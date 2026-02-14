# Songbook (Frontend only, CHO)

Библиотека песен в формате `*.cho` (ChordPro/CHO) с рендером аккордов и SVG-схемами.

## Поток работы
1. Клади исходники по источникам:
   - `amdm/` (`.txt` или `.html`)
   - `pesnipodgitaru/` (`.html`)
2. Для загрузки примеров с pesnipodgitaru:
```bash
node scripts/import-pesnipodgitaru.mjs
```
3. Запусти синхронизацию песен:
```bash
node scripts/sync-raw.mjs
```
4. При необходимости отдельно обнови библиотеку аккордов:
```bash
node scripts/update-chords.mjs
```
5. Обнови страницу в браузере.

## Важные детали
- У каждой песни есть `slug` в `public/library.json`.
- Текущая песня, режим чтения и видимость проигрышей сохраняются в URL-хэше.
- Режим чтения можно закрыть кнопкой `Выйти из чтения` или `Esc`.
- Проигрыши/вступления можно скрывать кнопкой `Показать/Скрыть проигрыши`.

## Что делает sync
- конвертирует `amdm/*` и `pesnipodgitaru/*` в `public/songs/**/*.cho`
- пересобирает индекс `public/library.json`
- обновляет библиотеку аккордов (`public/chords/index.json`)

## Что делает update-chords
- читает все `public/songs/*.cho`
- собирает список используемых аккордов
- для каждого аккорда:
  - если `public/chords/svg/<name>_0.svg` есть -> использует его
  - если нет -> пытается скачать с amdm
- пересобирает `public/chords/index.json`

## Структура хранения
- `amdm/*` — исходники amdm
- `pesnipodgitaru/*` — исходники pesnipodgitaru
- `public/library.json` — индекс песен
- `public/songs/**/*.cho` — сгенерированные песни
- `public/chords/index.json` — индекс SVG-аккордов (имя, варианты, путь)
- `public/chords/svg/*.svg` — локальные SVG

## Запуск UI
```bash
python3 -m http.server 8080
```

Открой `http://localhost:8080`.
