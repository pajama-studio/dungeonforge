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
}

const slotPools = new Map<number, SlotPool>();

export function getSlot(slot: number, scene?: THREE.Object3D): SlotPool {
  let p = slotPools.get(slot);
  if (!p) {
    p = { slot, group: new THREE.Group(), meshes: new Map(), perBuild: [], perBuildGeos: [], detailVisible: true };
    p.group.name = `slot-${slot}`;
    slotPools.set(slot, p);
  }
  if (scene && !p.group.parent) scene.add(p.group);
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
  fillInstanced(mesh, list);
  if (decorSuppressed && (DETAIL_KEYS.includes(key) || DECOR_EXTRA.includes(key))) mesh.visible = false;
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
  mesh.instanceMatrix = source.instanceMatrix;
  mesh.instanceColor = source.instanceColor;
  mesh.count = source.count;
  (mesh.userData as { n: number }).n = source.count;
  mesh.boundingSphere = source.boundingSphere;
  mesh.frustumCulled = source.frustumCulled;
}

/** end of the two-wave first paint: unhide every decorative layer (their
 *  pipelines are warm now) — LOD re-applies itself on the next frame */
export function revealDecor(): void {
  decorSuppressed = false;
  for (const p of slotPools.values()) {
    for (const k of [...DETAIL_KEYS, ...DECOR_EXTRA]) {
      const m = p.meshes.get(k);
      if (m) m.visible = ((m.userData as { n?: number }).n ?? 0) > 0;
    }
    for (const o of p.perBuild) o.visible = true;
  }
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
    ...DETAIL_KEYS, ...DECOR_EXTRA, "blocks", "tiles",
    "blocksFade", "blocksLoFade", "colsFade",
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
export function setDecorSuppressed(on: boolean): void { decorSuppressed = on; }
export function isDecorSuppressed(): boolean { return decorSuppressed; }

const DETAIL_KEYS = [
  "merlons", "rubble", "moss", "vines", "leaves", "creepers", "bramblesA",
  "bramblesB", "wisps", "links", "brackets", "cheeks", "wallGlows", "embers", "roots",
];

const occludingSlots = new Set<number>();

function setCount(p: SlotPool, key: string, on: boolean): void {
  const mesh = p.meshes.get(key);
  if (!mesh) return;
  mesh.visible = true;
  mesh.count = on ? ((mesh.userData as { n?: number }).n ?? 0) : 0;
}

function applyArchitectureVisibility(p: SlotPool): void {
  const faded = occludingSlots.has(p.slot);
  setCount(p, "blocks", !faded && p.detailVisible);
  setCount(p, "blocksLo", !faded && !p.detailVisible);
  setCount(p, "blocksFade", faded && p.detailVisible);
  setCount(p, "blocksLoFade", faded && !p.detailVisible);
  setCount(p, "cols", !faded);
  setCount(p, "colsFade", faded);
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
  const p = slotPools.get(slot);
  if (!p) return;
  p.detailVisible = visible;
  for (const k of DETAIL_KEYS) {
    const m = p.meshes.get(k);
    if (m) {
      m.visible = true;
      m.count = visible ? ((m.userData as { n?: number }).n ?? 0) : 0;
    }
  }
  applyArchitectureVisibility(p);
  const tiles = p.meshes.get("tiles");
  if (tiles) { tiles.visible = true; tiles.count = visible ? ((tiles.userData as { n?: number }).n ?? 0) : 0; }
  const tilesLo = p.meshes.get("tilesLo");
  if (tilesLo) { tilesLo.visible = true; tilesLo.count = visible ? 0 : ((tilesLo.userData as { n?: number }).n ?? 0); }
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
