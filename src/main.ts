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

import { assetUrl } from "./assets";
import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { TransformControls } from "three/addons/controls/TransformControls.js";
import { ClusteredLighting } from "three/addons/lighting/ClusteredLighting.js";
import { DEFAULT_PARAMS, type Params } from "./gen/dungeon";
import { GenPool } from "./gen/pool";
import {
  pruneSlots, setSlotDetail, setSlotLodLevel, setDecorSuppressed, revealDecor, cancelDecorReveal,
  decorRevealStatus, lodWarmStatus, startupDecorRenderObjectCount,
  setOccludingSlots, areSlotsLodWarm, stageSlotLodWarmup,
  type LodLevel, gpuSceneSlotPools } from "./scene/slots";
import {
  buildEnvironment, getGodrayShape, setGodrayShape, saveGodrayShape,
  resetGodrayShape, loadGodrayShape, type GodrayShape,
} from "./scene/env";
import { setInteriorCull, getInteriorCull, setClosedCourses, getClosedCourses, setFarShadows, getFarShadows } from "./scene/build";
import { landmarkStreamStatus } from "./scene/abyss-landmarks";
import { flickerDamp, setOcclusionWindow, stoneStyle } from "./scene/kit/materials";
import type { PostChain } from "./render/post";
import { GpuMasonryScene } from "./render/gpu-scene";
import type { Player } from "./player/player";
import { LightPool } from "./world/lights";
import { isEffectivelyVisible, parseStartupBatch, startupRenderWork } from "./startup-pacing";
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
import type { GpuDestruction } from "./world/destruction";
import { RogueRun, type RelicKind, type RelicReward } from "./game/roguelike";
import { playerInputFromKeys } from "./player/input";
import { buildPanel } from "./ui/panel";
import type { CameraShots } from "./editor/shots";
import { mulberry32 } from "./gen/rng";
import {
  TH, CELL, PR_BASE, PR_LARGE,
  LOD_NEAR, LOD_FAR, LOD_MID_NEAR, LOD_MID_FAR,
} from "./config";

// index.html stamps this immediately before requesting the entry module, so
// startup metrics include module fetch/parse and synchronous environment
// construction instead of beginning after the heaviest CPU work has finished.
const pageStartedAt = (window as unknown as { __dfPageStartedAt?: number }).__dfPageStartedAt
  ?? performance.now();

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
// Runtime overrides keep cold-start pacing measurable without maintaining
// benchmark-only branches. After global low-surface compaction, repeated
// foreground traces selected weighted budgets 14×12: both queues finish near
// 1.06 s without a >100 ms render or frame gap. The first cinematic
// submissions remain independently empty so the prepared dragon/skull and the
// four surface buckets each own a bounded ScenePass preview frame.
const startupCoreBatch = parseStartupBatch(urlParams.get("coreBatch"), 14, 20);
const startupDecorBatch = parseStartupBatch(urlParams.get("decorBatch"), 12, 16);
const startupFirstPostBatch = parseStartupBatch(
  urlParams.get("firstPostBatch"), 0, startupCoreBatch, 0,
);
// Pick the startup fill-rate tier before the first WebGPU target exists. A
// default 20-block chain always lands in PR_LARGE after spatial fitting; first
// rendering it at PR_BASE and clamping later invalidated every just-created
// render object. Small review scenes retain the sharper tier.
const requestedStartupIslands = urlParams.has("islands")
  ? Number(urlParams.get("islands")) || 1
  : DEFAULT_PARAMS.islands;
const startupMode = urlParams.get("mode");
const startupPrCap = requestedStartupIslands >= 6
  || startupMode === "ziggurat"
  || startupMode === "reliquary"
  ? PR_LARGE
  : PR_BASE;

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
renderer.setPixelRatio(Math.min(devicePixelRatio, startupPrCap));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // static baked shadows — soft PCF not worth the taps
// AgX was the wrong curve for this scene. It is built to desaturate as it
// rolls off and to keep shadows flat — safe for photographic material, and
// exactly wrong for a painted look that lives on saturated teal water and
// amber torchlight against true black. ACES keeps the chroma and gives the
// contrast the reference has.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// Measured sweep with the camera pinned: 2.1 gave a frame mean of 33.5 with
// 0.00% of pixels clipped, and even 3.3 only reached 0.02%. The scene was
// simply under-exposed — there was a third of a stop of headroom sitting
// unused, which is why it kept reading as too dark however the materials were
// tuned. 2.9 takes the mean to 45.2 and still clips 0.02%.
renderer.toneMappingExposure = 2.9;
app.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 3 * TH, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = 1.38;
controls.minDistance = 18;
controls.maxDistance = 170;
// Hold the authored establishing composition. Continuous auto-rotation moved
// the colossal dragon and skull out of frame while the remaining detail was
// still streaming, so the scene users eventually saw no longer matched the
// deliberate two-subject camera produced by forge(). Orbit remains available
// by drag, and the cinematic control provides an intentional moving tour.
controls.autoRotate = false;
controls.autoRotateSpeed = 0.35;
renderer.domElement.addEventListener("pointerdown", () => { controls.autoRotate = false; });

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
let cancelStartupProgressiveReveal = (): void => {};
let resolveStartupSceneReady!: () => void;
const startupSceneReady = new Promise<void>((resolve) => {
  resolveStartupSceneReady = resolve;
});
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
  btnNew.disabled = busy;
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
const env = buildEnvironment(
  scene, 1,
  (specs) => lights.setCinematic(specs),
  (specs) => lights.setLandmarkSpecs(specs),
); // seed-stable; kept across regens
// Bloom, volumetric fog, GTAO and godrays are not needed for the useful first
// paint. Keeping render/post.ts in the synchronous entry made the browser
// download and parse that entire node graph before boot() could even submit
// the coarse preview. Load it after first paint; until it is ready every
// caller receives the same responsive direct-render fallback.
let cinematicPost: PostChain | null = null;
let cinematicPostLoad: Promise<PostChain | null> | null = null;
let requestedBloom = 0.9;
const godrayStats = { enabled: false, resolutionScale: 0, raymarchSteps: 0 };
const postProcessing = {
  render(): void {
    if (cinematicPost) cinematicPost.post.render();
    else renderer.render(scene, camera);
  },
};
const setBloom = (strength: number): void => {
  requestedBloom = strength;
  cinematicPost?.setBloom(strength);
};
const loadCinematicPost = (): Promise<PostChain | null> => {
  if (cinematicPost) return Promise.resolve(cinematicPost);
  if (cinematicPostLoad) return cinematicPostLoad;
  startupTiming.postModuleRequestedAt = performance.now();
  cinematicPostLoad = import("./render/post")
    .then(({ createPost }) => {
      const chain = createPost(renderer, scene, camera, {
        ambientOcclusion: urlParams.get("ao") === "1",
        bloom: urlParams.get("bloom") !== "0",
        cinematic: urlParams.get("post") !== "basic",
        // Keep an explicit fallback for driver triage and low-end captures.
        // Default remains the authored shadow-derived moon shaft.
        godrayLight: urlParams.get("godrays") === "0" ? undefined : env.godrayLight,
        godrayVolume: env.godrayVolume,
      });
      chain.setBloom(requestedBloom);
      cinematicPost = chain;
      Object.assign(godrayStats, chain.godrays);
      startupTiming.postModuleReadyAt = performance.now();
      return chain;
    })
    .catch((error) => {
      console.warn("Cinematic post failed to load; keeping direct rendering", error);
      return null;
    });
  return cinematicPostLoad;
};
const stairs = new StairTowers(scene);
const actors = new DungeonActors(scene, camera, renderer.domElement);

const ctx: Ctx = {
  scene, camera, renderer, controls, env,
  spawn: null,
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
    reforging: false,
    prCap: startupPrCap,
  },
};
const endless = new EndlessWorld(ctx);
const cine = new Cinematic(ctx);
const nav = new NavMesh(ctx);
const navOverlay = new NavOverlay(ctx, nav);
const route = new RoutePath(ctx, nav);
const slotDetail = new Map<number, LodLevel>();
const gpuScene = new GpuMasonryScene(
  scene,
  renderer,
  urlParams.get("gpuscene") !== "0",
  urlParams.get("deferHighMasonry") !== "0",
);
let destruction: GpuDestruction | null = null;
let destructionLoad: Promise<GpuDestruction> | null = null;

