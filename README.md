# townhall-titulky

Prezentační aplikace pro firemní townhall: promítá slidy na celou obrazovku a pod
nimi zobrazuje **živé titulky** překládané z češtiny do angličtiny a ukrajinštiny.
Vše běží lokálně v Google Chrome na Windows notebooku — bez API klíčů, bez účtů,
zdarma.

## Dva režimy promítání

| | **Živý PowerPoint (doporučeno)** | **PDF režim (záloha)** |
| --- | --- | --- |
| Co promítá | zrcadlí běžící PowerPoint okno | připravené PDF |
| Animace, přechody, GIFy | ✅ vše, 100% věrnost | GIFy přes overlay, jinak statické |
| Videa | ✅ přímo v PowerPointu, se zvukem | přehrává je aplikace (overlay) |
| Klikátko | ovládá **PowerPoint** (okno musí mít fokus) | ovládá aplikaci |
| Příprava obsahu | žádná | nahrání `.pptx` průvodcem |
| Kdy použít | townhall s projektorem (rozšířená plocha) | jediná obrazovka, nebo když capture selže |

**Nastavení Živého PowerPointu (krok za krokem):**

1. `Win+P` → **Rozšířit** (projektor jako druhá obrazovka).
2. V PowerPointu: karta **Prezentace → Nastavit prezentaci → „Procházení
   jednotlivcem (okno)“** → OK → Spustit prezentaci — poběží v okně.
3. `start.bat` → v aplikaci nech vybraný **Živý PowerPoint** → `Spustit
   prezentaci s titulky` → **`Vybrat okno PowerPointu`** → v dialogu Chromu
   zvol okno s prezentací.
4. Okno Chromu přesuň na projektor a stiskni `F` (fullscreen).
5. Prezentaci ovládej klikáním / klikátkem **přímo v okně PowerPointu**.
   Okno nechej otevřené — klidně schované za aplikací, jen ho **neminimalizuj**
   (minimalizované okno se může přestat překreslovat).

> **Důležité pro titulky:** okno **této aplikace** nech viditelné (na
> projektoru). Nesmí být minimalizované ani úplně překryté — Chrome by
> pozastavil rozpoznávání řeči a titulky by se přestaly obnovovat.

## Požadavky

- Windows 10/11
- **Google Chrome** (rozpoznávání řeči funguje jen v něm)
- Internet v sále (překladové endpointy jsou jediná síťová komunikace)
- Mikrofonní vstup z mixážního pultu nastavený jako **výchozí** vstupní zařízení
  ve Windows (Nastavení → Systém → Zvuk → Vstup)
- Python 3 (pro `tools/prep.py` a lokální server); bez Pythonu se server spustí
  přes PowerShell (`tools/serve.ps1`), ale `prep.py` Python potřebuje

## Příprava prezentace (PDF režim)

Živý PowerPoint žádnou přípravu nepotřebuje. PDF režim (záloha) ano:

**Hlavní cesta — vše v aplikaci, bez terminálu:**

1. Spusť **`start.bat`** — nastartuje lokální server na `http://localhost:8137`
   a otevře Chrome.
2. Pokud obsah chybí, aplikace **sama nabídne nahrání**; jinak klikni na start
   panelu na **„Nahrát novou prezentaci“**.
3. **Přetáhni `.pptx` do okna** (nebo klikni a vyber soubor). Aplikace sama:
   nahraje soubor → zanalyzuje prezentaci → vytáhne videa → **převede ji do
   PDF** (přes lokálně nainstalovaný PowerPoint, u velkých prezentací to může
   trvat i minutu) → připraví konfiguraci.
4. Na závěr uvidíš souhrn (`32 slajdů · 4 videa`) → **`Pokračovat`** → start
   panel s novou prezentací. Hotovo.

> **Poznámka:** automatický převod do PDF vyžaduje **nainstalovaný PowerPoint**.
> Bez něj aplikace připraví videa i konfiguraci a provede tě ručním exportem
> (`Soubor → Uložit jako → PDF` → `content\slides.pdf` → „Zkontrolovat znovu“).

