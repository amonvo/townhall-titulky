// app/app.js — ES module vstupní bod aplikace.
//
// Orchestruje moduly: pdf.js (vendorovaná knihovna), slides.js (renderer + navigace
// + video overlay). Titulkovací engine (captions.js) a start panel se připojí ve
// Fázích 4–5.

import { pdfjsVersion } from "./pdf.js";
import { initSlides } from "./slides.js";

console.log("[townhall-titulky] pdf.js verze:", pdfjsVersion);

async function main() {
  const slides = await initSlides();
  // Zpřístupníme pro ladění a pro pozdější napojení (Fáze 4/5).
  window.__townhall = { pdfjsVersion, slides };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
