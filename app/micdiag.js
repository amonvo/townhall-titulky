// app/micdiag.js — diagnostika mikrofonu na jedno kliknutí (~8 s self-test).
//
// Souběžně: (1) getUserMedia + WebAudio level meter (jde do Chromu zvuk?),
// (2) sonda SpeechRecognition (dostane se rozpoznávání na server?).
// Verdikt velkým písmem v češtině + surová data pro screenshot vzdálené podpory.
//
// Během diagnostiky se běžící titulky zastaví a po zavření zase obnoví —
// sonda a ostrý engine se nikdy nesmí prát o rozpoznávání.

import { isRunning, startCaptions, stopCaptions } from "./captions.js";

const DIAG_MS = 8000;          // délka měření
const METER_INTERVAL_MS = 66;  // ~15×/s
const FLAT_LEVEL = 0.02;       // pod tímto maximem je vstup „mrtvý"

let overlayEl, deviceEl, barEl, maxEl, verdictEl, rawEl;
let onClose = null;

let MockRec = null;      // test seam: mock třída pro sondu
let fakeLevel = null;    // test seam: vynucená úroveň místo analyseru
let denyOverride = false;

let openFlag = false;
let wasRunning = false;
let denied = false;
let finished = false;
let stream = null;
let audioCtx = null;
let analyser = null;
let analyserBuf = null;
let meterTimer = null;
let finishTimer = null;
let probe = null;
let probeResults = 0;
let probeErrors = [];
let maxLevel = 0;
let deviceLabel = "—";

/* ---------- DOM ---------- */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function buildOverlay() {
  overlayEl = el("div", "hidden");
  overlayEl.id = "micdiag-overlay";
  const box = el("div", "wizard-box");
  box.appendChild(el("h1", "panel-title", "Diagnostika mikrofonu"));

  deviceEl = el("div", "diag-device", "zařízení: —");
  box.appendChild(deviceEl);

  box.appendChild(el("p", "diag-instruction", "Mluv normálně nahlas…"));

  const meter = el("div", "diag-meter");
  barEl = el("div", "diag-meter-bar");
  meter.appendChild(barEl);
  box.appendChild(meter);

  maxEl = el("div", "diag-max", "max úroveň: 0.00");
  box.appendChild(maxEl);

  verdictEl = el("div", "diag-verdict", "Měřím (~8 s)…");
  box.appendChild(verdictEl);

  rawEl = el("div", "diag-raw", "");
  box.appendChild(rawEl);

  const btns = el("div", "panel-buttons");
  const closeBtn = el("button", "panel-btn ghost", "Zavřít");
  closeBtn.type = "button";
  closeBtn.addEventListener("click", close);
  btns.appendChild(closeBtn);
  box.appendChild(btns);

  overlayEl.appendChild(box);
  document.body.appendChild(overlayEl);
}

/* ---------- měření úrovně ---------- */

function currentLevel() {
  if (fakeLevel !== null) return fakeLevel;
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(analyserBuf);
  let peak = 0;
  for (let i = 0; i < analyserBuf.length; i++) {
    const d = Math.abs(analyserBuf[i] - 128) / 128;
    if (d > peak) peak = d;
  }
  return peak;
}

function sampleLevel() {
  const level = currentLevel();
  if (level > maxLevel) maxLevel = level;
  barEl.style.width = Math.min(100, Math.round(level * 100)) + "%";
  barEl.classList.toggle("hot", level > 0.6);
  maxEl.textContent = "max úroveň: " + maxLevel.toFixed(2);
}

/* ---------- sonda rozpoznávání ---------- */

function startProbe() {
  const SR = MockRec || window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    probeErrors.push("SpeechRecognition nedostupné");
    return;
  }
  probe = new SR();
  probe.lang = "cs-CZ";
  probe.continuous = true;
  probe.interimResults = true;
  probe.onresult = function () { probeResults++; };
  probe.onerror = function (ev) { probeErrors.push(ev.error || "unknown"); };
  probe.onend = function () {
    // během měření drž sondu naživu (ticho ji ukončuje)
    if (openFlag && !finished) {
      try { probe.start(); } catch (e) { /* další end to zkusí znovu */ }
    }
  };
  try { probe.start(); } catch (e) { probeErrors.push("start selhal"); }
}

function stopProbe() {
  if (!probe) return;
  const p = probe;
  probe = null;
  try { p.onend = null; p.stop(); } catch (e) { /* už neběží */ }
}

