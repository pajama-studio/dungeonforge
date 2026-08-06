// Dungeonforge — procedural stone-labyrinth fortress diorama.
// three.js WebGPURenderer + TSL; MRT emissive bloom; deterministic seeds.

import * as THREE from "three/webgpu";
import { pass } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DEFAULT_PARAMS, type Layout, type Params } from "./gen/dungeon";
import { buildWorld, type WorldHandle } from "./scene/build";
import { buildEnvironment, TH } from "./scene/env";
import { mulberry32 } from "./gen/rng";

const app = document.getElementById("app")!;
const nameEl = document.getElementById("dungeonName")!;
const seedEl = document.getElementById("seedLabel")!;
const loadingEl = document.getElementById("loading")!;
const btnNew = document.getElementById("btnNew") as HTMLButtonElement;
const btnGo = document.getElementById("btnGo") as HTMLButtonElement;
const seedInput = document.getElementById("seedInput") as HTMLInputElement;

const params = new URLSearchParams(location.search);
let seed = Number(params.get("seed")) || 20260806;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.5, 400);
camera.position.set(46, 36, 66); // lower, more oblique — facades and height read stronger

const renderer = new THREE.WebGPURenderer({ antialias: false });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); // bloom hides the difference; fill rate is the budget
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
renderer.domElement.addEventListener("pointerdown", () => { controls.autoRotate = false; }, { once: false });

// post: single-attachment scene pass + HDR-threshold bloom. Glow materials
// output linear values > 1, so only they (and the hottest torch-lit stone,
// which is the reference look anyway) cross the threshold.
const postProcessing = new THREE.PostProcessing(renderer);
const scenePass = pass(scene, camera);
const scenePassColor = scenePass.getTextureNode();
const bloomPass = bloom(scenePassColor, 0.9, 0.4, 1.1);
postProcessing.outputNode = scenePassColor.add(bloomPass);

const env = buildEnvironment(scene, 1); // env is seed-stable; kept across regens

let world: WorldHandle | null = null;

// Generation runs in a worker (pure data, transferable typed arrays) — the
// main thread only fills instance buffers. Requests are id-tagged so a stale
// response from rapid re-forging is dropped instead of overwriting a newer one.
const genWorker = new Worker(new URL("./gen/worker.ts", import.meta.url), { type: "module" });
let genId = 0;
const pending = new Map<number, (l: Layout) => void>();
genWorker.onmessage = (e: MessageEvent<{ id: number; layout: Layout }>) => {
  pending.get(e.data.id)?.(e.data.layout);
  pending.delete(e.data.id);
};
const genParams: Params = { ...DEFAULT_PARAMS };

function generateAsync(s: number): Promise<Layout> {
  return new Promise((resolve) => {
    const id = ++genId;
    pending.set(id, resolve);
    genWorker.postMessage({ id, seed: s, params: genParams });
  });
}

// ---- forge-parameter sliders -------------------------------------------------
{
  const panel = document.getElementById("params")!;
  const defs: Array<{ key: keyof Params; label: string; min: number; max: number; step: number }> = [
    { key: "size", label: "dungeon size", min: 9, max: 21, step: 2 },
    { key: "plazas", label: "teleport plazas", min: 0, max: 4, step: 1 },
    { key: "totems", label: "brazier totems", min: 0, max: 10, step: 1 },
    { key: "heightAmp", label: "terrain relief", min: 0, max: 4, step: 0.1 },
    { key: "mound", label: "temple mound", min: 0, max: 5, step: 0.1 },
    { key: "braid", label: "braid (open dead ends)", min: 0, max: 1, step: 0.05 },
    { key: "loops", label: "extra loops", min: 0, max: 0.3, step: 0.01 },
    { key: "newest", label: "maze: branchy ↔ river", min: 0, max: 1, step: 0.05 },
    { key: "torchSpacing", label: "torch spacing", min: 3, max: 9, step: 1 },
    { key: "wallThin", label: "wall thickness", min: 0.25, max: 1, step: 0.05 },
    { key: "decay", label: "age & decay", min: 0, max: 1, step: 0.05 },
  ];
  let debounce = 0;
  for (const d of defs) {
    const label = document.createElement("label");
    label.textContent = d.label + " ";
    const val = document.createElement("span");
    val.textContent = String(genParams[d.key]);
    label.appendChild(val);
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(d.min); input.max = String(d.max); input.step = String(d.step);
    input.value = String(genParams[d.key]);
    input.addEventListener("input", () => {
      (genParams[d.key] as number) = Number(input.value);
      val.textContent = input.value;
      clearTimeout(debounce);
      debounce = window.setTimeout(() => void forge(seed), 180);
    });
    panel.appendChild(label);
    panel.appendChild(input);
  }
}

let lastN = 0;

async function forge(newSeed: number): Promise<void> {
  seed = newSeed >>> 0 || 1;
  const myId = genId + 1;
  const layout = await generateAsync(seed);
  if (myId !== genId) return; // a newer forge superseded this one
  if (world) world.dispose();
  world = buildWorld(layout);
  scene.add(world.group);
  const half = (layout.N * 2.2) / 2;
  env.fit(half);
  if (lastN !== layout.N) {
    // refit the view when the footprint changes; keep the current view direction
    camera.position.sub(controls.target).setLength(half * 2.55).add(controls.target);
    controls.maxDistance = half * 5;
    lastN = layout.N;
  }
  env.bakeShadows();
  nameEl.textContent = layout.name;
  seedEl.textContent = `seed ${seed} · ${layout.stats.floor} floor · ${layout.stats.wall} wall · ${layout.stats.genMs}ms`;
  const url = new URL(location.href);
  url.searchParams.set("seed", String(seed));
  history.replaceState(null, "", url);
}

const uiRng = mulberry32((Date.now() ^ 0x5f3759df) >>> 0); // UI-only randomness; the world itself is seed-pure
btnNew.addEventListener("click", () => void forge((uiRng() * 0xffffffff) >>> 0));
btnGo.addEventListener("click", () => void forge(Number(seedInput.value) || 1));
seedInput.addEventListener("keydown", (e) => { if (e.key === "Enter") void forge(Number(seedInput.value) || 1); });

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

async function boot(): Promise<void> {
  // generation (worker) and WebGPU init run concurrently
  await Promise.all([renderer.init(), forge(seed)]);
  // first render compiles every pipeline (async in WebGPU); materials are
  // shared afterwards, so re-forging never compiles again
  postProcessing.render();
  loadingEl.style.opacity = "0";
  renderer.setAnimationLoop(() => {
    const t = performance.now() / 1000;
    controls.update();
    world?.tick(t);
    postProcessing.render();
  });
}

void boot();

// dev hook for camera scripting (screenshot verification, cinematics)
(window as unknown as { __df: object }).__df = { camera, controls };
