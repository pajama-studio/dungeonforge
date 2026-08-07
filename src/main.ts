// Dungeonforge — procedural stone-labyrinth fortress diorama.
// three.js WebGPURenderer + TSL; MRT emissive bloom; deterministic seeds.
//
// This file only wires the systems together:
//   gen/      pure-data generator (worker pool)
//   scene/    kit (shared materials/geometries), slot pools, per-layout build, env
//   world/    the three modes (chain forge / 3×3×3 cube / endless streaming)
//   render/   post chain (bloom + volumetric fog + vignette)
//   ui/       forge-parameter panel
//   player/   the skeleton (route walker)

import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DEFAULT_PARAMS, type Params } from "./gen/dungeon";
import { GenPool } from "./gen/pool";
import {
  pruneSlots, setSlotDetail, setDecorSuppressed, revealDecor,
  decorWarmupRig, stageActualDetailWarmup, setOccludingSlots,
} from "./scene/slots";
import { buildEnvironment } from "./scene/env";
import { flickerDamp } from "./scene/kit/materials";
import { createPost } from "./render/post";
import { Player } from "./player/player";
import { LightPool } from "./world/lights";
import { StairTowers } from "./world/stairs";
import { DungeonActors } from "./world/actors";
import { WalkMap } from "./world/walkmap";
import type { Ctx } from "./world/context";
import { forge } from "./world/forge";
import { forgeCube } from "./world/cube";
import { forgeMonument, type Monument } from "./world/monument";
import { Cinematic } from "./world/cinematic";
import { RoutePath } from "./world/route";
import { NavMesh, NavOverlay } from "./world/nav";
import { EndlessWorld } from "./world/stream";
import { GpuDestruction } from "./world/destruction";
import { buildPanel } from "./ui/panel";
import { mulberry32 } from "./gen/rng";
import { TH, CELL, PR_BASE, PR_LARGE, LOD_NEAR, LOD_FAR } from "./config";

const app = document.getElementById("app")!;
const loadingEl = document.getElementById("loading")!;
const btnNew = document.getElementById("btnNew") as HTMLButtonElement;
const btnGo = document.getElementById("btnGo") as HTMLButtonElement;
const seedInput = document.getElementById("seedInput") as HTMLInputElement;

const urlParams = new URLSearchParams(location.search);

// ---- renderer / camera / controls -------------------------------------------
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.5, 400);
camera.position.set(46, 36, 66); // lower, more oblique — facades and height read stronger

const renderer = new THREE.WebGPURenderer({ antialias: false }); // MSAA × the post chain is the fill-rate killer
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, PR_BASE));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // static baked shadows — soft PCF not worth the taps
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.24; // key up: hemi fill dropped for contrast, torch pools carry the warmth
app.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 3 * TH, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = 1.38;
controls.minDistance = 18;
controls.maxDistance = 170;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;
renderer.domElement.addEventListener("pointerdown", () => { controls.autoRotate = false; });

const { post: postProcessing, setBloom } = createPost(renderer, scene, camera);

// ---- world context ----------------------------------------------------------
const env = buildEnvironment(scene, 1); // env is seed-stable; kept across regens
const stairs = new StairTowers(scene);
const actors = new DungeonActors(scene, camera, renderer.domElement);

const ctx: Ctx = {
  scene, camera, renderer, controls, env,
  gen: new GenPool(),
  lights: new LightPool(scene),
  walk: new WalkMap(stairs),
  stairs,
  actors,
  worlds: [],
  genParams: {
    ...DEFAULT_PARAMS,
    // shareable URL overrides, e.g. ?seed=7&islands=4&size=13
    ...(urlParams.has("islands") ? { islands: Number(urlParams.get("islands")) || 1 } : {}),
    ...(urlParams.has("size") ? { size: Number(urlParams.get("size")) || DEFAULT_PARAMS.size } : {}),
  } as Params,
  hud: {
    name: document.getElementById("dungeonName")!,
    seed: document.getElementById("seedLabel")!,
  },
  state: {
    seed: Number(urlParams.get("seed")) || 20260806,
    endless: false,
    lastExtent: 0,
    token: 0,
    prCap: PR_BASE,
  },
};
const endless = new EndlessWorld(ctx);
const cine = new Cinematic(ctx);
const nav = new NavMesh(ctx);
const navOverlay = new NavOverlay(ctx, nav);
const route = new RoutePath(ctx, nav);
const destruction = new GpuDestruction(
  scene, camera, renderer, renderer.domElement,
  () => ctx.walk.touch(),
);

