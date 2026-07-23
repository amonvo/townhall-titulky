// app/live.js — režim „Živý PowerPoint": zrcadlení běžící prezentace přes
// getDisplayMedia. 100% věrnost (animace, přechody, GIFy, videa se zvukem ze
// systému) a nativní ovládání klikátkem PŘÍMO v okně PowerPointu.
//
// Stavy: guidance (návod + výběr okna) → active (stream na stage) → ended
// (sdílení skončilo: znovu vybrat / zpět na úvod). Titulky běží nezávisle
// v obou režimech.

import { registerTransient, showTransient } from "./slides.js";

// Navigační klávesy, které v capture režimu nic neovládají — místo toho toast.
const NAV_KEYS = new Set([
  "ArrowRight", "ArrowDown", "PageDown",
  "ArrowLeft", "ArrowUp", "PageUp",
  "Home", "End", " ", "Spacebar",
]);

let overlayEl, bodyEl, videoEl, toastEl, pillEl, pillStateEl;
let onBackToPanel = null;
let active = false;          // stream běží
let overlayScreen = null;    // null | "guidance" | "ended"
let stream = null;
let toastTimer = null;

/* ---------- DOM ---------- */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function makeButton(label, cls, onClick) {
  const b = el("button", "panel-btn " + cls, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function buildDom() {
  // Video na stage (zobrazuje se přes body.live-active)
  videoEl = document.createElement("video");
  videoEl.id = "live-video";
  videoEl.autoplay = true;
  videoEl.muted = true;
  videoEl.playsInline = true;
  document.getElementById("stage").appendChild(videoEl);

  // Overlay (guidance / ended)
  overlayEl = el("div", "hidden");
  overlayEl.id = "live-overlay";
  const box = el("div", "wizard-box");
  box.appendChild(el("h1", "panel-title", "Živý PowerPoint"));
  bodyEl = el("div", "wizard-body");
  box.appendChild(bodyEl);
  overlayEl.appendChild(box);
  document.body.appendChild(overlayEl);

  // Toast pro navigační klávesy
  toastEl = el("div", "hidden", "Prezentaci ovládej v okně PowerPointu.");
  toastEl.id = "live-toast";
  document.body.appendChild(toastEl);

  // Status pill „zdroj: PowerPoint" (vedle pills od captions)
  const pills = document.getElementById("status-pills");
  if (pills) {
    pillEl = el("div", "pill");
    const label = el("span", null, "zdroj: ");
    pillStateEl = el("span", null, "PowerPoint");
    pillEl.appendChild(label);
    pillEl.appendChild(pillStateEl);
    pillEl.style.display = "none";
    pills.appendChild(pillEl);
    registerTransient(pillEl);
  }
}

/* ---------- obrazovky overlay ---------- */

function setScreen(name, build) {
  overlayScreen = name;
  bodyEl.textContent = "";
  build(bodyEl);
  overlayEl.classList.remove("hidden");
}

function hideOverlay() {
  overlayScreen = null;
  overlayEl.classList.add("hidden");
}

function showGuidance(errorMsg) {
  setScreen("guidance", (root) => {
    const steps = el("ol", "live-steps");
    [
      "V PowerPointu: karta Prezentace → Nastavit prezentaci → " +
        "„Procházení jednotlivcem (okno)“ → OK → Spustit prezentaci od začátku.",
      "Klikni níže na „Vybrat okno PowerPointu“ a v dialogu Chromu zvol okno s prezentací.",
      "Prezentaci pak ovládej klikáním / klikátkem PŘÍMO v okně PowerPointu. " +
        "Okno nechej otevřené (klidně za touto aplikací), jen ho neminimalizuj.",
    ].forEach((t) => steps.appendChild(el("li", null, t)));
    root.appendChild(steps);

    const err = el("div", "wizard-error", errorMsg || "");
    if (!errorMsg) err.classList.add("hidden");
    root.appendChild(err);

    const btns = el("div", "panel-buttons");
    btns.appendChild(makeButton("Vybrat okno PowerPointu", "primary", pickWindow));
    btns.appendChild(makeButton("Zpět", "ghost", backToPanel));
    root.appendChild(btns);
    root.appendChild(el("div", "wizard-hint", "Esc — zpět na úvod"));
  });
}

function showEnded() {
  setScreen("ended", (root) => {
    root.appendChild(el("p", "wizard-manual", "Sdílení okna skončilo."));
    const btns = el("div", "panel-buttons");
    btns.appendChild(makeButton("Znovu vybrat okno", "primary", pickWindow));
    btns.appendChild(makeButton("Zpět na úvod", "ghost", backToPanel));
    root.appendChild(btns);
  });
}

function backToPanel() {
  hideOverlay();
  teardownStream();
  if (typeof onBackToPanel === "function") onBackToPanel();
}

/* ---------- stream ---------- */

function attachStream(s) {
  teardownStream();
  stream = s;
  videoEl.srcObject = s;
  active = true;
  document.body.classList.add("live-active");
  hideOverlay();
  if (pillEl) {
    pillEl.style.display = "";
    pillEl.classList.add("ok");
    showTransient();
  }
  const track = s.getVideoTracks()[0];
  if (track) {
    track.addEventListener("ended", () => {
      // Uživatel zastavil sdílení / zavřel okno.
      teardownStream();
      showEnded();
    });
  }
}

function teardownStream() {
  if (stream) {
    stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
    stream = null;
  }
  videoEl.srcObject = null;
  active = false;
  document.body.classList.remove("live-active");
  if (pillEl) {
    pillEl.style.display = "none";
    pillEl.classList.remove("ok");
  }
}

async function pickWindow() {
  let s;
  try {
    s = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "window", frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (e) {
    // Zavření pickeru (dismissed) → tiše zpět na návod, žádný error spam.
    if (e && /dismissed/i.test(e.message || "")) {
      showGuidance();
    } else {
      showGuidance("Chrome nedostal povolení ke sdílení okna. " +
        "Povol sdílení (ikona kamery v adresním řádku) a zkus to znovu.");
    }
    return;
  }
  attachStream(s);
}

/* ---------- klávesy + toast ---------- */

function showToast() {
  toastEl.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 4000);
}

function onKeyCapture(e) {
  // Overlay (guidance/ended): Esc = zpět na úvod, navigace se blokuje.
  if (overlayScreen) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation(); // panel by tentýž Esc hned zpracoval taky
      backToPanel();
      return;
    }
    if (NAV_KEYS.has(e.key)) e.stopPropagation();
    return;
  }
  if (!active) return;
  // Aktivní zrcadlení: navigační klávesy nic neovládají → toast.
  // F, +/-, C a Esc propadají dál (fullscreen, škála, český řádek, panel).
  if (NAV_KEYS.has(e.key)) {
    e.preventDefault();
    e.stopPropagation();
    showToast();
  }
}

/* ---------- veřejné API ---------- */

export function initLive(opts) {
  opts = opts || {};
  onBackToPanel = opts.onBackToPanel || null;
  buildDom();
  window.addEventListener("keydown", onKeyCapture, true);

  // Testovací šev (?test=1): stav stroje bez reálného getDisplayMedia —
  // fake MediaStream z canvas.captureStream(), ended přes dispatchEvent.
  if (/[?&]test=1/.test(location.search)) {
    window.__liveTest = {
      attachFake: function () {
        const c = document.createElement("canvas");
        c.width = 640; c.height = 360;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#123456";
        ctx.fillRect(0, 0, c.width, c.height);
        attachStream(c.captureStream(10));
        return true;
      },
      endTracks: function () {
        if (!stream) return false;
        stream.getVideoTracks().forEach((t) => {
          t.stop();
          t.dispatchEvent(new Event("ended"));
        });
        return true;
      },
    };
  }

  return {
    start: () => showGuidance(),
    stop: () => { hideOverlay(); teardownStream(); },
    isActive: () => active,
    getScreen: () => overlayScreen,
  };
}
