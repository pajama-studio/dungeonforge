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
import { ClusteredLighting } from "three/addons/lighting/ClusteredLighting.js";
import { DEFAULT_PARAMS, type Params } from "./gen/dungeon";
import { GenPool } from "./gen/pool";
import {
  pruneSlots, setSlotDetail, setSlotLodLevel, setDecorSuppressed, revealDecor,
  setOccludingSlots, areSlotsLodWarm, stageSlotLodWarmup,
  type LodLevel,
} from "./scene/slots";
import { buildEnvironment } from "./scene/env";
import { flickerDamp, loadHandPaintedStoneTexture, setOcclusionWindow, stoneStyle } from "./scene/kit/materials";
import { createPost } from "./render/post";
import { GpuMasonryScene } from "./render/gpu-scene";
import { Player } from "./player/player";
import { LightPool } from "./world/lights";
import { StairTowers } from "./world/stairs";
import { DungeonActors } from "./world/actors";
import { WalkMap } from "./world/walkmap";
import type { Ctx, ForgeStage, ForgeStageDetail } from "./world/context";
import { forge } from "./world/forge";
import { forgeCube } from "./world/cube";
import { forgeMonument, type Monument } from "./world/monument";
import { Cinematic } from "./world/cinematic";
import { RoutePath } from "./world/route";
import { NavMesh, NavOverlay } from "./world/nav";
import { EndlessWorld } from "./world/stream";
import { GpuDestruction } from "./world/destruction";
import { RogueRun, type RelicKind, type RelicReward } from "./game/roguelike";
import { playerInputFromKeys } from "./player/input";
import { buildPanel } from "./ui/panel";
import { mulberry32 } from "./gen/rng";
import {
  TH, CELL, PR_BASE, PR_LARGE,
  LOD_NEAR, LOD_FAR, LOD_MID_NEAR, LOD_MID_FAR,
} from "./config";

const app = document.getElementById("app")!;
const loadingEl = document.getElementById("loading")!;
const btnNew = document.getElementById("btnNew") as HTMLButtonElement;
const btnGo = document.getElementById("btnGo") as HTMLButtonElement;
const seedInput = document.getElementById("seedInput") as HTMLInputElement;
const forgeSnapshot = document.getElementById("forgeSnapshot") as HTMLCanvasElement;
const forgeStatusEl = document.getElementById("forgeStatus")!;
const forgeStatusTitle = forgeStatusEl.querySelector<HTMLElement>(".forge-title")!;
const forgeStatusMeta = forgeStatusEl.querySelector<HTMLElement>(".forge-meta")!;
const forgeProgress = forgeStatusEl.querySelector<HTMLElement>(".forge-progress")!;
const forgeProgressFill = forgeProgress.querySelector<HTMLElement>("i")!;
const forgeStatusSteps = Array.from(forgeStatusEl.querySelectorAll<HTMLElement>(".forge-steps i"));
const runHud = document.getElementById("runHud")!;
const runFloorEl = document.getElementById("runFloor")!;
const runHpEl = document.getElementById("runHp")!;
const runHpFill = document.getElementById("runHpFill")!;
const runAttackEl = document.getElementById("runAttack")!;
const runShardsEl = document.getElementById("runShards")!;
const runObjectiveEl = document.getElementById("runObjective")!;
const runToast = document.getElementById("runToast")!;
const runReward = document.getElementById("runReward")!;
const runRewardOptions = document.getElementById("runRewardOptions")!;

const urlParams = new URLSearchParams(location.search);

// ---- renderer / camera / controls -------------------------------------------
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.5, 400);
camera.position.set(46, 36, 66); // lower, more oblique — facades and height read stronger

const renderer = new THREE.WebGPURenderer({ antialias: false }); // MSAA × the post chain is the fill-rate killer
// 100-loop A/B: Forward+ reduced the identical 16-light scene from 17.61 ms
// median to 4.01 ms (P95 22.96 -> 8.60), with matching output and zero GPU
// errors. `?clustered=0` remains as a driver-triage fallback.
if (urlParams.get("clustered") !== "0") {
  renderer.lighting = new ClusteredLighting(32, 64, 16, 16);
}
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

const { post: postProcessing, setBloom } = createPost(renderer, scene, camera, {
  ambientOcclusion: urlParams.get("ao") === "1",
});

interface ForgeRunRecord {
  token: number;
  seed: number;
  mode: string;
  stage: ForgeStage;
  startedAt: number;
  stageStartedAt: number;
  completedAt: number;
  timings: Partial<Record<ForgeStage, number>>;
  detail: string;
  error: string;
}

const forgeStageOrder: ForgeStage[] = ["requested", "generating", "assembling", "gpu-upload", "ready"];
const forgeRuns: ForgeRunRecord[] = [];
let activeForgeRun: ForgeRunRecord | null = null;
let reforgeSerial = 0;
let forgeStatusHideTimer = 0;