// ---- UI ---------------------------------------------------------------------
// Hierarchy: the WORLD (bottom-left: ⚄ New, seed, mode segments) · the VIEW
// (bottom-right toggles: 🎬🧭🕸💀) · TUNING (⚙ slides in the grouped panel).

type Mode = "chain" | "cube" | "ziggurat" | "reliquary" | "endless";
let activeMode: Mode = "chain";
const modeSeg = document.getElementById("modeSeg")!;
const modeBtns = Array.from(modeSeg.querySelectorAll<HTMLButtonElement>("button"));

function setModeActive(mode: Mode): void {
  activeMode = mode;
  for (const b of modeBtns) b.classList.toggle("active", b.dataset.mode === mode);
}

function enterEndless(): void {
  ctx.state.endless = true;
  ctx.hud.name.textContent = "the Endless Reach";
  ctx.hud.seed.textContent = `seed ${ctx.state.seed} · endless ∞ · roam to generate`;
  endless.reset();
  ctx.state.prCap = PR_LARGE;
  ctx.worlds.length = 0;
  ctx.walk.clear();
  ctx.stairs.clear();
  pruneSlots(new Set());
  controls.target.set(0, 3 * TH, 0);
  camera.position.set(50, 42, 70);
  ctx.state.lastExtent = 0;
}

function exitEndless(): void {
  ctx.state.endless = false;
  endless.reset();
  ctx.state.prCap = PR_BASE;
  pruneSlots(new Set());
}

/** rebuild the world in the ACTIVE mode (mode clicks and slider moves) */
function reforge(): void {
  stopWalk();
  if (activeMode === "endless") { exitEndless(); enterEndless(); return; }
  if (ctx.state.endless) exitEndless();
  if (activeMode === "cube") void forgeCube(ctx);
  else if (activeMode === "ziggurat" || activeMode === "reliquary") void forgeMonument(ctx, activeMode);
  else void forge(ctx, ctx.state.seed);
}

for (const b of modeBtns) {
  b.addEventListener("click", () => {
    if (activeMode === b.dataset.mode) return;
    setModeActive(b.dataset.mode as Mode);
    reforge();
  });
}

buildPanel(ctx.genParams, { onParams: reforge });

const uiRng = mulberry32((Date.now() ^ 0x5f3759df) >>> 0); // UI-only randomness; the world itself is seed-pure
function forgeSeed(seed: number): void {
  ctx.state.seed = seed;
  if (activeMode === "endless") setModeActive("chain");
  reforge();
}
btnNew.addEventListener("click", () => forgeSeed((uiRng() * 0xffffffff) >>> 0));
btnGo.addEventListener("click", () => forgeSeed(Number(seedInput.value) || 1));
seedInput.addEventListener("keydown", (e) => { if (e.key === "Enter") forgeSeed(Number(seedInput.value) || 1); });

// view tools (toggles, active-state synced each frame in the main loop)
const btnCine = document.getElementById("btnCine") as HTMLButtonElement;
const btnRoute = document.getElementById("btnRoute") as HTMLButtonElement;
const btnNav = document.getElementById("btnNav") as HTMLButtonElement;
const btnWalk = document.getElementById("btnWalk") as HTMLButtonElement;
const btnBreak = document.getElementById("btnBreak") as HTMLButtonElement;
btnCine.addEventListener("click", (e) => {
  e.stopPropagation();
  if (cine.active) cine.stop();
  else cine.start(performance.now() / 1000);
});
btnRoute.addEventListener("click", () => { if (!ctx.state.endless) route.toggle(); });
btnNav.addEventListener("click", () => { if (!ctx.state.endless) navOverlay.toggle(); });
btnWalk.addEventListener("click", () => { if (walking) stopWalk(); else void startWalk(); });
btnBreak.addEventListener("click", () => {
  destruction.toggle();
  btnBreak.classList.toggle("active", destruction.enabled);
  document.getElementById("tip")!.textContent = destruction.enabled
    ? "click masonry to fracture · drag still orbits · X exits"
    : "drag to orbit · scroll to zoom · Esc stops";
});

