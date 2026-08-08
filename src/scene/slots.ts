// Per-slot render-object pools. three's WebGPU renderer builds a node graph
// PER RENDER OBJECT on first sight (~7ms × ~35 meshes × passes ≈ 0.5s per
// island) — render objects are created once per slot; re-forges just rewrite
// instance buffers. This is also the streaming foundation: a slot can be
// refilled with any block as the camera roams.

import * as THREE from "three/webgpu";
import { InstList } from "./instances";
import { getKit } from "./kit";

export interface SlotPool {
  slot: number;
  group: THREE.Group;
  meshes: Map<string, THREE.InstancedMesh>;
  perBuild: THREE.Object3D[];
  perBuildGeos: THREE.BufferGeometry[];
  detailVisible: boolean;
  lodLevel: LodLevel;
}

export type LodLevel = 0 | 1 | 2;

const slotPools = new Map<number, SlotPool>();

/** Active high-detail masonry sources. Their low/faded LOD twins share the
 * same matrix buffer, so changing one source instance updates every visual
 * representation without risking divergent instance counts or stale WebGPU
 * bindings. This intentionally excludes floors, stairs and columns: a blast
 * can remove architecture without silently invalidating the walk surface. */
export function masonryMeshes(): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  for (const p of slotPools.values()) {
    if (!p.group.visible) continue;
    for (const key of ["blocks", "blockMids", "blockTops"]) {
      const mesh = p.meshes.get(key);
      if (mesh && ((mesh.userData as { n?: number }).n ?? 0) > 0) out.push(mesh);
    }
  }
  return out;
}

export function getSlot(slot: number, scene?: THREE.Object3D): SlotPool {
  let p = slotPools.get(slot);
  if (!p) {
    p = {
      slot, group: new THREE.Group(), meshes: new Map(), perBuild: [], perBuildGeos: [],
      detailVisible: true, lodLevel: 2,
    };
    (p.group.userData as { slot?: number }).slot = slot;
    p.group.name = `slot-${slot}`;
    slotPools.set(slot, p);
  }
  if (scene && !p.group.parent) scene.add(p.group);
  // A slot id can change semantic role between shuffles (for example 1003 can
  // be support piers in one spatial plan and a bridge in the next). Reset the
  // ENTIRE logical pool before the new builder writes its keys. Previously a
  // bridge rewrote `linkStones` but left the old pier's `blocksLo` populated,
  // which is the persistent floating-column residue seen after New Dungeon.
  for (const mesh of p.meshes.values()) {
    mesh.count = 0;
    mesh.visible = false;
    (mesh.userData as { n?: number }).n = 0;
  }
  p.group.position.set(0, 0, 0);
  p.group.rotation.set(0, 0, 0);
  p.group.scale.set(1, 1, 1);
  // clear the previous build's unique objects; pooled meshes stay alive
  for (const o of p.perBuild) o.removeFromParent();
  p.perBuild = [];
  for (const g of p.perBuildGeos) g.dispose();
  p.perBuildGeos = [];
  p.group.visible = true;
  return p;
}

function fillInstanced(mesh: THREE.InstancedMesh, list: InstList): void {
  (mesh.instanceMatrix.array as Float32Array).set(list.mats.subarray(0, list.count * 16));
  mesh.instanceMatrix.needsUpdate = true;
  if (!mesh.instanceColor) {
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(mesh.instanceMatrix.count * 3), 3,
    );
  }
  (mesh.instanceColor.array as Float32Array).set(list.cols.subarray(0, list.count * 3));
  mesh.instanceColor.needsUpdate = true;
  mesh.count = list.count;
  // empty lists happen constantly (most islands have no red chamber, no blue
  // flames, no crates…) — an empty-but-visible mesh still costs a render
  // object every frame, so hide it and let setSlotDetail respect that
  (mesh.userData as { n: number }).n = list.count;
  mesh.visible = list.count > 0;
  // manual bounds from the matrices' translation columns — computeBoundingSphere
  // decomposes every instance matrix and costs 100ms+ on big islands
  if (list.count > 0) {
    const dx = list.maxX - list.minX, dy = list.maxY - list.minY, dz = list.maxZ - list.minZ;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2 + 4; // pad for geometry size/scale
    const sphere = mesh.boundingSphere ?? new THREE.Sphere();
    sphere.center.set(
      (list.minX + list.maxX) / 2,
      (list.minY + list.maxY) / 2,
      (list.minZ + list.maxZ) / 2,
    );
    sphere.radius = r;
    mesh.boundingSphere = sphere;
  }
  mesh.frustumCulled = true;
}

