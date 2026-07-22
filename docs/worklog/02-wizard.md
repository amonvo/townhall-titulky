# Prompt 2 — In-app presentation wizard + prep fixes

Repository: `townhall-titulky` (you are in its root). This prompt adds a **visual,
operator-friendly preparation flow**: the operator drags a `.pptx` into the app, the
app converts it to PDF automatically (via the locally installed PowerPoint), extracts
embedded videos, and ends with "Spustit prezentaci". No terminal, no manual PDF
export. It also fixes bugs found in field testing.

## Ground rules (same as prompt 1 — apply throughout)

1. **FIRST ACTION:** verify `.gitignore` still ignores `/[0-9]*.md`, `content/`,
   `publish/`. Never commit anything under `content/`.
2. No-build static app: "build passes" = every page loads with **zero console
   errors**; `node --check` passes on all `.js`; `py -3 tools/prep.py --self-test`
   exits 0.
3. Commit + push after every phase, conventional commit messages.
4. Save this prompt as `docs/worklog/02-wizard.md`; decisions and deviations go to
   `docs/worklog/02-wizard-notes.md`.
5. On ambiguity: sensible default + worklog note, don't stop.
6. No CDN dependencies at runtime.
7. All shell/batch work must survive **spaces in the repo path** — quote every path.

---

## Phase 1 — `tools/prep.py`: fixes + importable pipeline

1. **Fix `SameFileError`:** when `--pdf` points to a file that already IS
   `content/slides.pdf` (same file after path resolution), skip the copy silently.
   Guard with existence checks; use `os.path.samefile` only when both paths exist.
2. Refactor the pipeline into an importable API without changing CLI behavior:

   ```python
   def prepare_content(pptx_path, pdf_path=None, out_dir="content",
                       allow_remux=True, progress_cb=None) -> dict
   ```

   - `progress_cb(step_id, message)` is called at each stage:
     `analyze`, `videos`, `pdf`, `config`, `done`.
   - Returns a summary dict: `{deckName, slideCount, videos: [{slide, file, x, y,
     w, h}], warnings: [str]}` (same data that goes into `config.json`).
3. Extend `--self-test` with: (a) the same-file PDF case (must not raise),
   (b) a `prepare_content` call with a recording `progress_cb` asserting the step
   sequence.
- Acceptance: self-test exit 0; CLI run unchanged in behavior.
- Commit `fix: prep.py same-file PDF + importable pipeline` + push.

## Phase 2 — Server API for preparation (`tools/serve.py`)

Extend the Python server (the default server from `start.bat`). Keep it stdlib-only.

**Security first:**

- The server MUST bind to `127.0.0.1` explicitly (verify the current code; enforce).
- API endpoints write **only** inside `content/`. Never use client-supplied strings
  as filesystem paths: the uploaded deck is always saved as
  `content/source.pptx`; the original filename is kept only as metadata
  (`deckName` = filename stem).

**Endpoints:**

1. `POST /api/prepare` — upload + start pipeline.
   - Accept `multipart/form-data` with a single field `pptx` (the file). Parse the
     multipart stream **without buffering the whole body in memory**: stream to
     `content/upload.tmp` in 64 KB chunks, then atomically rename to
     `content/source.pptx`. Require `Content-Length`; reject chunked
     transfer-encoding with 411/400. Size guard: reject > 2 GB.
   - Only one job at a time: if a job is running → `409` with JSON error.
   - On success: `202` + `{jobId}` and a background thread runs:
     `save → prepare_content(...) with progress_cb → PDF export → done`.
2. `GET /api/prepare/status` — JSON:
   `{state: "idle"|"running"|"done"|"error"|"needs_manual_pdf",
     step, stepIndex, stepsTotal, message, summary?}`.
   `summary` present when done (from `prepare_content`).
3. `GET /api/content/status` — `{hasPdf, hasConfig, deckName?, slideCount?}` read
   from disk/config.json; the app calls this on load and after manual fixes.

**PDF export (the automatic conversion):**

- New script `tools/export-pdf.ps1` with params `-Pptx <path> -Pdf <path>`:
  PowerPoint COM automation. Reference implementation:

  ```powershell
  param([Parameter(Mandatory)][string]$Pptx,
        [Parameter(Mandatory)][string]$Pdf)
  $pp = $null; $pres = $null
  try {
    $pp = New-Object -ComObject PowerPoint.Application
    $pp.DisplayAlerts = 1              # ppAlertsNone
    # Open(FileName, ReadOnly=msoTrue(-1), Untitled=msoFalse(0), WithWindow=msoFalse(0))
    $pres = $pp.Presentations.Open($Pptx, -1, 0, 0)
    $pres.SaveAs($Pdf, 32)             # ppSaveAsPDF
    exit 0
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
  } finally {
    if ($pres) { $pres.Close() }
    if ($pp)   { $pp.Quit() }
    [System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()
  }
  ```

  Verify/adjust as needed (COM enum values as integers on purpose — no Office
  assemblies required).
- The server invokes it via
  `powershell -NoProfile -ExecutionPolicy Bypass -File tools/export-pdf.ps1 …`
  as a subprocess with a **300 s timeout** (big decks take a while), absolute
  quoted paths, output → `content/slides.pdf`.
- If the subprocess fails or PowerPoint COM is unavailable (e.g. `New-Object`
  throws): job ends in state **`needs_manual_pdf`** — videos + config are already
  done; `message` carries a short Czech explanation. The UI (Phase 3) then shows
  manual export instructions and a re-check button. This keeps the app fully usable
  on machines without PowerPoint.
