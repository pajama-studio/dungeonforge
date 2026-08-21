# Contributing to Dungeonforge

Thanks for looking. This is a small project with strong opinions about
performance, so this file is mostly about which of those opinions you will run
into and which parts of the repo you can actually run.

## Getting it running

```sh
npm install
npm run dev        # → http://localhost:5173
```

You need a **WebGPU browser** — Chrome or Edge, or Safari 26+. There is no
WebGL fallback; the renderer is `WebGPURenderer` and the materials are TSL.

Before opening a pull request:

```sh
npm run typecheck
npm test
npm run build
```

CI runs exactly those three. Nothing else is required of you.

## What the tests actually guard

The generator is pure data with zero `three` imports, which is what makes it
testable at all. The suite pins the properties that make a build shippable:
determinism per seed, full floor connectivity by BFS, stair legality, and the
analytic height fields agreeing with the meshes built from them. If you change
generation, expect to change a golden table — several tests exist specifically
so that a change to the world's shape has to be deliberate rather than
incidental, and they say so in comments.

## What CI cannot check

**Rendering.** Headless Chromium has no working WebGPU backend for this scene:
it throws `createIndirectStorageAttribute is not a function` once instances
migrate into the GPU-driven indirect pools, and returns an empty frame. A
screenshot taken mid-assembly still shows geometry, so the failure looks like a
camera bug. It is not. Verify anything visual against a **real GPU browser**.

The harnesses in `scripts/` drive one over the Chrome DevTools Protocol. Start
Chrome with remote debugging, point it at a `npm run preview` build, then:

```sh
npm run build && npm run preview          # serves http://localhost:4173
node scripts/startup-benchmark.mjs --url localhost:4173 \
  --base-url "http://localhost:4173/" --seed 123
node scripts/composition-review.mjs --url-match localhost:4173 \
  --output /tmp/shot.png
```

`startup-benchmark.mjs` reports the app's own milestones — first visible frame,
decor ready, the longest render block, pipeline counts — which is how every
performance claim in the README was arrived at. Measure before and after;
"looks the same to me" is not a result this project accepts.

## Scripts you cannot run, and why they are here

Roughly a third of `scripts/` needs tooling or accounts that are not public.
They stay in the repo because they document how the art was actually made, not
because you are expected to execute them:

| Group | Needs | Examples |
|---|---|---|
| Mesh pipeline | Blender on your PATH | `blender-optimize-tripo.py`, `blender-bake-normals.py`, `rig-dragon-legs.py` |
| Retopology | Blender **plus** the paid Quad Remesher addon | `quad-remesh-dragon-perch.py` |
| Generation | A licensed Tripo account | `gen-titan-skull.sh`, `gen-horizon-assets.sh` |
| Asset table | A clone of the private props catalogue beside this repo | `sync-asset-urls.mjs` (`npm run assets:sync` / `assets:check`) |

Everything else — the benchmarks, the regression harnesses, `perf-benchmark.ts`,
`markov-benchmark.ts` — runs from a plain checkout.

## Where the models come from

The streamed landmark meshes are not in git. They live on a content-addressed
shelf at `props.pajama.studio`, and `src/asset-urls.json` (which **is** in git)
pins the exact bytes a build loads, so re-exporting a model changes its URL
instead of needing a cache purge. `npm run assets:pull` caches them locally and
`npm run dev:offline` then loads from that cache.

You do not need to touch any of this to work on the generator, the renderer or
the UI.

## House rules

These are load-bearing, not style preferences. `CLAUDE.md` in the parent
directory is the long version; the short version:

- **Instance everything repeated.** One draw call per model per chunk, never one
  mesh per object.
- **Cap every cost.** Instance counts, raymarch steps, view radius, pixel ratio.
  Fog far distance matches the view radius so nothing is drawn — or generated —
  beyond what is visible.
- **Deterministic generation, no `Math.random`.** Every client must compute the
  same world from the same seed. Use the seeded hashes in `src/gen/rng.ts`.
- **Analytic over raycast.** Ground height is a pure function. Never raycast a
  mesh to find the floor.
- **Share materials and geometry forever.** The WebGPU renderer compiles a
  pipeline per material; a material created after first render costs seconds.
  Anything a streamed asset will need must exist before the first compile.
- **Never change the scene's light count at runtime.** The forward path
  recompiles every pipeline when it changes. Claim from the fixed pool instead.

## Commit messages

Say what changed in the world, not which function you edited — `fix: the spawn
stood in mid-air beside its own front door` over `fix: update helpers.ts`. Look
at `git log` for the register.

## Reporting bugs

Include your **browser and GPU** (`chrome://gpu` helps), the **seed**, and the
URL — `?seed=123&islands=8&size=13` reproduces a build exactly. A seed that
misbehaves is a complete bug report on its own.