/** Fracture is an explicit tool, not part of the default diorama. Keeping its
 * 21 kB module, fixed GPU buffers, compute graph and pointer listeners off the
 * cold path makes the complete default scene arrive sooner without weakening
 * the feature: the first click owns the import and warm-up state visibly. */
async function ensureDestruction(): Promise<GpuDestruction> {
  if (destruction) return destruction;
  destructionLoad ??= import("./world/destruction").then(({ GpuDestruction }) => {
    const instance = new GpuDestruction(
      scene, camera, renderer, renderer.domElement,
      ctx.walk.sample,
      () => ctx.walk.touch(),
      (slot) => { slotDetail.set(slot, 2); setSlotLodLevel(slot, 2); },
      () => postProcessing.render(),
      (mesh, instanceId) => gpuScene.hideSourceInstance(mesh, instanceId),
    );
    destruction = instance;
    return instance;
  });
  try {
    return await destructionLoad;
  } catch (error) {
    destructionLoad = null;
    throw error;
  }
}

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
    detail: !decorReady
      ? "finishing the current scene upload"
      : "preserving current frame",
  });
  // A rebuild before the final scene context has seen its render objects
  // would have to compile hundreds of pipelines inside the transaction. Keep
  // the current progressive frame alive, queue the request, and start as soon
  // as the complete scene is genuinely warm. Orbit remains responsive while
  // it waits.
  await startupSceneReady;
  if (requestSerial !== reforgeSerial) return;
  await captureForgeSnapshot();
  if (requestSerial !== reforgeSerial) return;
  cancelStartupProgressiveReveal();
  ctx.state.reforging = true;
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
    // The forge resets slot-group transforms and rebuilds landmarks, so any
    // hand-adjusted generated object has to be stamped back to the user's
    // values now that the new world exists.
    editor?.reapplyOverrides();
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
  } finally {
    // A superseded transaction must not clear the flag owned by the newer
    // rebuild that replaced it.
    if (requestSerial === reforgeSerial) ctx.state.reforging = false;
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
  // A new seed is a new establishing shot even when its numeric extent happens
  // to match the previous chain. Without this reset, portrait compensation and
  // the seed-dependent dragon/dungeon target could silently retain stale framing.
  ctx.state.lastExtent = 0;
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
const btnDragonGizmo = document.getElementById("btnDragonGizmo") as HTMLButtonElement;
const dragonGizmoPanel = document.getElementById("dragonGizmoPanel")!;
const dragonGizmoReadout = document.getElementById("dragonGizmoReadout")!;
const btnDragonGizmoReset = document.getElementById("btnDragonGizmoReset") as HTMLButtonElement;

// Placement editor for the dragon-side landmark. TransformControls cannot be
// attached directly to dragonLandmark because that group intentionally keeps
// its origin at the dungeon centre; an invisible support-point anchor gives
// the user a useful gizmo at the dragon's feet while the group receives the
// resulting offset. The generated placement stays intact underneath.
const DRAGON_PLACEMENT_KEY = "dungeonforge.dragon-landmark-offset.v4";
let dragonTransform: TransformControls | null = null;
let dragonTransformLoad: Promise<TransformControls> | null = null;
const dragonTransformAnchor = new THREE.Object3D();
dragonTransformAnchor.name = "dragon-placement-transform-anchor";
scene.add(dragonTransformAnchor);

let dragonGizmoActive = false;
let dragonGizmoDragging = false;
let dragonOrbitWasEnabled = true;
const dragonDragAnchorStart = new THREE.Vector3();
const dragonDragLandmarkStart = new THREE.Vector3();
const dragonDragParentStart = new THREE.Vector3();
const dragonDragParentNow = new THREE.Vector3();
const dragonBouncePosition = new THREE.Vector3();
let cachedDragonLandmark: THREE.Group | null | undefined;
let cachedDragonSupportSlot: THREE.Group | null | undefined;
let cachedDragonBounce: THREE.PointLight | null | undefined;
let cachedDragonRim: THREE.PointLight | null | undefined;

function dragonLandmark(): THREE.Group | null {
  cachedDragonLandmark ??= scene.getObjectByName("dragon-slate-spire-landmark") as THREE.Group | undefined;
  return cachedDragonLandmark ?? null;
}

function dragonSupportSlot(): THREE.Group | null {
  cachedDragonSupportSlot ??= scene.getObjectByName("streamed-colossal-perched-dragon-slot") as THREE.Group | undefined;
  return cachedDragonSupportSlot ?? null;
}

function updateDragonGizmoReadout(): void {
  const p = dragonLandmark()?.position;
  dragonGizmoReadout.textContent = p
    ? `Dragon + rock · X ${p.x.toFixed(1)} · Y ${p.y.toFixed(1)} · Z ${p.z.toFixed(1)}`
    : "Dragon landmark unavailable";
}

function syncDragonGizmoAnchor(): void {
  const slot = dragonSupportSlot();
  if (!slot || dragonGizmoDragging) return;
  slot.updateWorldMatrix(true, false);
  slot.getWorldPosition(dragonTransformAnchor.position);
  dragonTransformAnchor.updateMatrixWorld();
}

function saveDragonPlacement(): void {
  const landmark = dragonLandmark();
  if (!landmark) return;
  localStorage.setItem(DRAGON_PLACEMENT_KEY, JSON.stringify(landmark.position.toArray()));
  landmark.userData.editorOffset = landmark.position.toArray();
  console.info(`[dragon placement] offset ${landmark.position.toArray().map((n) => n.toFixed(2)).join(", ")}`);
}

function setDragonPlacementOffset(offset: THREE.Vector3, persist = true): void {
  const landmark = dragonLandmark();
  if (!landmark) return;
  landmark.position.copy(offset);
  landmark.userData.editorOffset = landmark.position.toArray();
  landmark.updateWorldMatrix(true, true);
  syncDragonGizmoAnchor();
  updateDragonGizmoReadout();
  if (persist) saveDragonPlacement();
}

function generatedDragonPlacement(): THREE.Vector3 {
  const value = dragonLandmark()?.userData.generatedPlacement as unknown;
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
    ? new THREE.Vector3(value[0], value[1], value[2])
    : new THREE.Vector3();
}

function restoreDragonPlacement(): void {
  const raw = localStorage.getItem(DRAGON_PLACEMENT_KEY);
  if (!raw) return;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) return;
    setDragonPlacementOffset(new THREE.Vector3(value[0], value[1], value[2]), false);
  } catch {
    localStorage.removeItem(DRAGON_PLACEMENT_KEY);
  }
}

async function ensureDragonTransform(): Promise<TransformControls> {
  if (dragonTransform) return dragonTransform;
  dragonTransformLoad ??= import("three/addons/controls/TransformControls.js").then(({ TransformControls }) => {
    const transform = new TransformControls(camera, renderer.domElement);
    transform.setMode("translate");
    transform.setSpace("world");
    transform.setSize(0.82);
    transform.setTranslationSnap(0.5);
    transform.setColors(0xd65b58, 0x74c57a, 0x638fd6, 0xffd783);
    const helper = transform.getHelper();
    helper.name = "dragon-placement-transform-gizmo";
    scene.add(helper);
    transform.addEventListener("mouseDown", onDragonTransformMouseDown);
    transform.addEventListener("objectChange", onDragonTransformObjectChange);
    transform.addEventListener("mouseUp", onDragonTransformMouseUp);
    dragonTransform = transform;
    return transform;
  });
  return dragonTransformLoad;
}

