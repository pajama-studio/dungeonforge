# Dungeonforge

Procedurally generated stone-labyrinth fortress diorama — three.js **WebGPU + TSL**,
fully deterministic per seed, end-to-end in the browser.

![v6](docs/shot-v6.jpeg)

One integer seed reproduces the whole world bit-for-bit: chains of dungeon
blocks grown on a coarse macro grid — each a braided growing-tree maze with
discrete height tiers, a temple ziggurat, medallion plazas, a sunken red
chamber, a ravine + rope bridge, torch-lit walls, banners and a beacon tower —
linked by rope bridges, stacked into sky layers joined by square spiral
staircases, all validated (full floor connectivity via BFS with Δtier ≤ 1
moves, legal stairs) before anything renders.

Three world modes:

- **Chain forge** (default) — N linked blocks grown like WFC tiles; sliders
  reshape everything live.
- **⧉ 3×3×3 cube** — 27 blocks in a solid lattice; every horizontal neighbor
  bridges, every vertical pair gets a spiral stair shaft.
- **Endless ∞** — a 3×3 streamed window that follows you; blocks derive from
  `hash(seed, i, j)`, so the infinite world is consistent and free to roam.

**First-person mode**: click **⚔ Enter** — WASD/arrows to run, drag to look,
Esc back to orbit. Walkable ground is analytic everywhere (grid tiers, stair
ramps, spiral towers, bridge sag) — no mesh raycasts. The adventurer is the
CC0 [KayKit Adventurers](https://kaylousberg.com) Knight — see `LICENSES.md`
for asset credits (code is MIT).

## Run

```sh
npm install
npm run dev        # → http://localhost:5173 (?seed=123&islands=4&size=13 to pin a build)
npm test           # generator invariants: determinism, connectivity, stair legality
npm run build      # static bundle in dist/
```

## Architecture

```
src/
  config.ts        world constants (tier height, cell size, budgets, LOD bands)
  gen/             PURE-DATA generator — zero THREE imports
    dungeon.ts       the pipeline (see below); Layout in/out as typed arrays
    rng.ts           mulberry32 + stateless spatial hashes ("don't generate, hash")
    worker.ts        runs generate() off the main thread (transferable buffers)
    pool.ts          round-robin worker pool, id-tagged so stale replies drop
  scene/
    kit/             shared geometries + TSL materials, built ONCE per session
    instances.ts     InstList — raw-float instance buffers (no per-instance objects)
    slots.ts         per-slot render-object pools + distance LOD + pruning
    build.ts         Layout → instanced meshes (masonry, flames, clutter, lights)
    env.ts           sky (stars/milky way/moon), height fog, moonlight, cliff ring
  render/
    post.ts          bloom + depth-aware volumetric ground fog + vignette
  world/
    context.ts       the Ctx bag threaded through the modes
    forge.ts         chain mode        cube.ts   3×3×3 mode
    stream.ts        endless streaming mode
    spiral.ts        analytic spiral-stair math (pure, unit-tested)
    stairs.ts        stair tower meshes    walkmap.ts  analytic ground sampler
    lights.ts        fixed-size point-light pool     helpers.ts  gates/shafts
  ui/panel.ts      forge-parameter sliders
  player/player.ts first-person adventurer (GLB + ground-sampler locomotion)
  main.ts          wiring: renderer, modes, input, main loop (~250 lines)
```

- **Generator pipeline** (evidence in `docs/research.md`): growing-tree maze
  (70/30 newest/random) carving tiers clamped ±1 per passage → braiding (~45% of
  dead ends opened into loops) → landmarks stamped graph-first (temple, plazas,
  red chamber, ravine + bridge) → rasterize to a FLOOR/WALL/VOID grid →
  connectivity repair → stairs / wall heights / torch & banner min-spacing
  walks. Re-rolls a derived seed on validation failure.
- `scene/build.ts` — layout → instanced meshes. Masonry courses with per-instance
  color (baked AO + hue jitter), TSL flames / banners / medallions / portal,
  fake local torchlight (emissive wall + floor glow quads), per-island point
  lights picked by farthest-point sampling.
- `render/post.ts` — MRT **emissive-only bloom** (only flames/sigils glow, stone
  never blooms) + a 7-step depth-aware fog raymarch with moonward forward
  scattering.

## Performance notes

60 fps on an M-series laptop; cold load → first frame ≈ 0.9s (dev); re-forge ≈ 13ms.
What mattered:

- **No MSAA on the MRT post chain** (antialias: false — 4× bandwidth on two
  attachments was the killer).
- **Baked shadows**: WebGPU three has no `renderer.shadowMap.autoUpdate` — it's
  per-light: `light.shadow.autoUpdate = false` + `needsUpdate = true` per regen.
- **Shared materials/geometries** across regenerations (module-level cache):
  WebGPU pipeline compilation only ever happens once, so re-forging just refills
  instance buffers.
- **Warm-up before the loop**: `await renderer.init()` runs concurrently with
  worker generation; the loading overlay animates via compositor-driven CSS
  while the first render compiles every pipeline.
- **Zero-allocation rebuilds**: `InstList` composes instance matrices straight
  into flat `Float32Array`s (yaw-only fast path) — a forge writes tens of
  thousands of instances without creating a single `Matrix4`/`Color`; bounds
  come from the translation columns, never `computeBoundingSphere`.
- **Distance LOD with hysteresis**: far slots hide their small-detail layers and
  swap bulk masonry to low-poly boxes; ON below 95 units, OFF above 112, so a
  camera hovering at the boundary never thrashes geometry swaps.
- **Fixed light pool**: the scene always holds 28 point lights — three's WebGPU
  forward path recompiles every pipeline when the light count changes, so it
  never does; islands submit specs and the pool re-aims.
- **Background-tab-safe builds**: the per-island frame spacing falls back to a
  timeout when rAF stops (hidden tab), so a forge finishes instead of stalling.
- Light budget: 1 shadowed directional + a fixed pool of 28 unshadowed points
  shared by the whole chain; every other torch is emissive flame + wall/floor
  glow quads.
- Depth reads from **vertex-color face shading** baked into the shared block
  geometry (top/±x/±z faces each get their own value; NodeMaterial multiplies
  vertexColor × instanceColor), not from extra lights.
