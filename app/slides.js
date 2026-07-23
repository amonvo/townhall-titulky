// app/slides.js — renderer slidů (pdf.js), navigace klávesnicí/klikátkem, video overlay.
//
// Layout: #stage (78vh) drží <canvas id="slide-canvas"> vycentrovaný a odškálovaný,
// video overlay se pokládá absolutně nad vykreslený obdélník slajdu. #captions (22vh)
// naplní Fáze 4.

import { pdfjsLib } from "./pdf.js";

const CONTENT_BASE = "content/";
const RESIZE_DEBOUNCE_MS = 150;
const UI_IDLE_MS = 4000;

// ---- Stav ------------------------------------------------------------------
let pdfDoc = null;
let config = null;
let pageCount = 0;
let current = 0;           // 0 = ještě nevykresleno; první goTo(1) tak vždy proběhne
let renderToken = 0;       // ruší zastaralé async rendery
let resizeTimer = null;

let stageEl, canvasEl, counterEl;
// overlaye (video + gif): mapa "číslo slajdu" -> pole { entry, wrap, kind, video?, badge? }
const overlaysBySlide = new Map();
let activeOverlays = [];   // overlay prvky aktuálního slajdu
let lastWheelAt = 0;       // throttle kolečka (1 krok / 300 ms)

// prvky, které se schovávají po nečinnosti (counter + Fáze 4 pills)
const transientEls = new Set();
let idleTimer = null;

// ---- Idle skrývání UI ------------------------------------------------------
export function registerTransient(el) {
  if (el) transientEls.add(el);
}

export function showTransient() {
  transientEls.forEach((el) => el.classList.remove("ui-hidden"));
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    transientEls.forEach((el) => el.classList.add("ui-hidden"));
  }, UI_IDLE_MS);
}

// ---- Načtení obsahu --------------------------------------------------------
async function loadConfig() {
  const res = await fetch(CONTENT_BASE + "config.json", { cache: "no-store" });
  if (!res.ok) throw new Error("config.json HTTP " + res.status);
  return res.json();
}

async function loadPdf(pdfName) {
  const url = CONTENT_BASE + (pdfName || "slides.pdf");
  const task = pdfjsLib.getDocument({ url });
  return task.promise;
}

function showSetupMessage() {
  // Přátelská CZ hláška místo rozbité aplikace.
  const msg = document.createElement("div");
  msg.id = "setup-message";
  msg.innerHTML =
    "<strong>Chybí obsah</strong><br>" +
    "Spusť <code>tools/prep.py</code> (viz README) a vlož " +
    "<code>content/slides.pdf</code>.";
  if (canvasEl) canvasEl.style.display = "none";
  stageEl.appendChild(msg);
}

// ---- Vykreslení slajdu -----------------------------------------------------
function computeFitScale(viewport) {
  const sw = stageEl.clientWidth;
  const sh = stageEl.clientHeight;
  return Math.min(sw / viewport.width, sh / viewport.height);
}

async function renderPage(num) {
  if (!pdfDoc) return;
  const token = ++renderToken;
  const page = await pdfDoc.getPage(num);
  if (token !== renderToken) return; // mezitím jsme odnavigovali

  const base = page.getViewport({ scale: 1 });
  const fit = computeFitScale(base);
  const dpr = window.devicePixelRatio || 1;

  const cssW = base.width * fit;
  const cssH = base.height * fit;

  const viewport = page.getViewport({ scale: fit * dpr });
  canvasEl.width = Math.round(viewport.width);
  canvasEl.height = Math.round(viewport.height);
  canvasEl.style.width = Math.round(cssW) + "px";
  canvasEl.style.height = Math.round(cssH) + "px";

  const ctx = canvasEl.getContext("2d");
  const renderTask = page.render({ canvasContext: ctx, viewport });
  try {
    await renderTask.promise;
  } catch (e) {
    if (e && e.name === "RenderingCancelledException") return;
    throw e;
  }
  if (token !== renderToken) return;

  positionActiveVideos();
  prefetch(num);
}

function prefetch(num) {
  // Přednačti sousední stránky (dekódování), aby navigace působila okamžitě.
  [num - 1, num + 1].forEach((n) => {
    if (n >= 1 && n <= pageCount && pdfDoc) {
      pdfDoc.getPage(n).catch(() => {});
    }
  });
}

function updateCounter() {
  if (counterEl) counterEl.textContent = current + " / " + pageCount;
}