async function setDragonGizmoActive(active: boolean): Promise<void> {
  if (active === dragonGizmoActive) return;
  const landmark = dragonLandmark();
  if (active && !landmark) return;
  dragonGizmoActive = active;
  if (active) {
    if (walking) stopWalk();
    if (rogueMode) stopRogueRun();
    cine.stop();
    controls.autoRotate = false;
    syncDragonGizmoAnchor();
    const transform = await ensureDragonTransform();
    if (!dragonGizmoActive) return;
    transform.attach(dragonTransformAnchor);
  } else {
    dragonTransform?.detach();
  }
  btnDragonGizmo.classList.toggle("active", active);
  dragonGizmoPanel.classList.toggle("show", active);
  dragonGizmoPanel.setAttribute("aria-hidden", String(!active));
  document.body.classList.toggle("dragon-gizmo", active);
  document.getElementById("tip")!.textContent = active
    ? "drag the colored axes · 0.5-unit snap · Reset restores generated placement"
    : "drag to orbit · scroll to zoom · Esc stops";
  updateDragonGizmoReadout();
}

/** Keep the editor handle attached to the procedurally refitted support point,
 * and move the already allocated hoard bounce with the edited landmark. This
 * is constant-time and allocates nothing in the frame loop. */
function tickDragonPlacementGizmo(): void {
  if (dragonGizmoActive && !dragonGizmoDragging) syncDragonGizmoAnchor();
  const landmark = dragonLandmark();
  const root = landmark?.parent;
  if (!landmark || !root) return;
  cachedDragonBounce ??= scene.getObjectByName("cinematic-dragon-hoard-bounce") as THREE.PointLight | undefined;
  const specs = root.userData.cinematicLights as Array<{
    kind: string; role?: string; x: number; y: number; z: number;
    targetX?: number; targetY?: number; targetZ?: number;
  }> | undefined;
  const spec = specs?.find((light) => light.role === "dragon-focus")
    ?? specs?.find((light) => light.kind === "point");
  const fittedPlacement = root.userData.dragonLightPlacement as number[] | undefined;
  if (!cachedDragonBounce || !spec) return;
  dragonBouncePosition.set(
    spec.x + landmark.position.x - (fittedPlacement?.[0] ?? 0),
    spec.y + landmark.position.y - (fittedPlacement?.[1] ?? 0),
    spec.z + landmark.position.z - (fittedPlacement?.[2] ?? 0),
  );
  root.localToWorld(dragonBouncePosition);
  cachedDragonBounce.position.copy(dragonBouncePosition);

  cachedDragonRim ??= scene.getObjectByName("cinematic-dragon-rim") as THREE.PointLight | undefined;
  const rim = specs?.find((light) => light.role === "dragon-rim");
  if (!cachedDragonRim || !rim) return;
  dragonBouncePosition.set(
    rim.x + landmark.position.x - (fittedPlacement?.[0] ?? 0),
    rim.y + landmark.position.y - (fittedPlacement?.[1] ?? 0),
    rim.z + landmark.position.z - (fittedPlacement?.[2] ?? 0),
  );
  root.localToWorld(dragonBouncePosition);
  cachedDragonRim.position.copy(dragonBouncePosition);
}

function onDragonTransformMouseDown(): void {
  const landmark = dragonLandmark();
  if (!landmark) return;
  dragonGizmoDragging = true;
  dragonOrbitWasEnabled = controls.enabled;
  controls.enabled = false;
  dragonDragAnchorStart.copy(dragonTransformAnchor.position);
  dragonDragLandmarkStart.copy(landmark.position);
  const parent = landmark.parent;
  dragonDragParentStart.copy(dragonDragAnchorStart);
  parent?.worldToLocal(dragonDragParentStart);
}

function onDragonTransformObjectChange(): void {
  const landmark = dragonLandmark();
  if (!landmark || !dragonGizmoDragging) return;
  dragonDragParentNow.copy(dragonTransformAnchor.position);
  landmark.parent?.worldToLocal(dragonDragParentNow);
  landmark.position.copy(dragonDragLandmarkStart)
    .add(dragonDragParentNow.sub(dragonDragParentStart));
  landmark.userData.editorOffset = landmark.position.toArray();
  landmark.updateWorldMatrix(true, true);
  updateDragonGizmoReadout();
}

function onDragonTransformMouseUp(): void {
  dragonGizmoDragging = false;
  controls.enabled = dragonOrbitWasEnabled;
  saveDragonPlacement();
  syncDragonGizmoAnchor();
}

btnDragonGizmo.addEventListener("click", (event) => {
  event.stopPropagation();
  void setDragonGizmoActive(!dragonGizmoActive);
});
btnDragonGizmoReset.addEventListener("click", (event) => {
  event.stopPropagation();
  localStorage.removeItem(DRAGON_PLACEMENT_KEY);
  setDragonPlacementOffset(generatedDragonPlacement(), false);
});
restoreDragonPlacement();

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
  if (destruction?.enabled) {
    destruction.setEnabled(false);
  } else {
    if (breakArming) return;
    breakArming = true;
    btnBreak.classList.add("active");
    document.getElementById("tip")!.textContent = "arming GPU fracture…";
    try {
      const feature = await ensureDestruction();
      await feature.warmup();
      feature.setEnabled(true);
    } catch (error) {
      console.error("[destruction] pipeline failed:", error);
    } finally {
      breakArming = false;
    }
  }
  btnBreak.classList.toggle("active", destruction?.enabled === true);
  document.getElementById("tip")!.textContent = destruction?.enabled
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

// 🛠 dungeon editor: asset library + placement gizmo + generation params.
// Built lazily on first open so neither its TransformControls import nor its
// palette DOM is on the startup path.
const btnEditor = document.getElementById("btnEditor") as HTMLButtonElement;
let editor: import("./editor").DungeonEditor | null = null;
let editorLoad: Promise<import("./editor").DungeonEditor> | null = null;

async function ensureEditor(): Promise<import("./editor").DungeonEditor> {
  if (editor) return editor;
  editorLoad ??= import("./editor").then(({ DungeonEditor }) => {
    const instance = new DungeonEditor({
      scene, camera, dom: renderer.domElement, controls,
      genParams: ctx.genParams,
      state: ctx.state,
      activeMode: () => activeMode,
      reforge,
      // the editor owns the camera while open — nothing else may drive it
      quiesce: () => {
        if (walking) stopWalk();
        if (rogueMode) stopRogueRun();
        cine.stop();
        void setDragonGizmoActive(false);
      },
      setEditorLights: (specs) => ctx.lights.setEditorSpecs(specs),
      toast: (message) => flashRunToast(message),
    });
    editor = instance;
    void instance.restoreSaved();
    return instance;
  });
  return editorLoad;
}

async function toggleEditor(force?: boolean): Promise<void> {
  const instance = await ensureEditor();
  instance.toggle(force);
  btnEditor.classList.toggle("active", instance.open);
  document.getElementById("tip")!.textContent = instance.open
    ? "click a prop to select · 1/2/3 move·rotate·scale · ⌫ delete · ⌘Z undo"
    : "drag to orbit · scroll to zoom · Esc stops";
}

btnEditor.addEventListener("click", () => { void toggleEditor(); });

// 📷 camera shots: fly, press C, keep the framing. Its panel, persistence and
// DOM listeners are useful only after that explicit action, so keep them out
// of the default scene's parse/construction path.
const btnShots = document.getElementById("btnShots") as HTMLButtonElement;
let cameraShots: CameraShots | null = null;
let cameraShotsLoad: Promise<CameraShots> | null = null;

async function ensureCameraShots(): Promise<CameraShots> {
  if (cameraShots) return cameraShots;
  cameraShotsLoad ??= import("./editor/shots").then(({ CameraShots }) => {
    cameraShots = new CameraShots({
      camera,
      controls,
      quiesce: () => {
        if (walking) stopWalk();
        if (rogueMode) stopRogueRun();
        cine.stop();
      },
      toast: (message) => flashRunToast(message),
    });
    return cameraShots;
  });
  try {
    return await cameraShotsLoad;
  } catch (error) {
    cameraShotsLoad = null;
    throw error;
  }
}

