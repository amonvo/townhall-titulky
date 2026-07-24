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
