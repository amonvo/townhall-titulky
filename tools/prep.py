#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/prep.py — příprava obsahu pro townhall-titulky.

Z PPTX vytáhne videa (se správným pořadím slidů a pozicí videa na slajdu) a
vygeneruje content/config.json, který aplikace čte za běhu. Volitelně zkopíruje
exportované PDF do content/slides.pdf.

Použití:
    python tools/prep.py --pptx cesta/k/deck.pptx [--pdf cesta/k/deck.pdf] [--out content]
    python tools/prep.py --self-test

Pouze standardní knihovna Pythonu 3. PPTX se pouze čte (nikdy neserializuje zpět).
Volitelná závislost: pokud je na PATH `ffmpeg`, MOV se bezeztrátově remuxuje na MP4;
jinak se krok přeskočí a vypíše se varování.
"""

import argparse
import json
import os
import posixpath
import shutil
import subprocess
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET

# ---- XML namespaces (OOXML) ------------------------------------------------
NS = {
    "p":  "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a":  "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r":  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}

VIDEO_REL_SUFFIX = "/video"   # Type relationship pro video končí na .../video
EMU_PER_INCH = 914400          # jen pro referenci; my pracujeme s poměry


def _force_utf8_stdio():
    """
    Windows konzole bývá cp1250 a neumí zakódovat znaky jako '→'. Přepneme
    stdout/stderr na UTF-8 (s náhradou), aby výpis nikdy nespadl na UnicodeError.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


# ---- Pomocné funkce --------------------------------------------------------

def _q(ns_key, tag):
    """Vrátí kvalifikovaný název '{namespace}tag'."""
    return "{%s}%s" % (NS[ns_key], tag)


def _resolve_target(base_dir, target):
    """
    Vyřeší relativní Target z .rels vůči adresáři base_dir uvnitř zipu.
    Vrací normalizovanou POSIX cestu (oddělovač '/').
    """
    if target.startswith("/"):
        # absolutní cesta v balíku (od kořene)
        return posixpath.normpath(target.lstrip("/"))
    joined = posixpath.join(base_dir, target)
    return posixpath.normpath(joined)


def _parse_rels(zf, rels_path):
    """
    Načte .rels soubor a vrátí dict: rel_id -> {'type': ..., 'target': ...}.
    Pokud soubor neexistuje, vrátí prázdný dict.
    """
    if rels_path not in zf.namelist():
        return {}
    root = ET.fromstring(zf.read(rels_path))
    out = {}
    for r in root.findall(_q("rel", "Relationship")):
        out[r.get("Id")] = {
            "type": r.get("Type", ""),
            "target": r.get("Target", ""),
            "mode": r.get("TargetMode", "Internal"),
        }
    return out


def _rels_path_for(part_path):
    """Cesta k .rels souboru pro daný part (např. ppt/slides/slide1.xml)."""
    d = posixpath.dirname(part_path)
    b = posixpath.basename(part_path)
    return posixpath.join(d, "_rels", b + ".rels")


def _find_ffmpeg():
    """Vrátí cestu k ffmpeg, nebo None."""
    return shutil.which("ffmpeg")


# ---- Jádro pipeline --------------------------------------------------------

