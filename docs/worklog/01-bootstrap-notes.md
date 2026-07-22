# Worklog — poznámky k rozhodnutím (01-bootstrap)

Zde jsou zaznamenaná rozhodnutí učiněná při nejasnostech (dle ground rule 6:
*„On any ambiguity: choose a sensible default, note it here, do not stop."*).

## Prostředí (zjištěno na začátku)

- OS: Windows 11 Pro, PowerShell.
- Cesta k repu obsahuje mezery: `…\Projekty pro prezentaci\townhall-titulky` →
  ve všech `.bat` a skriptech se cesty **důsledně uvozovkují**.
- Node `v22.12.0` (pro `node --check`).
- Python `3.13.1`, dostupné jako `py -3` i `python`.
- `ffmpeg` je na PATH (gyan.dev build) → remux MOV→MP4 ve Fázi 2 je k dispozici.
- Git remote `origin` = `https://github.com/amonvo/townhall-titulky.git`, **prázdný**
  (žádné commity) → první push ho naplní. Auth funguje (ls-remote projde).

## Fáze 0

- `.gitignore` obsahuje `/1.md` i obecný vzor `/[0-9]*.md`, dále `content/`,
  `publish/`, `node_modules/`, `.DS_Store`, `Thumbs.db`, `*.log`, `__pycache__/`.
  Navíc přidán `.server.pid` (píše ho `start.bat` ve Fázi 5) — smetí, do gitu nepatří.
- `docs/worklog/01-bootstrap.md` = doslovná kopie `1.md`.
- README je zatím jen kostra (CZ), doplní se ve Fázi 5.
