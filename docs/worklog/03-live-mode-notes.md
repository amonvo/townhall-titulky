# Worklog — poznámky k rozhodnutím (03-live-mode)

Rozhodnutí při nejasnostech (ground rule 4: sensible default + poznámka, nezastavovat).

## Obecné

- `.gitignore` zkontrolován (`/[0-9]*.md`, `content/`, `publish/`) — beze změny.
- Doslovná kopie promptu → `docs/worklog/03-live-mode.md`, commituje se s Fází 1.

## Fáze 1 — redesign titulkovacího pásu

- Engine (rozpoznávání, překladová kaskáda, seq guardy, korekce) beze změny.
  Zobrazovací logika vytažena do `applyFinalDisplay` / `applyInterimDisplay` —
  handleFinal/handleInterim je volají z `.then()` překladu, testovací šev přímo.
- Final nyní: primární řádek drží text věty (nikdy se záměrně nemaže),
  předchozí zobrazený final (`t.lastFinal`) se posouvá do historie. Guardy
  `seq/shownSeq/finalSeq` zachovány přesně — final nepřepíše novější interim
  (jen aktualizuje historii + lastFinal).
- **Auto-fit a měření (nalezená past):** `line-height: 1.18` je menší než
  přirozená výška Segoe UI, takže inkoust glyfů přesahuje line-box a
  `scrollHeight` je trvale o ~2–3 px nad `clientHeight` i bez přetečení.
  S tolerancí +1 px auto-fit vždy spadl na floor 3.9vh. Řešení: tolerance
  `FIT_EPSILON_PX = 6` (skutečné přetečení o řádek je ≥ ~35 px i na floor
  velikosti při scale 0.7).
- **Rozhodnutí (default):** auto-fit kromě vlastního 2řádkového boxu měří i
  přetečení celého pásu `#captions` — pokrývá případ „oba jazyky zalomené
  najednou" (jedno zalomené primary + druhé na 1 řádek se do 22vh při 5.4vh
  nevejde ani teoreticky; spec říká „auto-fit shrink absorbs it"). Zmenšuje se
  jazyk, jehož text se právě změnil.
- **Rozhodnutí (default):** „reset to full size on the next sentence" —
  implementováno jako reset při KAŽDÉ změně textu (i interim update): smyčka
  začíná vždy na 5.4vh a krokuje dolů. Měření je synchronní před paintem,
  žádné bliknutí; sémanticky totéž a jednodušší.
- Škála `--scale` rozšířena na 0.7–1.6; změna měřítka přeměří auto-fit obou
  jazyků. Historie 2.8vh (ellipsis povolen), primary 5.4vh / lh 1.18 /
  max-height 2.4em / overflow hidden bez ellipsis.
- Testovací šev `?test=1`: `window.__captionsTest.final(cz, {en, uk})` a
  `.interim(...)` řídí zobrazovací vrstvu přímo (bez mikrofonu a sítě), ale
  stejnou cestou guardů jako ostrý provoz.
- **Ověření (Puppeteer, reálný Chrome): 16/16 asercí OK, 0 chyb v konzoli** —
  sticky final, posun do historie, interim přepis, zalomení na 2 řádky +
  zmenšení + žádný ellipsis + nic neuříznuto, reset velikosti další větou,
  `+`/`-` klamp 0.7–1.6. Pozn.: test musí nejdřív zavřít start panel (ten
  klávesy `+`/`-` blokuje capture handlerem — správné chování).

## Fáze 2 — výběr režimu

- Režim v `localStorage` klíč `townhall.mode` (`"live"` | `"pdf"`), default
  `live`; čtení/zápis v try/catch (private mode). Export `getMode()`/`setMode()`
  z panel.js — používá je i app.js (gating wizardu) a Fáze 3 (live.js).
- Karty jsou `<button>` (přístupnost) nad tlačítky panelu; výběr = border
  #2F6FEB + jemný glow.
- **Rozhodnutí (default):** varování „Chybí obsah" na panelu se ukazuje jen
  v PDF režimu — v živém zrcadlení žádný připravený obsah není potřeba, warning
  by mátl. Stejně tak auto-otevření wizardu při chybějícím obsahu (app.js) je
  gatované na PDF režim (spec: „If PDF mode is selected and content is missing,
  keep the current wizard-first behavior" — a contrario live nic neotvírá).
- Tlačítko „Nahrát novou prezentaci" jen při vybraném PDF režimu (dle spec).
- **Ověření (Puppeteer): 11/11 asercí OK** — výchozí live, výběr klikem,
  persistence přes reload, viditelnost wizard tlačítka podle režimu, PDF flow
  beze změny, live+chybějící obsah → žádný wizard ani warning,
  pdf+chybějící obsah → wizard-first.

## Fáze 3 — Živý PowerPoint (app/live.js)

- Stavový stroj: `guidance` (3 kroky + „Vybrat okno PowerPointu") → `active`
  (stream na stage) → `ended` („Sdílení okna skončilo." + Znovu vybrat /
  Zpět na úvod). Zavření pickeru (NotAllowedError s „dismissed") → tiše zpět
  na návod; jiné odmítnutí → česká hláška o povolení sdílení.
- Zobrazení řeší `body.live-active`: video (object-fit contain, box-shadow
  jako canvas) se ukáže, PDF canvas + counter + video/gif overlaye se schovají
  `display:none !important`. Video je `muted` — zvuk jde ze systému
  (PowerPoint sám), zachytává se jen obraz (`audio: false`).
- Pilulka `zdroj: PowerPoint` (ok) se přidává do #status-pills od captions a
  registruje do transient idle-hide mechanismu; mimo aktivní stream je
  `display:none`.
- Navigační klávesy (šipky, PageUp/Down, mezerník, Home/End) se v aktivním
  režimu pohltí capture handlerem → toast „Prezentaci ovládej v okně
  PowerPointu." (4 s, opakovaný stisk restartuje časovač). `F`, `+/-`, `C`,
  `Esc` propadají dál. **Rozhodnutí (default):** Home/End blokovány také
  (jsou to navigační klávesy, spec je nevyjmenovává explicitně).
- Esc: z guidance/ended overlaye = zpět na úvod (stopImmediatePropagation —
  stejná past jako u wizardu); z aktivního zrcadlení propadá na panel
  (mikrofon i stream běží dál, „Pokračovat" se vrátí).
- **Substituce v testech (dle explicitního povolení spec):** reálný
  getDisplayMedia picker nejde v headless deterministicky řídit
  (`--auto-select-desktop-capture-source` je nespolehlivé pro okna), stavový
  stroj se testuje fake MediaStreamem z `canvas.captureStream()` za `?test=1`
  (`__liveTest.attachFake/endTracks`; ended se dispatchuje ručně —
  programový `track.stop()` událost `ended` lokálně nevyvolá). Reálný picker
  flow ověří operátor (VERIFY).
- **Ověření (Puppeteer): 14/14 asercí OK, 0 chyb v konzoli** — guidance
  obrazovka + texty, Esc zpět, připojení streamu (video+srcObject, skrytý
  canvas/counter, pilulka ok), blokace navigace + toast, `+` funguje,
  ended overlay + tlačítka, návrat na panel.
