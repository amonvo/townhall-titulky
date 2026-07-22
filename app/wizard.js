// app/wizard.js — průvodce nahráním prezentace (.pptx → PDF + videa + config).
//
// Operátor přetáhne .pptx do drop zóny (nebo klikne a vybere soubor), aplikace
// ho nahraje na lokální server (POST /api/prepare), sleduje průběh přípravy
// (GET /api/prepare/status) a skončí souhrnem, nebo — když automatický převod
// do PDF selže (chybí PowerPoint) — návodem na ruční export.
//
// Vstupní body: 1) chybějící obsah při startu (řeší app.js přes
// /api/content/status), 2) tlačítko „Nahrát novou prezentaci" na start panelu.

// Klávesy aplikace se při otevřeném wizardu blokují (stejný capture přístup
// jako start panel), aby prezentace „neujížděla" pod overlayem.
const APP_KEYS = new Set([
  "ArrowRight", "ArrowDown", "PageDown",
  "ArrowLeft", "ArrowUp", "PageUp",
  "Home", "End", " ", "Spacebar",
  "f", "F", "+", "=", "-", "_", "c", "C",
]);

const STEP_ROWS = [
  ["upload", "Nahrávání souboru"],
  ["analyze", "Analýza prezentace"],
  ["videos", "Extrakce videí"],
  ["pdf", "Převod do PDF (u velkých prezentací může trvat i minutu)"],
  ["config", "Příprava konfigurace"],
  ["done", "Hotovo"],
];

let overlayEl, bodyEl;
let screen = "closed";   // closed|confirm|drop|progress|done|manual|error
let onClose = null;
let pollTimer = null;
let lastSummary = null;
let uploadRowEl = null;  // pro % v řádku Nahrávání
let rowEls = {};

/* ---------- české plurály ---------- */

function plural(n, one, few, many) {
  if (n === 1) return n + " " + one;
  if (n >= 2 && n <= 4) return n + " " + few;
  return n + " " + many;
}

function videoSummaryText(videos) {
  if (!videos || !videos.length) return "";
  const slides = videos.map((v) => v.slide).sort((a, b) => a - b);
  const range = (slides.length === 1)
    ? "slajd " + slides[0]
    : "slajdy " + slides[0] + "–" + slides[slides.length - 1];
  return plural(videos.length, "video", "videa", "videí") + " (" + range + ")";
}

/* ---------- sestavení DOM ---------- */

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

function buildWizard() {
  overlayEl = el("div", "hidden");
  overlayEl.id = "wizard-overlay";
  const box = el("div", "wizard-box");
  box.appendChild(el("h1", "panel-title", "Nahrání prezentace"));
  bodyEl = el("div", "wizard-body");
  box.appendChild(bodyEl);
  overlayEl.appendChild(box);
  document.body.appendChild(overlayEl);
}

/* ---------- obrazovky ---------- */

function setScreen(name, build) {
  screen = name;
  bodyEl.textContent = "";
  build(bodyEl);
}

function showConfirm(deckName) {
  setScreen("confirm", (root) => {
    root.appendChild(el("p", "wizard-text",
      "Nahradí aktuální prezentaci „" + (deckName || "bez názvu") + "“. Pokračovat?"));
    const btns = el("div", "panel-buttons");
    btns.appendChild(makeButton("Pokračovat", "primary", () => showDrop()));
    btns.appendChild(makeButton("Zpět", "ghost", () => close()));
    root.appendChild(btns);
  });
}

function showDrop() {
  setScreen("drop", (root) => {
    const zone = el("div", "drop-zone");
    zone.appendChild(el("div", "drop-icon", "📊"));
    zone.appendChild(el("div", "drop-main", "Přetáhni sem prezentaci (.pptx)"));
    zone.appendChild(el("div", "drop-sub", "nebo klikni pro výběr souboru"));
    const err = el("div", "drop-err", "");
    zone.appendChild(err);

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pptx";
    input.style.display = "none";
    input.addEventListener("change", () => {
      if (input.files && input.files[0]) acceptFile(input.files[0], err);
    });

    zone.addEventListener("click", () => input.click());
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("drag");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drag");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) acceptFile(f, err);
    });

    root.appendChild(zone);
    root.appendChild(input);
    root.appendChild(el("div", "wizard-hint", "Esc — zavřít"));
  });
}