function renderForgeStatus(run: ForgeRunRecord, completed?: number, total?: number): void {
  const titles: Record<ForgeStage, string> = {
    requested: "Shuffle queued",
    generating: "Generating maze",
    assembling: "Assembling scene",
    "gpu-upload": "Uploading to GPU",
    ready: "Dungeon ready",
    failed: "Shuffle failed",
  };
  const elapsed = performance.now() - run.startedAt;
  const ratio = total && total > 0 ? Math.min(1, Math.max(0, (completed ?? 0) / total)) : 0;
  const stageProgress: Record<ForgeStage, number> = {
    requested: 0.03,
    generating: 0.1 + ratio * 0.07,
    assembling: 0.17 + ratio * 0.7,
    "gpu-upload": 0.94,
    ready: 1,
    failed: 1,
  };
  const progress = stageProgress[run.stage];
  forgeStatusTitle.textContent = titles[run.stage];
  forgeStatusMeta.textContent = `${total && total > 0 ? `${Math.min(completed ?? 0, total)}/${total} · ` : ""}${Math.round(elapsed)}ms${run.detail ? ` · ${run.detail}` : ""}`;
  forgeProgressFill.style.transform = `scaleX(${progress})`;
  forgeProgress.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  forgeStatusEl.classList.toggle("busy", run.stage !== "ready" && run.stage !== "failed");
  forgeStatusEl.classList.toggle("failed", run.stage === "failed");
  forgeStatusEl.classList.remove("settled");
  window.clearTimeout(forgeStatusHideTimer);
  if (run.stage === "ready") {
    const token = run.token;
    forgeStatusHideTimer = window.setTimeout(() => {
      if (activeForgeRun?.token === token && activeForgeRun.stage === "ready") forgeStatusEl.classList.add("settled");
    }, 900);
  }
  forgeStatusEl.dataset.stage = run.stage;
  const activeIndex = run.stage === "failed" ? -1 : forgeStageOrder.indexOf(run.stage);
  for (let i = 0; i < forgeStatusSteps.length; i++) {
    forgeStatusSteps[i].classList.toggle("done", activeIndex >= 0 && i < activeIndex);
    forgeStatusSteps[i].classList.toggle("active", activeIndex >= 0 && i === activeIndex);
  }
  const busy = run.stage !== "ready" && run.stage !== "failed";
  btnNew.setAttribute("aria-busy", String(busy));
  btnNew.textContent = busy ? "⚒ Shuffling…" : "⚄ New dungeon";
  btnGo.disabled = busy;
  seedInput.disabled = busy;
}

function reportForgeStage(stage: ForgeStage, detail: ForgeStageDetail): void {
  // A superseded asynchronous build may finish a late pacer tick. Its status
  // must never overwrite the newer seed's lifecycle.
  if (activeForgeRun && detail.token < activeForgeRun.token) return;
  const now = performance.now();
  if (!activeForgeRun || activeForgeRun.token !== detail.token) {
    activeForgeRun = {
      token: detail.token,
      seed: detail.seed,
      mode: detail.mode,
      stage,
      startedAt: now,
      stageStartedAt: now,
      completedAt: 0,
      timings: {},
      detail: detail.detail ?? "",
      error: detail.error ?? "",
    };
    forgeRuns.push(activeForgeRun);
    // Bounded telemetry: enough for regressions without leaking across a long
    // endless editing session.
    if (forgeRuns.length > 32) forgeRuns.splice(0, forgeRuns.length - 32);
  } else if (activeForgeRun.stage === stage) {
    // Progress updates inside one semantic stage must not reset that stage's
    // timer; only the detail/count changes.
    activeForgeRun.detail = detail.detail ?? activeForgeRun.detail;
    activeForgeRun.error = detail.error ?? activeForgeRun.error;
  } else {
    activeForgeRun.timings[activeForgeRun.stage] = now - activeForgeRun.stageStartedAt;
    activeForgeRun.stage = stage;
    activeForgeRun.stageStartedAt = now;
    activeForgeRun.detail = detail.detail ?? activeForgeRun.detail;
    activeForgeRun.error = detail.error ?? "";
  }
  if (stage === "ready" || stage === "failed") activeForgeRun.completedAt = now;
  renderForgeStatus(activeForgeRun, detail.completed, detail.total);
}

async function captureForgeSnapshot(): Promise<void> {
  if (!coreReady || renderer.domElement.width === 0 || renderer.domElement.height === 0) return;
  try {
    const bitmap = await createImageBitmap(renderer.domElement);
    forgeSnapshot.width = bitmap.width;
    forgeSnapshot.height = bitmap.height;
    forgeSnapshot.getContext("2d", { alpha: false })?.drawImage(bitmap, 0, 0);
    bitmap.close();
    forgeSnapshot.classList.add("show");
  } catch (error) {
    // Snapshot support varies by WebGPU canvas implementation. The semantic
    // stage UI remains authoritative if capture is unavailable.
    console.debug("[forge] previous-frame snapshot unavailable", error);
  }
}

// ---- world context ----------------------------------------------------------
const lights = new LightPool(scene);
const env = buildEnvironment(scene, 1, (specs) => lights.setCinematic(specs)); // seed-stable; kept across regens
const stairs = new StairTowers(scene);
const actors = new DungeonActors(scene, camera, renderer.domElement);