// ⚙ params panel: collapsed by default, slides in from the right
const paramsEl = document.getElementById("params")!;
const btnParams = document.getElementById("btnParams") as HTMLButtonElement;
btnParams.addEventListener("click", () => {
  const open = paramsEl.classList.toggle("closed");
  btnParams.classList.toggle("active", !open);
});
document.getElementById("btnParamsClose")!.addEventListener("click", () => {
  paramsEl.classList.add("closed");
  btnParams.classList.remove("active");
});

// ---- skeleton route walker: the CC0 skeleton walks the whole route --------
let walking = false;
let walkU = 0, walkLen = 1, walkEndAt = 0;
let walkCurve: THREE.CatmullRomCurve3 | null = null;
const WALK_SPEED = 6.5; // unhurried — the tour is a guided showing, not a race
const camBack = new THREE.Vector3(0, 0, 1); // smoothed chase direction

async function startWalk(): Promise<void> {
  if (ctx.state.endless) return;
  await preloadPlayer();
  const rc = route.ensure();
  if (!rc || !player) return;
  cine.stop();
  route.show();
  walkCurve = rc.curve;
  walkLen = rc.length;
  walkU = 0;
  walkEndAt = 0;
  const t0 = rc.curve.getTangentAt(0);
  camBack.set(-t0.x, 0, -t0.z).normalize(); // chase cam starts already behind
  player.setFirstPerson(false);
  lantern.intensity = 11;
  setBloom(0.5); // close-up flames would bloom too hot at full strength
  walking = true;
  controls.enabled = false;
  controls.autoRotate = false;
}

/** the wall-top height at (x,z) near refY — 0 when open air/floor */
function camClearY(x: number, z: number, refY: number): number {
  let top = 0;
  for (const isl of ctx.walk.islands) {
    const N = isl.l.N;
    const gx = Math.round((x - isl.ox) / CELL + (N - 1) / 2);
    const gy = Math.round((z - isl.oz) / CELL + (N - 1) / 2);
    if (gx < 0 || gy < 0 || gx >= N || gy >= N) continue;
    if (Math.abs(isl.oy - (refY - 6)) > 26) continue; // other layers don't block
    const c = gy * N + gx;
    if (isl.l.kind[c] === 2) top = Math.max(top, isl.oy + isl.l.wallTop[c] * TH);
  }
  return top;
}

interface OccludingArchitecture { slots: Set<number>; stairs: Set<number> }

/** Cheap analytic line-of-sight returning the architecture to fade. The
 * character is never duplicated or made transparent. */
function skeletonOccluders(): OccludingArchitecture {
  const hits: OccludingArchitecture = { slots: new Set(), stairs: new Set() };
  if (!player) return hits;
  const p = player.group.position;
  const tx = p.x, ty = p.y + 1.45, tz = p.z;
  const dx = tx - camera.position.x, dy = ty - camera.position.y, dz = tz - camera.position.z;
  const steps = Math.max(5, Math.min(34, Math.ceil(Math.hypot(dx, dy, dz) / (CELL * 0.5))));
  for (let s = 1; s < steps; s++) {
    const u = s / steps;
    const x = camera.position.x + dx * u;
    const y = camera.position.y + dy * u;
    const z = camera.position.z + dz * u;
    for (const blocker of ctx.walk.blockers) {
      if (y < blocker.y0 - 0.2 || y > blocker.y1 + 0.2) continue;
      if (Math.hypot(x - blocker.x, z - blocker.z) <= blocker.radius && blocker.slot !== undefined) {
        hits.slots.add(blocker.slot);
      }
    }
    for (let towerIndex = 0; towerIndex < ctx.stairs.towers.length; towerIndex++) {
      const tower = ctx.stairs.towers[towerIndex];
      if (y < tower.y0 || y > tower.y1 + 2) continue;
      if (Math.max(Math.abs(x - tower.x), Math.abs(z - tower.z)) < tower.core) hits.stairs.add(towerIndex);
    }
    for (const isl of ctx.walk.islands) {
      const N = isl.l.N;
      const gx = Math.round((x - isl.ox) / CELL + (N - 1) / 2);
      const gy = Math.round((z - isl.oz) / CELL + (N - 1) / 2);
      if (gx < 0 || gy < 0 || gx >= N || gy >= N) continue;
      const c = gy * N + gx;
      if (isl.l.kind[c] !== 2 || isl.l.shaftMask[c]) continue;
      const lo = isl.oy + isl.l.wallBase[c] * TH;
      const hi = isl.oy + isl.l.wallTop[c] * TH;
      if (y > lo && y < hi) hits.slots.add(isl.slot);
    }
  }
  return hits;
}