export function putInstanced(
  pool: SlotPool, key: string,
  geom: THREE.BufferGeometry, mat: THREE.Material, list: InstList, shadows = true,
): void {
  let mesh = pool.meshes.get(key);
  if (mesh && (mesh.instanceMatrix.count < list.count || mesh.geometry !== geom || mesh.material !== mat)) {
    pool.group.remove(mesh);
    mesh.dispose();
    mesh = undefined;
  }
  if (!mesh) {
    const capacity = Math.max(256, Math.ceil(list.count * 1.6));
    mesh = new THREE.InstancedMesh(geom, mat, capacity);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    pool.meshes.set(key, mesh);
    pool.group.add(mesh);
  }
  mesh.name = key;
  fillInstanced(mesh, list);
  if (decorSuppressed && (DETAIL_KEYS.includes(key) || DECOR_EXTRA.includes(key))) mesh.visible = false;
}

/** One render object fed by multiple CPU instance lists. This is the low-LOD
 * counterpart of topology-split high masonry: write cap and middle segments
 * directly into the shared GPU attributes without first copying them into a
 * second multi-megabyte InstList. Returns each segment's instance offset. */
export function putInstancedCombined(
  pool: SlotPool, key: string,
  geom: THREE.BufferGeometry, mat: THREE.Material, lists: readonly InstList[], shadows = true,
): number[] {
  const count = lists.reduce((sum, list) => sum + list.count, 0);
  let mesh = pool.meshes.get(key);
  if (mesh && (mesh.instanceMatrix.count < count || mesh.geometry !== geom || mesh.material !== mat)) {
    pool.group.remove(mesh);
    mesh.dispose();
    mesh = undefined;
  }
  if (!mesh) {
    const capacity = Math.max(256, Math.ceil(count * 1.6));
    mesh = new THREE.InstancedMesh(geom, mat, capacity);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    pool.meshes.set(key, mesh);
    pool.group.add(mesh);
  }
  mesh.name = key;
  if (!mesh.instanceColor) {
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(mesh.instanceMatrix.count * 3), 3,
    );
  }
  const matrix = mesh.instanceMatrix.array as Float32Array;
  const colors = mesh.instanceColor.array as Float32Array;
  const offsets: number[] = [];
  let offset = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const list of lists) {
    offsets.push(offset);
    matrix.set(list.mats.subarray(0, list.count * 16), offset * 16);
    colors.set(list.cols.subarray(0, list.count * 3), offset * 3);
    offset += list.count;
    if (list.count > 0) {
      minX = Math.min(minX, list.minX); minY = Math.min(minY, list.minY); minZ = Math.min(minZ, list.minZ);
      maxX = Math.max(maxX, list.maxX); maxY = Math.max(maxY, list.maxY); maxZ = Math.max(maxZ, list.maxZ);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  mesh.count = count;
  mesh.visible = count > 0;
  (mesh.userData as { n: number }).n = count;
  if (count > 0) {
    const sphere = mesh.boundingSphere ?? new THREE.Sphere();
    sphere.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
    sphere.radius = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2 + 4;
    mesh.boundingSphere = sphere;
  }
  mesh.frustumCulled = true;
  return offsets;
}

/** A geometry-only LOD twin shares its source's instance matrix/color buffers.
 * Both render objects stay stable and compile once; toggling LOD then changes
 * visibility only, with no geometry mutation and no duplicate buffer upload. */
export function putInstancedTwin(
  pool: SlotPool, key: string, sourceKey: string,
  geom: THREE.BufferGeometry, mat: THREE.Material, shadows = true,
): void {
  const source = pool.meshes.get(sourceKey);
  if (!source) return;
  let mesh = pool.meshes.get(key);
  // A source mesh is replaced whenever a later forge outgrows its instance
  // capacity. Merely assigning the new attributes to an EXISTING twin is not
  // enough for WebGPURenderer: its cached render object remains bound to the
  // old GPU vertex buffers. The result is exactly `count=352` reading a stale
  // 327-item instanceColor buffer. Recreate the twin whenever either shared
  // attribute identity changes so WebGPU builds fresh bindings before draw.
  const sourceBuffersChanged = mesh !== undefined && (
    mesh.instanceMatrix !== source.instanceMatrix || mesh.instanceColor !== source.instanceColor
  );
  if (mesh && (mesh.geometry !== geom || mesh.material !== mat || sourceBuffersChanged)) {
    pool.group.remove(mesh);
    mesh.dispose();
    mesh = undefined;
  }
  if (!mesh) {
    mesh = new THREE.InstancedMesh(geom, mat, source.instanceMatrix.count);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    pool.meshes.set(key, mesh);
    pool.group.add(mesh);
  }
  mesh.name = key;
  mesh.instanceMatrix = source.instanceMatrix;
  mesh.instanceColor = source.instanceColor;
  mesh.count = source.count;
  (mesh.userData as { n: number }).n = source.count;
  mesh.boundingSphere = source.boundingSphere;
  mesh.frustumCulled = source.frustumCulled;
}

/** End of the two-wave first paint. Reveal only a small number of render
 * objects per call: WebGPU's first REAL post-process draw still performs
 * render-object setup that compileAsync cannot fully reproduce. Revealing the
 * entire dungeon in one frame measured as a 4.64 s main-thread wall; three
 * objects per frame turn the same work into bounded, progressive detail. */
let decorRevealQueue: THREE.Object3D[] | null = null;
let decorRevealCursor = 0;
export function revealDecor(maxObjects = Infinity): boolean {
  if (!decorSuppressed && decorRevealQueue === null) return true;
  if (decorRevealQueue === null) {
    decorSuppressed = false;
    decorRevealQueue = [];
    decorRevealCursor = 0;
    for (const p of slotPools.values()) {
      for (const k of [...DETAIL_KEYS, ...DECOR_EXTRA]) {
        const m = p.meshes.get(k);
        if (m && ((m.userData as { n?: number }).n ?? 0) > 0) decorRevealQueue.push(m);
      }
      for (const o of p.perBuild) decorRevealQueue.push(o);
    }
  }
  const end = Math.min(decorRevealQueue.length, decorRevealCursor + Math.max(1, maxObjects));
  while (decorRevealCursor < end) decorRevealQueue[decorRevealCursor++].visible = true;
  if (decorRevealCursor < decorRevealQueue.length) return false;
  decorRevealQueue = null;
  decorRevealCursor = 0;
  return true;
}

/** wave-2 warm-up rig: one parked, unculled proxy per decorative pipeline so
 *  compileAsync can build them without drawing a single visible fragment
 *  (compileAsync skips invisible AND frustum-culled objects) */
export function decorWarmupRig(scene: THREE.Object3D, layer = 0): () => void {
  const R = getKit();
  const objs: THREE.Object3D[] = [];
  const park = (o: THREE.Object3D) => {
    o.position.y = -1500;
    o.frustumCulled = false;
    o.layers.set(layer);
    objs.push(o);
    scene.add(o);
  };
  const inst = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    const m = new THREE.InstancedMesh(geo, mat, 1);
    m.setMatrixAt(0, new THREE.Matrix4());
    m.setColorAt(0, new THREE.Color(1, 1, 1));
    park(m);
  };
  inst(R.vineGeo, R.vineMat); inst(R.mossGeo, R.mossMat);
  inst(R.leafGeo, R.leafMat); inst(R.brambleGeoA, R.brambleMat);
  inst(R.rootGeo, R.brambleMat);
  inst(R.wispGeo, R.wispMat); inst(R.emberGeo, R.emberMat);
  inst(R.wallGlowGeo, R.wallGlowMat); inst(R.floorGlowGeo, R.floorGlowMat);
  inst(R.bannerGeo, R.bannerMat); inst(R.tileGeo, R.redMat);
  inst(R.flameGeo, R.flameBlue); inst(R.flameGeo, R.flameRed); inst(R.flameGeo, R.flameNeutral);
  inst(R.navCellGeo, R.navMat);
  // non-instanced usages compile DIFFERENT pipelines than instanced ones
  const med = R.circleGeo.clone();
  const nV = med.getAttribute("position").count;
  med.setAttribute("color", new THREE.BufferAttribute(new Float32Array(nV * 3).fill(1), 3));
  med.setAttribute("plazaSeed", new THREE.BufferAttribute(new Float32Array(nV), 1));
  park(new THREE.Mesh(med, R.medallionMat));
  const one = (geo: THREE.BufferGeometry, mat: THREE.Material) => park(new THREE.Mesh(geo, mat));
  one(R.portalGeo, R.portalMat); one(R.runeGeo, R.runeMat);
  one(R.beamGeo, R.beamMatBlue); one(R.beamGeo, R.beamMatWarm);
  one(R.beaconGeo, R.beaconMat); one(R.plugGeo, R.plugMat);
  const ropeGeo = new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(2, 0, 0)]),
    3, 0.05, 5,
  );
  one(ropeGeo, R.ropeMat);
  one(ropeGeo, R.routeBeamMat); // route beam = plain Mesh on a tube layout
  park(new THREE.Sprite(R.smokeMat));
  return () => {
    for (const o of objs) o.removeFromParent();
    med.dispose();
    ropeGeo.dispose();
  };
}

