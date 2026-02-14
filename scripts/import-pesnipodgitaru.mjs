import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const sourceDir = path.resolve(projectRoot, "pesnipodgitaru");

const defaultUrls = [
  "https://pesnipodgitaru.ru/pesni/russkiy-rok/kino-i-viktor-tsoy/gruppa-krovi",
  "https://pesnipodgitaru.ru/pesni/russkiy-rok/kino-i-viktor-tsoy/kukushka",
  "https://pesnipodgitaru.ru/pesni/russkiy-rok/kino-i-viktor-tsoy/konchitsya-leto",
  "https://pesnipodgitaru.ru/pesni/russkiy-rok/kino-i-viktor-tsoy/trolleybus",
  "https://pesnipodgitaru.ru/pesni/russkiy-rok/kino-i-viktor-tsoy/zvezda-po-imeni-solntse",
  "https://pesnipodgitaru.ru/pesni/russkiy-rok/kino-i-viktor-tsoy/pachka-sigaret",
  "https://pesnipodgitaru.ru/pesni/russkiy-rok/kino-i-viktor-tsoy/stuk",
  "https://pesnipodgitaru.ru/pesni/russkiy-rok/kino-i-viktor-tsoy/dalshe-deystvovat-budem-myi",
];

const inputUrls = process.argv.slice(2);
const urls = inputUrls.length ? inputUrls : defaultUrls;

await fs.mkdir(sourceDir, { recursive: true });

let success = 0;
let failed = 0;

for (const rawUrl of urls) {
  const url = normalizeUrl(rawUrl);
  if (!/pesnipodgitaru\.ru$/i.test(url.hostname)) {
    console.log(`Skip non-pesnipodgitaru URL: ${rawUrl}`);
    continue;
  }

  const fileName = `${slugify(url.pathname.split("/").filter(Boolean).at(-1) || "song")}.html`;
  const targetPath = path.join(sourceDir, fileName);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Songbook Importer)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      failed += 1;
      console.log(`Failed ${rawUrl}: HTTP ${response.status}`);
      continue;
    }

    const html = await response.text();
    if (!html.includes("<html")) {
      failed += 1;
      console.log(`Failed ${rawUrl}: unexpected payload`);
      continue;
    }

    await fs.writeFile(targetPath, html, "utf8");
    success += 1;
    console.log(`Saved ${rawUrl} -> pesnipodgitaru/${fileName}`);
  } catch (error) {
    failed += 1;
    console.log(`Failed ${rawUrl}: ${error?.message || "Fetch error"}`);
  }
}

console.log(`Imported pages: ${success}`);
console.log(`Failed pages: ${failed}`);

function normalizeUrl(value) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return new URL(withProtocol);
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
