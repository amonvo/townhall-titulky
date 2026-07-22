# Prompt 1 — Bootstrap "townhall-titulky": live-caption presentation app

You are building a **single-screen presentation application** for a corporate townhall.
A manager presents slides (originally PowerPoint) and speaks Czech into a microphone.
The app renders the slides fullscreen AND shows live captions translated to **English
and Ukrainian** in a dedicated caption band at the bottom. Everything runs locally in
Google Chrome on a Windows notebook, served from `http://localhost` — **zero cost, no
API keys, no accounts**.

Repository: `https://github.com/amonvo/townhall-titulky.git`, branch `main`.
If the current folder is not yet a git repo, clone the repository (or `git init`,
add the remote, and pull if the remote already has commits). Work on `main`.

## Non-negotiable ground rules (apply to every phase)

1. **FIRST ACTION:** ensure `.gitignore` exists and contains `/1.md` (and a pattern
   for future prompts, e.g. `/[0-9]*.md`) — prompt files are never committed.
2. `content/` and `publish/` are **gitignored** — presentation media (PPTX, PDF,
   videos, 100+ MB) never enters git history.
3. This is a **no-build static app** (plain HTML/CSS/JS, ES modules). "Build passes"
   means: every page loads in a browser with **zero console errors**, and `node
   --check` passes on every `.js` file. The only test suite is `tools/prep.py
   --self-test` (Phase 2) — it must exit 0.
4. **Commit + push after every phase.** Conventional commit messages (`feat:`,
   `fix:`, `chore:`, `docs:`).
5. Save this entire prompt as `docs/worklog/01-bootstrap.md` and commit it with
   Phase 0.
6. On any ambiguity: choose a sensible default, note it in
   `docs/worklog/01-bootstrap-notes.md`, do not stop.
7. If a file is locked during any operation, a process is holding it — stop the
   process, don't "fix" code.
