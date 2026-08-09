// Turns a Layout into meshes. Everything repeated is instanced; per-instance
// color carries baked AO + hue variation; all glow goes through emissiveNode so
// the MRT-emissive bloom pass picks it up and nothing else does.
//
// Materials & geometries live in scene/kit (created once, shared across
// regenerations); render objects live in scene/slots (created once per slot).
// A re-forge therefore only rewrites instance buffers — near-instant, and
// with InstList it allocates no per-instance objects at all.

import * as THREE from "three/webgpu";
import type { Layout, Dir } from "../gen/dungeon";
import { FLOOR, WALL, VOID, ABYSS, DX, DY } from "../gen/dungeon";
import { hash2, hash3 } from "../gen/rng";
import { TH, CELL, COURSE, linkArc, districtLinkArc } from "../config";
import { setStoneDamage } from "./kit/materials";
import { getKit } from "./kit";
import {
  getSlot, putInstanced, putInstancedCombined, putInstancedTwin,
  isDecorSuppressed, setSlotDetail, setSlotLodLevel,
} from "./slots";
import { InstArena, InstList, planColumn, type CourseShell } from "./instances";

export interface LightSpec { x: number; y: number; z: number; color: number; base: number; dist: number; ph: number }

/** Fixed-slot landmark lighting. These are authored alongside the procedural
 * abyss landmarks, but consumed by LightPool so the WebGPU light topology is
 * present before the first pipeline compile and never changes at runtime. */
export interface CinematicLightSpec extends LightSpec {
  kind: "spot" | "point";
  role?: "oracle-key" | "dragon-rim" | "dragon-focus";
  targetX?: number;
  targetY?: number;
  targetZ?: number;
  angle?: number;
  penumbra?: number;
}

export interface WorldHandle {
  group: THREE.Group;
  /** point-light requests in island-LOCAL coords — the orchestrator feeds them
   *  into a FIXED global pool (a changing scene light count recompiles every
   *  pipeline in three's WebGPU forward renderer) */
  lights: LightSpec[];
  tick: (t: number) => void;
  dispose: () => void;
}

export interface WorldBlocker { x: number; z: number; y0: number; y1: number; radius: number; slot?: number }
export interface SupportPierHandle extends WorldHandle { blockers: WorldBlocker[] }
export type HorizontalLinkStyle = "bridge" | "causeway" | "gallery" | "court";

/** Structural metadata exists only for thin, interior wall cells with a valid
 * floor on both sides. Destruction can therefore open intentional passages
 * without turning a rampart edge into walkable void. */
export interface MasonryBreachCell {
  layout: Layout;
  cell: number;
  gx: number;
  gy: number;
  floorTier: number;
  required: number[];
  destroyed: Set<number>;
  opened: boolean;
}
export interface MasonryStructureData {
  byInstance: Map<number, MasonryBreachCell>;
}

const _axisY = new THREE.Vector3(0, 1, 0);
const _hexColor = new THREE.Color();
const _paintCool = new THREE.Color(0x566a82);
const _paintWarm = new THREE.Color(0x89664b);
const _mat4 = new THREE.Matrix4();
const _stairYaw = new THREE.Quaternion();
const _stairPitch = new THREE.Quaternion();
const _stairQuat = new THREE.Quaternion();
const _stairEuler = new THREE.Euler();
const _stairPos = new THREE.Vector3();
const _unitScale = new THREE.Vector3(1, 1, 1);
const MOSS_TINT = new THREE.Color(0x39442a);
const worldLists = new InstArena();

/** scratch color from a hex literal (InstList copies r/g/b at push time) */
const hex = (h: number): THREE.Color => _hexColor.setHex(h);

// All procedural HSL values in this module are already in [0, 1], and HSL is
// expressed in Three's working color space. Skipping the generic modulo,
// clamps and color-space dispatch preserves Color.setHSL's math while keeping
// the tens of thousands of per-course color writes on a small numeric path.
const hue2rgb = (p: number, q: number, t: number): number => {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * 6 * (2 / 3 - t);
  return p;
};
const setHsl = (c: THREE.Color, h: number, s: number, l: number): THREE.Color => {
  if (s === 0) c.r = c.g = c.b = l;
  else {
    const p = l <= 0.5 ? l * (1 + s) : l + s - l * s;
    const q = 2 * l - p;
    c.r = hue2rgb(q, p, h + 1 / 3);
    c.g = hue2rgb(q, p, h);
    c.b = hue2rgb(q, p, h - 1 / 3);
  }
  return c;
};

const dirRotY = (d: Dir): number => (d === 0 ? Math.PI / 2 : d === 1 ? -Math.PI / 2 : d === 2 ? 0 : Math.PI);

// ---------------------------------------------------------------------------
// Bridge links.
// ---------------------------------------------------------------------------

/** A stone ARCH bridge between two islands' gates. Blocks must read as
 *  physically connected from any distance — a thin rope bridge disappears at
 *  range and the chain looks like disconnected floating islands. Deck rises
 *  along linkArc (the walkmap/nav sampler uses the SAME function, so the
 *  drawn deck is exactly the surface the walker stands on). */
export function horizontalLinkArc(style: HorizontalLinkStyle, dist: number): number {
  return style === "bridge" ? linkArc(dist) : districtLinkArc(dist);
}

export function horizontalLinkWidth(style: HorizontalLinkStyle): number {
  return style === "bridge" ? 2.2 : style === "court" ? 9.4 : style === "causeway" ? 5.4 : 4.8;
}

/** Walkable width excludes the parapet/jamb thickness. Keeping structural
 * width and nav width separate prevents wide district links from advertising
 * a strip that runs through their edge masonry. */
export function horizontalLinkWalkWidth(style: HorizontalLinkStyle): number {
  return style === "bridge" ? 2.2 : horizontalLinkWidth(style) - 1.25;
}

export function buildBridgeLink(
  a: THREE.Vector3, b: THREE.Vector3, slot: number, sceneRoot: THREE.Object3D,
  riseDelay = 0, style: HorizontalLinkStyle = "bridge",
): WorldHandle {
  const R = getKit();
  const pool = getSlot(slot, sceneRoot);
  const group = pool.group;
  group.name = style === "bridge" ? "bridge-link" : `district-${style}`;
  const delta = new THREE.Vector3().subVectors(b, a);
  const dist = delta.length();
  const dirN = delta.clone().normalize();
  const rotY = Math.atan2(dirN.z, dirN.x) * -1;
  const perp = new THREE.Vector3(-dirN.z, 0, dirN.x);
  const rise = horizontalLinkArc(style, dist);
  const fused = style !== "bridge";
  const halfWidth = horizontalLinkWidth(style) / 2;
  const seed = (slot * 0x9e3779b1) >>> 0;

  const stones = new InstList();
  const flames = new InstList();
  const bowls = new InstList();
  const c = new THREE.Color();
  const deckY = (t: number) => a.y + (b.y - a.y) * t + Math.sin(t * Math.PI) * rise;

  const nC = Math.max(4, Math.round(dist / (CELL * 0.5)));
  const segLen = dist / nC / CELL; // in blockGeo x-units
  for (let i = 0; i < nC; i++) {
    const t = (i + 0.5) / nC;
    const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
    const y = deckY(t);
    const h1 = hash3(seed, i, 3, 1);
    // deck slabs
    setHsl(c, 0.60, 0.24, 0.37 + hash3(seed, i, 4, 2) * 0.09);
    stones.pushY(
      px, y - 0.3, pz, rotY + (h1 - 0.5) * 0.03,
      segLen * 1.08, fused ? 0.78 : 0.65, fused ? horizontalLinkWidth(style) / CELL * 1.06 : 1.55, c,
    );
    // arch soffit: courses hang deeper toward the abutments — the classic
    // spring-line silhouette that sells "masonry", not "plank"
    const drop = fused
      ? 0.9 + Math.abs(t - 0.5) * 0.5
      : (1 - Math.sin(t * Math.PI)) * Math.min(3.2, dist * 0.17) + 0.7;
    setHsl(c, 0.60, 0.22, 0.29 + hash3(seed, i, 5, 3) * 0.07);
    stones.pushY(px, y - 0.45 - drop / 2, pz, rotY, segLen * 1.02, drop / COURSE, 1.1, c);
    // low parapet walls
    setHsl(c, 0.60, 0.25, 0.39 + hash3(seed, i, 6, 4) * 0.08);
    for (const side of fused ? [-halfWidth, halfWidth] : [-1.75, 1.75]) {
      stones.pushY(px + perp.x * side, y + 0.22, pz + perp.z * side, rotY + (h1 - 0.5) * 0.03, segLen * 0.94, 0.55, 0.16, c);
    }
    // A gallery is an inhabited seam: open columns and lintels visually carry
    // one district through the old block boundary without closing the route.
    if (style === "gallery" && (i === 0 || i === nC - 1 || i % 3 === 1)) {
      for (const side of [-halfWidth + 0.24, halfWidth - 0.24]) {
        setHsl(c, 0.09, 0.22, 0.34 + hash3(seed, i, side > 0 ? 18 : 19, 9) * 0.08);
        stones.pushY(px + perp.x * side, y + 1.25, pz + perp.z * side, rotY, 0.24, 2.7, 0.24, c);
      }
      stones.pushY(px, y + 2.52, pz, rotY, Math.max(0.3, segLen * 0.9), 0.32, horizontalLinkWidth(style) / CELL * 1.12, c);
    }
  }

  if (style === "court") {
    // One circular landmark physically crosses both block bounds. The ring
    // occupies the carved room aprons on either side while its center remains
    // clear for the grand-tour route and player movement.
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const my = deckY(0.5);
    const radius = 3.55;
    for (let k = 0; k < 16; k++) {
      const angle = k / 16 * Math.PI * 2;
      const along = Math.cos(angle) * radius, across = Math.sin(angle) * radius;
      const px = mx + dirN.x * along + perp.x * across;
      const pz = mz + dirN.z * along + perp.z * across;
      setHsl(c, 0.095 + (k % 2) * 0.008, 0.3, 0.42 + hash3(seed, k, 27, 10) * 0.1);
      stones.pushY(px, my + 0.03, pz, rotY - angle, 0.34, 0.2, 0.72, c);
      if ((k & 3) === 0) {
        stones.pushY(px, my + 1.1, pz, rotY - angle, 0.22, 2.3, 0.22, c);
      }
    }
    for (const side of [-1, 1]) {
      const px = mx + perp.x * side * (radius - 0.55);
      const pz = mz + perp.z * side * (radius - 0.55);
      bowls.pushY(px, my + 0.5, pz, 0, 1.05, 0.8, 1.05, hex(0x241d16));
      flames.pushY(px, my + 0.68, pz, 0, 1.15, 1.25, 1.15, hex(0xffffff));
    }
  }

  // Abutment pylons flank the crossing. The old implementation placed one
  // broad block on the deck centreline at each end: navigation treated that
  // volume as open while the rendered bridge visibly ran through solid stone.
  // Two narrow jambs preserve the load-bearing silhouette and leave a wider
  // clear opening than the analytic nav strip.
  for (const [end, sgn] of [[a, 1], [b, -1]] as const) {
    for (let k = 0; k < 3; k++) {
      const w = (fused ? 2.55 : 2.0) - k * 0.25;
      setHsl(c, 0.60, 0.24, 0.34 + hash3(seed, k, sgn + 2, 5) * 0.08);
      for (const side of [-1, 1]) {
        const jambOffset = fused ? halfWidth : 1.68;
        stones.pushY(
          end.x + dirN.x * sgn * 0.5 + perp.x * side * jambOffset,
          end.y - 0.9 + k * COURSE,
          end.z + dirN.z * sgn * 0.5 + perp.z * side * jambOffset,
          rotY + (hash3(seed, k, sgn + side + 7, 6) - 0.5) * 0.06,
          0.62 + (2 - k) * 0.08, 1, Math.max(0.34, w * 0.2), c,
        );
      }
    }
    // lantern: a small bowl seated on the parapet, flame rising out of it
    const lanternSide = fused ? halfWidth : 1.75;
    bowls.pushY(end.x + perp.x * lanternSide, end.y + 0.75, end.z + perp.z * lanternSide, 0, 0.7, 0.6, 0.7, hex(0x241d16));
    flames.pushY(end.x + perp.x * lanternSide, end.y + 0.85, end.z + perp.z * lanternSide, 0, 0.8, 0.85, 0.8, hex(0xffffff));
  }
  putInstanced(pool, "linkStones", R.blockGeo, R.stoneMat, stones, true);
  putInstancedTwin(pool, "linkStonesLo", "linkStones", R.blockGeoLo, R.stoneLoMat, true);
  putInstanced(pool, "linkBowls", R.bowlGeo, R.woodMat, bowls, false);
  putInstanced(pool, "linkFlames", R.flameGeo, R.flameWarm, flames, false);
  // A new/rebuilt companion slot must start in exactly one LOD. Leaving both
  // twins visible until the distance scheduler ran caused z-fighting, a pale
  // double layer and an unnecessary cold compile of the high stone shader.
  setSlotDetail(slot, false);

  const rise2 = makeRise(group, riseDelay);
  return {
    group,
    lights: [],
    tick: rise2,
    dispose() { /* slots persist — pruneSlots() hides unused ones */ },
  };
}

