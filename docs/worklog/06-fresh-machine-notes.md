# Prompt 6 — poznámky k rozhodnutím

## Fáze 1 — uživatelský prázdný stav (`app/slides.js`)

- `showSetupMessage()` (vývojářská hláška `tools/prep.py` z promptu 1) nahrazen
  `showEmptyState(hasApi)`: titulek `Chybí prezentace`, věta `Nahraj soubor
  .pptx a aplikace si ji připraví sama.`, primární tlačítko `Nahrát prezentaci`.
  Bez API (statický `serve.ps1` → 501, nebo server nedostupný) se místo toho
  ukáže věta o `TownhallTitulky.exe` / `start.bat` a tlačítko se **nevykreslí**
  — upload by stejně neměl kam jít (rozumný default, zadání tlačítko pro tuto
  variantu neřeší).
- Hranice modulů: `slides.js` wizard neimportuje — `initSlides({
  onRequestUpload, getContentStatus })`; obě callbacky dodává `app.js`
  (`onRequestUpload` → skryje panel + `wizard.open({ skipConfirm: true })`,
  `getContentStatus` → nový helper `refreshContentStatus()`, plné zapojení
  do routingu přijde ve Fázi 2).
- Detekce „server bez API": `refreshContentStatus()` vrací `hasApi: false` jak
  pro 501, tak pro síťovou chybu (offline) — obojí znamená „příprava obsahu
  není k dispozici".
- CSS: `#setup-message` (včetně `code`/`strong` pravidel) nahrazeno
  `#empty-state` (flex sloupec, titulek, text, tlačítko `panel-btn primary`).
- **Audit UI na vývojářské cesty** (`grep -rn -E "tools/|prep\.py|README"
  app/ index.html`): 2 nálezy v uživatelských řetězcích —
  1. `app/slides.js:63` stará hláška `Spusť tools/prep.py (viz README)` →
     odstraněna s celým `showSetupMessage()`;
  2. `app/panel.js:190` varování `…nebo spusť tools/prep.py (viz README)` →
     přepsáno na `Chybí prezentace — nahraj ji průvodcem (tlačítko Nahrát
     novou prezentaci).` (ve Fázi 2 varování zcela nahradí jemná poznámka na
     PDF kartě).
  Po opravě zbývá jediný hit: komentář v kódu `app/slides.js` („exe distribuce
  nemá repo ani tools/") — není to uživatelsky viditelný text, ponechán.
- Kontext k testům: Puppeteer suity z promptů 1–5 žily v session scratchpadu
  (viz paměť „browser-verification-setup"), v repu nejsou — ve Fázi 3 se
  znovu postaví sanity sada + nová suita `fresh-machine`.

## Fáze 2 — routing wizardu (`app/app.js`, `app/panel.js`)

- `refreshContentStatus()` (app.js) je jediný zdroj pravdy o serveru: vrací
  `{hasApi, hasPdf, hasConfig, deckName?, slideCount?}`; 501 i síťová chyba →
  `hasApi: false`. Cache `contentStatus` se obnovuje při startu a po každém
  zavření wizardu.
- Dvě různé otázky, dvě podmínky (záměrně):
  - **Otevřít wizard?** `pdfContentMissing()` = `hasApi && (!hasPdf ||
    !hasConfig)` — bez API se wizard nikdy neotvírá (neměl by kam nahrávat).
  - **Ukázat poznámku na PDF kartě?** `!slides.ok` — ground truth z reálně
    načteného obsahu. Statický `serve.ps1` s obsahem: API hlásí 501, ale
    slidy jedou → poznámka se správně neukazuje.
- Vstupní body wizardu: 1) start aplikace (zachováno, nyní přes helper),
  2) klik na PDF kartu (`onModeChange`), 3) obě start tlačítka přes nový hook
  `onBeforeStart` (vrátí-li true, panel start nepřebírá). U „Spustit prezentaci
  s titulky" se mikrofon **nespouští** — po úspěšném nahrání se stránka
  reloaduje, operátor spustí titulky až s obsahem (default, zadání neřeší).
