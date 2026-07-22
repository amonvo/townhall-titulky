// app/app.js — ES module vstupní bod aplikace.
//
// Orchestruje moduly: pdf.js (vendorovaná knihovna), slides.js (renderer + navigace
// + video overlay). Titulkovací engine (captions.js) a start panel se připojí ve
// Fázích 4–5.

import { pdfjsVersion } from "./pdf.js";
import { initSlides } from "./slides.js";
import { initCaptions } from "./captions.js";

console.log("[townhall-titulky] pdf.js verze:", pdfjsVersion);

async function main() {
  // Titulkovací engine (staví UI v pásu #captions, +/- a C klávesy, status pills).
  // Mikrofon se NEspouští automaticky — spustí ho start panel ve Fázi 5.
  const captions = initCaptions({
    onMicDenied: (msg) => console.warn("[captions] mic denied:", msg),
  });

  const slides = await initSlides();

  // Zpřístupníme pro ladění a pro pozdější napojení (Fáze 5 start panel).
  window.__townhall = { pdfjsVersion, slides, captions };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