// ---- Overlaye (video + gif) ------------------------------------------------
// Config v2 má jednotné `overlays` [{slide, type, file, x, y, w, h}];
// starší config jen `videos` → mapuje se na type "video".
function overlayEntries() {
  if (config && Array.isArray(config.overlays)) return config.overlays;
  if (config && Array.isArray(config.videos)) {
    return config.videos.map((v) => Object.assign({ type: "video" }, v));
  }
  return [];
}

function buildVideoOverlays() {
  overlayEntries().forEach((entry) => {
    let rec;
    if (entry.type === "gif") {
      // GIF: <img> — animuje nativně, žádné ovládání; kliky propadají
      // na navigaci (pointer-events: none na wrapu).
      const wrap = document.createElement("div");
      wrap.className = "gif-wrap";
      const img = document.createElement("img");
      img.className = "slide-gif";
      img.src = CONTENT_BASE + entry.file;
      img.alt = "";
      wrap.appendChild(img);
      wrap.style.display = "none";
      stageEl.appendChild(wrap);
      rec = { entry, wrap, kind: "gif" };
    } else {
      const wrap = document.createElement("div");
      wrap.className = "video-wrap";

      const video = document.createElement("video");
      video.className = "slide-video";
      video.src = CONTENT_BASE + entry.file;
      video.preload = "none";      // "auto" nastavíme jen pro aktuální slajd
      video.playsInline = true;
      video.controls = false;
      // Ne muted — sál musí video slyšet.

      const badge = document.createElement("button");
      badge.className = "play-badge";
      badge.type = "button";
      badge.setAttribute("aria-label", "Přehrát video");
      badge.textContent = "▶";

      const toggle = () => toggleVideo(video, badge);
      badge.addEventListener("click", toggle);
      video.addEventListener("click", toggle);
      video.addEventListener("play", () => { badge.classList.add("hidden"); });
      video.addEventListener("pause", () => { badge.classList.remove("hidden"); });
      video.addEventListener("ended", () => { badge.classList.remove("hidden"); });

      wrap.appendChild(video);
      wrap.appendChild(badge);
      wrap.style.display = "none";
      stageEl.appendChild(wrap);
      rec = { entry, wrap, kind: "video", video, badge };
    }
    if (!overlaysBySlide.has(entry.slide)) overlaysBySlide.set(entry.slide, []);
    overlaysBySlide.get(entry.slide).push(rec);
  });
}

function toggleVideo(video, badge) {
  if (video.paused) {
    // Přehrání jen na explicitní gesto uživatele (splňuje autoplay policy).
    video.play().catch(() => {});
  } else {
    video.pause();
  }
}

function positionOne(rec) {
  const cRect = canvasEl.getBoundingClientRect();
  const sRect = stageEl.getBoundingClientRect();
  const left = (cRect.left - sRect.left) + rec.entry.x * cRect.width;
  const top = (cRect.top - sRect.top) + rec.entry.y * cRect.height;
  const w = rec.entry.w * cRect.width;
  const h = rec.entry.h * cRect.height;
  rec.wrap.style.left = left + "px";
  rec.wrap.style.top = top + "px";
  rec.wrap.style.width = w + "px";
  rec.wrap.style.height = h + "px";
}

function positionActiveVideos() {
  activeOverlays.forEach(positionOne);
}

function showVideosFor(num) {
  // Skryj/pauzni overlaye předchozího slajdu (pozice videa se zachová).
  activeOverlays.forEach((rec) => {
    if (rec.kind === "video") {
      if (!rec.video.paused) rec.video.pause();
      rec.video.preload = "none";
    }
    rec.wrap.style.display = "none";
  });
  activeOverlays = overlaysBySlide.get(num) || [];
  activeOverlays.forEach((rec) => {
    rec.wrap.style.display = "block";
    if (rec.kind === "video") rec.video.preload = "auto";
    positionOne(rec);
  });
}

// ---- Navigace --------------------------------------------------------------
async function goTo(num) {
  const clamped = Math.max(1, Math.min(pageCount, num));
  if (clamped === current) return;
  current = clamped;
  updateCounter();
  showTransient();
  showVideosFor(current);
  await renderPage(current);
}

function next() { goTo(current + 1); }
function prev() { goTo(current - 1); }

function currentHasVideo() {
  return activeOverlays.some((rec) => rec.kind === "video");
}

function firstActiveVideo() {
  return activeOverlays.find((rec) => rec.kind === "video") || null;
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

function onKeyDown(e) {
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
      e.preventDefault(); next(); break;
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      e.preventDefault(); prev(); break;
    case "Home":
      e.preventDefault(); goTo(1); break;
    case "End":
      e.preventDefault(); goTo(pageCount); break;
    case " ":
    case "Spacebar":
      e.preventDefault();
      if (currentHasVideo()) {
        const rec = firstActiveVideo();
        toggleVideo(rec.video, rec.badge);
      } else {
        next();
      }
      break;
    case "f":
    case "F":
      e.preventDefault(); toggleFullscreen(); break;
    default:
      break;
  }
}

