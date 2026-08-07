// Dungeonforge — procedural stone-labyrinth fortress diorama.
// three.js WebGPURenderer + TSL; MRT emissive bloom; deterministic seeds.
//
// This file only wires the systems together:
//   gen/      pure-data generator (worker pool)
//   scene/    kit (shared materials/geometries), slot pools, per-layout build, env
//   world/    the three modes (chain forge / 3×3×3 cube / endless streaming)
//   render/   post chain (bloom + volumetric fog + vignette)
//   ui/       forge-parameter panel
//   player/   first-person adventurer

import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DEFAULT_PARAMS, type Params } from "./gen/dungeon";
import { GenPool } from "./gen/pool";
import { pruneSlots, setSlotDetail } from "./scene/slots";
import { buildEnvironment } from "./scene/env";
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

const postProcessing = createPost(renderer, scene, camera);

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
  if (playing) exitPlay();
  cine.start(performance.now() / 1000);
});

const btnEnter = document.createElement("button");
btnEnter.textContent = "⚔ Enter";
document.getElementById("controls")!.appendChild(btnEnter);
btnEnter.addEventListener("click", () => void (playing ? exitPlay() : enterPlay()));

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---- first-person mode ------------------------------------------------------
// the hero's lantern is a PERMANENT scene light (intensity 0 while idle):
// adding/removing a light recompiles every pipeline in three's WebGPU forward
// path — parenting it to the player and re-adding on Enter was the hitch
const lantern = new THREE.PointLight(0xffa050, 0, 11, 2);
scene.add(lantern);
let player: Player | null = null;
let playerReady: Promise<void> | null = null;
let playing = false;
let spawnX = 0, spawnZ = 0;

/** preload the adventurer right after first paint: GLB parse + skinned
 *  pipeline compilation happen in the background, parked under the abyss,
 *  so ⚔ Enter is a teleport instead of a stall */
function preloadPlayer(): Promise<void> {
  playerReady ??= (async () => {
    player = new Player();
    try { await player.load("/assets/knight.glb"); } catch { /* placeholder-only */ }
    player.group.position.set(0, -600, 0);
    scene.add(player.group);
    await renderer.compileAsync(scene, camera);
  })();
  return playerReady;
}
let camYaw = Math.PI;
let camPitch = -0.12;
const keys = new Set<string>();
addEventListener("keydown", (e: KeyboardEvent) => {
  keys.add(e.key.toLowerCase());
  if (e.key === "Escape" && playing) exitPlay();
  if (cine.active) cine.stop();
});
addEventListener("keyup", (e: KeyboardEvent) => keys.delete(e.key.toLowerCase()));
let dragging = false;
renderer.domElement.addEventListener("pointerdown", () => { dragging = true; cine.stop(); });
addEventListener("pointerup", () => { dragging = false; });
addEventListener("pointermove", (e: PointerEvent) => {
  if (playing && dragging) {
    camYaw -= e.movementX * 0.005;
    camPitch = Math.min(0.85, Math.max(-0.85, camPitch - e.movementY * 0.003));
  }
});

async function enterPlay(): Promise<void> {
  if (!ctx.walk.islands.length) return;
  await preloadPlayer(); // usually already resolved — Enter is instant
  const l0 = ctx.walk.islands[0];
  // spawn on the first medallion plaza when there is one (open, photogenic);
  // fall back to the entrance corridor
  const spawnCell = l0.l.medallions[0] ?? l0.l.entrance;
  spawnX = l0.ox + (spawnCell.x - (l0.l.N - 1) / 2) * CELL;
  spawnZ = l0.oz + (spawnCell.y - (l0.l.N - 1) / 2) * CELL;
  player!.place(spawnX, spawnZ, ctx.walk.sample);
  player!.setFirstPerson(true);
  lantern.intensity = 26;
  playing = true;
  controls.enabled = false;
  controls.autoRotate = false;
  btnEnter.textContent = "🗺 Orbit (Esc)";
}

function exitPlay(): void {
  playing = false;
  controls.enabled = true;
  lantern.intensity = 0;
  player?.group.position.set(0, -600, 0); // park — never leaves the scene
  btnEnter.textContent = "⚔ Enter";
}

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
    if (cine.active) {
      cine.update(t);
    } else if (playing && player) {
      const f = (keys.has("w") || keys.has("arrowup") ? 1 : 0) - (keys.has("s") || keys.has("arrowdown") ? 1 : 0);
      const s = (keys.has("d") || keys.has("arrowright") ? 1 : 0) - (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
      const p = player.group.position;
      player.update(dt, { f, s }, camYaw, ctx.walk.sample); // spiral stairs are plain walkable ground
      lantern.position.set(p.x, p.y + 2.2, p.z);
      if (p.y < -42) {
        // the abyss returns what it takes — to the last safe footing
        const rx = ctx.state.endless ? player.lastSafeX : spawnX;
        const rz = ctx.state.endless ? player.lastSafeZ : spawnZ;
        player.place(rx, rz, ctx.walk.sample);
      }
      // first-person camera at eye height
      camera.position.set(p.x, p.y + 1.55, p.z);
      camera.lookAt(
        p.x + Math.sin(camYaw) * Math.cos(camPitch),
        p.y + 1.55 + Math.sin(camPitch),
        p.z + Math.cos(camYaw) * Math.cos(camPitch),
      );
    } else {
      controls.update();
    }
    for (const w of ctx.worlds) w.tick(t);
    // distance LOD: far islands drop their small-detail layers. TRUE 3D
    // distance — a camera hovering 200 units above a spire is far from every
    // island even when its xz distance is small
    for (const isl of ctx.walk.islands) {
      const half = (isl.l.N * CELL) / 2;
      const d2 = Math.hypot(
        camera.position.x - isl.ox,
        camera.position.y - (isl.oy + 8),
        camera.position.z - isl.oz,
      ) - half;
      const prev = slotDetail.get(isl.slot);
      const want = prev === undefined ? d2 < LOD_NEAR : (prev ? d2 < LOD_FAR : d2 < LOD_NEAR);
      if (want !== prev) {
        slotDetail.set(isl.slot, want);
        setSlotDetail(isl.slot, want);
      }
    }
    endless.update(t, playing && player ? player.group.position : controls.target);
    ctx.lights.tick(t);
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
(window as unknown as { __df: object }).__df = { camera, controls, ctx };