8. **No CDN dependencies at runtime.** Everything the app needs at showtime must be
   vendored in the repo (the venue's network may be restricted). The only runtime
   network calls allowed are the translation endpoints themselves.

---

## Phase 0 — Repo bootstrap

- `.gitignore`: prompt files (`/[0-9]*.md`), `content/`, `publish/`, `node_modules/`,
  `.DS_Store`, `Thumbs.db`, `*.log`, `__pycache__/`.
- `README.md` skeleton (Czech, will be completed in Phase 5): project name, one-line
  purpose, "Dokumentace se doplňuje" placeholder.
- `docs/worklog/01-bootstrap.md` = this prompt, verbatim.
- Commit `chore: bootstrap repository` + push.

## Phase 1 — Project structure & vendored PDF.js

Create:

```
index.html          # the app (shell in this phase, completed in Phases 3–5)
app/app.css
app/app.js          # ES module entry
app/captions.js     # caption engine (Phase 4)
app/slides.js       # PDF rendering + navigation + video overlay (Phase 3)
vendor/pdfjs/       # pdf.min.mjs + pdf.worker.min.mjs (pinned version)
tools/prep.py       # Phase 2
tools/serve.ps1     # Phase 5
content/            # gitignored; runtime content lives here
  .gitkeep is NOT needed (folder is created by prep.py / documented in README)
start.bat
stop.bat
docs/worklog/
```

- Vendor **pdfjs-dist v4.x** (a pinned 4.x release): download `pdf.min.mjs` and
  `pdf.worker.min.mjs` (plus the license file) into `vendor/pdfjs/`. Use npm pack or
  a GitHub release download — whatever is reliable — but the final state is plain
  files committed to the repo, no `node_modules` at runtime.
- `index.html` loads `app/app.js` as `type="module"`; `app.js` imports pdf.js from
  `vendor/pdfjs/pdf.min.mjs` and sets `GlobalWorkerOptions.workerSrc` to the vendored
  worker. Prove it works: on load, log the pdf.js version into the console and show
  it in a temporary status line in the page.
- Acceptance: opening `http://localhost:8137/` shows the shell page, console clean,
  pdf.js version logged.
- Commit `feat: app shell with vendored pdf.js` + push.

## Phase 2 — `tools/prep.py`: extract videos + build content config

Python 3, **stdlib only** (zipfile, xml.etree/defused not required — use
`xml.dom.minidom` or `xml.etree.ElementTree`, reading only, never re-serializing the
PPTX). Optional dependency: if `ffmpeg` is on PATH it will be used; otherwise skipped.

CLI:

```
python tools/prep.py --pptx path/to/deck.pptx [--pdf path/to/deck.pdf] [--out content]
python tools/prep.py --self-test
```

Behavior:

1. **Slide order mapping (critical, do not skip):** parse
   `ppt/presentation.xml` → `<p:sldIdLst>` order, resolve each `r:id` through
   `ppt/_rels/presentation.xml.rels` to the actual `slideN.xml` file. Slide *display
   number* = position in `sldIdLst`, **not** the N in `slideN.xml`.
2. Read slide size from `<p:sldSz>` (EMU).
3. For each slide, parse `ppt/slides/_rels/slideM.xml.rels` with an XML parser (no
   regex — attribute order varies, extensions vary in case, e.g. `media1.MOV`).
   Collect relationships whose `Type` ends with `/video`. Dedupe targets (each video
   appears twice: `video` + `media` relationship).
4. In the slide XML, find the `<p:pic>` whose `<a:videoFile>` references that rel id;
   read `<a:off>`/`<a:ext>` from its `<p:spPr><a:xfrm>`. Convert to **fractions of
   slide size**: `x = off.x / sldSz.cx`, etc. If a video has no xfrm (inherits from
   layout), fall back to full-slide `{0,0,1,1}` and log a warning.
5. Extract each referenced video into `content/videos/` (keep original basename,
   lowercase the extension).
6. If the container is `.mov` and `ffmpeg` is available: remux losslessly
   (`ffmpeg -y -i in.mov -c copy out.mp4`) and reference the `.mp4`. If ffmpeg is
   missing, keep the `.mov` and print a visible warning that playback must be tested
   in Chrome (H.264/AAC in MOV usually plays, but test).
7. If `--pdf` given, copy it to `content/slides.pdf`.
8. Write `content/config.json`:

```json
{
  "pdf": "slides.pdf",
  "slideCount": 32,
  "deckName": "Townhall_Q1_2026",
  "videos": [
    { "slide": 27, "file": "videos/media2.mp4",
      "x": 0.48, "y": 0.40, "w": 0.49, "h": 0.49 }
  ]
}
```

   (`slide` = 1-based display number; fractions rounded to 4 decimals; `deckName`
   derived from the PPTX filename; `slideCount` from `sldIdLst` length.)
9. Print a human summary: slide count, videos found (slide → file → position),
   warnings.
10. **`--self-test`:** programmatically build a minimal synthetic PPTX in a temp dir
    (zipfile writes: `[Content_Types].xml`, `_rels/.rels`, `ppt/presentation.xml`
    with 2 slides in `sldIdLst`, presentation rels, two slide XMLs + rels — slide 2
    contains one fake video rel pointing to a small dummy `ppt/media/media1.MOV`
    (a few bytes of junk is fine — extraction is being tested, not playback) with an
    xfrm). Run the full pipeline on it and **assert**: slide order mapping correct,
    video detected on display-slide 2, fractions computed correctly, file extracted,
    config.json valid. Exit non-zero on any assertion failure. Skip the ffmpeg remux
    step in self-test (junk bytes are not remuxable) — guard it.
11. Idempotent: re-running overwrites `content/` outputs cleanly.

- Acceptance: `python tools/prep.py --self-test` exits 0. Additionally, if
  `content/source.pptx` exists on this machine (the operator may have placed the
  real 220 MB deck there), run prep against it and include its summary output in the
  worklog notes; if it does not exist, note that and move on.
- Commit `feat: prep.py content pipeline with self-test` + push.

## Phase 3 — Slide rendering, navigation, video overlay (`app/slides.js`)

**Layout (16:9 reference, but resolution-agnostic — vh/vw units):**

- `#stage` — top **78vh**, background `#0B0F14`. The slide canvas is centered inside,
  scaled to fit (`min` of width/height constraints), with
  `box-shadow: 0 12px 48px rgba(0,0,0,.55)`. No border-radius.
- `#captions` — bottom **22vh** (Phase 4 fills it; reserve the band now with the
  gradient background `linear-gradient(180deg,#071426 0%,#04101E 100%)` and
  `border-top:1px solid rgba(255,255,255,.07)`).
- Slide counter bottom-right inside stage: `27 / 32`, `1.6vh`,
  `color:rgba(245,247,250,.35)`. Auto-hides after 4 s of no mouse movement, reappears
  on movement (same behavior will apply to status pills in Phase 4).

**Rendering:**

- Load `content/config.json`; load `content/slides.pdf` via vendored pdf.js.
- Render the current page into a canvas at `devicePixelRatio` resolution for
  crispness on the projector; re-render on `resize`/fullscreen change (debounced
  ~150 ms).
- Preload the next and previous page offscreen so navigation feels instant.
- If `content/` is missing or config fails to load: show a friendly Czech setup
  message in the stage area ("Chybí obsah — spusť tools/prep.py, viz README"), not a
  broken app.

**Navigation (presenter-clicker compatible):**

- Next: `ArrowRight`, `ArrowDown`, `PageDown`. Prev: `ArrowLeft`, `ArrowUp`,
  `PageUp`. `Home`/`End` = first/last.
- `Space`: on a video slide toggles video play/pause; on a normal slide = next
  (clicker compatibility).
- `F` = fullscreen toggle (with `.catch` guard).

**Video overlay:**

- For slides listed in `config.videos`: position an absolutely-placed `<video>` over
  the slide canvas using the stored fractions, **relative to the rendered slide
  rect** (compute the letterboxed canvas box, then place the video inside it; keep
  it correct on resize).
- `preload="auto"` for the current slide's video. No native controls; a minimal
  centered play badge (▶ in a translucent dark circle, `6vh` diameter) when paused;
  click or `Space` toggles. **Not muted** — the room must hear it. Playback starts
  only on explicit user gesture (key/click), which satisfies Chrome's autoplay
  policy.
- Leaving the slide pauses the video (position kept). Returning shows it paused
  where it was.
- Video element gets a subtle `box-shadow` matching the slide, no border.

- Acceptance: with a small **generated test PDF** (create a throwaway 3-page PDF in
  `content/` during development if the real one is absent — e.g. via a tiny Python
  script with reportlab if available, else any minimal hand-written PDF; do NOT
  commit it) navigation works, counter updates, a dummy video config entry overlays
  correctly and repositions on window resize. Console clean.
- Commit `feat: slide renderer with clicker navigation and video overlay` + push.

## Phase 4 — Caption engine (`app/captions.js`)

Port the proven engine from the previous standalone prototype **without changing its
logic**. The complete prototype is reproduced at the end of this prompt
(APPENDIX A) — treat it as the reference implementation. Specifically preserve:

- Web Speech API, `cs-CZ`, `continuous`, `interimResults`, auto-restart in `onend`
  (250 ms, recreate recognizer on failure), `not-allowed` error → panel message.
- `translate()` waterfall: Google `translate.googleapis.com …client=gtx` primary →
  LibreTranslate fallback (`LIBRE_URL` config, empty by default) → `null` (show
  Czech text prefixed `· ` in the prev line as last resort). Keep the
  fail-counter + 15 s cooldown behavior exactly.
- **Per-language sequence guards** (`seq` / `shownSeq` / `finalSeq`) so a late
  translation never overwrites a newer one. Keep `INTERIM_THROTTLE_MS = 1200`.
- `CORRECTIONS` array + `applyCorrections()` with the same Unicode-boundary regex,
  applied before display and translation.
- Wake lock + `visibilitychange` re-acquire.

**New UI inside `#captions` band (this replaces the prototype's presentation
layer):**

- Two language rows, **equal size**: EN then UK. Each row: label
  (`ENGLISH` / `УКРАЇНСЬКА`, `1.3vh`, `letter-spacing:.22em`, uppercase,
  `color:#64707E`, `font-weight:600`), previous line (`2.6vh`, 55 % opacity), current
  line (`4.2vh`, `font-weight:600`, `text-shadow:0 2px 6px rgba(0,0,0,.6)`).
  EN text `#F5F7FA`, UK text `#FFD966`.
- Optional Czech mini-row above EN (`2.2vh`, `#6B7684`, no label): **hidden by
  default**, toggled with `C`.
- Font stack everywhere: `"Segoe UI","Helvetica Neue",Arial,sans-serif`.
- `+`/`-` adjust a `--scale` CSS var (0.7–1.5) affecting caption font sizes only.
- Status pills top-right (`mikrofon: …`, `překlad: …`) restyled to match
  (`background:#10161F;border:1px solid #1E2833;color:#8B95A1;` states: ok `#7DDBA3`,
  warn `#FFD966`, err `#FF8F7D`) + a small REC dot (`#EE3024`, subtle 2 s pulse) next
  to the mic pill while listening. Pills auto-hide with the slide counter after 4 s
  idle; any state **change** makes them reappear for 4 s.
- Config block at the top of `captions.js`: `LIBRE_URL`, `INTERIM_THROTTLE_MS`,
  `CORRECTIONS` — with Czech comments explaining how to add correction pairs.

- Acceptance: engine module loads without errors; with the mic unavailable
  (headless), the app still runs and pills show the correct state. Real mic flow is
  verified by the operator (see VERIFY).
- Commit `feat: caption engine with EN/UK band` + push.

## Phase 5 — Start panel, launcher, docs

**Start panel** (overlay, shown on load, styled like the app — dark, centered box):

- Title `Živé titulky — Townhall`, deck name + slide count from config.
- Buttons: **`Spustit prezentaci s titulky`** (primary, `#2F6FEB`, starts mic +
  hides panel) and **`Jen prezentace (bez titulků)`** (secondary, ghost style) —
  graceful degradation if the mic dies at showtime.
- Compat warnings (Czech): not Chrome / no SpeechRecognition; running from
  `file://`; missing `content/`.
- Keyboard legend: `←→ / klikátko` slajdy · `Mezerník` video · `F` fullscreen ·
  `+ −` písmo · `C` český řádek · `Esc` panel.
- `Esc` reopens the panel (mic keeps running; panel shows a `Zastavit titulky`
  button and a `Pokračovat` button).

**Launcher:**

- `start.bat`: try `py -3 -m http.server 8137`, fall back to
  `python -m http.server 8137`, fall back to
  `powershell -ExecutionPolicy Bypass -File tools\serve.ps1 -Port 8137`; wait until
  the port answers, then `start chrome "http://localhost:8137"` (fallback
  `start "" "http://localhost:8137"`). Write the server PID to `.server.pid`.
- `tools/serve.ps1`: minimal static file server on `System.Net.HttpListener` with
  correct MIME types for `.html .css .js .mjs .json .pdf .mp4 .mov` and **HTTP Range
  request support for video files** (Chrome requires ranges for seeking; if full
  Range support is complex, implement at minimum single-range `bytes=start-` /
  `bytes=start-end` responses with `206`, `Accept-Ranges`, `Content-Range`).
  Note: Python's `http.server` in 3.7+ does NOT support Range either — that is
  acceptable for playback-from-start (Chrome falls back to full download), but
  document in README that seeking inside videos may be limited with the Python
  server and works best with `serve.ps1`. Choose whichever default (python vs ps1
  first) you verify to stream the videos better, and note the decision in the
  worklog.
- `stop.bat`: kill the server via `.server.pid` (taskkill), delete the pid file.

**README.md (Czech, operator-facing, complete):**

- Co to je (2 věty). Požadavky: Windows, Google Chrome, internet v sále, mikrofonní
  vstup z mixážního pultu nastavený jako **výchozí** vstupní zařízení ve Windows.
- Příprava před každým townhallem (krok za krokem): 1) v PowerPointu
  `Soubor → Uložit jako → PDF` → `content/slides.pdf`; 2) PPTX uložit jako
  `content/source.pptx`; 3) `python tools/prep.py --pptx content/source.pptx --pdf
  content/slides.pdf`; 4) `start.bat`; 5) zkušební věta do mikrofonu.
