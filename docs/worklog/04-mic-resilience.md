# Prompt 4 — Resilient mic engine + built-in microphone diagnostics

Repository: `townhall-titulky` (root). Field incident: the mic pill loops
`poslouchám → restart…` endlessly and the operator has no way to see why. Root
cause of the *blindness*: `onerror` only handles `not-allowed`; every other error
(`network`, `audio-capture`, `no-speech`, `aborted`) is swallowed and the `onend`
auto-restart spins silently. Likely field causes: the Chrome window being
covered/backgrounded during Živý PowerPoint testing (Chrome suspends recognition
for hidden pages), or a network/VPN blocking Google's speech servers. This prompt
makes the engine tell the truth, restart intelligently, and gives the operator a
one-click diagnosis.

## Ground rules (as before)

1. FIRST: `.gitignore` covers `/[0-9]*.md`, `content/`, `publish/`.
2. Zero console errors; `node --check` all JS; prep self-test + test-api +
   existing Puppeteer suites stay green.
3. Commit + push per phase, conventional messages. Prompt →
   `docs/worklog/04-mic-resilience.md`; decisions → `…-notes.md`.
4. Ambiguity → sensible default + worklog note. No CDN. Quote all paths.
5. Engine translation/sequencing logic stays untouched — this prompt touches only
   the recognition lifecycle, status surfacing, and adds a diagnostics module.

---

## Phase 1 — Recognition lifecycle overhaul (`app/captions.js`)

**Track what actually happens:**

- In `onerror`, always record `ev.error` into `lastErrorCode` (plus timestamp).
  Keep the existing `not-allowed`/`service-not-allowed` panel path.
- Count `unproductiveEnds`: an end with **no result events** since the preceding
  start. Any result (interim or final) resets the counter and the backoff.
- Log a single console.info line per lifecycle event with a `[mic]` prefix
  (`start`, `end (unproductive=N)`, `error <code>`) — cheap forensics for remote
  debugging, no spam beyond that.

**Restart policy:**

- Benign cycle (silence): `no-speech` or an end with `unproductiveEnds < 3` and
  no hard error → restart with short delay and **keep the pill showing
  `poslouchám` (ok)** — no more `restart…` flicker during normal pauses.
- Escalation: `unproductiveEnds >= 3` or a repeated hard error → pill switches to
  a **specific Czech cause** and stays in retry:
  - `network` → `síť rozpoznávání nedostupná — zkouším dál` (err)
  - `audio-capture` → `mikrofon nenalezen / nedává zvuk` (err)
  - `aborted` repeatedly → `rozpoznávání přerušováno — okno nesmí být skryté`
    (warn)
  - otherwise → `restartuji… (<code>)` (warn)
- Exponential backoff between restarts: 250 → 500 → 1000 → 2000 → 4000 ms cap;
  reset on any result. Never give up while `running` (except the not-allowed
  path).
- Visibility: on `visibilitychange` → `visible`, if `running` and the last end
  happened while hidden, restart immediately (bypass backoff) and reset the
  counter.
- `stopCaptions()` resets counters/backoff so a fresh start is clean.

- Acceptance (Puppeteer): extend the `?test=1` seam — allow injecting a **mock
  SpeechRecognition class** (e.g. `window.__captionsTest.useMockRecognizer(cls)`
  wired before `startCaptions`) so tests can script lifecycles. Assert: benign
  silence cycle keeps `poslouchám` (no flicker to `restart…`); three unproductive
  ends → escalated pill text; scripted `network` errors → the network message;
  backoff delays grow (spy on setTimeout or timestamps with tolerance); a result
  resets escalation back to `poslouchám`. 0 console errors.
- Commit `fix: resilient recognition lifecycle with honest status` + push.

## Phase 2 — Microphone diagnostics (`app/micdiag.js` + panel button)

Start panel gains a ghost button **`Diagnostika mikrofonu`** (visible in both
modes, below the main buttons). Clicking opens an overlay (same visual language)
that runs an ~8 s self-test:

1. `getUserMedia({ audio: true })` → show the **device label** in use.
2. Live level meter: WebAudio `AnalyserNode`, a horizontal bar updating ~15×/s,
   plus a running `max level` readout. Instruction line: `Mluv normálně nahlas…`
3. In parallel, a `SpeechRecognition` probe (cs-CZ, interim on) collecting
   result/error events for the same window.
4. **Verdict** (large, color-coded, plain Czech):
   - level OK + results → `✔ Vše funguje — mikrofon i rozpoznávání.` (ok)
   - level OK + no results + network errors → `Zvuk jde, ale rozpoznávání se
     nedostane na server — zkontroluj síť/VPN/firewall.` (err)
   - flat level → `Do Chromu nejde žádný zvuk — zkontroluj vstupní zařízení ve
     Windows (Nastavení → Systém → Zvuk → Vstup).` (err)
   - permission denied → existing wording for mic access. (err)
   - Below the verdict, small mono text with raw data: device label, max level,
     SR events/error codes — for remote debugging screenshots.
5. `Zavřít` stops all tracks and the probe cleanly (no lingering capture).
   Running the diagnostic while captions are running: stop captions first,
   restore them after closing (remember state), so the probe and the live engine
   never fight over recognition.

- Acceptance (Puppeteer): overlay renders with meter + verdict area; behind
  `?test=1` allow injecting fake analyser levels and a mock recognizer to drive
  all four verdicts; assert verdict texts and cleanup (no active tracks after
  close; captions restored if they were running). Chrome launch may use
  `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` for the
  real-getUserMedia path where practical.
- Commit `feat: one-click microphone diagnostics` + push.

## Phase 3 — Guidance & docs

- Live-mode guidance (app/live.js) gets an added step/warning line: `Okno této
  aplikace nech viditelné (na projektoru). Nesmí být minimalizované ani úplně
  překryté — Chrome by pozastavil rozpoznávání řeči.` Same note into README
  (capture-mode section + troubleshooting: `titulky se pořád restartují` →
  diagnostika button, window visibility, network/VPN).
- README troubleshooting: add the new pill messages and what each means.
- Run the full battery; `git status` clean; push.
- Commit `docs: mic troubleshooting and visibility guidance` + push.

---

## VERIFY (operator)

1. Restart server, hard refresh. Start panel → `Diagnostika mikrofonu` → speak →
   screenshot the verdict.
2. If verdict is OK: start captions in PDF mode, speak with long pauses — pill
   stays `poslouchám` during silence (no restart flicker); captions work.
3. Živý PowerPoint on one screen: windows side-by-side (not overlapping) —
   captions keep running while clicking in PowerPoint.