function stopWalk(): void {
  if (!walking) return;
  walking = false;
  setOccludingSlots(new Set());
  ctx.stairs.setOccluded(new Set());
  lantern.intensity = 0;
  setBloom(0.9);
  player?.group.position.set(0, -600, 0);
  controls.enabled = true;
}

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---- the skeleton & his lantern ---------------------------------------------
// the lantern is a PERMANENT scene light (intensity 0 while idle): adding or
// removing a light recompiles every pipeline in three's WebGPU forward path
const lantern = new THREE.PointLight(0xffa050, 0, 11, 2);
scene.add(lantern);
let player: Player | null = null;
let playerReady: Promise<void> | null = null;

/** preload the skeleton right after first paint: GLB parse + skinned
 *  pipeline compilation happen in the background, parked under the abyss,
 *  so 💀 starts instantly */
function preloadPlayer(): Promise<void> {
  playerReady ??= (async () => {
    player = new Player();
    try { await player.load("/assets/skeleton.glb"); } catch { /* placeholder-only */ }
    player.group.position.set(0, -600, 0);
    scene.add(player.group);
    await renderer.compileAsync(scene, camera);
  })();
  return playerReady;
}
addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape" && walking) stopWalk();
  if (e.key.toLowerCase() === "x" && !(e.target instanceof HTMLInputElement)) btnBreak.click();
  if (cine.active) cine.stop();
});
renderer.domElement.addEventListener("pointerdown", () => { cine.stop(); });

// ---- main loop --------------------------------------------------------------
// distance LOD with hysteresis (LOD_NEAR / LOD_FAR) so a camera hovering at
// the boundary never thrashes geometry swaps
const slotDetail = new Map<number, boolean>();

// adaptive resolution: fill rate is the budget. Walk pixelRatio in small
// steps between 1.0 and the mode cap, driven by an EMA of the frame time —
// heavy views trade a little sharpness for smoothness, light views win it
// back. Adjust at most once a second (setPixelRatio reallocates targets).
let dprNow = Math.min(devicePixelRatio, PR_BASE);
let frameEma = 16.7;
let lastDprAdj = 0;
let decorReady = false;
let lodToken = -1;
let lastOcclusionCheck = 0;
function adaptResolution(t: number, rawMs: number): void {
  frameEma = frameEma * 0.95 + Math.min(rawMs, 50) * 0.05; // clamp forge hitches
  if (t - lastDprAdj < 1) return;
  const cap = Math.min(devicePixelRatio, ctx.state.prCap);
  let next = dprNow;
  // floor 0.85: the controller only walks down while frames are actually
  // over budget, and under bloom + fog the softness is invisible
  if (frameEma > 19 && dprNow > 0.85) next = Math.max(0.85, dprNow - 0.125);
  else if (frameEma < 14 && dprNow < cap) next = Math.min(cap, dprNow + 0.125);
  else if (dprNow > cap) next = cap;
  if (next !== dprNow) {
    dprNow = next;
    renderer.setPixelRatio(dprNow);
    lastDprAdj = t;
  }
}

