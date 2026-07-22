# Worklog — poznámky k rozhodnutím (02-wizard)

Rozhodnutí při nejasnostech (ground rule 5: sensible default + poznámka, nezastavovat).

## Obecné

- Prompt 2 nemá „Phase 0" — doslovná kopie promptu (`docs/worklog/02-wizard.md`)
  a tento soubor poznámek se commitují s Fází 1.
- `.gitignore` zkontrolován: `/[0-9]*.md`, `content/`, `publish/` ignorovány — beze změny.

## Fáze 1 — prep.py

- `SameFileError` fix: guard `os.path.exists(src) and os.path.exists(dst) and
  os.path.samefile(src, dst)` → kopie se tiše přeskočí. `samefile` se volá jen
  když obě cesty existují (na Windows by na neexistující cestě padal OSError).
- Refaktor: jádro pipeline přesunuto do `prepare_content(pptx_path, pdf_path,
  out_dir, allow_remux, progress_cb)` — vrací summary dict
  `{deckName, slideCount, videos, warnings}` (přesně data z config.json).
  Kroky `progress_cb`: `analyze → videos → pdf → config → done`; pořadí je
  exportované jako konstanta `PROGRESS_STEPS` (použije ji server API i testy).
- **Rozhodnutí (default):** krok `pdf` se přes `progress_cb` hlásí i když
  `pdf_path=None` (sekvence kroků je stabilní pro UI wizardu; jen se nic
  nekopíruje). Self-test asertuje plnou sekvenci.
- `build_content` zůstává jako zpětně kompatibilní obálka se stejným návratovým
  tvarem `{config, warnings, config_path}` a stejným CLI výstupem — chování CLI
  beze změny (ověřeno self-testem, který přes `build_content` dál běží).
- Self-test rozšířen: same-file PDF (nespadne + obsah souboru nezničen),
  `prepare_content` s nahrávacím `progress_cb` (asertuje sekvenci kroků
  i tvar summary). **12/12 asercí OK, exit 0.**

## Fáze 2 — server API

- `serve.py` byl už vázán na `127.0.0.1` — ověřeno, doplněn výslovný komentář.
- **Kroky jobu:** `upload → analyze → videos → pdf → config → done`
  (stepsTotal 6). `prepare_content` hlásí `pdf`/`config` PŘED exportem PDF
  (config.json zapisuje pipeline); server její `pdf`/`config`/`done` potlačuje
  a hlásí vlastní `pdf` (COM export) → `config` (přepis deckName + finální
  kontrola) → `done`, aby pořadí řádků ve wizardu odpovídalo skutečnému průběhu.
- **deckName:** upload se vždy ukládá jako `content/source.pptx` (klientský
  název se nikdy nepoužívá jako cesta). `prepare_content` proto odvodí deckName
  „source" — server ho v kroku `config` přepíše sanitizovaným stem původního
  názvu souboru (jen metadata do config.json + summary).
- **Rozhodnutí (default):** `summary` se ve statusu vrací i pro stav
  `needs_manual_pdf` (spec ho výslovně chce u `done`) — wizard tak i v manuální
  větvi může ukázat počty slidů/videí; videa+config jsou v té chvíli hotové.
- Multipart parser: ruční streamující (stdlib `cgi` je v Pythonu 3.13
  odstraněný). Tělo se čte po 64 KB, payload streamuje do `content/upload.tmp`
  s drženým „ocasem" délky boundary (marker nemůže být rozpůlen), pak atomický
  `os.replace` na `source.pptx`. Chunked TE → 411, chybějící Content-Length →
  411, > 2 GB → 413, ne-multipart → 400. Neúspěšná validace vrací job do `idle`.
- Export PDF: `content/slides.tmp.pdf` → `os.replace` na `slides.pdf` až po
  úspěchu; při selhání se tmp maže a starý `slides.pdf` zůstává. stderr
  z PowerShellu se dekóduje postupně utf-8 → cp1250 → cp852 (PS 5.1 píše podle
  konzole; pozorováno UTF-8 → mojibake při `text=True`, proto ruční dekódování).
- `.ps1` soubory uloženy **s UTF-8 BOM** — PowerShell 5.1 čte skripty bez BOM
  jako ANSI a české řetězce v odpovědích by byly rozbité (ověřeno curl testem
  před/po). Týká se `serve.ps1` (501 JSON) i `export-pdf.ps1`.
- **Incident při testu (zamčený soubor):** první verze `test-api.py` zálohovala
  celé `content/` přes `shutil.move` — spadla, protože operátor měl v
  `content/` reálný deck `Townhall Q1 2026 CZ-En-UA-2 v1.pptx` **otevřený
  v PowerPointu** (drží zámek; zjištěno přes Restart Manager API, PID 34704,
  živé okno). Proces jsem NEZABÍJEL (ground rule 7 míří na naše vlastní
  operace, ne na živou práci operátora — kill by mohl zahodit neuložené změny).
  Místo toho test zálohuje/obnovuje POUZE fixní názvy, do kterých pipeline
  zapisuje (`config.json`, `slides.pdf`, `slides.tmp.pdf`, `source.pptx`,
  `upload.tmp`, `videos/`) — operátorových souborů se nedotýká. `shutil.move`
  stihl před pádem obsah zkopírovat do zálohy, takže NIC se neztratilo;
  `content/` byl plně obnoven (deck, PDF, config, 4 videa) a ověřen.
