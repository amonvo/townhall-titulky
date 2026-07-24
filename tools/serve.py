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

import argparse
import json
import os
import posixpath
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid
import http.server
import socketserver

# prep.py je ve stejném adresáři → importovatelná pipeline
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prep  # noqa: E402

# ---- Kořeny (dev vs. zmrazený exe) -----------------------------------------
# APP_ROOT  = statická aplikace (index.html, app/, vendor/, tools/*.ps1):
#             v dev repo root, ve zmrazeném exe rozbalený bundle (_MEIPASS).
# DATA_ROOT = měnitelná data (content/): v dev repo root, ve zmrazeném exe
#             SLOŽKA VEDLE EXE — uživatelská data nikdy nežijí uvnitř bundlu.
FROZEN = bool(getattr(sys, "frozen", False))
if FROZEN:
    APP_ROOT = sys._MEIPASS  # noqa: SLF001 — PyInstaller runtime
    DATA_ROOT = os.path.dirname(os.path.abspath(sys.executable))
else:
    APP_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    DATA_ROOT = APP_ROOT

CONTENT_DIR = os.path.join(DATA_ROOT, "content")
EXPORT_PS1 = os.path.join(APP_ROOT, "tools", "export-pdf.ps1")

# Watchdog (exe lifecycle): intervaly lze pro testy zkrátit env proměnnými.
HEARTBEAT_TIMEOUT = float(os.environ.get("TOWNHALL_HB_TIMEOUT", "60"))
STARTUP_GRACE = float(os.environ.get("TOWNHALL_HB_GRACE", "120"))

AUTO_EXIT = False
_last_heartbeat = None          # None = zatím žádný heartbeat
_started_at = time.time()

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
    def log_message(self, fmt, *args):
        # tišší log (API status poll každých 500 ms by zaplavil konzoli)
        if ("/api/prepare/status" in (self.path or "")
                or "/api/heartbeat" in (self.path or "")):
            return
        super().log_message(fmt, *args)

    def translate_path(self, path):
        # Routing kořenů: /content/* → DATA_ROOT (vedle exe), vše ostatní
        # → APP_ROOT (statická aplikace, ve zmrazeném exe _MEIPASS).
        path = path.split("?", 1)[0].split("#", 1)[0]
        path = urllib.parse.unquote(path)
        path = posixpath.normpath(path)
        parts = [p for p in path.split("/") if p and p not in (".", "..")]
        root = DATA_ROOT if parts and parts[0] == "content" else APP_ROOT
        return os.path.join(root, *parts)

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
        elif self.path == "/api/heartbeat":
            global _last_heartbeat
            _last_heartbeat = time.time()
            # tělo (pokud nějaké je) zahodíme
            cl = int(self.headers.get("Content-Length") or 0)
            if cl:
                try:
                    self.rfile.read(min(cl, 4096))
                except OSError:
                    pass
            self._send_json(200, {"ok": True})
        else:
            self._send_json(404, {"error": "Neznámý API endpoint."})

    def do_GET(self):
        if self.path == "/api/prepare/status":
            self._api_prepare_status()
            return
        if self.path == "/api/content/status":
            self._api_content_status()
            return
        if self.path == "/api/env":
            self._send_json(200, {"frozen": FROZEN, "autoExit": AUTO_EXIT})
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
    allow_reuse_address = False   # obsazený port = běžící instance (viz main)


# ---- Watchdog (exe lifecycle) ----------------------------------------------

def _watchdog():
    """
    Ukončí proces, když aplikace v prohlížeči přestane posílat heartbeaty
    (zavřené okno). Po startu platí delší grace perioda — pomalé první
    spuštění prohlížeče nesmí server zabít.
    """
    while True:
        time.sleep(min(1.0, HEARTBEAT_TIMEOUT / 4))
        now = time.time()
        if _last_heartbeat is None:
            deadline = _started_at + STARTUP_GRACE
        else:
            deadline = _last_heartbeat + HEARTBEAT_TIMEOUT
        if now > deadline:
            print("serve.py: žádný heartbeat — končím.")
            os._exit(0)


# ---- Prohlížeč (Chrome → Edge → chybová hláška) ----------------------------

def _registry_app_path(exe_name):
    try:
        import winreg
    except ImportError:
        return None
    key_path = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\%s" % exe_name
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        try:
            with winreg.OpenKey(hive, key_path) as k:
                val, _ = winreg.QueryValueEx(k, None)
                if val and os.path.isfile(val):
                    return val
        except OSError:
            continue
    return None


