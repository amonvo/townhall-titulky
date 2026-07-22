// app/pdf.js — jednotné místo pro vendorovanou pdf.js.
// Importuje knihovnu a nastaví worker na vendorovaný soubor (žádné CDN za běhu).
// Importují odsud jak app.js, tak slides.js.

import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "../vendor/pdfjs/pdf.worker.min.mjs",
  import.meta.url
).href;

export const pdfjsVersion = pdfjsLib.version;
export { pdfjsLib };
