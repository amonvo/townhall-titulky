# Prompt 3 — Live PowerPoint capture mode, caption redesign, PDF-mode upgrades

Repository: `townhall-titulky` (you are in its root). **This prompt assumes prompt
2 (wizard + prepare API) is already merged** — integrate with it, don't duplicate.
Three goals, in priority order:

1. **Caption band redesign** — field testing showed finished sentences drop into
   the small faded line while the big line sits empty; long sentences get
   ellipsized. Unacceptable for a wall projection.
2. **New presentation mode: "Živý PowerPoint"** — the app live-mirrors the real
   PowerPoint slideshow window via `getDisplayMedia`, giving 100% fidelity
   (animations, transitions, GIFs, videos with sound, native clicker control).
3. **PDF-mode upgrades** — animated GIF overlay (field-found defect: an animated
   GIF exports as a blank white box in the PDF), click/wheel navigation, PDF
   margin detection.

## Ground rules (as before)

1. FIRST: verify `.gitignore` covers `/[0-9]*.md`, `content/`, `publish/`.
2. No-build static app; zero console errors; `node --check` all `.js`;
   `py -3 tools/prep.py --self-test` exit 0; existing Puppeteer suite stays green.
3. Commit + push per phase, conventional messages. Prompt →
   `docs/worklog/03-live-mode.md`; decisions → `docs/worklog/03-live-mode-notes.md`.
4. Ambiguity → sensible default + worklog note. No CDN at runtime. Quote all paths
   (spaces in repo path).
5. UI preferences (mode choice, caption scale, CZ row visibility) may use
   `localStorage` — this is a localhost app, that's fine.

---

## Phase 1 — Caption band redesign (`app/captions.js` presentation layer)

**Engine logic (recognition, translate waterfall, seq guards, corrections) stays
untouched.** Only the DOM mapping changes.

New model per language (EN, UK — and the optional CZ mini-row keeps current
behavior):

- **Primary line (large):** shows the live interim text while speaking; when a
  sentence finalizes, its translation **stays in the primary line** until the next
  interim/final replaces it. The primary line is never intentionally emptied.
- **History line (small, above primary):** the previous finalized sentence
  (single line, ellipsis allowed here, 50% opacity).

Sequencing: keep the per-language `seq/shownSeq/finalSeq` guards exactly; the only
change is that a final result writes into the primary line (and pushes the
previously shown final into the history line) instead of clearing it.

**Typography & fit (16:9 reference, vh units, `--scale` multiplier unchanged in
mechanism, allowed range 0.7–1.6):**

- Labels: `1.3vh` as now. History: `2.8vh`. Primary: **`5.4vh`**, weight 600,
  `line-height 1.18`, text-shadow as now.
- Primary wraps to **max 2 lines**. Auto-fit: after each text update, if the
  primary element overflows its 2-line box, step the font down
  (`5.4 → 4.8 → 4.3 → 3.9vh`, per language independently) until it fits; reset to
  full size on the next sentence. Implement with a cheap measure
  (`scrollHeight > clientHeight`) — no per-frame loops, only on text change.
  **Never truncate the primary line with ellipsis.**
- Band height: keep `22vh`, tune paddings so two languages with a wrapped primary
  still fit; if both primaries wrap simultaneously, the auto-fit shrink absorbs it.
- CZ mini-row (toggle `C`) sits above EN as now, `2.2vh`.

- Acceptance (Puppeteer): expose a test seam behind `?test=1`
  (`window.__captionsTest = {final(cz, translations), interim(...)}` that drives
  the display layer directly, bypassing mic/network). Assert: after a final, the
  primary line still shows the sentence (not empty); a second final moves the
  first into history; a very long sentence wraps to 2 lines, font-size shrinks,
  computed style has no ellipsis on primary; `+`/`-` still scale; 0 console
  errors.
- Commit `feat: caption band redesign with sticky primary line and auto-fit` +
  push.

## Phase 2 — Presentation mode selection (start panel restructure)

The start panel (and wizard entry from prompt 2) gains a **mode choice** as two
cards above the start buttons:

- **`Živý PowerPoint (doporučeno)`** — subtitle: `Zrcadlí běžící prezentaci —
  animace, videa i přechody. Vyžaduje notebook + projektor (rozšířená plocha).`
- **`PDF režim`** — subtitle: `Promítá připravené PDF. Pro jedinou obrazovku nebo
  jako záloha.`

Selected card highlighted (border `#2F6FEB`); choice persisted in `localStorage`;
default = Živý PowerPoint. The existing buttons (`Spustit prezentaci s titulky`,
`Jen prezentace (bez titulků)`) act on the selected mode. `Nahrát novou
prezentaci` (wizard) shows only when PDF režim is selected — capture mode needs no
content preparation. If PDF mode is selected and content is missing, keep the
current wizard-first behavior.

- Acceptance (Puppeteer): cards render, selection persists across reload,
  wizard button visibility follows the mode, PDF flow unchanged when PDF selected.
- Commit `feat: presentation mode selection` + push.

## Phase 3 — Live PowerPoint capture mode (`app/live.js`)

**Flow when starting in Živý PowerPoint mode:**

1. Pre-capture guidance overlay (same visual language, numbered Czech steps):
   1. `V PowerPointu: karta Prezentace → Nastavit prezentaci → „Procházení
      jednotlivcem (okno)" → OK → Spustit prezentaci od začátku.` (This runs the
      slideshow in a resizable window instead of fullscreen.)
   2. `Klikni níže na „Vybrat okno PowerPointu" a v dialogu Chromu zvol okno s
      prezentací.`
   3. `Prezentaci pak ovládej klikáním / klikátkem PŘÍMO v okně PowerPointu.
      Okno nechej otevřené (klidně za touto aplikací), jen ho neminimalizuj.`
   Button: `Vybrat okno PowerPointu`.
