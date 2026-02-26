import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const sourceDir = path.resolve(projectRoot, "mychords");

const { urls, targetOverride, shift } = parseArgs(process.argv.slice(2));
if (!urls.length) {
  console.error('Usage: node scripts/import-mychords.mjs [--target=E] [--shift=-1] "https://mychords.net/ru/...html" [...]');
  process.exit(1);
}

await fs.mkdir(sourceDir, { recursive: true });

let success = 0;
let failed = 0;

for (const rawUrl of urls) {
  try {
    const url = normalizeUrl(rawUrl);
    if (!/mychords\.net$/i.test(url.hostname)) {
      console.log(`Skip non-mychords URL: ${rawUrl}`);
      continue;
    }

    const pageHtml = await fetchHtml(url.toString());
    const pageMeta = extractMchPageMeta(pageHtml);
    const target = targetOverride || detectTargetFromDescription(pageHtml) || pageMeta.gptTarget || "";
    const transResult = await fetchTransHtml(url, pageMeta, target, shift);
    const merged = transResult.html ? replaceWordsTextHtml(pageHtml, transResult.html) : pageHtml;
    const shifted = shift && !transResult.appliedShift ? transposeMyChordsWordsBlock(merged, shift) : merged;

    const baseName = slugify(url.pathname.split("/").filter(Boolean).at(-1) || "song");
    const fileName = `${baseName}.html`;
    const targetPath = path.join(sourceDir, fileName);
    await fs.writeFile(targetPath, shifted, "utf8");

    console.log(
      `Saved ${rawUrl} -> mychords/${fileName}${target ? ` (target=${target})` : ""}${shift ? ` (shift=${shift})` : ""}`,
    );
    success += 1;
  } catch (error) {
    failed += 1;
    console.log(`Failed ${rawUrl}: ${error?.message || "Fetch error"}`);
  }
}

console.log(`Imported pages: ${success}`);
console.log(`Failed pages: ${failed}`);

function parseArgs(args) {
  const urls = [];
  let targetOverride = "";
  let shift = 0;

  for (const arg of args) {
    if (arg.startsWith("--target=")) {
      targetOverride = normalizeTargetToken(arg.slice("--target=".length));
      continue;
    }
    if (arg.startsWith("--shift=")) {
      shift = Number.parseInt(arg.slice("--shift=".length), 10) || 0;
      continue;
    }
    urls.push(arg);
  }

  return { urls, targetOverride, shift };
}

function normalizeUrl(value) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return new URL(withProtocol);
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Songbook Importer)",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const html = await response.text();
  if (!html.includes("<html")) {
    throw new Error("unexpected payload");
  }

  return html;
}

function extractMchPageMeta(html) {
  const appConfigMatch = html.match(
    /window\.appConfig\s*=\s*\{[\s\S]*?gpt_page:\s*"([^"]+)"[\s\S]*?gpt_a:\s*"([^"]+)"[\s\S]*?gpt_gr:\s*"([^"]+)"[\s\S]*?gpt_target:\s*"([^"]+)"/i,
  );
  const transPath = html.match(/class="w-words__text"[^>]*data-url="([^"]+)"/i)?.[1] || "/ru/trans";

  return {
    gptPage: appConfigMatch?.[1] || "",
    gptA: appConfigMatch?.[2] || "",
    gptGr: appConfigMatch?.[3] || "",
    gptTarget: appConfigMatch?.[4] || "",
    transPath,
  };
}

