const LIBRARY_URL = "./public/library.json";
const CHORD_INDEX_URL = "./public/chords/index.json";

const elements = {
  songList: document.getElementById("songList"),
  songTitle: document.getElementById("songTitle"),
  songMeta: document.getElementById("songMeta"),
  songContent: document.getElementById("songContent"),
  template: document.getElementById("songListItemTemplate"),
  readerToggleButton: document.getElementById("readerToggleButton"),
  exitReaderButton: document.getElementById("exitReaderButton"),
  instrumentalToggleButton: document.getElementById("instrumentalToggleButton"),
  chordSummary: document.getElementById("chordSummary"),
  chordDetailsToggleButton: document.getElementById("chordDetailsToggleButton"),
  chordDetails: document.getElementById("chordDetails"),
  chordList: document.getElementById("chordList"),
  chordDiagram: document.getElementById("chordDiagram"),
};

const state = {
  songs: [],
  activeSongId: null,
  loadError: "",
  choCache: new Map(),
  showInstrumentals: false,
  showChordDetails: false,
  chordIndex: new Map(),
  selectedChord: null,
};

let suppressHashChange = false;

init();

async function init() {
  bindEvents();
  applyUiFromHash();
  await loadChordIndex();
  await loadLibrary();
  renderSongList();

  const routeSong = getRouteSongSlug();
  const initialSong = findSongBySlug(routeSong) || state.songs[0] || null;

  if (initialSong) {
    await openSong(initialSong.id, { updateHash: !routeSong });
  } else {
    renderEmptyViewer();
  }

  renderInstrumentalToggle();
}

function bindEvents() {
  if (elements.readerToggleButton) {
    elements.readerToggleButton.addEventListener("click", () => {
      setReaderMode(!document.body.classList.contains("reader-mode"));
    });
  }

  if (elements.exitReaderButton) {
    elements.exitReaderButton.addEventListener("click", () => {
      setReaderMode(false);
    });
  }

  if (elements.instrumentalToggleButton) {
    elements.instrumentalToggleButton.addEventListener("click", async () => {
      state.showInstrumentals = !state.showInstrumentals;
      setHashState({ inst: state.showInstrumentals ? "1" : "0" }, false);
      renderInstrumentalToggle();

      const activeSong = state.songs.find((song) => song.id === state.activeSongId);
      if (activeSong) {
        const choText = await getChoText(activeSong);
        renderCho(choText);
      }
    });
  }

  if (elements.chordDetailsToggleButton) {
    elements.chordDetailsToggleButton.addEventListener("click", () => {
      state.showChordDetails = !state.showChordDetails;
      renderChordDetailsToggle();
    });
  }

  window.addEventListener("hashchange", async () => {
    if (suppressHashChange) {
      suppressHashChange = false;
      return;
    }

    applyUiFromHash();
    renderInstrumentalToggle();

    const routeSong = getRouteSongSlug();
    if (!routeSong) {
      return;
    }

    const song = findSongBySlug(routeSong);
    if (song && song.id !== state.activeSongId) {
      await openSong(song.id, { updateHash: false });
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("reader-mode")) {
      setReaderMode(false);
    }
  });
}

async function loadLibrary() {
  try {
    const response = await fetch(LIBRARY_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Не удалось прочитать public/library.json");
    }

    const data = await response.json();
    if (!data || !Array.isArray(data.songs)) {
      throw new Error("Некорректный формат библиотеки");
    }

    state.songs = data.songs;
    state.loadError = "";
  } catch (error) {
    console.error(error);
    state.songs = [];
    state.activeSongId = null;
    state.loadError = error?.message || "Ошибка загрузки library.json";
  }
}