- If `content/slides.pdf` already exists and the upload is a new deck, the old PDF
  is replaced only on successful export (export to `content/slides.tmp.pdf`, then
  atomic replace) — a failed export must not destroy a working setup.

**`tools/serve.ps1` (fallback server):** static only. For any `/api/*` request
return `501` with JSON `{error: "Příprava vyžaduje Python server (serve.py). Spusť
start.bat na stroji s Pythonem, nebo připrav obsah ručně dle README."}` so the UI
can display it.

- Acceptance: unit-style test script `tools/test-api.py` (stdlib, run in CI-fashion
  by you now): starts serve.py on a test port, uploads the **synthetic self-test
  PPTX** from prep.py's fixture builder via multipart, polls status until
  `done`/`needs_manual_pdf` (in this environment PowerPoint is absent → expect
  `needs_manual_pdf`), asserts videos extracted + config.json written + state
  machine correct + 409 on concurrent job. Exit 0.
- Commit `feat: prepare API with PowerPoint PDF export` + push.

## Phase 3 — Wizard UI (`app/wizard.js`)

Same design language as the start panel (dark `#0B0F14`, centered box, brand blue
`#2F6FEB` primary, red `#EE3024` only for errors). Czech texts throughout.

**Entry points:**

1. App load with missing/incomplete content (`/api/content/status`) → wizard shows
   instead of the start panel.
2. Start panel gains a ghost secondary button **`Nahrát novou prezentaci`** → opens
   the wizard. If content already exists, the wizard's first screen warns:
   `Nahradí aktuální prezentaci „<deckName>". Pokračovat?` (Pokračovat / Zpět).

**Screens/states:**

1. **Drop zone:** large area (min 40vh), dashed border 2px
   `rgba(255,255,255,.18)`, radius 12px, centered icon + text
   `Přetáhni sem prezentaci (.pptx)` and `nebo klikni pro výběr souboru`;
   `<input type="file" accept=".pptx">` triggered by click. Dragover state:
   border + glow in `#2F6FEB`. Reject non-.pptx with a friendly message.
3. **Progress:** vertical step list with states (pending ○ / running spinner /
   done ✓ / failed ✕): `Nahrávání souboru` (with % from XHR upload progress) →
   `Analýza prezentace` → `Extrakce videí` → `Převod do PDF (u velkých prezentací
   může trvat i minutu)` → `Příprava konfigurace` → `Hotovo`. Poll
   `/api/prepare/status` every 500 ms; map `step` ids to rows. Use XHR for the
   upload (progress events); `fetch` elsewhere.
4. **Done:** summary card — `<deckName>` + `32 slajdů · 4 videa (slajdy 26–29)`
   (numbers from `summary`; hide the video part when none) + primary
   **`Pokračovat`** → `location.reload()` (start panel then shows the new deck).
5. **needs_manual_pdf:** amber state: short explanation + exact manual steps
   (`V PowerPointu: Soubor → Uložit jako → typ PDF → ulož jako content\slides.pdf`)
   + button `Zkontrolovat znovu` (re-calls `/api/content/status`; if PDF present →
   Done screen). Videos/config are already prepared — say so.
6. **Error:** red message with the server's text + `Zkusit znovu`.

**Behavior details:** block app keys (arrows/space/F/…) while the wizard is open —
same capture-phase approach as the panel; `Esc` closes the wizard only from the
drop-zone screen (not mid-upload/mid-job).

- Acceptance (Puppeteer + real Chrome, extend the existing harness):
  - wizard appears when content status reports missing content (mock via a
    temporary empty content dir or a test flag);
  - file-input upload of the synthetic PPTX drives the real API → progress rows
    advance → `needs_manual_pdf` shows manual instructions (PowerPoint absent
    here);
  - drop a tiny valid PDF into `content/slides.pdf`, click `Zkontrolovat znovu` →
    Done screen with deck summary → `Pokračovat` reloads into start panel showing
    the deck name;
  - non-pptx file rejected with message; app keys blocked while wizard open.
  - Target: all assertions green, 0 console errors.
- Commit `feat: presentation upload wizard` + push.

## Phase 4 — Docs + polish

- README: new section **`Příprava prezentace`** — primary path is now:
  `start.bat` → (aplikace sama nabídne nahrání, nebo tlačítko Nahrát novou
  prezentaci) → přetáhnout `.pptx` → hotovo. Requirements note: automatic PDF
  conversion needs installed PowerPoint; without it the app guides through manual
  export. Keep the CLI (`tools/prep.py`) documented as the advanced path.
  Update troubleshooting accordingly.
- Verify `start.bat`/`stop.bat` unaffected; run the full check battery once more
  (node --check, self-test, test-api, Puppeteer suite).
- Commit `docs: wizard-first preparation guide` + push. `git status` clean.

---

## VERIFY (operator — do not execute)

1. `start.bat` → start panel → `Nahrát novou prezentaci` → drag the real Q1
   `.pptx` → watch steps (upload %, extraction, PDF conversion ~up to a minute) →
   summary `32 slajdů · 4 videa` → `Pokračovat`. Screenshots: drop zone, progress,
   summary.
2. Present: captions run, slide 27 video plays with sound, slide 26 (MOV) plays.
3. Repeat with the Q2 deck → `33 slajdů`, then switch back to Q1 — proves the
   quarterly workflow.