async function boot(): Promise<void> {
  await renderer.init();
  await destruction.warmup();
  // TWO-WAVE first paint. The cold-load wall is driver pipeline compilation
  // (~25 node materials with a 28-light loop each). Wave 1 hides every
  // decorative layer (vegetation, banners, glows, medallions, smoke, ropes…)
  // so the first compile only covers the core look — the overlay lifts
  // seconds earlier. Wave 2 then warms the remaining pipelines on PARKED
  // PROXY meshes and unhides the real layers only once they're compiled.
  setDecorSuppressed(true);
  const mode = urlParams.get("mode");
  if (mode === "ziggurat" || mode === "reliquary") setModeActive(mode);
  let forgeErr: unknown = null;
  const forging = (mode === "ziggurat" || mode === "reliquary"
    ? forgeMonument(ctx, mode as Monument)
    : forge(ctx, ctx.state.seed)
  ).catch((e) => { forgeErr = e; console.error("[forge] failed:", e); });
  while (ctx.worlds.length === 0 && forgeErr === null) await new Promise((r) => setTimeout(r, 30));
  await renderer.compileAsync(scene, camera); // wave 1: core look only
  void preloadPlayer(); // skeleton pipelines compile in the background
  void (async () => {
    await forging;
    // Warm the REAL pooled objects on a camera-isolated layer. Proxies still
    // cover unique/non-instanced layouts, while actual slot objects eliminate
    // the first-approach WebGPU compilation hitch.
    const warmLayer = 29;
    const cameraLayerMask = camera.layers.mask;
    camera.layers.set(warmLayer);
    const restoreActual = stageActualDetailWarmup(warmLayer);
    const restoreStairFade = ctx.stairs.stageFadeWarmup(warmLayer);
    const dispose = decorWarmupRig(scene, warmLayer);
    await renderer.compileAsync(scene, camera);
    // compileAsync prepares shader pipelines but WebGPU can still defer
    // render-object/binding realization until submission. Two real isolated
    // draws, covered by the loading veil, move that driver work out of the
    // user's first zoom. Waiting the queue makes `decorReady` a hard promise.
    const queue = (renderer.backend as unknown as {
      device?: { queue?: { onSubmittedWorkDone?: () => Promise<void> } };
    }).device?.queue;
    // Use the REAL post scene pass: its offscreen color/depth target format is
    // part of the WebGPU pipeline key, so warming the canvas framebuffer alone
    // does not cover the pipeline used during gameplay.
    postProcessing.render();
    await (queue?.onSubmittedWorkDone?.() ?? Promise.resolve());
    postProcessing.render();
    await (queue?.onSubmittedWorkDone?.() ?? Promise.resolve());
    restoreActual();
    restoreStairFade();
    dispose();
    camera.layers.mask = cameraLayerMask;
    revealDecor();
    decorReady = true;
    slotDetail.clear(); // let distance LOD re-apply to the revealed layers
    ctx.env.bakeShadows();
  })();
  let revealed = false;
  let lastT = performance.now() / 1000;
  renderer.setAnimationLoop(() => {
    const t = performance.now() / 1000;
    const rawMs = (t - lastT) * 1000;
    const dt = Math.min(0.05, t - lastT);
    lastT = t;
    adaptResolution(t, rawMs);
    if (walking && player && walkCurve) {
      // stairs & steep ramps: slow to a walk cycle (no climb clip in the pack)
      const pNow = walkCurve.getPointAt(walkU);
      const near = walkCurve.getPointAt(Math.min(1, walkU + 2 / walkLen));
      const steep = Math.abs(near.y - pNow.y) > Math.hypot(near.x - pNow.x, near.z - pNow.z) * 0.4;
      walkU = Math.min(1, walkU + ((steep ? WALK_SPEED * 0.45 : WALK_SPEED) * dt) / walkLen);
      const p = walkCurve.getPointAt(walkU);
      // SHORT lookahead on stairs: the heading then follows the helix around
      // the tower (a long lookahead cuts across the core and the body faces
      // the wrong way); driveTo smooths the turn so it reads as leaning in
      const ahead = walkCurve.getPointAt(Math.min(1, walkU + (steep ? 1.1 : 4) / walkLen));
      // GROUND CONTACT: xz follows the curve, but y snaps to the analytic
      // ground sampler (exact stair ramps, spiral tread line, bridge sag) —
      // the smoothed curve alone would sink feet into stair treads
      const g = ctx.walk.sample(p.x, p.z, p.y);
      if (g.ok && Math.abs(g.y - (p.y - 0.45)) < 2.2) p.y = g.y;
      else p.y -= 0.45;
      const heading = Math.atan2(ahead.x - p.x, ahead.z - p.z);
      player.driveTo(p, heading, dt, walkU >= 1 ? "idle" : steep ? "walk" : "run");
      lantern.position.set(p.x, p.y + 3.1, p.z);
      // chase cam: high, pulled back, and CALM — the chase direction is its
      // own smoothed vector, so on spiral stairs the camera drifts up slowly
      // above the tower while the skeleton corkscrews below, instead of
      // whirling around with every helix turn
      const backT = new THREE.Vector3(p.x - ahead.x, 0, p.z - ahead.z).normalize();
      camBack.lerp(backT, Math.min(1, dt * (steep ? 0.9 : 3.0))).normalize();
      const dist = steep ? 8.5 : 10, lift = steep ? 12.5 : 9.5;
      const desired = new THREE.Vector3(p.x + camBack.x * dist, p.y + lift, p.z + camBack.z * dist);
      // clear the SIGHT LINE, not just the camera cell: sample wall tops along
      // camera→skeleton and rise above the tallest blocker
      for (const s of [1, 0.66, 0.33]) {
        const sx = p.x + (desired.x - p.x) * s;
        const sz = p.z + (desired.z - p.z) * s;
        desired.y = Math.max(desired.y, camClearY(sx, sz, p.y) + 2.6);
      }
      camera.position.lerp(desired, Math.min(1, dt * 3.2));
      camera.lookAt(p.x, p.y + 1.4, p.z);
      if (t - lastOcclusionCheck > 0.08) {
        lastOcclusionCheck = t;
        const occluders = skeletonOccluders();
        setOccludingSlots(occluders.slots);
        ctx.stairs.setOccluded(occluders.stairs);
      }
      if (walkU >= 1 && walkEndAt === 0) walkEndAt = t;
      if (walkEndAt > 0 && t - walkEndAt > 2.5) stopWalk();
    } else if (cine.active) {
      cine.update(t);
    } else {
      controls.update();
    }
    for (const w of ctx.worlds) w.tick(t);
    ctx.actors.tick(t, dt);
    destruction.tick(dt);
    // distance LOD: far islands drop their small-detail layers. TRUE 3D
    // distance — a camera hovering 200 units above a spire is far from every
    // island even when its xz distance is small
    if (lodToken !== ctx.state.token) {
      lodToken = ctx.state.token;
      slotDetail.clear();
      destruction.reset();
    }
    let nearestD = Infinity;
    let lodSlot = -1, lodWant = false, lodPriority = Infinity;
    for (const isl of ctx.walk.islands) {
      const half = (isl.l.N * CELL) / 2;
      const d2 = Math.hypot(
        camera.position.x - isl.ox,
        camera.position.y - (isl.oy + 8),
        camera.position.z - isl.oz,
      ) - half;
      nearestD = Math.min(nearestD, d2);
      const prev = slotDetail.get(isl.slot);
      const want = prev === undefined ? d2 < LOD_NEAR : (prev ? d2 < LOD_FAR : d2 < LOD_NEAR);
      if (want !== prev) {
        // At most ONE island crosses LOD per frame. Entering chooses the
        // nearest pending island; leaving chooses the farthest. This caps the
        // render-work delta even when a zoom crosses several stacked layers.
        const priority = want ? d2 : -d2;
        if (priority < lodPriority) { lodPriority = priority; lodSlot = isl.slot; lodWant = want; }
      }
    }
    if (lodSlot >= 0) {
      slotDetail.set(lodSlot, lodWant);
      setSlotDetail(lodSlot, lodWant);
    }
    endless.update(t, controls.target);
    route.tick(); // a re-forge invalidates the drawn route
    navOverlay.tick();
    // toggle highlights follow the real state (route/nav can self-hide on
    // re-forge; cine exits on any input) — classList.toggle no-ops if unchanged
    btnCine.classList.toggle("active", cine.active);
    btnRoute.classList.toggle("active", route.visible);
    btnNav.classList.toggle("active", navOverlay.visible);
    btnWalk.classList.toggle("active", walking);
    btnBreak.classList.toggle("active", destruction.enabled);
    // distance calms the flicker: near 60 units torches dance at full
    // amplitude; past ~150 they settle to a steady candle glow (dozens of
    // asynchronous flickers read as an uncomfortable shimmer from afar)
    const damp = Math.min(1, Math.max(0.1, 1 - (nearestD - 60) / 90));
    flickerDamp.value = damp;
    ctx.lights.tick(t, damp);
    const r0 = performance.now();
    postProcessing.render();
    const rDur = performance.now() - r0;
    if (rDur > 100) console.log(`[frame] render() blocked ${rDur.toFixed(0)}ms`);
    if (!revealed && ctx.worlds.length > 0 && decorReady) {
      revealed = true;
      loadingEl.style.opacity = "0";
    }
  });
  await forging;
}

void boot();

// dev hook for camera scripting (screenshot verification, cinematics)
(window as unknown as { __df: object }).__df = {
  camera, controls, ctx, postProcessing, nav, route,
  get player() { return player; },
  skeletonOccluders,
  get walking() { return walking; },
  get walkU() { return walkU; },
  get decorReady() { return decorReady; },
  destruction,
  setAllDetail(visible: boolean) {
    for (const island of ctx.walk.islands) setSlotDetail(island.slot, visible);
  },
  startWalk,
};
