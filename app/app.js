// app/app.js — ES module vstupní bod aplikace.
//
// Fáze 1: vendorovaná pdf.js se naimportuje, nastaví se worker a do konzole i
// dočasného stavového řádku se vypíše verze (důkaz, že knihovna běží bez CDN).
// Fáze 3–5 sem připojí renderer slidů (slides.js) a titulkovací engine (captions.js).

import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";

// Worker musí ukazovat na vendorovaný soubor (žádné CDN za běhu).
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "../vendor/pdfjs/pdf.worker.min.mjs",
  import.meta.url
).href;

const version = pdfjsLib.version;
console.log("[townhall-titulky] pdf.js verze:", version);

const boot = document.getElementById("boot-status");
if (boot) {
  boot.textContent = "pdf.js " + version + " ✓";
}

// Zpřístupníme knihovnu dalším modulům (Fáze 3 renderer).
export { pdfjsLib };