def analyze_pptx(zf):
    """
    Zanalyzuje otevřený PPTX zip a vrátí strukturu:
    {
      'sldSz': (cx, cy),
      'slides': [ { 'display': 1, 'part': 'ppt/slides/slide1.xml',
                    'videos': [ {rel_id, target(abs part path), x,y,w,h,
                                 xfrm_missing(bool)} ] }, ... ],
      'warnings': [str, ...],
    }
    """
    warnings = []

    pres_path = "ppt/presentation.xml"
    pres = ET.fromstring(zf.read(pres_path))

    # Velikost slidu (EMU)
    sldSz = pres.find(_q("p", "sldSz"))
    if sldSz is None:
        raise ValueError("presentation.xml neobsahuje <p:sldSz>")
    cx = int(sldSz.get("cx"))
    cy = int(sldSz.get("cy"))

    # Pořadí slidů podle sldIdLst → r:id
    sld_id_lst = pres.find(_q("p", "sldIdLst"))
    if sld_id_lst is None:
        raise ValueError("presentation.xml neobsahuje <p:sldIdLst>")
    ordered_rids = []
    for sld_id in sld_id_lst.findall(_q("p", "sldId")):
        rid = sld_id.get(_q("r", "id"))
        ordered_rids.append(rid)

    # Rozřešení r:id → slideN.xml přes ppt/_rels/presentation.xml.rels
    pres_rels = _parse_rels(zf, _rels_path_for(pres_path))
    slide_parts = []  # v pořadí zobrazení
    for rid in ordered_rids:
        rel = pres_rels.get(rid)
        if rel is None:
            warnings.append("sldIdLst odkazuje na neznámé r:id %s (přeskočeno)" % rid)
            continue
        part = _resolve_target("ppt", rel["target"])
        slide_parts.append(part)

    slides = []
    for idx, part in enumerate(slide_parts, start=1):
        entry = {"display": idx, "part": part, "videos": []}
        try:
            slide_xml = ET.fromstring(zf.read(part))
        except KeyError:
            warnings.append("Slide part %s nenalezen v balíku" % part)
            slides.append(entry)
            continue

        # Rels daného slidu
        slide_rels = _parse_rels(zf, _rels_path_for(part))

        # Video relationshipy (Type končí na /video), dedup podle cílového souboru
        video_rels = {}  # rel_id -> abs target part path
        seen_targets = set()
        for rid, rel in slide_rels.items():
            if rel["type"].endswith(VIDEO_REL_SUFFIX):
                tgt = _resolve_target(posixpath.dirname(part), rel["target"])
                if tgt in seen_targets:
                    continue
                seen_targets.add(tgt)
                video_rels[rid] = tgt

        if not video_rels:
            slides.append(entry)
            continue

        # Najdi <p:pic>, jehož <a:videoFile> odkazuje na některý video rel_id.
        # Přečti xfrm z <p:spPr><a:xfrm>.
        for pic in slide_xml.iter(_q("p", "pic")):
            vf = None
            for cand in pic.iter(_q("a", "videoFile")):
                vf = cand
                break
            if vf is None:
                continue
            # a:videoFile může mít r:link nebo r:embed
            link = vf.get(_q("r", "link")) or vf.get(_q("r", "embed"))
            if link not in video_rels:
                continue

            target = video_rels[link]
            xfrm = None
            spPr = pic.find(_q("p", "spPr"))
            if spPr is not None:
                xfrm = spPr.find(_q("a", "xfrm"))

            if xfrm is not None:
                off = xfrm.find(_q("a", "off"))
                ext = xfrm.find(_q("a", "ext"))
            else:
                off = ext = None

            if off is not None and ext is not None:
                ox = int(off.get("x")); oy = int(off.get("y"))
                ew = int(ext.get("cx")); eh = int(ext.get("cy"))
                x = round(ox / cx, 4)
                y = round(oy / cy, 4)
                w = round(ew / cx, 4)
                h = round(eh / cy, 4)
                xfrm_missing = False
            else:
                x, y, w, h = 0.0, 0.0, 1.0, 1.0
                xfrm_missing = True
                warnings.append(
                    "Slide %d: video %s nemá xfrm (dědí z layoutu) → fallback "
                    "na celý slajd {0,0,1,1}" % (idx, posixpath.basename(target))
                )

            entry["videos"].append({
                "rel_id": link,
                "target": target,
                "x": x, "y": y, "w": w, "h": h,
                "xfrm_missing": xfrm_missing,
            })
            # video rel spárováno; ať se nespáruje znovu jiným pic
            video_rels.pop(link, None)

        # Video rely bez odpovídajícího pic (vzácné) — fallback pozice
        for rid, target in list(video_rels.items()):
            warnings.append(
                "Slide %d: video rel %s nemá <p:pic>/<a:videoFile> → fallback "
                "{0,0,1,1}" % (idx, posixpath.basename(target))
            )
            entry["videos"].append({
                "rel_id": rid,
                "target": target,
                "x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0,
                "xfrm_missing": True,
            })

        slides.append(entry)

    return {"sldSz": (cx, cy), "slides": slides, "warnings": warnings}