const ctx: Ctx = {
  scene, camera, renderer, controls, env,
  gen: new GenPool(),
  lights,
  walk: new WalkMap(stairs),
  stairs,
  actors,
  reportForgeStage,
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
const slotDetail = new Map<number, LodLevel>();
const gpuScene = new GpuMasonryScene(scene, renderer, urlParams.get("gpuscene") !== "0");
const destruction = new GpuDestruction(
  scene, camera, renderer, renderer.domElement,
  ctx.walk.sample,
  () => ctx.walk.touch(),
  (slot) => { slotDetail.set(slot, 2); setSlotLodLevel(slot, 2); },
  () => postProcessing.render(),
  (mesh, instanceId) => gpuScene.hideSourceInstance(mesh, instanceId),
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
  gpuScene.rebuild();
  controls.target.set(0, 3 * TH, 0);
  camera.position.set(50, 42, 70);
  ctx.state.lastExtent = 0;
}

function exitEndless(): void {
  ctx.state.endless = false;
  endless.reset();
  ctx.state.prCap = PR_BASE;
  pruneSlots(new Set());
  gpuScene.rebuild();
}

/** Rebuild the active mode as an observable transaction. The previous canvas
 * stays frozen above the shared instance pools while generation/assembly
 * mutates them, then crossfades only after the submitted GPU work completes. */
async function runReforge(): Promise<void> {
  const requestSerial = ++reforgeSerial;
  if (rogueMode) stopRogueRun();
  stopWalk();
  if (activeMode === "endless") {
    exitEndless();
    enterEndless();
    return;
  }
  if (ctx.state.endless) exitEndless();
  const modeAtStart = activeMode;
  const expectedToken = ctx.state.token + 1;
  reportForgeStage("requested", {
    token: expectedToken,
    seed: ctx.state.seed,
    mode: modeAtStart,
    detail: "preserving current frame",
  });
  await captureForgeSnapshot();
  if (requestSerial !== reforgeSerial) return;
  try {
    const task = modeAtStart === "cube"
      ? forgeCube(ctx)
      : modeAtStart === "ziggurat" || modeAtStart === "reliquary"
        ? forgeMonument(ctx, modeAtStart)
        : forge(ctx, ctx.state.seed);
    await task;
    if (ctx.state.token !== expectedToken || activeMode !== modeAtStart) return;
    gpuScene.rebuild();
    gpuScene.tick(camera);
    reportForgeStage("gpu-upload", {
      token: expectedToken,
      seed: ctx.state.seed,
      mode: modeAtStart,
      detail: "waiting for submitted work",
    });
    postProcessing.render();
    const queue = (renderer.backend as unknown as {
      device?: { queue?: { onSubmittedWorkDone?: () => Promise<void> } };
    }).device?.queue;
    await (queue?.onSubmittedWorkDone?.() ?? Promise.resolve());
    if (ctx.state.token !== expectedToken || activeMode !== modeAtStart) return;
    reportForgeStage("ready", {
      token: expectedToken,
      seed: ctx.state.seed,
      mode: modeAtStart,
      detail: `${ctx.walk.islands.length} blocks playable`,
      completed: ctx.walk.islands.length,
      total: ctx.walk.islands.length,
    });
    forgeSnapshot.classList.remove("show");
    window.setTimeout(() => {
      if (activeForgeRun?.token !== expectedToken || forgeSnapshot.classList.contains("show")) return;
      forgeSnapshot.getContext("2d")?.clearRect(0, 0, forgeSnapshot.width, forgeSnapshot.height);
    }, 350);
  } catch (error) {
    if (ctx.state.token !== expectedToken) return;
    const message = error instanceof Error ? error.message : String(error);
    reportForgeStage("failed", {
      token: expectedToken,
      seed: ctx.state.seed,
      mode: modeAtStart,
      detail: "previous frame retained — retry is safe",
      error: message,
    });
    console.error("[forge] shuffle failed", error);
  }
}

/** rebuild the world in the ACTIVE mode (mode clicks and slider moves) */
function reforge(): void {
  void runReforge();
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
const btnPlay = document.getElementById("btnPlay") as HTMLButtonElement;
btnCine.addEventListener("click", (e) => {
  e.stopPropagation();
  if (cine.active) cine.stop();
  else cine.start(performance.now() / 1000);
});
btnRoute.addEventListener("click", () => { if (!ctx.state.endless) route.toggle(); });
btnNav.addEventListener("click", () => { if (!ctx.state.endless) navOverlay.toggle(); });
btnWalk.addEventListener("click", () => { if (walking) stopWalk(); else void startWalk(); });
let breakArming = false;
btnBreak.addEventListener("click", async () => {
  if (destruction.enabled) {
    destruction.setEnabled(false);
  } else {
    if (breakArming) return;
    breakArming = true;
    btnBreak.classList.add("active");
    document.getElementById("tip")!.textContent = "arming GPU fracture…";
    try {
      await destruction.warmup();
      destruction.setEnabled(true);
    } catch (error) {
      console.error("[destruction] pipeline failed:", error);
    } finally {
      breakArming = false;
    }
  }
  btnBreak.classList.toggle("active", destruction.enabled);
  document.getElementById("tip")!.textContent = destruction.enabled
    ? "click masonry to fracture · drag still orbits · X exits"
    : "drag to orbit · scroll to zoom · Esc stops";
});
btnPlay.addEventListener("click", () => {
  if (rogueMode && !rogue.state.dead) stopRogueRun();
  else void startRogueRun();
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
  const coldSummon = playerReady === null;
  if (coldSummon) {
    btnWalk.disabled = true;
    document.getElementById("tip")!.textContent = "summoning the route guide…";
  }
  try {
    await preloadPlayer();
  } finally {
    if (coldSummon) {
      btnWalk.disabled = false;
      document.getElementById("tip")!.textContent = "drag to orbit · scroll to zoom · Esc stops";
    }
  }
  const rc = route.ensure();
  if (!rc || !player) return;
  player.group.visible = true;
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

const occlusionActive: OccludingArchitecture = { slots: new Set(), stairs: new Set() };
const occlusionDesired: OccludingArchitecture = { slots: new Set(), stairs: new Set() };
const occlusionPlayerTarget = new THREE.Vector3();
let occlusionBlend = 0;
let occlusionBlendTarget = 0;

function replaceSet(target: Set<number>, source: ReadonlySet<number>): void {
  target.clear();
  for (const value of source) target.add(value);
}

function setOcclusionTarget(next: OccludingArchitecture): void {
  replaceSet(occlusionDesired.slots, next.slots);
  replaceSet(occlusionDesired.stairs, next.stairs);
  const occupied = next.slots.size > 0 || next.stairs.size > 0;
  occlusionBlendTarget = occupied ? 1 : 0;
  if (!occupied) return;
  for (const slot of next.slots) occlusionActive.slots.add(slot);
  for (const stair of next.stairs) occlusionActive.stairs.add(stair);
  setOccludingSlots(occlusionActive.slots);
  ctx.stairs.setOccluded(occlusionActive.stairs);
}

function tickOcclusion(dt: number): void {
  const speed = occlusionBlendTarget > occlusionBlend ? 9 : 5.5;
  occlusionBlend += (occlusionBlendTarget - occlusionBlend) * (1 - Math.exp(-dt * speed));
  gpuScene.setOccludingSlots(occlusionActive.slots);
  if (player) {
    occlusionPlayerTarget.copy(player.group.position);
    occlusionPlayerTarget.y += 1.25;
    setOcclusionWindow(camera.position, occlusionPlayerTarget, occlusionBlend);
  }
  if (occlusionBlendTarget > 0 && occlusionBlend > 0.88) {
    replaceSet(occlusionActive.slots, occlusionDesired.slots);
    replaceSet(occlusionActive.stairs, occlusionDesired.stairs);
    setOccludingSlots(occlusionActive.slots);
    ctx.stairs.setOccluded(occlusionActive.stairs);
  } else if (occlusionBlendTarget === 0 && occlusionBlend < 0.015
    && (occlusionActive.slots.size > 0 || occlusionActive.stairs.size > 0)) {
    occlusionBlend = 0;
    occlusionActive.slots.clear();
    occlusionActive.stairs.clear();
    setOccludingSlots(occlusionActive.slots);
    ctx.stairs.setOccluded(occlusionActive.stairs);
  }
}

function clearOcclusion(): void {
  occlusionBlend = occlusionBlendTarget = 0;
  occlusionActive.slots.clear(); occlusionActive.stairs.clear();
  occlusionDesired.slots.clear(); occlusionDesired.stairs.clear();
  setOccludingSlots(occlusionActive.slots);
  ctx.stairs.setOccluded(occlusionActive.stairs);
  setOcclusionWindow(camera.position, camera.position, 0);
  gpuScene.setOccludingSlots(occlusionActive.slots);
}

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
  clearOcclusion();
  lantern.intensity = 0;
  setBloom(0.9);
  if (player) {
    player.group.position.set(0, -600, 0);
    player.group.visible = false;
  }
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
const lanternAnchor = new THREE.Vector3();
let player: Player | null = null;
let playerReady: Promise<void> | null = null;

/** Preload and parse the trimmed skeleton asset after first paint. The WebGPU
 * skinned compile remains demand-driven: compileAsync itself stalls this
 * backend for ~5 s even for one hidden Basic pipeline, so doing it
 * automatically is worse than paying the real-draw realization only when the
 * player explicitly enters a playable mode. */
function preloadPlayer(): Promise<void> {
  playerReady ??= (async () => {
    player = new Player();
    try { await player.load("/assets/skeleton-game.glb"); } catch { /* placeholder-only */ }
    player.group.position.set(0, -600, 0);
    player.group.visible = false;
    scene.add(player.group);
  })();
  return playerReady;
}

// ---- playable roguelike run ------------------------------------------------
const rogue = new RogueRun();
const rogueKeys = new Set<string>();
const rogueExit = new THREE.Vector3();
const rogueTarget = new THREE.Vector3();
const rogueCameraDelta = new THREE.Vector3();
let rogueMode = false;
let rogueTransition = false;
let rogueAttackQueued = false;
let rogueInteractQueued = false;
let rogueNextAttack = 0;
let rogueInvulnerable = 0;
let rogueDashQueued = false;
let rogueDashUntil = 0;
let rogueDashCooldown = 0;
let rogueDashes = 0;
let rogueToastTimer = 0;
let rogueLastHud = 0;
let rogueRewardFloor = -1;

function flashRunToast(title: string, detail = ""): void {
  runToast.innerHTML = `<strong>${title}</strong>${detail ? `<span>${detail}</span>` : ""}`;
  runToast.classList.add("show");
  clearTimeout(rogueToastTimer);
  rogueToastTimer = window.setTimeout(() => runToast.classList.remove("show"), 1900);
}

function updateRunHud(): void {
  const s = rogue.state;
  runFloorEl.textContent = `Depth ${s.floor}`;
  runHpEl.textContent = `${Math.ceil(s.hp)} / ${s.maxHp}`;
  runHpFill.style.width = `${Math.max(0, Math.min(100, s.hp / s.maxHp * 100))}%`;
  runAttackEl.textContent = `⚔ ${s.attack}`;
  runShardsEl.textContent = `◆ ${s.shards}`;
  runObjectiveEl.textContent = s.dead
    ? `Fallen after ${s.kills} kills · press ⚔ to rise again`
    : rogueTransition ? "The next depth is forming…"
      : s.enemiesAlive > 0 ? `${ctx.actors.eliteCount > 0 ? "Break the Warden · " : ""}Hunt ${s.enemiesAlive} remaining · Space attacks`
        : s.awaitingReward ? "Choose an oath · the portal remains sealed"
          : "Portal awakened · reach it and press E";
  runHud.classList.toggle("dead", s.dead);
  syncRogueReward();
}

function syncRogueReward(): void {
  const show = rogueMode && rogue.state.active && rogue.state.awaitingReward;
  runReward.classList.toggle("show", show);
  runReward.setAttribute("aria-hidden", String(!show));
  if (!show || rogueRewardFloor === rogue.state.floor) return;
  rogueRewardFloor = rogue.state.floor;
  runRewardOptions.replaceChildren(...rogue.floorChoices().map((reward, index) => {
    const button = document.createElement("button");
    button.dataset.kind = reward.kind;
    const title = document.createElement("strong"); title.textContent = reward.label;
    const detail = document.createElement("span"); detail.textContent = reward.detail;
    const key = document.createElement("em"); key.textContent = `press ${index + 1}`;
    button.append(title, detail, key);
    return button;
  }));
}

function chooseRogueReward(kind: RelicKind): RelicReward | null {
  const reward = rogue.chooseFloorReward(kind);
  if (!reward) return null;
  runReward.classList.remove("show");
  flashRunToast(reward.label, reward.detail);
  updateRunHud();
  return reward;
}

runRewardOptions.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button[data-kind]");
  if (button) chooseRogueReward(button.dataset.kind as RelicKind);
});

function updateRogueExit(): void {
  const island = [...ctx.walk.islands].reverse().find((entry) => entry.l.door) ?? ctx.walk.islands.at(-1);
  if (!island) { rogueExit.set(0, 0, 0); return; }
  const l = island.l, center = (l.N - 1) / 2;
  const door = l.door ?? l.entrance;
  const cell = door.y * l.N + door.x;
  rogueExit.set(
    island.ox + (door.x - center) * CELL,
    island.oy + l.tier[cell] * TH + 0.16,
    island.oz + (door.y - center) * CELL,
  );
}

function placeRoguePlayer(): boolean {
  if (!player || ctx.walk.islands.length === 0) return false;
  const island = ctx.walk.islands[0];
  const l = island.l, center = (l.N - 1) / 2;
  const x = island.ox + (l.entrance.x - center) * CELL;
  const z = island.oz + (l.entrance.y - center) * CELL;
  player.group.visible = true;
  player.setFirstPerson(false);
  player.place(x, z, ctx.walk.sample);
  player.lastSafeX = x; player.lastSafeZ = z;
  controls.autoRotate = false;
  controls.enabled = true;
  controls.target.set(x, player.group.position.y + 1.2, z);
  const cameraX = x + 10, cameraZ = z + 12;
  let cameraY = player.group.position.y + 11;
  // Entrance cells sit beside tall gate masonry. Raise the initial chase view
  // above every sampled blocker instead of beginning the run inside a wall and
  // forcing the occlusion system to recover on frame one.
  for (const s of [1, 0.75, 0.5, 0.25]) {
    cameraY = Math.max(
      cameraY,
      camClearY(x + (cameraX - x) * s, z + (cameraZ - z) * s, player.group.position.y) + 3.2,
    );
  }
  camera.position.set(cameraX, cameraY, cameraZ);
  camera.lookAt(controls.target);
  lantern.intensity = 8;
  updateRogueExit();
  return true;
}

async function startRogueRun(): Promise<void> {
  if (rogueTransition) return;
  rogueTransition = true;
  stopWalk();
  cine.stop();
  const restartSeed = rogue.state.dead ? rogue.state.baseSeed : ctx.state.seed;
  const coldSummon = playerReady === null;
  if (coldSummon) {
    btnPlay.disabled = true;
    document.getElementById("tip")!.textContent = "summoning the adventurer…";
  }
  try {
    await preloadPlayer();
  } finally {
    if (coldSummon) {
      btnPlay.disabled = false;
      document.getElementById("tip")!.textContent = "WASD move · Shift dash · Space attack · E interact";
    }
  }
  if (ctx.state.endless) exitEndless();
  if (activeMode !== "chain" || ctx.state.seed !== restartSeed || ctx.walk.islands.length === 0) {
    setModeActive("chain");
    await forge(ctx, restartSeed);
    gpuScene.rebuild();
  }
  ctx.actors.resetLoot();
  const enemyCount = ctx.actors.beginFloor(1);
  rogue.start(restartSeed, enemyCount);
  rogueMode = true;
  rogueTransition = false;
  rogueInvulnerable = 0;
  rogueDashQueued = false;
  rogueDashUntil = rogueDashCooldown = 0;
  rogueDashes = 0;
  rogueAttackQueued = rogueInteractQueued = false;
  rogueRewardFloor = -1;
  runHud.classList.add("show");
  btnPlay.classList.add("active");
  setBloom(0.62);
  placeRoguePlayer();
  updateRunHud();
  flashRunToast("The descent begins", `${enemyCount} sentinels stir`);
}

function stopRogueRun(): void {
  rogueMode = false;
  rogueTransition = false;
  rogue.stop();
  rogueKeys.clear();
  rogueAttackQueued = rogueInteractQueued = false;
  runHud.classList.remove("show", "dead");
  runToast.classList.remove("show");
  runReward.classList.remove("show");
  btnPlay.classList.remove("active");
  clearOcclusion();
  lantern.intensity = 0;
  setBloom(0.9);
  if (player) {
    player.group.position.set(0, -600, 0);
    player.group.visible = false;
  }
  controls.enabled = true;
}

async function descendRogue(): Promise<void> {
  if (rogueTransition || !rogue.canDescend()) return;
  rogueTransition = true;
  updateRunHud();
  flashRunToast(`Descending to depth ${rogue.state.floor + 1}`);
  if (player) player.group.position.y = -600;
  const nextFloor = rogue.state.floor + 1;
  await forge(ctx, rogue.floorSeed(nextFloor));
  gpuScene.rebuild();
  const enemies = ctx.actors.beginFloor(nextFloor);
  rogue.descend(enemies);
  placeRoguePlayer();
  rogueTransition = false;
  rogueInvulnerable = 0.7;
  updateRunHud();
  flashRunToast(`Depth ${rogue.state.floor}`, `${enemies} stronger sentinels`);
}

function grantChestReward(reward: RelicReward): void {
  flashRunToast(reward.label, reward.detail);
  updateRunHud();
}

addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape" && walking) stopWalk();
  if (e.key === "Escape" && rogueMode) stopRogueRun();
  if (e.key.toLowerCase() === "x" && !(e.target instanceof HTMLInputElement)) btnBreak.click();
  if (cine.active) cine.stop();
});
addEventListener("keydown", (e: KeyboardEvent) => {
  if (!rogueMode || !rogue.state.active || e.target instanceof HTMLInputElement) return;
  const key = e.key.toLowerCase();
  if (rogue.state.awaitingReward && /^[1-3]$/.test(key)) {
    const reward = rogue.floorChoices()[Number(key) - 1];
    if (reward) chooseRogueReward(reward.kind);
    e.preventDefault();
    return;
  }
  rogueKeys.add(key);
  if (e.code === "Space") { rogueAttackQueued = true; e.preventDefault(); }
  if (key === "shift") { rogueDashQueued = true; e.preventDefault(); }
  if (key === "e") rogueInteractQueued = true;
});
addEventListener("keyup", (e: KeyboardEvent) => rogueKeys.delete(e.key.toLowerCase()));
addEventListener("blur", () => rogueKeys.clear());
renderer.domElement.addEventListener("pointerdown", () => { cine.stop(); });

