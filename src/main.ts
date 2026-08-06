// Dungeonforge — procedural stone-labyrinth fortress diorama.
// three.js WebGPURenderer + TSL; MRT emissive bloom; deterministic seeds.

import * as THREE from "three/webgpu";
import {
  pass, screenUV, float, smoothstep, vec3, vec4, int, Loop, hash, time, exp,
  color, getViewPosition, cameraProjectionMatrixInverse, cameraWorldMatrix,
  cameraPosition, triNoise3D,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DEFAULT_PARAMS, type Layout, type Params } from "./gen/dungeon";
import { buildWorld, buildBridgeLink, type WorldHandle } from "./scene/build";
import { Player, type GroundSampler } from "./player/player";
import { FLOOR } from "./gen/dungeon";
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
// volumetric ground fog: a depth-aware raymarch through an animated low-lying
// density slab — walls occlude it correctly, wisps roll through corridors, and
// looking toward the moon brightens the fog (cheap forward scattering).
const depthTex = scenePass.getTextureNode("depth");
const vp = getViewPosition(screenUV, depthTex, cameraProjectionMatrixInverse);
const wp = cameraWorldMatrix.mul(vec4(vp, 1)).xyz;
const ro = cameraPosition;
const delta = wp.sub(ro);
const distGeo = delta.length();
const maxDist = distGeo.min(110);
const rd = delta.div(distGeo);
const STEPS = 9;
const stepLen = maxDist.div(STEPS);
const jitter = hash(screenUV.x.mul(1213.7).add(screenUV.y.mul(771.1))); // static dither hides banding
const trans = float(1).toVar();
Loop({ type: "int", start: 0, end: STEPS, condition: "<" }, ({ i }) => {
  const t = float(i).add(jitter).mul(stepLen);
  const p = ro.add(rd.mul(t));
  const hFall = smoothstep(2.8, -5.5, p.y); // slab: dense below the fortress floor, gone above
  const n = triNoise3D(p.mul(0.021).add(vec3(time.mul(0.009), 0, time.mul(0.006))), 0.3, time);
  const dens = hFall.mul(n.mul(0.8).add(0.2)).mul(0.05);
  trans.mulAssign(exp(dens.mul(stepLen).negate()));
});
const moonDirV = new THREE.Vector3(-46, 48, -22).normalize();
const scatter = rd.dot(vec3(moonDirV.x, moonDirV.y, moonDirV.z)).clamp(0, 1).pow(5).mul(0.5).add(1);
const fogCol = color(0x27476b).mul(scatter).mul(0.85);

// cinematic finish: gentle vignette pulls the eye to the lit heart of the maze
const vig = float(1).sub(smoothstep(0.5, 1.02, screenUV.sub(0.5).length().mul(1.35)).mul(0.45));
const composed = scenePassColor.add(bloomPass);
postProcessing.outputNode = composed.mul(trans).add(fogCol.mul(float(1).sub(trans))).mul(vig);

const env = buildEnvironment(scene, 1); // env is seed-stable; kept across regens

const worlds: WorldHandle[] = [];

// walkability data captured at forge time for the third-person mode
const TH_W = 1.85;
interface IslandWalk { l: Layout; ox: number; oz: number; stairDir: Map<number, number> }
interface LinkWalk { a: THREE.Vector3; b: THREE.Vector3; sag: number }
const walkIslands: IslandWalk[] = [];
const walkLinks: LinkWalk[] = [];

const sampleGround: GroundSampler = (x, z) => {
  for (const isl of walkIslands) {
    const { l, ox, oz } = isl;
    const gx = Math.round((x - ox) / CELL + (l.N - 1) / 2);
    const gy = Math.round((z - oz) / CELL + (l.N - 1) / 2);
    if (gx < 0 || gy < 0 || gx >= l.N || gy >= l.N) continue;
    const c = gy * l.N + gx;
    if (l.kind[c] !== FLOOR) return { y: 0, ok: false };
    let y = l.tier[c] * TH_W + 0.16;
    const sd = isl.stairDir.get(c);
    if (sd !== undefined) {
      // ramp across the stair cell toward the higher neighbor
      const cx = ox + (gx - (l.N - 1) / 2) * CELL;
      const cz = oz + (gy - (l.N - 1) / 2) * CELL;
      const fx = [1, -1, 0, 0][sd], fz = [0, 0, 1, -1][sd];
      const t = Math.min(1, Math.max(0, ((x - cx) * fx + (z - cz) * fz) / CELL + 0.5));
      y += t * TH_W;
    }
    return { y, ok: true };
  }
  for (const lk of walkLinks) {
    const abx = lk.b.x - lk.a.x, abz = lk.b.z - lk.a.z;
    const len2 = abx * abx + abz * abz;
    const t = ((x - lk.a.x) * abx + (z - lk.a.z) * abz) / len2;
    if (t < 0 || t > 1) continue;
    const px = lk.a.x + abx * t, pz = lk.a.z + abz * t;
    if (Math.hypot(x - px, z - pz) > 1.1) continue;
    return { y: lk.a.y + (lk.b.y - lk.a.y) * t - Math.sin(t * Math.PI) * lk.sag + 0.05, ok: true };
  }
  return { y: 0, ok: false };
};