- **PowerPoint na tomto stroji JE nainstalovaný** (prompt předpokládal opak).
  COM export se syntetickým junk-deckem reálně proběhl a PowerPoint ho korektně
  odmítl (0x80070570 „soubor je poškozen") → stav `needs_manual_pdf`. Test
  akceptuje `done` i `needs_manual_pdf` (podle přítomnosti/úspěchu PowerPointu)
  a asertuje větvově správné chování.
- **Ověření Fáze 2:** `tools/test-api.py` — **21/21 asercí OK, exit 0**
  (content/status, idle→running→needs_manual_pdf, 202+jobId, 409 souběh,
  400 ne-multipart, 411 chunked, extrakce videa, config zapsán, deckName
  přepsán, žádný slides.tmp.pdf po selhání, obnova content/). `serve.ps1`:
  `/api/*` → 501 s českou JSON hláškou, statika dál 200.

## Fáze 3 — wizard UI

- Wizard je samostatný modul `app/wizard.js` (konzistentně s panel.js);
  obrazovky: confirm → drop → progress → done | manual (needs_manual_pdf)
  | error. Stavy řádků: ○ pending / spinner running / ✓ done / ✕ failed.
  Upload přes XHR (progress events → % v řádku „Nahrávání souboru"),
  vše ostatní `fetch`; poll 500 ms.
- **Rozhodnutí (default):** Esc zavírá wizard z obrazovek `drop` i `confirm`
  (spec jmenuje jen drop zónu; confirm je také „nic neběží"). Z progress/done/
  manual/error Esc nezavírá (mid-job zákaz dle spec; done/manual mají explicitní
  tlačítka). Esc se vždy pohltí, aby neotevřel start panel pod wizardem.
- **Nalezená chyba (capture listenery na stejném uzlu):** Esc ve wizardu zavřel
  wizard a `onClose` ukázal start panel — jenže tentýž keydown pak doběhl do
  capture listeneru panelu (stopPropagation nezastaví další listenery na tomtéž
  uzlu), panel byl už viditelný → hned se zase schoval. Oprava:
  `stopImmediatePropagation()` v Esc větvi wizardu.
- Tlačítko „Nahrát novou prezentaci" je na start panelu jen v ne-running stavu
  (během běžících titulků se deck nemění; nejdřív „Zastavit titulky").
- Auto-otevření wizardu při startu: app.js volá `/api/content/status`; když
  `!hasPdf || !hasConfig` → panel se schová a otevře se drop zóna
  (`skipConfirm`). Při 501 (statický serve.ps1) nebo výpadku API se wizard
  neotvírá — panel zůstává se svým varováním o chybějícím obsahu; kliknutí na
  „Nahrát novou prezentaci" pak 501 hlášku serveru zobrazí v error obrazovce.
- **Poznámka ke „konzole čistá":** při záměrně chybějícím obsahu browser VŽDY
  zaloguje resource-error `content/config.json 404` (fetch selhání loguje síťová
  vrstva, JS ho potlačit nemůže; appka stav řeší setup hláškou). Test tento
  jeden očekávaný řádek filtruje podle URL; cokoli jiného = fail.
- **Incident (stale server):** na portu 8137 běží operátorův server spuštěný
  přes start.bat ve 21:17 — tedy kód PŘED commitem API (22:24) → `/api/*`
  vrací statické 404. Proces jsem nezabíjel (živá práce operátora); testy běží
  na izolovaných portech 8151/8152 (app používá relativní URL). Operátor musí
  před použitím wizardu server restartovat: `stop.bat` + `start.bat` (uvedeno
  v souhrnu i README).
- Puppeteer testy zálohují/obnovují v `content/` opět jen fixní pipeline
  názvy — operátorův deck (otevřený v PowerPointu) zůstává nedotčen.
- **Ověření Fáze 3 (Puppeteer + reálný Chrome + reálné API):** **12/12 asercí
  OK, 0 neočekávaných chyb v konzoli** — auto-otevření wizardu při chybějícím
  obsahu, odmítnutí ne-.pptx, upload → progress → needs_manual_pdf (PowerPoint
  odmítl junk deck), návod na ruční export, ručně dodané PDF + „Zkontrolovat
  znovu" → Done se souhrnem „selftest · 2 slajdy · 1 video (slajd 2)",
  „Pokračovat" → reload → panel s názvem decku, confirm při přepisu, blokace
  kláves pod wizardem, Esc→zpět na panel.
