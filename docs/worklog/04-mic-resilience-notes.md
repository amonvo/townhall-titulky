# Worklog — poznámky k rozhodnutím (04-mic-resilience)

Rozhodnutí při nejasnostech (ground rule 4: sensible default + poznámka, nezastavovat).

## Obecné

- `.gitignore` zkontrolován (`/[0-9]*.md`, `content/`, `publish/`) — beze změny.
- Doslovná kopie promptu → `docs/worklog/04-mic-resilience.md`, commit s Fází 1.
- Překladová/sekvenční logika enginu nedotčena (ground rule 5) — mění se jen
  lifecycle rozpoznávání, stavové pilulky a přibývá diagnostika.

## Fáze 1 — lifecycle rozpoznávání

- Stav: `lastErrorCode`+`lastErrorAt`, `hardStreak` (po sobě jdoucí
  network/audio-capture/aborted), `unproductiveEnds`, `backoffMs`
  (250→500→1000→2000→4000 cap), `escalated`, `lastEndWhileHidden`.
  Jakýkoli výsledek (interim i final, i prázdný) vše resetuje.
- **Sémantika „neproduktivního konce":** konec segmentu, ve kterém nepadl
  žádný result event. Konec segmentu VŽDY uzavírá produktivitu
  (`gotResultSinceStart = false` v onend) — konec segmentu s výsledkem je
  produktivní a nepočítá se, další segment začíná čistý. (Bez toho by rychlé
  sekvence konců počítaly špatně — chyceno testem.)
- **Eskalace:** `hardStreak >= 2` NEBO (`unproductiveEnds >= 3` a poslední
  chyba není `no-speech`). `no-speech` je benigní VŽDY (normální pauzy v řeči
  produkují no-speech + end donekonečna a nesmí nikdy eskalovat, i když
  počítadlo roste — spec to říká explicitně: „Benign cycle (silence):
  no-speech…").
- **Rozhodnutí (default):** eskalace bez jakéhokoli error kódu (přesně polní
  incident — konce bez chyb) → text `restartuji… (bez odezvy)` (spec dává
  vzor `restartuji… (<code>)`, ale kód není žádný).
- **Žádný flicker:** `setMic`/`setTr` ignorují nastavení stejného textu+stavu
  → benigní restart pilulku nezmění (zůstává „poslouchám"/ok) a hlavně
  nevyvolá `showTransient()` — stejná hodnota není „změna stavu", takže pills
  správně mizí po 4 s i při tichu s restarty. (Vedlejší zisk: opakované
  „Google"/ok od překladače už také neprobouzí pills každou větou.)
- Backoff: delay se bere PŘED zdvojením (první restart 250 ms). Restart při
  selhání `rec.start()` → recreate; když selže i to → `selhalo — zkouším dál`
  (err) a plánuje se další pokus — nikdy se nevzdává, dokud `running`
  (mimo not-allowed cestu, ta `running` shodí).
- `visibilitychange` → visible: pokud poslední konec nastal na skryté stránce
  a čeká restart, provede se HNED (bez backoffu) s vynulovaným počítadlem.
- Forensika: `console.info` s prefixem `[mic]` — `start`, `end
  (unproductive=N)`, `error <code>`. Jeden řádek na událost.
- Test seam rozšířen: `useMockRecognizer(cls)` (nutno před `start()`),
  `getLifecycle()`, `micPill()`.
- **Ověření (Puppeteer + mock SR): 14/14 asercí OK, 0 chyb v konzoli** —
  poslouchám bez flickeru při tichu (3×), růst backoffu 500→1000→2000, reset
  výsledkem, eskalace po 3 neproduktivních koncích („bez odezvy"), network/
  audio-capture/aborted hlášky, stop → vypnuto + čistá počítadla, [mic] logy.

## Fáze 2 — diagnostika mikrofonu (app/micdiag.js)

- ~8 s self-test: getUserMedia (label zařízení) + WebAudio AnalyserNode level
  meter (peak z time-domain dat, ~15×/s, práh „mrtvého" vstupu 0.02) souběžně
  se sondou SpeechRecognition (cs-CZ, interim; ticho ji ukončuje → onend ji
  drží při životě po dobu měření).
- Verdikty dle spec (ok/err), plus **rozhodnutí (default):** úroveň OK + žádné
  výsledky + žádné network chyby → také síťový verdikt (nejpravděpodobnější
  příčina; surový řádek ukáže skutečné kódy pro vzdálenou podporu). Surová
  data: `zařízení · max úroveň · SR: N výsledků · chyby: …`.
- Meter běží i po verdiktu až do zavření (operátor vidí živou úroveň);
  `finalize()` si před verdiktem vezme poslední vzorek (determinismus).
- „Zavřít": interval/timeout pryč, sonda stop, tracky stop, AudioContext
  close. Titulky běžící před otevřením se zastaví a po zavření obnoví
  (`wasRunning`), aby se sonda a ostrý engine nepraly o rozpoznávání.
- Tlačítko `Diagnostika mikrofonu` (ghost) na panelu v obou režimech i obou
  stavech (idle/running) — pod hlavními tlačítky.
- Test seam `?test=1`: `__micDiagTest.useMockRecognizer/setLevel/forceDeny/
  finish/state`. Poučka z testu: fake audio device Chromu generuje tón, takže
  fake level pro „mrtvý vstup" verdikt je nutné nastavit PŘED open().
- **Ověření (Puppeteer, fake-device flags): 16/16 asercí OK, 0 chyb v konzoli**
  — tlačítko, otevření (meter+verdikt), zastavení titulků během testu, label
  fake zařízení, všechny 4 verdikty, surová data, cleanup bez živých tracků,
  obnova titulků a návrat panelu.

## Fáze 3 — guidance + docs

- Guidance Živého PowerPointu: přidán žlutý varovný odstavec o viditelnosti
  okna aplikace (minimalizace/úplné překrytí → Chrome pozastaví rozpoznávání).
- README: totéž varování v setup sekci capture režimu; troubleshooting vede
  novým postupem „Titulky se pořád restartují" (1. diagnostika, 2. viditelnost
  okna, 3. síť/VPN) + tabulka všech stavů pilulky „mikrofon" s významy.
- **Závěrečná baterie (vše exit 0):** `node --check` 8 modulů · prep
  self-test 19/19 · test-api 21/21 · Puppeteer: panel 14/14, wizard 12/12,
  captions 16/16, modes 11/11, live 14/14, pdfmode 14/14, miclife 14/14,
  micdiag 16/16. Izolované porty; operátorův server a content/ nedotčeny.