> **Po aktualizaci aplikace (git pull)** restartuj server: `stop.bat` +
> `start.bat` — běžící server jinak servíruje starý kód.

Před akcí ještě: klikni na **„Spustit prezentaci s titulky“**, povol mikrofon
a řekni zkušební větu — v dolním pásu se objeví anglický a ukrajinský překlad.
Po akci server zastavíš přes **`stop.bat`**.

### Pokročilá cesta (CLI)

Ruční příprava přes terminál funguje dál:

1. V PowerPointu: `Soubor → Uložit jako → PDF` → ulož jako `content/slides.pdf`.
2. Původní prezentaci ulož jako `content/source.pptx`.
3. Vytáhni videa a vygeneruj konfiguraci:

   ```
   python tools/prep.py --pptx content/source.pptx --pdf content/slides.pdf
   ```

   Skript vypíše souhrn: počet slajdů, nalezená videa (slajd → soubor → pozice)
   a případná varování. Videa skončí v `content/videos/`, konfigurace
   v `content/config.json`.

## Ovládání

V **Živém PowerPointu** ovládáš prezentaci přímo v okně PowerPointu (klikátko,
myš); klávesy níže označené „PDF“ v něm nic nedělají a aplikace to připomene.

| Ovládání | Akce | Režim |
| --- | --- | --- |
| `→` `↓` `PageDown` | další slajd (funguje s klikátkem) | PDF |
| `←` `↑` `PageUp` | předchozí slajd | PDF |
| `Home` / `End` | první / poslední slajd | PDF |
| **klik na slajd** | další slajd | PDF |
| **klik u levého okraje** (12 % šířky) | předchozí slajd | PDF |
| **kolečko myši** dolů/nahoru | další / předchozí (max 1 krok za 0,3 s) | PDF |
| `Mezerník` | na slajdu s videem: přehrát/pauza; jinak další slajd | PDF |
| `F` | fullscreen zap/vyp | oba |
| `+` / `−` | zvětšit / zmenšit písmo titulků (0.7×–1.6×) | oba |
| `C` | zobrazit/skrýt český řádek nad titulky | oba |
| `Esc` | otevřít start panel (mikrofon běží dál; lze titulky zastavit) | oba |

## Řešení potíží

**Titulky se pořád restartují / neběží** — postupuj takto:

1. Start panel (`Esc`) → **`Diagnostika mikrofonu`** → mluv ~8 s → verdikt
   řekne, jestli je problém ve zvuku, v síti, nebo v oprávnění.
2. Okno aplikace nesmí být **minimalizované ani úplně překryté** — Chrome
   skrytým stránkám pozastavuje rozpoznávání (typicky při Živém PowerPointu
   přes celou obrazovku na jednom monitoru).
3. Rozpoznávání běží přes servery Googlu — **VPN/firewall** je může blokovat.

Stavy pilulky „mikrofon“ a jejich význam:

| Pilulka | Význam |
| --- | --- |
| `poslouchám` (zeleně) | vše v pořádku; svítí i během normálních pauz v řeči |
| `síť rozpoznávání nedostupná — zkouším dál` | speech servery nedostupné — síť/VPN/firewall; obnoví se samo |
| `mikrofon nenalezen / nedává zvuk` | Chrome nedostává audio — zkontroluj vstup ve Windows |
| `rozpoznávání přerušováno — okno nesmí být skryté` | okno aplikace je minimalizované/překryté |
| `restartuji… (…)` | opakované restarty z uvedeného důvodu; v závorce chybový kód |
| `přístup zamítnut` | povol mikrofon v liště adresy a spusť znovu |

**„Sdílení okna skončilo“ (Živý PowerPoint)** — zavřel se prezentační režim
PowerPointu, nebo bylo sdílení zastaveno (lišta Chromu „Zastavit sdílení“).
Spusť prezentaci v PowerPointu znovu a klikni na `Znovu vybrat okno`.

**Černý/zamrzlý obraz v Živém PowerPointu** — okno PowerPointu je nejspíš
**minimalizované**; Windows ho pak nepřekresluje. Obnov ho (stačí za oknem
aplikace, překrytí nevadí). Pomáhá i vypnout spořič/zámek obrazovky.