/** Massive masonry piers carrying a STACKED block: without them the upper
 *  layers levitate and the whole chain reads as a nonsense sky-city. Four
 *  corner piers (plus edge piers on big footprints) rise from the lower
 *  block's masonry to bite into the upper block's underside. */
export function buildSupportPiers(
  par: { l: Layout; ox: number; oy: number; oz: number },
  chi: { l: Layout; ox: number; oy: number; oz: number },
  slot: number, sceneRoot: THREE.Object3D, riseDelay = 0,
): SupportPierHandle {
  const R = getKit();
  const pool = getSlot(slot, sceneRoot);
  pool.group.name = "support-piers";
  const bricks = new InstList();
  const blockers: WorldBlocker[] = [];
  const c = new THREE.Color();
  // piers stand on the OVERLAP of the two footprints (stacked pairs share it
  // fully; monument layers overlap by quadrants), inset from its corners
  const halfC = (chi.l.N * CELL) / 2, halfP = (par.l.N * CELL) / 2;
  const x0 = Math.max(chi.ox - halfC, par.ox - halfP), x1 = Math.min(chi.ox + halfC, par.ox + halfP);
  const z0 = Math.max(chi.oz - halfC, par.oz - halfP), z1 = Math.min(chi.oz + halfC, par.oz + halfP);
  const inset = CELL * 1.7;
  const sites: Array<[number, number]> = [];
  if (x1 - x0 > inset * 2 + CELL && z1 - z0 > inset * 2 + CELL) {
    sites.push(
      [x0 + inset, z0 + inset], [x1 - inset, z0 + inset],
      [x0 + inset, z1 - inset], [x1 - inset, z1 - inset],
    );
    if (x1 - x0 > 13 * CELL) sites.push([(x0 + x1) / 2, z0 + inset], [(x0 + x1) / 2, z1 - inset]);
  } else {
    sites.push([(x0 + x1) / 2, (z0 + z1) / 2]); // sliver overlap: one central pier
  }
  const seed = (slot * 0x85ebca6b) >>> 0;
  for (let s = 0; s < sites.length; s++) {
    // footing MUST land on SOLID parent ground — a pier standing over a VOID
    // cell (ravine, eaten edge) hangs in mid-air. Search outward for the
    // nearest solid cell and move the pier onto its center; none → no pier.
    const N2 = par.l.N;
    const gx0 = Math.round((sites[s][0] - par.ox) / CELL + (N2 - 1) / 2);
    const gy0 = Math.round((sites[s][1] - par.oz) / CELL + (N2 - 1) / 2);
    let fgx = -1, fgy = -1, bestScore = Infinity;
    outer: for (let r = 0; r <= 2; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const gx = gx0 + dx, gy = gy0 + dy;
        if (gx < 0 || gy < 0 || gx >= N2 || gy >= N2) continue;
        const pk = par.l.kind[gy * N2 + gx];
        if (pk === VOID) continue;
        const wx = par.ox + (gx - (N2 - 1) / 2) * CELL;
        const wz = par.oz + (gy - (N2 - 1) / 2) * CELL;
        const cgx = Math.round((wx - chi.ox) / CELL + (chi.l.N - 1) / 2);
        const cgy = Math.round((wz - chi.oz) / CELL + (chi.l.N - 1) / 2);
        const ck = cgx >= 0 && cgy >= 0 && cgx < chi.l.N && cgy < chi.l.N
          ? chi.l.kind[cgy * chi.l.N + cgx]
          : VOID;
        // A stair court must remain clear on BOTH layers. Treat the full
        // 5x5 neighborhood as reserved so a carrying pier can never become a
        // hidden navigation blocker beside a generated landing.
        const nearParShaft = par.l.verticalAnchors.some((a) =>
          Math.max(Math.abs(a.x - gx), Math.abs(a.y - gy)) <= 2);
        const nearChiShaft = chi.l.verticalAnchors.some((a) =>
          Math.max(Math.abs(a.x - cgx), Math.abs(a.y - cgy)) <= 2);
        if (nearParShaft || nearChiShaft) continue;
        // Wall-on-wall is structurally and navigationally ideal. A floor
        // footing is allowed only as a fallback and is registered as blocked.
        const score = (pk === WALL ? 0 : 20) + (ck === WALL ? 0 : ck === FLOOR ? 12 : 5) + r;
        if (score < bestScore) { bestScore = score; fgx = gx; fgy = gy; }
      }
      if (bestScore <= r) break outer;
    }
    if (fgx < 0) continue;
    const ci = fgy * N2 + fgx;
    const px = par.ox + (fgx - (N2 - 1) / 2) * CELL;
    const pz = par.oz + (fgy - (N2 - 1) / 2) * CELL;
    const baseY = par.oy + (par.l.kind[ci] === WALL ? par.l.wallTop[ci] - 1 : par.l.tier[ci]) * TH;
    const topY = chi.oy + TH * 0.6; // bite into the child's masonry — no seam
    if (topY <= baseY) continue; // the parent's existing wall mass already carries this point
    const n = Math.max(2, Math.ceil((topY - baseY) / COURSE));
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1 || 1);
      const h1 = hash3(seed, s, k, 5);
      // entasis: broad footing and flared capital, slimmer waist
      const w = 1.0 - Math.sin(t * Math.PI) * 0.25 + (h1 - 0.5) * 0.06;
      setHsl(c, 0.60, 0.22, 0.31 + hash3(seed, s, k, 6) * 0.08);
      bricks.pushY(
        px + (hash3(seed, s, k, 7) - 0.5) * 0.12, baseY + (k + 0.5) * COURSE,
        pz + (hash3(seed, s, k, 8) - 0.5) * 0.12,
        (h1 - 0.5) * 0.35, w, 1.02, w, c,
      );
    }
    blockers.push({ x: px, z: pz, y0: baseY, y1: topY, radius: CELL * 0.58, slot });
  }
  putInstanced(pool, "blocks", R.blockGeo, R.stoneMat, bricks, true);
  putInstancedTwin(pool, "blocksLo", "blocks", R.blockGeoLo, R.stoneLoMat, true);
  setSlotDetail(slot, false);
  const rise = makeRise(pool.group, riseDelay);
  return { group: pool.group, lights: [], tick: rise, dispose() {}, blockers };
}

/** forge reveal: freshly built content rises out of the abyss with a whisper
 *  of overshoot (easeOutBack). Group-transform only — costs nothing, and the
 *  handle is recreated per build, so re-forges replay it naturally. `delay`
 *  staggers the reveal: building is frame-budget-batched for speed, but each
 *  island still surfaces in sequence. */
function makeRise(group: THREE.Group, delay = 0): (t: number) => void {
  if (delay < 0) return () => {}; // repairs/rebuilds of already-risen content
  let born = -1, baseY = 0;
  return (t: number) => {
    if (born < 0) { born = t; baseY = group.position.y; }
    const k = Math.min(1, Math.max(0, (t - born - delay) / 1.15));
    const u = k - 1;
    const e = 1 + 2.70158 * u * u * u + 1.70158 * u * u;
    group.position.y = baseY - 26 * (1 - e);
  };
}

// ---------------------------------------------------------------------------
// Per-layout build.
// ---------------------------------------------------------------------------

/** Runtime bisect for masonry see-through. The interior-course cull is a
 *  purely horizontal test — it asks whether four neighbours hide a column's
 *  flanks, and has no concept of being seen from below. Turning it off and
 *  re-forging says definitively whether a reported hole is the cull or the
 *  geometry. Exposed on __df.masonry. */
let interiorCullEnabled = true;
/** Experiment switch: draw every course with the sealed box. If see-through
 *  banding disappears with this on, the open shells are the cause. */
let DEBUG_CLOSED_COURSES = false;
export function setClosedCourses(on: boolean): void { DEBUG_CLOSED_COURSES = on; }
export function getClosedCourses(): boolean { return DEBUG_CLOSED_COURSES; }
export function setInteriorCull(on: boolean): void { interiorCullEnabled = on; }
export function getInteriorCull(): boolean { return interiorCullEnabled; }