function acceptFile(file, errEl) {
  if (!/\.pptx$/i.test(file.name)) {
    errEl.textContent = "Tohle není .pptx — vyber prosím soubor prezentace PowerPointu.";
    return;
  }
  startUpload(file);
}

function showProgress() {
  setScreen("progress", (root) => {
    const list = el("ul", "wizard-steps");
    rowEls = {};
    STEP_ROWS.forEach(([id, label]) => {
      const li = el("li", "step-row pending");
      const ico = el("span", "step-ico", "○");
      const lab = el("span", "step-label", label);
      li.appendChild(ico);
      li.appendChild(lab);
      list.appendChild(li);
      rowEls[id] = { li, ico, lab, label };
      if (id === "upload") uploadRowEl = rowEls[id];
    });
    root.appendChild(list);
  });
}

function setRowState(id, state) {
  const row = rowEls[id];
  if (!row) return;
  row.li.className = "step-row " + state;
  if (state === "running") {
    row.ico.textContent = "";
    row.ico.appendChild(el("span", "spinner"));
  } else if (state === "done") {
    row.ico.textContent = "✓";
  } else if (state === "failed" || state === "manual") {
    row.ico.textContent = "✕";
  } else {
    row.ico.textContent = "○";
  }
}

function updateRows(currentStep) {
  const idx = STEP_ROWS.findIndex(([id]) => id === currentStep);
  STEP_ROWS.forEach(([id], i) => {
    if (i < idx) setRowState(id, "done");
    else if (i === idx) setRowState(id, "running");
    else setRowState(id, "pending");
  });
}

function summaryLine(summary, contentStatus) {
  const deck = (summary && summary.deckName)
    || (contentStatus && contentStatus.deckName) || "Prezentace";
  const count = (summary && summary.slideCount)
    || (contentStatus && contentStatus.slideCount) || 0;
  let line = plural(count, "slajd", "slajdy", "slajdů");
  const vids = videoSummaryText(summary && summary.videos);
  if (vids) line += " · " + vids;
  return { deck, line };
}

function showDone(contentStatus) {
  setScreen("done", (root) => {
    const card = el("div", "wizard-summary");
    const s = summaryLine(lastSummary, contentStatus);
    card.appendChild(el("div", "wizard-summary-deck", s.deck));
    card.appendChild(el("div", "wizard-summary-info", s.line));
    root.appendChild(card);
    const btns = el("div", "panel-buttons");
    btns.appendChild(makeButton("Pokračovat", "primary", () => location.reload()));
    root.appendChild(btns);
  });
}

function showManual(message) {
  setScreen("manual", (root) => {
    root.appendChild(el("p", "wizard-manual",
      message || "Automatický převod do PDF se nepodařil."));
    const steps = el("p", "wizard-text");
    steps.innerHTML =
      "Videa i konfigurace jsou připravené. Zbývá jen PDF:<br>" +
      "V PowerPointu: <strong>Soubor → Uložit jako → typ PDF</strong> → ulož jako " +
      "<code>content\\slides.pdf</code>";
    root.appendChild(steps);
    const note = el("div", "drop-err", "");
    root.appendChild(note);
    const btns = el("div", "panel-buttons");
    btns.appendChild(makeButton("Zkontrolovat znovu", "primary", async () => {
      note.textContent = "";
      try {
        const r = await fetch("api/content/status", { cache: "no-store" });
        const cs = await r.json();
        if (r.ok && cs.hasPdf) showDone(cs);
        else note.textContent = "PDF zatím nenalezeno — ulož ho jako content\\slides.pdf.";
      } catch (e) {
        note.textContent = "Server neodpovídá — běží start.bat?";
      }
    }));
    root.appendChild(btns);
  });
}