// Generation runs in a WORKER POOL (pure data, transferable typed arrays) —
// islands of a chain generate in parallel; the main thread only fills instance
// buffers. Requests are id-tagged so stale responses are dropped.
const POOL = Math.min(4, Math.max(2, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
const genWorkers = Array.from({ length: POOL }, () =>
  new Worker(new URL("./gen/worker.ts", import.meta.url), { type: "module" }));
let genId = 0;
let rr = 0;
const pending = new Map<number, (l: Layout) => void>();
for (const w of genWorkers) {
  w.onmessage = (e: MessageEvent<{ id: number; layout: Layout }>) => {
    pending.get(e.data.id)?.(e.data.layout);
    pending.delete(e.data.id);
  };
}
const genParams: Params = { ...DEFAULT_PARAMS };

function generateAsync(s: number, overrides: Partial<Params> = {}): Promise<Layout> {
  return new Promise((resolve) => {
    const id = ++genId;
    pending.set(id, resolve);
    genWorkers[rr++ % POOL].postMessage({ id, seed: s, params: { ...genParams, ...overrides } });
  });
}

// ---- forge-parameter sliders -------------------------------------------------
{
  const panel = document.getElementById("params")!;
  const defs: Array<{ key: keyof Params; label: string; min: number; max: number; step: number }> = [
    { key: "islands", label: "linked blocks", min: 1, max: 4, step: 1 },
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

let lastExtent = 0;
let forgeToken = 0;
const CELL = 2.2;
const ISLAND_GAP = 15; // world units of abyss between linked blocks

async function forge(newSeed: number): Promise<void> {
  seed = newSeed >>> 0 || 1;
  const nIsl = Math.max(1, Math.min(4, Math.round(genParams.islands)));

  // generate the whole chain IN PARALLEL across the worker pool
  const tok = ++forgeToken;
  const layouts = await Promise.all(Array.from({ length: nIsl }, (_, i) => {
    const s = i === 0 ? seed : ((Math.imul(seed, 0x85ebca6b) ^ Math.imul(i, 0x9e3779b1)) >>> 0) || 1;
    const gateSides = nIsl === 1 ? [] : i === 0 ? [0] : i === nIsl - 1 ? [1] : [1, 0];
    const overrides: Partial<Params> = i === 0
      ? { gateSides }
      : {
          gateSides,
          size: Math.max(9, Math.round(genParams.size * 0.6)) | 1,
          plazas: 1,
          totems: Math.min(2, genParams.totems),
        };
    return generateAsync(s, overrides);
  }));
  if (tok !== forgeToken) return; // a newer forge superseded this one

  for (const w of worlds) w.dispose();
  worlds.length = 0;
  walkIslands.length = 0;
  walkLinks.length = 0;

  // chain layout: place each block east of the previous, aligning gate rows
  let minX = Infinity, maxX = -Infinity;
  let prevEast: { x: number; z: number; y: number } | null = null;
  let ox = 0, oz = 0;
  for (let i = 0; i < layouts.length; i++) {
    const l = layouts[i];
    const half = (l.N * CELL) / 2;
    const localPos = (g: { x: number; y: number; tier: number }) => ({
      x: (g.x - (l.N - 1) / 2) * CELL,
      z: (g.y - (l.N - 1) / 2) * CELL,
      y: g.tier * 1.85 + 0.1,
    });
    const west = l.gates.find((g) => g.dir === 1);
    const east = l.gates.find((g) => g.dir === 0);
    if (i > 0 && prevEast) {
      ox += ISLAND_GAP + half + (layouts[i - 1].N * CELL) / 2;
      oz = west ? prevEast.z - localPos({ ...west, tier: 0 }).z : oz;
    }
    const w = buildWorld(l);
    w.group.position.set(ox, 0, oz);
    scene.add(w.group);
    worlds.push(w);
    walkIslands.push({
      l, ox, oz,
      stairDir: new Map(l.stairs.map((s) => [s.y * l.N + s.x, s.dir])),
    });
    minX = Math.min(minX, ox - half);
    maxX = Math.max(maxX, ox + half);
    // bridge back to the previous island
    if (i > 0 && prevEast && west) {
      const wp = localPos(west);
      const from = new THREE.Vector3(prevEast.x + 0.3, prevEast.y, prevEast.z);
      const to = new THREE.Vector3(ox + wp.x - CELL / 2 - 0.3 + 0, wp.y, oz + wp.z);
      worlds.push(buildBridgeLink(from, to));
      scene.add(worlds[worlds.length - 1].group);
      walkLinks.push({ a: from.clone(), b: to.clone(), sag: Math.min(2.2, from.distanceTo(to) * 0.06) });
    }
    if (east) {
      const ep = localPos(east);
      prevEast = { x: ox + ep.x + CELL / 2 + 0.3, z: oz + ep.z, y: ep.y };
    } else {
      prevEast = null;
    }
  }

  const centerX = (minX + maxX) / 2;
  const half = Math.max((maxX - minX) / 2, (layouts[0].N * CELL) / 2) + 4;
  env.fit(Math.hypot(half, (layouts[0].N * CELL) / 2), centerX);
  if (Math.abs(lastExtent - half) > 1) {
    controls.target.set(centerX, 3 * TH, 0);
    camera.position.set(centerX + half * 0.75, half * 0.62, half * 1.1);
    controls.maxDistance = half * 5;
    lastExtent = half;
  }
  env.bakeShadows();
  nameEl.textContent = layouts[0].name + (nIsl > 1 ? ` +${nIsl - 1}` : "");
  const floorSum = layouts.reduce((s2, l) => s2 + l.stats.floor, 0);
  seedEl.textContent = `seed ${seed} · ${nIsl} block${nIsl > 1 ? "s" : ""} · ${floorSum} floor · ${layouts[0].stats.genMs}ms`;
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

// ---- third-person mode ------------------------------------------------------
let player: Player | null = null;
let playing = false;
let camYaw = 0.6;
let camDist = 8.5;
const keys = new Set<string>();
addEventListener("keydown", (e: KeyboardEvent) => {
  keys.add(e.key.toLowerCase());
  if (e.key === "Escape" && playing) void exitPlay();
});
addEventListener("keyup", (e: KeyboardEvent) => keys.delete(e.key.toLowerCase()));
let dragging = false;
renderer.domElement.addEventListener("pointerdown", () => { dragging = true; });
addEventListener("pointerup", () => { dragging = false; });
addEventListener("pointermove", (e: PointerEvent) => {
  if (playing && dragging) camYaw -= e.movementX * 0.005;
});
renderer.domElement.addEventListener("wheel", (e) => {
  if (playing) camDist = Math.min(14, Math.max(4, camDist + e.deltaY * 0.01));
}, { passive: true });

const btnEnter = document.createElement("button");
btnEnter.textContent = "⚔ Enter";
document.getElementById("controls")!.appendChild(btnEnter);
btnEnter.addEventListener("click", () => void (playing ? exitPlay() : enterPlay()));

async function enterPlay(): Promise<void> {
  if (!walkIslands.length) return;
  if (!player) {
    player = new Player();
    try { await player.load("/assets/knight.glb"); } catch { /* placeholder-only */ }
  }
  const l0 = walkIslands[0];
  // spawn on the first medallion plaza when there is one (open, photogenic);
  // fall back to the entrance corridor
  const spawnCell = l0.l.medallions[0] ?? l0.l.entrance;
  const ex = l0.ox + (spawnCell.x - (l0.l.N - 1) / 2) * CELL;
  const ez = l0.oz + (spawnCell.y - (l0.l.N - 1) / 2) * CELL;
  player.place(ex, ez, sampleGround);
  scene.add(player.group);
  playing = true;
  controls.enabled = false;
  controls.autoRotate = false;
  btnEnter.textContent = "🗺 Orbit (Esc)";
}

async function exitPlay(): Promise<void> {
  playing = false;
  controls.enabled = true;
  player?.group.removeFromParent();
  btnEnter.textContent = "⚔ Enter";
}

async function boot(): Promise<void> {
  // generation (worker) and WebGPU init run concurrently
  await Promise.all([renderer.init(), forge(seed)]);
  // first render compiles every pipeline (async in WebGPU); materials are
  // shared afterwards, so re-forging never compiles again
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
      player.update(dt, { f, s }, camYaw, sampleGround);
      const p = player.group.position;
      const tx = p.x - Math.sin(camYaw) * camDist;
      const tz = p.z - Math.cos(camYaw) * camDist;
      const ty = p.y + camDist * 0.62;
      camera.position.lerp(new THREE.Vector3(tx, ty, tz), Math.min(1, dt * 6));
      camera.lookAt(p.x, p.y + 1.4, p.z);
    } else {
      controls.update();
    }
    for (const w of worlds) w.tick(t);
    postProcessing.render();
  });
}

void boot();

// dev hook for camera scripting (screenshot verification, cinematics)
(window as unknown as { __df: object }).__df = { camera, controls };
