import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapTextToSong } from "../song-parser.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const libraryPath = path.resolve(projectRoot, "public/library.json");
const songsDir = path.resolve(projectRoot, "public/songs");

const inputFile = process.argv[2];
if (!inputFile) {
  console.error('Usage: node scripts/import-text.mjs "./path/to/song.txt"');
  console.error('   or: cat song.txt | node scripts/import-text.mjs -');
  process.exit(1);
}

const isStdin = inputFile === "-";
const absoluteInputPath = isStdin ? null : path.resolve(process.cwd(), inputFile);
const inputText = isStdin ? await readStdin() : await fs.readFile(absoluteInputPath, "utf8");
const sourceLabel = isStdin ? "stdin.txt" : path.basename(absoluteInputPath);
const song = mapTextToSong(inputText, sourceLabel);

await fs.mkdir(songsDir, { recursive: true });

const library = await loadLibrary();
const existing = library.songs.find((item) => item.sourceUrl === song.sourceUrl);
const choFile = existing?.choFile || createChoRelativePath(song, sourceLabel);

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

function createChoRelativePath(song, sourceLabel) {
  const safeArtist = slugify(song.artist || "artist");
  const safeTitle = slugify(song.title || "song");
  const safeSource = slugify(sourceLabel.replace(/\.[^.]+$/, ""));
  const base = safeSource || `${safeArtist}-${safeTitle}`;
  return `songs/${base}.cho`;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
