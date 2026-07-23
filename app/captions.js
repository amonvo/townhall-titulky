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

// prev = historie (malý řádek, poslední dokončená věta), curr = primární řádek
// (velký; drží interim i poslední final — nikdy se záměrně nemaže),
// lastFinal = text posledního zobrazeného finalu (posouvá se do historie).
const TARGETS = [
  { code: "en", prev: null, curr: null, lastFinal: null, seq: 0, shownSeq: 0, finalSeq: 0 },
  { code: "uk", prev: null, curr: null, lastFinal: null, seq: 0, shownSeq: 0, finalSeq: 0 },
];

let czCurr = null;          // element pro aktuální český (mini-řádek)
let running = false;
let rec = null;
let wakeLock = null;

// ---- Lifecycle rozpoznávání (pravdivý stav + chytrý restart) ----
let RecognizerClass = null;    // test seam: mock třída místo SpeechRecognition
let lastErrorCode = null;      // poslední ev.error (null = žádná chyba od výsledku)
let lastErrorAt = 0;
let hardStreak = 0;            // po sobě jdoucí tvrdé chyby (network/audio-capture/aborted)
let unproductiveEnds = 0;      // konce bez jediného result eventu od startu
let gotResultSinceStart = false;
let backoffMs = 250;           // 250 → 500 → 1000 → 2000 → 4000 (cap); reset výsledkem
let escalated = false;         // pilulka ukazuje eskalovanou příčinu
let restartTimer = null;
let lastEndWhileHidden = false;

const HARD_ERRORS = new Set(["network", "audio-capture", "aborted"]);

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

// Auto-fit primárního řádku: max 2 řádky, ellipsis zakázán. Po každé změně
// textu se zkusí plná velikost a při přetečení (vlastního 2řádkového boxu,
// NEBO celého pásu #captions) se krokuje dolů. Levné měření scrollHeight —
// běží jen při změně textu / měřítka, žádné per-frame smyčky.
const PRIMARY_SIZES = [5.4, 4.8, 4.3, 3.9]; // vh

// Tolerance měření: line-height 1.18 je menší než přirozená výška Segoe UI,
// takže inkoust glyfů přesahuje line-box a scrollHeight je trvale o ~2-3 px
// nad clientHeight i bez přetečení. Skutečné přetečení o řádek je ≥ ~35 px.
const FIT_EPSILON_PX = 6;

function fitPrimary(t) {
  if (!t.curr) return;
  const band = document.getElementById("captions");
  for (let i = 0; i < PRIMARY_SIZES.length; i++) {
    t.curr.style.fontSize = "calc(" + PRIMARY_SIZES[i] + "vh * var(--scale))";
    const overflowSelf = t.curr.scrollHeight > t.curr.clientHeight + FIT_EPSILON_PX;
    const overflowBand = band && band.scrollHeight > band.clientHeight + FIT_EPSILON_PX;
    if (!overflowSelf && !overflowBand) return;
  }
}

function setPrimaryText(t, text) {
  t.curr.textContent = text;
  fitPrimary(t);
}

// Final: zapíše se do primárního řádku (zůstává tam do další věty);
// předchozí zobrazený final se posune do historie. Guardy seq beze změny.
function applyFinalDisplay(t, s, tr, czText) {
  if (s < t.finalSeq) return;
  t.finalSeq = s;
  const text = (tr !== null && tr !== undefined) ? tr : "· " + czText;
  if (t.lastFinal) t.prev.textContent = t.lastFinal;
  t.lastFinal = text;
  if (t.shownSeq <= s) { setPrimaryText(t, text); t.shownSeq = s; }
}

function applyInterimDisplay(t, s, tr) {
  if (tr === null || tr === undefined) return;
  if (s <= t.shownSeq || s < t.finalSeq) return;
  t.shownSeq = s;
  setPrimaryText(t, tr);
}

