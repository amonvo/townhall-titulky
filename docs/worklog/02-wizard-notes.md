# Worklog — poznámky k rozhodnutím (02-wizard)

Rozhodnutí při nejasnostech (ground rule 5: sensible default + poznámka, nezastavovat).

## Obecné

- Prompt 2 nemá „Phase 0" — doslovná kopie promptu (`docs/worklog/02-wizard.md`)
  a tento soubor poznámek se commitují s Fází 1.
- `.gitignore` zkontrolován: `/[0-9]*.md`, `content/`, `publish/` ignorovány — beze změny.

## Fáze 1 — prep.py

- `SameFileError` fix: guard `os.path.exists(src) and os.path.exists(dst) and
  os.path.samefile(src, dst)` → kopie se tiše přeskočí. `samefile` se volá jen
  když obě cesty existují (na Windows by na neexistující cestě padal OSError).
- Refaktor: jádro pipeline přesunuto do `prepare_content(pptx_path, pdf_path,
  out_dir, allow_remux, progress_cb)` — vrací summary dict
  `{deckName, slideCount, videos, warnings}` (přesně data z config.json).
  Kroky `progress_cb`: `analyze → videos → pdf → config → done`; pořadí je
  exportované jako konstanta `PROGRESS_STEPS` (použije ji server API i testy).
- **Rozhodnutí (default):** krok `pdf` se přes `progress_cb` hlásí i když
  `pdf_path=None` (sekvence kroků je stabilní pro UI wizardu; jen se nic
  nekopíruje). Self-test asertuje plnou sekvenci.
- `build_content` zůstává jako zpětně kompatibilní obálka se stejným návratovým
  tvarem `{config, warnings, config_path}` a stejným CLI výstupem — chování CLI
  beze změny (ověřeno self-testem, který přes `build_content` dál běží).
- Self-test rozšířen: same-file PDF (nespadne + obsah souboru nezničen),
  `prepare_content` s nahrávacím `progress_cb` (asertuje sekvenci kroků
  i tvar summary). **12/12 asercí OK, exit 0.**