- Ovládání (tabulka kláves). Řešení potíží: mikrofon zamítnut (ikona zámku v
  liště), video nehraje (MOV → remux přes ffmpeg, příkaz uvést), překlad nedostupný
  (volitelná lokální LibreTranslate: `pip install libretranslate`, spustit, vyplnit
  `LIBRE_URL` v `app/captions.js`), SmartScreen u `start.bat` (Více informací →
  Přesto spustit).
- Sekce "Jak přidat opravy přehmatů" (`CORRECTIONS`).
- Commit `docs: operator README + launcher` (launcher may be its own
  `feat:` commit) + push.

**Final check of this prompt's scope:** `git status` clean, everything pushed,
worklog notes complete.

---

## VERIFY (for the operator — do not execute, just leave the app ready)

The operator will test on Windows with the real deck:

1. `content/source.pptx` = real Q1 deck, exported `content/slides.pdf`, run prep,
   `start.bat` → app opens in Chrome.
2. Screenshot 1: start panel. Screenshot 2: slide 2 fullscreen with caption band
   (speak one Czech sentence, EN+UK appear). Screenshot 3: slide 27 with video
   playing. Screenshot 4: `+` scaled captions.
3. Video slide 26 (MOV): plays with audio? If not → ffmpeg remux path from README.
4. Clicker: PageUp/PageDown navigate; Space on slide 27 toggles video.
5. Kill network mid-speech → pills show fallback/error state, app survives, speech
   resumes when network returns.

