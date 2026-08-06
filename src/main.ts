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
import { buildWorld, buildBridgeLink, pruneSlots, setSlotDetail, type WorldHandle } from "./scene/build";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
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
const STEPS = 7;
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

// FIXED global light pool: three's WebGPU forward path recompiles every
// pipeline whenever the scene's light count changes — so the count never does.
// Islands submit LightSpecs; the pool re-aims existing lights at them.
import type { LightSpec } from "./scene/build";
const LIGHT_POOL_SIZE = 28;
const lightPool: THREE.PointLight[] = [];
for (let i = 0; i < LIGHT_POOL_SIZE; i++) {
  const pl = new THREE.PointLight(0xff9a45, 0, 15, 2);
  lightPool.push(pl);
  scene.add(pl);
}
let poolSpecs: LightSpec[] = [];
function assignLights(specs: LightSpec[]): void {
  poolSpecs = specs.slice(0, LIGHT_POOL_SIZE);
  for (let i = 0; i < LIGHT_POOL_SIZE; i++) {
    const pl = lightPool[i];
    const s2 = poolSpecs[i];
    if (s2) {
      pl.position.set(s2.x, s2.y, s2.z);
      pl.color.setHex(s2.color);
      pl.distance = s2.dist;
      pl.intensity = s2.base;
    } else {
      pl.intensity = 0;
    }
  }
}

// walkability data captured at forge time for the third-person mode
const TH_W = 1.85;
interface IslandWalk { l: Layout; ox: number; oy: number; oz: number; slot: number; stairDir: Map<number, number> }
interface LinkWalk { a: THREE.Vector3; b: THREE.Vector3; sag: number }
const walkIslands: IslandWalk[] = [];
const walkLinks: LinkWalk[] = [];
interface Ladder { x: number; z: number; y0: number; y1: number }
const ladders: Ladder[] = [];
const elevMeshes: THREE.Object3D[] = [];

const ladderMat = new THREE.MeshLambertNodeMaterial({ color: 0x4a3624 });
function buildLadder(x: number, z: number, y0: number, y1: number): void {
  const len = y1 - y0 + 1.4;
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-0.38, 0.38]) {
    const rail = new THREE.BoxGeometry(0.07, len, 0.07);
    rail.translate(side, len / 2, 0);
    parts.push(rail);
  }
  for (let yy = 0.3; yy < len; yy += 0.48) {
    const rung = new THREE.BoxGeometry(0.84, 0.055, 0.055);
    rung.translate(0, yy, 0);
    parts.push(rung);
  }
  const geo = BufferGeometryUtils.mergeGeometries(parts);
  for (const g of parts) g.dispose();
  const mesh = new THREE.Mesh(geo, ladderMat);
  mesh.position.set(x, y0 - 0.4, z + 0.45);
  scene.add(mesh);
  elevMeshes.push(mesh);
  ladders.push({ x, z, y0, y1 });
}

