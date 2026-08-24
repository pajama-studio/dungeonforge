import { defineConfig, type ResolvedConfig } from "vite";
import { rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assetUrls from "./src/asset-urls.json";

const ROOT = dirname(fileURLToPath(import.meta.url));

/** Warm the immutable-prop origin while the browser is still discovering the
 * main module graph. The generated URLs come from the same committed manifest
 * as assetUrl(), so a prop re-export updates both consumers in one diff.
 *
 * Preloading all three multi-megabyte landmarks is kept as an explicit
 * diagnostic mode: it makes their transfers finish sooner, but competes with
 * the smaller core props and queues all three decoders at once. The production
 * default therefore limits the hint to a connection warm-up. */
function heroAssetHints() {
  const paths = [
    "abyss/dragon/dragon-render-45k-rigged-runtime.glb",
    "abyss/dragon/titan-skull-perch-30k.glb",
    "abyss/oracle/oracle-render-30k.glb",
  ] as const;
  const urls = paths.map((path) => assetUrls[path]);
  const origin = new URL(urls[0]).origin;
  const source = `(()=>{
    window.__dfPageStartedAt ??= performance.now();
    const mode=new URLSearchParams(location.search).get("assetHints");
    if(mode==="0")return;
    const add=(rel,href,as)=>{const link=document.createElement("link");link.rel=rel;link.href=href;link.crossOrigin="anonymous";if(as)link.as=as;document.head.append(link)};
    add("preconnect",${JSON.stringify(origin)});
    if(mode!=="preload"&&mode!=="1")return;
    for(const url of ${JSON.stringify(urls)})add("preload",url,"fetch");
  })()`;
  return {
    name: "hero-asset-hints",
    transformIndexHtml() {
      return [{ tag: "script", children: source, injectTo: "head-prepend" as const }];
    },
  };
}

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
  let outDir = join(ROOT, "dist");
  return {
    name: "ship-only-tracked-assets",
    apply: "build" as const,
    configResolved(config: ResolvedConfig) {
      outDir = config.build.outDir.startsWith("/")
        ? config.build.outDir
        : join(ROOT, config.build.outDir);
    },
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
        const file = join(outDir, "assets", path);
        if (!existsSync(file)) continue;
        bytes += statSync(file).size;
        rmSync(file);
        removed++;
      }
      if (removed) {
        console.log(`  not bundled (untracked — served from props, or staging): ${removed} files, ${(bytes / 1048576).toFixed(1)} MB`);
      }
      // DRACOLoader now emits version-matched, content-hashed decoder assets
      // through the module graph. The historical public copy remains in source
      // for old/offline tooling, but no runtime URL references it and shipping
      // both sets adds 1.8 MB to every deployment.
      const legacyDraco = join(outDir, "draco");
      if (existsSync(legacyDraco)) {
        const legacyBytes = walk(legacyDraco)
          .reduce((total, path) => total + statSync(join(legacyDraco, path)).size, 0);
        rmSync(legacyDraco, { recursive: true });
        console.log(`  not bundled (superseded public Draco copy): ${(legacyBytes / 1048576).toFixed(1)} MB`);
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
  // Keep this standalone demo from inheriting a PostCSS config from a parent
  // workspace. Its styles are plain CSS and need no PostCSS plugins.
  css: { postcss: { plugins: [] } },
  plugins: [heroAssetHints(), shipOnlyTrackedAssets()],
});
