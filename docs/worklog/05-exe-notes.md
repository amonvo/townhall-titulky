# Worklog — poznámky k rozhodnutím (05-exe)

Rozhodnutí při nejasnostech (ground rule 3: default + poznámka, nezastavovat).

## Obecné

- `.gitignore` už kryje `/[0-9]*.md`, `content/`, `publish/` — beze změny
  (publish/ = výstup buildu, binárky se necommitují).
- Doslovná kopie promptu → `docs/worklog/05-exe.md`, commit s Fází 1.

## Fáze 1 — serve.py: frozen roots, heartbeat, launcher

- Kořeny: `APP_ROOT` (statika; dev = repo root, frozen = `sys._MEIPASS`) vs.
  `DATA_ROOT` (content/; dev = repo root, frozen = složka vedle exe).
  Statické servírování router-uje v `translate_path`: prefix `/content/` →
  DATA_ROOT, vše ostatní → APP_ROOT; komponenty `..` se zahazují (traversal).
- **Rozhodnutí:** `allow_reuse_address` přepnut na **False** — na Windows
  SO_REUSEADDR znamená „ukradni cizí port" (dvojí bind bez chyby), což dřív
  způsobilo zmatek při testech. S False funguje detekce „port obsazený →
  běžící instance → jen otevři další okno a skonči" (UX jako start.bat).
- Watchdog: `--auto-exit` → daemon vlákno; deadline = poslední heartbeat
  + 60 s, před prvním heartbeatem start + 120 s grace. Intervaly jdou pro
  testy zkrátit env proměnnými `TOWNHALL_HB_TIMEOUT`/`TOWNHALL_HB_GRACE`
  (**rozhodnutí:** env vary místo CLI argumentů — testy je předají
  subprocessu, aniž by rozšiřovaly veřejné CLI). Ukončení `os._exit(0)`
  (čisté — server je celý daemon-threaded, žádný stav k flushnutí).
- CLI: argparse `--port/--auto-exit/--no-browser/--smoke` + **poziční port
  zachován** (start.bat volá `serve.py 8137` — beze změny chování v dev).
  Dvojklik na zmrazený exe (bez argumentů) = `--auto-exit` + spuštění
  prohlížeče; v dev se prohlížeč nespouští nikdy (o to se stará start.bat).
- Prohlížeč: Chrome přes známé instalační cesty + registry App Paths
  (HKLM/HKCU), fallback Edge (cesty + App Paths). `--app=http://localhost:P`
  + `--new-window` (chromeless okno). Nic nenalezeno → ctypes `MessageBoxW`
  s českou hláškou a konec.
- `--smoke`: server v threadu, self-GET `/` + `/api/content/status`,
  `SMOKE OK` + exit 0; jinak exit 1.
- Heartbeat endpoint `POST /api/heartbeat` → `{ok: true}` (nelogován, stejně
  jako status poll).
- **Ověření:** test-api rozšířen na **27/27, exit 0** — heartbeat 200,
  `--smoke` exit 0, watchdog žije v grace a bez beatů končí, heartbeaty
  (1 s při timeout 2 s) drží proces naživu a po jejich konci umírá.
  Sanity Puppeteer (panel 14/14, pdfmode 14/14) po přepisu translate_path OK.
  Mimochodem: česká chybová hláška PowerPoint COM se nyní dekóduje správně
  (fix kódování stderr z promptu 2 potvrzen v terénu).