// ---- main loop --------------------------------------------------------------
// distance LOD with hysteresis (LOD_NEAR / LOD_FAR) so a camera hovering at
// the boundary never thrashes geometry swaps
// adaptive resolution: fill rate is the budget. Walk pixelRatio in small
// steps between 1.0 and the mode cap, driven by an EMA of the frame time —
// heavy views trade a little sharpness for smoothness, light views win it
// back. Adjust at most once a second (setPixelRatio reallocates targets).
let dprNow = Math.min(devicePixelRatio, PR_BASE);
let frameEma = 16.7;
let lastDprAdj = 0;
let coreReady = false;
let decorReady = false;
let decorRevealPending = false;
let decorRevealFrames = 0;
let lodToken = -1;
let lastOcclusionCheck = 0;
const startupTiming = {
  startedAt: performance.now(),
  forgeReadyAt: 0,
  coreReadyAt: 0,
  firstVisibleAt: 0,
  stoneTextureReadyAt: 0,
  decorReadyAt: 0,
};
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
  // Build CPU scene data while WebGPU initializes. Neither generation nor
  // instance filling needs an initialized device, so serializing these two
  // independent jobs only lengthened the critical path.
  setDecorSuppressed(true);
  const mode = urlParams.get("mode");
  if (mode === "ziggurat" || mode === "reliquary") setModeActive(mode);
  let forgeErr: unknown = null;
  const rendererReady = renderer.init();
  const forging = (mode === "ziggurat" || mode === "reliquary"
    ? forgeMonument(ctx, mode as Monument)
    : forge(ctx, ctx.state.seed)
  ).then(() => { startupTiming.forgeReadyAt = performance.now(); })
    .catch((e) => { forgeErr = e; console.error("[forge] failed:", e); });
  await rendererReady;

  // Present the FIRST completed island while the paced forge continues. The
  // former Promise.all waited for every slot, then submitted 300+ cold render
  // objects at once: on this WebGPU driver the CPU forge took only ~260 ms but
  // the first visible frame arrived at 4.23 s. One low-LOD island compiles the
  // shared pipelines and gives the browser a useful frame before the remaining
  // render objects are realized progressively.
  const awaitBuildFrame = (): Promise<void> => new Promise((resolve) => {
    let done = false;
    const settle = () => { if (!done) { done = true; resolve(); } };
    const timeout = window.setTimeout(settle, 50);
    requestAnimationFrame(() => { clearTimeout(timeout); settle(); });
  });
  const firstIslandDeadline = performance.now() + 60000;
  while (ctx.worlds.length === 0 && forgeErr === null && performance.now() < firstIslandDeadline) {
    await awaitBuildFrame();
  }
  if (forgeErr !== null || ctx.worlds.length === 0) throw forgeErr ?? new Error("Dungeon forge produced no world");

  // Wave 1 submits the real low-LOD post frame directly. It intentionally uses
  // the partial scene captured above; later slots reuse the same pipelines.
  postProcessing.render();
  const queue = (renderer.backend as unknown as {
    device?: { queue?: { onSubmittedWorkDone?: () => Promise<void> } };
  }).device?.queue;
  await (queue?.onSubmittedWorkDone?.() ?? Promise.resolve());
  coreReady = true;
  startupTiming.coreReadyAt = performance.now();
  startupTiming.firstVisibleAt = performance.now();
  loadingEl.style.opacity = "0";
  loadingEl.style.visibility = "hidden";
  // The shared 76 KB brush texture is deliberately post-first-visible. Its
  // placeholder already compiled with the masonry shader, so swapping pixels
  // later neither blocks startup nor creates a new render pipeline.
  window.setTimeout(() => {
    void loadHandPaintedStoneTexture()
      .then(() => { startupTiming.stoneTextureReadyAt = performance.now(); })
      .catch((error) => console.warn("Hand-painted stone texture failed to stream", error));
  }, 1400);

  // Keep the partial world alive and animated while layout/build work yields
  // between islands. This callback is replaced atomically by the full game
  // loop below as soon as forging is complete.
  let earlyLastT = performance.now() / 1000;
  renderer.setAnimationLoop(() => {
    const t = performance.now() / 1000;
    const dt = Math.min(0.05, t - earlyLastT);
    earlyLastT = t;
    controls.update();
    for (const world of ctx.worlds) world.tick(t);
    ctx.actors.tick(t, dt);
    ctx.lights.tick(t, 0.3);
    postProcessing.render();
  });

  await forging;
  if (forgeErr !== null || ctx.worlds.length === 0) throw forgeErr ?? new Error("Dungeon forge produced no world");
  gpuScene.rebuild();
  reportForgeStage("ready", {
    token: ctx.state.token,
    seed: ctx.state.seed,
    mode: activeMode,
    detail: `${ctx.walk.islands.length} blocks playable · detail streaming`,
    completed: ctx.walk.islands.length,
    total: ctx.walk.islands.length,
  });

  // Do not compile every actual detail render object off-screen. On the target
  // WebGPU driver that "background" compile monopolised the page for 47–50 s,
  // leaving the user staring at low LOD. The reveal queue submits one real
  // object per frame instead: pipelines are cached naturally and render-object
  // realization is amortised while the already-visible dungeon stays usable.
  const beginProgressiveDecor = (): void => {
    decorRevealFrames = 0;
    decorRevealPending = true;
  };

  let revealed = true;
  let lastT = performance.now() / 1000;
  renderer.setAnimationLoop(() => {
    const t = performance.now() / 1000;
    const rawMs = (t - lastT) * 1000;
    const dt = Math.min(0.05, t - lastT);
    lastT = t;
    adaptResolution(t, rawMs);
    if (rogueMode && rogue.state.active && player && !rogueTransition) {
      const { f: forward, s: strafe } = playerInputFromKeys(rogueKeys);
      const camYaw = Math.atan2(
        controls.target.x - camera.position.x,
        controls.target.z - camera.position.z,
      );
      if (rogueDashQueued && t >= rogueDashCooldown && (forward !== 0 || strafe !== 0)) {
        rogueDashUntil = t + 0.22;
        rogueDashCooldown = t + 1.05;
        rogueInvulnerable = Math.max(rogueInvulnerable, 0.25);
        rogueDashes++;
      }
      rogueDashQueued = false;
      player.update(
        dt, { f: forward, s: strafe }, camYaw, ctx.walk.sample,
        t < rogueDashUntil ? 2.35 : 1,
      );
      rogueInvulnerable = Math.max(0, rogueInvulnerable - dt);
      const attack = rogueAttackQueued && t >= rogueNextAttack;
      if (attack) {
        rogueAttackQueued = false;
        rogueNextAttack = t + 0.34;
        player.attack();
      }
      const combat = ctx.actors.stepCombat(dt, player.group.position, ctx.walk.sample, rogue.state.attack, attack);
      if (combat.kills > 0) {
        rogue.defeat(combat.kills, combat.eliteKills);
        flashRunToast(
          combat.eliteKills > 0 ? "Warden shattered" : "Sentinel broken",
          combat.eliteKills > 0 ? `bounty claimed · ◆ ${rogue.state.shards}` : `${rogue.state.enemiesAlive} remain`,
        );
      }
      if (combat.playerDamage > 0 && rogueInvulnerable <= 0) {
        const died = rogue.takeDamage(combat.playerDamage);
        rogueInvulnerable = 0.48;
        if (died) {
          lantern.intensity = 0;
          clearOcclusion();
          flashRunToast("You have fallen", `depth ${rogue.state.floor} · ${rogue.state.kills} kills`);
        }
      }
      if (player.falling && player.group.position.y < -25) rogue.takeDamage(9999);

      if (rogueInteractQueued) ctx.actors.interact(player.group.position);
      for (const key of ctx.actors.consumeOpenedChests()) {
        const reward = rogue.openChest(key);
        if (reward) grantChestReward(reward);
      }
      if (
        rogueInteractQueued && rogue.canDescend()
        && player.group.position.distanceTo(rogueExit) < 3.6
      ) void descendRogue();
      rogueInteractQueued = false;

      // Translate camera and target together, preserving the player's chosen
      // orbit while the focus follows the hero. No camera-relative snapping.
      rogueTarget.set(player.group.position.x, player.group.position.y + 1.2, player.group.position.z);
      rogueCameraDelta.copy(rogueTarget).sub(controls.target).multiplyScalar(Math.min(1, dt * 7));
      controls.target.add(rogueCameraDelta);
      camera.position.add(rogueCameraDelta);
      controls.update();
      lantern.position.copy(player.getTorchWorldPosition(lanternAnchor));
      if (t - lastOcclusionCheck > 0.08) {
        lastOcclusionCheck = t;
        const occluders = skeletonOccluders();
        setOcclusionTarget(occluders);
      }
      if (t - rogueLastHud > 0.1) { rogueLastHud = t; updateRunHud(); }
    } else if (walking && player && walkCurve) {
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
      lantern.position.copy(player.getTorchWorldPosition(lanternAnchor));
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
        setOcclusionTarget(occluders);
      }
      if (walkU >= 1 && walkEndAt === 0) walkEndAt = t;
      if (walkEndAt > 0 && t - walkEndAt > 2.5) stopWalk();
    } else if (cine.active) {
      cine.update(t);
    } else {
      controls.update();
    }
    tickOcclusion(dt);
    for (const w of ctx.worlds) w.tick(t);
    ctx.actors.tick(t, dt);
    destruction.tick(dt);
    if (decorRevealPending) {
      // One cold render object per frame is the hard safety invariant. The old
      // five-object tail completed sooner on paper but repeatedly froze the
      // already-playable scene for 0.3–1.3 seconds.
      decorRevealFrames++;
      const batch = 1;
      if (revealDecor(batch)) {
        decorRevealPending = false;
        decorReady = true;
        startupTiming.decorReadyAt = performance.now();
        slotDetail.clear(); // let distance LOD re-apply to the revealed layers
      }
    }
    // distance LOD: far islands drop their small-detail layers. TRUE 3D
    // distance — a camera hovering 200 units above a spire is far from every
    // island even when its xz distance is small
    if (lodToken !== ctx.state.token) {
      lodToken = ctx.state.token;
      slotDetail.clear();
      destruction.reset();
    }
    let nearestD = Infinity;
    let lodSlot = -1, lodWant: LodLevel = 0, lodPriority = Infinity;
    for (const isl of ctx.walk.islands) {
      const half = (isl.l.N * CELL) / 2;
      const d2 = Math.hypot(
        camera.position.x - isl.ox,
        camera.position.y - (isl.oy + 8),
        camera.position.z - isl.oz,
      ) - half;
      nearestD = Math.min(nearestD, d2);
      // Every freshly built pool is already level 0. Treat an unrecorded slot
      // as far instead of spending the first 20 frames "demoting" far islands
      // before the nearest one is allowed to promote.
      const prev = slotDetail.get(isl.slot) ?? 0;
      let want: LodLevel;
      if (destruction.enabled) want = 2;
      else if (prev === 2) want = d2 < LOD_FAR ? 2 : 1;
      else if (prev === 1) want = d2 < LOD_NEAR ? 2 : d2 > LOD_MID_FAR ? 0 : 1;
      else want = d2 < LOD_MID_NEAR ? 1 : 0;
      if (decorReady && want !== prev) {
        // At most ONE island crosses LOD per frame. Entering chooses the
        // nearest pending island; leaving chooses the farthest. This caps the
        // render-work delta even when a zoom crosses several stacked layers.
        const priority = want > prev ? d2 : -d2;
        if (priority < lodPriority) { lodPriority = priority; lodSlot = isl.slot; lodWant = want; }
      }
    }
    let lodWarmRestore: (() => void) | null = null;
    if (lodSlot >= 0) {
      const slots = [lodSlot, 1000 + lodSlot, 3000 + lodSlot];
      const previous = slotDetail.get(lodSlot) ?? 0;
      if (lodWant <= previous || areSlotsLodWarm(slots, lodWant)) {
        slotDetail.set(lodSlot, lodWant);
        for (const slot of slots) setSlotLodLevel(slot, lodWant);
      } else {
        lodWarmRestore = stageSlotLodWarmup(slots, lodWant);
      }
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
    btnPlay.classList.toggle("active", rogueMode);
    // distance calms the flicker: near 60 units torches dance at full
    // amplitude; past ~150 they settle to a steady candle glow (dozens of
    // asynchronous flickers read as an uncomfortable shimmer from afar)
    const damp = Math.min(1, Math.max(0.1, 1 - (nearestD - 60) / 90));
    flickerDamp.value = damp;
    ctx.lights.tick(t, damp);
    ctx.env.tick(camera);
    gpuScene.tick(camera);
    const r0 = performance.now();
    postProcessing.render();
    lodWarmRestore?.();
    const rDur = performance.now() - r0;
    if (rDur > 100) console.log(`[frame] render() blocked ${rDur.toFixed(0)}ms`);
    if (!revealed && ctx.worlds.length > 0 && coreReady) {
      revealed = true;
      loadingEl.style.opacity = "0";
      loadingEl.style.visibility = "hidden";
    }
  });
  // Let the first frame and short CSS fade settle, then stream visual detail.
  setTimeout(beginProgressiveDecor, 350);
}

