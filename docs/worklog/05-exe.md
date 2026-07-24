# Prompt 5 — Single-file executable: TownhallTitulky.exe

Repository: `townhall-titulky` (root). Goal: the operator gets **one file**,
`TownhallTitulky.exe` — double-click and everything runs. No Python, no
`start.bat`, no installs. The exe bundles the Python server + the whole static
app + the prep pipeline (PyInstaller onefile). It launches the system Chrome in
a chromeless `--app` window so it looks and feels like a native application, and
it exits cleanly when the operator closes that window.

**Why not Electron/Tauri (do not "improve" toward them):** Web Speech API
recognition is only served to real Chrome; bundled Chromium builds get network
errors from the speech service. Chrome (or Edge as fallback) must remain the
runtime — the exe's job is to make everything around it disappear.

## Ground rules (as before)

1. FIRST: `.gitignore` covers `/[0-9]*.md`, `content/`, `publish/` (exe output
   goes to `publish/` — binaries are never committed). Committing a small
   `assets/icon.ico` source asset is fine.
2. Zero console errors; `node --check` all JS; prep self-test, test-api, all
   Puppeteer suites stay green.
3. Commit + push per phase. Prompt → `docs/worklog/05-exe.md`; decisions →
   `…-notes.md`. Ambiguity → default + note. Quote all paths.
4. Build-time-only dependencies (`pyinstaller`, `pillow`) are installed on this
   machine by the build script; they are NOT runtime requirements and must not
   creep into the app.

---

## Phase 1 — Server: frozen mode & lifecycle (`tools/serve.py`)

1. **Path resolution:** introduce two roots and use them consistently:
   - `APP_ROOT` (static assets: `index.html`, `app/`, `vendor/`): repo root in
     dev; `sys._MEIPASS` when frozen (`getattr(sys, "frozen", False)`).
   - `DATA_ROOT` (mutable data: `content/`): repo root in dev; **directory of
     the executable** (`os.path.dirname(sys.executable)`) when frozen — user
     data lives next to the exe, never inside the bundle.
   Prep pipeline, API endpoints, and static serving all respect these roots.
2. **Heartbeat lifecycle:** endpoint `POST /api/heartbeat`. When the server is
   started with `--auto-exit` (the exe does this), a watchdog thread exits the
   process after **60 s without a heartbeat** (grace period 120 s after startup
   so a slow first browser launch doesn't kill it). Without the flag (dev via
   start.bat), behavior is unchanged.
3. **CLI:** `--port` (default 8137), `--auto-exit`, `--no-browser`,
   `--smoke` (start, self-GET `/` and `/api/content/status`, print OK, exit 0 —
   used by the build verification).
4. **Browser launch helper** (used by the entry point): find Chrome via common
   install paths + `App Paths` registry key; fallback Edge (`msedge.exe`);
   launch `--app=http://localhost:<port>` (+ `--new-window`). If only Edge is
   found, still proceed (the app's compat check will advise Chrome for best
   speech support). If neither exists: show a Windows message box (ctypes
   `MessageBoxW`) with a Czech explanation, then exit.
5. Port busy on startup → assume an instance is already running: just launch the
   browser window again and exit (same UX as start.bat today).

- Acceptance: extend `tools/test-api.py` — heartbeat endpoint responds; watchdog
  logic unit-tested with shortened intervals (inject via env var or argument);
  `--smoke` exits 0 in dev mode. Existing suites green.
- Commit `feat: frozen-mode roots, heartbeat lifecycle, browser launcher` + push.

## Phase 2 — App-side heartbeat + environment awareness

1. `GET /api/env` → `{ frozen: bool, autoExit: bool }`.
2. `app/app.js`: after load, fetch `/api/env`; if `autoExit`, send
   `POST /api/heartbeat` every 5 s (`fetch`, `keepalive: true`, errors ignored).
   Closing the window simply stops the beats; the watchdog handles the rest.
3. Compat check addition: if UA is Edge (not Chrome), show in the existing
   warning area: `Běžíš v Edge — rozpoznávání řeči je nejspolehlivější v Google
   Chrome. Pokud titulky nefungují, nainstaluj/použij Chrome.`
4. Puppeteer: with a test server started in `--auto-exit` mode and a shortened
   watchdog, assert the page's heartbeats keep it alive and that the process
   exits after the page closes. Assert the Edge-UA warning via UA override.
- Commit `feat: heartbeat client and Edge advisory` + push.

## Phase 3 — Icon + build script (`scripts/build-exe.ps1`)

1. `scripts/make-icon.py` (build-time, uses Pillow): generate
   `assets/icon.ico` (sizes 16–256) — dark navy `#032342` rounded square, two
   caption bars (white `#F5F7FA` and yellow `#FFD966`) above a thin red
   `#EE3024` base line; minimal, flat, no text. Commit the resulting `.ico`
   (small source asset). Skip regeneration if the file exists unless `--force`.
2. `scripts/build-exe.ps1`:
   - `py -3 -m pip install --upgrade pyinstaller pillow` (build machine only).
   - Run `make-icon.py` if needed.
   - Create `scripts/version-info.txt` (PyInstaller version resource):
     FileDescription `Townhall Titulky`, ProductName, FileVersion
     `1.0.0.<build>`, CompanyName generic.
   - PyInstaller: `--onefile --noconsole --name TownhallTitulky
     --icon assets/icon.ico --version-file scripts/version-info.txt
     --add-data "index.html;." --add-data "app;app" --add-data "vendor;vendor"
     --add-data "tools/export-pdf.ps1;tools"` with entry `tools/serve.py`
     (its `__main__` when frozen with no args defaults to `--auto-exit` +
     launch browser). Verify `export-pdf.ps1` resolves from `APP_ROOT` when
     frozen.
   - Output `publish/TownhallTitulky.exe`; also assemble `publish/balik/` =
     exe + `README-uzivatel.txt` (Czech, non-technical: spusť dvojklikem;
     SmartScreen → Více informací → Přesto spustit; data ve složce content
     vedle souboru; ukončení = zavřít okno; požadavky: Chrome, internet, pro
     automatický převod prezentace PowerPoint).
   - Finish with the smoke test: run the built exe with `--no-browser --smoke
     --port 8199`; fail the script on non-zero exit.
3. README (repo): new section `Sestavení exe` (one command) + distribution note
   (zip the `publish/balik` folder manually; binaries never enter git).
- Acceptance: `powershell -ExecutionPolicy Bypass -File scripts/build-exe.ps1`
  succeeds end-to-end on this machine, smoke test passes, `git status` clean
  (publish/ ignored).
- Commit `feat: single-file exe build with icon and version info` + push.

## Phase 4 — Full battery + docs polish

- Run everything: node --check, prep self-test, test-api (incl. heartbeat),
  all Puppeteer suites; rebuild exe once more from a clean `publish/`.
- README: operator quick-start now leads with the exe (dvojklik na
  TownhallTitulky.exe); `start.bat` stays as the dev path.
- Worklog notes complete; push.
- Commit `docs: exe-first operator guide` + push.

---

## VERIFY (operator — do not execute)

1. Copy `publish/TownhallTitulky.exe` to an empty folder outside the repo.
   Double-click → SmartScreen (`Přesto spustit`) → app window opens with the
   start panel.
2. Run the wizard with the real deck; present in PDF mode; run `Diagnostika
   mikrofonu` and screenshot the verdict.
3. Close the app window → within ~1 minute no leftover process in Task Manager;
   `content/` sits next to the exe and survives a restart of the exe.
4. Start the exe twice in a row → second launch just opens a new window, no
   port conflict.
