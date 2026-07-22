# townhall-titulky

Prezentační aplikace pro firemní townhall: promítá slidy na celou obrazovku a pod
nimi zobrazuje **živé titulky** překládané z češtiny do angličtiny a ukrajinštiny.
Vše běží lokálně v Google Chrome na Windows notebooku — bez API klíčů, bez účtů,
zdarma.

## Požadavky

- Windows 10/11
- **Google Chrome** (rozpoznávání řeči funguje jen v něm)
- Internet v sále (překladové endpointy jsou jediná síťová komunikace)
- Mikrofonní vstup z mixážního pultu nastavený jako **výchozí** vstupní zařízení
  ve Windows (Nastavení → Systém → Zvuk → Vstup)
- Python 3 (pro `tools/prep.py` a lokální server); bez Pythonu se server spustí
  přes PowerShell (`tools/serve.ps1`), ale `prep.py` Python potřebuje

## Příprava před každým townhallem (krok za krokem)

1. V PowerPointu: `Soubor → Uložit jako → PDF` → ulož jako `content/slides.pdf`.
2. Původní prezentaci ulož jako `content/source.pptx`.
3. Vytáhni videa a vygeneruj konfiguraci:

   ```
   python tools/prep.py --pptx content/source.pptx --pdf content/slides.pdf
   ```

   Skript vypíše souhrn: počet slajdů, nalezená videa (slajd → soubor → pozice)
   a případná varování. Videa skončí v `content/videos/`, konfigurace
   v `content/config.json`.
4. Spusť **`start.bat`** — nastartuje lokální server na `http://localhost:8137`
   a otevře Chrome. V aplikaci klikni na **„Spustit prezentaci s titulky“**
   a povol mikrofon.
5. Řekni zkušební větu do mikrofonu — v dolním pásu se objeví anglický
   a ukrajinský překlad.

Po akci server zastavíš přes **`stop.bat`**.

## Ovládání

| Klávesa | Akce |
| --- | --- |
| `→` `↓` `PageDown` | další slajd (funguje s klikátkem) |
| `←` `↑` `PageUp` | předchozí slajd |
| `Home` / `End` | první / poslední slajd |
| `Mezerník` | na slajdu s videem: přehrát/pauza; jinak další slajd |
| `F` | fullscreen zap/vyp |
| `+` / `−` | zvětšit / zmenšit písmo titulků (0.7×–1.5×) |
| `C` | zobrazit/skrýt český řádek nad titulky |
| `Esc` | otevřít start panel (mikrofon běží dál; lze titulky zastavit) |

## Řešení potíží

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
index.html          aplikace (jedna stránka)
app/                ES moduly: app.js, slides.js, captions.js, panel.js, pdf.js
vendor/pdfjs/       vendorovaná pdf.js v4 (žádné CDN za běhu)
tools/prep.py       extrakce videí z PPTX + generování content/config.json
tools/serve.py      lokální server (Python, MIME + HTTP Range)
tools/serve.ps1     lokální server (PowerShell fallback bez Pythonu)
content/            slides.pdf, videos/, config.json — negitováno, plní prep.py
start.bat/stop.bat  spuštění/zastavení serveru + otevření Chrome
```
