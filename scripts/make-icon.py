#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scripts/make-icon.py — vygeneruje assets/icon.ico (build-time, Pillow).

Design: tmavě modrý zaoblený čtverec (#032342), dva titulkové pruhy
(bílý #F5F7FA a žlutý #FFD966) nad tenkou červenou (#EE3024) základní
linkou. Minimalistické, ploché, bez textu.

Použití:  py -3 scripts/make-icon.py [--force]
Existující soubor se bez --force nepřegenerovává.
"""

import argparse
import os
import sys

from PIL import Image, ImageDraw

OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..",
                                   "assets", "icon.ico"))
SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

NAVY = (3, 35, 66, 255)        # #032342
WHITE = (245, 247, 250, 255)   # #F5F7FA
YELLOW = (255, 217, 102, 255)  # #FFD966
RED = (238, 48, 36, 255)       # #EE3024


def draw_base(size):
    """Nakreslí motiv v daném rozlišení (supersampling 4×, pak LANCZOS)."""
    ss = size * 4
    img = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def px(frac):
        return int(round(frac * ss))

    # Zaoblený čtverec přes celé plátno
    d.rounded_rectangle([0, 0, ss - 1, ss - 1], radius=px(0.22), fill=NAVY)

    # Titulkové pruhy: bílý (delší) a žlutý (kratší) v dolní polovině
    bar_r = px(0.045)
    d.rounded_rectangle([px(0.19), px(0.50), px(0.81), px(0.60)],
                        radius=bar_r, fill=WHITE)
    d.rounded_rectangle([px(0.19), px(0.66), px(0.68), px(0.745)],
                        radius=bar_r, fill=YELLOW)

    # Tenká červená základní linka
    d.rounded_rectangle([px(0.19), px(0.82), px(0.81), px(0.845)],
                        radius=px(0.012), fill=RED)

    return img.resize((size, size), Image.LANCZOS)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true",
                    help="přegenerovat i když ikona existuje")
    args = ap.parse_args(argv)

    if os.path.isfile(OUT) and not args.force:
        print("make-icon: %s existuje, přeskočeno (použij --force)" % OUT)
        return 0

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    base = draw_base(256)
    frames = [base.resize(s, Image.LANCZOS) for s in SIZES]
    base.save(OUT, format="ICO", sizes=SIZES, append_images=frames[:-1])
    print("make-icon: zapsáno %s (%d velikostí)" % (OUT, len(SIZES)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
