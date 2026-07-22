# Worklog — poznámky k rozhodnutím (01-bootstrap)

Zde jsou zaznamenaná rozhodnutí učiněná při nejasnostech (dle ground rule 6:
*„On any ambiguity: choose a sensible default, note it here, do not stop."*).

## Prostředí (zjištěno na začátku)

- OS: Windows 11 Pro, PowerShell.
- Cesta k repu obsahuje mezery: `…\Projekty pro prezentaci\townhall-titulky` →
  ve všech `.bat` a skriptech se cesty **důsledně uvozovkují**.
- Node `v22.12.0` (pro `node --check`).
- Python `3.13.1`, dostupné jako `py -3` i `python`.
- `ffmpeg` je na PATH (gyan.dev build) → remux MOV→MP4 ve Fázi 2 je k dispozici.
- Git remote `origin` = `https://github.com/amonvo/townhall-titulky.git`, **prázdný**
  (žádné commity) → první push ho naplní. Auth funguje (ls-remote projde).

## Fáze 0

- `.gitignore` obsahuje `/1.md` i obecný vzor `/[0-9]*.md`, dále `content/`,
  `publish/`, `node_modules/`, `.DS_Store`, `Thumbs.db`, `*.log`, `__pycache__/`.
  Navíc přidán `.server.pid` (píše ho `start.bat` ve Fázi 5) — smetí, do gitu nepatří.
- `docs/worklog/01-bootstrap.md` = doslovná kopie `1.md`.
- README je zatím jen kostra (CZ), doplní se ve Fázi 5.

## Fáze 1

- Vendorováno `pdfjs-dist@4.10.38` (poslední stabilní 4.x): `pdf.min.mjs`,
  `pdf.worker.min.mjs`, `LICENSE`. Ověřeno, že řetězec verze `4.10.38` je v obou
  souborech. `vendor/pdfjs/README.md` popisuje původ a postup aktualizace.
- `app.js` importuje `pdf.min.mjs`, nastaví `GlobalWorkerOptions.workerSrc` na
  vendorovaný worker, vypíše verzi do konzole i do dočasného `#boot-status`.
- **DŮLEŽITÉ ZJIŠTĚNÍ (řeší se ve Fázi 5):** Pythonův `http.server` servíruje
  `.mjs` jako `text/plain`. Chrome kvůli *strict MIME checking* modul odmítne
  (`Failed to load module script … MIME type of "text/plain"`). Celá appka jsou
  ES moduly importující `.mjs`, takže **holý `python -m http.server` appku
  nerozběhne**. Řešení: primární server bude `serve.ps1` (Fáze 5) se správnými MIME
  typy (`.mjs` → `text/javascript`) a Range podporou; případný Python fallback musí
  MIME pro `.mjs` opravit. Rozhodnutí o pořadí serverů viz poznámky k Fázi 5.
- Ověření Fáze 1 (headless Chrome, server se správným `.mjs` MIME): DOM ukazuje
  `pdf.js 4.10.38 ✓`, konzole obsahuje jediný řádek (log verze), **žádné chyby**.
- `node --check` prošel na `app/app.js`, `app/slides.js`, `app/captions.js`
  i na obou vendorovaných `.mjs`.

## Fáze 2 — prep.py

- Pouze stdlib (`zipfile`, `xml.etree.ElementTree`, `argparse`, `json`, `shutil`,
  `subprocess`, `posixpath`). PPTX se pouze čte, nikdy neserializuje zpět.
- Pořadí slidů: `p:sldIdLst` → `r:id` → `presentation.xml.rels` → `slideN.xml`.
  Zobrazované číslo = pozice v `sldIdLst`, ne N v `slideN.xml`.
- Video rely: `Type` končící `/video`, dedupe podle cílového souboru (video se
  vyskytuje 2× — jako `/video` a `/media`). Párování na `<p:pic>` přes
  `<a:videoFile r:link|r:embed>`. Pozice z `<p:spPr><a:xfrm>` → zlomky vůči `sldSz`,
  zaokrouhleno na 4 desetinná místa. Chybějící xfrm → fallback `{0,0,1,1}` + varování.
- MOV: je-li `ffmpeg` na PATH, bezeztrátový remux `-c copy` na MP4; jinak MOV zůstává
  s viditelným varováním. V self-testu je remux vypnutý (junk bytes nejsou
  remuxovatelné) přes `allow_remux=False`.
- **Rozhodnutí (default):** Windows konzole je cp1250 a padala na znaku `→`
  (`UnicodeEncodeError`). Přidán `_force_utf8_stdio()`, který přepne stdout/stderr
  na UTF-8 s `errors="replace"`. Výpis tak nikdy nespadne.
- `--self-test` staví syntetický 2-slajdový PPTX (slide 2 = 1 fake video, xfrm
  0.5/0.5/0.5/0.5, rely `/video`+`/media` na stejný soubor) a asertuje: slideCount,
  deckName, dedupe→1 video, display-slide 2, fractions, přípona zmenšena, extrakce
  souboru, validní config.json. **Exit 0.**
- `content/source.pptx` na tomto stroji **neexistuje** → prep proti reálnému decku
  neběžel (dle akceptace jen zaznamenat a pokračovat). Operátor ho spustí dle README.

## Fáze 3 — slides.js

- pdf.js setup vytažen do `app/pdf.js` (importují app.js i slides.js) → worker se
  nastavuje na jednom místě, žádná cyklická závislost.
- Render do `<canvas>` v rozlišení `devicePixelRatio`, fit-scale = `min` poměrů vůči
  #stage, re-render na `resize`/`fullscreenchange` s debounce 150 ms. `renderToken`
  ruší zastaralé async rendery (rychlé listování).
- **Rozhodnutí (default):** „Preload next/prev offscreen" řešeno přednačtením
  `getPage(n±1)` (dekódování), ne plným offscreen renderem do canvasu. pdf.js si
  stránky cachuje, takže překreslení po navigaci je okamžité; plný offscreen render
  by přidal složitost bez znatelného přínosu na 78vh ploše.
- Video overlay: `<video>` v `.video-wrap` pokládán absolutně nad vykreslený
  obdélník slajdu; pozice se počítá z `canvas.getBoundingClientRect()` vůči
  `#stage` (letterbox korektní i po resize). `preload="auto"` jen pro aktuální
  slajd, jinak `none`. Není `muted`. Play badge (▶) mizí při přehrávání. Opuštění
  slajdu video pauzne (pozice zůstává) a skryje.
- **Chyby nalezené a opravené při ověření (Puppeteer + reálný Chrome):**
  1. `goTo(1)` na startu předčasně končil, protože default `canvas.width` (300) je
     truthy → slajd 1 se nevykreslil. Oprava: `current` startuje na `0`, guard
     zjednodušen na `clamped === current`.
  2. `favicon.ico` → 404 v konzoli. Oprava: `<link rel="icon" href="data:,">`.
- **Ověření Fáze 3 (Puppeteer, reálný Chrome, headless):** 3str. testovací PDF +
  1 video entry (slide 2, x0.25/y0.25/w0.5/h0.5). Všech 13 asercí OK, **0 chyb
  v konzoli**: counter 1/3, render canvasu, Šipky/Home/End, geometrie videa přesně
  odpovídá zlomkům, repozice po resize, Space přehraje video a nemění counter,
  opuštění slajdu skryje+pauzne video. Testovací PDF/video/config jsou v `content/`
  (gitignored, necommitováno). Generátor PDF byl throwaway a byl smazán.

## Fáze 4 — captions.js

- Jádro engine převzato z prototypu (APPENDIX A) **beze změny logiky**: `cs-CZ`,
  `continuous`, `interimResults`, auto-restart v `onend` (250 ms, při selhání
  recreate recognizer), `not-allowed`/`service-not-allowed` → panel hláška.
  Kaskáda `translate()`: Google `client=gtx` → LibreTranslate (`LIBRE_URL`, prázdný
  default) → `null` (poslední záchrana: čeština s prefixem `· `). Fail-counter +
  15 s cooldown zachován. Sekvenční ochrana `seq`/`shownSeq`/`finalSeq`,
  `INTERIM_THROTTLE_MS=1200`. `CORRECTIONS` + `applyCorrections()` s Unicode
  hranicemi. Wake lock + `visibilitychange` re-acquire.
- Nová UI v pásu #captions: dva stejně velké řádky EN (#F5F7FA) a UK (#FFD966),
  každý label + prev (2.6vh, 55 %) + curr (4.2vh, 600). Český mini-řádek skrytý,
  přepíná `C`. `+`/`-` mění `--scale` (0.7–1.5), který škáluje jen písmo titulků.
  Status pills vpravo nahoře (mikrofon/překlad) se stavy ok/warn/err + REC tečka
  (#EE3024, 2 s pulse) při poslechu. Pills se přidávají do `registerTransient`
  (mizí s counterem po 4 s), každá změna stavu volá `showTransient()` → objeví se.
- **Rozhodnutí (default):** klávesy `+`/`-`/`C` řeší captions.js vlastním keydown
  listenerem (disjunktní od kláves ve slides.js), moduly zůstávají nezávislé.
  Mikrofon se NEspouští automaticky — spustí ho start panel (Fáze 5); `onMicDenied`
  je zatím napojen na `console.warn`, panel ho převezme.
- **Ověření Fáze 4 (Puppeteer, reálný Chrome):** 13/13 asercí OK, **0 chyb**:
  pills ve výchozím stavu, EN/UK labely, český řádek skrytý → `C` přepíná, `+/-`
  mění a klampuje `--scale` na 0.7–1.5, `start()` funguje a aplikace dál naviguje.
  Reálný tok mikrofonu ověří operátor (sekce VERIFY).

## Fáze 5 — start panel, launcher, docs

- **Start panel jako samostatný modul `app/panel.js`** (není v seznamu souborů ve
  specifikaci — ta panel řadí pod „index.html completed in Phases 3–5"). Default:
  vlastní modul drží `app.js` jako čistý orchestrátor, konzistentně s captions.js.
  Panel se staví v JS (jako captions UI), index.html se nemění.
- Panel: titulek, deck name + počet slajdů z configu (české plurály 1 slajd /
  2–4 slajdy / 5+ slajdů), kompat. varování (ne-Chrome či chybějící
  SpeechRecognition, `file://`, chybějící obsah), primární tlačítko
  `Spustit prezentaci s titulky` (#2F6FEB) + ghost `Jen prezentace (bez titulků)`,
  legenda kláves. `Esc` panel znovu otevře; v běžícím stavu nabízí `Pokračovat`
  (primární) + `Zastavit titulky`. `onMicDenied` z captions.js zobrazí panel
  s červenou zprávou.
- **Rozhodnutí (default):** dokud je panel otevřený, klávesy aplikace (šipky,
  mezerník, F, +/−, C…) se blokují capture-fází keydown, aby prezentace
  „neujížděla" pod overlayem. Esc při zavřeném panelu ho otevírá (bubble listener).
- `slides.js` nově vrací `config` (i při selhání PDF), aby panel měl deck name
  a počet slajdů; jinak beze změny.
- Odstraněn mrtvý CSS blok `#boot-status` (element zmizel už ve Fázi 3).
- **Netrackované `tools/serve.ps1` a `tools/serve.py` existovaly v repu už před
  Fází 5** — zkontrolovány proti specifikaci a převzaty: `serve.ps1` =
  HttpListener, MIME mapa (.html/.css/.js/.mjs/.json/.pdf/.mp4/.mov), single-range
  `bytes=start-`/`start-end`/`-N` s 206/Accept-Ranges/Content-Range, ochrana proti
  path traversal. `serve.py` = stdlib server se stejnou MIME mapou a Range
  podporou, navíc **vícevláknový** (ThreadingMixIn).
- **Rozhodnutí — pořadí serverů ve `start.bat` (odchylka od litery specifikace):**
  specifikace navrhuje `py -3 -m http.server` → `python -m http.server` →
  `serve.ps1`. Holý `http.server` ale appku vůbec nenačte (`.mjs` → `text/plain`,
  strict MIME checking — zjištění Fáze 1) a neumí Range. Proto `start.bat` spouští
  `tools/serve.py` (`py -3` → `python`) a až bez Pythonu `serve.ps1`. Python
  server je default, protože je vícevláknový (paralelní requesty při načítání
  aplikace + streamování videa), `serve.ps1` obsluhuje požadavky sériově.
  Oba servery ověřeny curl testy: správné MIME (`.mjs` → `text/javascript`)
  a Range → `206 Partial Content` se správným `Content-Range` (`bytes=0-99`
  i `bytes=100-`).
- `.bat` soubory jsou záměrně **bez diakritiky** (ASCII) — cmd s výchozí kódovou
  stránkou cp852/1250 by UTF-8 texty komolil. PID serveru se získává přes
  `Start-Process -PassThru` (batch `start` PID vracet neumí); `taskkill /T`
  ve `stop.bat` zabije i child `python.exe` pod `py.exe`. Cesty všude
  v uvozovkách (cesta k repu obsahuje mezery).
- `start.bat` navíc: pokud port 8137 už odpovídá, server se nespouští znovu
  (jen se otevře prohlížeč); Chrome se hledá na obvyklých instalačních cestách
  (ProgramFiles, ProgramFiles(x86), LocalAppData), jinak výchozí prohlížeč.
- **Ověření Fáze 5:**
  - `node --check`: všech 5 app modulů + oba vendorované `.mjs` — OK.
  - `py -3 tools/prep.py --self-test` — exit 0, všechny asercie OK.
  - curl testy MIME + Range na `serve.py` (8137) i `serve.ps1` (8138) — OK
    (viz výše).
  - Puppeteer + reálný Chrome (headless): **14/14 asercí OK, 0 chyb v konzoli** —
    panel viditelný na startu se správným titulkem/podtitulkem/tlačítky/legendou,
    šipka při otevřeném panelu nenaviguje, `Jen prezentace` zavře panel a
    navigace funguje, `Esc` panel znovu otevře, `Spustit` → mikrofon běží +
    panel skryt, `Esc` v běhu → `Zastavit titulky`/`Pokračovat`, `Zastavit`
    vrátí start tlačítka.
  - `start.bat` end-to-end: server nastartoval přes `py -3 tools\serve.py`,
    `.server.pid` zapsán, `GET /` → 200, Chrome otevřen. `stop.bat`: proces
    zabit, `.server.pid` smazán, port už neodpovídá.
- `content/source.pptx` stále neexistuje → prep proti reálnému decku neběžel
  (jen zaznamenáno dle akceptace Fáze 2; operátor postupuje dle README).
- Screenshoty a reálný mikrofonní tok jsou na operátorovi (sekce VERIFY promptu
  — „do not execute, just leave the app ready").
