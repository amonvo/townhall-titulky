#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/serve.py — statický souborový server (stdlib) se správnými MIME typy,
podporou HTTP Range pro videa a API pro přípravu prezentace (wizard).

Proč nestačí `python -m http.server`:
  * neservíruje `.mjs` jako JavaScript (dává text/plain) → Chrome odmítne ES moduly,
  * neumí Range → nejde převíjet ve videu.
Tento server obojí řeší a navíc poskytuje:

  POST /api/prepare         upload .pptx (multipart) + spuštění pipeline na pozadí
  GET  /api/prepare/status  stav běžící/poslední přípravy (JSON)
  GET  /api/content/status  co je na disku (hasPdf, hasConfig, deckName…)

Bezpečnost: server je vázán VÝHRADNĚ na 127.0.0.1. API zapisuje POUZE do
content/ — klientské řetězce (názvy souborů) se nikdy nepoužívají jako cesty;
upload se vždy ukládá jako content/source.pptx a původní název zůstává jen
jako metadata (deckName).

Použití:  python tools/serve.py [port]   (default 8137)
"""

import json
import os
import re
import subprocess
import sys
import threading
import uuid
import http.server
import socketserver

# prep.py je ve stejném adresáři → importovatelná pipeline
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prep  # noqa: E402

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8137
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CONTENT_DIR = os.path.join(ROOT, "content")
EXPORT_PS1 = os.path.join(ROOT, "tools", "export-pdf.ps1")

MAX_UPLOAD = 2 * 1024 ** 3          # 2 GB
PDF_EXPORT_TIMEOUT = 300            # s — velké decky konvertují dlouho

MIME = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".pdf": "application/pdf",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".txt": "text/plain; charset=utf-8",
}

# ---- Stav přípravy (jediný job najednou) -----------------------------------

# Kroky hlášené wizardu. Pozn.: config.json zapisuje prepare_content PŘED
# exportem PDF; krok "config" tu ale hlásíme až PO exportu (přepis deckName
# + finální kontrola), aby pořadí řádků ve wizardu odpovídalo realitě UI.
STEPS = ("upload", "analyze", "videos", "pdf", "config", "done")

_job_lock = threading.Lock()
_job = {
    "state": "idle",      # idle | running | done | error | needs_manual_pdf
    "step": None,
    "stepIndex": 0,
    "stepsTotal": len(STEPS),
    "message": "",
    "summary": None,
    "jobId": None,
}


def _job_set(**kw):
    with _job_lock:
        _job.update(kw)


def _job_step(step, message):
    _job_set(step=step, stepIndex=STEPS.index(step), message=message)


def _job_snapshot():
    with _job_lock:
        return dict(_job)


class _MultipartError(Exception):
    pass


# ---- Streamující multipart parser (jediné pole "pptx") ---------------------

def _stream_multipart_to_file(rfile, length, boundary, dst_path, chunk=65536):
    """
    Přečte multipart/form-data tělo o dané délce, najde part s name="pptx"
    a jeho payload streamuje po 64KB blocích do dst_path (nikdy nedrží celé
    tělo v paměti). Vrací (původní_název_souboru, zapsané_byty).
    """
    delim = b"--" + boundary
    end_marker = b"\r\n" + delim
    remaining = length
    buf = b""

    def fill():
        nonlocal buf, remaining
        if remaining <= 0:
            return False
        data = rfile.read(min(chunk, remaining))
        if not data:
            remaining = 0
            return False
        remaining -= len(data)
        buf += data
        return True

    # 1) první boundary + hlavičky partu
    while True:
        start = buf.find(delim)
        if start != -1 and buf.find(b"\r\n\r\n", start) != -1:
            break
        if len(buf) > 1024 * 1024:
            raise _MultipartError("hlavičky multipart partu jsou příliš dlouhé")
        if not fill():
            raise _MultipartError("neúplné multipart tělo (hlavičky partu)")

    hdr_end = buf.find(b"\r\n\r\n", start)
    headers_blob = buf[start:hdr_end].decode("utf-8", "replace")
    name_m = re.search(r'name="([^"]*)"', headers_blob)
    if not name_m or name_m.group(1) != "pptx":
        raise _MultipartError('očekáváno jediné pole "pptx"')
    file_m = re.search(r'filename="([^"]*)"', headers_blob)
    orig_name = file_m.group(1) if file_m else ""
    buf = buf[hdr_end + 4:]

    # 2) payload až po koncový \r\n--boundary
    written = 0
    keep = len(end_marker) - 1
    with open(dst_path, "wb") as out:
        while True:
            idx = buf.find(end_marker)
            if idx != -1:
                out.write(buf[:idx])
                written += idx
                return orig_name, written
            if len(buf) > keep:
                out.write(buf[:-keep])
                written += len(buf) - keep
                buf = buf[-keep:]
            if not fill():
                raise _MultipartError("neúplné multipart tělo (chybí koncový boundary)")


# ---- Export PDF přes PowerPoint COM ----------------------------------------

def _export_pdf(pptx_abs, pdf_abs):
    """
    Zavolá tools/export-pdf.ps1 (PowerPoint COM). Vrací (ok, err_text).
    Timeout 300 s — velké decky konvertují dlouho.
    """
    cmd = [
        "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", EXPORT_PS1, "-Pptx", pptx_abs, "-Pdf", pdf_abs,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True,
                              timeout=PDF_EXPORT_TIMEOUT)
    except subprocess.TimeoutExpired:
        return False, "převod PDF překročil časový limit %d s" % PDF_EXPORT_TIMEOUT
    except OSError as e:
        return False, "PowerShell se nepodařilo spustit (%s)" % e
    if proc.returncode != 0:
        # PowerShell může stderr psát v UTF-8 i v cp1250/cp852 — zkus po řadě.
        raw = proc.stderr or b""
        for enc in ("utf-8", "cp1250", "cp852"):
            try:
                err = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        else:
            err = raw.decode("utf-8", "replace")
        err = err.strip() or "neznámá chyba PowerPointu"
        return False, err
    if not os.path.isfile(pdf_abs) or os.path.getsize(pdf_abs) == 0:
        return False, "export skončil bez chyby, ale PDF nevzniklo"
    return True, ""


def _sanitize_deck_name(orig_name):
    """Z klientského názvu souboru udělá bezpečný deckName (jen metadata)."""
    base = os.path.basename(orig_name.replace("\\", "/"))
    stem = os.path.splitext(base)[0]
    return stem.strip() or "prezentace"


# ---- Vlákno přípravy --------------------------------------------------------

def _run_prepare_job(deck_name):
    """Běží na pozadí: prepare_content → export PDF → přepis deckName."""
    src = os.path.join(CONTENT_DIR, "source.pptx")
    try:
        # analyze + videos hlásí pipeline; její kroky pdf/config/done
        # potlačujeme — server je hlásí sám ve správném pořadí pro UI.
        def cb(step, message):
            if step in ("analyze", "videos"):
                _job_step(step, message)

        summary = prep.prepare_content(src, pdf_path=None, out_dir=CONTENT_DIR,
                                       allow_remux=True, progress_cb=cb)

        # Export PDF (atomicky: nejdřív .tmp, nahradit až po úspěchu —
        # neúspěšný export nesmí zničit funkční slides.pdf z minula).
        _job_step("pdf", "Převádím do PDF (u velkých prezentací může trvat i minutu)…")
        pdf_tmp = os.path.join(CONTENT_DIR, "slides.tmp.pdf")
        pdf_dst = os.path.join(CONTENT_DIR, "slides.pdf")
        ok, err = _export_pdf(os.path.abspath(src), os.path.abspath(pdf_tmp))
        if ok:
            os.replace(pdf_tmp, pdf_dst)
        else:
            try:
                if os.path.exists(pdf_tmp):
                    os.remove(pdf_tmp)
            except OSError:
                pass

        # deckName = původní název souboru (jen metadata; do config.json)
        _job_step("config", "Dokončuji konfiguraci…")
        cfg_path = os.path.join(CONTENT_DIR, "config.json")
        with open(cfg_path, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
        cfg["deckName"] = deck_name
        with open(cfg_path, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, ensure_ascii=False, indent=2)
        summary["deckName"] = deck_name

        if ok:
            _job_set(state="done", step="done", stepIndex=STEPS.index("done"),
                     message="Hotovo", summary=summary)
        else:
            _job_set(state="needs_manual_pdf", step="pdf",
                     stepIndex=STEPS.index("pdf"),
                     message="Automatický převod do PDF se nepodařil (%s). "
                             "Videa i konfigurace jsou připravené — PDF ulož "
                             "ručně dle pokynů." % err,
                     summary=summary)
    except Exception as e:  # noqa: BLE001 — stav error nese text chyby
        _job_set(state="error", message="Příprava selhala: %s" % e, summary=None)


# ---- HTTP handler -----------------------------------------------------------

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        # tišší log (API status poll každých 500 ms by zaplavil konzoli)
        if "/api/prepare/status" not in (self.path or ""):
            super().log_message(fmt, *args)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in MIME:
            return MIME[ext]
        return super().guess_type(path)

    # -- JSON helpers --------------------------------------------------------

    def _send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # -- API: GET ------------------------------------------------------------

    def _api_prepare_status(self):
        snap = _job_snapshot()
        out = {
            "state": snap["state"],
            "step": snap["step"],
            "stepIndex": snap["stepIndex"],
            "stepsTotal": snap["stepsTotal"],
            "message": snap["message"],
        }
        if snap["summary"] is not None and snap["state"] in ("done", "needs_manual_pdf"):
            out["summary"] = snap["summary"]
        if snap["jobId"]:
            out["jobId"] = snap["jobId"]
        self._send_json(200, out)

    def _api_content_status(self):
        pdf_path = os.path.join(CONTENT_DIR, "slides.pdf")
        cfg_path = os.path.join(CONTENT_DIR, "config.json")
        out = {
            "hasPdf": os.path.isfile(pdf_path) and os.path.getsize(pdf_path) > 0,
            "hasConfig": False,
        }
        try:
            with open(cfg_path, "r", encoding="utf-8") as fh:
                cfg = json.load(fh)
            out["hasConfig"] = True
            out["deckName"] = cfg.get("deckName")
            out["slideCount"] = cfg.get("slideCount")
        except (OSError, ValueError):
            pass
        self._send_json(200, out)

    # -- API: POST /api/prepare ---------------------------------------------

    def _api_prepare(self):
        # Jediný job najednou
        with _job_lock:
            if _job["state"] == "running":
                self._send_json(409, {"error": "Příprava už běží — počkej na dokončení."})
                return
            _job.update(state="running", step="upload",
                        stepIndex=STEPS.index("upload"),
                        message="Přijímám soubor…", summary=None,
                        jobId=uuid.uuid4().hex)

        def fail(status, msg, state="error"):
            _job_set(state=state, message=msg)
            self._send_json(status, {"error": msg})

        te = (self.headers.get("Transfer-Encoding") or "").lower()
        if "chunked" in te:
            fail(411, "Chunked upload není podporován — pošli Content-Length.",
                 state="idle")
            return
        cl = self.headers.get("Content-Length")
        if not cl:
            fail(411, "Chybí Content-Length.", state="idle")
            return
        length = int(cl)
        if length > MAX_UPLOAD:
            fail(413, "Soubor je větší než 2 GB.", state="idle")
            return

        ctype = self.headers.get("Content-Type") or ""
        bm = re.search(r'boundary="?([^";]+)"?', ctype)
        if "multipart/form-data" not in ctype or not bm:
            fail(400, "Očekávám multipart/form-data s polem „pptx“.", state="idle")
            return
        boundary = bm.group(1).encode("utf-8")

        os.makedirs(CONTENT_DIR, exist_ok=True)
        tmp_path = os.path.join(CONTENT_DIR, "upload.tmp")
        src_path = os.path.join(CONTENT_DIR, "source.pptx")
        try:
            orig_name, written = _stream_multipart_to_file(
                self.rfile, length, boundary, tmp_path)
        except _MultipartError as e:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except OSError:
                pass
            fail(400, "Nahrání selhalo: %s" % e, state="idle")
            return

        if written == 0:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            fail(400, "Soubor je prázdný.", state="idle")
            return

        # Atomicky na definitivní místo; klientský název jen jako metadata.
        os.replace(tmp_path, src_path)
        deck_name = _sanitize_deck_name(orig_name)

        t = threading.Thread(target=_run_prepare_job, args=(deck_name,),
                             daemon=True)
        t.start()

        with _job_lock:
            job_id = _job["jobId"]
        self._send_json(202, {"jobId": job_id})

    # -- Routing -------------------------------------------------------------

    def do_POST(self):
        if self.path == "/api/prepare":
            self._api_prepare()
        else:
            self._send_json(404, {"error": "Neznámý API endpoint."})

    def do_GET(self):
        if self.path == "/api/prepare/status":
            self._api_prepare_status()
            return
        if self.path == "/api/content/status":
            self._api_content_status()
            return
        if self.path.startswith("/api/"):
            self._send_json(404, {"error": "Neznámý API endpoint."})
            return

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")
        if not os.path.isfile(path):
            self.send_error(404, "Not Found")
            return

        ctype = self.guess_type(path)
        total = os.path.getsize(path)
        range_header = self.headers.get("Range")

        if range_header and range_header.startswith("bytes="):
            try:
                start_s, end_s = range_header[len("bytes="):].split("-", 1)
                if start_s == "":
                    length = int(end_s)
                    start = max(0, total - length)
                    end = total - 1
                else:
                    start = int(start_s)
                    end = int(end_s) if end_s else total - 1
                if start > end or start >= total:
                    raise ValueError
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % total)
                self.end_headers()
                return

            end = min(end, total - 1)
            chunk = end - start + 1
            self.send_response(206)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, total))
            self.send_header("Content-Length", str(chunk))
            self.end_headers()
            with open(path, "rb") as f:
                f.seek(start)
                remaining = chunk
                while remaining > 0:
                    buf = f.read(min(65536, remaining))
                    if not buf:
                        break
                    self.wfile.write(buf)
                    remaining -= len(buf)
            return

        # Bez Range: celý soubor
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(total))
        self.end_headers()
        with open(path, "rb") as f:
            while True:
                buf = f.read(65536)
                if not buf:
                    break
                self.wfile.write(buf)


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    os.chdir(ROOT)
    # Bezpečnost: pouze loopback — nikdy nevystavovat do sítě.
    with ThreadingServer(("127.0.0.1", PORT), Handler) as httpd:
        print("serve.py: naslouchám na http://localhost:%d (kořen: %s)" % (PORT, ROOT))
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
