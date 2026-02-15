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
const POPULAR_CHORDS = [
  "A",
  "Am",
  "A7",
  "B",
  "Bm",
  "B7",
  "C",
  "Cm",
  "C7",
  "D",
  "Dm",
  "D7",
  "E",
  "Em",
  "E7",
  "F",
  "Fm",
  "F7",
  "G",
  "Gm",
  "G7",
  "H",
  "Hm",
  "H7",
];

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

for (const chord of POPULAR_CHORDS) {
  allChords.add(chord);
}

const chordItems = [];
let availableCount = 0;
let missingCount = 0;

for (const chord of [...allChords].sort((a, b) => a.localeCompare(b))) {
  const variants = await buildChordVariants(chord);
  if (variants.some((v) => v.available)) {
    availableCount += 1;
  } else {
    missingCount += 1;
  }

  chordItems.push({
    name: chord,
    variants,
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
  const safeChordKey = slugifyChord(chord);
  const file = `chords/svg/${safeChordKey}_${variantId}.svg`;
  const absolutePath = path.join(publicDir, file);

  if (await fileExists(absolutePath)) {
    return {
      variant: variantId,
      file,
      sourceUrl: `https://amdm.ru/cs/images/chords/svg/${encodeURIComponent(chord)}_${variantId}.svg`,
      available: true,
      cached: true,
    };
  }

  const candidates = chordSourceCandidates(chord);
  for (const sourceChord of candidates) {
    const sourceUrl = `https://amdm.ru/cs/images/chords/svg/${encodeURIComponent(sourceChord)}_${variantId}.svg`;
    try {
      const response = await fetch(sourceUrl);
      if (!response.ok) {
        continue;
      }

      const svg = await response.text();
      if (!svg.includes("<svg")) {
        continue;
      }

      await fs.writeFile(absolutePath, svg, "utf8");

      return {
        variant: variantId,
        file,
        sourceUrl,
        available: true,
        cached: false,
      };
    } catch {
      // try next candidate
    }
  }

  return {
    variant: variantId,
    file,
    sourceUrl: `https://amdm.ru/cs/images/chords/svg/${encodeURIComponent(chord)}_${variantId}.svg`,
    available: false,
    cached: false,
    error: "fetch failed",
  };
}

async function buildChordVariants(chord) {
  const out = [];
  let primary = null;

  for (const variantId of [0, 1, 2, 3]) {
    const variant = await ensureChordVariant(chord, variantId);
    if (variantId === 0) {
      primary = variant;
    }
    if (variant.available) {
      out.push(variant);
    }
  }

  return out.length ? out : primary ? [primary] : [];
}

function chordSourceCandidates(chord) {
  const out = [chord];
  const enharmonic = sharpToFlatEnharmonic(chord);
  if (enharmonic && enharmonic !== chord) {
    out.push(enharmonic);
  }
  return out;
}

function sharpToFlatEnharmonic(chord) {
  const match = String(chord).match(/^([A-H])#(.*)$/);
  if (!match) {
    return chord;
  }

  const base = match[1];
  const suffix = match[2] || "";
  const map = {
    C: "Db",
    D: "Eb",
    F: "Gb",
    G: "Ab",
    A: "Bb",
  };

  const flat = map[base];
  if (!flat) {
    return chord;
  }

  return `${flat}${suffix}`;
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
