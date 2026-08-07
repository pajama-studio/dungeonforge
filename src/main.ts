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
import { pruneSlots, setSlotDetail } from "./scene/slots";
import { buildEnvironment } from "./scene/env";
import { flickerDamp } from "./scene/kit/materials";
import { createPost } from "./render/post";
import { Player } from "./player/player";
import { LightPool } from "./world/lights";
import { StairTowers } from "./world/stairs";
import { WalkMap } from "./world/walkmap";
import type { Ctx } from "./world/context";
import { forge } from "./world/forge";
import { forgeCube } from "./world/cube";
import { forgeMonument, type Monument } from "./world/monument";
import { Cinematic } from "./world/cinematic";
import { RoutePath } from "./world/route";
import { EndlessWorld } from "./world/stream";
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
renderer.toneMappingExposure = 1.18;
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

const ctx: Ctx = {
  scene, camera, renderer, controls, env,
  gen: new GenPool(),
  lights: new LightPool(scene),
  walk: new WalkMap(stairs),
  stairs,
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
const route = new RoutePath(ctx);

// ---- UI ---------------------------------------------------------------------
buildPanel(ctx.genParams, {
  onParams: () => void forge(ctx, ctx.state.seed),
  onEndless(on) {
    ctx.state.endless = on;
    endless.reset();
    if (on) {
      ctx.state.prCap = PR_LARGE;
      ctx.worlds.length = 0;
      ctx.walk.clear();
      ctx.stairs.clear();
      pruneSlots(new Set());
      controls.target.set(0, 3 * TH, 0);
      camera.position.set(50, 42, 70);
      ctx.state.lastExtent = 0;
    } else {
      ctx.state.prCap = PR_BASE;
      pruneSlots(new Set());
      void forge(ctx, ctx.state.seed);
    }
  },
});

const uiRng = mulberry32((Date.now() ^ 0x5f3759df) >>> 0); // UI-only randomness; the world itself is seed-pure
btnNew.addEventListener("click", () => void forge(ctx, (uiRng() * 0xffffffff) >>> 0));
btnGo.addEventListener("click", () => void forge(ctx, Number(seedInput.value) || 1));
seedInput.addEventListener("keydown", (e) => { if (e.key === "Enter") void forge(ctx, Number(seedInput.value) || 1); });

const btnCube = document.createElement("button");
btnCube.textContent = "⧉ 3×3×3";
document.getElementById("controls")!.appendChild(btnCube);
btnCube.addEventListener("click", () => void forgeCube(ctx));

const btnZig = document.createElement("button");
btnZig.textContent = "▲ Ziggurat";
document.getElementById("controls")!.appendChild(btnZig);
btnZig.addEventListener("click", () => void forgeMonument(ctx, "ziggurat"));

const btnRel = document.createElement("button");
btnRel.textContent = "◆ Reliquary";
document.getElementById("controls")!.appendChild(btnRel);
btnRel.addEventListener("click", () => void forgeMonument(ctx, "reliquary"));

const btnCine = document.createElement("button");
btnCine.textContent = "🎬";
btnCine.title = "cinematic flythrough — any input to exit";
document.getElementById("controls")!.appendChild(btnCine);
btnCine.addEventListener("click", (e) => {
  e.stopPropagation();
  cine.start(performance.now() / 1000);
});

const btnRoute = document.createElement("button");
btnRoute.textContent = "🧭";
btnRoute.title = "show the 3D route from spawn to the farthest sanctum";
document.getElementById("controls")!.appendChild(btnRoute);
btnRoute.addEventListener("click", () => {
  if (!ctx.state.endless) route.toggle();
});

// ---- skeleton route walker: the CC0 skeleton walks the whole route --------
let walking = false;
let walkU = 0, walkLen = 1, walkEndAt = 0;
let walkCurve: THREE.CatmullRomCurve3 | null = null;
const WALK_SPEED = 10;
const btnWalk = document.createElement("button");
btnWalk.textContent = "💀";
btnWalk.title = "the skeleton walks the route, start to finish (Esc stops)";
document.getElementById("controls")!.appendChild(btnWalk);
btnWalk.addEventListener("click", () => void startWalk());

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

function stopWalk(): void {
  if (!walking) return;
  walking = false;
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
  // the forge streams islands in one per frame; the loop starts as soon as the
  // shared materials are compiled, so the overlay lifts when the FIRST island
  // is on screen instead of after the whole chain.
  const mode = urlParams.get("mode");
  const forging = mode === "ziggurat" || mode === "reliquary"
    ? forgeMonument(ctx, mode as Monument)
    : forge(ctx, ctx.state.seed);
  // wait for the first island (worker gen + one build), then compile every
  // pipeline ASYNCHRONOUSLY — the GPU process compiles in parallel while
  // further islands keep streaming in; a sync first render would instead
  // block the main thread for the entire compile.
  while (ctx.worlds.length === 0) await new Promise((r) => setTimeout(r, 30));
  await renderer.compileAsync(scene, camera);
  void preloadPlayer(); // knight pipelines compile in the background
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
      const ahead = walkCurve.getPointAt(Math.min(1, walkU + 4 / walkLen));
      p.y -= 0.45; // the route tube floats a little above the floor
      const heading = Math.atan2(ahead.x - p.x, ahead.z - p.z);
      player.driveTo(p, heading, dt, walkU >= 1 ? "idle" : steep ? "walk" : "run");
      lantern.position.set(p.x, p.y + 3.1, p.z);
      // chase cam: high and pulled back — and never inside a wall column:
      // if the camera's cell is masonry, lift it above that wall's top
      const back = new THREE.Vector3(p.x - ahead.x, 0, p.z - ahead.z).normalize();
      const desired = new THREE.Vector3(p.x + back.x * 10, p.y + 9.5, p.z + back.z * 10);
      // clear the SIGHT LINE, not just the camera cell: sample wall tops along
      // camera→skeleton and rise above the tallest blocker
      for (const s of [1, 0.66, 0.33]) {
        const sx = p.x + (desired.x - p.x) * s;
        const sz = p.z + (desired.z - p.z) * s;
        desired.y = Math.max(desired.y, camClearY(sx, sz, p.y) + 2.6);
      }
      camera.position.lerp(desired, Math.min(1, dt * 3.2));
      camera.lookAt(p.x, p.y + 1.4, p.z);
      if (walkU >= 1 && walkEndAt === 0) walkEndAt = t;
      if (walkEndAt > 0 && t - walkEndAt > 2.5) stopWalk();
    } else if (cine.active) {
      cine.update(t);
    } else {
      controls.update();
    }
    for (const w of ctx.worlds) w.tick(t);
    // distance LOD: far islands drop their small-detail layers. TRUE 3D
    // distance — a camera hovering 200 units above a spire is far from every
    // island even when its xz distance is small
    let nearestD = Infinity;
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
        slotDetail.set(isl.slot, want);
        setSlotDetail(isl.slot, want);
      }
    }
    endless.update(t, controls.target);
    route.tick(); // a re-forge invalidates the drawn route
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
    if (!revealed && ctx.worlds.length > 0) {
      revealed = true;
      loadingEl.style.opacity = "0";
    }
  });
  await forging;
}

void boot();

// dev hook for camera scripting (screenshot verification, cinematics)
(window as unknown as { __df: object }).__df = {
  camera, controls, ctx,
  get walking() { return walking; },
  get walkU() { return walkU; },
  startWalk,
};
