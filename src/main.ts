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
  },
};
const endless = new EndlessWorld(ctx);

// ---- UI ---------------------------------------------------------------------
buildPanel(ctx.genParams, {
  onParams: () => void forge(ctx, ctx.state.seed),
  onEndless(on) {
    ctx.state.endless = on;
    endless.reset();
    if (on) {
      renderer.setPixelRatio(Math.min(devicePixelRatio, PR_LARGE));
      ctx.worlds.length = 0;
      ctx.walk.clear();
      ctx.stairs.clear();
      pruneSlots(new Set());
      controls.target.set(0, 3 * TH, 0);
      camera.position.set(50, 42, 70);
      ctx.state.lastExtent = 0;
    } else {
      renderer.setPixelRatio(Math.min(devicePixelRatio, PR_BASE));
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
let player: Player | null = null;
let playing = false;
let spawnX = 0, spawnZ = 0;
let camYaw = Math.PI;
let camPitch = -0.12;
const keys = new Set<string>();
addEventListener("keydown", (e: KeyboardEvent) => {
  keys.add(e.key.toLowerCase());
  if (e.key === "Escape" && playing) exitPlay();
});
addEventListener("keyup", (e: KeyboardEvent) => keys.delete(e.key.toLowerCase()));
let dragging = false;
renderer.domElement.addEventListener("pointerdown", () => { dragging = true; });
addEventListener("pointerup", () => { dragging = false; });
addEventListener("pointermove", (e: PointerEvent) => {
  if (playing && dragging) {
    camYaw -= e.movementX * 0.005;
    camPitch = Math.min(0.85, Math.max(-0.85, camPitch - e.movementY * 0.003));
  }
});

async function enterPlay(): Promise<void> {
  if (!ctx.walk.islands.length) return;
  if (!player) {
    player = new Player();
    try { await player.load("/assets/knight.glb"); } catch { /* placeholder-only */ }
  }
  const l0 = ctx.walk.islands[0];
  // spawn on the first medallion plaza when there is one (open, photogenic);
  // fall back to the entrance corridor
  const spawnCell = l0.l.medallions[0] ?? l0.l.entrance;
  spawnX = l0.ox + (spawnCell.x - (l0.l.N - 1) / 2) * CELL;
  spawnZ = l0.oz + (spawnCell.y - (l0.l.N - 1) / 2) * CELL;
  player.place(spawnX, spawnZ, ctx.walk.sample);
  player.setFirstPerson(true);
  scene.add(player.group);
  playing = true;
  controls.enabled = false;
  controls.autoRotate = false;
  btnEnter.textContent = "🗺 Orbit (Esc)";
}

function exitPlay(): void {
  playing = false;
  controls.enabled = true;
  player?.group.removeFromParent();
  btnEnter.textContent = "⚔ Enter";
}

// ---- main loop --------------------------------------------------------------
// distance LOD with hysteresis (LOD_NEAR / LOD_FAR) so a camera hovering at
// the boundary never thrashes geometry swaps
const slotDetail = new Map<number, boolean>();

async function boot(): Promise<void> {
  // generation (worker) and WebGPU init run concurrently
  await Promise.all([renderer.init(), forge(ctx, ctx.state.seed)]);
  // first render compiles every pipeline (renderer.init() above makes this the
  // blessed sync path); materials are shared afterwards, so re-forging never
  // compiles again
  postProcessing.render();
  loadingEl.style.opacity = "0";
  let lastT = performance.now() / 1000;
  renderer.setAnimationLoop(() => {
    const t = performance.now() / 1000;
    const dt = Math.min(0.05, t - lastT);
    lastT = t;
    if (playing && player) {
      const f = (keys.has("w") || keys.has("arrowup") ? 1 : 0) - (keys.has("s") || keys.has("arrowdown") ? 1 : 0);
      const s = (keys.has("d") || keys.has("arrowright") ? 1 : 0) - (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
      const p = player.group.position;
      player.update(dt, { f, s }, camYaw, ctx.walk.sample); // spiral stairs are plain walkable ground
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
    // distance LOD: far islands drop their small-detail layers
    for (const isl of ctx.walk.islands) {
      const half = (isl.l.N * CELL) / 2;
      const d2 = Math.hypot(camera.position.x - isl.ox, camera.position.z - isl.oz) - half;
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
  });
}

void boot();

// dev hook for camera scripting (screenshot verification, cinematics)
(window as unknown as { __df: object }).__df = { camera, controls, ctx };
