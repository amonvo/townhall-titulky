// app/panel.js — start panel (overlay přes celou aplikaci).
//
// Zobrazuje se při načtení: název decku, počet slajdů, kompatibilitní varování,
// tlačítka pro spuštění s/bez titulků a legendu kláves. `Esc` panel kdykoli znovu
// otevře (mikrofon běží dál); v běžícím stavu nabízí „Zastavit titulky" a
// „Pokračovat". Dokud je panel otevřený, klávesy aplikace (šipky, mezerník…)
// se nepropouštějí do slides.js/captions.js.

import { isSpeechSupported } from "./captions.js";

// Klávesy, které si jinak rozebírají slides.js a captions.js — při otevřeném
// panelu je blokujeme, aby prezentace „neujížděla" pod overlay.
const APP_KEYS = new Set([
  "ArrowRight", "ArrowDown", "PageDown",
  "ArrowLeft", "ArrowUp", "PageUp",
  "Home", "End", " ", "Spacebar",
  "f", "F", "+", "=", "-", "_", "c", "C",
]);

let overlayEl, subEl, warnsEl, msgEl, buttonsEl, cardsEl;
let slidesApi = null;
let captionsApi = null;
let onUpload = null;    // otevře wizard nahrání prezentace (napojuje app.js)
let onModeChange = null;
let visible = false;

/* ---------- režim promítání (localStorage) ---------- */

const MODE_KEY = "townhall.mode";

// "live" = Živý PowerPoint (getDisplayMedia zrcadlení), "pdf" = PDF režim.
export function getMode() {
  let v = null;
  try { v = localStorage.getItem(MODE_KEY); } catch (e) { /* private mode */ }
  return v === "pdf" ? "pdf" : "live"; // default: Živý PowerPoint
}

export function setMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch (e) { /* private mode */ }
  if (typeof onModeChange === "function") onModeChange(mode);
}

function czPluralSlides(n) {
  if (n === 1) return "1 slajd";
  if (n >= 2 && n <= 4) return n + " slajdy";
  return n + " slajdů";
}

function isLikelyChrome() {
  const ua = navigator.userAgent;
  return /Chrome\//.test(ua) && !/Edg\//.test(ua) && !/OPR\//.test(ua);
}

/* ---------- sestavení DOM ---------- */

function makeButton(label, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "panel-btn " + cls;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function buildPanel() {
  overlayEl = document.createElement("div");
  overlayEl.id = "panel-overlay";

  const box = document.createElement("div");
  box.className = "panel-box";

  const title = document.createElement("h1");
  title.className = "panel-title";
  title.textContent = "Živé titulky — Townhall";

  subEl = document.createElement("div");
  subEl.className = "panel-sub";

  warnsEl = document.createElement("div");
  warnsEl.className = "panel-warns";

  // Výběr režimu: dvě karty nad tlačítky.
  cardsEl = document.createElement("div");
  cardsEl.className = "mode-cards";
  const cardDefs = [
    {
      mode: "live",
      title: "Živý PowerPoint (doporučeno)",
      sub: "Zrcadlí běžící prezentaci — animace, videa i přechody. " +
        "Vyžaduje notebook + projektor (rozšířená plocha).",
    },
    {
      mode: "pdf",
      title: "PDF režim",
      sub: "Promítá připravené PDF. Pro jedinou obrazovku nebo jako záloha.",
    },
  ];
  cardDefs.forEach((def) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "mode-card";
    card.dataset.mode = def.mode;
    const t = document.createElement("div");
    t.className = "mode-card-title";
    t.textContent = def.title;
    const s = document.createElement("div");
    s.className = "mode-card-sub";
    s.textContent = def.sub;
    card.appendChild(t);
    card.appendChild(s);
    card.addEventListener("click", () => {
      setMode(def.mode);
      refreshCards();
      refreshWarnings();
      refreshButtons();
    });
    cardsEl.appendChild(card);
  });

  msgEl = document.createElement("div");
  msgEl.className = "panel-msg hidden";

  buttonsEl = document.createElement("div");
  buttonsEl.className = "panel-buttons";

  const legend = document.createElement("div");
  legend.className = "panel-legend";
  legend.innerHTML =
    "<kbd>←</kbd><kbd>→</kbd> / klikátko&nbsp;slajdy · " +
    "<kbd>Mezerník</kbd> video · <kbd>F</kbd> fullscreen · " +
    "<kbd>+</kbd><kbd>−</kbd> písmo · <kbd>C</kbd> český řádek · " +
    "<kbd>Esc</kbd> panel";

  box.appendChild(title);
  box.appendChild(subEl);
  box.appendChild(warnsEl);
  box.appendChild(cardsEl);
  box.appendChild(msgEl);
  box.appendChild(buttonsEl);
  box.appendChild(legend);
  overlayEl.appendChild(box);
  document.body.appendChild(overlayEl);
}