// stacked layers overlap in xz — candidates are ranked by |y - refY| so the
// sampler resolves to whichever floor the player is actually on
const sampleGround: GroundSampler = (x, z, refY = 0) => {
  let best: { y: number; ok: boolean; solid?: boolean } | null = null;
  let bestScore = Infinity;
  for (const isl of walkIslands) {
    const { l, ox, oz } = isl;
    const gx = Math.round((x - ox) / CELL + (l.N - 1) / 2);
    const gy = Math.round((z - oz) / CELL + (l.N - 1) / 2);
    if (gx < 0 || gy < 0 || gx >= l.N || gy >= l.N) continue;
    const c = gy * l.N + gx;
    if (l.kind[c] === 2) {
      const score = Math.abs(refY - isl.oy) + 2; // walls score by layer proximity
      if (score < bestScore) { bestScore = score; best = { y: 0, ok: false, solid: true }; }
      continue;
    }
    if (l.kind[c] !== FLOOR) continue;
    let y = l.tier[c] * TH_W + 0.16 + isl.oy;
    const sd = isl.stairDir.get(c);
    if (sd !== undefined) {
      const cx = ox + (gx - (l.N - 1) / 2) * CELL;
      const cz = oz + (gy - (l.N - 1) / 2) * CELL;
      const fx = [1, -1, 0, 0][sd], fz = [0, 0, 1, -1][sd];
      const t = Math.min(1, Math.max(0, ((x - cx) * fx + (z - cz) * fz) / CELL + 0.5));
      y += t * TH_W;
    }
    const score = Math.abs(refY - y);
    if (score < bestScore) { bestScore = score; best = { y, ok: true }; }
  }
  if (best) return best;
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
    { key: "islands", label: "linked blocks", min: 1, max: 24, step: 1 },
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
  // endless mode toggle
  const endlessLabel = document.createElement("label");
  endlessLabel.textContent = "endless ∞ (roam to generate) ";
  const endlessBox = document.createElement("input");
  endlessBox.type = "checkbox";
  endlessBox.style.width = "auto";
  endlessLabel.appendChild(endlessBox);
  panel.appendChild(endlessLabel);
  endlessBox.addEventListener("change", () => {
    endless = endlessBox.checked;
    streamCells.clear();
    streamPending.clear();
    freeStreamSlots.length = 0;
    edgeSlotMap.clear();
    freeEdgeSlots.length = 0;
    streamTimer = -10;
    if (endless) {
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
      worlds.length = 0; walkIslands.length = 0; walkLinks.length = 0;
      ladders.length = 0;
      for (const m of elevMeshes) m.removeFromParent();
      elevMeshes.length = 0;
      pruneSlots(new Set());
      controls.target.set(0, 3 * TH, 0);
      camera.position.set(50, 42, 70);
      lastExtent = 0;
    } else {
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
      pruneSlots(new Set());
      void forge(seed);
    }
  });

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
  if (endless) return; // roaming owns the world in endless mode
  seed = newSeed >>> 0 || 1;
  const nIsl = Math.max(1, Math.min(24, Math.round(genParams.islands)));

  // -- macro layout: blocks GROW on a coarse grid like WFC tiles — each new
  //    block attaches to a random placed block on a free side. Gates open
  //    toward tree neighbors (bridged) plus extra random sides that dangle
  //    over the abyss (step out and you fall).
  const tok = ++forgeToken;
  const h32 = (a: number, b: number) => (Math.imul(seed ^ a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b)) >>> 0;
  const macro: Array<{ mi: number; mj: number; mk: number; parent: number; dirFromParent: number }> = [
    { mi: 0, mj: 0, mk: 0, parent: -1, dirFromParent: -1 },
  ];
  const occupied = new Set(["0,0,0"]);
  // dirs 0-3 horizontal; dir 4 stacks a block a LAYER above, joined by elevator
  const MDX = [1, -1, 0, 0, 0], MDZ = [0, 0, 1, -1, 0], MDK = [0, 0, 0, 0, 1];
  for (let k = 1; k < nIsl; k++) {
    let placedOk = false;
    for (let attempt = 0; attempt < 26 && !placedOk; attempt++) {
      const p = h32(k, attempt) % macro.length;
      // guarantee at least one stacked layer once the chain is big enough
      const needStack = nIsl >= 3 && k === nIsl - 1 && !macro.some((m) => m.dirFromParent === 4);
      const d = needStack && attempt < 7 ? 4 : h32(k, attempt + 100) % 5;
      const mi = macro[p].mi + MDX[d], mj = macro[p].mj + MDZ[d], mk = macro[p].mk + MDK[d];
      if (mk > 2) continue; // three layers max — sky castles need a skyline, not a ladder
      if (occupied.has(`${mi},${mj},${mk}`)) continue;
      occupied.add(`${mi},${mj},${mk}`);
      macro.push({ mi, mj, mk, parent: p, dirFromParent: d });
      placedOk = true;
    }
    if (!placedOk) break;
  }

  // gate sides per block: toward parent, toward children, plus dangling extras
  const gateSets: Array<Set<number>> = macro.map(() => new Set());
  for (let k = 1; k < macro.length; k++) {
    const d = macro[k].dirFromParent;
    if (d < 4) { // vertical neighbors join by elevator, not gate
      gateSets[macro[k].parent].add(d);
      gateSets[k].add(d ^ 1);
    }
  }
  for (let k = 0; k < macro.length; k++) {
    for (let d = 0; d < 4; d++) {
      if (!gateSets[k].has(d) && h32(k * 7, d + 300) % 100 < 35) gateSets[k].add(d); // broken sky-door
    }
  }

  // per-block VARIATION: satellites differ in size, growth style and age
  const layouts = await Promise.all(macro.map((_, i) => {
    const s = i === 0 ? seed : (h32(i, 1) || 1);
    const gateSides = [...gateSets[i]];
    if (i === 0) return generateAsync(seed, { gateSides });
    const v = (n: number) => h32(i, n + 40) % 1000 / 1000;
    return generateAsync(s, {
      gateSides,
      size: [9, 11, 13][h32(i, 50) % 3] | 1,
      plazas: h32(i, 51) % 3 === 0 ? 0 : 1,
      totems: h32(i, 52) % 4,
      decay: Math.min(1, Math.max(0.1, genParams.decay + (v(3) - 0.5) * 0.5)),
      heightAmp: Math.max(0.5, genParams.heightAmp + (v(4) - 0.5) * 1.6),
      newest: Math.min(1, Math.max(0.2, genParams.newest + (v(5) - 0.5) * 0.5)),
      mound: i === 0 ? genParams.mound : genParams.mound * 0.4, // one temple rules the skyline
    });
  }));
  if (tok !== forgeToken) return; // a newer forge superseded this one

  worlds.length = 0; // slot pools persist; pruneSlots() hides the unused ones
  walkIslands.length = 0;
  walkLinks.length = 0;
  ladders.length = 0;
  for (const m of elevMeshes) m.removeFromParent();
  elevMeshes.length = 0;
  const activeSlots = new Set<number>();
  // building an island costs 10-20ms of instance filling on the main thread —
  // spread the chain across frames instead of stalling one frame with all of it
  const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

  // tree layout: place blocks in BFS order along their parent edges, sliding
  // each child so the two facing gates line up; bridge every parent-child pair
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const allLights: LightSpec[] = [];
  const positions: Array<{ ox: number; oy: number; oz: number }> = [];
  const gateWorld = (i: number, dir: number) => {
    const l = layouts[i];
    const g = l.gates.find((gg) => gg.dir === dir);
    if (!g) return null;
    const p = positions[i];
    const fx = [1, -1, 0, 0][dir], fz = [0, 0, 1, -1][dir];
    return new THREE.Vector3(
      p.ox + (g.x - (l.N - 1) / 2) * CELL + fx * (CELL / 2 + 0.3),
      p.oy + g.tier * TH_W + 0.1,
      p.oz + (g.y - (l.N - 1) / 2) * CELL + fz * (CELL / 2 + 0.3),
    );
  };

  for (let i = 0; i < layouts.length; i++) {
    const l = layouts[i];
    const half = (l.N * CELL) / 2;
    let ox = 0, oz = 0;
    let oy = 0;
    const pIdx = macro[i].parent;
    if (pIdx >= 0) {
      const d = macro[i].dirFromParent;
      const pp = positions[pIdx];
      if (d === 4) {
        // a LAYER above its parent — same footprint, joined by elevator.
        // clearance must top the parent's temple/towers (~22 world units)
        ox = pp.ox;
        oz = pp.oz;
        oy = pp.oy + 32 + ((h32(i, 141) % 1000) / 1000) * 5;
      } else {
        const pHalf = (layouts[pIdx].N * CELL) / 2;
        const fx = [1, -1, 0, 0][d], fz = [0, 0, 1, -1][d];
        ox = pp.ox + fx * (pHalf + ISLAND_GAP + half);
        oz = pp.oz + fz * (pHalf + ISLAND_GAP + half);
        oy = pp.oy + (((h32(i, 141) >>> 4) % 1000) / 1000 - 0.5) * 8.4;
        // slide on the cross axis so the two gates face each other
        const pg = layouts[pIdx].gates.find((g) => g.dir === d);
        const cg = l.gates.find((g) => g.dir === (d ^ 1));
        if (pg && cg) {
          if (fx !== 0) {
            const pz2 = pp.oz + (pg.y - (layouts[pIdx].N - 1) / 2) * CELL;
            oz = pz2 - (cg.y - (l.N - 1) / 2) * CELL;
          } else {
            const px2 = pp.ox + (pg.x - (layouts[pIdx].N - 1) / 2) * CELL;
            ox = px2 - (cg.x - (l.N - 1) / 2) * CELL;
          }
        }
      }
    }
    positions.push({ ox, oy, oz });

    const w = buildWorld(l, i, scene, macro[i].dirFromParent === 4 ? 0.22 : 1);
    activeSlots.add(i);
    w.group.position.set(ox, oy, oz);
    scene.add(w.group);
    worlds.push(w);
    for (const ls of w.lights) allLights.push({ ...ls, x: ls.x + ox, y: ls.y + oy, z: ls.z + oz });
    walkIslands.push({
      l, ox, oy, oz, slot: i,
      stairDir: new Map(l.stairs.map((s) => [s.y * l.N + s.x, s.dir])),
    });
    if (l.bridge) {
      // the island's own ravine bridge is walkable too
      const b = l.bridge;
      const bz = oz + (b.y - (l.N - 1) / 2) * CELL;
      const by = oy + b.tier * TH_W + 0.1;
      walkLinks.push({
        a: new THREE.Vector3(ox + (b.x0 - (l.N - 1) / 2) * CELL + CELL * 0.4, by, bz),
        b: new THREE.Vector3(ox + (b.x1 - (l.N - 1) / 2) * CELL - CELL * 0.4, by, bz),
        sag: 0.7,
      });
    }
    minX = Math.min(minX, ox - half); maxX = Math.max(maxX, ox + half);
    minZ = Math.min(minZ, oz - half); maxZ = Math.max(maxZ, oz + half);

    // elevator joining a stacked pair: a cell that is open floor in BOTH
    // layers, with no support pillar under the upper one (a clear shaft)
    if (pIdx >= 0 && macro[i].dirFromParent === 4) {
      const par = walkIslands[pIdx];
      const cN = l.N, pN = par.l.N;
      outer:
      for (let r = 0; r < cN / 2; r++) {
        for (let gy = Math.max(1, ((cN - 1) >> 1) - r); gy <= Math.min(cN - 2, ((cN - 1) >> 1) + r); gy++) {
          for (let gx = Math.max(1, ((cN - 1) >> 1) - r); gx <= Math.min(cN - 2, ((cN - 1) >> 1) + r); gx++) {
            const cc = gy * cN + gx;
            if (l.kind[cc] !== FLOOR || l.stairMask[cc] || l.support[cc] !== l.tier[cc]) continue;
            const wxp = ox + (gx - (cN - 1) / 2) * CELL;
            const wzp = oz + (gy - (cN - 1) / 2) * CELL;
            const pgx = Math.round((wxp - par.ox) / CELL + (pN - 1) / 2);
            const pgy = Math.round((wzp - par.oz) / CELL + (pN - 1) / 2);
            if (pgx < 1 || pgy < 1 || pgx >= pN - 1 || pgy >= pN - 1) continue;
            const pc = pgy * pN + pgx;
            if (par.l.kind[pc] !== FLOOR || par.l.stairMask[pc]) continue;
            const y0 = par.oy + par.l.tier[pc] * TH_W + 0.16;
            const y1 = oy + l.tier[cc] * TH_W + 0.16;
            buildLadder(wxp, wzp, y0, y1);
            break outer;
          }
        }
      }
    }
    if (pIdx >= 0) {
      const from = gateWorld(pIdx, macro[i].dirFromParent);
      const to = gateWorld(i, macro[i].dirFromParent ^ 1);
      if (from && to) {
        worlds.push(buildBridgeLink(from, to, 1000 + i, scene));
        activeSlots.add(1000 + i);
        walkLinks.push({ a: from.clone(), b: to.clone(), sag: Math.min(2.2, from.distanceTo(to) * 0.06) });
      }
    }
    // bake per island: spreads shadow-variant pipeline/bind-group creation
    // across the same frames the incremental build already occupies
    env.bakeShadows();
    if (i < layouts.length - 1) {
      await nextFrame();
      if (tok !== forgeToken) return; // superseded mid-build
    }
  }

  pruneSlots(activeSlots);
  assignLights(allLights);
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const half = Math.max((maxX - minX) / 2, (maxZ - minZ) / 2, (layouts[0].N * CELL) / 2) + 4;
  env.fit(half * 1.2, centerX, centerZ);
  if (Math.abs(lastExtent - half) > 1) {
    controls.target.set(centerX, 3 * TH, centerZ);
    camera.position.set(centerX + half * 0.75, half * 0.62, centerZ + half * 1.1);
    controls.maxDistance = half * 5;
    lastExtent = half;
    // fill rate is the budget: bigger worlds render at a slightly lower ratio
    renderer.setPixelRatio(Math.min(devicePixelRatio, half > 95 ? 1.25 : 1.5));
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

// ---- 3×3×3 cube demo --------------------------------------------------------
// 27 blocks in a solid lattice: every horizontal neighbor pair bridges, every
// vertical pair gets an elevator shaft. The showcase build.
async function forgeCube(): Promise<void> {
  if (endless) return;
  const tok = ++forgeToken;
  const size = 11, N = 2 * size + 1, pitch = N * CELL + ISLAND_GAP, LAYER = 36;
  const ch = (a: number, b: number, c: number, salt: number) =>
    (Math.imul(seed ^ Math.imul(a + 7, 73856093) ^ Math.imul(b + 7, 19349663) ^ Math.imul(c + 7, 83492791), 0x9e3779b1 ^ salt) >>> 0);
  const cells: Array<{ mi: number; mj: number; mk: number }> = [];
  for (let mk = 0; mk < 3; mk++) for (let mj = -1; mj <= 1; mj++) for (let mi = -1; mi <= 1; mi++) cells.push({ mi, mj, mk });
  const edgeRow = (a: number, b: number, c: number, axis: number) => 3 + (ch(a, b, c, 0xe0 + axis) % (N - 6));

  const layouts2 = await Promise.all(cells.map((c) => {
    const gs: number[] = [], gr: number[] = [];
    if (c.mi < 1) { gs.push(0); gr.push(edgeRow(c.mi, c.mj, c.mk, 0)); }
    if (c.mi > -1) { gs.push(1); gr.push(edgeRow(c.mi - 1, c.mj, c.mk, 0)); }
    if (c.mj < 1) { gs.push(2); gr.push(edgeRow(c.mi, c.mj, c.mk, 1)); }
    if (c.mj > -1) { gs.push(3); gr.push(edgeRow(c.mi, c.mj - 1, c.mk, 1)); }
    return generateAsync(ch(c.mi, c.mj, c.mk, 0x77) || 1, {
      gateSides: gs, gateRows: gr, size, plazas: 1, totems: 2,
      mound: c.mi === 0 && c.mj === 0 && c.mk === 2 ? genParams.mound : genParams.mound * 0.3,
      decay: Math.min(1, Math.max(0.1, genParams.decay + ((ch(c.mi, c.mj, c.mk, 0x88) % 100) / 100 - 0.5) * 0.5)),
    });
  }));
  if (tok !== forgeToken) return;

  worlds.length = 0;
  walkIslands.length = 0;
  walkLinks.length = 0;
  ladders.length = 0;
  for (const m of elevMeshes) m.removeFromParent();
  elevMeshes.length = 0;
  const activeSlots = new Set<number>();
  const allLightsByCell: LightSpec[][] = [];
  const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

  for (let i = 0; i < cells.length; i++) {
    const c = cells[i], l = layouts2[i];
    const ox = c.mi * pitch, oz = c.mj * pitch;
    const oy = c.mk * LAYER + ((ch(c.mi, c.mj, c.mk, 0x99) % 100) / 100 - 0.5) * 4.4;
    const w = buildWorld(l, i, scene, c.mk === 0 ? 1 : 0.22);
    activeSlots.add(i);
    w.group.position.set(ox, oy, oz);
    worlds.push(w);
    allLightsByCell.push(w.lights.map((ls) => ({ ...ls, x: ls.x + ox, y: ls.y + oy, z: ls.z + oz })));
    walkIslands.push({ l, ox, oy, oz, slot: i, stairDir: new Map(l.stairs.map((s) => [s.y * l.N + s.x, s.dir])) });
    if (l.bridge) {
      const b = l.bridge;
      const bz = oz + (b.y - (l.N - 1) / 2) * CELL;
      const by = oy + b.tier * TH_W + 0.1;
      walkLinks.push({
        a: new THREE.Vector3(ox + (b.x0 - (l.N - 1) / 2) * CELL + CELL * 0.4, by, bz),
        b: new THREE.Vector3(ox + (b.x1 - (l.N - 1) / 2) * CELL - CELL * 0.4, by, bz),
        sag: 0.7,
      });
    }
    env.bakeShadows();
    if (i < cells.length - 1) { await nextFrame(); if (tok !== forgeToken) return; }
  }

  // bridges: every horizontally adjacent pair with facing gates
  const cellAt = (mi: number, mj: number, mk: number) => cells.findIndex((c) => c.mi === mi && c.mj === mj && c.mk === mk);
  const gwFor = (idx: number, dir: number): THREE.Vector3 | null => {
    const l = layouts2[idx], c = cells[idx];
    const g = l.gates.find((gg) => gg.dir === dir);
    if (!g) return null;
    const fx = [1, -1, 0, 0][dir], fz = [0, 0, 1, -1][dir];
    const isl = walkIslands[idx];
    return new THREE.Vector3(
      isl.ox + (g.x - (l.N - 1) / 2) * CELL + fx * (CELL / 2 + 0.3),
      isl.oy + g.tier * TH_W + 0.1,
      isl.oz + (g.y - (l.N - 1) / 2) * CELL + fz * (CELL / 2 + 0.3),
    );
  };
  let edgeSlot = 1000;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    for (const [dmi, dmj, dir] of [[1, 0, 0], [0, 1, 2]] as const) {
      const j = cellAt(c.mi + dmi, c.mj + dmj, c.mk);
      if (j < 0) continue;
      const from = gwFor(i, dir), to = gwFor(j, dir ^ 1);
      if (!from || !to) continue;
      worlds.push(buildBridgeLink(from, to, edgeSlot, scene));
      activeSlots.add(edgeSlot++);
      walkLinks.push({ a: from.clone(), b: to.clone(), sag: Math.min(2.2, from.distanceTo(to) * 0.06) });
    }
    // ladders: every vertical pair, first clear shaft wins
    const jUp = cellAt(c.mi, c.mj, c.mk + 1);
    if (jUp >= 0) {
      const par = walkIslands[i], chi = walkIslands[jUp];
      const cN = chi.l.N, pN = par.l.N;
      outer:
      for (let r = 0; r < cN / 2; r++) {
        for (let gy = Math.max(1, ((cN - 1) >> 1) - r); gy <= Math.min(cN - 2, ((cN - 1) >> 1) + r); gy++) {
          for (let gx = Math.max(1, ((cN - 1) >> 1) - r); gx <= Math.min(cN - 2, ((cN - 1) >> 1) + r); gx++) {
            const cc = gy * cN + gx;
            if (chi.l.kind[cc] !== FLOOR || chi.l.stairMask[cc] || chi.l.support[cc] !== chi.l.tier[cc]) continue;
            const wxp = chi.ox + (gx - (cN - 1) / 2) * CELL;
            const wzp = chi.oz + (gy - (cN - 1) / 2) * CELL;
            const pgx = Math.round((wxp - par.ox) / CELL + (pN - 1) / 2);
            const pgy = Math.round((wzp - par.oz) / CELL + (pN - 1) / 2);
            if (pgx < 1 || pgy < 1 || pgx >= pN - 1 || pgy >= pN - 1) continue;
            const pc = pgy * pN + pgx;
            if (par.l.kind[pc] !== FLOOR || par.l.stairMask[pc]) continue;
            const y0 = par.oy + par.l.tier[pc] * TH_W + 0.16;
            const y1 = chi.oy + chi.l.tier[cc] * TH_W + 0.16;
            buildLadder(wxp, wzp, y0, y1);
            break outer;
          }
        }
      }
    }
  }

  // fair light distribution: round-robin across cells into the fixed pool
  const interleaved: LightSpec[] = [];
  for (let li = 0; interleaved.length < LIGHT_POOL_SIZE * 2; li++) {
    let any = false;
    for (const arr of allLightsByCell) if (arr[li]) { interleaved.push(arr[li]); any = true; }
    if (!any) break;
  }
  pruneSlots(activeSlots);
  assignLights(interleaved);
  env.fit(pitch * 2.1, 0, 0);
  controls.target.set(0, LAYER * 1.1, 0);
  camera.position.set(pitch * 1.9, LAYER * 2.1, pitch * 2.6);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
  nameEl.textContent = `${layouts2[cellAt(0, 0, 2)]?.name ?? ""} — the Cube`;
  seedEl.textContent = `seed ${seed} · 3×3×3 · ${layouts2.reduce((s2, l) => s2 + l.stats.floor, 0)} floor`;
}

// ---- endless streaming mode -------------------------------------------------
// A 3×3 macro-cell window follows the camera/player. Blocks derive from
// hash(seed, mi, mj) so the infinite world is consistent; edge hashes decide
// where neighbors agree to open gates (each side carves the nearest fit — a
// slightly diagonal bridge just means the masons disagreed). Slot pools make
// roaming cheap: after the first nine cells, no render object is ever created.
let endless = false;
interface StreamCell { key: string; mi: number; mj: number; slot: number; l: Layout; ox: number; oy: number; oz: number; handle: WorldHandle }
const streamCells = new Map<string, StreamCell>();
const streamPending = new Set<string>();
const freeStreamSlots: number[] = [];
let nextStreamSlot = 10;
const edgeSlotMap = new Map<string, number>();
const freeEdgeSlots: number[] = [];
let nextEdgeSlot = 2000;
let streamTimer = -10;

const eh32 = (a: number, b: number, salt: number) =>
  (Math.imul(seed ^ Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663), 0x9e3779b1 ^ salt) >>> 0);
