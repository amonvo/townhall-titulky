// app/app.js — ES module vstupní bod aplikace.
//
// Orchestruje moduly: pdf.js (vendorovaná knihovna), slides.js (renderer + navigace
// + video overlay), captions.js (titulkovací engine) a panel.js (start panel).

import { pdfjsVersion } from "./pdf.js";
import { initSlides } from "./slides.js";
import { initCaptions } from "./captions.js";
import { initPanel } from "./panel.js";

console.log("[townhall-titulky] pdf.js verze:", pdfjsVersion);

async function main() {
  let panel = null;

  // Titulkovací engine (staví UI v pásu #captions, +/- a C klávesy, status pills).
  // Mikrofon se NEspouští automaticky — spouští ho start panel.
  const captions = initCaptions({
    onMicDenied: (msg) => { if (panel) panel.showMessage(msg); },
  });

  const slides = await initSlides();

  // Start panel (overlay): deck name + počet slajdů, kompat. varování, tlačítka.
  panel = initPanel({ slides, captions });

  // Zpřístupníme pro ladění.
  window.__townhall = { pdfjsVersion, slides, captions, panel };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