export function buildWorld(l: Layout, slot: number, sceneRoot: THREE.Object3D, rootScale = 1, riseDelay = 0): WorldHandle {
  worldLists.reset();
  const list = (capacity = 64) => worldLists.take(capacity);
  const R = getKit();
  // Point the texture-sampled fracture layer at this layout's decay, so the
  // same shared material renders a pristine sanctum and a collapsed ossuary.
  setStoneDamage(l.params?.decay ?? 0.5);
  const { N, kind, tier, wallTop, wallBase, support } = l;
  const gi = (x: number, y: number) => y * N + x;
  const worldCoord = new Float32Array(N);
  const center = (N - 1) / 2;
  for (let i = 0; i < N; i++) worldCoord[i] = (i - center) * CELL;
  const seed = l.seed;

  const pool = getSlot(slot, sceneRoot);
  const group = pool.group;
  group.name = "fortress";
  const addUnique = (o: THREE.Object3D) => {
    if (isDecorSuppressed()) o.visible = false; // two-wave first paint
    group.add(o);
    pool.perBuild.push(o);
  };
  // geometries unique to this layout (bridge ropes) — everything else is shared
  const perBuildGeos = pool.perBuildGeos;

  // ---------------------------------------------------------------- masonry
  const blocks = list(N * N * 2);
  const blockMids = list(N * N * 3);
  const blockTops = list(N * N);
  const blockBases = list(N * N);
  const blocksLow = list(N * N);
  const merlons = list(N * 4);
  const architecturalBays = list(N * 3);
  const towerRoofs = list(Math.max(4, l.towers.length));
  const tiles = list(N * N);
  const tilesLow = list(N * N / 2);
  const redTiles = list(128);
  const stoneColor = new THREE.Color();
  const narrativeRole = l.params.narrativeRole;

  const cellCount = N * N;
  const templeBuilding = new Uint8Array(cellCount);
  for (const c of l.templeCells) templeBuilding[c] = 1;
  const towerAt: Array<Layout["towers"][number] | undefined> = new Array(cellCount);
  for (const tower of l.towers) towerAt[tower.y * N + tower.x] = tower;

  // Interior maze walls are slimmer than the corridors they divide: thin across
  // their run direction, with fatter posts at crossings. Ramparts (boundary or
  // void-facing), towers and the temple building stay full-width.
  const thin = Math.min(1, Math.max(0.25, l.params?.wallThin ?? 0.45));
  const post = Math.min(1, thin + 0.22); // crossing pillars slightly proud of the slabs
  // Precompute scalar dimensions once. The old lazy helper returned a fresh
  // {sx, sz} object on every lookup, including four lookups per occlusion test.
  const wallSX = new Float32Array(cellCount).fill(1);
  const wallSZ = new Float32Array(cellCount).fill(1);
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      const c = y * N + x;
      if (kind[c] !== WALL || templeBuilding[c] || towerAt[c]) continue;
      const east = kind[c + 1], west = kind[c - 1], south = kind[c + N], north = kind[c - N];
      if (east === VOID || west === VOID || south === VOID || north === VOID) continue;
      const fx = east === FLOOR || west === FLOOR;
      const fz = south === FLOOR || north === FLOOR;
      if (fx && !fz) wallSX[c] = thin;
      else if (fz && !fx) wallSZ[c] = thin;
      else if (fx && fz) wallSX[c] = wallSZ[c] = post;
      else wallSX[c] = wallSZ[c] = Math.min(1, post + 0.1);
    }
  }
  const wallHalf = (x: number, y: number, d: Dir): number => {
    const c = y * N + x;
    return (d <= 1 ? wallSX[c] : wallSZ[c]) * CELL * 0.5;
  };

  // Only an interior wall separating two compatible floors is breachable.
  // The passage band is tracked per rendered course below; high cornices and
  // decorative masonry never mutate navigation when struck.
  const breachTier = new Int8Array(cellCount).fill(ABYSS);
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      const c = y * N + x;
      if (kind[c] !== WALL || templeBuilding[c] || towerAt[c] || l.doorMask[c] || l.shaftMask[c]) continue;
      const ew = kind[c - 1] === FLOOR && kind[c + 1] === FLOOR && Math.abs(tier[c - 1] - tier[c + 1]) <= 1;
      const ns = kind[c - N] === FLOOR && kind[c + N] === FLOOR && Math.abs(tier[c - N] - tier[c + N]) <= 1;
      if (ew || ns) breachTier[c] = Math.max(
        ew ? Math.max(tier[c - 1], tier[c + 1]) : ABYSS,
        ns ? Math.max(tier[c - N], tier[c + N]) : ABYSS,
      );
    }
  }
  const breachCells = new Map<number, MasonryBreachCell>();
  const breachByInstance = new Map<number, MasonryBreachCell>();
  const breachByMiddleInstance = new Map<number, MasonryBreachCell>();
  const breachByTopInstance = new Map<number, MasonryBreachCell>();
  const breachByBaseInstance = new Map<number, MasonryBreachCell>();
  let masonryPotential = 0;
  let masonryInteriorCulled = 0;
  let masonryDoorCulled = 0;

  // Occlusion tier: the height below which every side of a column is hidden by
  // its 4 neighbors — those courses never rasterize (topmost course always kept
  // for the visible cap face).
  const occlTier = new Int8Array(cellCount).fill(ABYSS);
  const neighborOffsets = [1, -1, N, -N];
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      const c = y * N + x;
      let o = 127;
      for (const off of neighborOffsets) {
        const n = c + off;
        if (kind[n] === FLOOR) o = Math.min(o, tier[n]);
        else if (kind[n] === WALL) {
          // a slimmed wall no longer hides its neighbor's flank — only count
          // full-width neighbors as occluders above their base
          o = Math.min(o, wallSX[n] === 1 && wallSZ[n] === 1 ? wallTop[n] : wallBase[n]);
        } else { o = ABYSS; break; }
      }
      occlTier[c] = o;
    }
  }

  const pushCourses = (
    x: number, y: number, baseTier: number, topTier: number,
    refFloorTier: number, scaleXZ: number, warm: number,
    sx = 1, sz = 1,
  ) => {
    const cell = y * N + x;
    const cx = worldCoord[x], cz = worldCoord[y];
    const nCourses = Math.max(0, Math.round((topTier - baseTier) * TH / COURSE));
    const doorCell = l.doorMask[cell] === 1;
    const occlH = occlTier[cell] * TH;
    // occlTier is a purely horizontal test — the minimum height at which all
    // four neighbours hide this column's flanks. It has no concept of "below",
    // so a mass overhanging the abyss needs its lowest course sealed.
    const bottomExposed = wallBase[cell] === ABYSS;
    const courseY0 = (k: number) => baseTier * TH + k * COURSE;
    const inDoorGap = (k: number): boolean => {
      if (!doorCell || !l.door) return false;
      const yMid = courseY0(k) + COURSE / 2;
      return yMid > l.door.tier * TH && yMid < l.door.tier * TH + 2.6;
    };
    const breachAt = (k: number): boolean => {
      const floorTier = breachTier[cell];
      if (floorTier === ABYSS) return false;
      const yMid = courseY0(k) + COURSE / 2;
      return yMid > floorTier * TH && yMid < floorTier * TH + 2.65;
    };
    // One decision for the whole column, so a course can never be left with a
    // missing face because something else removed its neighbour.
    const column = planColumn({
      courseCount: nCourses,
      removed: (k) => {
        if (inDoorGap(k)) return true;
        if (!interiorCullEnabled) return false;
        if (breachAt(k)) return false;
        if (bottomExposed && k === 0) return false;
        return k < nCourses - 1 && courseY0(k) + COURSE <= occlH - 0.01;
      },
      sealed: (k) => breachAt(k) || DEBUG_CLOSED_COURSES,
      // A boundary below the occlusion height is hidden by the neighbours, so
      // it needs no geometry even when the adjacent course is gone.
      boundaryVisible: (k) => courseY0(k) > occlH - 0.01,
      bottomExposed,
    });
    for (let k = 0; k < nCourses; k++) {
      masonryPotential++;
      const y0 = baseTier * TH + k * COURSE;
      const yMid = y0 + COURSE / 2;
      const planned = column[k];
      if (!planned.render) {
        if (inDoorGap(k)) masonryDoorCulled++;
        else masonryInteriorCulled++;
        continue;
      }
      const h1 = hash3(seed, x * 131 + y, k, 1);
      const h2v = hash3(seed, x * 131 + y, k, 2);
      const h3v = hash3(seed, x * 131 + y, k, 3);
      // baked AO: courses far below the nearest floor sit in shadowed crevices
      const rel = Math.min(1, Math.max(0, (yMid - refFloorTier * TH) / (2.6 * TH) + 0.72));
      const lumRaw = (0.50 + h1 * 0.16) * (0.55 + 0.45 * rel);
      // Painterly value grouping is baked once per course instead of
      // quantised per fragment. Broad authored-looking patches survive while
      // the hot masonry shader stays exactly as cheap as before.
      const lumBand = (Math.floor(lumRaw * 6) + 0.5) / 6;
      const lum = lumRaw * 0.45 + lumBand * 0.55;
      // Moon-facing masonry is painted in a cool slate family rather than an
      // ochre base merely neutralised by blue lighting. Temple masses retain
      // a restrained earthen family, giving torch pools something warm to
      // reveal without turning the whole fortress grey.
      const hue = warm ? 0.085 + (h2v - 0.5) * 0.025 : 0.59 + (h2v - 0.5) * 0.045;
      const sat = warm ? 0.32 + (h3v - 0.5) * 0.08 : 0.25 + (h3v - 0.5) * 0.09;
      setHsl(stoneColor, hue, sat, lum);
      const palettePick = hash3(seed, x * 197 + y, k, 93);
      if (palettePick < 0.46) stoneColor.lerp(_paintCool, 0.22 + (0.46 - palettePick) * 0.34);
      else if (palettePick > 0.76) stoneColor.lerp(_paintWarm, 0.12 + (palettePick - 0.76) * 0.25);
      if (yMid < refFloorTier * TH + COURSE && h1 < 0.12) stoneColor.lerp(MOSS_TINT, 0.45); // moss
      const jx = (h2v - 0.5) * 0.12 + ((k % 2) ? 0.05 : -0.05);
      const jz = (h3v - 0.5) * 0.12 + ((k % 2) ? -0.05 : 0.05);
      // cornice ring every 5th course on towers — segmented silhouette
      const cornice = scaleXZ > 1.2 && k % 5 === 4 ? 1.14 : 1;
      const s = scaleXZ * cornice;
      const handSx = 0.965 + h1 * 0.07;
      const handSz = 0.965 + h3v * 0.07;
      const breachCourse = breachAt(k);
      const floorTier = breachTier[cell];
      const shell: CourseShell = planned.shell;
      const target = shell === "full" ? blocks
        : shell === "top" ? blockTops
        : shell === "base" ? blockBases : blockMids;
      const targetBreaches = shell === "full" ? breachByInstance
        : shell === "top" ? breachByTopInstance
        : shell === "base" ? breachByBaseInstance : breachByMiddleInstance;
      const instanceId = target.count;
      target.pushY(cx + jx, yMid, cz + jz, (h1 - 0.5) * 0.065, s * handSx * sx, 1, s * handSz * sz, stoneColor);
      if (breachCourse) {
        let breach = breachCells.get(cell);
        if (!breach) {
          breach = { layout: l, cell, gx: x, gy: y, floorTier, required: [], destroyed: new Set(), opened: false };
          breachCells.set(cell, breach);
        }
        breach.required.push(instanceId);
        targetBreaches.set(instanceId, breach);
      }
    }

    // Far representation: collapse consecutive regular courses into one tall
    // prism. Door gaps and proud tower cornices remain explicit boundaries;
    // the cheap low material draws course seams analytically. This removes
    // hidden inter-course caps and tens of thousands of distant instances.
    const pushLowSpan = (start: number, end: number, proud = 1) => {
      if (end <= start) return;
      // Very tall single prisms saved instances but read as extruded CAD walls.
      // Split them into irregular 7–10-course brush blocks: still far cheaper
      // than one instance per brick, but with authored horizontal rhythm and a
      // fresh baked palette sample at each broad stroke. The first 3–5-course
      // pass raised low-detail triangles from 284k to 397k and cost 7–8%; this
      // cadence keeps the painted breakup without throwing away the LOD win.
      let cursor = start;
      while (cursor < end) {
        const brushCourses = 7 + Math.floor(hash3(seed, x * 131 + y, cursor, 91) * 4);
        const next = Math.min(end, cursor + brushCourses);
        const midK = Math.floor((cursor + next - 1) / 2);
        const h1 = hash3(seed, x * 131 + y, midK, 1);
        const h2v = hash3(seed, x * 131 + y, midK, 2);
        const h3v = hash3(seed, x * 131 + y, midK, 3);
        const yMid = baseTier * TH + (cursor + next) * COURSE * 0.5;
        const rel = Math.min(1, Math.max(0, (yMid - refFloorTier * TH) / (2.6 * TH) + 0.72));
        const lum = (0.48 + h1 * 0.14) * (0.55 + 0.45 * rel);
        setHsl(
          stoneColor,
          warm ? 0.085 + (h2v - 0.5) * 0.025 : 0.59 + (h2v - 0.5) * 0.04,
          warm ? 0.30 : 0.23,
          lum,
        );
        const palettePick = hash3(seed, x * 197 + y, midK, 92);
        if (palettePick < 0.46) stoneColor.lerp(_paintCool, 0.18 + (0.46 - palettePick) * 0.24);
        else if (palettePick > 0.76) stoneColor.lerp(_paintWarm, 0.10 + (palettePick - 0.76) * 0.2);
        blocksLow.pushY(
          cx, yMid, cz, 0,
          scaleXZ * proud * sx, next - cursor, scaleXZ * proud * sz, stoneColor,
        );
        cursor = next;
      }
    };
    let runStart = -1;
    for (let k = 0; k < nCourses; k++) {
      const y0 = baseTier * TH + k * COURSE;
      const yMid = y0 + COURSE / 2;
      const hidden = k < nCourses - 1 && y0 + COURSE <= occlH - 0.01;
      const doorGap = doorCell && l.door
        ? yMid > l.door.tier * TH && yMid < l.door.tier * TH + 2.6
        : false;
      const cornice = scaleXZ > 1.2 && k % 5 === 4;
      if (hidden || doorGap || cornice) {
        if (runStart >= 0) pushLowSpan(runStart, k);
        runStart = -1;
        if (!hidden && !doorGap) pushLowSpan(k, k + 1, 1.14);
      } else if (runStart < 0) runStart = k;
    }
    if (runStart >= 0) pushLowSpan(runStart, nCourses);
  };

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const c = gi(x, y);
      if (kind[c] === WALL && !l.shaftMask[c]) {
        let ref = wallBase[c];
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (nx >= 0 && ny >= 0 && nx < N && ny < N && kind[gi(nx, ny)] === FLOOR) ref = Math.max(ref, tier[gi(nx, ny)]);
        }
        const tower = towerAt[c];
        const warm = templeBuilding[c];
        const sx = wallSX[c], sz = wallSZ[c];
        pushCourses(x, y, wallBase[c], wallTop[c], ref, tower ? tower.scale : 1, warm, sx, sz);
        // slim walls expose strips of the cell — pave them so the corridor
        // floor reads as continuing beneath the wall
        if (sx < 1 || sz < 1) {
          const hp = hash2(seed, c, 23);
          setHsl(stoneColor, 0.60, 0.22, 0.31 + hp * 0.1);
          tiles.pushY(worldCoord[x], wallBase[c] * TH + 0.07, worldCoord[y], 0, 0.995, 1, 0.995, stoneColor);
          tilesLow.pushY(worldCoord[x], wallBase[c] * TH + 0.07, worldCoord[y], 0, 0.995, 1, 0.995, stoneColor);
        }
        // battlement teeth ONLY where the wall meets the outside or the ravine —
        // interior maze walls keep clean tops (center studs read as lego bricks)
        let voidDir = -1;
        const exteriorDirs: Dir[] = [];
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (nx < 0 || ny < 0 || nx >= N || ny >= N || kind[gi(nx, ny)] === VOID) {
            if (voidDir < 0) voidDir = d;
            exteriorDirs.push(d as Dir);
          }
        }
        if (voidDir >= 0 && !tower && !l.doorMask[c] && !l.ruinMask[c]) {
          const alongX = DY[voidDir] !== 0; // rim runs perpendicular to the void
          for (const off of [-0.58, 0.58]) {
            setHsl(stoneColor, 0.59, 0.28, 0.34 + hash2(seed, c, 9) * 0.09);
            merlons.pushY(
              worldCoord[x] + (alongX ? off : 0), wallTop[c] * TH + 0.16, worldCoord[y] + (alongX ? 0 : off),
              0, 0.8, 0.92, 0.8, stoneColor,
            );
          }
        }
        // Architectural façade skin. The maze/collision cells stay exactly as
        // generated, but visible exterior runs gain shared cornices, pointed
        // arches and seam buttresses. Repeated bays overlap at their edges, so
        // the eye reads one continuous building elevation instead of one box
        // per cell. Ruins intentionally leave occasional broken bays.
        if (!tower && !l.doorMask[c]) {
          const roleDensity = narrativeRole === "overgrowth" ? 0.62
            : narrativeRole === "forge" ? 0.72
              : narrativeRole === "threshold" ? 0.84 : 0.94;
          for (const d of exteriorDirs) {
            const faceHeight = (wallTop[c] - ref) * TH;
            if (faceHeight < 4.1) continue;
            const admitted = !l.ruinMask[c]
              ? hash3(seed, c, d, 361) < roleDensity
              : hash3(seed, c, d, 362) < roleDensity * 0.28;
            if (!admitted) continue;
            const faceScaleY = THREE.MathUtils.clamp(faceHeight / 5.7, 0.78, 1.48);
            const faceScaleX = 0.94 + hash3(seed, c, d, 363) * 0.045;
            const faceDepth = 0.86 + hash3(seed, c, d, 364) * 0.14;
            const topY = wallTop[c] * TH - 0.04;
            const halfFace = wallHalf(x, y, d);
            setHsl(
              stoneColor,
              narrativeRole === "forge" ? 0.075 : 0.59 + (hash3(seed, c, d, 365) - 0.5) * 0.025,
              narrativeRole === "forge" ? 0.29 : 0.24,
              0.31 + hash3(seed, c, d, 366) * 0.09,
            );
            architecturalBays.pushY(
              worldCoord[x] + DX[d] * (halfFace + 0.08),
              topY - 5.02 * faceScaleY,
              worldCoord[y] + DY[d] * (halfFace + 0.08),
              dirRotY(d), faceScaleX, faceScaleY, faceDepth, stoneColor,
            );
          }
        }
        if (tower) {
          for (const [mx, mz] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) {
            setHsl(stoneColor, 0.075, 0.3, 0.38);
            merlons.pushY(worldCoord[x] + mx * tower.scale, tower.top * TH + 0.18, worldCoord[y] + mz * tower.scale, 0, 0.9, 1.15, 0.9, stoneColor);
          }
        }
      } else if (kind[c] === FLOOR && support[c] < tier[c]) {
        pushCourses(x, y, support[c], tier[c], tier[c], 1, 0);
      }
    }
  }

  // temple facade: pilasters flanking the doorway + a proud lintel course.
  // Oriented by doorDir — rotated layouts put the temple on any side.
  if (l.temple && l.door) {
    const T = l.temple;
    const fdx = DX[l.doorDir], fdz = DY[l.doorDir];
    const pxd = -fdz, pzd = fdx; // along the facade
    const rotF = dirRotY(l.doorDir);
    const fx0 = worldCoord[l.door.x] + fdx * (CELL / 2 + 0.14);
    const fz0 = worldCoord[l.door.y] + fdz * (CELL / 2 + 0.14);
    for (const sgn of [-1, 1]) {
      const bx = fx0 + pxd * sgn * 0.62 * CELL;
      const bz = fz0 + pzd * sgn * 0.62 * CELL;
      const nC = Math.round(((T.buildTop - T.platformTier) * TH - 0.4) / COURSE);
      for (let k = 0; k < nC; k++) {
        setHsl(stoneColor, 0.1, 0.46, 0.5 + hash3(seed, k, 5, 8) * 0.1);
        blocks.pushY(bx, T.platformTier * TH + (k + 0.5) * COURSE, bz, rotF, 0.34, 0.98, 0.22, stoneColor);
      }
    }
    setHsl(stoneColor, 0.1, 0.48, 0.56);
    blocks.pushY(fx0, l.door.tier * TH + 2.75, fz0, rotF, 1.55, 0.85, 0.24, stoneColor);
  }
  // pavilion roof slabs on towers
  for (const t of l.towers) {
    setHsl(stoneColor, 0.59, 0.28, 0.38);
    blocks.pushY(worldCoord[t.x], t.top * TH + (t.beacon ? 1.9 : 0) + 0.1, worldCoord[t.y], 0, t.scale * 1.22, t.beacon ? 0.55 : 0.45, t.scale * 1.22, stoneColor);
    if (t.beacon) {
      // four corner posts holding the roof over the beacon
      for (const [mx, mz] of [[-0.62, -0.62], [0.62, -0.62], [-0.62, 0.62], [0.62, 0.62]]) {
        setHsl(stoneColor, 0.59, 0.27, 0.34);
        blocks.pushY(worldCoord[t.x] + mx * t.scale, t.top * TH + 1.0, worldCoord[t.y] + mz * t.scale, 0, 0.22, 2.4, 0.22, stoneColor);
      }
    } else if (hash3(seed, t.x, t.y, 371) < 0.76) {
      // Steep roofs create a second skyline family beside battlement towers.
      // One shared instanced mesh keeps the added architectural read cheap.
      const roofHue = narrativeRole === "forge" ? 0.065 : 0.61;
      setHsl(stoneColor, roofHue, 0.28, 0.24 + hash3(seed, t.x, t.y, 372) * 0.08);
      const roofXZ = CELL * t.scale * (0.76 + hash3(seed, t.x, t.y, 373) * 0.08);
      const roofY = 3.2 + t.scale * 0.95 + hash3(seed, t.x, t.y, 374) * 0.8;
      towerRoofs.pushY(
        worldCoord[t.x], t.top * TH + 0.34, worldCoord[t.y],
        hash3(seed, t.x, t.y, 375) * Math.PI / 3,
        roofXZ, roofY, roofXZ, stoneColor,
      );
    }
  }

  // (instanced meshes are created at the END of buildWorld so later sections —
  //  totem pillars, bridge abutments, stair cheeks — can still add masonry)

  // ---------------------------------------------------------------- floors
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const c = gi(x, y);
      if (kind[c] !== FLOOR || l.stairMask[c]) continue;
      const h1 = hash2(seed, c, 21), h2v = hash2(seed, c, 22);
      let target = tiles;
      if (l.redMask[c]) {
        setHsl(stoneColor, 0.015, 0.5, 0.14 + h1 * 0.05);
        target = redTiles;
      } else if (l.templeMask[c]) {
        setHsl(stoneColor, 0.09, 0.32, 0.46 + h1 * 0.12);
      } else if (l.plazaMask[c]) {
        setHsl(stoneColor, 0.59, 0.25, 0.40 + h1 * 0.11);
      } else {
        setHsl(stoneColor, 0.60 + (h2v - 0.5) * 0.035, 0.22, 0.35 + h1 * 0.11);
      }
      target.pushY(
        worldCoord[x] + (h2v - 0.5) * 0.05, tier[c] * TH + 0.07, worldCoord[y] + (h1 - 0.5) * 0.05,
        (h1 - 0.5) * 0.04, 0.985, 1, 0.985, stoneColor,
      );
    }
  }
  // Far floor representation: greedy horizontal spans preserve height and
  // narrative surface class, but remove the one-box-per-cell silhouette and
  // all internal side faces. High detail keeps the authored individual slabs.
  for (let y = 0; y < N; y++) {
    let x = 0;
    while (x < N) {
      const startCell = gi(x, y);
      if (kind[startCell] !== FLOOR || l.stairMask[startCell] || l.redMask[startCell]) { x++; continue; }
      const start = x;
      const floorTier = tier[startCell];
      const surfaceClass = l.templeMask[startCell] ? 1 : l.plazaMask[startCell] ? 2 : 0;
      x++;
      while (x < N) {
        const c = gi(x, y);
        const cls = l.templeMask[c] ? 1 : l.plazaMask[c] ? 2 : 0;
        if (kind[c] !== FLOOR || l.stairMask[c] || l.redMask[c] || tier[c] !== floorTier || cls !== surfaceClass) break;
        x++;
      }
      const end = x;
      const midX = Math.floor((start + end - 1) / 2);
      const sampleCell = gi(midX, y);
      const h1 = hash2(seed, sampleCell, 21), h2v = hash2(seed, sampleCell, 22);
      if (surfaceClass === 1) setHsl(stoneColor, 0.09, 0.32, 0.46 + h1 * 0.12);
      else if (surfaceClass === 2) setHsl(stoneColor, 0.59, 0.25, 0.40 + h1 * 0.11);
      else setHsl(stoneColor, 0.60 + (h2v - 0.5) * 0.035, 0.22, 0.35 + h1 * 0.11);
      tilesLow.pushY(
        (worldCoord[start] + worldCoord[end - 1]) * 0.5,
        floorTier * TH + 0.07,
        worldCoord[y], 0,
        (end - start) * 0.985, 1, 0.985,
        stoneColor,
      );
    }
  }
  // ---------------------------------------------------------------- stairs
  const steps = list(l.stairs.length * 4);
  const cheeks = list(l.stairs.length * 2);
  const slope = Math.atan2(TH, CELL);
  for (const s of l.stairs) {
    const rot = dirRotY(s.dir);
    const fx = DX[s.dir], fz = DY[s.dir];
    for (let i = 0; i < 4; i++) {
      const along = -CELL / 2 + (i + 0.5) * (CELL / 4);
      const h1 = hash3(seed, s.x * 57 + s.y, i, 4);
      // lighter treads than the surrounding pavement so flights read at a glance
      setHsl(stoneColor, 0.09, 0.28, 0.42 + h1 * 0.1);
      steps.pushY(
        worldCoord[s.x] + fx * along, s.tier * TH + (i + 0.5) * (TH / 4), worldCoord[s.y] + fz * along,
        rot, 1, 1.06, 1, stoneColor,
      );
    }
    // sloped stringer cheeks flanking the flight — the strongest stair cue
    const px = -fz, pz = fx; // perpendicular
    _stairYaw.setFromAxisAngle(_axisY, rot);
    _stairPitch.setFromEuler(_stairEuler.set(-slope, 0, 0));
    _stairQuat.copy(_stairYaw).multiply(_stairPitch);
    for (const sgn of [-1, 1]) {
      setHsl(stoneColor, 0.085, 0.26, 0.3 + hash3(seed, s.x, s.y, sgn + 5) * 0.06);
      _stairPos.set(
        worldCoord[s.x] + px * sgn * (CELL / 2 - 0.1), s.tier * TH + TH * 0.5 + 0.02,
        worldCoord[s.y] + pz * sgn * (CELL / 2 - 0.1),
      );
      cheeks.pushMatrix(_mat4.compose(_stairPos, _stairQuat, _unitScale).elements, stoneColor);
    }
  }

  // per-plaza identity: a curated arcane palette + jitter, deterministic per
  // seed. Shared by the medallion disc and its brazier ring so the whole
  // plaza glows one color.
  // ordered so that neighboring ENTRIES are far apart in hue (azure, gold,
  // cyan, crimson, violet, emerald, rose) — walking the list with a small
  // stride therefore always yields well-separated colors on one island
  const PLAZA_HUES = [0x3d7dff, 0xffb43a, 0x3fd9de, 0xff5c49, 0xa45cff, 0x38e0a5, 0xff6fb2];
  const plazaColor = (mIdx: number): THREE.Color => {
    const base = Math.floor(hash2(seed, 500, 7) * PLAZA_HUES.length);
    const stride = 1 + Math.floor(hash2(seed, 503, 7) * 2);
    const c2 = new THREE.Color(PLAZA_HUES[(base + mIdx * stride) % PLAZA_HUES.length]);
    c2.offsetHSL((hash2(seed, 501 + mIdx, 8) - 0.5) * 0.06, 0, (hash2(seed, 502 + mIdx, 9) - 0.5) * 0.1);
    return c2;
  };
  const plazaOf = (x: number, y: number): number => l.medallions.findIndex((m) => {
    const dx = m.x - x, dy = m.y - y, r = m.r + 1.6;
    return dx * dx + dy * dy <= r * r;
  });

  // ---------------------------------------------------------------- torches & braziers
  const brackets = list(l.torches.length);
  const warmFlames = list(l.torches.length);
  const blueFlames = list();
  const redFlames = list();
  const plazaFlames = list();
  const flameAnchors: Array<{ x: number; y: number; z: number }> = [];

  for (const t of l.torches) {
    const rot = dirRotY(t.dir);
    const fx = DX[t.dir], fz = DY[t.dir];
    const half = wallHalf(t.x, t.y, t.dir);
    const px = worldCoord[t.x] + fx * (half + 0.12);
    const pz = worldCoord[t.y] + fz * (half + 0.12);
    const py = t.tier * TH + 1.9;
    brackets.pushY(px, py - 0.28, pz, rot, 1, 1, 1, hex(0x2a2018));
    warmFlames.pushY(px + fx * 0.08, py, pz + fz * 0.08, rot, 1, 1, 1, hex(0xffffff));
    flameAnchors.push({ x: px, y: py + 0.3, z: pz });
  }

  const bowls = list(l.braziers.length);
  for (const b of l.braziers) {
    const px = worldCoord[b.x], pz = worldCoord[b.y];
    // totems stand on a carved stone pillar; plaza braziers sit on the ground
    const lift = b.totem ? 1.15 : 0;
    const py = b.tier * TH + 0.15 + lift;
    if (b.totem) {
      setHsl(stoneColor, 0.09, 0.3, 0.3 + hash2(seed, b.x * 91 + b.y, 12) * 0.08);
      blocks.pushY(px, b.tier * TH + 0.65, pz, hash2(seed, b.x, b.y) * 0.4, 0.2, 1.6, 0.2, stoneColor);
    }
    bowls.pushY(px, py + 0.42, pz, 0, 1, 1, 1, hex(0x241d16));
    // braziers ringing a medallion burn in the PLAZA's color (neutral flame
    // ramp × per-instance tint); everything else keeps its named kind
    const owner = b.totem || b.kind === "red" ? -1 : plazaOf(b.x, b.y);
    if (owner >= 0) {
      plazaFlames.pushY(px, py + 0.72, pz, 0, 1.55, 1.75, 1.55, plazaColor(owner).offsetHSL(0, 0, 0.1));
    } else {
      const target = b.kind === "blue" ? blueFlames : b.kind === "red" ? redFlames : warmFlames;
      target.pushY(px, py + 0.72, pz, 0, 1.55, 1.75, 1.55, hex(0xffffff));
    }
    flameAnchors.push({ x: px, y: py + 1.1, z: pz });
  }

  putInstanced(pool, "brackets", R.bracketGeo, R.woodMat, brackets, false);
  putInstanced(pool, "bowls", R.bowlGeo, R.woodMat, bowls, false);

  // fake local torchlight: wall glow + a pool of light on the floor beneath
  {
    const wallGlows = list(l.torches.length);
    for (const t of l.torches) {
      const rot = dirRotY(t.dir);
      const fx = DX[t.dir], fz = DY[t.dir];
      const half = wallHalf(t.x, t.y, t.dir);
      wallGlows.pushY(
        worldCoord[t.x] + fx * (half + 0.05), t.tier * TH + 1.7, worldCoord[t.y] + fz * (half + 0.05),
        rot, 1, 1, 1, hex(0xffffff),
      );
    }
    putInstanced(pool, "wallGlows", R.wallGlowGeo, R.wallGlowMat, wallGlows, false);

    const floorGlows = list(l.braziers.length);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const big = new THREE.Vector3(1.6, 1.6, 1.6);
    for (const t of l.torches) {
      const fx = DX[t.dir], fz = DY[t.dir];
      const half = wallHalf(t.x, t.y, t.dir);
      pos.set(worldCoord[t.x] + fx * (half + 0.7), t.tier * TH + 0.19, worldCoord[t.y] + fz * (half + 0.7));
      floorGlows.pushMatrix(_mat4.compose(pos, q, one).elements, hex(0xffffff));
    }
    for (const b of l.braziers) {
      pos.set(worldCoord[b.x], b.tier * TH + 0.21, worldCoord[b.y]);
      floorGlows.pushMatrix(_mat4.compose(pos, q, big).elements, hex(0xffffff));
    }
    putInstanced(pool, "floorGlows", R.floorGlowGeo, R.floorGlowMat, floorGlows, false);
  }

  // ---------------------------------------------------------------- banners
  {
    const items = list(l.banners.length);
    for (const b of l.banners) {
      const rot = dirRotY(b.dir);
      const fx = DX[b.dir], fz = DY[b.dir];
      const half = wallHalf(b.x, b.y, b.dir);
      const hang = Math.min(b.top * TH - 0.5, b.tier * TH + 4.6);
      items.pushY(
        worldCoord[b.x] + fx * (half + 0.1), hang, worldCoord[b.y] + fz * (half + 0.1),
        rot, 1, 1, 1, hex(0xffffff),
      );
    }
    putInstanced(pool, "banners", R.bannerGeo, R.bannerMat, items, false);
  }

  // ---------------------------------------------------------------- medallions
  // every plaza gets its own sigil + color, but ONE shared material: the
  // per-plaza identity rides in two constant geometry attributes on a tiny
  // cloned disc (58 verts) — no per-plaza pipelines, ever
  for (let mIdx = 0; mIdx < l.medallions.length; mIdx++) {
    const m = l.medallions[mIdx];
    const geo = R.circleGeo.clone();
    const nV = geo.getAttribute("position").count;
    const col = plazaColor(mIdx);
    const sVal = hash2(seed, 510 + mIdx, 11);
    const colArr = new Float32Array(nV * 3);
    const seedArr = new Float32Array(nV);
    for (let i = 0; i < nV; i++) {
      colArr[i * 3] = col.r; colArr[i * 3 + 1] = col.g; colArr[i * 3 + 2] = col.b;
      seedArr[i] = sVal;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
    geo.setAttribute("plazaSeed", new THREE.BufferAttribute(seedArr, 1));
    perBuildGeos.push(geo);
    const mesh = new THREE.Mesh(geo, R.medallionMat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.setScalar(m.r * CELL);
    mesh.position.set(worldCoord[m.x], m.tier * TH + 0.17, worldCoord[m.y]);
    mesh.receiveShadow = true;
    addUnique(mesh);
  }

  // ---------------------------------------------------------------- temple portal
  if (l.door) {
    const fdx = DX[l.doorDir], fdz = DY[l.doorDir];
    const rotF = dirRotY(l.doorDir);
    const mesh = new THREE.Mesh(R.portalGeo, R.portalMat);
    mesh.position.set(
      worldCoord[l.door.x] + fdx * (CELL / 2 - 0.18), l.door.tier * TH + 1.25,
      worldCoord[l.door.y] + fdz * (CELL / 2 - 0.18),
    );
    mesh.rotation.y = rotF;
    addUnique(mesh);
    // glowing rune architrave carved into the lintel above the doorway
    const rune = new THREE.Mesh(R.runeGeo, R.runeMat);
    rune.position.set(
      worldCoord[l.door.x] + fdx * (CELL / 2 + 0.16), l.door.tier * TH + 2.95,
      worldCoord[l.door.y] + fdz * (CELL / 2 + 0.16),
    );
    rune.rotation.y = rotF;
    addUnique(rune);
  }

  // ---------------------------------------------------------------- bridge
  if (l.bridge) {
    const b = l.bridge;
    // span runs along x (axis 0) or z (axis 1) — rotated layouts flip it
    const atW = (b.at - (N - 1) / 2) * CELL;
    const s0 = (b.s0 - (N - 1) / 2) * CELL + CELL * 0.4;
    const s1 = (b.s1 - (N - 1) / 2) * CELL - CELL * 0.4;
    const bX = (s: number, off: number) => (b.axis === 0 ? s : atW + off);
    const bZ = (s: number, off: number) => (b.axis === 0 ? atW + off : s);
    const rotB = b.axis === 0 ? 0 : Math.PI / 2;
    const yTop = b.tier * TH + 0.1;
    const planks = list();
    const nP = 14;
    for (let i = 0; i < nP; i++) {
      const t = (i + 0.5) / nP;
      const s = s0 + (s1 - s0) * t;
      const sag = Math.sin(t * Math.PI) * 0.7;
      const h1 = hash3(seed, 999, i, 7);
      planks.pushY(bX(s, 0), yTop - sag, bZ(s, 0), rotB + (h1 - 0.5) * 0.1, 1, 1.2, 1.45, hex(0x4a3624));
    }
    putInstanced(pool, "ravinePlanks", R.plankGeo, R.woodMat, planks, false);
    // Keep the short internal crossing visually subordinate to the stair/court
    // connection. The former sagging rope pair and four tall posts projected
    // into a U-shaped altar plus a centreline obstruction from the overview,
    // even though they served no navigation or structural purpose. Stone side
    // abutments below already communicate that the deck is anchored.
    // Stone abutments anchoring both ends. Keep the rope-bridge centreline
    // completely clear: the former single 4.2-unit-wide block visibly sealed
    // both landings even though WalkMap marked them traversable.
    for (const [s, sgn] of [[s0, -1], [s1, 1]] as const) {
      setHsl(stoneColor, 0.60, 0.26, 0.40);
      for (const side of [-0.98, 0.98]) {
        blocks.pushY(
          bX(s + sgn * 0.5, side), yTop - 0.35, bZ(s + sgn * 0.5, side),
          rotB, 0.75, 1.15, 0.34, stoneColor,
        );
      }
      warmFlames.pushY(bX(s, 0.8), yTop + 1.55, bZ(s, 0.8), 0, 0.8, 0.85, 0.8, hex(0xffffff));
      flameAnchors.push({ x: bX(s, 0.8), y: yTop + 1.7, z: bZ(s, 0.8) });
    }
  }

  // ---------------------------------------------------------------- beacons
  for (const t of l.towers) {
    if (!t.beacon) continue;
    const mesh = new THREE.Mesh(R.beaconGeo, R.beaconMat);
    mesh.position.set(worldCoord[t.x], t.top * TH + 1.0, worldCoord[t.y]);
    addUnique(mesh);
    flameAnchors.push({ x: worldCoord[t.x], y: t.top * TH + 1.2, z: worldCoord[t.y] });
  }

  // ---------------------------------------------------------------- smoke
  // mist banks: FEW and BROAD. Many small puffs read as scattered crumbs from
  // afar — a handful of wide, flat banks hugging below floor level read as one
  // weather system settling over the whole fortress.
  const smokes: THREE.Sprite[] = [];
  for (let k = 0; k < 8; k++) {
    const s = new THREE.Sprite(R.smokeMat);
    const a = hash2(seed, k, 41) * Math.PI * 2;
    const rad = 16 + hash2(seed, k, 42) * 22;
    if (k < 4 && l.bridge) {
      // mist banks pooling in the ravine, near the bridge (either axis)
      const b = l.bridge;
      const mid = ((b.s0 + b.s1) / 2 - (N - 1) / 2) * CELL;
      const at = (b.at - (N - 1) / 2) * CELL;
      const jx = (hash2(seed, k, 43) - 0.5) * 10, jz = (hash2(seed, k, 45) - 0.5) * 22;
      s.position.set(
        (b.axis === 0 ? mid : at) + jx, -1.5 - hash2(seed, k, 44) * 5,
        (b.axis === 0 ? at : mid) + jz,
      );
    } else {
      s.position.set(Math.cos(a) * rad, -2.5 - hash2(seed, k, 46) * 5, Math.sin(a) * rad);
    }
    const sc = 26 + hash2(seed, k, 47) * 20;
    s.scale.set(sc, sc * 0.38, 1);
    (s.userData as { ph: number }).ph = hash2(seed, k, 48) * Math.PI * 2;
    (s.userData as { bx: number }).bx = s.position.x;
    smokes.push(s);
    addUnique(s);
  }

  // ---------------------------------------------- weathering & clutter pass
  const rubble = list(N * N);
  const crates = list();
  const vines = list(N * N);
  const leaves = list(N * N);
  const creepers = list();
  const bramblesA = list();
  const bramblesB = list();
  const links = list();
  const moss = list(N * N);
  const bloodStains = list(Math.ceil(N * N * 0.04));
  const greenGrime = list(Math.ceil(N * N * 0.08));
  const cols = list();
  const roots = list();
  const decay = Math.min(1, Math.max(0, l.params?.decay ?? 0.5));
  {
    const totemCells = new Set(l.braziers.filter((b) => b.totem).map((b) => b.y * N + b.x));
    for (let y = 1; y < N - 1; y++) {
      for (let x = 1; x < N - 1; x++) {
        const c = gi(x, y);
        // rubble scattered where corridors meet walls — centuries of spall
        if (kind[c] === FLOOR && !l.stairMask[c] && !l.plazaMask[c] && !totemCells.has(c)) {
          const h = hash2(seed, c, 71);
          let nearRuin = false;
          for (let d = 0; d < 4; d++) if (l.ruinMask[gi(x + DX[d], y + DY[d])]) nearRuin = true;
          if (h < (nearRuin ? 0.75 : 0.32 * decay)) {
            const n = 1 + Math.floor(hash2(seed, c, 72) * 3);
            // lean the cluster toward an adjacent wall, if any
            let ox = 0, oz = 0;
            for (let d = 0; d < 4; d++) {
              if (kind[gi(x + DX[d], y + DY[d])] === WALL) { ox = DX[d] * 0.62; oz = DY[d] * 0.62; break; }
            }
            for (let k = 0; k < n; k++) {
              const ha = hash3(seed, c, k, 73), hb = hash3(seed, c, k, 74), hc = hash3(seed, c, k, 75);
              setHsl(stoneColor, 0.08, 0.22, 0.24 + ha * 0.2);
              const sc = 0.8 + hb * 1.2;
              rubble.pushY(
                worldCoord[x] + ox + (ha - 0.5) * 0.9, tier[c] * TH + 0.14 + sc * 0.07, worldCoord[y] + oz + (hb - 0.5) * 0.9,
                hc * 6.28, sc, sc * (0.5 + hc * 0.4), sc, stoneColor,
              );
            }
          }
          // moss creeping out of the shaded corners (top-down readable)
          const hm = hash2(seed, c, 78);
          if (hm < 0.4 * decay) {
            let mx = 0, mz = 0;
            for (let d = 0; d < 4; d++) {
              if (kind[gi(x + DX[d], y + DY[d])] === WALL) { mx = DX[d] * 0.7; mz = DY[d] * 0.7; break; }
            }
            const nP2 = 1 + Math.floor(hash2(seed, c, 79) * 2);
            for (let k = 0; k < nP2; k++) {
              const ha = hash3(seed, c, k, 80), hb = hash3(seed, c, k, 85);
              setHsl(stoneColor, 0.25 + hb * 0.05, 0.35, 0.24 + ha * 0.1);
              const sc = 0.7 + ha * 1.3;
              moss.pushY(
                worldCoord[x] + mx + (ha - 0.5) * 1.0, tier[c] * TH + 0.157 + k * 0.004, worldCoord[y] + mz + (hb - 0.5) * 1.0,
                hb * 6.28, sc, 1, sc * (0.7 + hb * 0.5), stoneColor,
              );
            }
          }
          // Narrative residue, not navigation blockers: sparse dried blood
          // around ruined/quiet corridors and sickly damp smears at wall feet.
          // Hash tags are independent so a seed keeps the same composition
          // across reloads and unrelated generator changes.
          const nearWall = (() => {
            for (let d = 0; d < 4; d++) if (kind[gi(x + DX[d], y + DY[d])] === WALL) return true;
            return false;
          })();
          const bloodChance = 0.012 + (nearRuin ? 0.045 : 0) + (decay > 0.62 ? 0.012 : 0);
          if (hash2(seed, c, 181) < bloodChance) {
            const ha = hash2(seed, c, 182), hb = hash2(seed, c, 183);
            const sc = 0.48 + hash2(seed, c, 184) * 0.92;
            bloodStains.pushY(
              worldCoord[x] + (ha - 0.5) * 0.9,
              tier[c] * TH + 0.169,
              worldCoord[y] + (hb - 0.5) * 0.9,
              hash2(seed, c, 185) * Math.PI * 2,
              sc * (0.72 + hb * 0.72), 1, sc * (0.7 + ha * 0.65),
              hex(0x4d0d0a),
            );
          }
          const grimeChance = (nearWall ? 0.038 : 0.012) + decay * (nearRuin ? 0.085 : 0.035);
          if (hash2(seed, c, 186) < grimeChance) {
            const ha = hash2(seed, c, 187), hb = hash2(seed, c, 188);
            const sc = 0.62 + hash2(seed, c, 189) * 1.15;
            greenGrime.pushY(
              worldCoord[x] + (ha - 0.5) * 1.15,
              tier[c] * TH + 0.166,
              worldCoord[y] + (hb - 0.5) * 1.15,
              hash2(seed, c, 190) * Math.PI * 2,
              sc * (0.65 + ha * 0.8), 1, sc * (0.58 + hb * 0.66),
              hex(0x40531d),
            );
          }
          // crates in quiet dead ends the totems didn't claim
          let deg = 0;
          for (let d = 0; d < 4; d++) if (kind[gi(x + DX[d], y + DY[d])] === FLOOR) deg++;
          if (deg === 1 && !totemCells.has(c) && hash2(seed, c, 76) < 0.4 && !(x === l.entrance.x && y === l.entrance.y)) {
            const ha = hash2(seed, c, 77);
            crates.pushY(worldCoord[x] + (ha - 0.5) * 0.5, tier[c] * TH + 0.51, worldCoord[y] + (ha - 0.5) * 0.4, ha * 1.5, 1, 1, 1, hex(0x4d3a22));
            if (ha < 0.45) crates.pushY(worldCoord[x] + (ha - 0.5) * 0.5 + 0.3, tier[c] * TH + 1.15, worldCoord[y] + (ha - 0.5) * 0.4 - 0.2, ha * 4, 0.72, 0.72, 0.72, hex(0x423120));
          }
        }
        // moss on wall-top walkways too
        if (kind[c] === WALL && hash2(seed, c, 86) < 0.2 * decay) {
          const ha = hash2(seed, c, 87);
          setHsl(stoneColor, 0.26, 0.32, 0.22 + ha * 0.08);
          const sc = 0.6 + ha * 0.9;
          moss.pushY(
            worldCoord[x] + (ha - 0.5) * 0.8, wallTop[c] * TH + 0.03, worldCoord[y] + (0.5 - ha) * 0.8,
            ha * 6.28, sc, 1, sc, stoneColor,
          );
        }
        // brambles (荆棘): thorny tangles sprawling over the castle's skin —
        // dense on the outer ramparts and ravine cliffs, sparse inside
        if (kind[c] === WALL && !l.doorMask[c]) {
          for (let d = 0 as Dir; d < 4; d++) {
            const nx = x + DX[d], ny = y + DY[d];
            const outer = nx < 0 || ny < 0 || nx >= N || ny >= N || kind[gi(nx, ny)] === VOID;
            const innerFloor = !outer && kind[gi(nx, ny)] === FLOOR;
            if (!outer && !innerFloor) continue;
            const hb2 = hash3(seed, c, d, 101);
            const chance = outer ? 0.24 + 0.5 * decay : (wallTop[c] - tier[gi(nx, ny)] >= 3 ? 0.14 * decay : 0);
            if (hb2 > chance) continue;
            const half = wallHalf(x, y, d as Dir);
            const fx = DX[d], fz = DY[d];
            const ha = hash3(seed, c, d, 102), hbv = hash3(seed, c, d, 103);
            const lat = (ha - 0.5) * 1.2;
            // girdle bands: outer ones ride below the rim, inner ones hover
            // low over the corridor floor — never poking past the silhouette
            const baseY = outer
              ? wallTop[c] * TH - 1.5 - hbv * 1.4
              : tier[gi(nx, ny)] * TH + 0.5 + hbv * 0.8;
            const sc = 0.85 + hbv * 0.6;
            setHsl(stoneColor, 0.07 + ha * 0.02, 0.25, 0.16 + ha * 0.08);
            const target = hbv < 0.5 ? bramblesA : bramblesB;
            target.pushY(
              worldCoord[x] + fx * (half + 0.04) + (fz !== 0 ? lat : 0),
              baseY,
              worldCoord[y] + fz * (half + 0.04) + (fx !== 0 ? lat : 0),
              dirRotY(d as Dir), sc * (ha < 0.5 ? 1 : -1), sc * (0.75 + ha * 0.35), sc, stoneColor,
            );
          }
        }
        // creeper patches (爬山虎) climbing the wall faces from the floor
        if (kind[c] === WALL && !l.doorMask[c]) {
          for (let d = 0 as Dir; d < 4; d++) {
            const n = gi(x + DX[d], y + DY[d]);
            if (kind[n] !== FLOOR) continue;
            const hc2 = hash3(seed, c, d, 88);
            if (hc2 > 0.7 * decay) continue;
            const half = wallHalf(x, y, d as Dir);
            const fx = DX[d], fz = DY[d];
            const availH = (wallTop[c] - tier[n]) * TH - 0.4;
            if (availH < 1.2) continue;
            const rot = dirRotY(d as Dir);
            const stack = availH > 4.2 && hash3(seed, c, d, 89) < 0.55 ? 2 : 1;
            for (let k = 0; k < stack; k++) {
              const ha = hash3(seed, c, d * 3 + k, 90), hb = hash3(seed, c, d * 3 + k, 92);
              const lat = (ha - 0.5) * 1.1;
              const sy = Math.min(1.25, (availH / stack) / 2.4) * (0.8 + hb * 0.4);
              const sx2 = (0.85 + ha * 0.6) * (hb < 0.5 ? 1 : -1); // mirror half for variety
              setHsl(stoneColor, 0.24 + hb * 0.06, 0.44, 0.36 + ha * 0.16);
              creepers.pushY(
                worldCoord[x] + fx * (half + 0.05) + (fz !== 0 ? lat : 0),
                tier[n] * TH + 0.15 + k * (availH / stack) * 0.92,
                worldCoord[y] + fz * (half + 0.05) + (fx !== 0 ? lat : 0),
                rot, sx2, sy, 1, stoneColor,
              );
            }
          }
        }
        // vines draping tall wall faces
        if (kind[c] === WALL && !l.doorMask[c]) {
          for (let d = 0 as Dir; d < 4; d++) {
            const n = gi(x + DX[d], y + DY[d]);
            if (kind[n] !== FLOOR || wallTop[c] - tier[n] < 3) continue;
            const h = hash3(seed, c, d, 81);
            if (h > 0.7 * decay) continue;
            const half = wallHalf(x, y, d as Dir);
            const fx = DX[d], fz = DY[d];
            const nStrips = 1 + Math.floor(hash3(seed, c, d, 82) * 2);
            for (let k = 0; k < nStrips; k++) {
              const ha = hash3(seed, c, d * 7 + k, 83), hb = hash3(seed, c, d * 7 + k, 84);
              const lat = (ha - 0.5) * 1.3;
              const px2 = worldCoord[x] + fx * (half + 0.08) + (fz !== 0 ? lat : 0);
              const pz2 = worldCoord[y] + fz * (half + 0.08) + (fx !== 0 ? lat : 0);
              const py2 = wallTop[c] * TH - 0.05 - hb * 0.3;
              const rot = dirRotY(d as Dir);
              const sw = 1.1 + hb * 0.9, sh = 0.75 + ha * 0.8;
              setHsl(stoneColor, 0.26 + hb * 0.06, 0.3, 0.2 + ha * 0.1);
              vines.pushY(px2, py2, pz2, rot, sw * 0.5, sh, 1, stoneColor);
              // the leaf cluster is what actually reads — brighter, bigger
              setHsl(stoneColor, 0.24 + hb * 0.07, 0.45, 0.42 + ha * 0.16);
              leaves.pushY(px2, py2, pz2, rot, sw, sh, sw, stoneColor);
            }
          }
        }
      }
    }
    // ring of ancient columns around each medallion plaza — most broken, a few
    // still crowned with their capital
    const _euler = new THREE.Euler();
    const _quat = new THREE.Quaternion();
    const _pos = new THREE.Vector3();
    const _scl = new THREE.Vector3();
    for (let mIdx = 0; mIdx < l.medallions.length; mIdx++) {
      const m = l.medallions[mIdx];
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + mIdx * 0.4;
        const px2 = worldCoord[m.x] + Math.cos(a) * (m.r + 0.55) * CELL;
        const pz2 = worldCoord[m.y] + Math.sin(a) * (m.r + 0.55) * CELL * 0.98;
        const h = hash3(seed, mIdx * 31, k, 95);
        if (h > 0.8) continue; // a few are gone entirely
        const py2 = m.tier * TH + 0.12;
        setHsl(stoneColor, 0.09, 0.28, 0.4 + h * 0.12);
        if (h < 0.35) {
          // intact column with capital
          const ch = 2.4 + h * 1.2;
          cols.pushY(px2, py2, pz2, h * 6.28, 1, ch, 1, stoneColor);
          blocks.pushY(px2, py2 + ch + 0.12, pz2, h * 3, 0.26, 0.22, 0.26, stoneColor);
        } else {
          // broken stump, slightly tilted, rubble at its foot
          const ch = 0.5 + h * 1.6;
          _quat.setFromEuler(_euler.set((h - 0.5) * 0.1, h * 6.28, (h - 0.6) * 0.1));
          _pos.set(px2, py2, pz2);
          cols.pushMatrix(_mat4.compose(_pos, _quat, _scl.set(1, ch, 1)).elements, stoneColor);
          const hr = hash3(seed, mIdx * 31, k, 96);
          setHsl(stoneColor, 0.08, 0.2, 0.26 + hr * 0.1);
          rubble.pushY(px2 + (hr - 0.5), py2 + 0.12, pz2 + (0.5 - hr), hr * 6, 0.7 + hr, 0.5, 0.7 + hr, stoneColor);
        }
      }
    }
    // great chains hanging from the rim into the abyss
    {
      const rims: Array<{ x: number; y: number; d: Dir; h: number }> = [];
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const c = gi(x, y);
          if (kind[c] !== WALL) continue;
          for (let d = 0 as Dir; d < 4; d++) {
            const nx = x + DX[d], ny = y + DY[d];
            const isVoid = nx < 0 || ny < 0 || nx >= N || ny >= N || kind[gi(nx, ny)] === VOID;
            if (isVoid) { rims.push({ x, y, d: d as Dir, h: hash2(seed, c, 91) }); break; }
          }
        }
      }
      rims.sort((a, b) => a.h - b.h);
      const chosen: typeof rims = [];
      for (const r of rims) {
        if (chosen.length >= 5) break;
        if (chosen.some((q) => Math.max(Math.abs(q.x - r.x), Math.abs(q.y - r.y)) < 8)) continue;
        chosen.push(r);
      }
      for (const r of chosen) {
        const fx = DX[r.d], fz = DY[r.d];
        const topY = wallTop[gi(r.x, r.y)] * TH - 0.4;
        const endY = ABYSS * TH + 4;
        const nL = 16;
        for (let i = 0; i < nL; i++) {
          const t = (i + 0.5) / nL;
          const out = 0.6 + t * t * 1.8; // swings outward as it falls
          links.pushY(
            worldCoord[r.x] + fx * (CELL / 2 + out), topY + (endY - topY) * t, worldCoord[r.y] + fz * (CELL / 2 + out),
            dirRotY(r.d) + (i % 2) * Math.PI / 2, 1.15, 1.15, 1.15, hex(0x191a20),
          );
        }
      }
    }
  }

  // ------------------------------------------------ narrative district pass
  // The macro planner gives every 2–5 block precinct a role. Dress a few
  // quiet wall niches in each block with role-specific evidence: storage in
  // the gate, tablets in the archive, tomb ledges in the ossuary, ember
  // altars in the forge, votives on the pilgrim route, invasive growth in the
  // wild ruin and blue ward-lights in the sanctum. All props stay wall-hugging
  // with a clear centerline, so visual storytelling never becomes an
  // unregistered navigation blocker.
  const storyRole = l.params.narrativeRole;
  if (storyRole) {
    type StorySite = { x: number; y: number; c: number; wallDir: Dir; score: number };
    const candidates: StorySite[] = [];
    for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) {
      const c = gi(x, y);
      if (kind[c] !== FLOOR || l.stairMask[c] || l.templeMask[c] || l.plazaMask[c]) continue;
      if (support[c] !== tier[c]) continue;
      if (Math.max(Math.abs(x - l.entrance.x), Math.abs(y - l.entrance.y)) < 5) continue;
      if (l.verticalAnchors.some((a) => Math.max(Math.abs(a.x - x), Math.abs(a.y - y)) < 4)) continue;
      if (l.gates.some((g) => Math.max(Math.abs(g.x - x), Math.abs(g.y - y)) < 4)) continue;
      let wallDir = -1, degree = 0;
      for (let d = 0 as Dir; d < 4; d++) {
        const nk = kind[gi(x + DX[d], y + DY[d])];
        if (nk === FLOOR) degree++;
        else if (nk === WALL && wallDir < 0) wallDir = d;
      }
      if (wallDir < 0 || degree > 2) continue;
      candidates.push({ x, y, c, wallDir: wallDir as Dir, score: hash3(seed ^ 0x53544f52, c, l.params.districtId ?? 0, 1) });
    }
    candidates.sort((a, b) => a.score - b.score);
    const chosen: StorySite[] = [];
    const wanted = storyRole === "sanctum" || storyRole === "forge" ? 4 : 3;
    for (const site of candidates) {
      if (chosen.length >= wanted) break;
      if (chosen.some((other) => Math.max(Math.abs(other.x - site.x), Math.abs(other.y - site.y)) < 6)) continue;
      chosen.push(site);
    }
    for (let i = 0; i < chosen.length; i++) {
      const site = chosen[i];
      const fx = DX[site.wallDir], fz = DY[site.wallDir];
      const px = worldCoord[site.x] + fx * 0.7;
      const pz = worldCoord[site.y] + fz * 0.7;
      const py = tier[site.c] * TH;
      const yaw = dirRotY(site.wallDir);
      const h = hash3(seed ^ 0x4c4f5245, site.c, i, 2);
      if (storyRole === "threshold") {
        crates.pushY(px, py + 0.42, pz, yaw + h * 0.25, 0.82, 0.82, 0.82, hex(0x4b3420));
        setHsl(stoneColor, 0.08, 0.18, 0.26 + h * 0.08);
        rubble.pushY(px - fz * 0.42, py + 0.12, pz + fx * 0.42, h * 6.28, 0.8, 0.55, 0.8, stoneColor);
      } else if (storyRole === "archive") {
        // Upright tablet racks, kept shallow against the wall.
        for (const side of [-0.28, 0.28]) {
          setHsl(stoneColor, 0.105, 0.25, 0.38 + h * 0.1);
          blocks.pushY(px - fz * side, py + 0.78, pz + fx * side, yaw, 0.22, 1.55, 0.62, stoneColor);
        }
        crates.pushY(px - fz * 0.68, py + 0.34, pz + fx * 0.68, yaw, 0.62, 0.62, 0.62, hex(0x39291d));
      } else if (storyRole === "ossuary") {
        // Wall tomb / sarcophagus niche, never across the corridor center.
        setHsl(stoneColor, 0.085, 0.12, 0.38 + h * 0.08);
        blocks.pushY(px, py + 0.34, pz, yaw, 0.56, 0.52, 0.3, stoneColor);
        cols.pushY(px + fz * 0.54, py + 0.04, pz - fx * 0.54, yaw, 0.72, 0.62 + h * 0.4, 0.72, stoneColor);
        rubble.pushY(px - fz * 0.48, py + 0.1, pz + fx * 0.48, h * 5, 0.62, 0.42, 0.62, stoneColor);
      } else if (storyRole === "forge") {
        setHsl(stoneColor, 0.055, 0.28, 0.25 + h * 0.07);
        blocks.pushY(px, py + 0.38, pz, yaw, 0.48, 0.72, 0.42, stoneColor);
        blocks.pushY(px - fx * 0.08, py + 0.79, pz - fz * 0.08, yaw, 0.68, 0.18, 0.34, stoneColor);
        redFlames.pushY(px, py + 1.08, pz, 0, 0.85, 0.95, 0.85, hex(0xffffff));
        flameAnchors.push({ x: px, y: py + 1.35, z: pz });
      } else if (storyRole === "pilgrim") {
        setHsl(stoneColor, 0.1, 0.28, 0.42 + h * 0.1);
        cols.pushY(px, py + 0.04, pz, yaw, 0.82, 1.2 + h * 0.7, 0.82, stoneColor);
        warmFlames.pushY(px - fz * 0.42, py + 0.78, pz + fx * 0.42, 0, 0.7, 0.8, 0.7, hex(0xffffff));
        flameAnchors.push({ x: px - fz * 0.42, y: py + 1.05, z: pz + fx * 0.42 });
      } else if (storyRole === "overgrowth") {
        setHsl(stoneColor, 0.27 + h * 0.04, 0.42, 0.32 + h * 0.1);
        leaves.pushY(px, py + 0.82, pz, yaw, 1.25, 1.15, 1.25, stoneColor);
        bramblesA.pushY(px - fz * 0.35, py + 0.34, pz + fx * 0.35, yaw, 1.05, 0.82, 1.05, hex(0x3c3825));
        moss.pushY(px - fx * 0.5, py + 0.16, pz - fz * 0.5, h * 6.28, 1.2, 1, 0.9, stoneColor);
      } else {
        // Sanctum wards: paired blue lights beside intact columns.
        setHsl(stoneColor, 0.105, 0.32, 0.5 + h * 0.08);
        cols.pushY(px, py + 0.04, pz, yaw, 0.9, 2.0 + h * 0.7, 0.9, stoneColor);
        blueFlames.pushY(px - fz * 0.44, py + 0.92, pz + fx * 0.44, 0, 0.8, 0.95, 0.8, hex(0xffffff));
        flameAnchors.push({ x: px - fz * 0.44, y: py + 1.2, z: pz + fx * 0.44 });
      }
    }
  }

  // underside rock keel: hides the flat bottoms of the abyss columns. SHALLOW —
  // a deep spike reads as a stalactite stabbing at whatever drifts below.
  // rootScale 0 skips it entirely — blocks with another block directly
  // beneath must NOT dangle a rock cone into their neighbor's sky.
  if (rootScale > 0) {
    const halfW = (N * CELL) / 2;
    const depth = (9 + halfW * 0.28) * rootScale;
    const plug = new THREE.Mesh(R.plugGeo, R.plugMat);
    plug.scale.set(halfW * 0.86, depth, halfW * 0.86);
    plug.position.y = ABYSS * TH + 1.5 - depth / 2;
    addUnique(plug);
  }

  // hanging roots: gnarled strands trailing from the underside rim — the
  // fortress reads as something ANCIENT the earth still grips
  {
    const rim = ABYSS * TH + 2.4;
    const nR = 10 + ((hash2(seed, 77, 1) * 8) | 0);
    const _p = new THREE.Vector3(), _s = new THREE.Vector3();
    const _q = new THREE.Quaternion(), _e = new THREE.Euler();
    for (let k = 0; k < nR; k++) {
      const side = (hash2(seed, k, 78) * 4) | 0;
      const along = (hash2(seed, k, 79) - 0.5) * (N - 2) * CELL;
      const fx = [1, -1, 0, 0][side], fz = [0, 0, 1, -1][side];
      const px = fx !== 0 ? fx * ((N * CELL) / 2 - 0.2) : along;
      const pz = fz !== 0 ? fz * ((N * CELL) / 2 - 0.2) : along;
      const len = 3.5 + hash2(seed, k, 80) * 7.5;
      const lean = 0.08 + hash2(seed, k, 81) * 0.25; // drift outward as they fall
      setHsl(stoneColor, 0.24 + hash2(seed, k, 82) * 0.09, 0.24, 0.1 + hash2(seed, k, 83) * 0.08);
      _e.set(fz * lean, hash2(seed, k, 84) * Math.PI * 2, -fx * lean);
      const w = 0.9 + hash2(seed, k, 85);
      _mat4.compose(_p.set(px, rim, pz), _q.setFromEuler(_e), _s.set(w, len, w));
      roots.pushMatrix(_mat4.elements, stoneColor);
    }
  }

  // ------------------------------------------------------- instanced meshes
  // created last so every section above could still contribute masonry/flames
  putInstanced(pool, "blocks", R.blockGeo, R.stoneMat, blocks);
  putInstanced(pool, "blockMids", DEBUG_CLOSED_COURSES ? R.blockGeo : R.blockMiddleGeo, R.stoneMat, blockMids);
  putInstanced(pool, "blockTops", DEBUG_CLOSED_COURSES ? R.blockGeo : R.blockTopGeo, R.stoneMat, blockTops);
  putInstanced(pool, "blockBases", DEBUG_CLOSED_COURSES ? R.blockGeo : R.blockBaseGeo, R.stoneMat, blockBases);
  (pool.meshes.get("blocks")!.userData as {
    masonryCull?: { potential: number; interior: number; authoredGaps: number; emitted: number };
  }).masonryCull = {
    potential: masonryPotential,
    interior: masonryInteriorCulled,
    authoredGaps: masonryDoorCulled,
    emitted: masonryPotential - masonryInteriorCulled - masonryDoorCulled,
  };
  putInstanced(pool, "blocksLo", R.blockGeoLo, R.stoneLoMat, blocksLow);
  // Middle LOD keeps the exact authored transform/color of every visible
  // course. Only bevel topology and the expensive near material disappear;
  // the vertically collapsed blocksLo representation is reserved for far.
  putInstancedTwin(pool, "blocksMidLo", "blocks", R.blockGeoLo, R.stoneLoMat, true);
  putInstancedTwin(pool, "blockMidsLo", "blockMids", R.blockGeoLo, R.stoneLoMat, true);
  putInstancedTwin(pool, "blockTopsLo", "blockTops", R.blockGeoLo, R.stoneLoMat, true);
  (pool.meshes.get("blocks")!.userData as { masonry?: MasonryStructureData }).masonry = {
    byInstance: breachByInstance,
  };
  (pool.meshes.get("blockMids")!.userData as { masonry?: MasonryStructureData }).masonry = {
    byInstance: breachByMiddleInstance,
  };
  (pool.meshes.get("blockTops")!.userData as { masonry?: MasonryStructureData }).masonry = {
    byInstance: breachByTopInstance,
  };
  putInstancedTwin(pool, "blocksFade", "blocks", R.blockGeo, R.stoneFadeMat, false);
  putInstancedTwin(pool, "blocksMidLoFade", "blocksMidLo", R.blockGeoLo, R.stoneLoFadeMat, false);
  putInstancedTwin(pool, "blocksLoFade", "blocksLo", R.blockGeoLo, R.stoneLoFadeMat, false);
  // Closed geometry for the fade twins, not the open shells the opaque pools
  // use. The open meshes drop their top and bottom caps to save 46 of 68
  // triangles, which is sound while a column is opaque and fully stacked. The
  // reveal window makes masonry 13% opaque with alphaHash and DoubleSide, so
  // you see through the front face into a hollow course with no lid and no
  // floor — the horizontal see-through banding. Only instances inside the
  // aperture draw these twins, so the extra triangles are a rounding error.
  putInstancedTwin(pool, "blockMidsFade", "blockMids", R.blockGeo, R.stoneFadeMat, false);
  putInstancedTwin(pool, "blockMidsLoFade", "blockMidsLo", R.blockGeoLo, R.stoneLoFadeMat, false);
  putInstancedTwin(pool, "blockTopsFade", "blockTops", R.blockGeo, R.stoneFadeMat, false);
  putInstancedTwin(pool, "blockBasesFade", "blockBases", R.blockGeo, R.stoneFadeMat, false);
  putInstancedTwin(pool, "blockTopsLoFade", "blockTopsLo", R.blockGeoLo, R.stoneLoFadeMat, false);
  pool.meshes.get("blocksFade")!.count = 0;
  pool.meshes.get("blocksMidLoFade")!.count = 0;
  pool.meshes.get("blocksLoFade")!.count = 0;
  pool.meshes.get("blockMidsFade")!.count = 0;
  pool.meshes.get("blockMidsLoFade")!.count = 0;
  pool.meshes.get("blockTopsFade")!.count = 0;
  pool.meshes.get("blockTopsLoFade")!.count = 0;
  putInstanced(pool, "merlons", R.merlonGeo, R.stoneMat, merlons);
  putInstanced(pool, "architecturalBays", R.architecturalBayGeo, R.stoneMat, architecturalBays, false);
  putInstanced(pool, "towerRoofs", R.towerRoofGeo, R.stoneMat, towerRoofs, false);
  putInstanced(pool, "tiles", R.tileGeo, R.stoneMat, tiles, true);
  putInstanced(pool, "tilesLo", R.tileGeoLo, R.stoneLoMat, tilesLow, true);
  putInstancedTwin(pool, "tilesMidLo", "tiles", R.tileGeoLo, R.stoneLoMat, true);
  // Every rebuilt slot starts in the cheap state. The main loop promotes at
  // most one nearby island per frame after the background high-detail compile.
  const blockHi = pool.meshes.get("blocks"), blockLo = pool.meshes.get("blocksLo");
  const blockMidHi = pool.meshes.get("blockMids");
  const blockTopHi = pool.meshes.get("blockTops");
  const tileHi = pool.meshes.get("tiles"), tileLo = pool.meshes.get("tilesLo");
  if (blockHi) { blockHi.visible = false; blockHi.count = 0; }
  if (tileHi) { tileHi.visible = false; tileHi.count = 0; }
  if (blockLo) {
    blockLo.count = ((blockLo.userData as { n?: number }).n ?? 0);
    blockLo.visible = blockLo.count > 0;
  }
  if (blockMidHi) { blockMidHi.visible = false; blockMidHi.count = 0; }
  if (blockTopHi) { blockTopHi.visible = false; blockTopHi.count = 0; }
  if (tileLo) {
    tileLo.count = ((tileLo.userData as { n?: number }).n ?? 0);
    tileLo.visible = tileLo.count > 0;
  }
  putInstanced(pool, "redTiles", R.tileGeo, R.redMat, redTiles, true);
  putInstanced(pool, "steps", R.stepGeo, R.stoneMat, steps);
  putInstancedTwin(pool, "stepsLo", "steps", R.stepGeo, R.stoneLoMat, true);
  pool.meshes.get("steps")!.count = 0;
  pool.meshes.get("steps")!.visible = false;
  putInstanced(pool, "cheeks", R.cheekGeo, R.stoneMat, cheeks, false);
  putInstanced(pool, "flamesW", R.flameGeo, R.flameWarm, warmFlames, false);
  putInstanced(pool, "flamesB", R.flameGeo, R.flameBlue, blueFlames, false);
  putInstanced(pool, "flamesR", R.flameGeo, R.flameRed, redFlames, false);
  putInstanced(pool, "flamesP", R.flameGeo, R.flameNeutral, plazaFlames, false);
  putInstanced(pool, "rubble", R.rubbleGeo, R.stoneMat, rubble, false);
  putInstanced(pool, "crates", R.crateGeo, R.woodMat, crates, false);
  putInstanced(pool, "vines", R.vineGeo, R.vineMat, vines, false);
  putInstanced(pool, "leaves", R.leafGeo, R.leafMat, leaves, false);
  putInstanced(pool, "creepers", R.creeperGeo, R.leafMat, creepers, false);
  putInstanced(pool, "bramblesA", R.brambleGeoA, R.brambleMat, bramblesA, false);
  putInstanced(pool, "bramblesB", R.brambleGeoB, R.brambleMat, bramblesB, false);
  putInstanced(pool, "links", R.linkGeo, R.woodMat, links, false);
  putInstanced(pool, "moss", R.mossGeo, R.mossMat, moss, false);
  putInstancedCombined(pool, "stains", R.stainGeo, R.stainMat, [bloodStains, greenGrime], false);
  putInstanced(pool, "cols", R.colGeo, R.stoneMat, cols, true);
  putInstancedTwin(pool, "colsLo", "cols", R.colGeo, R.stoneLoMat, true);
  putInstancedTwin(pool, "colsFade", "cols", R.colGeo, R.stoneFadeMat, false);
  putInstancedTwin(pool, "colsLoFade", "colsLo", R.colGeo, R.stoneLoFadeMat, false);
  pool.meshes.get("cols")!.count = 0;
  pool.meshes.get("cols")!.visible = false;
  pool.meshes.get("colsFade")!.count = 0;
  pool.meshes.get("colsFade")!.visible = false;
  pool.meshes.get("colsLoFade")!.count = 0;
  pool.meshes.get("colsLoFade")!.visible = false;
  putInstanced(pool, "roots", R.rootGeo, R.brambleMat, roots, false);
  // smoke wisps rising from every flame
  {
    const wisps = list();
    for (const a of flameAnchors) {
      const h = hash2(seed, Math.round(a.x * 7 + a.z * 13), 97);
      wisps.pushY(a.x, a.y + 0.15, a.z, h * 6.28, 0.8 + h * 0.5, 0.8 + h * 0.6, 0.8 + h * 0.5, hex(0xffffff));
    }
    putInstanced(pool, "wisps", R.wispGeo, R.wispMat, wisps, false);
  }
  // drifting embers: a few near every flame + strays wandering the corridors
  {
    const embers = list();
    for (const a of flameAnchors) {
      const h = hash2(seed, Math.round(a.x * 11 + a.z * 5), 98);
      const n = 2 + Math.floor(h * 2);
      for (let k = 0; k < n; k++) {
        const hk = hash3(seed, Math.round(a.x * 3), k, 99);
        embers.pushY(a.x + (hk - 0.5) * 1.4, a.y - 0.4, a.z + (h - 0.5) * 1.4, 0, 0.6 + hk, 0.6 + hk, 0.6 + hk, hex(0xffffff));
      }
    }
    for (let k = 0; k < 40; k++) {
      const hx = hash2(seed, k, 104), hz = hash2(seed, k, 105);
      const gx2 = 1 + Math.floor(hx * (N - 2)), gy2 = 1 + Math.floor(hz * (N - 2));
      const c2 = gi(gx2, gy2);
      if (kind[c2] !== FLOOR) continue;
      embers.pushY(worldCoord[gx2], tier[c2] * TH + 0.6, worldCoord[gy2], 0, 0.5 + hx * 0.7, 0.5 + hx * 0.7, 0.5 + hx * 0.7, hex(0xffffff));
    }
    putInstanced(pool, "embers", R.emberGeo, R.emberMat, embers, false);
  }
  // landmark beams: the portal breathes blue into the night, the beacon gold
  if (l.door) {
    const beam = new THREE.Mesh(R.beamGeo, R.beamMatBlue);
    beam.position.set(worldCoord[l.door.x], l.door.tier * TH + 2.2, worldCoord[l.door.y]);
    addUnique(beam);
  }
  for (const t of l.towers) {
    if (!t.beacon) continue;
    const beam = new THREE.Mesh(R.beamGeo, R.beamMatWarm);
    beam.scale.set(0.55, 0.8, 0.55);
    beam.position.set(worldCoord[t.x], t.top * TH + 0.8, worldCoord[t.y]);
    addUnique(beam);
  }

  // ---------------------------------------------------------------- lights
  // collected as SPECS only — actual PointLights live in the orchestrator's
  // fixed-size pool so the scene's light count (and thus every compiled
  // pipeline) never changes across regenerations
  const lights: LightSpec[] = [];
  {
    const chosen: Array<{ x: number; y: number; z: number }> = [];
    if (flameAnchors.length > 0) {
      // farthest-point sampling: maximal coverage from a tiny light budget
      let first = flameAnchors[0];
      for (const a of flameAnchors) if (a.x * a.x + a.z * a.z < first.x * first.x + first.z * first.z) first = a;
      chosen.push(first);
      const poolSize = l.N >= 25 ? 9 : 5; // satellites get a smaller light budget
      while (chosen.length < Math.min(poolSize, flameAnchors.length)) {
        let best = flameAnchors[0], bestD = -1;
        for (const a of flameAnchors) {
          let dMin = Infinity;
          for (const c2 of chosen) {
            const dx = a.x - c2.x, dz = a.z - c2.z;
            dMin = Math.min(dMin, dx * dx + dz * dz);
          }
          if (dMin > bestD) { bestD = dMin; best = a; }
        }
        if (bestD <= 0) break;
        chosen.push(best);
      }
    }
    let li = 0;
    for (const c2 of chosen) {
      lights.push({ x: c2.x, y: c2.y + 0.2, z: c2.z, color: 0xff9340, base: 66, dist: 20, ph: hash2(seed, li++, 61) * Math.PI * 2 });
    }
    if (l.door) {
      lights.push({ x: worldCoord[l.door.x], y: l.door.tier * TH + 1.6, z: worldCoord[l.door.y] + 1.6, color: 0x3e7bff, base: 26, dist: 16, ph: 1.1 });
    }
    for (const b of l.braziers) {
      if (b.kind !== "red") continue;
      lights.push({ x: worldCoord[b.x], y: b.tier * TH + 1.4, z: worldCoord[b.y], color: 0xff2c10, base: 34, dist: 13, ph: 4.2 });
    }
  }

  // ---------------------------------------------------------------- handle
  // Reused pools can retain the previous camera's tier. Finish every rebuild
  // in one unambiguous far state after all three-tier twins exist.
  setSlotLodLevel(slot, 0);
  const rise = makeRise(group, riseDelay);
  return {
    group,
    lights,
    tick(t: number) {
      rise(t);
      for (const s of smokes) {
        const ud = s.userData as { ph: number; bx: number };
        s.position.x = ud.bx + Math.sin(t * 0.07 + ud.ph) * 3.2;
      }
    },
    dispose() { /* slots persist — pruneSlots() hides unused ones */ },
  };
}