function detectTargetFromDescription(html) {
  const description = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i)?.[1] || "";
  const startChord = description.match(/(?:вступление|intro)\s+([A-H](?:#|b)?m?)/i)?.[1] || "";
  const root = startChord.match(/^([A-H](?:#|b)?)/i)?.[1] || "";
  return normalizeTargetToken(root);
}

function normalizeTargetToken(value) {
  const token = String(value || "").trim();
  if (!token) {
    return "";
  }
  return token.charAt(0).toUpperCase() + token.slice(1);
}

async function fetchTransHtml(pageUrl, meta, target, shift = 0) {
  if (!meta.transPath) {
    return { html: "", appliedShift: false };
  }

  const endpoint = new URL(meta.transPath, `${pageUrl.protocol}//${pageUrl.host}`).toString();
  const candidates = buildTransPayloadCandidates(pageUrl, meta, target, shift);

  for (const candidate of candidates) {
    try {
      const response =
        candidate.method === "POST"
          ? await fetch(endpoint, {
              method: "POST",
              headers: {
                "User-Agent": "Mozilla/5.0 (Songbook Importer)",
                Accept: "text/html,application/xhtml+xml,*/*",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              },
              body: new URLSearchParams(candidate.params),
            })
          : await fetch(`${endpoint}?${new URLSearchParams(candidate.params).toString()}`, {
              method: "GET",
              headers: {
                "User-Agent": "Mozilla/5.0 (Songbook Importer)",
                Accept: "text/html,application/xhtml+xml,*/*",
                "X-Requested-With": "XMLHttpRequest",
              },
            });

      if (!response.ok) {
        continue;
      }

      const text = await response.text();
      const normalized = normalizeTransResponse(text);
      if (normalized) {
        return { html: normalized, appliedShift: candidate.usesShift };
      }
    } catch {
      // try next candidate
    }
  }

  return { html: "", appliedShift: false };
}

function buildTransPayloadCandidates(pageUrl, meta, target, shift) {
  const semitoneShift = Number.parseInt(String(shift || 0), 10) || 0;
  const common = {
    page: meta.gptPage,
    a: meta.gptA,
    gr: meta.gptGr,
    target: target || meta.gptTarget,
  };

  const reduced = Object.fromEntries(Object.entries(common).filter(([, v]) => String(v || "").trim()));
  const idBased = {
    id: meta.gptPage,
    a: meta.gptA,
    gr: meta.gptGr,
    target: target || meta.gptTarget,
  };
  const reducedId = Object.fromEntries(Object.entries(idBased).filter(([, v]) => String(v || "").trim()));

  const out = [
    { method: "GET", params: reduced, usesShift: false },
    { method: "GET", params: reducedId, usesShift: false },
    { method: "POST", params: reduced, usesShift: false },
    { method: "POST", params: reducedId, usesShift: false },
  ];

  if (semitoneShift) {
    out.unshift({
      method: "POST",
      params: {
        host: pageUrl.toString(),
        transpose: String(Math.abs(semitoneShift)),
        direction: semitoneShift < 0 ? "down" : "up",
      },
      usesShift: true,
    });
  }

  return out;
}

function normalizeTransResponse(payload) {
  const text = String(payload || "").trim();
  if (!text) {
    return "";
  }

  if (text.includes('class="w-words__text"')) {
    const words = text.match(/<div[^>]*class="[^"]*\bw-words__text\b[^"]*"[^>]*>[\s\S]*?<\/div>/i)?.[0] || "";
    if (words && words.includes("b-accord__symbol")) {
      return words;
    }
  }

  if (text.includes("b-accord__symbol") && !text.includes("<html")) {
    const wrapped = `<div class="w-words__text" itemprop="text" data-url="/ru/trans">${text}</div>`;
    return wrapped;
  }

  return "";
}

function replaceWordsTextHtml(pageHtml, wordsBlockHtml) {
  const source = String(pageHtml || "");
  const replacement = String(wordsBlockHtml || "");
  if (!replacement) {
    return source;
  }

  return source.replace(
    /<div[^>]*class="[^"]*\bw-words__text\b[^"]*"[^>]*>[\s\S]*?<\/div>/i,
    replacement,
  );
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function transposeMyChordsWordsBlock(html, shift) {
  const delta = Number.parseInt(String(shift), 10) || 0;
  if (!delta) {
    return html;
  }

  return String(html || "").replace(
    /(<span[^>]*class="[^"]*\bb-accord__symbol\b[^"]*"[^>]*>)([\s\S]*?)(<\/span>)/gi,
    (_, open, chordRaw, close) => `${open}${transposeChord(chordRaw, delta)}${close}`,
  );
}

function transposeChord(chordRaw, shift) {
  const chord = String(chordRaw || "").trim();
  if (!chord) {
    return chord;
  }

  const transposedMain = transposeChordPart(chord, shift);
  if (transposedMain) {
    return transposedMain;
  }

  return chord;
}

function transposeChordPart(chord, shift) {
  const slashIndex = chord.indexOf("/");
  const main = slashIndex === -1 ? chord : chord.slice(0, slashIndex);
  const bass = slashIndex === -1 ? "" : chord.slice(slashIndex + 1);

  const mainMatch = main.match(/^([A-H](?:#|b)?)(.*)$/i);
  if (!mainMatch) {
    return "";
  }

  const nextMainRoot = transposeRoot(mainMatch[1], shift);
  if (!nextMainRoot) {
    return "";
  }

  let out = `${nextMainRoot}${mainMatch[2] || ""}`;

  if (bass) {
    const bassMatch = bass.match(/^([A-H](?:#|b)?)(.*)$/i);
    if (!bassMatch) {
      return out;
    }
    const nextBassRoot = transposeRoot(bassMatch[1], shift);
    if (!nextBassRoot) {
      return out;
    }
    out += `/${nextBassRoot}${bassMatch[2] || ""}`;
  }

  return out;
}

function transposeRoot(root, shift) {
  const normalized = normalizeRoot(root);
  if (normalized === -1) {
    return "";
  }

  const next = (normalized + shift % 12 + 12) % 12;
  return semitoneToRoot(next);
}

function normalizeRoot(rootRaw) {
  const root = String(rootRaw || "").trim();
  const map = {
    C: 0,
    "C#": 1,
    Db: 1,
    D: 2,
    "D#": 3,
    Eb: 3,
    E: 4,
    F: 5,
    "F#": 6,
    Gb: 6,
    G: 7,
    "G#": 8,
    Ab: 8,
    A: 9,
    "A#": 10,
    Bb: 10,
    B: 10,
    H: 11,
    Hb: 10,
  };
  return map[root] ?? map[root.toUpperCase()] ?? -1;
}

function semitoneToRoot(index) {
  const map = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "B", "H"];
  return map[index] || "";
}
