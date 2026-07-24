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