- Žádná auto-open smyčka: zavření wizardu jen obnoví stav + ukáže panel;
  všechny ostatní triggery jsou explicitní kliky. Klik na už vybranou PDF
  kartu je taky explicitní akce → wizard se otevře znovu (odpovídá testu
  „clicking start … opens the wizard again").
- Varování „Chybí obsah…" v `refreshWarnings()` odstraněno úplně — nahrazeno
  jemnou poznámkou `Prezentace zatím nenahrána` na PDF kartě
  (`.mode-card-note`, plní `refreshCards()`).
- Podtitulek panelu bez configu: dřív „Obsah zatím není připraven" → nyní
  prázdný (chybějící obsah komunikuje PDF karta; živý režim žádnou hlášku
  nepotřebuje). Default + poznámka.
- `window.__townhall` nově vystavuje `refreshContentStatus` a
  `getContentStatus()` pro testy.

## Fáze 3 — testy: cesta čistého stroje

- Puppeteer suity z promptů 1–5 žily jen v session scratchpadu (viz paměť
  „browser-verification-setup") a nejsou k dispozici — sada se postavila znovu
  a tentokrát se **commituje do `tests/`**, ať přežije session (default +
  poznámka; odpovídá to i předepsané commit zprávě `test: fresh-machine
  suite`). Spuštění viz hlavička `tests/run-tests.js` (puppeteer-core +
  systémový Chrome, `npm i puppeteer-core --no-save`).
- Nový test hook v `tools/serve.py`: env `TOWNHALL_DATA_ROOT` přesměruje
  `content/` do libovolného adresáře. Testy tak simulují čistý stroj
  (prázdný temp DATA_ROOT) i připravený obsah, aniž by sáhly na operátorův
  `content/` (reálný deck). Izolované porty 8151/8152 (operátorův 8137
  nedotčen).
- Fixture `tests/make_fixture.py`: `data-fresh/` (prázdný kořen) a
  `data-prepared/` (ručně sestavené minimální dvoustránkové 16:9 PDF +
  `config.json` s deckName „Test Deck") — bez závislosti na PowerPointu.
  Fixtures + node_modules jsou gitignorované.
- Suity a výsledky (celkem **38/38 OK**):
  - `fresh-machine` (18): default live → panel bez staré hlášky; PDF karta →
    wizard (drop); zrušení → panel + poznámka „Prezentace zatím nenahrána",
    žádná reopen smyčka (kontrola 700 ms); oba starty → wizard znovu (mikrofon
    se nespouští); prázdný stav scény s tlačítkem `Nahrát prezentaci` →
    wizard; `tools/`/`prep.py` nikde v `body.innerText`; 0 chyb v konzoli.
  - `static-501` (9): interceptem vynucené 501 pro `/api/*` (simulace
    `serve.ps1`) — wizard se nikdy neotvírá, empty state ukazuje variantu
    `TownhallTitulky.exe / start.bat` bez tlačítka, start schová panel do
    scény s hláškou.
  - `pdfmode sanity` (11): připravený obsah — wizard se neotvírá, podtitulek
    `Test Deck · 2 slajdy`, poznámka skrytá, navigace šipkami, Esc vrací
    panel.
- Konzole: síťové logy `Failed to load resource: 404/501` jsou na čistém
  stroji očekávané (chybějící content, API bez podpory) a filtrují se;
  `pageerror` a ostatní console.error musí být nula.
- Baterie: `py tools/prep.py --self-test` OK, `py tools/test-api.py` OK
  (všechny asercie), `node --check` všech `app/*.js` OK.
- `.gitignore` doplněn o `tests/data-*` fixtures a `package.json`/`lock`
  (projekt je záměrně bez runtime npm závislostí; zabrání náhodnému commitu
  při `npm i` bez `--no-save`).
