# -*- coding: utf-8 -*-
"""Vytvoří fixture DATA_ROOTy pro testy: fresh (prázdný) a prepared (mini PDF)."""
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
FRESH = os.path.join(BASE, "data-fresh")
PREPARED = os.path.join(BASE, "data-prepared")


def minimal_pdf(pages=2, w=960, h=540):
    """Ručně sestavené validní PDF (prázdné stránky 16:9), správné xref offsety."""
    objects = []
    kids = " ".join("%d 0 R" % (3 + i) for i in range(pages))
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(("<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, pages)).encode())
    for _ in range(pages):
        objects.append(("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] >>"
                        % (w, h)).encode())

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += ("%d 0 obj\n" % i).encode() + body + b"\nendobj\n"
    xref_pos = len(out)
    n = len(objects) + 1
    out += ("xref\n0 %d\n" % n).encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += ("%010d 00000 n \n" % off).encode()
    out += ("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
            % (n, xref_pos)).encode()
    return bytes(out)


def main():
    os.makedirs(FRESH, exist_ok=True)  # záměrně bez content/
    content = os.path.join(PREPARED, "content")
    os.makedirs(content, exist_ok=True)
    with open(os.path.join(content, "slides.pdf"), "wb") as fh:
        fh.write(minimal_pdf())
    cfg = {"pdf": "slides.pdf", "deckName": "Test Deck", "slideCount": 2,
           "videos": [], "slideAspect": 16 / 9}
    with open(os.path.join(content, "config.json"), "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
    print("fixtures OK:", FRESH, PREPARED)
    return 0


if __name__ == "__main__":
    sys.exit(main())