void boot().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  reportForgeStage("failed", {
    token: ctx.state.token,
    seed: ctx.state.seed,
    mode: activeMode,
    detail: "startup stopped",
    error: message,
  });
  const loadingText = loadingEl.querySelector("span");
  if (loadingText) loadingText.textContent = `forge failed · ${message}`;
  console.error("[boot] failed", error);
});

// dev hook for camera scripting (screenshot verification, cinematics)
(window as unknown as { __df: object }).__df = {
  camera, controls, ctx, postProcessing, nav, navOverlay, route,
  get player() { return player; },
  skeletonOccluders,
  get walking() { return walking; },
  get walkU() { return walkU; },
  get coreReady() { return coreReady; },
  get decorReady() { return decorReady; },
  get forgeRun() { return activeForgeRun ? structuredClone(activeForgeRun) : null; },
  get forgeRuns() { return structuredClone(forgeRuns); },
  startupTiming,
  stoneStyle,
  gpuScene,
  destruction,
  rogue,
  get rogueMode() { return rogueMode; },
  get rogueExit() { return rogueExit.clone(); },
  get rogueDashes() { return rogueDashes; },
  setAllDetail(visible: boolean) {
    for (const island of ctx.walk.islands) {
      setSlotDetail(island.slot, visible);
      setSlotDetail(1000 + island.slot, visible);
      setSlotDetail(3000 + island.slot, visible);
    }
    gpuScene.tick(camera);
  },
  setSlotDetail(slot: number, visible: boolean) {
    setSlotDetail(slot, visible);
    gpuScene.tick(camera);
  },
  areSlotsLodWarm,
  stageSlotLodWarmup,
  startWalk,
  startRogueRun,
  stopRogueRun,
  chooseRogueReward,
};
