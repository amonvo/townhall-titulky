#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/test-api.py — test API pro přípravu prezentace (stdlib only).

Nastartuje serve.py na testovacím portu, nahraje syntetický PPTX (fixture
z prep.py) přes multipart, polluje status do done/needs_manual_pdf a asertuje:
videa extrahovaná, config.json zapsaný, stavový automat správně, 409 při
souběžném jobu, odmítnutí špatných requestů.

POZOR: pracuje s reálným content/ v repu (server jinam neumí — záměrně).
Zálohují se POUZE soubory s fixními názvy, do kterých pipeline zapisuje
(config.json, slides.pdf, source.pptx, videos/, upload.tmp) — přesunem do
content.bak-test/ a po testu zpět. Ostatních souborů operátora (např. deck
pod původním názvem, klidně otevřený v PowerPointu) se test NEDOTÝKÁ.

Použití:  py -3 tools/test-api.py
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prep  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CONTENT = os.path.join(ROOT, "content")
PORT = 8199
BASE = "http://127.0.0.1:%d" % PORT

failures = []


def check(cond, msg):
    print("  [%s] %s" % ("OK  " if cond else "FAIL", msg))
    if not cond:
        failures.append(msg)


def wait_port(port, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def get_json(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return r.status, json.loads(r.read().decode("utf-8"))


def multipart_body(field, filename, payload):
    boundary = "----testboundary1234567890"
    head = ("--%s\r\nContent-Disposition: form-data; name=\"%s\"; "
            "filename=\"%s\"\r\nContent-Type: application/octet-stream\r\n\r\n"
            % (boundary, field, filename)).encode("utf-8")
    tail = ("\r\n--%s--\r\n" % boundary).encode("utf-8")
    return boundary, head + payload + tail


def post(path, body=None, headers=None, method="POST"):
    req = urllib.request.Request(BASE + path, data=body, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except ValueError:
            return e.code, {}
    except (ConnectionError, OSError):
        # server u odmítnutých uploadů může zavřít spojení dřív,
        # než klient dočte odpověď
        return -1, {}


# Fixní názvy, do kterých pipeline/API zapisuje — jen ty se zálohují/mažou.
PIPELINE_ITEMS = ("config.json", "slides.pdf", "slides.tmp.pdf",
                  "source.pptx", "upload.tmp", "videos")

BACKUP_DIR = CONTENT + ".bak-test"


def _backup_pipeline_items():
    moved = []
    if os.path.isdir(BACKUP_DIR):
        shutil.rmtree(BACKUP_DIR)
    os.makedirs(BACKUP_DIR)
    for name in PIPELINE_ITEMS:
        src = os.path.join(CONTENT, name)
        if os.path.exists(src):
            shutil.move(src, os.path.join(BACKUP_DIR, name))
            moved.append(name)
    return moved


def _restore_pipeline_items():
    for name in PIPELINE_ITEMS:
        test_made = os.path.join(CONTENT, name)
        if os.path.isdir(test_made):
            shutil.rmtree(test_made, ignore_errors=True)
        elif os.path.exists(test_made):
            try:
                os.remove(test_made)
            except OSError:
                pass
        bak = os.path.join(BACKUP_DIR, name)
        if os.path.exists(bak):
            shutil.move(bak, test_made)
    shutil.rmtree(BACKUP_DIR, ignore_errors=True)


def main():
    prep._force_utf8_stdio()
    print("test-api.py: start")

    os.makedirs(CONTENT, exist_ok=True)
    moved = _backup_pipeline_items()
    print("  (zálohováno: %s)" % (", ".join(moved) or "nic"))

    tmp = tempfile.mkdtemp(prefix="apitest_")
    pptx = os.path.join(tmp, "selftest.pptx")
    prep._build_synthetic_pptx(pptx)
    with open(pptx, "rb") as fh:
        pptx_bytes = fh.read()

    server = subprocess.Popen(
        [sys.executable, os.path.join(ROOT, "tools", "serve.py"), str(PORT)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=ROOT)
    try:
        check(wait_port(PORT), "server nastartoval na portu %d" % PORT)

        # 1) content/status na prázdném adresáři
        st, data = get_json("/api/content/status")
        check(st == 200 and data.get("hasPdf") is False
              and data.get("hasConfig") is False,
              "GET /api/content/status: prázdný content → hasPdf/hasConfig false")

        # 2) prepare/status v klidu
        st, data = get_json("/api/prepare/status")
        check(st == 200 and data.get("state") == "idle",
              "GET /api/prepare/status: výchozí stav idle")

        # 3) špatný request: ne-multipart POST
        st, data = post("/api/prepare", body=b"hello",
                        headers={"Content-Type": "text/plain"})
        check(st == 400 and "error" in data,
              "POST ne-multipart → 400 s JSON chybou")

        # 4) upload syntetického PPTX
        boundary, body = multipart_body("pptx", "selftest.pptx", pptx_bytes)
        st, data = post("/api/prepare", body=body, headers={
            "Content-Type": "multipart/form-data; boundary=%s" % boundary})
        check(st == 202 and data.get("jobId"),
              "POST /api/prepare → 202 + jobId")

        # 5) souběžný job → 409 (okno: export PDF běží sekundy)
        st2, data2 = post("/api/prepare", body=body, headers={
            "Content-Type": "multipart/form-data; boundary=%s" % boundary})
        check(st2 == 409 and "error" in data2,
              "druhý POST během jobu → 409 s JSON chybou")

        # 6) poll do koncového stavu
        seen_steps = []
        final = None
        end = time.time() + 330
        while time.time() < end:
            st, data = get_json("/api/prepare/status")
            if data.get("step") and (not seen_steps or seen_steps[-1] != data["step"]):
                seen_steps.append(data["step"])
            if data.get("state") in ("done", "needs_manual_pdf", "error"):
                final = data
                break
            time.sleep(0.5)
        check(final is not None, "job doběhl do koncového stavu (timeout 330 s)")
        state = (final or {}).get("state")
        # Pozn.: na stroji s PowerPointem může být syntetický deck i úspěšně
        # převeden → 'done'; bez PowerPointu / při selhání otevření → needs_manual_pdf.
        check(state in ("done", "needs_manual_pdf"),
              "koncový stav done|needs_manual_pdf (bylo: %s — %s)"
              % (state, (final or {}).get("message")))
        print("    (stav: %s; kroky: %s)" % (state, seen_steps))

        # 7) summary + stavový automat
        if final and state in ("done", "needs_manual_pdf"):
            summary = final.get("summary") or {}
            check(summary.get("slideCount") == 2 and summary.get("deckName") == "selftest",
                  "summary: slideCount=2, deckName='selftest' (z názvu uploadu)")
            check(len(summary.get("videos") or []) == 1
                  and summary["videos"][0]["slide"] == 2,
                  "summary: 1 video na slajdu 2")
            if state == "needs_manual_pdf":
                check(bool(final.get("message")), "needs_manual_pdf nese českou zprávu")

        # 8) soubory na disku
        check(os.path.isfile(os.path.join(CONTENT, "source.pptx")),
              "content/source.pptx uložen (atomicky, fixní název)")
        check(not os.path.exists(os.path.join(CONTENT, "upload.tmp")),
              "content/upload.tmp po uploadu neexistuje")
        video = os.path.join(CONTENT, "videos", "media1.mov")
        check(os.path.isfile(video) and os.path.getsize(video) > 0,
              "video extrahováno do content/videos/media1.mov")
        cfg_path = os.path.join(CONTENT, "config.json")
        cfg_ok = False
        deck = None
        try:
            with open(cfg_path, "r", encoding="utf-8") as fh:
                cfg = json.load(fh)
            cfg_ok = True
            deck = cfg.get("deckName")
        except (OSError, ValueError):
            pass
        check(cfg_ok, "content/config.json zapsán a validní")
        check(deck == "selftest", "config.deckName přepsán na původní název uploadu")
        if state == "needs_manual_pdf":
            check(not os.path.exists(os.path.join(CONTENT, "slides.tmp.pdf")),
                  "po neúspěšném exportu nezůstal slides.tmp.pdf")

        # 9) content/status po dokončení
        st, data = get_json("/api/content/status")
        check(st == 200 and data.get("hasConfig") is True
              and data.get("deckName") == "selftest"
              and data.get("slideCount") == 2,
              "GET /api/content/status po jobu: hasConfig + deckName + slideCount")
        check(data.get("hasPdf") == (state == "done"),
              "hasPdf odpovídá výsledku exportu (%s)" % state)

        # 10) další job po doběhnutí už není blokován 409
        st, data = post("/api/prepare", body=b"x",
                        headers={"Content-Type": "text/plain"})
        check(st == 400, "po doběhnutí jobu server přijímá další požadavky (ne 409)")

        # 11) chunked transfer-encoding → 411 (raw socket)
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=5) as s:
                s.sendall(b"POST /api/prepare HTTP/1.1\r\n"
                          b"Host: 127.0.0.1\r\n"
                          b"Transfer-Encoding: chunked\r\n"
                          b"Content-Type: multipart/form-data; boundary=x\r\n"
                          b"\r\n")
                resp = s.recv(4096).decode("latin-1", "replace")
            check(" 411 " in resp.splitlines()[0], "chunked upload → 411")
        except OSError as e:
            check(False, "chunked test selhal na socketu (%s)" % e)

    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
        shutil.rmtree(tmp, ignore_errors=True)
        # Smaž výstupy testu a vrať zálohované soubory operátora
        _restore_pipeline_items()

    print("-" * 60)
    if failures:
        print("TEST-API SELHAL: %d asercí neprošlo." % len(failures))
        return 1
    print("TEST-API OK: všechny asercie prošly.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