function handleFinal(czText) {
  if (czCurr) czCurr.textContent = czText;
  TARGETS.forEach(function (t) {
    const s = ++t.seq;
    translate(czText, t.code).then(function (tr) {
      applyFinalDisplay(t, s, tr, czText);
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
      applyInterimDisplay(t, s, tr);
    });
  });
}

/* ===================== ROZPOZNÁVÁNÍ ŘEČI ===================== */

// Jakýkoli výsledek (interim i final) = mikrofon i server žijí →
// reset počítadel, backoffu i případné eskalace pilulky.
function noteResult() {
  gotResultSinceStart = true;
  lastErrorCode = null;
  hardStreak = 0;
  if (unproductiveEnds || backoffMs !== 250 || escalated) {
    unproductiveEnds = 0;
    backoffMs = 250;
    if (escalated) {
      escalated = false;
      setMic("poslouchám", "ok");
    }
  }
}

function resetLifecycle() {
  lastErrorCode = null;
  hardStreak = 0;
  unproductiveEnds = 0;
  gotResultSinceStart = false;
  backoffMs = 250;
  escalated = false;
  lastEndWhileHidden = false;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
}

// Eskalace: opakovaná tvrdá chyba, nebo ≥3 neproduktivní konce s jinou
// příčinou než tichem (`no-speech` je vždy benigní — normální pauza v řeči).
function shouldEscalate() {
  if (hardStreak >= 2) return true;
  if (lastErrorCode === "no-speech") return false;
  return unproductiveEnds >= 3;
}

function escalationPill() {
  if (lastErrorCode === "network") {
    setMic("síť rozpoznávání nedostupná — zkouším dál", "err");
  } else if (lastErrorCode === "audio-capture") {
    setMic("mikrofon nenalezen / nedává zvuk", "err");
  } else if (lastErrorCode === "aborted") {
    setMic("rozpoznávání přerušováno — okno nesmí být skryté", "warn");
  } else {
    setMic("restartuji… (" + (lastErrorCode || "bez odezvy") + ")", "warn");
  }
}

function doRestart() {
  restartTimer = null;
  if (!running) return;
  gotResultSinceStart = false;
  try {
    rec.start();
  } catch (e) {
    try {
      rec = createRecognizer();
      rec.start();
    } catch (e2) {
      // Nikdy se nevzdávat, dokud running (mimo not-allowed cestu).
      setMic("selhalo — zkouším dál", "err");
      scheduleRestart();
      return;
    }
  }
  console.info("[mic] start");
  // Benigní cyklus: pilulka zůstává „poslouchám" (setMic stejný stav ignoruje).
  if (!escalated) setMic("poslouchám", "ok");
}

function scheduleRestart(immediate) {
  if (restartTimer) clearTimeout(restartTimer);
  if (shouldEscalate()) {
    escalated = true;
    escalationPill();
  }
  const delay = immediate ? 0 : backoffMs;
  backoffMs = Math.min(backoffMs * 2, 4000);
  restartTimer = setTimeout(doRestart, delay);
}

function createRecognizer() {
  const SR = RecognizerClass
    || window.SpeechRecognition || window.webkitSpeechRecognition;
  const r = new SR();
  r.lang = "cs-CZ";
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;

  r.onresult = function (e) {
    noteResult();
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
    lastErrorCode = ev.error || "unknown";
    lastErrorAt = Date.now();
    console.info("[mic] error " + lastErrorCode);
    if (HARD_ERRORS.has(lastErrorCode)) hardStreak++;
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      running = false;
      setMic("přístup zamítnut", "err");
      showPanel("Chrome nedostal přístup k mikrofonu. Povol ho v liště adresy a spusť znovu.");
    }
  };

  r.onend = function () {
    if (!running) { setMic("vypnuto"); return; }
    if (!gotResultSinceStart) unproductiveEnds++;
    gotResultSinceStart = false; // konec uzavírá segment; další začíná čistý
    lastEndWhileHidden = document.visibilityState === "hidden";
    console.info("[mic] end (unproductive=" + unproductiveEnds + ")");
    scheduleRestart();
  };

  return r;
}

/* ===================== WAKE LOCK ===================== */

