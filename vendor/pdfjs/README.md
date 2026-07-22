# vendor/pdfjs

Vendorované soubory z balíku [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist),
**připnutá verze `4.10.38`**. Staženo přes `npm pack pdfjs-dist@4.10.38`, zkopírovány
pouze potřebné soubory (žádné `node_modules` za běhu):

- `pdf.min.mjs` — hlavní knihovna (ES module)
- `pdf.worker.min.mjs` — worker
- `LICENSE` — Apache-2.0 (Mozilla)

Aplikace importuje `pdf.min.mjs` a nastaví `GlobalWorkerOptions.workerSrc` na
vendorovaný worker. Aktualizace verze = stáhnout znovu přes `npm pack` a přepsat
tyto soubory (a upravit číslo verze zde).
