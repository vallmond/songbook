# AGENTS.md

## Project Overview
- Project: frontend-only guitar songbook.
- Sources: `amdm/`, `pesnipodgitaru/`, and `mychords/` (raw source files).
- Generated artifacts: `public/library.json`, `public/songs/**/*.cho`, `public/chords/index.json`, chord SVG cache in `public/chords/svg/`.
- Main parser: `song-parser.mjs`.
- Main UI renderer: `app.js`.

## Canonical Workflow
1. Put/update raw files in `amdm/`, `pesnipodgitaru/`, or `mychords/`.
2. Run `node scripts/sync-raw.mjs`.
3. Reload frontend and verify target songs.

## Import Helpers
- Import PesniPodGitaru pages:
  - `node scripts/import-pesnipodgitaru.mjs <url1> <url2> ...`
- Script writes source HTML into `pesnipodgitaru/`.
- Import MyChords pages (tries `/ru/trans` with target override support):
  - `node scripts/import-mychords.mjs [--target=E] <url1> <url2> ...`
- Script writes source HTML into `mychords/`.

## Parsing Notes (important)
- CHO format is the canonical internal format.
- For `pesnipodgitaru`, parser uses `simpleChordDistribution` and extra heuristics:
  - carry tail chords like `_ _ G F` to next lyric line.
  - normalize Cyrillic chord letters (`С->C`, `Н->H`, etc.).
  - detect loose section cues like `Припев.` and `Куплет.`.
  - split combined chord tokens (`GH7EmDG` -> `G H7 Em D G`).
- For AMDM, preserve spacing-sensitive behavior; avoid collapsing internal spaces in chord rows.

## Rendering Notes
- Mobile/tablet full-screen reading supported.
- Print layout supported.
- Instrumental sections can be hidden in UI.
- Chord-only lines are rendered as separate chord sequences (not merged into one token).
- Locked instrumental sections should exit once real chorded lyrics start.

## Known Sharp Edges
- Source HTML quality varies; section boundaries may need heuristic tuning per song.
- When changing parser heuristics, always re-check at least:
  - `Кукла колдуна` (AMDM)
  - `Что такое осень` (AMDM)
  - `Кукушка` (PesniPodGitaru)
  - `Пачка сигарет` (PesniPodGitaru)
  - `Стук` (PesniPodGitaru)

## Commands Cheat Sheet
- Sync all sources:
  - `node scripts/sync-raw.mjs`
- Update chord SVG/index only:
  - `node scripts/update-chords.mjs`
- Import one song from URL:
  - `node scripts/import-pesnipodgitaru.mjs <url>`

## Git
- Commit parser/render changes together with regenerated `public/*` artifacts when behavior changes.