const streamSize = () => Math.min(11, Math.max(9, Math.round(genParams.size))) | 1; // 9 live blocks — keep them lean
const streamPitch = () => (2 * streamSize() + 1) * CELL + ISLAND_GAP;
function edgeInfo(mi: number, mj: number, horiz: boolean) {
  const N = 2 * streamSize() + 1;
  const h = eh32(mi * 2 + (horiz ? 0 : 1), mj * 2 + (horiz ? 1 : 0), 0x5eed);
  return { has: h % 100 < 72, row: 3 + ((h >>> 8) % (N - 6)) };
}

async function ensureStreamCell(mi: number, mj: number): Promise<void> {
  const key = `${mi},${mj}`;
  if (streamCells.has(key) || streamPending.has(key)) return;
  streamPending.add(key);
  const size = streamSize();
  const gateSides: number[] = [];
  const gateRows: number[] = [];
  const edges = [
    { e: edgeInfo(mi, mj, true), side: 0 },
    { e: edgeInfo(mi - 1, mj, true), side: 1 },
    { e: edgeInfo(mi, mj, false), side: 2 },
    { e: edgeInfo(mi, mj - 1, false), side: 3 },
  ];
  for (const { e, side } of edges) if (e.has) { gateSides.push(side); gateRows.push(e.row); }
  const l = await generateAsync(eh32(mi, mj, 0x11) || 1, {
    gateSides, gateRows, size,
    mound: mi === 0 && mj === 0 ? genParams.mound : genParams.mound * 0.45,
    plazas: eh32(mi, mj, 0x33) % 3 === 0 ? 2 : 1,
  });
  streamPending.delete(key);
  if (!endless) return;
  const slot = freeStreamSlots.pop() ?? nextStreamSlot++;
  const pitch = streamPitch();
  const ox = mi * pitch, oz = mj * pitch;
  const oy = ((eh32(mi, mj, 0x22) % 1000) / 1000 - 0.5) * 5.2;
  const w = buildWorld(l, slot, scene);
  w.group.position.set(ox, oy, oz);
  streamCells.set(key, { key, mi, mj, slot, l, ox, oy, oz, handle: w });
  refreshStreamWorld();
}