def build_content(pptx_path, pdf_path=None, out_dir="content", allow_remux=True,
                  verbose=True):
    """
    Spustí celou pipeline: analyzuj PPTX, vytáhni videa, (volitelně remuxuj MOV),
    zkopíruj PDF, zapiš config.json. Vrátí dict configu.
    """
    pptx_path = os.path.abspath(pptx_path)
    out_dir = os.path.abspath(out_dir)
    videos_dir = os.path.join(out_dir, "videos")

    os.makedirs(out_dir, exist_ok=True)
    # Idempotence: složku videos vyčisti (config i PDF se přepisují níže).
    if os.path.isdir(videos_dir):
        shutil.rmtree(videos_dir)
    os.makedirs(videos_dir, exist_ok=True)

    ffmpeg = _find_ffmpeg() if allow_remux else None

    with zipfile.ZipFile(pptx_path, "r") as zf:
        info = analyze_pptx(zf)
        cx, cy = info["sldSz"]
        warnings = list(info["warnings"])

        config_videos = []
        for slide in info["slides"]:
            for v in slide["videos"]:
                src_part = v["target"]           # ppt/media/mediaN.MOV
                base = posixpath.basename(src_part)
                stem, ext = os.path.splitext(base)
                ext_low = ext.lower()
                out_name = stem + ext_low
                out_path = os.path.join(videos_dir, out_name)

                # Extrakce
                try:
                    data = zf.read(src_part)
                except KeyError:
                    warnings.append("Cíl videa %s nenalezen v balíku (přeskočeno)"
                                    % src_part)
                    continue
                with open(out_path, "wb") as fh:
                    fh.write(data)

                ref_name = "videos/" + out_name

                # Remux MOV → MP4 (bezeztrátově), je-li ffmpeg
                if ext_low == ".mov":
                    if ffmpeg:
                        mp4_name = stem + ".mp4"
                        mp4_path = os.path.join(videos_dir, mp4_name)
                        cmd = [ffmpeg, "-y", "-i", out_path, "-c", "copy", mp4_path]
                        try:
                            subprocess.run(cmd, check=True,
                                           stdout=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL)
                            os.remove(out_path)
                            ref_name = "videos/" + mp4_name
                        except (subprocess.CalledProcessError, OSError) as e:
                            warnings.append(
                                "ffmpeg remux selhal pro %s (%s) → ponechávám MOV, "
                                "otestuj přehrání v Chrome" % (base, e))
                    elif not allow_remux:
                        warnings.append(
                            "remux vypnut (self-test) → %s zůstává MOV." % base)
                    else:
                        warnings.append(
                            "ffmpeg není na PATH → %s zůstává MOV. H.264/AAC v MOV "
                            "v Chrome obvykle hraje, ale OTESTUJ přehrání." % base)

                config_videos.append({
                    "slide": slide["display"],
                    "file": ref_name,
                    "x": v["x"], "y": v["y"], "w": v["w"], "h": v["h"],
                })

        slide_count = len(info["slides"])

    # PDF
    pdf_ref = None
    if pdf_path:
        pdf_src = os.path.abspath(pdf_path)
        pdf_dst = os.path.join(out_dir, "slides.pdf")
        shutil.copyfile(pdf_src, pdf_dst)
        pdf_ref = "slides.pdf"

    deck_name = os.path.splitext(os.path.basename(pptx_path))[0]

    config = {
        "pdf": pdf_ref if pdf_ref else "slides.pdf",
        "slideCount": slide_count,
        "deckName": deck_name,
        "videos": config_videos,
    }

    config_path = os.path.join(out_dir, "config.json")
    with open(config_path, "w", encoding="utf-8") as fh:
        json.dump(config, fh, ensure_ascii=False, indent=2)

    if verbose:
        _print_summary(config, warnings, out_dir, has_pdf=bool(pdf_ref))

    return {"config": config, "warnings": warnings, "config_path": config_path}