function onResize() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { renderPage(current); }, RESIZE_DEBOUNCE_MS);
}

// ---- Klik & kolečko (jen PDF režim) ----------------------------------------
function pdfNavActive() {
  return !!pdfDoc && !document.body.classList.contains("live-active");
}

function onStageClick(e) {
  if (!pdfNavActive()) return;
  // Kliky na video overlay dál přepínají play/pause; navigaci nekradou.
  if (e.target.closest && e.target.closest(".video-wrap")) return;
  const rect = stageEl.getBoundingClientRect();
  const frac = (e.clientX - rect.left) / rect.width;
  if (frac <= 0.12) prev(); else next();
}

function onWheel(e) {
  if (!pdfNavActive()) return;
  const now = Date.now();
  if (now - lastWheelAt < 300) return;
  if (e.deltaY > 0) { lastWheelAt = now; next(); }
  else if (e.deltaY < 0) { lastWheelAt = now; prev(); }
}

// ---- Banner „PDF má okraje" ------------------------------------------------
function showMarginBanner() {
  const banner = document.createElement("div");
  banner.id = "margin-banner";
  const text = document.createElement("span");
  text.textContent =
    "PDF má okraje kolem slajdů — vytvoř ho znovu průvodcem (automatický " +
    "export), nebo v PowerPointu přes Uložit jako → PDF.";
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Zavřít upozornění");
  close.textContent = "✕";
  close.addEventListener("click", () => banner.remove());
  banner.appendChild(text);
  banner.appendChild(close);
  stageEl.appendChild(banner);
}

async function checkPdfMargins() {
  // Poměr stran stránky PDF vs. poměr slidu z configu (default 16:9),
  // tolerance 2 %. Nesedí → PDF vzniklo tiskem (okraje papíru).
  try {
    const page1 = await pdfDoc.getPage(1);
    const vp = page1.getViewport({ scale: 1 });
    const actual = vp.width / vp.height;
    const expected = (config && config.slideAspect) ? config.slideAspect : 16 / 9;
    if (Math.abs(actual - expected) / expected > 0.02) showMarginBanner();
  } catch (e) { /* diagnostika nesmí shodit render */ }
}

// ---- Inicializace ----------------------------------------------------------
export async function initSlides() {
  stageEl = document.getElementById("stage");
  canvasEl = document.getElementById("slide-canvas");
  counterEl = document.getElementById("slide-counter");

  registerTransient(counterEl);

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onResize);
  document.addEventListener("fullscreenchange", onResize);
  window.addEventListener("mousemove", showTransient, { passive: true });

  try {
    config = await loadConfig();
  } catch (e) {
    console.warn("[slides] config.json se nepodařilo načíst:", e.message);
    showSetupMessage();
    return { ok: false, config: null };
  }

  try {
    pdfDoc = await loadPdf(config.pdf);
  } catch (e) {
    console.warn("[slides] PDF se nepodařilo načíst:", e.message);
    showSetupMessage();
    return { ok: false, config };
  }

  pageCount = pdfDoc.numPages;
  // slideCount z configu je informativní; skutečný počet stran bere z PDF.
  if (counterEl) counterEl.hidden = false;

  // Levá kliková zóna (12 %) s jemným chevronem na hover.
  const navZone = document.createElement("div");
  navZone.id = "nav-zone-left";
  const chevron = document.createElement("span");
  chevron.textContent = "‹";
  navZone.appendChild(chevron);
  stageEl.appendChild(navZone);

  stageEl.addEventListener("click", onStageClick);
  stageEl.addEventListener("wheel", onWheel, { passive: true });

  buildVideoOverlays();
  await goTo(1);
  showTransient();
  checkPdfMargins();

  console.log("[slides] připraveno:", pageCount, "stran,",
    (config.videos || []).length, "videí");

  return {
    ok: true,
    config,
    next, prev,
    goTo,
    getState: () => ({ current, pageCount, hasVideo: currentHasVideo() }),
  };
}

// Export čistě geometrické funkce pro testovatelnost (výpočet rámu videa).
export function videoRectFromCanvas(canvasRect, stageRect, frac) {
  return {
    left: (canvasRect.left - stageRect.left) + frac.x * canvasRect.width,
    top: (canvasRect.top - stageRect.top) + frac.y * canvasRect.height,
    width: frac.w * canvasRect.width,
    height: frac.h * canvasRect.height,
  };
}