async function loadChordIndex() {
  state.chordIndex = new Map();
  try {
    const response = await fetch(CHORD_INDEX_URL, { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      if (item?.name) {
        state.chordIndex.set(item.name, item);
      }
    }
  } catch (error) {
    console.error(error);
  }
}

function renderSongList() {
  elements.songList.innerHTML = "";

  if (state.loadError) {
    const err = document.createElement("li");
    err.textContent = `Ошибка: ${state.loadError}`;
    elements.songList.append(err);
    return;
  }

  if (!state.songs.length) {
    const empty = document.createElement("li");
    empty.textContent = "Пока пусто";
    elements.songList.append(empty);
    return;
  }

  for (const song of state.songs) {
    const node = elements.template.content.cloneNode(true);
    const button = node.querySelector("button");

    button.textContent = `${song.artist} - ${song.title}`;
    button.classList.toggle("is-active", song.id === state.activeSongId);

    button.addEventListener("click", async () => {
      await openSong(song.id, { updateHash: true });
    });

    elements.songList.append(node);
  }
}

async function openSong(songId, options = { updateHash: true }) {
  state.activeSongId = songId;
  renderSongList();

  const song = state.songs.find((item) => item.id === songId);
  if (!song) {
    renderEmptyViewer();
    return;
  }

  if (options.updateHash) {
    setHashState({ song: getSongSlug(song) }, false);
  }

  elements.songTitle.textContent = song.title;
  elements.songMeta.textContent = `${song.artist} • ${song.sourceHost} • ${new Date(song.importedAt).toLocaleString("ru-RU")}`;
  elements.songContent.innerHTML = "";
  const loading = document.createElement("div");
  loading.className = "cho-empty";
  loading.textContent = "Загрузка .cho...";
  elements.songContent.append(loading);

  try {
    const choText = await getChoText(song);
    renderCho(choText);
    renderChordPanel(extractChords(choText));
  } catch (error) {
    console.error(error);
    elements.songContent.innerHTML = "";
    const failed = document.createElement("div");
    failed.className = "cho-empty";
    failed.textContent = "Не удалось загрузить .cho файл";
    elements.songContent.append(failed);
    renderChordPanel([]);
  }
}

async function getChoText(song) {
  if (state.choCache.has(song.id)) {
    return state.choCache.get(song.id);
  }

  if (!song.choFile) {
    if (song.chordPro) {
      state.choCache.set(song.id, song.chordPro);
      return song.chordPro;
    }
    throw new Error("В индексе нет choFile");
  }

  const response = await fetch(`./public/${song.choFile}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Ошибка чтения cho файла");
  }

  const text = await response.text();
  state.choCache.set(song.id, text);
  return text;
}

function renderCho(choText) {
  elements.songContent.innerHTML = "";

  const parsed = parseChoLines(choText);

  for (const row of parsed.rows) {
    if (row.instrumental && !state.showInstrumentals) {
      continue;
    }

    if (row.type === "verse-gap") {
      const gap = document.createElement("div");
      gap.className = "cho-verse-gap";
      gap.textContent = " ";
      elements.songContent.append(gap);
      continue;
    }

    if (row.type === "section") {
      const section = document.createElement("div");
      section.className = "cho-section";
      section.textContent = `[${row.value}]`;
      if (row.instrumental) {
        section.classList.add("cho-section--instrumental");
      }
      elements.songContent.append(section);
      continue;
    }

    if (row.type === "text") {
      const textLine = document.createElement("div");
      textLine.className = "cho-text";
      if (row.tabLike) {
        textLine.classList.add("cho-text--tab");
      }
      textLine.textContent = row.value;
      elements.songContent.append(textLine);
      continue;
    }

    if (row.type === "chorded") {
      const wrapper = document.createElement("div");
      wrapper.className = "cho-line";

      const chords = document.createElement("div");
      chords.className = "cho-chords";
      chords.textContent = row.chords;

      const lyrics = document.createElement("div");
      lyrics.className = "cho-lyrics";
      lyrics.textContent = row.lyrics;

      wrapper.append(chords, lyrics);
      elements.songContent.append(wrapper);
    }
  }
}

function parseChoLines(choText) {
  const rows = [];
  const lines = choText.replace(/\r/g, "").split("\n");
  let blankRun = 0;
  let currentInstrumental = false;
  let instrumentalLockedBySection = false;

  for (const line of lines) {
    const directive = parseDirective(line);

    if (directive) {
      blankRun = flushBlankRun(rows, blankRun, currentInstrumental);
      const key = directive.key;
      if (key === "c" || key === "comment") {
        currentInstrumental = isInstrumentalSection(directive.value);
        instrumentalLockedBySection = currentInstrumental;
        rows.push({ type: "section", value: directive.value || "Секция", instrumental: currentInstrumental });
      }
      continue;
    }

    if (!line.trim()) {
      blankRun += 1;
      continue;
    }

    const tabLikeLine = isTablatureLine(line);
    if (tabLikeLine) {
      currentInstrumental = true;
    }

    if (instrumentalLockedBySection && isChordedLyricLine(line)) {
      currentInstrumental = false;
      instrumentalLockedBySection = false;
    }

    if (currentInstrumental && !instrumentalLockedBySection && shouldExitInstrumentalBlock(line)) {
      currentInstrumental = false;
    }

    blankRun = flushBlankRun(rows, blankRun, currentInstrumental);

    if (!line.includes("[")) {
      rows.push({
        type: "text",
        value: line,
        instrumental: currentInstrumental || tabLikeLine,
        tabLike: tabLikeLine,
      });
      continue;
    }

    const rendered = splitChordLine(line);
    rows.push({ type: "chorded", chords: rendered.chords, lyrics: rendered.lyrics, instrumental: currentInstrumental });
  }

  flushBlankRun(rows, blankRun, currentInstrumental);
  return { rows };
}

function shouldExitInstrumentalBlock(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  // Keep string-tab lines inside instrumental blocks.
  if (isTablatureLine(trimmed)) {
    return false;
  }

  // Keep pure chord lines (e.g. "[Hm] [C] [Am] [D]") inside instrumental blocks.
  const withoutChords = trimmed.replace(/\[[^\]]+\]/g, "").trim();
  if (!withoutChords) {
    return false;
  }

  // If line contains lyric text (Cyrillic/Latin words), instrumental block ends.
  if (/[А-Яа-яЁё]/.test(withoutChords) || /[A-Za-z]{2,}/.test(withoutChords)) {
    return true;
  }

  return false;
}

function flushBlankRun(rows, blankRun, instrumental) {
  if (blankRun === 0) {
    return 0;
  }

  rows.push({ type: "verse-gap", instrumental });
  return 0;
}

function parseDirective(line) {
  const match = line.match(/^\{\s*([^:}\s]+)\s*(?::\s*([^}]*))?\}\s*$/);
  if (!match) {
    return null;
  }

  return {
    key: (match[1] || "").toLowerCase(),
    value: (match[2] || "").trim(),
  };
}

function splitChordLine(line) {
  const chordRegex = /\[([^\]]+)\]/g;
  const chordOnly = line.replace(chordRegex, "").trim().length === 0;
  if (chordOnly) {
    const chordNames = Array.from(line.matchAll(chordRegex))
      .map((match) => (match[1] || "").trim())
      .filter(Boolean);
    return {
      chords: chordNames.join(" "),
      lyrics: "",
    };
  }

  let lyrics = "";
  let chords = "";
  let lyricCursor = 0;
  let consumed = 0;

  for (const match of line.matchAll(chordRegex)) {
    const index = match.index ?? 0;
    const chord = match[1].trim();

    const textPart = line.slice(consumed, index);
    lyrics += textPart;
    lyricCursor += textPart.length;

    let placePos = lyricCursor;
    if (chords.length > placePos) {
      placePos = chords.length + 1;
    }

    if (chords.length < placePos) {
      chords += " ".repeat(placePos - chords.length);
    }

    chords += chord;
    consumed = index + match[0].length;
  }

  lyrics += line.slice(consumed);
  return { chords, lyrics };
}

function isTablatureLine(line) {
  const trimmed = line.trim();
  if (/^[1-6]-я\s+/.test(trimmed)) {
    return true;
  }
  if (!/^[EADGBe]\|/.test(trimmed)) {
    return false;
  }

  // Typical guitar tab line symbols: frets, bars, ties, slides, bends, muted notes.
  return /^[EADGBe]\|[-0-9hHpPbBrRsSxX~^()\\/|.*\s]+$/.test(trimmed);
}

function isChordedLyricLine(line) {
  if (!line.includes("[")) {
    return false;
  }
  const withoutChords = line.replace(/\[[^\]]+\]/g, "").trim();
  if (!withoutChords) {
    return false;
  }
  return /[А-Яа-яЁёA-Za-z]/.test(withoutChords);
}

function extractChords(choText) {
  const found = new Set();
  for (const match of choText.matchAll(/\[([^\]]+)\]/g)) {
    const chord = match[1].trim();
    if (chord) {
      found.add(chord);
    }
  }

  return [...found].sort((a, b) => a.localeCompare(b));
}

function renderChordPanel(chords) {
  if (elements.chordSummary) {
    elements.chordSummary.textContent = chords.length ? chords.join(" • ") : "Нет аккордов";
  }

  if (!state.selectedChord || !chords.includes(state.selectedChord)) {
    state.selectedChord = chords[0] || null;
  }

  elements.chordList.innerHTML = "";
  if (!chords.length) {
    const empty = document.createElement("span");
    empty.className = "chord-inline-empty";
    empty.textContent = "Нет аккордов";
    elements.chordList.append(empty);
    renderChordDiagram(null);
    return;
  }

  for (const chord of chords) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "chord-chip";
    item.textContent = chord;
    item.classList.toggle("is-active", chord === state.selectedChord);
    item.addEventListener("click", () => {
      state.selectedChord = chord;
      renderChordPanel(chords);
    });
    elements.chordList.append(item);
  }

  renderChordDiagram(state.selectedChord);
  renderChordDetailsToggle();
}

function renderEmptyViewer() {
  elements.songTitle.textContent = "Библиотека пуста";
  elements.songMeta.textContent = "";
  elements.songContent.innerHTML = "";

  const info = document.createElement("div");
  info.className = "cho-empty";
  info.textContent = "Положите файлы в amdm/ или pesnipodgitaru/ и выполните: node scripts/sync-raw.mjs";
  elements.songContent.append(info);
  renderChordPanel([]);
}

function isInstrumentalSection(value) {
  const normalized = (value || "").toLowerCase();
  return /(проигрыш|вступлен|соло|interlude|intro|instrumental|riff|рифф|bridge|бридж)/i.test(normalized);
}

function renderInstrumentalToggle() {
  if (!elements.instrumentalToggleButton) {
    return;
  }
  elements.instrumentalToggleButton.textContent = state.showInstrumentals
    ? "Скрыть проигрыши"
    : "Показать проигрыши";
}

function renderChordDetailsToggle() {
  if (!elements.chordDetails || !elements.chordDetailsToggleButton) {
    return;
  }
  elements.chordDetails.hidden = !state.showChordDetails;
  elements.chordDetailsToggleButton.textContent = state.showChordDetails
    ? "Скрыть детали"
    : "Детали аккордов";
}

function renderChordDiagram(chord) {
  if (!elements.chordDiagram) {
    return;
  }
  elements.chordDiagram.innerHTML = "";

  if (!chord) {
    const empty = document.createElement("p");
    empty.className = "chord-inline-empty";
    empty.textContent = "Выберите аккорд";
    elements.chordDiagram.append(empty);
    return;
  }

  const title = document.createElement("div");
  title.className = "chord-diagram__title";
  title.textContent = chord;
  elements.chordDiagram.append(title);

  const indexed = state.chordIndex.get(chord);
  const variant = indexed?.variants?.find((v) => v.available && v.file);

  if (variant) {
    const image = document.createElement("img");
    image.className = "chord-diagram__img";
    image.src = `./public/${variant.file}`;
    image.alt = `Схема аккорда ${chord}`;
    elements.chordDiagram.append(image);
    return;
  }

  const miss = document.createElement("p");
  miss.className = "chord-inline-empty";
  miss.textContent = "SVG не найден";
  elements.chordDiagram.append(miss);
}

function setReaderMode(enabled) {
  document.body.classList.toggle("reader-mode", enabled);
  setHashState({ reader: enabled ? "1" : null }, false);
}

function applyUiFromHash() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const reader = hash.get("reader") === "1";
  const inst = hash.get("inst");

  document.body.classList.toggle("reader-mode", reader);
  if (inst === "1") {
    state.showInstrumentals = true;
  }
  if (inst === "0") {
    state.showInstrumentals = false;
  }
}

function getRouteSongSlug() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return hash.get("song") || "";
}

function setHashState({ song, reader, inst }, replace) {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));

  if (song !== undefined) {
    if (song) {
      params.set("song", song);
    } else {
      params.delete("song");
    }
  }

  if (reader !== undefined) {
    if (reader) {
      params.set("reader", reader);
    } else {
      params.delete("reader");
    }
  }

  if (inst !== undefined) {
    if (inst === "1" || inst === "0") {
      params.set("inst", inst);
    } else {
      params.delete("inst");
    }
  }

  const nextHash = params.toString();
  const currentHash = window.location.hash.replace(/^#/, "");
  if (nextHash === currentHash) {
    return;
  }

  suppressHashChange = true;
  if (replace) {
    history.replaceState(null, "", `${window.location.pathname}${nextHash ? `#${nextHash}` : ""}`);
  } else {
    window.location.hash = nextHash;
  }
}

function getSongSlug(song) {
  if (song.slug) {
    return song.slug;
  }
  const base = `${song.artist || "artist"}-${song.title || "song"}`;
  return slugify(base);
}

function findSongBySlug(slug) {
  if (!slug) {
    return null;
  }

  return state.songs.find((song) => getSongSlug(song) === slug) || null;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9а-яё_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
