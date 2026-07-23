// app/app.js — ES module vstupní bod aplikace.
//
// Orchestruje moduly: pdf.js (vendorovaná knihovna), slides.js (renderer + navigace
// + video overlay), captions.js (titulkovací engine) a panel.js (start panel).

import { pdfjsVersion } from "./pdf.js";
import { initSlides } from "./slides.js";
import { initCaptions } from "./captions.js";
import { initPanel, getMode } from "./panel.js";
import { initWizard } from "./wizard.js";
import { initLive } from "./live.js";

console.log("[townhall-titulky] pdf.js verze:", pdfjsVersion);

async function main() {
  let panel = null;

  // Titulkovací engine (staví UI v pásu #captions, +/- a C klávesy, status pills).
  // Mikrofon se NEspouští automaticky — spouští ho start panel.
  const captions = initCaptions({
    onMicDenied: (msg) => { if (panel) panel.showMessage(msg); },
  });

  const slides = await initSlides();

  // Wizard nahrání prezentace; po zavření se vrací start panel.
  const wizard = initWizard({ onClose: () => { if (panel) panel.show(); } });

  // Živé zrcadlení PowerPointu (getDisplayMedia); zpět vede na start panel.
  const live = initLive({ onBackToPanel: () => { if (panel) panel.show(); } });

  // Start panel (overlay): deck name + počet slajdů, kompat. varování, tlačítka.
  panel = initPanel({
    slides, captions,
    onUpload: () => wizard.open(),
    onStartLive: () => live.start(),
  });

  // Chybí/nekompletní obsah → místo start panelu rovnou wizard (drop zóna).
  // Jen v PDF režimu — živé zrcadlení žádný připravený obsah nepotřebuje.
  // Statický fallback server (serve.ps1) vrací pro /api/* 501 → wizard se
  // neotvírá a panel zůstává (varování o obsahu ukazuje sám).
  if (getMode() === "pdf") {
    try {
      const r = await fetch("api/content/status", { cache: "no-store" });
      if (r.ok) {
        const cs = await r.json();
        if (!cs.hasPdf || !cs.hasConfig) {
          panel.hide();
          wizard.open({ skipConfirm: true });
        }
      }
    } catch (e) { /* server bez API — panel zůstává */ }
  }

  // Zpřístupníme pro ladění.
  window.__townhall = { pdfjsVersion, slides, captions, panel, wizard, live };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
