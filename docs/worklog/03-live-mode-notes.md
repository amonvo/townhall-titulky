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
