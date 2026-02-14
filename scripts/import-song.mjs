import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSongPageText, mapUrlToSong, normalizeUrl } from "../song-parser.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const libraryPath = path.resolve(projectRoot, "public/library.json");
const songsDir = path.resolve(projectRoot, "public/songs");

const inputUrl = process.argv[2];
if (!inputUrl) {
  console.error('Usage: node scripts/import-song.mjs "https://amdm.ru/..."');
  process.exit(1);
}

await fs.mkdir(songsDir, { recursive: true });

const normalizedUrl = normalizeUrl(inputUrl);
const raw = await fetchSongPageText(normalizedUrl, fetch);
const song = mapUrlToSong(normalizedUrl, raw);

const library = await loadLibrary();
const existing = library.songs.find((item) => item.sourceUrl === song.sourceUrl);
const choFile = existing?.choFile || createChoRelativePath(song);

await fs.writeFile(path.resolve(projectRoot, "public", choFile), `${song.cho}\n`, "utf8");

const item = {
  id: existing?.id || song.id,
  title: song.title,
  artist: song.artist,
  sourceUrl: song.sourceUrl,
  sourceHost: song.sourceHost,
  importedAt: new Date().toISOString(),
  format: "cho",
  choFile,
};

const updatedSongs = [item, ...library.songs.filter((entry) => entry.sourceUrl !== song.sourceUrl)];
const updated = {
  version: 2,
  updatedAt: new Date().toISOString(),
  songs: updatedSongs,
};

await fs.writeFile(libraryPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");

console.log(`Saved .cho: ${choFile}`);
console.log(`Added: ${song.artist} - ${song.title}`);
console.log(`Total songs: ${updatedSongs.length}`);

async function loadLibrary() {
  try {
    const content = await fs.readFile(libraryPath, "utf8");
    const parsed = JSON.parse(content);
    if (!parsed || !Array.isArray(parsed.songs)) {
      return emptyLibrary();
    }
    return parsed;
  } catch {
    return emptyLibrary();
  }
}

function emptyLibrary() {
  return { version: 2, updatedAt: new Date().toISOString(), songs: [] };
}

function createChoRelativePath(song) {
  const slugFromUrl = slugFromSourceUrl(song.sourceUrl);
  const safeArtist = slugify(song.artist || "artist");
  const safeTitle = slugify(song.title || "song");
  const base = slugFromUrl || `${safeArtist}-${safeTitle}`;
  return `songs/${base}.cho`;
}

function slugFromSourceUrl(url) {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  return slugify(segments[segments.length - 1] || "");
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