def _print_summary(config, warnings, out_dir, has_pdf):
    print("=" * 60)
    print("prep.py — souhrn")
    print("=" * 60)
    print("Deck:        %s" % config["deckName"])
    print("Počet slidů: %d" % config["slideCount"])
    print("PDF:         %s" % ("content/slides.pdf" if has_pdf
                               else "(nedodáno --pdf; app očekává content/slides.pdf)"))
    if config["videos"]:
        print("Videa (%d):" % len(config["videos"]))
        for v in config["videos"]:
            print("  slide %-3d → %-24s  poz [x=%.4f y=%.4f w=%.4f h=%.4f]"
                  % (v["slide"], v["file"], v["x"], v["y"], v["w"], v["h"]))
    else:
        print("Videa:       žádná nenalezena")
    if warnings:
        print("-" * 60)
        print("VAROVÁNÍ (%d):" % len(warnings))
        for w in warnings:
            print("  ! " + w)
    print("=" * 60)


# ---- Self-test -------------------------------------------------------------

def _build_synthetic_pptx(path):
    """
    Sestaví minimální syntetický PPTX se 2 slidy; slide 2 obsahuje jedno fake
    video (rel /video + rel /media na stejný soubor media1.MOV) s xfrm.
    Velikost slidu 12192000 x 6858000 (16:9). xfrm videa: off (0.5,0.5),
    ext (0.5,0.5) → očekávané fractions 0.5/0.5/0.5/0.5.
    """
    P = NS["p"]; A = NS["a"]; R = NS["r"]
    REL = NS["rel"]
    CT = "http://schemas.openxmlformats.org/package/2006/content-types"

    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="%s">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="mov" ContentType="video/quicktime"/>'
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
        '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        '</Types>'
    ) % CT

    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="%s">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
        '</Relationships>'
    ) % REL

    presentation = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:presentation xmlns:p="%s" xmlns:r="%s">'
        '<p:sldIdLst>'
        '<p:sldId id="256" r:id="rId1"/>'
        '<p:sldId id="257" r:id="rId2"/>'
        '</p:sldIdLst>'
        '<p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>'
        '</p:presentation>'
    ) % (P, R)

    presentation_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="%s">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>'
        '</Relationships>'
    ) % REL

    slide1 = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:sld xmlns:p="%s" xmlns:a="%s" xmlns:r="%s">'
        '<p:cSld><p:spTree></p:spTree></p:cSld>'
        '</p:sld>'
    ) % (P, A, R)

    # slide2: p:pic s a:videoFile r:link="rId2" (rId2 = /video), xfrm 0.5/0.5/0.5/0.5
    slide2 = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:sld xmlns:p="%s" xmlns:a="%s" xmlns:r="%s">'
        '<p:cSld><p:spTree>'
        '<p:pic>'
        '<p:nvPicPr>'
        '<p:cNvPr id="4" name="Video"/>'
        '<p:cNvPicPr/>'
        '<p:nvPr><a:videoFile r:link="rId2"/></p:nvPr>'
        '</p:nvPicPr>'
        '<p:blipFill><a:blip/></p:blipFill>'
        '<p:spPr>'
        '<a:xfrm>'
        '<a:off x="6096000" y="3429000"/>'
        '<a:ext cx="6096000" cy="3429000"/>'
        '</a:xfrm>'
        '</p:spPr>'
        '</p:pic>'
        '</p:spTree></p:cSld>'
        '</p:sld>'
    ) % (P, A, R)

    slide1_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="%s"></Relationships>'
    ) % REL

    # rId2 = /video, rId3 = /media (obojí na stejný soubor → test dedupe)
    slide2_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="%s">'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/media1.MOV"/>'
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/media" Target="../media/media1.MOV"/>'
        '</Relationships>'
    ) % REL

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", root_rels)
        zf.writestr("ppt/presentation.xml", presentation)
        zf.writestr("ppt/_rels/presentation.xml.rels", presentation_rels)
        zf.writestr("ppt/slides/slide1.xml", slide1)
        zf.writestr("ppt/slides/slide2.xml", slide2)
        zf.writestr("ppt/slides/_rels/slide1.xml.rels", slide1_rels)
        zf.writestr("ppt/slides/_rels/slide2.xml.rels", slide2_rels)
        zf.writestr("ppt/media/media1.MOV", b"\x00\x01\x02JUNKMOVBYTES\x03\x04")


