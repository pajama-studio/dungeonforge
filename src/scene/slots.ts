// Per-slot render-object pools. three's WebGPU renderer builds a node graph
// PER RENDER OBJECT on first sight (~7ms × ~35 meshes × passes ≈ 0.5s per
// island) — render objects are created once per slot; re-forges just rewrite
// instance buffers. This is also the streaming foundation: a slot can be
// refilled with any block as the camera roams.

import * as THREE from "three/webgpu";
import { InstList } from "./instances";
import { getKit } from "./kit";

export interface SlotPool {
  group: THREE.Group;
  meshes: Map<string, THREE.InstancedMesh>;
  perBuild: THREE.Object3D[];
  perBuildGeos: THREE.BufferGeometry[];
}

const slotPools = new Map<number, SlotPool>();

export function getSlot(slot: number, scene?: THREE.Object3D): SlotPool {
  let p = slotPools.get(slot);
  if (!p) {
    p = { group: new THREE.Group(), meshes: new Map(), perBuild: [], perBuildGeos: [] };
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
    let nx = Infinity, ny = Infinity, nz = Infinity, px = -Infinity, py = -Infinity, pz = -Infinity;
    const m = list.mats;
    for (let i = 0; i < list.count; i++) {
      const o = i * 16;
      nx = Math.min(nx, m[o + 12]); px = Math.max(px, m[o + 12]);
      ny = Math.min(ny, m[o + 13]); py = Math.max(py, m[o + 13]);
      nz = Math.min(nz, m[o + 14]); pz = Math.max(pz, m[o + 14]);
    }
    const r = Math.hypot(px - nx, py - ny, pz - nz) / 2 + 4; // pad for geometry size/scale
    mesh.boundingSphere = new THREE.Sphere(
      new THREE.Vector3((nx + px) / 2, (ny + py) / 2, (nz + pz) / 2), r,
    );
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
export function decorWarmupRig(scene: THREE.Object3D): () => void {
  const R = getKit();
  const objs: THREE.Object3D[] = [];
  const park = (o: THREE.Object3D) => {
    o.position.y = -1500;
    o.frustumCulled = false;
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

/** distance LOD: hide the small-detail layers of a far-away slot and swap its
 *  bulk masonry to low-poly box geometry (~4× fewer vertices) */
export function setSlotDetail(slot: number, visible: boolean): void {
  const p = slotPools.get(slot);
  if (!p) return;
  for (const k of DETAIL_KEYS) {
    const m = p.meshes.get(k);
    if (m) m.visible = visible && ((m.userData as { n?: number }).n ?? 0) > 0;
  }
  const R = getKit();
  const blocks = p.meshes.get("blocks");
  if (blocks) blocks.geometry = visible ? R.blockGeo : R.blockGeoLo;
  const tiles = p.meshes.get("tiles");
  if (tiles) tiles.geometry = visible ? R.tileGeo : R.tileGeoLo;
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
