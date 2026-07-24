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
import { initMicDiag } from "./micdiag.js";

console.log("[townhall-titulky] pdf.js verze:", pdfjsVersion);

// Poslední známý stav obsahu na serveru. hasApi=false = statický fallback
// server (serve.ps1 vrací pro /api/* 501) nebo server nedostupný — wizard
// tam nemá jak připravit obsah, otvírat ho nemá smysl.
let contentStatus = { hasApi: false, hasPdf: false, hasConfig: false };

async function refreshContentStatus() {
  try {
    const r = await fetch("api/content/status", { cache: "no-store" });
    if (r.ok) {
      const cs = await r.json();
      contentStatus = Object.assign(
        { hasApi: true, hasPdf: false, hasConfig: false }, cs);
    } else {
      contentStatus = { hasApi: false, hasPdf: false, hasConfig: false };
    }
  } catch (e) {
    contentStatus = { hasApi: false, hasPdf: false, hasConfig: false };
  }
  return contentStatus;
}

async function main() {
  let panel = null;
  let wizard = null;

  // Otevře wizard rovnou na drop zóně (bez potvrzování přepisu — obsah chybí).
  const openUploadWizard = () => {
    if (panel) panel.hide();
    if (wizard) wizard.open({ skipConfirm: true });
  };

  // Exe režim (auto-exit server): heartbeat každých 5 s drží server naživu;
  // zavření okna beaty zastaví a watchdog serveru proces ukončí. Startuje
  // HNED (před načítáním PDF) — pomalý první render nesmí spotřebovat grace.
  fetch("api/env", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((env) => {
      if (!env || !env.autoExit) return;
      const beat = () => {
        fetch("api/heartbeat", { method: "POST", keepalive: true })
          .catch(() => { /* výpadek beatů řeší watchdog, ne UI */ });
      };
      beat();
      setInterval(beat, 5000);
    })
    .catch(() => { /* server bez API (serve.ps1) — žádné beaty */ });

  // Titulkovací engine (staví UI v pásu #captions, +/- a C klávesy, status pills).
  // Mikrofon se NEspouští automaticky — spouští ho start panel.
  const captions = initCaptions({
    onMicDenied: (msg) => { if (panel) panel.showMessage(msg); },
  });

  const slides = await initSlides({
    onRequestUpload: openUploadWizard,
    getContentStatus: refreshContentStatus,
  });

  // Wizard nahrání prezentace; po zavření se vrací start panel.
  wizard = initWizard({ onClose: () => { if (panel) panel.show(); } });

  // Živé zrcadlení PowerPointu (getDisplayMedia); zpět vede na start panel.
  const live = initLive({ onBackToPanel: () => { if (panel) panel.show(); } });

  // Diagnostika mikrofonu (~8 s self-test); po zavření zpět na panel.
  const micdiag = initMicDiag({ onClose: () => { if (panel) panel.show(); } });

  // Start panel (overlay): deck name + počet slajdů, kompat. varování, tlačítka.
  panel = initPanel({
    slides, captions,
    onUpload: () => wizard.open(),
    onStartLive: () => live.start(),
    onMicDiag: () => micdiag.open(),
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
  window.__townhall = { pdfjsVersion, slides, captions, panel, wizard, live, micdiag };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