btnShots.addEventListener("click", async () => {
  const shots = await ensureCameraShots();
  shots.toggle();
  btnShots.classList.toggle("active", shots.open);
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
    const { Player } = await import("./player/player");
    player = new Player();
    try { await player.load(assetUrl("skeleton-game.glb")); } catch { /* placeholder-only */ }
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
  // Outside the entrance tower's door when the world has one. l.entrance is the
  // old in-fortress cell — a label on a floor tile that nothing arrives at —
  // and remains the fallback for modes that build no ground entrance.
  const x = ctx.spawn ? ctx.spawn.x : island.ox + (l.entrance.x - center) * CELL;
  const z = ctx.spawn ? ctx.spawn.z : island.oz + (l.entrance.y - center) * CELL;
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
  const editingText = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (e.key.toLowerCase() === "g" && !editingText && !e.repeat) {
    void setDragonGizmoActive(!dragonGizmoActive);
    e.preventDefault();
  }
  if (e.key.toLowerCase() === "e" && !editingText && !e.repeat && !e.metaKey && !e.ctrlKey) {
    void toggleEditor();
    e.preventDefault();
  }
  if (e.key.toLowerCase() === "c" && !editingText && !e.repeat && !e.metaKey && !e.ctrlKey) {
    void ensureCameraShots().then((shots) => {
      shots.capture();
      btnShots.classList.add("active");
    });
    e.preventDefault();
  }
  if (e.key === "Escape" && dragonGizmoActive) void setDragonGizmoActive(false);
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
let dprNow = Math.min(devicePixelRatio, startupPrCap);
let frameVsync = 16.7; // rolling estimate of the display refresh interval
let frameDropped = 0;
let frameCounted = 0;
let overloadStreak = 0;
let emergencyShifted = false;
let lastDprAdj = 0;
let coreReady = false;
let decorReady = false;
let decorRevealPending = false;
let decorRevealFrames = 0;
let lodToken = -1;
let lastOcclusionCheck = 0;
const startupTiming = {
  startedAt: pageStartedAt,
  forgeReadyAt: 0,
  coreReadyAt: 0,
  firstVisibleAt: 0,
  postReadyAt: 0,
  postPreviewPrimeReadyAt: 0,
  postPreviewReadyAt: 0,
  shadowReadyAt: 0,
  postModuleRequestedAt: 0,
  postModuleReadyAt: 0,
  maxFrameGapMs: 0,
  frameGaps: [] as number[],
  maxRenderBlockMs: 0,
  renderBlocks: [] as number[],
  renderBlockEvents: [] as Array<{
    at: number;
    duration: number;
    programs: number;
    pipelines: number;
    decor: ReturnType<typeof decorRevealStatus>;
    lodWarm: ReturnType<typeof lodWarmStatus>;
    pipelineWork: {
      renderCalls: number;
      computeCalls: number;
      shaderCalls: number;
      totalMs: number;
      topObjects: Array<{ label: string; count: number }>;
      slowest: Array<{ kind: "render" | "compute" | "shader"; duration: number; label: string }>;
    };
  }>,
  pipelineCreateEvents: [] as Array<{
    at: number;
    kind: "render" | "compute" | "shader";
    duration: number;
    label: string;
  }>,
  postProgramsBefore: 0,
  postProgramsAfter: 0,
  postPipelinesBefore: 0,
  postPipelinesAfter: 0,
  postStageEvents: [] as Array<{
    stage: "preview-prime" | "preview" | "cinematic" | "shadow";
    duration: number;
    programs: number;
    pipelines: number;
    renderCalls: number;
    computeCalls: number;
    shaderCalls: number;
    pipelineMs: number;
    topObjects: Array<{ label: string; count: number }>;
  }>,
  stoneTextureReadyAt: 0,
  coreStreamObjects: 0,
  worldStreamObjects: 0,
  environmentStreamObjects: 0,
  coreStreamInventory: [] as Array<{
    name: string;
    type: string;
    material: string;
    work: number;
    instances: number;
    castShadow: boolean;
  }>,
  coreStreamBatch: startupCoreBatch,
  firstPostStreamBatch: startupFirstPostBatch,
  decorStreamBatch: startupDecorBatch,
  localDecorStreamObjects: 0,
  decorLayersReadyAt: 0,
  landmarksReadyAt: 0,
  coreStreamReadyAt: 0,
  decorReadyAt: 0,
};
const pipelineTraceCalls: Array<{
  kind: "render" | "compute" | "shader";
  duration: number;
  label: string;
}> = [];
function traceWebGpuPipelineCreation(): void {
  const backend = renderer.backend as unknown as Record<string, unknown> & { device?: Record<string, unknown> };
  const device = backend.device;
  if (!device || (backend as { __dfTraced?: boolean }).__dfTraced) return;
  (backend as { __dfTraced?: boolean }).__dfTraced = true;
  const record = (kind: "render" | "compute" | "shader", duration: number, label: string) => {
    if (pipelineTraceCalls.length < 5000) pipelineTraceCalls.push({ kind, duration, label });
    if (duration <= 50 || startupTiming.pipelineCreateEvents.length >= 48) return;
    startupTiming.pipelineCreateEvents.push({
      at: performance.now(), kind, duration: Math.round(duration), label,
    });
  };
  const wrapBackend = (method: "createRenderPipeline" | "createComputePipeline", kind: "render" | "compute") => {
    const original = backend[method];
    if (typeof original !== "function") return;
    backend[method] = function (this: unknown, subject: unknown, ...rest: unknown[]) {
      const renderObject = subject as {
        object?: { name?: string; type?: string };
        material?: { name?: string; type?: string };
        geometry?: { name?: string; type?: string };
        name?: string;
      };
      const label = kind === "render"
        ? `${renderObject.object?.name || renderObject.object?.type || "object"} · ${renderObject.material?.name || renderObject.material?.type || "material"} · ${renderObject.geometry?.name || renderObject.geometry?.type || "geometry"}`
        : renderObject.name || "compute-pipeline";
      const started = performance.now();
      const result = (original as (this: unknown, ...args: unknown[]) => unknown).call(this, subject, ...rest);
      record(kind, performance.now() - started, label);
      return result;
    };
  };
  wrapBackend("createRenderPipeline", "render");
  wrapBackend("createComputePipeline", "compute");
  const wrap = (method: "createRenderPipeline" | "createComputePipeline", kind: "render" | "compute") => {
    const original = device[method];
    if (typeof original !== "function") return;
    device[method] = function (this: unknown, descriptor: { label?: string }) {
      const started = performance.now();
      const result = (original as (this: unknown, descriptor: object) => unknown).call(this, descriptor);
      const duration = performance.now() - started;
      record(kind, duration, descriptor.label ?? "unlabelled");
      return result;
    };
  };
  wrap("createRenderPipeline", "render");
  wrap("createComputePipeline", "compute");
  const originalShaderModule = device.createShaderModule;
  if (typeof originalShaderModule === "function") {
    device.createShaderModule = function (this: unknown, descriptor: { label?: string }) {
      const started = performance.now();
      const result = (originalShaderModule as (this: unknown, descriptor: object) => unknown).call(this, descriptor);
      record("shader", performance.now() - started, descriptor.label ?? "unlabelled-shader");
      return result;
    };
  }
}
function adaptResolution(t: number, rawMs: number): void {
  // Resolution changes are NOT cheap on this renderer: ClusteredLightsNode
  // derives its cluster grid from the drawing-buffer size, so every
  // setPixelRatio call changes the lights-node cache key, invalidates every
  // render object in the scene and forces a full WGSL rebuild — a
  // multi-second main-thread stall (measured 3.3–3.6s per step, 22s+ when the
  // old controller walked several steps during boot). A per-second walk-up /
  // walk-down controller turns that stall into a periodic storm, so the
  // resolution is PINNED to the mode cap instead, with a single emergency
  // downshift for genuinely overloaded GPUs (sustained vsync drops for 15s).
  frameVsync = Math.min(frameVsync * 1.02, Math.max(4, Math.min(rawMs, 25)));
  frameCounted++;
  if (rawMs > frameVsync * 1.6) frameDropped++;
  if (t - lastDprAdj < 1) return;
  lastDprAdj = t;
  const dropRate = frameDropped / Math.max(1, frameCounted);
  frameDropped = 0;
  frameCounted = 0;
  overloadStreak = dropRate > 0.25 ? overloadStreak + 1 : 0;
  const cap = Math.min(devicePixelRatio, ctx.state.prCap);
  let next = dprNow;
  if (!emergencyShifted && overloadStreak >= 15 && dprNow > 1) {
    emergencyShifted = true; // one-way: never oscillate back into a rebuild
    next = Math.max(1, cap - 0.35);
  } else if (dprNow > cap) {
    next = cap; // mode cap shrank (large chain) — one-time clamp at forge
  } else if (dprNow < cap && !emergencyShifted) {
    next = cap; // mode cap grew back on a smaller re-forge
  }
  if (next !== dprNow) {
    dprNow = next;
    renderer.setPixelRatio(dprNow);
    console.log(`[frame] pixelRatio → ${dprNow.toFixed(2)} (full pipeline rebuild)`);
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
  if (urlParams.has("bench")) traceWebGpuPipelineCreation();

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

  // Wave 1 is a direct scene render. Forge runs alongside renderer.init(), so
  // a fast CPU can finish every block before the renderer is ready. Rendering
  // the whole completed chain here defeated the intended "first island"
  // paint and made a cold WebGPU driver realize hundreds of objects behind the
  // opaque loading screen (12 s measured on Chrome). Temporarily submit only
  // the first playable block; the forge remains complete in memory and the
  // remaining groups rejoin immediately after this first useful frame.
  const firstPaintGroup = ctx.worlds[0].group;
  const deferredFirstPaintGroups = [...new Set(ctx.worlds.map((world) => world.group))]
    .filter((group) => group !== firstPaintGroup && group.visible);
  for (const group of deferredFirstPaintGroups) group.visible = false;

  // A first paint needs the generated silhouette, not every final shader.
  // Submit only the coarse floor/masonry meshes with one unlit material and a
  // flat abyss backdrop. The normal scene graph is restored before the next
  // frame, which can compile lighting, fog, landmarks and detail while this
  // useful preview remains on the canvas instead of the loading card.
  const previewKeys = new Set([
    "blocksLo", "blocksMidLo", "blockTopsLo",
    "tilesLo", "tilesMidLo", "stepsLo", "colsLo",
  ]);
  const deferredFirstPaintObjects: THREE.Object3D[] = [];
  const hideVisibleRenderables = (
    root: THREE.Object3D | undefined,
    keep: (object: THREE.Object3D) => boolean,
  ): void => {
    root?.traverse((object) => {
      const renderable = (object as THREE.Mesh).isMesh
        || (object as THREE.Line).isLine
        || (object as THREE.Sprite).isSprite;
      if (!renderable || !object.visible || keep(object)) return;
      object.visible = false;
      deferredFirstPaintObjects.push(object);
    });
  };
  hideVisibleRenderables(scene.getObjectByName("environment"), () => false);
  hideVisibleRenderables(firstPaintGroup, (object) => previewKeys.has(object.name));

  const previewMaterial = new THREE.MeshBasicNodeMaterial({
    color: 0x435565,
    vertexColors: true,
  });
  const savedOverrideMaterial = scene.overrideMaterial;
  const savedBackground = scene.background;
  const savedBackgroundNode = scene.backgroundNode;
  const savedFogNode = scene.fogNode;
  const savedShadows = renderer.shadowMap.enabled;
  scene.overrideMaterial = previewMaterial;
  scene.background = new THREE.Color(0x0a0e1c);
  scene.backgroundNode = null;
  scene.fogNode = null;
  renderer.shadowMap.enabled = false;
  try {
    renderer.render(scene, camera);
    const queue = (renderer.backend as unknown as {
      device?: { queue?: { onSubmittedWorkDone?: () => Promise<void> } };
    }).device?.queue;
    await (queue?.onSubmittedWorkDone?.() ?? Promise.resolve());
  } finally {
    renderer.shadowMap.enabled = savedShadows;
    scene.fogNode = savedFogNode;
    scene.backgroundNode = savedBackgroundNode;
    scene.background = savedBackground;
    scene.overrideMaterial = savedOverrideMaterial;
    for (const object of deferredFirstPaintObjects) object.visible = true;
    for (const group of deferredFirstPaintGroups) group.visible = true;
    previewMaterial.dispose();
  }
  coreReady = true;
  startupTiming.coreReadyAt = performance.now();
  startupTiming.firstVisibleAt = performance.now();
  loadingEl.style.opacity = "0";
  loadingEl.style.visibility = "hidden";
  loadingEl.style.display = "none";
  // Fetch the cinematic module as soon as the useful coarse frame is on
  // screen. Keep this promise so CPU forging and module parsing can finish in
  // parallel, then submit the complete world only through the final shared
  // ScenePass. Rendering the restored full scene directly while this import
  // was pending compiled every object once here and again in ScenePass.
  const cinematicPostStarted = loadCinematicPost();
  // Masonry stays on its neutral resident maps during startup. Updating a
  // shared Texture after WebGPU has realized the world invalidates every
  // concrete render object (~1,070 on the default chain), while direct queue
  // copies expose a Chrome MRT bug that turns the titan skull into a white
  // bloom mask. The procedural grain, joints, wear and cracks already carry
  // the wide shot; streamed surface maps remain outside the live scene until
  // they can be isolated behind a renderer-safe upload path.

  // Keep the partial world alive and animated while layout/build work yields
  // between islands. This callback is replaced atomically by the full game
  // loop below as soon as forging is complete.
  let cinematicPostEnabled = false;
  let earlyLastT = performance.now() / 1000;
  renderer.setAnimationLoop(() => {
    const t = performance.now() / 1000;
    const rawMs = (t - earlyLastT) * 1000;
    const dt = Math.min(0.05, t - earlyLastT);
    earlyLastT = t;
    if (rawMs > 100) {
      startupTiming.maxFrameGapMs = Math.max(startupTiming.maxFrameGapMs, rawMs);
      if (startupTiming.frameGaps.length < 32) startupTiming.frameGaps.push(Math.round(rawMs));
    }
    controls.update();
    for (const world of ctx.worlds) world.tick(t);
    ctx.actors.tick(t, dt);
    ctx.lights.tick(t, 0.3);
  });

  // Until ScenePass exists the already-presented coarse frame deliberately
  // remains on the canvas. This short hold avoids a second cold realization
  // of the complete scene while still letting forge and the dynamic import
  // make progress together. A failed optional import resolves to null and the
  // full loop below falls back to a single direct realization.
  await Promise.all([forging, cinematicPostStarted]);
  if (forgeErr !== null || ctx.worlds.length === 0) throw forgeErr ?? new Error("Dungeon forge produced no world");
  // Preview and cinematic pipelines can share the ScenePass node but Three's
  // renderer still gives each RenderPipeline a distinct render context. The
  // old preview→post switch therefore recreated all 392 default-scene render
  // objects. Enter the final context while the world is still sparse and keep
  // every subsequent streamed object in that one context for its whole life.
  cinematicPostEnabled = cinematicPost !== null;
  // The coarse first paint deliberately had shadows disabled and therefore
  // did not allocate the static moon map. Forge may have requested several
  // bakes while assembling CPU objects; clear that pending bit so the shared
  // ScenePass preview and the fullscreen post graph each get their own frame.
  // We request the one real bake immediately after the final post appears.
  if (cinematicPostEnabled) ctx.env.godrayLight.shadow.needsUpdate = false;
  // Establish global GPU-owned buckets before inventorying per-slot objects.
  // Otherwise a source such as `blocksLo` enters the deferred queue, is then
  // replaced by an indirect bucket, and the stale queue later makes that
  // managed source visible again. Rebuilding here lets canStream() exclude the
  // exact render objects the GPU scene has already superseded.
  gpuScene.rebuild();
  gpuScene.setCompactedDecorVisible(false);
  const splitSharedScenePreview = cinematicPostEnabled
    && cinematicPost !== null
    && cinematicPost.preview !== cinematicPost.post;
  if (splitSharedScenePreview) gpuScene.setLowSurfacesVisible(false);
  // Keep the first playable block plus the dragon/skull/main beam intact and
  // stage every secondary environment object alongside the remaining dungeon.
  // The foreground subjects therefore arrive as one authored composition,
  // while fog, horizon remnants, oracle dressing and distant masonry fill in
  // over subsequent frames instead of joining one cold 128-call submission.
  const isRenderable = (object: THREE.Object3D): boolean => (
    (object as THREE.Mesh).isMesh
    || (object as THREE.Line).isLine
    || (object as THREE.Sprite).isSprite
  );
  const canStream = (object: THREE.Object3D): boolean => {
    if (!isRenderable(object) || !isEffectivelyVisible(object)) return false;
    const instanced = object as THREE.InstancedMesh;
    return !instanced.isInstancedMesh || (
      instanced.count > 0
      && !(instanced.userData as { gpuSceneManaged?: boolean }).gpuSceneManaged
    );
  };
  const hasAncestorNamed = (object: THREE.Object3D, names: ReadonlySet<string>): boolean => {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (names.has(current.name)) return true;
      current = current.parent;
    }
    return false;
  };
  // The shadow aperture is part of the main beam, not late atmosphere. Keeping
  // it in the first authored composition makes the shaft appear with the
  // dragon/skull and lets the dedicated startup shadow frame realize its real
  // occluder. The two additive dust blades remain in the later queue: they are
  // texture, not structure, and including them made one measured ScenePass
  // prime graze 101 ms. Moving only the aperture removes two work units from
  // the later queue (44 → 42), still enough for the safe 14-unit budget to
  // finish it in three frames instead of a nearly-empty fourth frame.
  // `criticalBeam=0` is retained as an exact browser A/B escape hatch.
  const criticalBeam = urlParams.get("criticalBeam") !== "0";
  const criticalEnvironmentRoots = new Set([
    "streamed-colossal-perched-dragon-slot",
  ]);
  const criticalEnvironmentObjects = new Set([
    "terraced-weathered-abyss-bedrock",
    "colossal-dragon-slate-spire",
    ...(criticalBeam ? ["procedural-overhead-cavern-godray-aperture"] : []),
  ]);
  // Hide the async oracle at its stable parent, not at whichever streamed
  // children happen to exist during this traversal. Otherwise a shell that
  // finishes one frame later bypasses the inventory and unexpectedly adds ten
  // cold render/shader realizations to the ScenePass preview.
  const deferredEnvironmentRoots = [
    scene.getObjectByName("abyssal-cephalopod-oracle"),
  ].filter((object): object is THREE.Object3D => Boolean(object?.parent && object.visible));
  for (const root of deferredEnvironmentRoots) root.visible = false;
  const deferredEnvironmentObjects: THREE.Object3D[] = [];
  scene.getObjectByName("environment")?.traverse((object) => {
    if (!canStream(object)
      || criticalEnvironmentObjects.has(object.name)
      || hasAncestorNamed(object, criticalEnvironmentRoots)) return;
    object.visible = false;
    deferredEnvironmentObjects.push(object);
  });
  // Population is five fixed instanced batches, independent of island count.
  // They are gameplay-important but not part of the dragon/skull establishing
  // silhouette, so spread them through the environment side of the core queue
  // instead of compiling all five in the first preview.
  const deferredActorObjects = ctx.actors.startupRenderables()
    .filter((object) => canStream(object));
  for (const object of deferredActorObjects) object.visible = false;
  deferredEnvironmentObjects.unshift(...deferredEnvironmentRoots, ...deferredActorObjects);

  const deferredWorldObjects: THREE.Object3D[] = [];
  const deferredGroups = [...new Set(ctx.worlds.map((world) => world.group))]
    .filter((group) => group.visible);
  for (const group of deferredGroups) {
    group.traverse((object) => {
      if (!canStream(object)) return;
      // The resident low-LOD silhouette of the first island has already been
      // presented by the coarse paint and is needed beneath the dragon. Its
      // ancillary meshes are not: putting those into the same final-context
      // queue as every other island removes a block-sized material burst from
      // the shared ScenePass preview without changing the authored layout.
      if (group === firstPaintGroup && previewKeys.has(object.name)) return;
      object.visible = false;
      deferredWorldObjects.push(object);
    });
  }
  // Two dungeon objects followed by one environment object gives the playable
  // chain priority without letting the atmosphere pop in as one late layer.
  const deferredCoreObjects: THREE.Object3D[] = [];
  for (let worldCursor = 0, environmentCursor = 0;
    worldCursor < deferredWorldObjects.length || environmentCursor < deferredEnvironmentObjects.length;) {
    for (let i = 0; i < 2 && worldCursor < deferredWorldObjects.length; i++) {
      deferredCoreObjects.push(deferredWorldObjects[worldCursor++]);
    }
    if (environmentCursor < deferredEnvironmentObjects.length) {
      deferredCoreObjects.push(deferredEnvironmentObjects[environmentCursor++]);
    }
  }
  startupTiming.worldStreamObjects = deferredWorldObjects.length;
  startupTiming.environmentStreamObjects = deferredEnvironmentObjects.length;
  startupTiming.coreStreamObjects = deferredCoreObjects.length;
  if (urlParams.get("profile") === "1") {
    startupTiming.coreStreamInventory = deferredCoreObjects.map((object) => {
      const renderable = object as THREE.Mesh & THREE.InstancedMesh;
      const materials = renderable.material
        ? (Array.isArray(renderable.material) ? renderable.material : [renderable.material])
        : [];
      return {
        name: object.name || object.type,
        type: object.type,
        material: materials.map((material) => material.name || material.type).join("+") || "group",
        work: startupRenderWork(object),
        // Node-driven Sprite batches expose their draw instance count directly
        // without pretending to be InstancedMesh. Report the renderer-facing
        // count so startup inventory does not understate those batches.
        instances: Number.isFinite(renderable.count) ? renderable.count : 1,
        castShadow: renderable.castShadow === true,
      };
    });
  }
  let deferredCoreCursor = 0;
  const revealDeferredCore = (budget: number): boolean => {
    // Zero is an authored phase boundary, not an undersized positive budget:
    // the shared ScenePass preview must contain no queued Oracle/environment
    // object. Clamping it to one reintroduced the exact cold landmark burst
    // `startupFirstPostBatch=0` exists to prevent.
    if (budget <= 0) return deferredCoreCursor >= deferredCoreObjects.length;
    let revealedThisFrame = 0;
    let revealedWork = 0;
    let revealedShadowCaster = false;
    const workBudget = budget;
    while (deferredCoreCursor < deferredCoreObjects.length) {
      const object = deferredCoreObjects[deferredCoreCursor];
      if (!object.parent) {
        deferredCoreCursor++;
        continue;
      }
      const objectWork = startupRenderWork(object);
      if (revealedThisFrame > 0 && revealedWork + objectWork > workBudget) break;
      deferredCoreCursor++;
      object.visible = true;
      revealedShadowCaster ||= (object as THREE.Mesh).castShadow === true;
      revealedThisFrame++;
      revealedWork += objectWork;
    }
    // The directional shadow is intentionally static. Refresh it only when a
    // newly streamed caster joins the scene: its shadow render object is then
    // realized inside the same three-object budget as its colour pass. The old
    // fixed 1.5 s rebake discovered 20+ cold shadow objects in one frame and
    // caused a second ~110 ms hitch after the dungeon appeared.
    if (revealedShadowCaster) ctx.env.bakeShadows();
    const complete = deferredCoreCursor >= deferredCoreObjects.length;
    if (complete && startupTiming.coreStreamReadyAt === 0) {
      startupTiming.coreStreamReadyAt = performance.now();
    }
    return complete;
  };
  // CPU generation is complete and the coarse canvas is still visible. The
  // progressive queues below now populate the one final cinematic context.
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
  let decorRevealRequested = false;
  let startupStreamingCancelled = false;
  let compactedDecorPreviewPending = false;
  let localDecorRevealNeeded = false;
  let decorReadyAfterRender = false;
  let decorLayersSubmitted = false;
  const startProgressiveDecor = (): void => {
    if (startupStreamingCancelled) return;
    decorRevealFrames = 0;
    startupTiming.localDecorStreamObjects = startupDecorRenderObjectCount();
    localDecorRevealNeeded = startupTiming.localDecorStreamObjects > 0;
    compactedDecorPreviewPending = gpuScene.hasCompactedDecor();
    decorRevealPending = localDecorRevealNeeded && !compactedDecorPreviewPending;
    if (gpuScene.setCompactedDecorVisible(true)) ctx.env.bakeShadows();
    if (!localDecorRevealNeeded) {
      // LOD0 has no local shells to submit. Clear suppression now so a later
      // near-LOD promotion can reveal its detail normally, and finish only
      // after this frame has really drawn the global decor.
      cancelDecorReveal();
      decorReadyAfterRender = true;
    }
  };
  const beginProgressiveDecor = (): void => {
    if (startupStreamingCancelled) return;
    decorRevealRequested = true;
    if (deferredCoreCursor >= deferredCoreObjects.length) startProgressiveDecor();
  };

  cancelStartupProgressiveReveal = () => {
    if (startupStreamingCancelled) return;
    startupStreamingCancelled = true;
    // Environment objects persist across New Dungeon; world-slot objects are
    // immediately repopulated by forge(), so only the persistent half needs
    // restoring when this one-shot startup queue is abandoned.
    for (const object of deferredEnvironmentObjects) {
      if (object.parent) object.visible = true;
    }
    deferredCoreCursor = deferredCoreObjects.length;
    decorRevealPending = false;
    compactedDecorPreviewPending = false;
    decorReadyAfterRender = false;
    decorLayersSubmitted = false;
    gpuScene.setCompactedDecorVisible(true);
    cancelDecorReveal();
    if (!decorReady) {
      decorReady = true;
      startupTiming.decorReadyAt ||= performance.now();
    }
  };

  const streamTerminal = (name: string, terminal: readonly string[]): boolean => {
    const object = scene.getObjectByName(name);
    return Boolean(object && terminal.includes(String(object.userData.streamState)));
  };

  let revealed = true;
  let lastT = performance.now() / 1000;
  renderer.setAnimationLoop(() => {
    const t = performance.now() / 1000;
    const rawMs = (t - lastT) * 1000;
    const dt = Math.min(0.05, t - lastT);
    lastT = t;
    if (rawMs > 100) {
      startupTiming.maxFrameGapMs = Math.max(startupTiming.maxFrameGapMs, rawMs);
      if (startupTiming.frameGaps.length < 32) startupTiming.frameGaps.push(Math.round(rawMs));
    }
    adaptResolution(t, rawMs);
    // runReforge() has already captured the last complete frame into the
    // overlay. Do not submit half-refilled slot pools behind it: those draws
    // used to realize transient render objects, causing several 100–240 ms
    // blocks that the player could not even see. RAF remains alive so Pacer
    // can yield assembly work; the transaction submits once when coherent.
    if (ctx.state.reforging) {
      controls.update();
      return;
    }
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
    destruction?.tick(dt);
    // The first cinematic submission already realizes the post graph and all
    // critical subjects, so keep its scene delta empty. Once that context is
    // hot, the measured core batch shortens complete-scene arrival without
    // raising the first-post compilation peak.
    const finalPostReady = !cinematicPostEnabled || startupTiming.postReadyAt !== 0;
    const startupShadowReady = !cinematicPostEnabled || startupTiming.shadowReadyAt !== 0;
    const coreBatch = finalPostReady && startupShadowReady
      ? startupCoreBatch
      : startupFirstPostBatch;
    if (!ctx.state.reforging && !startupStreamingCancelled
      && revealDeferredCore(coreBatch) && decorRevealRequested
      && !decorRevealPending && !compactedDecorPreviewPending && !decorReady) {
      startProgressiveDecor();
    }
    if (!ctx.state.reforging && !startupStreamingCancelled && compactedDecorPreviewPending) {
      // Two global all-LOD decor objects get one isolated realization frame.
      // The remaining queue starts next frame, so banners/red tiles cannot
      // combine with a full detail batch into a new cold-render spike.
      compactedDecorPreviewPending = false;
      decorRevealPending = localDecorRevealNeeded;
    } else if (!ctx.state.reforging && !startupStreamingCancelled && decorRevealPending) {
      // Most pooled details are zero-count at far LOD, but architectural bays
      // intentionally survive every distance tier. Reveal one concrete object
      // per final-context frame so their NodeMaterial setup cannot collapse
      // the first visible frame into one monolithic compile.
      decorRevealFrames++;
      if (revealDecor(startupDecorBatch)) {
        decorRevealPending = false;
        decorReadyAfterRender = true;
      }
    }
    // distance LOD: far islands drop their small-detail layers. TRUE 3D
    // distance — a camera hovering 200 units above a spire is far from every
    // island even when its xz distance is small
    if (!ctx.state.reforging && lodToken !== ctx.state.token) {
      lodToken = ctx.state.token;
      slotDetail.clear();
      destruction?.reset();
    }
    let nearestD = Infinity;
    let lodSlot = -1, lodWant: LodLevel = 0, lodPriority = Infinity;
    for (const isl of ctx.state.reforging ? [] : ctx.walk.islands) {
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
      if (destruction?.enabled) want = 2;
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
    tickDragonPlacementGizmo();
    route.tick(); // a re-forge invalidates the drawn route
    navOverlay.tick();
    // toggle highlights follow the real state (route/nav can self-hide on
    // re-forge; cine exits on any input) — classList.toggle no-ops if unchanged
    btnCine.classList.toggle("active", cine.active);
    btnRoute.classList.toggle("active", route.visible);
    btnNav.classList.toggle("active", navOverlay.visible);
    btnWalk.classList.toggle("active", walking);
    btnBreak.classList.toggle("active", destruction?.enabled === true);
    btnPlay.classList.toggle("active", rogueMode);
    // distance calms the flicker: near 60 units torches dance at full
    // amplitude; past ~150 they settle to a steady candle glow (dozens of
    // asynchronous flickers read as an uncomfortable shimmer from afar)
    const damp = Math.min(1, Math.max(0.1, 1 - (nearestD - 60) / 90));
    flickerDamp.value = damp;
    ctx.lights.tick(t, damp);
    ctx.env.tick(camera);
    gpuScene.tick(camera);
    const pipelineTraceStart = pipelineTraceCalls.length;
    const warmingStartupShadow = cinematicPostEnabled
      && startupTiming.postReadyAt !== 0
      && startupTiming.shadowReadyAt === 0;
    let startupPostStage: "preview-prime" | "preview" | "cinematic" | "shadow" | "" = "";
    const r0 = performance.now();
    if (cinematicPostEnabled && cinematicPost) {
      const needsSharedScenePrime = splitSharedScenePreview
        && startupTiming.postPreviewPrimeReadyAt === 0;
      const needsSharedScenePreview = startupTiming.postPreviewReadyAt === 0
        && cinematicPost.preview !== cinematicPost.post;
      const firstPost = !needsSharedScenePrime
        && !needsSharedScenePreview
        && startupTiming.postReadyAt === 0;
      if (firstPost) {
        startupTiming.postProgramsBefore = renderer.info.memory.programs;
        startupTiming.postPipelinesBefore = (renderer as unknown as {
          _pipelines?: { caches?: { size?: number } };
        })._pipelines?.caches?.size ?? 0;
      }
      if (needsSharedScenePrime) {
        startupPostStage = "preview-prime";
        // First realize the authored subjects plus global masonry. The coarse
        // canvas already contains a walkable floor silhouette, so the four
        // low-surface buckets can safely enter the same ScenePass one frame
        // later instead of adding their material graphs to this peak.
        cinematicPost.preview.render();
        startupTiming.postPreviewPrimeReadyAt = performance.now();
        gpuScene.setLowSurfacesVisible(true);
      } else if (needsSharedScenePreview) {
        startupPostStage = "preview";
        // `preview` reads the exact ScenePass texture used by the cinematic
        // chain. Realize the critical scene materials and their shadow paths
        // in that shared context first, then let bloom / atmosphere / godrays
        // join on the following frame. This replaces one monolithic cold
        // submission with two useful pictures; it does not render the scene
        // into a throwaway context or compile any object twice.
        cinematicPost.preview.render();
        startupTiming.postPreviewReadyAt = performance.now();
      } else {
        if (firstPost) startupPostStage = "cinematic";
        else if (warmingStartupShadow) startupPostStage = "shadow";
        postProcessing.render();
      }
      if (firstPost) {
        startupTiming.postReadyAt = performance.now();
        startupTiming.postProgramsAfter = renderer.info.memory.programs;
        startupTiming.postPipelinesAfter = (renderer as unknown as {
          _pipelines?: { caches?: { size?: number } };
        })._pipelines?.caches?.size ?? 0;
      }
    } else {
      renderer.render(scene, camera);
    }
    if (warmingStartupShadow) startupTiming.shadowReadyAt = performance.now();
    // Split the new global low-masonry shadow realization from the already
    // expensive first cinematic colour submission. The first complete frame
    // still contains every wall; only its static shadow map arrives one frame
    // later, then remains baked for the session.
    if ((!cinematicPostEnabled || startupTiming.postReadyAt !== 0)
      && gpuScene.enableLowMasonryShadows()) {
      ctx.env.bakeShadows();
    }
    lodWarmRestore?.();
    const rDur = performance.now() - r0;
    if (startupPostStage) {
      const pipelineCalls = pipelineTraceCalls.slice(pipelineTraceStart);
      const renderObjectCounts = new Map<string, number>();
      for (const call of pipelineCalls) {
        if (call.kind !== "render") continue;
        const label = call.label.split(" · ", 1)[0];
        renderObjectCounts.set(label, (renderObjectCounts.get(label) ?? 0) + 1);
      }
      startupTiming.postStageEvents.push({
        stage: startupPostStage,
        duration: rDur,
        programs: renderer.info.memory.programs,
        pipelines: (renderer as unknown as {
          _pipelines?: { caches?: { size?: number } };
        })._pipelines?.caches?.size ?? 0,
        renderCalls: pipelineCalls.filter((call) => call.kind === "render").length,
        computeCalls: pipelineCalls.filter((call) => call.kind === "compute").length,
        shaderCalls: pipelineCalls.filter((call) => call.kind === "shader").length,
        pipelineMs: pipelineCalls.reduce((sum, call) => sum + call.duration, 0),
        topObjects: [...renderObjectCounts]
          .map(([label, count]) => ({ label, count }))
          .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      });
    }
    if (decorReadyAfterRender) {
      decorReadyAfterRender = false;
      decorLayersSubmitted = true;
      startupTiming.decorLayersReadyAt ||= performance.now();
    }
    // "Complete" means the actual authored composition, not merely the local
    // instance queues. Async hero/horizon children can join visible parents
    // after startup inventory; wait until each is terminal, then mark ready
    // only after this frame has submitted those newly attached renderables.
    const landmarksReady = streamTerminal(
      "streamed-colossal-perched-dragon-slot", ["ready", "failed"],
    ) && streamTerminal(
      "abyssal-cephalopod-oracle", ["ready", "fallback"],
    ) && streamTerminal("horizon-ring", ["ready"]);
    if (landmarksReady) startupTiming.landmarksReadyAt ||= performance.now();
    if (!decorReady && decorLayersSubmitted && landmarksReady) {
      decorReady = true;
      startupTiming.decorReadyAt = performance.now();
      resolveStartupSceneReady();
      slotDetail.clear(); // let distance LOD re-apply to the revealed layers
    }
    if (rDur > 100) {
      const pipelineCalls = pipelineTraceCalls.slice(pipelineTraceStart);
      const renderObjectCounts = new Map<string, number>();
      for (const call of pipelineCalls) {
        if (call.kind !== "render") continue;
        const label = call.label.split(" · ", 1)[0];
        renderObjectCounts.set(label, (renderObjectCounts.get(label) ?? 0) + 1);
      }
      startupTiming.maxRenderBlockMs = Math.max(startupTiming.maxRenderBlockMs, rDur);
      if (startupTiming.renderBlocks.length < 32) startupTiming.renderBlocks.push(Math.round(rDur));
      if (startupTiming.renderBlockEvents.length < 32) {
        startupTiming.renderBlockEvents.push({
          at: performance.now(),
          duration: Math.round(rDur),
          programs: renderer.info.memory.programs,
          pipelines: (renderer as unknown as {
            _pipelines?: { caches?: { size?: number } };
          })._pipelines?.caches?.size ?? 0,
          decor: decorRevealStatus(),
          lodWarm: lodWarmStatus(),
          pipelineWork: {
            renderCalls: pipelineCalls.filter((call) => call.kind === "render").length,
            computeCalls: pipelineCalls.filter((call) => call.kind === "compute").length,
            shaderCalls: pipelineCalls.filter((call) => call.kind === "shader").length,
            totalMs: Math.round(pipelineCalls.reduce((sum, call) => sum + call.duration, 0)),
            topObjects: [...renderObjectCounts]
              .map(([label, count]) => ({ label, count }))
              .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
              .slice(0, 64),
            slowest: [...pipelineCalls]
              .sort((a, b) => b.duration - a.duration)
              .slice(0, 5)
              .map((call) => ({ ...call, duration: Math.round(call.duration) })),
          },
        });
      }
      console.log(`[frame] render() blocked ${rDur.toFixed(0)}ms`);
    }
    if (!revealed && ctx.worlds.length > 0 && coreReady) {
      revealed = true;
      loadingEl.style.opacity = "0";
      loadingEl.style.visibility = "hidden";
    }
  });
  // Arm detail immediately. This does not reveal anything early: the main loop
  // still requires the final post, startup shadow and complete core queue.
  // The former fixed 350 ms timer predated those explicit gates; once the
  // pipeline became faster it idled after core completion and added 40–100 ms
  // to the real complete-picture time. The already-settled post import makes
  // the request synchronous here, while the same direct-render fallback is
  // preserved if that optional module failed.
  void loadCinematicPost().finally(beginProgressiveDecor);
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
  godrayStats,
  get editor() { return editor; },
  openEditor: (open?: boolean) => toggleEditor(open),
  get cameraShots() { return cameraShots; },
  ensureCameraShots,
  stoneStyle,
  /** Landmark streaming, per request: requested / loaded / failed. */
  landmarkStreams: () => landmarkStreamStatus(),
  godray: {
    get shape() { return getGodrayShape(); },
    /** Live — the aperture re-seats immediately, no re-forge. */
    set(partial: Partial<GodrayShape>) { return setGodrayShape(partial); },
    save() { saveGodrayShape(); },
    reset() { return resetGodrayShape(); },
  },
  masonry: {
    get interiorCull() { return getInteriorCull(); },
    /** Turn the interior-course cull off, then re-forge, to tell whether a
     *  see-through wall is the cull or the geometry. */
    setInteriorCull(on: boolean) { setInteriorCull(on); },
    get closedCourses() { return getClosedCourses(); },
    /** Draw every course with the sealed box. Re-forge after changing. */
    setClosedCourses(on: boolean) { setClosedCourses(on); },
    get farShadows() { return getFarShadows(); },
    /** Far-LOD masonry shadow casting. Re-forge after changing. */
    setFarShadows(on: boolean) { setFarShadows(on); },
    /** Pin every slot to one LOD tier, to measure the value pop at a switch. */
    forceLod(level: 0 | 1 | 2) {
      for (const pool of gpuSceneSlotPools()) setSlotLodLevel(pool.slot, level);
    },
  },
  gpuScene,
  get destruction() { return destruction; },
  ensureDestruction,
  dragonPlacement: {
    get controls() { return dragonTransform; },
    anchor: dragonTransformAnchor,
    setActive: setDragonGizmoActive,
    reset() {
      localStorage.removeItem(DRAGON_PLACEMENT_KEY);
      setDragonPlacementOffset(generatedDragonPlacement(), false);
    },
    setOffset(x: number, y: number, z: number) {
      setDragonPlacementOffset(new THREE.Vector3(x, y, z));
    },
    getOffset() { return dragonLandmark()?.position.clone() ?? new THREE.Vector3(); },
  },
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
