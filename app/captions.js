// app/captions.js — titulkovací engine.
//
// Jádro (rozpoznávání řeči, překladová kaskáda, sekvenční ochrana pořadí, opravy
// přehmatů, wake lock a auto-restart) je PŘEVZATO z ověřeného prototypu (APPENDIX A
// v docs/worklog/01-bootstrap.md) — logika se nemění. Nová je pouze prezentační
// vrstva: dva jazykové řádky (EN, UK) v pásu #captions a status pills.

import { registerTransient, showTransient } from "./slides.js";

/* ===================== KONFIGURACE ===================== */

// Záložní překladač LibreTranslate. Prázdné = nepoužívá se.
// Např. po `pip install libretranslate` a spuštění: "http://localhost:5000".
let LIBRE_URL = "";

// Jak často (ms) překládat rozpracovanou (interim) větu.
const INTERIM_THROTTLE_MS = 1200;

// Po sérii chyb zkoušej hlavní (Google) endpoint jen 1× za tento interval.
const GOOGLE_COOLDOWN_MS = 15000;

// Opravy častých přehmatů rozpoznávače. Každý pár je [co_hledat, čím_nahradit].
// Nahrazuje se na hranicích slov (Unicode) PŘED zobrazením i překladem.
// Příklad — přidání opravy:  ["ejč ár", "HR"],  ["kví ej", "QA"]
const CORRECTIONS = [
  // ["ejč ár", "HR"],
];

const CORRECTIONS_COMPILED = CORRECTIONS.map(function (pair) {
  const esc = pair[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    re: new RegExp("(?<![\\p{L}\\p{N}])" + esc + "(?![\\p{L}\\p{N}])", "giu"),
    to: pair[1],
  };
});

function applyCorrections(text) {
  for (let i = 0; i < CORRECTIONS_COMPILED.length; i++) {
    text = text.replace(CORRECTIONS_COMPILED[i].re, CORRECTIONS_COMPILED[i].to);
  }
  return text;
}

/* ===================== STAV ===================== */

const TARGETS = [
  { code: "en", prev: null, curr: null, seq: 0, shownSeq: 0, finalSeq: 0 },
  { code: "uk", prev: null, curr: null, seq: 0, shownSeq: 0, finalSeq: 0 },
];

let czCurr = null;          // element pro aktuální český (mini-řádek)
let running = false;
let rec = null;
let wakeLock = null;

let googleFails = 0;
let lastGoogleTry = 0;
let lastInterimAt = 0;

let onMicDenied = null;     // callback (Fáze 5 napojí start panel)

// DOM status pills
let micStateEl, trStateEl, micPillEl, trPillEl, recDotEl, pillsEl;

/* ===================== PŘEKLAD (kaskáda) ===================== */

function translateGoogle(text, tl) {
  const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=cs&tl="
    + tl + "&dt=t&q=" + encodeURIComponent(text);
  return fetch(url).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }).then(function (data) {
    if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("bad payload");
    const out = data[0].map(function (seg) { return seg && seg[0] ? seg[0] : ""; }).join("").trim();
    if (!out) throw new Error("empty");
    return out;
  });
}

function translateLibre(text, tl) {
  if (!LIBRE_URL) return Promise.reject(new Error("no fallback configured"));
  return fetch(LIBRE_URL.replace(/\/+$/, "") + "/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: text, source: "cs", target: tl, format: "text" }),
  }).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }).then(function (d) {
    const out = (d.translatedText || "").trim();
    if (!out) throw new Error("empty");
    return out;
  });
}

/* Vrací Promise<string|null>. null = překlad selhal úplně. */
function translate(text, tl) {
  const now = Date.now();
  const tryGoogle = googleFails < 5 || (now - lastGoogleTry) > GOOGLE_COOLDOWN_MS;
  if (tryGoogle) {
    lastGoogleTry = now;
    return translateGoogle(text, tl).then(function (t) {
      googleFails = 0; setTr("Google", "ok"); return t;
    }).catch(function () {
      googleFails++;
      return translateLibre(text, tl).then(function (t) {
        setTr("záložní (LibreTranslate)", "warn"); return t;
      }).catch(function () {
        setTr("nedostupný – zobrazuji češtinu", "err"); return null;
      });
    });
  }
  return translateLibre(text, tl).then(function (t) {
    setTr("záložní (LibreTranslate)", "warn"); return t;
  }).catch(function () {
    setTr("nedostupný – zobrazuji češtinu", "err"); return null;
  });
}