def find_browser():
    """Vrátí (cesta, 'chrome'|'edge') nebo (None, None)."""
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    lad = os.environ.get("LocalAppData", "")
    chrome_candidates = [
        os.path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(lad, "Google", "Chrome", "Application", "chrome.exe"),
    ]
    for c in chrome_candidates:
        if c and os.path.isfile(c):
            return c, "chrome"
    reg = _registry_app_path("chrome.exe")
    if reg:
        return reg, "chrome"
    edge_candidates = [
        os.path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]
    for c in edge_candidates:
        if c and os.path.isfile(c):
            return c, "edge"
    reg = _registry_app_path("msedge.exe")
    if reg:
        return reg, "edge"
    return None, None


def launch_browser(port):
    """Otevře aplikaci v chromeless --app okně. Vrací True při úspěchu."""
    path, kind = find_browser()
    if not path:
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(
                None,
                "Nenašel jsem Google Chrome ani Microsoft Edge.\n\n"
                "Nainstaluj prosím Google Chrome (rozpoznávání řeči funguje "
                "nejlépe v něm) a spusť aplikaci znovu.",
                "Townhall Titulky", 0x10)  # MB_ICONERROR
        except Exception:  # noqa: BLE001 — bez GUI aspoň log
            print("CHYBA: Chrome ani Edge nenalezen.")
        return False
    subprocess.Popen([path, "--app=http://localhost:%d" % port, "--new-window"])
    if kind == "edge":
        print("serve.py: Chrome nenalezen, otevírám Edge (kompatibilní, "
              "ale řeč je nejspolehlivější v Chromu).")
    return True


# ---- Smoke test (ověření buildu) -------------------------------------------

def run_smoke(port):
    """Nastartuje server, self-GET / a /api/content/status, vypíše OK, exit 0."""
    httpd = ThreadingServer(("127.0.0.1", port), Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        for url_path in ("/", "/api/content/status"):
            with urllib.request.urlopen(
                    "http://127.0.0.1:%d%s" % (port, url_path), timeout=10) as r:
                if r.status != 200:
                    print("SMOKE FAIL: %s -> %d" % (url_path, r.status))
                    return 1
                body = r.read()
                if not body:
                    print("SMOKE FAIL: %s prázdná odpověď" % url_path)
                    return 1
        print("SMOKE OK")
        return 0
    except Exception as e:  # noqa: BLE001
        print("SMOKE FAIL: %s" % e)
        return 1
    finally:
        httpd.shutdown()


# ---- Vstupní bod ------------------------------------------------------------

def main(argv=None):
    global AUTO_EXIT

    ap = argparse.ArgumentParser(description="Lokální server townhall-titulky.")
    ap.add_argument("port_pos", nargs="?", type=int,
                    help="port (poziční, kompatibilita se start.bat)")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--auto-exit", action="store_true",
                    help="ukončit proces bez heartbeatů (používá exe)")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--smoke", action="store_true",
                    help="self-test serveru (build verifikace), exit 0 při OK")
    args = ap.parse_args(argv)

    port = args.port or args.port_pos or 8137

    # Dvojklik na zmrazený exe (žádné argumenty) = plný „aplikační" režim.
    frozen_default = FROZEN and (argv is None and len(sys.argv) == 1)
    auto_exit = args.auto_exit or frozen_default
    want_browser = (frozen_default or FROZEN) and not args.no_browser and not args.smoke

    if args.smoke:
        return run_smoke(port)

    os.makedirs(CONTENT_DIR, exist_ok=True)
    os.chdir(DATA_ROOT)

    # Bezpečnost: pouze loopback — nikdy nevystavovat do sítě.
    try:
        httpd = ThreadingServer(("127.0.0.1", port), Handler)
    except OSError:
        # Port obsazený → běžící instance; jen otevři další okno a skonči.
        print("serve.py: port %d už obsluhuje běžící instance." % port)
        if want_browser:
            launch_browser(port)
        return 0

    if auto_exit:
        AUTO_EXIT = True
        threading.Thread(target=_watchdog, daemon=True).start()

    if want_browser:
        launch_browser(port)

    with httpd:
        print("serve.py: naslouchám na http://localhost:%d (app: %s, data: %s)"
              % (port, APP_ROOT, DATA_ROOT))
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