function addWarn(text) {
  const w = document.createElement("div");
  w.className = "panel-warn";
  w.textContent = "⚠ " + text;
  warnsEl.appendChild(w);
}

function refreshSubtitle() {
  const cfg = slidesApi && slidesApi.config;
  if (cfg) {
    const parts = [];
    if (cfg.deckName) parts.push(cfg.deckName);
    const count = (slidesApi.getState && slidesApi.getState().pageCount)
      || cfg.slideCount || 0;
    if (count) parts.push(czPluralSlides(count));
    subEl.textContent = parts.join(" · ") || "Prezentace připravena";
  } else {
    subEl.textContent = "Obsah zatím není připraven";
  }
}

function refreshCards() {
  if (!cardsEl) return;
  const mode = getMode();
  [...cardsEl.children].forEach((card) => {
    card.classList.toggle("selected", card.dataset.mode === mode);
  });
}

function refreshWarnings() {
  warnsEl.textContent = "";
  if (!isLikelyChrome() || !isSpeechSupported()) {
    addWarn("Rozpoznávání řeči vyžaduje Google Chrome — v tomto prohlížeči titulky nepoběží.");
  }
  if (location.protocol === "file:") {
    addWarn("Aplikace běží ze souboru (file://) — spusť ji přes start.bat, jinak nepůjde načíst obsah ani mikrofon.");
  }
  // Chybějící obsah je problém jen v PDF režimu — živé zrcadlení ho nepotřebuje.
  if (getMode() === "pdf" && (!slidesApi || !slidesApi.ok)) {
    addWarn("Chybí obsah — nahraj prezentaci průvodcem, nebo spusť tools/prep.py (viz README).");
  }
}

function refreshButtons() {
  buttonsEl.textContent = "";
  const running = captionsApi && captionsApi.isRunning();
  if (running) {
    buttonsEl.appendChild(makeButton("Pokračovat", "primary", () => hide()));
    buttonsEl.appendChild(makeButton("Zastavit titulky", "ghost", () => {
      captionsApi.stop();
      refreshButtons();
    }));
  } else {
    const startBtn = makeButton("Spustit prezentaci s titulky", "primary", () => {
      const ok = captionsApi.start();
      if (ok) { hide(); }
      else {
        showMessage("Mikrofon se nepodařilo spustit — zkontroluj vstupní zařízení ve Windows.");
      }
    });
    if (!isSpeechSupported()) startBtn.disabled = true;
    buttonsEl.appendChild(startBtn);
    buttonsEl.appendChild(makeButton("Jen prezentace (bez titulků)", "ghost", () => hide()));
    // Nahrání prezentace má smysl jen v PDF režimu — capture nic nepřipravuje.
    if (typeof onUpload === "function" && getMode() === "pdf") {
      buttonsEl.appendChild(makeButton("Nahrát novou prezentaci", "ghost", () => {
        hide();
        onUpload();
      }));
    }
  }
}

/* ---------- zobrazení / skrytí ---------- */

function show() {
  refreshSubtitle();
  refreshWarnings();
  refreshCards();
  refreshButtons();
  overlayEl.classList.remove("hidden");
  visible = true;
}

function hide() {
  overlayEl.classList.add("hidden");
  msgEl.classList.add("hidden");
  msgEl.textContent = "";
  visible = false;
}

// Zobrazí panel s výraznou zprávou (např. zamítnutý mikrofon).
function showMessage(message) {
  show();
  msgEl.textContent = message;
  msgEl.classList.remove("hidden");
  refreshButtons(); // stav mikrofonu se mohl změnit (running=false)
}

/* ---------- klávesy ---------- */

// Capture fáze: při otevřeném panelu spolkne klávesy aplikace a řeší Esc.
function onKeyCapture(e) {
  if (!visible) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    hide();
    return;
  }
  if (APP_KEYS.has(e.key)) {
    e.stopPropagation();
  }
}

// Bubble fáze: Esc při zavřeném panelu ho znovu otevře (mikrofon běží dál).
function onKeyOpen(e) {
  if (e.key === "Escape" && !visible) {
    e.preventDefault();
    show();
  }
}

/* ---------- veřejné API ---------- */

export function initPanel(opts) {
  slidesApi = opts.slides || null;
  captionsApi = opts.captions;
  onUpload = opts.onUpload || null;
  onModeChange = opts.onModeChange || null;
  buildPanel();
  window.addEventListener("keydown", onKeyCapture, true);
  window.addEventListener("keydown", onKeyOpen);
  show();
  return { show, hide, showMessage, isVisible: () => visible, getMode };
}