/* ===================== ZOBRAZENÍ (sekvenční ochrana pořadí) ===================== */

function handleFinal(czText) {
  if (czCurr) czCurr.textContent = czText;
  TARGETS.forEach(function (t) {
    const s = ++t.seq;
    translate(czText, t.code).then(function (tr) {
      if (s < t.finalSeq) return;
      t.finalSeq = s;
      t.prev.textContent = (tr !== null) ? tr : "· " + czText;
      if (t.shownSeq <= s) { t.curr.textContent = ""; t.shownSeq = s; }
    });
  });
}

function handleInterim(czText) {
  if (czCurr) czCurr.textContent = czText;
  const now = Date.now();
  if (now - lastInterimAt < INTERIM_THROTTLE_MS) return;
  lastInterimAt = now;
  TARGETS.forEach(function (t) {
    const s = ++t.seq;
    translate(czText, t.code).then(function (tr) {
      if (tr === null) return;
      if (s <= t.shownSeq || s < t.finalSeq) return;
      t.shownSeq = s;
      t.curr.textContent = tr;
    });
  });
}

/* ===================== ROZPOZNÁVÁNÍ ŘEČI ===================== */

function createRecognizer() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const r = new SR();
  r.lang = "cs-CZ";
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;

  r.onresult = function (e) {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) {
        const txt = applyCorrections(res[0].transcript.trim());
        if (txt) handleFinal(txt);
      } else {
        interim += res[0].transcript;
      }
    }
    interim = applyCorrections(interim.trim());
    if (interim) handleInterim(interim);
  };

  r.onerror = function (ev) {
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      running = false;
      setMic("přístup zamítnut", "err");
      showPanel("Chrome nedostal přístup k mikrofonu. Povol ho v liště adresy a spusť znovu.");
    }
  };

  r.onend = function () {
    if (!running) { setMic("vypnuto"); return; }
    setMic("restart…", "warn");
    setTimeout(function () {
      if (!running) return;
      try { rec.start(); setMic("poslouchám", "ok"); }
      catch (e) {
        try { rec = createRecognizer(); rec.start(); setMic("poslouchám", "ok"); }
        catch (e2) { setMic("selhalo", "err"); }
      }
    }, 250);
  };

  return r;
}

/* ===================== WAKE LOCK ===================== */

function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  navigator.wakeLock.request("screen").then(function (wl) { wakeLock = wl; }).catch(function () {});
}
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible" && running) requestWakeLock();
});

/* ===================== STATUS PILLS ===================== */

function applyPillState(pill, state) {
  pill.classList.remove("ok", "warn", "err");
  if (state) pill.classList.add(state);
}

function setMic(text, state) {
  if (!micStateEl) return;
  micStateEl.textContent = text;
  applyPillState(micPillEl, state);
  // REC tečka svítí, když posloucháme.
  if (recDotEl) recDotEl.classList.toggle("listening", running && state === "ok");
  showTransient();
}

function setTr(text, state) {
  if (!trStateEl) return;
  trStateEl.textContent = text;
  applyPillState(trPillEl, state);
  showTransient();
}

function showPanel(message) {
  if (typeof onMicDenied === "function") onMicDenied(message);
  else console.warn("[captions] " + message);
}

/* ===================== DOM SESTAVENÍ ===================== */

