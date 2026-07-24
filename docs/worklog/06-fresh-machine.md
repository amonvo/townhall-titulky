# Prompt 6 — Fresh-machine dead-end fix: always route to the wizard

Repository: `townhall-titulky` (root). Field incident (tester, clean notebook,
exe distribution): with no `content/` present, the stage showed the stale
developer message `Chybí obsah — spusť tools/prep.py, viz README` — a dead end.
Root causes: (1) `slides.js` still renders the Phase-3 developer fallback from
prompt 1; (2) the wizard auto-open in `app.js` runs only once at startup and
only when the persisted mode is `pdf` — a fresh machine defaults to Živý
PowerPoint, so switching to PDF later never triggers it. End users of the exe
have no repo, no tools/, no README — the UI must never reference them.

## Ground rules (as before)

1. FIRST: `.gitignore` covers `/[0-9]*.md`, `content/`, `publish/`.
2. Zero console errors; `node --check`; prep self-test, test-api, all Puppeteer
   suites stay green.
3. Commit + push per phase. Prompt → `docs/worklog/06-fresh-machine.md`;
   decisions → `…-notes.md`. Ambiguity → default + note. Quote all paths.

---

## Phase 1 — User-facing missing-content state (`app/slides.js`)

- Replace the developer fallback message with a proper empty state rendered in
  the stage area: title `Chybí prezentace`, one sentence `Nahraj soubor .pptx a
  aplikace si ji připraví sama.`, primary button **`Nahrát prezentaci`**.
- `slides.js` must not import the wizard directly (keep module boundaries):
  expose a callback hook (e.g. `initSlides({ onRequestUpload })`) that `app.js`
  wires to `wizard.open(...)`. The button calls it.
- If the server has no API (static `serve.ps1` fallback → 501), the empty state
  shows instead: `Prezentace není připravena. Spusť aplikaci přes
  TownhallTitulky.exe nebo start.bat (server s přípravou obsahu).` — still no
  `tools/` paths.
- Audit the whole UI (`grep` app/ for `tools/`, `prep.py`, `README`) — no
  developer-facing paths may remain in user-visible strings. Worklog the hits
  and fixes.

## Phase 2 — Wizard routing that cannot dead-end (`app/app.js`, `app/panel.js`)

Content-missing detection becomes a reusable helper (`refreshContentStatus()`
returning `{hasPdf, hasConfig}` with the 501/offline case handled). Wire it so
the wizard opens whenever **PDF mode is active AND content is missing**, at
every entry point:

1. App startup (existing case — keep).
2. **Mode switch** to the PDF card on the start panel.
3. Clicking `Spustit prezentaci s titulky` / `Jen prezentace` while PDF mode is
   selected and content is missing (instead of hiding the panel into an empty
   stage).
4. After the wizard closes (success or cancel), re-run `refreshContentStatus()`
   and update the panel subtitle (deck name + slide count, or a gentle
   `Prezentace zatím nenahrána` note on the PDF card).

Živý PowerPoint mode stays untouched by content checks. No auto-open loops:
if the user cancels the wizard, don't immediately reopen it on the same panel
view — reopen only on the next explicit action (mode click / start click).

## Phase 3 — Tests: the fresh-machine path

- Puppeteer, new suite `fresh-machine`: server started with an **empty temp
  DATA_ROOT** (no content/). Assert: startup in default (live) mode shows the
  panel, no stale message anywhere; switching to the PDF card opens the wizard;
  canceling returns to the panel with the `nenahráno` note and no reopen loop;
  clicking start in PDF mode opens the wizard again; the stage empty state
  renders with the `Nahrát prezentaci` button and the button opens the wizard;
  `document.body.innerText` contains neither `tools/` nor `prep.py` at any
  point. Existing suites stay green (adjust any that relied on the old
  message).

## Phase 4 — Rebuild + docs

- README: troubleshooting entry for the old message removed/replaced; note the
  new empty-state flow.
- Run the full battery; then `scripts/build-exe.ps1` (fresh `publish/`), smoke
  test green. `git status` clean, all pushed.
- Commit sequence: `fix: user-facing empty state`, `fix: wizard routing on all
  pdf-mode entry points`, `test: fresh-machine suite`, `chore: rebuild exe +
  docs` (or equivalent conventional messages per phase).

---

## VERIFY (operator — do not execute)

1. Copy the NEW exe into an empty folder on a machine (or delete `content/`
   next to it). Run: panel shows; choose PDF režim → wizard opens by itself;
   cancel → panel again, no loop; `Spustit` → wizard again.
2. Upload the deck via the wizard → present.
3. Nowhere in the UI any `tools/…` or `prep.py` text.