def self_test():
    print("prep.py --self-test: sestavuji syntetický PPTX…")
    tmp = tempfile.mkdtemp(prefix="preptest_")
    failures = []
    try:
        pptx = os.path.join(tmp, "selftest.pptx")
        _build_synthetic_pptx(pptx)

        out = os.path.join(tmp, "content")
        # allow_remux=False: junk bytes nejsou remuxovatelné (guard)
        res = build_content(pptx, pdf_path=None, out_dir=out,
                            allow_remux=False, verbose=True)
        cfg = res["config"]

        def check(cond, msg):
            status = "OK  " if cond else "FAIL"
            print("  [%s] %s" % (status, msg))
            if not cond:
                failures.append(msg)

        # 1) Počet slidů z sldIdLst
        check(cfg["slideCount"] == 2, "slideCount == 2 (z sldIdLst)")

        # 2) deckName z názvu souboru
        check(cfg["deckName"] == "selftest", "deckName == 'selftest'")

        # 3) Právě jedno video (dedupe video+media → 1)
        check(len(cfg["videos"]) == 1,
              "právě 1 video (dedupe /video + /media)")

        if cfg["videos"]:
            v = cfg["videos"][0]
            # 4) Detekováno na zobrazovaném slidu 2
            check(v["slide"] == 2, "video na display-slajdu 2 (pořadí z sldIdLst)")
            # 5) Fractions správně (0.5/0.5/0.5/0.5)
            check(v["x"] == 0.5 and v["y"] == 0.5 and v["w"] == 0.5 and v["h"] == 0.5,
                  "fractions x=y=w=h=0.5 (z xfrm/sldSz)")
            # 6) Reference na .mov (malé písmo přípony), remux přeskočen
            check(v["file"] == "videos/media1.mov",
                  "reference videos/media1.mov (přípona zmenšena, remux přeskočen)")
            # 7) Soubor skutečně extrahován
            extracted = os.path.join(out, "videos", "media1.mov")
            check(os.path.isfile(extracted) and os.path.getsize(extracted) > 0,
                  "video soubor extrahován a neprázdný")

        # 8) config.json je validní JSON na disku
        try:
            with open(res["config_path"], "r", encoding="utf-8") as fh:
                json.load(fh)
            check(True, "config.json je validní JSON")
        except Exception as e:
            check(False, "config.json validní JSON (%s)" % e)

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("-" * 60)
    if failures:
        print("SELF-TEST SELHAL: %d asercí neprošlo." % len(failures))
        return 1
    print("SELF-TEST OK: všechny asercie prošly.")
    return 0


# ---- CLI -------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Příprava obsahu (videa + config.json) pro townhall-titulky.")
    ap.add_argument("--pptx", help="cesta k .pptx")
    ap.add_argument("--pdf", help="cesta k exportovanému .pdf (zkopíruje se do content/slides.pdf)")
    ap.add_argument("--out", default="content", help="výstupní adresář (default: content)")
    ap.add_argument("--self-test", action="store_true", help="spustí interní test a skončí")
    args = ap.parse_args(argv)

    _force_utf8_stdio()

    if args.self_test:
        return self_test()

    if not args.pptx:
        ap.error("chybí --pptx (nebo použij --self-test)")

    if not os.path.isfile(args.pptx):
        print("CHYBA: PPTX neexistuje: %s" % args.pptx, file=sys.stderr)
        return 2
    if args.pdf and not os.path.isfile(args.pdf):
        print("CHYBA: PDF neexistuje: %s" % args.pdf, file=sys.stderr)
        return 2

    build_content(args.pptx, pdf_path=args.pdf, out_dir=args.out,
                  allow_remux=True, verbose=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