**PDF má okraje kolem slajdů (žlutý proužek v aplikaci)** — PDF vzniklo tiskem
(tiskárna přidává okraje papíru). Vytvoř ho znovu průvodcem (automatický
export), nebo v PowerPointu přes `Soubor → Uložit jako → typ PDF`.

**Nahrání prezentace hlásí chybu / „Příprava vyžaduje Python server“** —
wizard potřebuje Python server (`tools/serve.py`), který `start.bat` spouští
automaticky, když je Python nainstalovaný. Záložní PowerShell server
(`serve.ps1`) je jen statický a přípravu neumí — na stroji bez Pythonu připrav
obsah ručně (viz Pokročilá cesta). Pokud jsi právě aktualizoval aplikaci,
restartuj server (`stop.bat` + `start.bat`).

**Převod do PDF selhal (žlutá obrazovka)** — na stroji chybí PowerPoint, nebo
soubor odmítl otevřít. Videa i konfigurace už jsou připravené; stačí PDF
doplnit ručně: v PowerPointu `Soubor → Uložit jako → typ PDF` → ulož jako
`content\slides.pdf` → v aplikaci „Zkontrolovat znovu“.

**Mikrofon zamítnut** — Chrome ukáže ikonu zámku/kamery v adresním řádku.
Klikni na ni → Mikrofon → Povolit, pak v panelu znovu „Spustit prezentaci
s titulky“.

**Video nehraje** — `.MOV` kontejner Chrome vždy nepřehraje. Pokud je
nainstalované `ffmpeg`, `prep.py` video převede sám (bezeztrátově). Ručně:

```
ffmpeg -y -i "content/videos/media1.mov" -c copy "content/videos/media1.mp4"
```

a v `content/config.json` u příslušného videa změň `file` na `.mp4`.

**Překlad nedostupný** — pilulka „překlad“ zčervená a titulky ukazují češtinu
s prefixem `·`. Primární překladač (Google) se obnoví sám (zkouší se každých
15 s). Volitelná lokální záloha LibreTranslate:

```
pip install libretranslate
libretranslate --load-only cs,en,uk
```

a v `app/captions.js` nastav `LIBRE_URL = "http://localhost:5000"`.

**SmartScreen blokuje `start.bat`** — klikni na „Více informací“ →
„Přesto spustit“. Skript jen spouští lokální server a Chrome.

**Převíjení ve videu nefunguje** — použitý server musí podporovat HTTP Range.
`start.bat` spouští `tools/serve.py` (Range umí, stejně jako záložní
`tools/serve.ps1`). Holý `python -m http.server` **nepoužívej** — neservíruje
`.mjs` moduly správně (aplikace se vůbec nenačte) a Range neumí.

## Jak přidat opravy přehmatů (`CORRECTIONS`)

Rozpoznávač občas komolí firemní zkratky („ejč ár“ místo „HR“). Otevři
`app/captions.js` a do pole `CORRECTIONS` přidej páry
`[co_hledat, čím_nahradit]`:

```js
const CORRECTIONS = [
  ["ejč ár", "HR"],
  ["kví ej", "QA"],
];
```

Nahrazuje se na hranicích slov (bez ohledu na velikost písmen) ještě **před**
zobrazením i překladem, takže oprava se propíše do češtiny, angličtiny
i ukrajinštiny.

## Struktura projektu

```
index.html            aplikace (jedna stránka)
app/                  ES moduly: app.js, slides.js, captions.js, panel.js,
                      wizard.js, live.js, pdf.js
vendor/pdfjs/         vendorovaná pdf.js v4 (žádné CDN za běhu)
tools/prep.py         extrakce videí a GIFů z PPTX + content/config.json (v2)
tools/serve.py        lokální server (Python, MIME + Range + API přípravy)
tools/serve.ps1       lokální server (PowerShell fallback, jen statika)
tools/export-pdf.ps1  PPTX → PDF přes PowerPoint (volá ho server)
tools/test-api.py     testy API přípravy
content/              slides.pdf, videos/, config.json — negitováno
start.bat/stop.bat    spuštění/zastavení serveru + otevření Chrome
```