function streamGateWorld(cell: StreamCell, dir: number): THREE.Vector3 | null {
  const g = cell.l.gates.find((gg) => gg.dir === dir);
  if (!g) return null;
  const fx = [1, -1, 0, 0][dir], fz = [0, 0, 1, -1][dir];
  return new THREE.Vector3(
    cell.ox + (g.x - (cell.l.N - 1) / 2) * CELL + fx * (CELL / 2 + 0.3),
    cell.oy + g.tier * TH_W + 0.1,
    cell.oz + (g.y - (cell.l.N - 1) / 2) * CELL + fz * (CELL / 2 + 0.3),
  );
}

function refreshStreamWorld(): void {
  worlds.length = 0;
  walkIslands.length = 0;
  walkLinks.length = 0;
  const allLights: LightSpec[] = [];
  const activeSlots = new Set<number>();
  for (const cell of streamCells.values()) {
    activeSlots.add(cell.slot);
    worlds.push(cell.handle);
    walkIslands.push({
      l: cell.l, ox: cell.ox, oy: cell.oy, oz: cell.oz, slot: cell.slot,
      stairDir: new Map(cell.l.stairs.map((s) => [s.y * cell.l.N + s.x, s.dir])),
    });
    for (const ls of cell.handle.lights) allLights.push({ ...ls, x: ls.x + cell.ox, y: ls.y + cell.oy, z: ls.z + cell.oz });
    if (cell.l.bridge) {
      const b = cell.l.bridge;
      const bz = cell.oz + (b.y - (cell.l.N - 1) / 2) * CELL;
      const by = cell.oy + b.tier * TH_W + 0.1;
      walkLinks.push({
        a: new THREE.Vector3(cell.ox + (b.x0 - (cell.l.N - 1) / 2) * CELL + CELL * 0.4, by, bz),
        b: new THREE.Vector3(cell.ox + (b.x1 - (cell.l.N - 1) / 2) * CELL - CELL * 0.4, by, bz),
        sag: 0.7,
      });
    }
  }
  // inter-cell bridges for every present pair that agreed on a gate
  const activeEdges = new Set<string>();
  for (const cell of streamCells.values()) {
    for (const [dmi, dmj, horiz, dir] of [[1, 0, true, 0], [0, 1, false, 2]] as const) {
      const nb = streamCells.get(`${cell.mi + dmi},${cell.mj + dmj}`);
      if (!nb || !edgeInfo(cell.mi, cell.mj, horiz).has) continue;
      const from = streamGateWorld(cell, dir);
      const to = streamGateWorld(nb, dir ^ 1);
      if (!from || !to) continue;
      const eKey = `${horiz ? "h" : "v"}${cell.mi},${cell.mj}`;
      let slot = edgeSlotMap.get(eKey);
      if (slot === undefined) {
        slot = freeEdgeSlots.pop() ?? nextEdgeSlot++;
        edgeSlotMap.set(eKey, slot);
      }
      activeEdges.add(eKey);
      activeSlots.add(slot);
      worlds.push(buildBridgeLink(from, to, slot, scene));
      walkLinks.push({ a: from.clone(), b: to.clone(), sag: Math.min(2.2, from.distanceTo(to) * 0.06) });
    }
  }
  for (const [k, slot] of edgeSlotMap) {
    if (!activeEdges.has(k)) { edgeSlotMap.delete(k); freeEdgeSlots.push(slot); }
  }
  pruneSlots(activeSlots);
  assignLights(allLights);
  env.bakeShadows();
}

