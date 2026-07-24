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

## Fáze 2 — heartbeat klient + Edge advisory

- `GET /api/env` → `{frozen, autoExit}`. app.js beaty POSTuje každých 5 s
  (`keepalive: true`, chyby ignorovány — výpadek řeší watchdog, ne UI).
- **Nalezená past (opraveno):** heartbeat blok původně běžel až po
  `await initSlides()` — načtení velkého PDF by mohlo spotřebovat grace okno
  a watchdog by server zabil uprostřed prvního renderu. Beaty teď startují
  HNED na začátku `main()`, nezávisle na zbytku inicializace (fire-and-forget
  promise chain, žádné await).
- Edge advisory: `Edg/` v UA → specifická hláška („Běžíš v Edge…") místo
  obecného varování o Chromu; Edge SR má, jen méně spolehlivě.
- **Poučka do testů:** `networkidle0` se s periodickými heartbeaty (a range
  požadavky pdf.js) nikdy neustálí → heartbeat suite používá
  `waitUntil: "load"` + čekání na `__townhall`.
- **Ověření (Puppeteer + reálný auto-exit server, timeout 8 s / grace 15 s):
  7/7 asercí OK** — env endpoint, beaty drží server naživu 17 s (> timeout
  i grace), Edge UA ukazuje advisory (normální UA ne), 0 chyb v konzoli,
  po zavření prohlížeče server do ~8 s sám skončí.