function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  navigator.wakeLock.request("screen").then(function (wl) { wakeLock = wl; }).catch(function () {});
}
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible" && running) {
    requestWakeLock();
    // Konec nastal na skryté stránce (Chrome pozastavuje rozpoznávání) →
    // po odkrytí restart HNED, bez backoffu, s čistým počítadlem.
    if (lastEndWhileHidden && restartTimer) {
      lastEndWhileHidden = false;
      unproductiveEnds = 0;
      backoffMs = 250;
      clearTimeout(restartTimer);
      restartTimer = null;
      doRestart();
    }
  }
});

/* ===================== STATUS PILLS ===================== */

function applyPillState(pill, state) {
  pill.classList.remove("ok", "warn", "err");
  if (state) pill.classList.add(state);
}

// Stejný text + stav se ignoruje: benigní restarty tak nezpůsobí flicker
// pilulky ani zbytečné probouzení transient UI (změna stavu = objevení pills).
let lastMicText = null, lastMicState = null;
function setMic(text, state) {
  if (!micStateEl) return;
  if (text === lastMicText && state === lastMicState) {
    if (recDotEl) recDotEl.classList.toggle("listening", running && state === "ok");
    return;
  }
  lastMicText = text; lastMicState = state;
  micStateEl.textContent = text;
  applyPillState(micPillEl, state);
  // REC tečka svítí, když posloucháme.
  if (recDotEl) recDotEl.classList.toggle("listening", running && state === "ok");
  showTransient();
}

let lastTrText = null, lastTrState = null;
function setTr(text, state) {
  if (!trStateEl) return;
  if (text === lastTrText && state === lastTrState) return;
  lastTrText = text; lastTrState = state;
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
  scale = Math.max(0.7, Math.min(1.6, Math.round((scale + delta) * 10) / 10));
  document.documentElement.style.setProperty("--scale", String(scale));
  // Změna měřítka mění 2řádkový box → přeměř auto-fit obou jazyků.
  TARGETS.forEach(fitPrimary);
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
  if (!isSpeechSupported() && !RecognizerClass) {
    setMic("nepodporováno (jen Chrome)", "err");
    return false;
  }
  if (running) return true;
  resetLifecycle();
  running = true;
  try {
    rec = createRecognizer();
    rec.start();
    console.info("[mic] start");
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
  resetLifecycle();
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

  // Testovací šev (?test=1): řídí zobrazovací vrstvu přímo, bez mikrofonu
  // a bez sítě — sekvenční guardy jdou stejnou cestou jako ostrý provoz.
  if (/[?&]test=1/.test(location.search)) {
    window.__captionsTest = {
      final: function (cz, translations) {
        if (czCurr) czCurr.textContent = cz;
        TARGETS.forEach(function (t) {
          const s = ++t.seq;
          applyFinalDisplay(t, s, translations ? translations[t.code] : null, cz);
        });
      },
      interim: function (cz, translations) {
        if (czCurr) czCurr.textContent = cz;
        TARGETS.forEach(function (t) {
          const s = ++t.seq;
          applyInterimDisplay(t, s, translations ? translations[t.code] : null);
        });
      },
      // Mock SpeechRecognition třída (nutno nastavit PŘED startCaptions) —
      // testy pak skriptují lifecycle přímo přes handlery instance.
      useMockRecognizer: function (cls) { RecognizerClass = cls || null; },
      getLifecycle: function () {
        return {
          unproductiveEnds: unproductiveEnds,
          backoffMs: backoffMs,
          escalated: escalated,
          lastErrorCode: lastErrorCode,
          hardStreak: hardStreak,
          running: running,
        };
      },
      micPill: function () {
        return {
          text: micStateEl ? micStateEl.textContent : null,
          ok: micPillEl ? micPillEl.classList.contains("ok") : false,
          warn: micPillEl ? micPillEl.classList.contains("warn") : false,
          err: micPillEl ? micPillEl.classList.contains("err") : false,
        };
      },
    };
  }

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
