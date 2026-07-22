#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/serve.py — statický souborový server (stdlib) se správnými MIME typy a
podporou HTTP Range pro videa.

Proč nestačí `python -m http.server`:
  * neservíruje `.mjs` jako JavaScript (dává text/plain) → Chrome odmítne ES moduly,
  * neumí Range → nejde převíjet ve videu.
Tento server obojí řeší.

Použití:  python tools/serve.py [port]   (default 8137)
"""

import os
import sys
import http.server
import socketserver

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8137
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

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


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in MIME:
            return MIME[ext]
        return super().guess_type(path)

    def do_GET(self):
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
    with ThreadingServer(("127.0.0.1", PORT), Handler) as httpd:
        print("serve.py: naslouchám na http://localhost:%d (kořen: %s)" % (PORT, ROOT))
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
