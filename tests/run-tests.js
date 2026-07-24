// Puppeteer suity: fresh-machine, static-501, pdfmode sanity.
// Servery: 8151 = prázdný DATA_ROOT (čistý stroj), 8152 = připravený obsah.
// Izolované porty (8151/8152) — operátorův server na 8137 zůstává nedotčen,
// stejně jako reálný content/ (testy jedou přes TOWNHALL_DATA_ROOT fixtures).
//
// Spuštění:  cd tests && py make_fixture.py && npm i puppeteer-core --no-save
//            && node run-tests.js
"use strict";

const { spawn, execSync } = require("child_process");
const http = require("http");
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME_PATH
  || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const REPO = path.resolve(__dirname, "..");
const SCRATCH = __dirname;

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log("  ok  " + label); }
  else { failed++; console.log("  FAIL " + label); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitPort(port, timeoutMs = 15000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function probe() {
      const req = http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
        res.resume(); resolve();
      });
      req.on("error", () => {
        if (Date.now() - t0 > timeoutMs) reject(new Error("port " + port + " nenaběhl"));
        else setTimeout(probe, 250);
      });
    })();
  });
}

function startServer(port, dataRoot) {
  const child = spawn("py", [path.join(REPO, "tools", "serve.py"), String(port)], {
    cwd: REPO,
    env: Object.assign({}, process.env, { TOWNHALL_DATA_ROOT: dataRoot }),
    stdio: "ignore",
  });
  return child;
}

function killServer(child) {
  try { execSync("taskkill /PID " + child.pid + " /T /F", { stdio: "ignore" }); }
  catch (e) { /* už neběží */ }
}

async function newPage(browser, { mode, intercept501 } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // 404/501 na chybějící obsah/API jsou očekávané síťové logy čistého stroje.
    if (/Failed to load resource.*(404|501)/.test(text)) return;
    errors.push("console: " + text);
  });
  if (mode) {
    await page.evaluateOnNewDocument((m) => {
      localStorage.setItem("townhall.mode", m);
    }, mode);
  }
  if (intercept501) {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.url().includes("/api/")) {
        req.respond({
          status: 501,
          contentType: "application/json; charset=utf-8",
          body: JSON.stringify({ error: "API není k dispozici (statický server)." }),
        });
      } else {
        req.continue();
      }
    });
  }
  return { page, errors };
}

async function load(page, port) {
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load" });
  await page.waitForFunction(() => window.__townhall, { timeout: 15000 });
}

const bodyText = (page) => page.evaluate(() => document.body.innerText);
const panelVisible = (page) => page.evaluate(() =>
  !document.getElementById("panel-overlay").classList.contains("hidden"));
const wizardOpen = (page) => page.evaluate(() => window.__townhall.wizard.isOpen());
const wizardScreen = (page) => page.evaluate(() => window.__townhall.wizard.getScreen());

async function assertNoDevStrings(page, label) {
  const text = await bodyText(page);
  assert(!text.includes("tools/") && !text.includes("prep.py"),
    label + ": žádné tools/ ani prep.py v textu stránky");
}

function clickPanelButton(page, label) {
  return page.evaluate((l) => {
    const btn = [...document.querySelectorAll("#panel-overlay .panel-btn")]
      .find((b) => b.textContent === l);
    if (!btn) throw new Error("tlačítko nenalezeno: " + l);
    btn.click();
  }, label);
}

async function suiteFreshMachine(browser, port) {
  console.log("\n== fresh-machine (prázdný DATA_ROOT, default live) ==");
  const { page, errors } = await newPage(browser);
  await load(page, port);
  await sleep(700); // prostor pro případný (nežádoucí) auto-open

  assert(await panelVisible(page), "startup: panel viditelný");
  assert(!(await wizardOpen(page)), "startup (live): wizard se neotvírá");
  const text = await bodyText(page);
  assert(!text.includes("Chybí obsah"), "startup: stará hláška nikde");
  await assertNoDevStrings(page, "startup");

  // 2) přepnutí na PDF kartu → wizard
  await page.click('.mode-card[data-mode="pdf"]');
  await sleep(200);
  assert(await wizardOpen(page), "klik na PDF kartu: wizard se otevřel");
  assert((await wizardScreen(page)) === "drop", "wizard: rovnou drop zóna");
  await assertNoDevStrings(page, "wizard");

  // 3) zrušení → panel s poznámkou, žádná reopen smyčka
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    !document.getElementById("panel-overlay").classList.contains("hidden"));
  await sleep(700);
  assert(!(await wizardOpen(page)), "po zrušení: wizard zůstává zavřený (bez smyčky)");
  const note = await page.evaluate(() => {
    const n = document.querySelector('.mode-card[data-mode="pdf"] .mode-card-note');
    return n && !n.classList.contains("hidden") ? n.textContent : null;
  });
  assert(note === "Prezentace zatím nenahrána", "PDF karta: poznámka „nenahrána“");

  // 4) start s titulky → wizard znovu, mikrofon se nespouští
  await clickPanelButton(page, "Spustit prezentaci s titulky");
  await sleep(200);
  assert(await wizardOpen(page), "start s titulky: wizard se otevřel");
  assert(!(await page.evaluate(() => window.__townhall.captions.isRunning())),
    "start s titulky: mikrofon neběží");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    !document.getElementById("panel-overlay").classList.contains("hidden"));

  // 5) jen prezentace → wizard znovu
  await clickPanelButton(page, "Jen prezentace (bez titulků)");
  await sleep(200);
  assert(await wizardOpen(page), "jen prezentace: wizard se otevřel");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    !document.getElementById("panel-overlay").classList.contains("hidden"));

  // 6) prázdný stav scény + tlačítko
  await page.keyboard.press("Escape"); // zavřít panel
  await sleep(150);
  const empty = await page.evaluate(() => {
    const box = document.getElementById("empty-state");
    if (!box) return null;
    const title = box.querySelector(".empty-title");
    const btn = document.getElementById("empty-upload-btn");
    return {
      title: title && title.textContent,
      btn: btn && btn.textContent,
      visible: box.offsetParent !== null || box.offsetWidth > 0,
    };
  });
  assert(!!empty, "scéna: #empty-state existuje");
  assert(empty && empty.title === "Chybí prezentace", "empty state: titulek");
  assert(empty && empty.btn === "Nahrát prezentaci", "empty state: tlačítko");
  await page.click("#empty-upload-btn");
  await sleep(200);
  assert(await wizardOpen(page), "tlačítko Nahrát prezentaci: wizard se otevřel");
  await assertNoDevStrings(page, "závěr");

  assert(errors.length === 0, "0 chyb v konzoli" +
    (errors.length ? " (" + errors.join(" | ") + ")" : ""));
  await page.close();
}

