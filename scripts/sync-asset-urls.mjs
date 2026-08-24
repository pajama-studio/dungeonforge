// Regenerate src/asset-urls.json — where each shipped model is actually served.
//
//   node scripts/sync-asset-urls.mjs            # write the manifest
//   node scripts/sync-asset-urls.mjs --check    # fail if it is out of date (CI)
//
// The models are not in this repository. They live on props.pajama.studio,
// whose R2 keys are content-addressed — pub/<sha>.glb — so a URL identifies
// exact bytes and the year-long immutable cache in front of it is correct
// rather than a trap. The cost of that is one indirection: the game cannot name
// a file by path, so this writes the path -> URL table it reads instead.
//
// The table is committed. That keeps the build offline, keeps the diff of an
// asset change reviewable (a changed hash is a changed model), and means the
// game never waits on a catalogue request before its first byte of geometry.
//
// Source of truth is the props catalogue for *which* files exist, and the live
// props API for *where* they are. Those can disagree — a catalogue entry that
// was never pushed, a tier that is licensed rather than public — and every way
// they disagree is an error here rather than a null in the manifest.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PROPS = resolve(ROOT, "../props");
const API = "https://props.pajama.studio/api/v1/props";
const OUT = join(ROOT, "src/asset-urls.json");

const CHECK = process.argv.includes("--check");

if (!existsSync(join(PROPS, "catalog"))) {
  console.error(`no props catalogue at ${PROPS}/catalog — clone pajama-studio/props beside this repo`);
  process.exit(1);
}

/** Every catalogue file this repo's assets are described by, flattened to
 *  (slug, variant, path) rows. Files that declare their own root are source
 *  masters living outside public/assets; the game never loads those. */
function wantedFiles() {
  const rows = [];
  for (const name of readdirSync(join(PROPS, "catalog")).filter((f) => f.endsWith(".json"))) {
    const catalog = JSON.parse(readFileSync(join(PROPS, "catalog", name), "utf8"));
    const base = resolve(PROPS, catalog.root ?? ".");
    if (base !== join(ROOT, "public/assets")) continue;
    for (const prop of catalog.props) {
      for (const file of prop.files) {
        if (file.root) continue;
        rows.push({ slug: prop.slug, variant: file.variant, path: file.path, catalog: name });
      }
    }
  }
  return rows;
}

async function main() {
  const rows = wantedFiles();
  const slugs = [...new Set(rows.map((r) => r.slug))];
  process.stdout.write(`resolving ${rows.length} files across ${slugs.length} props … `);

  const live = new Map();
  await Promise.all(
    slugs.map(async (slug) => {
      const response = await fetch(`${API}/${slug}`);
      if (!response.ok) throw new Error(`${slug}: API returned ${response.status}`);
      const body = await response.json();
      if (!body.ok) throw new Error(`${slug}: ${body.error}`);
      live.set(slug, body.data.files);
    }),
  );
  console.log("done");

  const manifest = {};
  const problems = [];
  const licensed = [];
  for (const row of rows) {
    const file = live.get(row.slug)?.find((f) => f.variant === row.variant);
    if (!file) {
      problems.push(`${row.path} — ${row.slug}/${row.variant} is in ${row.catalog} but not live; push props first`);
      continue;
    }
    // Licensed tiers are not an error. The shelf carries richer builds than the
    // game ships — the dragon's un-rigged 45k, the skull's 120k — and those are
    // sold, not served. They simply do not enter the manifest.
    //
    // What would be an error is the game asking for one, and that is caught
    // where it can actually be known: assetUrl() throws on any path that is
    // neither in this manifest nor a declared local file. A tier that gets
    // licensed later turns into a startup failure, not a silent 404.
    if (!file.url) {
      licensed.push(`${row.slug}/${row.variant}`);
      continue;
    }
    manifest[row.path] = file.url;
  }

  for (const problem of problems) console.error(`  ! ${problem}`);
  if (problems.length) {
    console.error(`\n${problems.length} unresolved — manifest not written`);
    process.exit(1);
  }
  if (licensed.length) console.log(`  licensed, not served: ${licensed.join(", ")}`);

  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  const json = JSON.stringify(sorted, null, 2) + "\n";

  if (CHECK) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== json) {
      console.error("src/asset-urls.json is out of date — run: node scripts/sync-asset-urls.mjs");
      process.exit(1);
    }
    console.log(`src/asset-urls.json is current — ${Object.keys(sorted).length} files`);
    return;
  }

  writeFileSync(OUT, json);
  console.log(`wrote src/asset-urls.json — ${Object.keys(sorted).length} files`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