function updateStreaming(t: number): void {
  if (!endless) return;
  if (t - streamTimer < 0.4) return;
  streamTimer = t;
  const pitch = streamPitch();
  const focus = playing && player ? player.group.position : controls.target;
  const fi = Math.round(focus.x / pitch), fj = Math.round(focus.z / pitch);
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) void ensureStreamCell(fi + di, fj + dj);
  let evicted = false;
  for (const cell of [...streamCells.values()]) {
    if (Math.max(Math.abs(cell.mi - fi), Math.abs(cell.mj - fj)) > 1) {
      streamCells.delete(cell.key);
      freeStreamSlots.push(cell.slot);
      evicted = true;
    }
  }
  if (evicted) refreshStreamWorld();
  env.fit(pitch * 1.7, fi * pitch, fj * pitch);
}

// ---- third-person mode ------------------------------------------------------
let player: Player | null = null;
let playing = false;
let spawnX = 0, spawnZ = 0;
let camYaw = Math.PI;
let camPitch = -0.12;
let camDist = 8.5;
void camDist;
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
  if (playing && dragging) {
    camYaw -= e.movementX * 0.005;
    camPitch = Math.min(0.85, Math.max(-0.85, camPitch - e.movementY * 0.003));
  }
});
renderer.domElement.addEventListener("wheel", (e) => {
  if (playing) camDist = Math.min(14, Math.max(4, camDist + e.deltaY * 0.01));
}, { passive: true });