function buildCaptionUI() {
  const band = document.getElementById("captions");

  // Český mini-řádek (skrytý, přepíná se 'C')
  const czRow = document.createElement("div");
  czRow.id = "cap-cz";
  czRow.className = "cap-cz hidden";
  czCurr = document.createElement("div");
  czCurr.className = "cap-cz-text";
  czRow.appendChild(czCurr);

  function makeRow(id, labelText, curColorClass) {
    const row = document.createElement("div");
    row.id = id;
    row.className = "cap-row";
    const label = document.createElement("div");
    label.className = "cap-label";
    label.textContent = labelText;
    const prev = document.createElement("div");
    prev.className = "cap-prev";
    const curr = document.createElement("div");
    curr.className = "cap-curr " + curColorClass;
    row.appendChild(label);
    row.appendChild(prev);
    row.appendChild(curr);
    return { row, prev, curr };
  }

  const en = makeRow("cap-en", "ENGLISH", "cap-en-color");
  const uk = makeRow("cap-uk", "УКРАЇНСЬКА", "cap-uk-color");

  TARGETS[0].prev = en.prev; TARGETS[0].curr = en.curr;
  TARGETS[1].prev = uk.prev; TARGETS[1].curr = uk.curr;

  band.appendChild(czRow);
  band.appendChild(en.row);
  band.appendChild(uk.row);

  // Status pills (fixed vpravo nahoře)
  pillsEl = document.createElement("div");
  pillsEl.id = "status-pills";

  micPillEl = document.createElement("div");
  micPillEl.className = "pill";
  recDotEl = document.createElement("span");
  recDotEl.className = "rec-dot";
  const micLabel = document.createElement("span");
  micLabel.textContent = "mikrofon: ";
  micStateEl = document.createElement("span");
  micStateEl.textContent = "vypnuto";
  micPillEl.appendChild(recDotEl);
  micPillEl.appendChild(micLabel);
  micPillEl.appendChild(micStateEl);

  trPillEl = document.createElement("div");
  trPillEl.className = "pill";
  const trLabel = document.createElement("span");
  trLabel.textContent = "překlad: ";
  trStateEl = document.createElement("span");
  trStateEl.textContent = "—";
  trPillEl.appendChild(trLabel);
  trPillEl.appendChild(trStateEl);

  pillsEl.appendChild(micPillEl);
  pillsEl.appendChild(trPillEl);
  document.body.appendChild(pillsEl);

  registerTransient(pillsEl);
}

/* ===================== MĚŘÍTKO PÍSMA A ČESKÝ ŘÁDEK ===================== */

let scale = 1;
function adjustScale(delta) {
  scale = Math.max(0.7, Math.min(1.5, Math.round((scale + delta) * 10) / 10));
  document.documentElement.style.setProperty("--scale", String(scale));
}

let czVisible = false;
function setCzechRowVisible(v) {
  czVisible = (v === undefined) ? !czVisible : !!v;
  const row = document.getElementById("cap-cz");
  if (row) row.classList.toggle("hidden", !czVisible);
}

function onKeyDown(e) {
  if (e.key === "+" || e.key === "=") { e.preventDefault(); adjustScale(+0.1); }
  else if (e.key === "-" || e.key === "_") { e.preventDefault(); adjustScale(-0.1); }
  else if (e.key === "c" || e.key === "C") { e.preventDefault(); setCzechRowVisible(); }
}

/* ===================== VEŘEJNÉ API ===================== */

export function isSpeechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function startCaptions() {
  if (!isSpeechSupported()) {
    setMic("nepodporováno (jen Chrome)", "err");
    return false;
  }
  if (running) return true;
  running = true;
  try {
    rec = createRecognizer();
    rec.start();
    setMic("poslouchám", "ok");
  } catch (e) {
    running = false;
    setMic("selhalo", "err");
    return false;
  }
  requestWakeLock();
  return true;
}

export function stopCaptions() {
  running = false;
  if (recDotEl) recDotEl.classList.remove("listening");
  try { if (rec) rec.stop(); } catch (e) {}
  setMic("vypnuto");
  if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
}

export function isRunning() { return running; }

export function setLibreUrl(url) { LIBRE_URL = url || ""; }

export function initCaptions(opts) {
  opts = opts || {};
  onMicDenied = opts.onMicDenied || null;
  buildCaptionUI();
  document.documentElement.style.setProperty("--scale", "1");
  window.addEventListener("keydown", onKeyDown);
  setMic("vypnuto");
  setTr("—");
  return {
    start: startCaptions,
    stop: stopCaptions,
    isRunning,
    isSupported: isSpeechSupported(),
    setCzechRowVisible,
    adjustScale,
    setLibreUrl,
  };
}
