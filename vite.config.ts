import { defineConfig } from "vite";
import { rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Ship what the repository ships, and nothing that is merely lying around.
 *
 * public/assets is a staging area as much as a runtime directory: the
 * decimation pipeline writes finished tiers into it and the props ingest reads
 * them back out, so it accumulates things the game never loads — licensed tiers
 * the shelf sells, byproducts of the module authoring script, a retired model,
 * a stray LOD. Vite copies publicDir wholesale, so all of it lands in dist.
 *
 * Git tracking is the exact predicate. A file tracked here is one this
 * repository publishes; everything else is either served from
 * props.pajama.studio at runtime or is not meant to leave the machine. That
 * makes the rule self-maintaining — putting a model on the shelf untracks it,
 * which is the same act that excludes it from the bundle — and it makes the
 * deploy deterministic instead of depending on whether this machine happened to
 * run the pipeline or `npm run assets:pull`.
 *
 * Only files that exist under public/assets are considered, so the build's own
 * chunks in dist/assets are never touched.
 */
function shipOnlyTrackedAssets() {
  return {
    name: "ship-only-tracked-assets",
    apply: "build" as const,
    closeBundle() {
      const source = join(ROOT, "public/assets");
      if (!existsSync(source)) return;

      let tracked: Set<string>;
      try {
        tracked = new Set(
          execFileSync("git", ["ls-files", "public/assets"], { cwd: ROOT, encoding: "utf8" })
            .split("\n")
            .filter(Boolean)
            .map((line) => line.slice("public/assets/".length)),
        );
      } catch (error) {
        // Failing open would quietly ship every staged byte, which is the
        // outcome this plugin exists to prevent.
        throw new Error(`cannot list tracked assets, refusing to guess what to bundle: ${error}`);
      }

      let removed = 0;
      let bytes = 0;
      for (const path of walk(source)) {
        if (tracked.has(path)) continue;
        const file = join(ROOT, "dist/assets", path);
        if (!existsSync(file)) continue;
        bytes += statSync(file).size;
        rmSync(file);
        removed++;
      }
      if (removed) {
        console.log(`  not bundled (untracked — served from props, or staging): ${removed} files, ${(bytes / 1048576).toFixed(1)} MB`);
      }
    },
  };
}

/** Every file under dir, as paths relative to it. */
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

export default defineConfig({
  plugins: [shipOnlyTrackedAssets()],
});