const btnCube = document.createElement("button");
btnCube.textContent = "⧉ 3×3×3";
document.getElementById("controls")!.appendChild(btnCube);
btnCube.addEventListener("click", () => void forgeCube());

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
  spawnX = l0.ox + (spawnCell.x - (l0.l.N - 1) / 2) * CELL;
  spawnZ = l0.oz + (spawnCell.y - (l0.l.N - 1) / 2) * CELL;
  player.place(spawnX, spawnZ, sampleGround);
  player.setFirstPerson(true);
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
      const p = player.group.position;
      // ladder climbing: stand at a ladder, W climbs, S descends
      player.climbing = false;
      for (const e of ladders) {
        if (Math.abs(p.x - e.x) < 0.95 && Math.abs(p.z - e.z) < 0.95 && p.y > e.y0 - 0.5 && p.y < e.y1 + 0.5) {
          if (f !== 0) {
            player.climbing = true;
            p.y = Math.min(e.y1 + 0.02, Math.max(e.y0, p.y + f * 3.4 * dt));
            p.x += (e.x - p.x) * Math.min(1, dt * 8);
            p.z += (e.z - p.z) * Math.min(1, dt * 8);
            if (p.y >= e.y1 - 0.01 && f > 0) player.climbing = false; // crest the top and walk off
          }
          break;
        }
      }
      player.update(dt, player.climbing ? { f: 0, s: 0 } : { f, s }, camYaw, sampleGround);
      if (p.y < -42) {
        // the abyss returns what it takes — to the last safe footing
        const rx = endless ? player.lastSafeX : spawnX;
        const rz = endless ? player.lastSafeZ : spawnZ;
        player.place(rx, rz, sampleGround);
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
    for (const w of worlds) w.tick(t);
    // distance LOD: far islands drop their small-detail layers
    for (let i = 0; i < walkIslands.length; i++) {
      const isl = walkIslands[i];
      const half = (isl.l.N * CELL) / 2;
      const d2 = Math.hypot(camera.position.x - isl.ox, camera.position.z - isl.oz) - half;
      setSlotDetail(isl.slot, d2 < 95);
    }
    updateStreaming(t);
    for (let i = 0; i < poolSpecs.length; i++) {
      const s2 = poolSpecs[i];
      lightPool[i].intensity = s2.base * (0.82 + 0.12 * Math.sin(t * 7.3 + s2.ph) + 0.06 * Math.sin(t * 13.1 + s2.ph * 1.7));
    }
    const r0 = performance.now();
    postProcessing.render();
    const rDur = performance.now() - r0;
    if (rDur > 100) console.log(`[frame] render() blocked ${rDur.toFixed(0)}ms`);
  });
}

void boot();

// dev hook for camera scripting (screenshot verification, cinematics)
(window as unknown as { __df: object }).__df = { camera, controls };
