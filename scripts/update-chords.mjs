import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const publicDir = path.resolve(projectRoot, "public");
const songsDir = path.resolve(publicDir, "songs");
const chordsDir = path.resolve(publicDir, "chords");
const chordSvgDir = path.resolve(chordsDir, "svg");
const chordIndexPath = path.resolve(chordsDir, "index.json");

await fs.mkdir(songsDir, { recursive: true });
await fs.mkdir(chordSvgDir, { recursive: true });

const songFiles = (await findChoFilesRecursive(songsDir)).sort((a, b) => a.localeCompare(b, "ru"));

const allChords = new Set();
for (const songFile of songFiles) {
  const content = await fs.readFile(path.join(publicDir, songFile), "utf8");
  for (const chord of extractChords(content)) {
    allChords.add(chord);
  }
}

const chordItems = [];
let availableCount = 0;
let missingCount = 0;

for (const chord of [...allChords].sort((a, b) => a.localeCompare(b))) {
  const variant = await ensureChordVariant(chord, 0);
  if (variant.available) {
    availableCount += 1;
  } else {
    missingCount += 1;
  }

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

console.log(`Songs scanned: ${songFiles.length}`);
console.log(`Chords indexed: ${chordItems.length}`);
console.log(`SVG available: ${availableCount}`);
console.log(`SVG missing: ${missingCount}`);
console.log(`Index file: ${path.relative(projectRoot, chordIndexPath)}`);

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

function slugifyChord(chord) {
  return chord
    .replace(/#/g, "sharp")
    .replace(/\//g, "-slash-")
    .replace(/\+/g, "plus")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "chord";
}

async function findChoFilesRecursive(rootDir) {
  const out = [];

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".cho")) {
        out.push(path.relative(publicDir, absolute).replace(/\\/g, "/"));
      }
    }
  }

  await walk(rootDir);
  return out;
}