/** Stage the ACTUAL pooled detail objects on an isolated camera layer for
 *  compileAsync(). WebGPU's node setup is render-object-specific: compiling
 *  one proxy per material did not warm the hundreds of real island objects,
 *  which caused a measured 403ms hitch on the first far→near LOD transition.
 *  The main camera never sees this layer, so background warm-up cannot flash. */
export function stageActualDetailWarmup(layer = 29): () => void {
  const saved: Array<{
    o: THREE.Object3D; visible: boolean; culled: boolean; mask: number;
    geometry?: THREE.BufferGeometry; count?: number;
  }> = [];
  const warmKeys = new Set([
    ...DETAIL_KEYS, ...DECOR_EXTRA, "blocks", "blockMids", "tiles", "steps", "cols",
    "blockTops", "blocksMidLo", "blockMidsLo", "blockTopsLo", "tilesMidLo",
    "blocksFade", "blocksMidLoFade", "blocksLoFade", "blockMidsFade", "blockMidsLoFade",
    "blockTopsFade", "blockTopsLoFade", "colsFade", "colsLoFade",
  ]);
  const stage = (o: THREE.Object3D, populated = true, geometry?: THREE.BufferGeometry) => {
    saved.push({
      o, visible: o.visible, culled: o.frustumCulled, mask: o.layers.mask,
      ...((o as THREE.Mesh).isMesh ? { geometry: (o as THREE.Mesh).geometry } : {}),
      ...((o as THREE.InstancedMesh).isInstancedMesh ? { count: (o as THREE.InstancedMesh).count } : {}),
    });
    if (geometry && (o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry = geometry;
    if ((o as THREE.InstancedMesh).isInstancedMesh) {
      (o as THREE.InstancedMesh).count = populated ? ((o.userData as { n?: number }).n ?? 0) : 0;
    }
    o.visible = populated;
    o.frustumCulled = false;
    o.layers.set(layer);
  };
  for (const p of slotPools.values()) {
    if (!p.group.visible) continue;
    for (const [key, mesh] of p.meshes) {
      if (!warmKeys.has(key)) continue;
      stage(mesh, ((mesh.userData as { n?: number }).n ?? 0) > 0);
    }
    for (const o of p.perBuild) stage(o);
  }
  return () => {
    for (const s of saved) {
      s.o.visible = s.visible;
      s.o.frustumCulled = s.culled;
      s.o.layers.mask = s.mask;
      if (s.geometry && (s.o as THREE.Mesh).isMesh) (s.o as THREE.Mesh).geometry = s.geometry;
      if (s.count !== undefined && (s.o as THREE.InstancedMesh).isInstancedMesh) {
        (s.o as THREE.InstancedMesh).count = s.count;
      }
    }
  };
}

// decorative layers held back during the two-wave first paint (wave 1 shows
// the core look; these appear once their pipelines are warm)
const DECOR_EXTRA = ["banners", "redTiles", "flamesB", "flamesR", "flamesP"];
let decorSuppressed = false;
export function setDecorSuppressed(on: boolean): void {
  decorSuppressed = on;
  if (on) {
    decorRevealQueue = null;
    decorRevealCursor = 0;
  }
}
export function isDecorSuppressed(): boolean { return decorSuppressed; }

const DETAIL_KEYS = [
  "merlons", "rubble", "moss", "stains", "vines", "leaves", "creepers", "bramblesA",
  "bramblesB", "wisps", "links", "brackets", "cheeks", "wallGlows", "embers", "roots",
  "flamesW", "flamesB", "flamesR", "flamesP",
];

const occludingSlots = new Set<number>();

function setCount(p: SlotPool, key: string, on: boolean): void {
  const mesh = p.meshes.get(key);
  if (!mesh) return;
  const count = on ? ((mesh.userData as { n?: number }).n ?? 0) : 0;
  mesh.count = count;
  // A zero-count but visible InstancedMesh still enters Three's projection /
  // render-object bookkeeping. Pipelines and buffers stay resident while the
  // inactive LOD/fade twin disappears from the submitted object list.
  mesh.visible = count > 0;
}

function applyArchitectureVisibility(p: SlotPool): void {
  const faded = occludingSlots.has(p.slot);
  const high = p.lodLevel === 2;
  const middle = p.lodLevel === 1;
  const far = p.lodLevel === 0;
  const hasBrickMiddle = p.meshes.has("blocksMidLo");
  setCount(p, "blocks", !faded && high);
  setCount(p, "blocksMidLo", !faded && middle);
  setCount(p, "blocksLo", !faded && (far || (middle && !hasBrickMiddle)));
  setCount(p, "blocksFade", faded && high);
  setCount(p, "blocksMidLoFade", faded && middle);
  setCount(p, "blocksLoFade", faded && (far || (middle && !hasBrickMiddle)));
  setCount(p, "blockMids", !faded && high);
  setCount(p, "blockMidsLo", !faded && middle);
  setCount(p, "blockMidsFade", faded && high);
  setCount(p, "blockMidsLoFade", faded && middle);
  setCount(p, "blockTops", !faded && high);
  setCount(p, "blockTopsLo", !faded && middle);
  setCount(p, "blockTopsFade", faded && high);
  setCount(p, "blockTopsLoFade", faded && middle);
  setCount(p, "cols", !faded && high);
  setCount(p, "colsLo", !faded && !high);
  setCount(p, "colsFade", faded && high);
  setCount(p, "colsLoFade", faded && !high);
  // Link galleries/causeways live in companion slots but obey the connected
  // island's LOD. Like island masonry, their twins share instance buffers.
  setCount(p, "linkStones", !faded && high);
  setCount(p, "linkStonesLo", !faded && !high);
  setCount(p, "linkFlames", !faded && high);
}

/** Make only the architecture currently between camera and character fade. */
export function setOccludingSlots(next: ReadonlySet<number>): void {
  let changed = next.size !== occludingSlots.size;
  if (!changed) for (const slot of next) if (!occludingSlots.has(slot)) { changed = true; break; }
  if (!changed) return;
  const affected = new Set([...occludingSlots, ...next]);
  occludingSlots.clear();
  for (const slot of next) occludingSlots.add(slot);
  for (const slot of affected) {
    const p = slotPools.get(slot);
    if (p) applyArchitectureVisibility(p);
  }
}

/** Distance LOD: stable high/low render-object twins only change visibility.
 * Mutating geometry invalidated WebGPU render objects and caused a 200–400ms
 * first-zoom compile hitch even after material warm-up. */
export function setSlotDetail(slot: number, visible: boolean): void {
  setSlotLodLevel(slot, visible ? 2 : 0);
}

/** Three-tier masonry LOD. Tier 1 preserves every authored brick transform
 * and tint with cheap box geometry; only tier 0 collapses vertical courses. */
export function setSlotLodLevel(slot: number, level: LodLevel): void {
  const p = slotPools.get(slot);
  if (!p) return;
  p.lodLevel = level;
  p.detailVisible = level === 2;
  for (const k of DETAIL_KEYS) {
    const m = p.meshes.get(k);
    if (m) {
      m.visible = true;
      m.count = level === 2 ? ((m.userData as { n?: number }).n ?? 0) : 0;
    }
  }
  applyArchitectureVisibility(p);
  const tiles = p.meshes.get("tiles");
  if (tiles) {
    tiles.count = level === 2 ? ((tiles.userData as { n?: number }).n ?? 0) : 0;
    tiles.visible = tiles.count > 0;
  }
  const tilesMidLo = p.meshes.get("tilesMidLo");
  if (tilesMidLo) {
    tilesMidLo.count = level === 1 ? ((tilesMidLo.userData as { n?: number }).n ?? 0) : 0;
    tilesMidLo.visible = tilesMidLo.count > 0;
  }
  const tilesLo = p.meshes.get("tilesLo");
  if (tilesLo) {
    tilesLo.count = (level === 0 || (level === 1 && !tilesMidLo))
      ? ((tilesLo.userData as { n?: number }).n ?? 0) : 0;
    tilesLo.visible = tilesLo.count > 0;
  }
  setCount(p, "steps", level === 2);
  setCount(p, "stepsLo", level !== 2);
}

// WebGPU render objects are cached per concrete mesh, not merely per shared
// geometry/material pipeline. A cold island promotion used to realize 20+
// objects in the threshold-crossing frame (95–126ms measured). Warm exactly
// one real object per frame below the abyss, then switch the whole tier only
// after every target object has been submitted once.
const warmedLodObjects = new WeakSet<THREE.InstancedMesh>();
const MID_LOD_WARM_KEYS = [
  "blocksMidLo", "blockMidsLo", "blockTopsLo", "tilesMidLo",
] as const;
const HIGH_LOD_WARM_KEYS = [
  "blocks", "blockMids", "blockTops", "tiles", "cols", "steps",
  "linkStones", "linkFlames", ...DETAIL_KEYS, ...DECOR_EXTRA,
] as const;

function lodWarmKeys(level: LodLevel): readonly string[] {
  return level === 2 ? HIGH_LOD_WARM_KEYS : level === 1 ? MID_LOD_WARM_KEYS : [];
}

function pendingWarmMesh(slots: readonly number[], level: LodLevel): THREE.InstancedMesh | null {
  for (const slot of slots) {
    const p = slotPools.get(slot);
    if (!p || !p.group.visible) continue;
    for (const key of lodWarmKeys(level)) {
      const mesh = p.meshes.get(key);
      if (!mesh || warmedLodObjects.has(mesh) || ((mesh.userData as { n?: number }).n ?? 0) <= 0) continue;
      // If it is already in the submitted tier, no extra hidden draw is needed.
      if (mesh.visible && mesh.count > 0) {
        warmedLodObjects.add(mesh);
        continue;
      }
      return mesh;
    }
  }
  return null;
}

export function areSlotsLodWarm(slots: readonly number[], level: LodLevel): boolean {
  return pendingWarmMesh(slots, level) === null;
}

/** Stages one instance of one cold target mesh for the next real post frame.
 * Call the returned restore function immediately after render submission. */
export function stageSlotLodWarmup(slots: readonly number[], level: LodLevel): (() => void) | null {
  const mesh = pendingWarmMesh(slots, level);
  if (!mesh) return null;
  const matrix = mesh.instanceMatrix;
  const array = matrix.array as Float32Array;
  const savedMatrix = array.slice(0, 16);
  const savedVisible = mesh.visible;
  const savedCount = mesh.count;
  const savedCulled = mesh.frustumCulled;
  // Identity with a very deep translation: it survives object culling and
  // reaches the render backend without producing a visible fragment.
  array.fill(0, 0, 16);
  array[0] = 1; array[5] = 1; array[10] = 1; array[15] = 1;
  array[13] = -2000;
  matrix.addUpdateRange(0, 16);
  matrix.needsUpdate = true;
  mesh.count = 1;
  mesh.visible = true;
  mesh.frustumCulled = false;
  return () => {
    array.set(savedMatrix, 0);
    matrix.addUpdateRange(0, 16);
    matrix.needsUpdate = true;
    mesh.visible = savedVisible;
    mesh.count = savedCount;
    mesh.frustumCulled = savedCulled;
    warmedLodObjects.add(mesh);
  };
}

/** hide pools that the current forge doesn't use */
export function pruneSlots(active: Set<number>): void {
  for (const [slot, p] of slotPools) {
    if (!active.has(slot)) {
      p.group.visible = false;
      for (const o of p.perBuild) o.removeFromParent();
      p.perBuild = [];
    }
  }
}
