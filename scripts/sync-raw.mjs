import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapRawFileToSong } from "../song-parser.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const amdmDir = path.resolve(projectRoot, "amdm");
const pesniDir = path.resolve(projectRoot, "pesnipodgitaru");
const legacyRawDir = path.resolve(projectRoot, "raw");
const publicDir = path.resolve(projectRoot, "public");
const songsDir = path.resolve(publicDir, "songs");
const chordsDir = path.resolve(publicDir, "chords");
const chordSvgDir = path.resolve(chordsDir, "svg");
const libraryPath = path.resolve(publicDir, "library.json");
const chordIndexPath = path.resolve(chordsDir, "index.json");

await fs.mkdir(amdmDir, { recursive: true });
await fs.mkdir(pesniDir, { recursive: true });
await fs.mkdir(songsDir, { recursive: true });
await fs.mkdir(chordSvgDir, { recursive: true });

const sources = [
  { name: "amdm", dir: amdmDir },
  { name: "pesnipodgitaru", dir: pesniDir },
];

if (await fileExists(legacyRawDir)) {
  sources.push({ name: "raw", dir: legacyRawDir });
}

await clearSongsDir(songsDir);

const songs = [];
const allChords = new Set();
let totalRawFiles = 0;

for (const source of sources) {
  const fileNames = (await fs.readdir(source.dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "ru"));

  totalRawFiles += fileNames.length;

  for (const fileName of fileNames) {
    const absolutePath = path.join(source.dir, fileName);
    const content = await fs.readFile(absolutePath, "utf8");
    const sourceLabel = `${source.name}/${fileName}`;
    const song = mapRawFileToSong(content, sourceLabel);
    const choFile = `songs/${source.name}/${slugify(fileName.replace(/\.[^.]+$/, ""))}.cho`;

    await fs.mkdir(path.dirname(path.join(publicDir, choFile)), { recursive: true });
    await fs.writeFile(path.join(publicDir, choFile), `${song.cho}\n`, "utf8");

    for (const chord of extractChords(song.cho)) {
      allChords.add(chord);
    }

    songs.push({
      id: song.id,
      slug: buildSongSlug(song, source.name, fileName),
      title: song.title,
      artist: song.artist,
      sourceUrl: `${source.name}://${fileName}`,
      sourceHost: source.name,
      importedAt: new Date().toISOString(),
      format: "cho",
      choFile,
    });
  }
}

const dedupedSongs = dedupeSongs(songs);

const library = {
  version: 2,
  updatedAt: new Date().toISOString(),
  songs: dedupedSongs,
};

await fs.writeFile(libraryPath, `${JSON.stringify(library, null, 2)}\n`, "utf8");

const chordItems = [];
for (const chord of [...allChords].sort((a, b) => a.localeCompare(b))) {
  const variant = await ensureChordVariant(chord, 0);
  chordItems.push({
    name: chord,
    variants: [variant],
  });
}

const chordIndex = {
  version: 1,
  updatedAt: new Date().toISOString(),
  sourceTemplate: "https://amdm.ru/cs/images/chords/svg/{chord}_{variant}.svg",
  items: chordItems,
};

await fs.writeFile(chordIndexPath, `${JSON.stringify(chordIndex, null, 2)}\n`, "utf8");

console.log(`Synced source files: ${totalRawFiles}`);
console.log(`Generated songs: ${dedupedSongs.length}`);
console.log(`Chord assets indexed: ${chordItems.length}`);

async function ensureChordVariant(chord, variantId) {
  const encodedChord = encodeURIComponent(chord);
  const safeChordKey = slugifyChord(chord);
  const file = `chords/svg/${safeChordKey}_${variantId}.svg`;
  const absolutePath = path.join(publicDir, file);
  const sourceUrl = `https://amdm.ru/cs/images/chords/svg/${encodedChord}_${variantId}.svg`;

  if (await fileExists(absolutePath)) {
    return {
      variant: variantId,
      file,
      sourceUrl,
      available: true,
      cached: true,
    };
  }

  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      return {
        variant: variantId,
        file,
        sourceUrl,
        available: false,
        cached: false,
        error: `HTTP ${response.status}`,
      };
    }

    const svg = await response.text();
    if (!svg.includes("<svg")) {
      return {
        variant: variantId,
        file,
        sourceUrl,
        available: false,
        cached: false,
        error: "Not an SVG payload",
      };
    }

    await fs.writeFile(absolutePath, svg, "utf8");

    return {
      variant: variantId,
      file,
      sourceUrl,
      available: true,
      cached: false,
    };
  } catch (error) {
    return {
      variant: variantId,
      file,
      sourceUrl,
      available: false,
      cached: false,
      error: error?.message || "Fetch error",
    };
  }
}

function extractChords(choText) {
  const chords = new Set();
  for (const match of choText.matchAll(/\[([^\]]+)\]/g)) {
    const chord = (match[1] || "").trim();
    if (chord) {
      chords.add(chord);
    }
  }
  return [...chords];
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildSongSlug(song, sourceName, fileName) {
  const rawName = fileName.replace(/\.[^.]+$/, "");
  const base = `${sourceName}-${song.artist || ""}-${song.title || ""}-${rawName}`;
  return slugify(base);
}

function slugifyChord(chord) {
  return chord
    .replace(/#/g, "sharp")
    .replace(/\//g, "-slash-")
    .replace(/\+/g, "plus")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "chord";
}

function dedupeSongs(items) {
  const chosen = new Map();

  for (const item of items) {
    const key = dedupeKey(item);
    const existing = chosen.get(key);
    if (!existing || songPriority(item) > songPriority(existing)) {
      chosen.set(key, item);
    }
  }

  return [...chosen.values()].sort((a, b) => a.slug.localeCompare(b.slug, "ru"));
}

function dedupeKey(song) {
  return `${normalizeDedupeText(song.artist)}::${normalizeDedupeText(song.title)}`;
}

function normalizeDedupeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function songPriority(song) {
  const hostPriority =
    song.sourceHost === "pesnipodgitaru"
      ? 30
      : song.sourceHost === "amdm"
        ? 20
        : song.sourceHost === "raw"
          ? 10
          : 0;

  // If same song repeats in one source, prefer bigger numeric raw id (e.g. 7 over 4).
  const idMatch = (song.sourceUrl || "").match(/\/\/(\d+)\.html$/i);
  const rawId = idMatch ? Number.parseInt(idMatch[1], 10) : 0;

  return hostPriority * 100000 + rawId;
}

async function clearSongsDir(dir) {
  if (!(await fileExists(dir))) {
    return;
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await fs.rm(absolute, { recursive: true, force: true });
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".cho")) {
      await fs.unlink(absolute);
    }
  }
}