function showError(message) {
  setScreen("error", (root) => {
    root.appendChild(el("p", "wizard-error",
      message || "Něco se pokazilo."));
    const btns = el("div", "panel-buttons");
    btns.appendChild(makeButton("Zkusit znovu", "primary", () => showDrop()));
    root.appendChild(btns);
  });
}

/* ---------- upload + polling ---------- */

function startUpload(file) {
  showProgress();
  setRowState("upload", "running");

  const fd = new FormData();
  fd.append("pptx", file, file.name);

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "api/prepare");
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable && uploadRowEl) {
      const pct = Math.round((e.loaded / e.total) * 100);
      uploadRowEl.lab.textContent = uploadRowEl.label + " — " + pct + " %";
    }
  };
  xhr.onload = () => {
    if (xhr.status === 202) {
      if (uploadRowEl) uploadRowEl.lab.textContent = uploadRowEl.label;
      updateRows("analyze");
      startPolling();
    } else {
      let msg = "Server vrátil chybu " + xhr.status + ".";
      try {
        const d = JSON.parse(xhr.responseText);
        if (d && d.error) msg = d.error;
      } catch (e) { /* ne-JSON odpověď */ }
      showError(msg);
    }
  };
  xhr.onerror = () => showError("Spojení se serverem selhalo — běží start.bat?");
  xhr.send(fd);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    let st;
    try {
      const r = await fetch("api/prepare/status", { cache: "no-store" });
      st = await r.json();
    } catch (e) {
      return; // přechodný výpadek — poll pokračuje
    }
    if (st.state === "running") {
      if (st.step && st.step !== "upload") updateRows(st.step);
    } else if (st.state === "done") {
      stopPolling();
      lastSummary = st.summary || null;
      STEP_ROWS.forEach(([id]) => setRowState(id, "done"));
      showDone();
    } else if (st.state === "needs_manual_pdf") {
      stopPolling();
      lastSummary = st.summary || null;
      showManual(st.message);
    } else if (st.state === "error") {
      stopPolling();
      showError(st.message);
    }
    // idle: job ještě nenaběhl — čekáme dál
  }, 500);
}

/* ---------- otevření / zavření / klávesy ---------- */

async function open(options) {
  options = options || {};
  lastSummary = null;
  overlayEl.classList.remove("hidden");

  if (options.skipConfirm) {
    showDrop();
    return;
  }
  // Zjisti, jestli by upload něco přepsal (jméno decku pro potvrzení).
  let cs = null;
  try {
    const r = await fetch("api/content/status", { cache: "no-store" });
    if (r.status === 501) {
      const d = await r.json();
      showError(d.error || "Server nepodporuje přípravu.");
      return;
    }
    if (r.ok) cs = await r.json();
  } catch (e) { /* server bez API — pokračuj na drop */ }

  if (cs && (cs.hasPdf || cs.hasConfig)) showConfirm(cs.deckName);
  else showDrop();
}

function close() {
  stopPolling();
  overlayEl.classList.add("hidden");
  screen = "closed";
  if (typeof onClose === "function") onClose();
}

function onKeyCapture(e) {
  if (screen === "closed") return;
  if (e.key === "Escape") {
    e.preventDefault();
    // stopImmediatePropagation: close() ukazuje start panel a JEHO capture
    // listener (stejný uzel window) by jinak tentýž Esc zpracoval taky
    // a panel hned zase schoval.
    e.stopImmediatePropagation();
    // Zavřít jde jen z drop zóny / potvrzení — ne uprostřed uploadu/jobu.
    if (screen === "drop" || screen === "confirm") close();
    return;
  }
  if (APP_KEYS.has(e.key)) e.stopPropagation();
}

/* ---------- veřejné API ---------- */

export function initWizard(opts) {
  opts = opts || {};
  onClose = opts.onClose || null;
  buildWizard();
  window.addEventListener("keydown", onKeyCapture, true);
  return {
    open,
    close,
    isOpen: () => screen !== "closed",
    getScreen: () => screen,
  };
}