2. On click: `navigator.mediaDevices.getDisplayMedia({ video: { displaySurface:
   "window", frameRate: { ideal: 30 } }, audio: false })`. Leave cursor capture at
   browser default (the presenter may point with the mouse / PowerPoint laser).
3. Render the stream in a `<video autoplay muted playsinline>` filling the stage
   area: `object-fit: contain`, dark stage background, same box-shadow treatment
   as the PDF canvas. Captions band below as always.
4. Status pill addition: `zdroj: PowerPoint` (ok state) while the track is live.

**Edge handling:**

- User cancels the picker → back to guidance overlay, no error spam.
- Track `ended` (user stops sharing / window closed) → overlay: `Sdílení okna
  skončilo.` + buttons `Znovu vybrat okno` / `Zpět na úvod`.
- Permission denied → readable Czech message.
- In capture mode, Arrow/PageUp/PageDown/Space do **not** navigate anything; on
  first such keypress show a 4 s toast: `Prezentaci ovládej v okně PowerPointu.`
  `F`, `+`/`-`, `C`, `Esc` keep working. Slide counter is hidden (unknown page).
- Mic + captions behave identically in both modes.

**README (extend in Phase 5):** capture mode setup incl. `Win+P → Rozšířit`,
moving the Chrome window to the projector, F for fullscreen, and the note that a
minimized PowerPoint window may stop updating (keep it restored, occlusion is
fine).

- Acceptance (Puppeteer, best effort): run Chrome with
  `--auto-select-desktop-capture-source=` (or
  `--use-fake-ui-for-media-stream`) to auto-pick a source; assert the video
  element attaches a live stream and the captions band coexists; simulate track
  stop → assert the re-pick overlay appears. If headless capture proves flaky,
  cover the state machine by injecting a fake MediaStream behind `?test=1` and
  note the substitution in the worklog. UI states must be fully asserted either
  way.
- Commit `feat: live PowerPoint capture mode` + push.

## Phase 4 — PDF-mode upgrades

1. **Animated media overlay (GIF):**
   - `tools/prep.py`: extend extraction — for each slide, `<p:pic>` elements whose
     image relationship targets a `.gif` (case-insensitive) are extracted to
     `content/videos/` (keep the folder; name as-is, lowercase ext) with position
     fractions computed exactly like videos. Config: introduce a unified
     `overlays` array: `{slide, type: "video"|"gif", file, x, y, w, h}` — migrate
     the video entries into it; keep writing the legacy `videos` key too for one
     version (app reads `overlays` if present, else `videos`). Bump a `"version":
     2` field. Extend `--self-test` with a GIF-bearing synthetic slide.
   - App (`slides.js`): render `type: "gif"` overlays as absolutely positioned
     `<img>` over the slide rect (same geometry pipeline as videos). GIFs animate
     natively; no controls, no play badge, not clickable (clicks fall through to
     navigation). Field context: Q1/Q2 slide 5 has one animated GIF whose first
     frame exports as a blank white box in the PDF — the overlay covers exactly
     that spot.
2. **Click & wheel navigation (PDF mode only):**
   - Click on the stage = next slide. Click within the **left 12%** of the stage =
     previous (show a subtle left-chevron affordance on hover of that zone,
     opacity .25).
   - Clicks on video overlays keep toggling play/pause (existing); GIF overlays
     and the counter/pills don't swallow navigation clicks.
   - Mouse wheel: down = next, up = previous, throttled to one step per 300 ms.
   - Keyboard navigation unchanged.
3. **PDF margin detection:** after rendering page 1, compare the PDF page aspect
   ratio to the config slide aspect (default 16:9) with 2% tolerance. On mismatch,
   show a one-time dismissible banner: `PDF má okraje kolem slajdů — vytvoř ho
   znovu průvodcem (automatický export), nebo v PowerPointu přes Uložit jako →
   PDF.` (Cause: printing to PDF adds paper margins; SaveAs/COM export is
   full-bleed.)

- Acceptance (Puppeteer): synthetic config with a GIF overlay → `<img>` positioned
  correctly and repositions on resize; click right/left zones navigate; wheel
  navigates with throttle; margin banner appears for an A4-aspect fixture PDF and
  not for a 16:9 one; existing video overlay tests stay green.
- Commit `feat: gif overlays, click and wheel navigation, margin warning` + push.

## Phase 5 — Docs + full battery

- README: new section `Dva režimy promítání` — comparison table (kdy který),
  capture-mode setup steps, updated controls table (click zones, wheel), extended
  troubleshooting (sdílení skončilo; černý obraz = minimalizované okno; okraje v
  PDF). Update the operator quick-start to lead with Živý PowerPoint for the
  townhall and PDF režim as fallback.
- Run everything: `node --check`, prep self-test, `tools/test-api.py`, full
  Puppeteer suite. `git status` clean, all pushed.
- Commit `docs: dual projection modes guide` + push.

---

## VERIFY (operator — do not execute)

1. **Captions:** start in PDF mode, speak two long sentences → the big line keeps
   the finished sentence, wraps long ones to 2 lines and shrinks instead of
   truncating; previous sentence sits above in the small line. Screenshots:
   mid-sentence + after finish.
2. **Live mode:** PowerPoint slideshow in window mode → `Živý PowerPoint` →
   pick the window → slides mirror with animations; slide 5 GIF animates; slide
   26/27 videos play with sound through the system; clicker advances PowerPoint
   directly. Screenshot of the mirrored stage with captions.
3. **PDF mode:** slide 5 shows the animated GIF overlay (no white box); click
   right/left zones and wheel navigate; slide 27 video still plays.
4. Fullscreen `F` on the projector display in both modes.