---

## APPENDIX A — reference prototype (logic to preserve)

```html
<!-- The full previous prototype follows. Port its ENGINE (speech, translate
     waterfall, sequencing, corrections, wake lock, restart) into app/captions.js
     unchanged in behavior; its presentation layer is superseded by Phases 3–5. -->
```

```javascript
/* konfigurace */
var LIBRE_URL = "";              // napr. "http://localhost:5000" (zaloha, nepovinne)
var INTERIM_THROTTLE_MS = 1200;  // jak casto prekladat rozpracovanou vetu
var GOOGLE_COOLDOWN_MS = 15000;  // po serii chyb zkousej hlavni endpoint 1x za 15 s
var TARGETS = [
  { code: "en", prev: null, curr: null, seq: 0, shownSeq: 0, finalSeq: 0 },
  { code: "uk", prev: null, curr: null, seq: 0, shownSeq: 0, finalSeq: 0 }
];

var CORRECTIONS = [];
var CORRECTIONS_COMPILED = CORRECTIONS.map(function (pair) {
  var esc = pair[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    re: new RegExp("(?<![\\p{L}\\p{N}])" + esc + "(?![\\p{L}\\p{N}])", "giu"),
    to: pair[1]
  };
});

function applyCorrections(text) {
  for (var i = 0; i < CORRECTIONS_COMPILED.length; i++) {
    text = text.replace(CORRECTIONS_COMPILED[i].re, CORRECTIONS_COMPILED[i].to);
  }
  return text;
}

/* preklad */
function translateGoogle(text, tl) {
  var url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=cs&tl="
          + tl + "&dt=t&q=" + encodeURIComponent(text);
  return fetch(url).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }).then(function (data) {
    if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("bad payload");
    var out = data[0].map(function (seg) { return seg && seg[0] ? seg[0] : ""; }).join("").trim();
    if (!out) throw new Error("empty");
    return out;
  });
}

function translateLibre(text, tl) {
  if (!LIBRE_URL) return Promise.reject(new Error("no fallback configured"));
  return fetch(LIBRE_URL.replace(/\/+$/, "") + "/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: text, source: "cs", target: tl, format: "text" })
  }).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }).then(function (d) {
    var out = (d.translatedText || "").trim();
    if (!out) throw new Error("empty");
    return out;
  });
}

/* Vraci Promise<string|null>. null = preklad selhal uplne. */
function translate(text, tl) {
  var now = Date.now();
  var tryGoogle = googleFails < 5 || (now - lastGoogleTry) > GOOGLE_COOLDOWN_MS;
  if (tryGoogle) {
    lastGoogleTry = now;
    return translateGoogle(text, tl).then(function (t) {
      googleFails = 0; setTr("Google", "ok"); return t;
    }).catch(function () {
      googleFails++;
      return translateLibre(text, tl).then(function (t) {
        setTr("zalozni (LibreTranslate)", "warn"); return t;
      }).catch(function () {
        setTr("nedostupny - zobrazuji cestinu", "err"); return null;
      });
    });
  }
  return translateLibre(text, tl).then(function (t) {
    setTr("zalozni (LibreTranslate)", "warn"); return t;
  }).catch(function () {
    setTr("nedostupny - zobrazuji cestinu", "err"); return null;
  });
}

/* zobrazeni vysledku - sekvencni ochrana poradi */
function handleFinal(czText) {
  czCurr.textContent = czText;
  TARGETS.forEach(function (t) {
    var s = ++t.seq;
    translate(czText, t.code).then(function (tr) {
      if (s < t.finalSeq) return;
      t.finalSeq = s;
      t.prev.textContent = (tr !== null) ? tr : "\u00b7 " + czText;
      if (t.shownSeq <= s) { t.curr.textContent = ""; t.shownSeq = s; }
    });
  });
}

function handleInterim(czText) {
  czCurr.textContent = czText;
  var now = Date.now();
  if (now - lastInterimAt < INTERIM_THROTTLE_MS) return;
  lastInterimAt = now;
  TARGETS.forEach(function (t) {
    var s = ++t.seq;
    translate(czText, t.code).then(function (tr) {
      if (tr === null) return;
      if (s <= t.shownSeq || s < t.finalSeq) return;
      t.shownSeq = s;
      t.curr.textContent = tr;
    });
  });
}

/* rozpoznavani reci */
function createRecognizer() {
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var r = new SR();
  r.lang = "cs-CZ";
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;

  r.onresult = function (e) {
    var interim = "";
    for (var i = e.resultIndex; i < e.results.length; i++) {
      var res = e.results[i];
      if (res.isFinal) {
        var txt = applyCorrections(res[0].transcript.trim());
        if (txt) handleFinal(txt);
      } else {
        interim += res[0].transcript;
      }
    }
    interim = applyCorrections(interim.trim());
    if (interim) handleInterim(interim);
  };

  r.onerror = function (ev) {
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      running = false;
      setMic("pristup zamitnut", "err");
      showPanel("Chrome nedostal pristup k mikrofonu. Povol ho v liste adresy a spust znovu.");
    }
  };

  r.onend = function () {
    if (!running) { setMic("vypnuto"); return; }
    setMic("restart...", "warn");
    setTimeout(function () {
      if (!running) return;
      try { rec.start(); setMic("posloucham", "ok"); }
      catch (e) {
        try { rec = createRecognizer(); rec.start(); setMic("posloucham", "ok"); }
        catch (e2) { setMic("selhalo", "err"); }
      }
    }, 250);
  };

  return r;
}

/* wake lock */
function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  navigator.wakeLock.request("screen").then(function (wl) { wakeLock = wl; }).catch(function () {});
}
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible" && running) requestWakeLock();
});
```
