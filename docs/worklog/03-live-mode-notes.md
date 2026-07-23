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

## Fáze 4 — PDF upgrady

- prep.py: xfrm čtení vytaženo do `_pic_fractions()` (sdílí video i GIF větev).
  GIF detekce: `<p:pic>` BEZ `<a:videoFile>`, jehož `<a:blip r:embed|r:link>`
  vede přes `/image` relationship na `*.gif` (case-insensitive). Pozor na
  postery videí: pic s videoFile se přeskakuje, takže GIF poster videa se
  nespáruje omylem dvakrát. GIF scan běží i na slidech bez videí (původní
  early-continue by ho přeskočil — opraveno restrukturalizací smyčky).
- Config **v2**: `{version: 2, slideAspect, overlays: [{slide, type, file,
  x,y,w,h}], videos: [legacy]}`. `slideAspect` (z sldSz) přidán nad rámec spec
  — spec chce porovnávat „config slide aspect (default 16:9)" a prep tu
  hodnotu zná přesně; app čte `config.slideAspect || 16/9`.
- slides.js: jednotný overlay pipeline (`overlaysBySlide`, `kind: video|gif`);
  čte `overlays`, jinak mapuje legacy `videos`. GIF = `<img>` v `.gif-wrap`
  s `pointer-events: none` (kliky propadají navigaci), bez ovládání; šířka/
  výška 100 % rámu (roztažení přesně na autorovaný obdélník). Mezerník bere
  první VIDEO overlay (`firstActiveVideo`), ne libovolný overlay.
- Klik/kolečko: jen PDF režim (`pdfDoc && !body.live-active`). Klik na stage =
  další; levá zóna 12 % = zpět (chevron ‹, hover opacity .25, z-index pod
  video overlayem); kliky z `.video-wrap` navigaci nekradou (closest check).
  Kolečko: throttle 1 krok/300 ms — **rozhodnutí:** ignorovaný krok v okně
  throttlu časovač NEresetuje (rychlé škrtnutí kolečkem = 1 krok, ne zámek).
- Banner okrajů: po prvním renderu poměr stran stránky 1 vs. `slideAspect`
  (tolerance 2 %) → dismissible banner (✕). Jednorázový = jednou za načtení
  stránky (bez localStorage — po opravě PDF zmizí sám, jinak má připomínat).
- **Ověření (Puppeteer): 14/14 asercí OK, 0 chyb v konzoli** — GIF overlay
  geometrie (tolerance 2 px) + reposition po resize + pointer-events none,
  klik vpravo/levá zóna, kolečko s throttlem, žádný banner u 16:9 fixture,
  banner u A4 fixture + zavření. Self-test prep.py rozšířen na **19/19**
  (config v2, gif extrakce, slideAspect, legacy klíč).

## Fáze 5 — docs + baterie

- README: sekce „Dva režimy promítání" (srovnávací tabulka + setup Živého
  PowerPointu vč. Win+P → Rozšířit, přesun Chromu na projektor, F,
  neminimalizovat okno), quick-start vede Živým PowerPointem, příprava obsahu
  označena jako PDF-only. Tabulka ovládání doplněna o klik zóny a kolečko
  se sloupcem režimů; troubleshooting: sdílení skončilo, černý obraz
  (minimalizace), okraje v PDF.
- **Regrese chycená baterií:** starší suity (panel, wizard) předpokládaly PDF
  chování, ale nový default režim je „live" — panel suite padala na navigaci
  (guidance overlay blokuje šipky) a wizard se bez PDF režimu auto-neotvírá.
  Suity dostaly preset `localStorage townhall.mode=pdf` (testují PDF flow;
  live flow má vlastní suite). Aplikační chování je záměrné, ne chyba.
- **Závěrečná baterie (vše exit 0):** `node --check` 7 modulů ·
  prep self-test **19/19** · test-api **21/21** · Puppeteer: panel 14/14,
  wizard 12/12, captions 16/16, modes 11/11, live 14/14, pdfmode 14/14.
  Testy opět na izolovaném portu 8153; operátorův server na 8137 nedotčen
  (pozn.: po git pull je potřeba `stop.bat` + `start.bat`, jinak poběží
  kód bez live režimu — je v README).