async function suiteStatic501(browser, port) {
  console.log("\n== static-501 (API vrací 501, mode=pdf) ==");
  const { page, errors } = await newPage(browser, { mode: "pdf", intercept501: true });
  await load(page, port);
  await sleep(700);

  assert(await panelVisible(page), "startup: panel viditelný");
  assert(!(await wizardOpen(page)), "bez API: wizard se NEotvírá");
  await assertNoDevStrings(page, "startup");

  const empty = await page.evaluate(() => {
    const box = document.getElementById("empty-state");
    if (!box) return null;
    return {
      text: box.querySelector(".empty-text").textContent,
      hasBtn: !!document.getElementById("empty-upload-btn"),
    };
  });
  assert(!!empty, "scéna: #empty-state existuje");
  assert(empty && empty.text.includes("TownhallTitulky.exe")
    && empty.text.includes("start.bat"), "empty state: varianta bez API (exe/start.bat)");
  assert(empty && !empty.hasBtn, "empty state bez API: žádné tlačítko nahrání");

  // start bez API → žádný wizard, panel se schová do prázdného stavu scény
  await clickPanelButton(page, "Jen prezentace (bez titulků)");
  await sleep(300);
  assert(!(await wizardOpen(page)), "start bez API: wizard se neotvírá");
  assert(!(await panelVisible(page)), "start bez API: panel skryt (scéna s hláškou)");

  assert(errors.length === 0, "0 chyb v konzoli" +
    (errors.length ? " (" + errors.join(" | ") + ")" : ""));
  await page.close();
}

async function suitePdfMode(browser, port) {
  console.log("\n== pdfmode sanity (připravený obsah, mode=pdf) ==");
  const { page, errors } = await newPage(browser, { mode: "pdf" });
  await load(page, port);
  await page.waitForFunction(() =>
    window.__townhall.slides && window.__townhall.slides.ok, { timeout: 15000 });
  await sleep(500);

  assert(await panelVisible(page), "startup: panel viditelný");
  assert(!(await wizardOpen(page)), "obsah přítomen: wizard se neotvírá");
  const st = await page.evaluate(() => window.__townhall.slides.getState());
  assert(st.pageCount === 2, "PDF načteno: 2 strany");
  const sub = await page.evaluate(() =>
    document.querySelector(".panel-sub").textContent);
  assert(sub.includes("Test Deck") && sub.includes("2 slajdy"),
    "podtitulek: deck + počet slajdů (" + sub + ")");
  const noteHidden = await page.evaluate(() => {
    const n = document.querySelector('.mode-card[data-mode="pdf"] .mode-card-note');
    return !n || n.classList.contains("hidden");
  });
  assert(noteHidden, "poznámka „nenahrána“ se s obsahem neukazuje");
  assert(!(await page.evaluate(() => !!document.getElementById("empty-state"))),
    "žádný empty state");

  // navigace po zavření panelu
  await page.keyboard.press("Escape");
  await sleep(150);
  await page.keyboard.press("ArrowRight");
  await sleep(400);
  let counter = await page.evaluate(() =>
    document.getElementById("slide-counter").textContent);
  assert(counter === "2 / 2", "ArrowRight → 2 / 2 (" + counter + ")");
  await page.keyboard.press("ArrowLeft");
  await sleep(400);
  counter = await page.evaluate(() =>
    document.getElementById("slide-counter").textContent);
  assert(counter === "1 / 2", "ArrowLeft → 1 / 2 (" + counter + ")");

  // Esc panel znovu otevře
  await page.keyboard.press("Escape");
  await sleep(150);
  assert(await panelVisible(page), "Esc: panel se znovu otevřel");
  await assertNoDevStrings(page, "závěr");

  assert(errors.length === 0, "0 chyb v konzoli" +
    (errors.length ? " (" + errors.join(" | ") + ")" : ""));
  await page.close();
}

(async () => {
  const freshRoot = path.join(SCRATCH, "data-fresh");
  const preparedRoot = path.join(SCRATCH, "data-prepared");

  const s1 = startServer(8151, freshRoot);
  const s2 = startServer(8152, preparedRoot);
  let browser;
  try {
    await waitPort(8151);
    await waitPort(8152);
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: "new",
      args: ["--no-first-run", "--disable-features=Translate"],
    });
    await suiteFreshMachine(browser, 8151);
    await suiteStatic501(browser, 8151);
    await suitePdfMode(browser, 8152);
  } finally {
    if (browser) await browser.close().catch(() => {});
    killServer(s1);
    killServer(s2);
  }
  console.log("\nCELKEM: " + passed + " ok, " + failed + " fail");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("RUNNER ERROR:", e); process.exit(2); });