/* ---------- verdikt ---------- */

function setVerdict(text, cls) {
  verdictEl.textContent = text;
  verdictEl.className = "diag-verdict " + cls;
}

function finalize() {
  if (finished) return;
  // Poslední vzorek úrovně (ať verdikt nezávisí na tikání intervalu).
  if (openFlag && !denied && (analyser || fakeLevel !== null)) sampleLevel();
  finished = true;
  if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
  stopProbe();

  if (denied) {
    setVerdict("Chrome nedostal přístup k mikrofonu. Povol ho v liště adresy a spusť znovu.", "err");
  } else if (maxLevel < FLAT_LEVEL) {
    setVerdict("Do Chromu nejde žádný zvuk — zkontroluj vstupní zařízení ve Windows " +
      "(Nastavení → Systém → Zvuk → Vstup).", "err");
  } else if (probeResults > 0) {
    setVerdict("✔ Vše funguje — mikrofon i rozpoznávání.", "ok");
  } else {
    // zvuk jde, ale žádný výsledek — typicky síť/VPN/firewall na speech serveru
    setVerdict("Zvuk jde, ale rozpoznávání se nedostane na server — " +
      "zkontroluj síť/VPN/firewall.", "err");
  }

  const errs = probeErrors.length ? probeErrors.join(", ") : "žádné";
  rawEl.textContent = "zařízení: " + deviceLabel
    + " · max úroveň: " + maxLevel.toFixed(2)
    + " · SR: " + probeResults + " výsledků · chyby: " + errs;
}

/* ---------- otevření / zavření ---------- */

async function acquire() {
  if (denyOverride) {
    denied = true;
    finalize();
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    denied = true;
    finalize();
    return;
  }
  const track = stream.getAudioTracks()[0];
  deviceLabel = (track && track.label) || "neznámé zařízení";
  deviceEl.textContent = "zařízení: " + deviceLabel;

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyserBuf = new Uint8Array(analyser.fftSize);
    source.connect(analyser);
  } catch (e) { /* meter pojede jen z fakeLevel; verdikt řeší flat větev */ }

  meterTimer = setInterval(sampleLevel, METER_INTERVAL_MS);
  startProbe();
  finishTimer = setTimeout(finalize, DIAG_MS);
}

function open() {
  if (openFlag) return;
  openFlag = true;
  // Ostrý engine a sonda se nesmí prát o rozpoznávání.
  wasRunning = isRunning();
  if (wasRunning) stopCaptions();

  denied = false;
  finished = false;
  probeResults = 0;
  probeErrors = [];
  maxLevel = 0;
  deviceLabel = "—";
  deviceEl.textContent = "zařízení: —";
  barEl.style.width = "0%";
  maxEl.textContent = "max úroveň: 0.00";
  setVerdict("Měřím (~8 s)…", "");
  rawEl.textContent = "";

  overlayEl.classList.remove("hidden");
  acquire();
}

function close() {
  if (!openFlag) return;
  openFlag = false;
  finished = true;
  if (meterTimer) { clearInterval(meterTimer); meterTimer = null; }
  if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
  stopProbe();
  if (stream) {
    stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
    stream = null;
  }
  if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
  analyser = null;
  overlayEl.classList.add("hidden");
  // Titulky běžely → obnov je.
  if (wasRunning) { startCaptions(); wasRunning = false; }
  if (typeof onClose === "function") onClose();
}

/* ---------- veřejné API ---------- */

export function initMicDiag(opts) {
  opts = opts || {};
  onClose = opts.onClose || null;
  buildOverlay();

  if (/[?&]test=1/.test(location.search)) {
    window.__micDiagTest = {
      useMockRecognizer: function (cls) { MockRec = cls || null; },
      setLevel: function (v) { fakeLevel = (v === null || v === undefined) ? null : v; },
      forceDeny: function (v) { denyOverride = !!v; },
      finish: function () { finalize(); },
      state: function () {
        return {
          open: openFlag,
          denied: denied,
          finished: finished,
          maxLevel: maxLevel,
          probeResults: probeResults,
          probeErrors: probeErrors.slice(),
          verdict: verdictEl.textContent,
          verdictClass: verdictEl.className,
          raw: rawEl.textContent,
          tracksLive: stream
            ? stream.getTracks().filter((t) => t.readyState === "live").length
            : 0,
        };
      },
    };
  }

  return { open, close, isOpen: () => openFlag };
}
