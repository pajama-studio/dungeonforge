// Put the shipped models back under public/assets, for working with no network.
//
//   node scripts/pull-assets.mjs           # fetch anything missing
//   node scripts/pull-assets.mjs --force   # re-fetch everything
//
// Then run the dev server with VITE_ASSETS_LOCAL=1 and nothing reaches for
// props.pajama.studio. These files are gitignored: this is a cache, not a
// checkout, and deleting public/assets is always safe.
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DEST = join(ROOT, "public/assets");
const FORCE = process.argv.includes("--force");

const manifest = JSON.parse(readFileSync(join(ROOT, "src/asset-urls.json"), "utf8"));
const entries = Object.entries(manifest);

const wanted = FORCE ? entries : entries.filter(([path]) => !existsSync(join(DEST, path)));
if (wanted.length === 0) {
  console.log(`all ${entries.length} models already under public/assets`);
  process.exit(0);
}
console.log(`fetching ${wanted.length} of ${entries.length} models …`);

// Six at a time: these are small files on an edge cache, and the useful limit
// is the connection rather than the server.
const CONCURRENCY = 6;
let cursor = 0;
let done = 0;
let bytes = 0;
const failures = [];

async function worker() {
  while (cursor < wanted.length) {
    const [path, url] = wanted[cursor++];
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      const target = join(DEST, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
      bytes += body.length;
      console.log(`  ${String(++done).padStart(3)}/${wanted.length}  ${path}`);
    } catch (error) {
      failures.push(`${path} — ${error.message}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, worker));

for (const failure of failures) console.error(`  ! ${failure}`);
console.log(`\n${done} fetched, ${(bytes / 1048576).toFixed(1)} MB${failures.length ? `, ${failures.length} failed` : ""}`);
if (failures.length) process.exit(1);
