// Turns a Layout into meshes. Everything repeated is instanced; per-instance
// color carries baked AO + hue variation; all glow goes through emissiveNode so
// the MRT-emissive bloom pass picks it up and nothing else does.
//
// Materials & geometries are created ONCE and shared across regenerations —
// WebGPU pipeline compilation is the expensive part of a rebuild, so a re-forge
// only recreates InstancedMesh instance buffers (near-instant).

import * as THREE from "three/webgpu";
import {
  color, vec2, vec3, uv, time, sin, cos, positionLocal, positionWorld, normalLocal,
  instanceIndex, hash, smoothstep, length, fract, abs, mix, float, atan, max, triNoise3D,
  transformNormalToView,
} from "three/tsl";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type { Layout, Dir } from "../gen/dungeon";
import { FLOOR, WALL, VOID, ABYSS, DX, DY } from "../gen/dungeon";
import { hash2, hash3, mulberry32 } from "../gen/rng";
import { TH, CELL } from "./env";

const COURSE = TH / 2; // one masonry course = half a tier
const BRIDGE_SPAN = 3.2 * CELL; // ravine is always 3 cells + 2×0.4-cell setback

export interface LightSpec { x: number; y: number; z: number; color: number; base: number; dist: number; ph: number }

export interface WorldHandle {
  group: THREE.Group;
  /** point-light requests in island-LOCAL coords — the orchestrator feeds them
   *  into a FIXED global pool (a changing scene light count recompiles every
   *  pipeline in three's WebGPU forward renderer) */
  lights: LightSpec[];
  tick: (t: number) => void;
  dispose: () => void;
}

interface Inst { m: THREE.Matrix4; c: THREE.Color }

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _axisY = new THREE.Vector3(0, 1, 0);

function fillInstanced(mesh: THREE.InstancedMesh, items: Inst[]): void {
  for (let i = 0; i < items.length; i++) {
    mesh.setMatrixAt(i, items[i].m);
    mesh.setColorAt(i, items[i].c);
  }
  mesh.count = items.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  // manual bounds from the matrices' translation columns — computeBoundingSphere
  // decomposes every instance matrix and costs 100ms+ on big islands
  if (items.length > 0) {
    let nx = Infinity, ny = Infinity, nz = Infinity, px = -Infinity, py = -Infinity, pz = -Infinity;
    for (const it of items) {
      const e = it.m.elements;
      nx = Math.min(nx, e[12]); px = Math.max(px, e[12]);
      ny = Math.min(ny, e[13]); py = Math.max(py, e[13]);
      nz = Math.min(nz, e[14]); pz = Math.max(pz, e[14]);
    }
    const cx2 = (nx + px) / 2, cy2 = (ny + py) / 2, cz2 = (nz + pz) / 2;
    const r = Math.hypot(px - nx, py - ny, pz - nz) / 2 + 4; // pad for geometry size/scale
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx2, cy2, cz2), r);
  }
  mesh.frustumCulled = true;
}

// Per-slot pools. three's WebGPU renderer builds a node graph PER RENDER
// OBJECT on first sight (~7ms × ~35 meshes × passes ≈ 0.5s per island) —
// render objects are created once per slot; re-forges just rewrite instance
// buffers. This is also the streaming foundation: a slot can be refilled with
// any block as the camera roams.
interface SlotPool {
  group: THREE.Group;
  meshes: Map<string, THREE.InstancedMesh>;
  perBuild: THREE.Object3D[];
  perBuildGeos: THREE.BufferGeometry[];
}
const slotPools = new Map<number, SlotPool>();

function getSlot(slot: number, scene?: THREE.Object3D): SlotPool {
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

function putInstanced(
  pool: SlotPool, key: string,
  geom: THREE.BufferGeometry, mat: THREE.Material, items: Inst[], shadows = true,
): void {
  let mesh = pool.meshes.get(key);
  if (mesh && (mesh.instanceMatrix.count < items.length || mesh.geometry !== geom || mesh.material !== mat)) {
    pool.group.remove(mesh);
    mesh.dispose();
    mesh = undefined;
  }
  if (!mesh) {
    const capacity = Math.max(256, Math.ceil(items.length * 1.6));
    mesh = new THREE.InstancedMesh(geom, mat, capacity);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    pool.meshes.set(key, mesh);
    pool.group.add(mesh);
  }
  fillInstanced(mesh, items);
}

const DETAIL_KEYS = ["merlons", "rubble", "moss", "vines", "leaves", "creepers", "bramblesA", "bramblesB", "wisps", "links", "brackets", "cheeks", "wallGlows", "embers"];

/** distance LOD: hide the small-detail layers of a far-away slot and swap its
 *  bulk masonry to low-poly box geometry (~4× fewer vertices) */
export function setSlotDetail(slot: number, visible: boolean): void {
  const p = slotPools.get(slot);
  if (!p) return;
  for (const k of DETAIL_KEYS) {
    const m = p.meshes.get(k);
    if (m) m.visible = visible;
  }
  const R = getShared();
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

function inst(x: number, y: number, z: number, rotY = 0, sx = 1, sy = 1, sz = sx, c = 0xffffff): Inst {
  _pos.set(x, y, z);
  _quat.setFromAxisAngle(_axisY, rotY);
  _scale.set(sx, sy, sz);
  return { m: new THREE.Matrix4().compose(_pos, _quat, _scale), c: new THREE.Color(c) };
}

const dirRotY = (d: Dir): number => (d === 0 ? Math.PI / 2 : d === 1 ? -Math.PI / 2 : d === 2 ? 0 : Math.PI);

/** Bake painterly form shading into vertex colors: tops catch the sky, each side
 *  face gets its own value so every block edge reads as a distinct plane.
 *  Multiplies with per-instance color (NodeMaterial does vertexColor × instanceColor). */
function shadeFaces(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const normal = geo.getAttribute("normal");
  const colors = new Float32Array(normal.count * 3);
  for (let i = 0; i < normal.count; i++) {
    const nx = normal.getX(i), ny = normal.getY(i), nz = normal.getZ(i);
    let v: number;
    if (ny > 0.45) v = 1.0;
    else if (ny < -0.45) v = 0.42;
    else if (Math.abs(nx) > Math.abs(nz)) v = nx > 0 ? 0.92 : 0.74;
    else v = nz > 0 ? 0.84 : 0.66;
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = v;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geo;
}

// ---------------------------------------------------------------------------
// Shared resources — built once, reused by every regeneration.
// ---------------------------------------------------------------------------

interface SharedRes {
  blockGeo: THREE.BufferGeometry;
  blockGeoLo: THREE.BufferGeometry;
  tileGeoLo: THREE.BufferGeometry;
  merlonGeo: THREE.BufferGeometry;
  tileGeo: THREE.BufferGeometry;
  stepGeo: THREE.BufferGeometry;
  cheekGeo: THREE.BufferGeometry;
  bracketGeo: THREE.BufferGeometry;
  bowlGeo: THREE.BufferGeometry;
  postGeo: THREE.BufferGeometry;
  plankGeo: THREE.BufferGeometry;
  flameGeo: THREE.BufferGeometry;
  wallGlowGeo: THREE.BufferGeometry;
  floorGlowGeo: THREE.BufferGeometry;
  bannerGeo: THREE.BufferGeometry;
  rubbleGeo: THREE.BufferGeometry;
  crateGeo: THREE.BufferGeometry;
  vineGeo: THREE.BufferGeometry;
  linkGeo: THREE.BufferGeometry;
  mossGeo: THREE.BufferGeometry;
  colGeo: THREE.BufferGeometry;
  leafGeo: THREE.BufferGeometry;
  creeperGeo: THREE.BufferGeometry;
  brambleGeoA: THREE.BufferGeometry;
  brambleGeoB: THREE.BufferGeometry;
  brambleMat: THREE.MeshLambertNodeMaterial;
  leafMat: THREE.MeshLambertNodeMaterial;
  wispGeo: THREE.BufferGeometry;
  runeGeo: THREE.BufferGeometry;
  plugGeo: THREE.BufferGeometry;
  plugMat: THREE.MeshLambertNodeMaterial;
  emberGeo: THREE.BufferGeometry;
  emberMat: THREE.MeshBasicNodeMaterial;
  beamGeo: THREE.BufferGeometry;
  beamMatBlue: THREE.MeshBasicNodeMaterial;
  beamMatWarm: THREE.MeshBasicNodeMaterial;
  vineMat: THREE.MeshLambertNodeMaterial;
  mossMat: THREE.MeshLambertNodeMaterial;
  wispMat: THREE.MeshBasicNodeMaterial;
  runeMat: THREE.MeshBasicNodeMaterial;
  circleGeo: THREE.BufferGeometry;   // unit radius; scaled per medallion
  portalGeo: THREE.BufferGeometry;
  beaconGeo: THREE.BufferGeometry;
  stoneMat: THREE.MeshLambertNodeMaterial;
  redMat: THREE.MeshStandardNodeMaterial;
  woodMat: THREE.MeshLambertNodeMaterial;
  flameWarm: THREE.MeshBasicNodeMaterial;
  flameBlue: THREE.MeshBasicNodeMaterial;
  flameRed: THREE.MeshBasicNodeMaterial;
  wallGlowMat: THREE.MeshBasicNodeMaterial;
  floorGlowMat: THREE.MeshBasicNodeMaterial;
  bannerMat: THREE.MeshStandardNodeMaterial;
  medallionBlue: THREE.MeshStandardNodeMaterial;
  medallionGold: THREE.MeshStandardNodeMaterial;
  portalMat: THREE.MeshBasicNodeMaterial;
  beaconMat: THREE.MeshBasicNodeMaterial;
  smokeMat: THREE.SpriteNodeMaterial;
}

let S: SharedRes | null = null;

// Pure-glow materials are UNLIT (MeshBasicNodeMaterial): they skip the whole
// light loop per fragment — crucial, since additive quads are the overdraw.
// Their colorNode outputs linear HDR > 1 so the threshold bloom picks them up.
function makeFlameMat(cA: number, cB: number, cCore: number): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const ph = hash(instanceIndex.toFloat().add(0.317)).mul(6.2832);
  const flick = sin(time.mul(10.7).add(ph)).mul(0.55).add(sin(time.mul(16.3).add(ph.mul(2.7))).mul(0.45));
  const h = uv().y;
  const cx = uv().x.sub(0.5).abs().mul(2);
  const sway = sin(time.mul(9.1).add(ph)).mul(h).mul(0.06);
  mat.positionNode = positionLocal.add(vec3(sway, flick.mul(0.05).mul(h), sway.mul(0.6)));
  const shape = smoothstep(1.0, 0.22, h.add(cx.mul(0.85)).add(flick.mul(0.08)))
    .mul(smoothstep(0.0, 0.1, float(1).sub(cx)));
  const ramp = mix(color(cCore), mix(color(cA), color(cB), h), smoothstep(0.0, 0.55, h.add(cx.mul(0.3))));
  mat.colorNode = ramp.mul(shape).mul(flick.mul(0.4).add(3.2));
  mat.opacityNode = shape;
  return mat;
}

/** Carved-masonry stone: mortar seams at block borders, a fake running-bond
 *  vertical seam per course (so one instance reads as 2-3 hand-laid blocks),
 *  and low-frequency grain — all procedural, multiplied under the per-instance
 *  hue/AO color and the per-face shading vertex color. */
function makeStoneMat(): THREE.MeshLambertNodeMaterial {
  const mat = new THREE.MeshLambertNodeMaterial({ vertexColors: true });
  const pl = positionLocal;
  const nl = normalLocal;
  const hw = (CELL * 1.02) / 2;
  const sideMask = smoothstep(0.6, 0.35, abs(nl.y)); // 1 on side faces, 0 on tops
  // vertical mortar at block x/z borders (only on faces not normal to that axis)
  const ex = smoothstep(hw - 0.12, hw - 0.02, abs(pl.x)).mul(float(1).sub(abs(nl.x)));
  const ez = smoothstep(hw - 0.12, hw - 0.02, abs(pl.z)).mul(float(1).sub(abs(nl.z)));
  // horizontal course seams: world-space y is course-aligned (bases sit on tier
  // multiples and courses aren't y-jittered), so one fract does every course
  const fy = fract(positionWorld.y.div(COURSE));
  const dSeam = fy.min(float(1).sub(fy));
  const line = smoothstep(0.11, 0.02, dSeam).mul(sideMask);
  // fake running-bond: an extra vertical seam at a per-instance offset
  const off = hash(instanceIndex.toFloat().add(0.13)).sub(0.5).mul(1.3);
  const vseam = smoothstep(0.06, 0.015, abs(pl.x.sub(off)))
    .add(smoothstep(0.06, 0.015, abs(pl.z.sub(off.mul(-0.7)))))
    .mul(sideMask);
  // hand-cut seams: modulate the mortar so joints vary in depth along their run
  const cut = triNoise3D(positionWorld.mul(2.2), 0, 0).mul(0.5).add(0.65);
  const mortar = ex.add(ez).add(line).add(vseam).clamp(0, 1).mul(cut);
  // weathered grain: three FINE scales only — a macro (low-frequency) term just
  // smears meaningless light/dark clouds across whole walls
  const grain = triNoise3D(positionWorld.mul(0.6), 0, 0).mul(0.16)
    .add(triNoise3D(positionWorld.mul(1.8), 0, 0).mul(0.13))
    .add(triNoise3D(positionWorld.mul(4.6), 0, 0).mul(0.09));
  // Carved relief — pure math, no textures. An analytic height field whose
  // gradient perturbs the normal: a chiselled egg-crate frieze band every 5th
  // course + a faint tool-mark ripple everywhere. h is differentiable, so the
  // normal offset is the exact tangential gradient (no tangent frame needed).
  const fc = fract(positionWorld.y.div(COURSE * 8));
  const band = smoothstep(0.44, 0.5, fc).mul(float(1).sub(smoothstep(0.56, 0.62, fc)))
    .mul(sideMask); // carve SIDE faces only — on tops the tangential gradient
                    // survives projection at full strength and reads as a
                    // diagonal crosshatch smeared across walkways and floors
  const kx = 5.6, kq = 9.0;
  const sx = sin(pl.x.mul(kx)), sz = sin(pl.z.mul(kx));
  const cxn = cos(pl.x.mul(kx)), czn = cos(pl.z.mul(kx));
  const ripple = cos(pl.x.add(pl.z).mul(kq)).mul(0.10).mul(sideMask);
  const dhdx = band.mul(cxn.mul(sz).mul(kx * 0.13)).add(ripple.mul(-kq * 0.012));
  const dhdz = band.mul(sx.mul(czn).mul(kx * 0.13)).add(ripple.mul(-kq * 0.012));
  const g = vec3(dhdx, 0, dhdz);
  const gT = g.sub(nl.mul(g.dot(nl)));
  mat.normalNode = transformNormalToView(nl.sub(gT).normalize());

  const cavity = band.mul(sx.mul(sz)).mul(0.5).add(0.5);
  // rain streaks: columnar (y-independent) noise → dark weathering runs down
  // the side faces, like water has been bleeding off the walkways for ages
  const streak = smoothstep(0.58, 0.78, triNoise3D(vec3(positionWorld.x.mul(0.9), 0, positionWorld.z.mul(0.9)), 0, 0))
    .mul(sideMask);
  const albedo = float(0.86).add(grain)
    .mul(float(1).sub(mortar.mul(0.42)))
    .mul(cavity.mul(0.09).add(0.955))
    .mul(float(1).sub(streak.mul(0.22)));
  mat.colorNode = vec3(albedo);
  return mat;
}

function makeMedallionMat(theme: number, phase: number): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.8 });
  const p = uv().sub(0.5).mul(2);
  const r = length(p);
  const ang = atan(p.y, p.x);
  const band = (rr: number, w: number) => smoothstep(w, w * 0.4, abs(r.sub(rr)));
  const segs = smoothstep(0.28, 0.34, fract(ang.mul(12 / 6.2832).add(time.mul(0.02))).sub(0.5).abs());
  const pattern = band(0.9, 0.05)
    .add(band(0.68, 0.045).mul(segs))
    .add(band(0.4, 0.05))
    .add(smoothstep(0.2, 0.03, r).mul(1.7));
  const pulse = sin(time.mul(1.25).add(phase)).mul(0.22).add(0.78);
  mat.colorNode = color(0x27221c).mul(float(1).sub(pattern.clamp(0, 1).mul(0.5)));
  mat.emissiveNode = color(theme).mul(pattern).mul(pulse).mul(1.6);
  return mat;
}

/** Grow one thorny bramble tendril in the wall plane: a branching random walk
 *  of woody segments, each sprouting alternating thorn spikes. Pure algorithm,
 *  deterministic per seed — two baked variants + per-instance mirror/rot/scale
 *  give the tangle its variety. */
function buildBrambleGeo(seedNum: number): THREE.BufferGeometry {
  const rng = mulberry32(seedNum);
  const parts: THREE.BufferGeometry[] = [];
  // tendrils run HORIZONTALLY, girdling the wall like a thorn belt — they hug
  // the face (tiny z offsets, short thorns) and only rarely arc upward
  interface Walker { x: number; y: number; ang: number; home: number; depth: number; steps: number }
  const queue: Walker[] = [
    { x: 0, y: 0, ang: (rng() - 0.5) * 0.5, home: 0, depth: 0, steps: 11 },
    { x: 0, y: 0.25 + rng() * 0.3, ang: Math.PI + (rng() - 0.5) * 0.5, home: Math.PI, depth: 0, steps: 9 },
  ];
  let thornSide = 1;
  while (queue.length > 0) {
    const w = queue.pop()!;
    for (let i = 0; i < w.steps; i++) {
      const L = 0.2 + rng() * 0.14;
      const dx = Math.cos(w.ang), dy = Math.sin(w.ang);
      const mx = w.x + dx * L * 0.5, my = w.y + dy * L * 0.5;
      const seg = new THREE.BoxGeometry(0.042, L * 1.15, 0.042);
      seg.rotateZ(w.ang - Math.PI / 2);
      seg.translate(mx, my, 0.035 + rng() * 0.04);
      parts.push(seg);
      if (rng() < 0.85) {
        thornSide = -thornSide;
        const t = new THREE.ConeGeometry(0.026, 0.12, 4);
        t.rotateZ(w.ang - Math.PI / 2 + thornSide * (Math.PI / 2 + 0.35));
        t.translate(mx + -dy * thornSide * 0.045, my + dx * thornSide * 0.045, 0.055 + rng() * 0.035);
        parts.push(t);
      }
      w.x += dx * L; w.y += dy * L;
      w.ang += (rng() - 0.5) * 0.95;
      w.ang = w.ang * 0.8 + w.home * 0.2; // relax back to the horizontal run
      // stay inside a low band: fold the walk back if it strays vertically
      if (my > 0.8) w.ang = w.home - Math.abs(w.ang - w.home) * 0.5;
      if (my < -0.55) w.ang = w.home + Math.abs(w.ang - w.home) * 0.5;
      if (w.depth < 2 && rng() < 0.2) {
        queue.push({ x: w.x, y: w.y, ang: w.ang + (rng() < 0.5 ? 1 : -1) * (0.5 + rng() * 0.5), home: w.home, depth: w.depth + 1, steps: 3 + Math.floor(rng() * 4) });
      }
    }
  }
  const merged = BufferGeometryUtils.mergeGeometries(parts);
  for (const g of parts) g.dispose();
  return merged;
}

function getShared(): SharedRes {
  if (S) return S;

  const flameGeoBase = new THREE.PlaneGeometry(0.55, 1.02);
  flameGeoBase.translate(0, 0.51, 0);
  const flameGeoCross = flameGeoBase.clone().rotateY(Math.PI / 2);
  const flameGeo = BufferGeometryUtils.mergeGeometries([flameGeoBase, flameGeoCross]);
  flameGeoBase.dispose(); flameGeoCross.dispose();

  const bannerGeo = new THREE.PlaneGeometry(1.35, 2.55, 1, 10);
  bannerGeo.translate(0, -1.275, 0);

  const bannerMat = new THREE.MeshStandardNodeMaterial({
    side: THREE.DoubleSide, roughness: 0.9, transparent: true, alphaTest: 0.4,
  });
  {
    const ph = hash(instanceIndex.toFloat().add(0.71)).mul(6.2832);
    const w = uv().y.oneMinus(); // 0 at the rod, 1 at the free bottom edge
    const sway = sin(time.mul(1.9).add(ph).add(w.mul(2.6))).mul(w).mul(0.16);
    bannerMat.positionNode = positionLocal.add(vec3(sway.mul(0.4), 0, sway));
    const u = uv().x, v = uv().y;
    const edge = u.min(u.oneMinus()).min(v);
    const border = smoothstep(0.11, 0.075, edge);
    const du = u.sub(0.5).abs(), dv = v.sub(0.42).abs();
    const diamond = du.mul(2.3).add(dv.mul(1.2));
    const sig = smoothstep(0.31, 0.26, diamond).sub(smoothstep(0.19, 0.14, diamond)).clamp(0, 1);
    const circ = smoothstep(0.075, 0.05, length(vec2(du, v.sub(0.14))));
    const gold = color(0xc9973a);
    const base = color(0x2a55c8).mul(v.mul(0.45).add(0.62));
    bannerMat.colorNode = mix(base, gold, max(border.mul(0.85), sig.add(circ).clamp(0, 1)));
    bannerMat.emissiveNode = gold.mul(sig.add(circ)).mul(0.4);
    // centuries of wind: a ragged, per-banner torn bottom edge
    const tear = triNoise3D(vec3(u.mul(4.2), ph, 0), 0, 0).mul(0.2);
    bannerMat.opacityNode = smoothstep(0.0, 0.1, v.sub(tear));
  }

  const wallGlowMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  {
    const ph = hash(instanceIndex.toFloat().add(0.83)).mul(6.2832);
    const flick = sin(time.mul(8.9).add(ph)).mul(0.1).add(sin(time.mul(14.7).add(ph.mul(1.9))).mul(0.06)).add(0.86);
    const fall = smoothstep(0.5, 0.04, length(uv().sub(vec2(0.5, 0.42))));
    wallGlowMat.colorNode = color(0xff8a35).mul(fall).mul(flick).mul(0.42);
    wallGlowMat.opacityNode = fall;
  }

  const floorGlowMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  {
    const ph = hash(instanceIndex.toFloat().add(0.59)).mul(6.2832);
    const flick = sin(time.mul(8.3).add(ph)).mul(0.09).add(sin(time.mul(13.9).add(ph.mul(2.3))).mul(0.05)).add(0.88);
    const fall = smoothstep(0.5, 0.03, length(uv().sub(0.5)));
    floorGlowMat.colorNode = color(0xff9440).mul(fall).mul(flick).mul(0.5);
    floorGlowMat.opacityNode = fall;
  }

  const portalMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  {
    const p = uv().sub(vec2(0.5, 0.42));
    const r = length(p);
    const swirl = sin(r.mul(22).sub(time.mul(2.1)).add(atan(p.y, p.x).mul(3)));
    const glow = float(0.3).div(r.add(0.16));
    portalMat.colorNode = color(0x3e7bff).mul(glow.mul(swirl.mul(0.22).add(1))).mul(1.6);
    portalMat.opacityNode = smoothstep(0.62, 0.12, r);
  }

  const beaconMat = new THREE.MeshBasicNodeMaterial();
  beaconMat.colorNode = color(0xffe4a0).mul(sin(time.mul(2.2)).mul(0.2).add(1)).mul(4.5);

  const redMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, vertexColors: true });
  redMat.emissiveNode = color(0xff2a08).mul(sin(time.mul(1.7)).mul(0.25).add(0.85)).mul(0.55);

  const smokeMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  smokeMat.colorNode = color(0x3a587a); // cool-tinted mist banks
  smokeMat.opacityNode = smoothstep(0.5, 0.08, length(uv().sub(0.5))).mul(0.13);

  // hanging vines: pinned at the top, swaying tip, dark→mossy green gradient
  const vineMat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false });
  {
    const ph = hash(instanceIndex.toFloat().add(0.47)).mul(6.2832);
    const w = uv().y.oneMinus(); // 0 at the anchored top, 1 at the tip
    const sway = sin(time.mul(1.3).add(ph).add(w.mul(2.1))).mul(w).mul(0.1);
    vineMat.positionNode = positionLocal.add(vec3(sway.mul(0.5), 0, sway));
    vineMat.colorNode = mix(color(0x39522c), color(0x17240f), uv().y.oneMinus());
    vineMat.opacityNode = float(1).sub(smoothstep(0.8, 1.0, w)); // tip fades out
  }
  const vineGeo = new THREE.PlaneGeometry(0.24, 1.9, 1, 6);
  vineGeo.translate(0, -0.95, 0);

  // moss patches: flat blobs with noise-eaten irregular edges — the detail
  // layer that actually reads from a top-down camera
  const mossMat = new THREE.MeshLambertNodeMaterial({ transparent: true, depthWrite: false });
  {
    const r = length(uv().sub(0.5)).mul(2);
    const n = triNoise3D(positionWorld.mul(0.85), 0, 0);
    mossMat.colorNode = mix(color(0x2c4520), color(0x18280f), r);
    mossMat.opacityNode = float(1).sub(smoothstep(0.45, 1.0, r.add(n.mul(0.55)))).mul(0.9);
  }
  const mossGeo = new THREE.CircleGeometry(0.62, 12);
  mossGeo.rotateX(-Math.PI / 2);

  // ancient column (unit height, base at y=0, gentle entasis taper)
  const colGeo = new THREE.CylinderGeometry(0.16, 0.2, 1, 8);
  colGeo.translate(0, 0.5, 0);

  // ivy leaf cluster: ~10 leaf quads staggered down a hanging stem line
  // (VegetationGeneratorThreeJS insight: instanced leaf quads carry the read;
  //  the stem itself barely matters at diorama distance)
  const leafGeo = (() => {
    const quads: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 10; k++) {
      const t = k / 9;
      const g = new THREE.PlaneGeometry(0.4 - t * 0.14, 0.32 - t * 0.1);
      const side = k % 2 === 0 ? 1 : -1;
      g.rotateZ(side * (0.35 + t * 0.25));
      g.rotateY(side * 0.55);
      g.translate(side * (0.12 + ((k * 37) % 10) * 0.014), -0.14 - t * 1.62, 0.1 + ((k * 53) % 7) * 0.012);
      quads.push(g);
    }
    const merged = BufferGeometryUtils.mergeGeometries(quads);
    for (const g of quads) g.dispose();
    return merged;
  })();
  // creeper patch (爬山虎): a wall-hugging carpet of small leaves that climbs
  // up from the floor — dense at the base, thinning and narrowing upward,
  // with a few runner leaves straggling past the fringe
  const creeperGeo = (() => {
    const rng = mulberry32(0xc11e9e);
    const quads: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 26; k++) {
      const yN = Math.pow(rng(), 1.35);        // bias toward the base
      const y = yN * 2.3;
      const spread = 0.85 * (1 - yN * 0.65);   // narrows as it climbs
      const u = (rng() + rng() - 1) * spread;  // clustered toward the stem line
      const s = 0.34 - yN * 0.08 + rng() * 0.08;
      const g = new THREE.PlaneGeometry(s, s * 0.82);
      g.rotateZ((rng() - 0.5) * 1.6);
      g.rotateY((rng() - 0.5) * 0.7);
      g.translate(u, y + 0.1, 0.05 + rng() * 0.12);
      quads.push(g);
    }
    const merged = BufferGeometryUtils.mergeGeometries(quads);
    for (const g of quads) g.dispose();
    return merged;
  })();

  const leafMat = new THREE.MeshLambertNodeMaterial({
    side: THREE.DoubleSide, transparent: true, alphaTest: 0.4,
  });
  {
    const ph = hash(instanceIndex.toFloat().add(0.61)).mul(6.2832);
    const w = uv().y.oneMinus();
    const sway = sin(time.mul(1.4).add(ph).add(w.mul(1.8))).mul(0.08);
    leafMat.positionNode = positionLocal.add(vec3(sway.mul(0.6), 0, sway));
    // rounded-diamond leaf mask + darker center vein
    const du = uv().x.sub(0.5).abs(), dv = uv().y.sub(0.5).abs();
    const dm = du.mul(2.1).add(dv.mul(1.7));
    leafMat.opacityNode = float(1).sub(smoothstep(0.75, 0.95, dm));
    const vein = smoothstep(0.05, 0.12, du);
    leafMat.colorNode = mix(color(0x6f9447), color(0x3d5c2a), dv.mul(1.6).clamp(0, 1))
      .mul(vein.mul(0.2).add(0.8));
    // moonlit sheen so ivy doesn't collapse to silhouette at night
    leafMat.emissive = new THREE.Color(0x101a0b);
  }

  // torch smoke: crossed quads, upward-thinning wisps driven by scrolling noise
  const wispBase = new THREE.PlaneGeometry(0.7, 2.6);
  wispBase.translate(0, 1.3, 0);
  const wispCross = wispBase.clone().rotateY(Math.PI / 2);
  const wispGeo = BufferGeometryUtils.mergeGeometries([wispBase, wispCross]);
  wispBase.dispose(); wispCross.dispose();
  const wispMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  {
    const ph = hash(instanceIndex.toFloat().add(0.29)).mul(6.2832);
    const v = uv().y, cx = uv().x.sub(0.5).abs().mul(2);
    const drift = sin(time.mul(0.7).add(ph).add(v.mul(2.6))).mul(v).mul(0.35);
    wispMat.positionNode = positionLocal.add(vec3(drift, 0, drift.mul(0.5)));
    const puff = triNoise3D(vec3(uv().x.mul(2.2), v.mul(1.9).sub(time.mul(0.22)), ph), 0, 0);
    wispMat.colorNode = mix(color(0x3a2c1d), color(0x151a24), v.clamp(0, 1));
    wispMat.opacityNode = float(1).sub(cx).clamp(0, 1).pow(1.6)
      .mul(float(1).sub(v)).mul(puff.mul(0.75).add(0.25)).mul(0.34)
      .mul(smoothstep(0.0, 0.1, v));
  }

  // drifting embers: tiny crossed quads on a looping rise, sine-wobbling
  const emberBase = new THREE.PlaneGeometry(0.09, 0.09);
  const emberCross = emberBase.clone().rotateY(Math.PI / 2);
  const emberGeo = BufferGeometryUtils.mergeGeometries([emberBase, emberCross]);
  emberBase.dispose(); emberCross.dispose();
  const emberMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  {
    const ph = hash(instanceIndex.toFloat().add(0.157)).mul(6.2832);
    const life = fract(time.mul(0.055).add(hash(instanceIndex.toFloat().add(0.31))));
    const rise = life.mul(5.5);
    const wob = vec3(
      sin(time.mul(0.9).add(ph)).mul(0.6),
      rise,
      sin(time.mul(0.7).add(ph.mul(1.7))).mul(0.6),
    );
    emberMat.positionNode = positionLocal.add(wob);
    const fadeIO = sin(life.mul(3.1416));
    const rad = float(1).sub(uv().sub(0.5).length().mul(2)).clamp(0, 1);
    emberMat.colorNode = mix(color(0xff9a3a), color(0xffd9a0), hash(ph)).mul(rad).mul(fadeIO).mul(2.2);
    emberMat.opacityNode = rad.mul(fadeIO);
  }

  // landmark light beams (portal / beacon): open cylinders fading with height
  const beamGeo = new THREE.CylinderGeometry(0.9, 1.6, 16, 12, 1, true);
  beamGeo.translate(0, 8, 0);
  const makeBeamMat = (c: number, strength: number) => {
    const m = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const v = uv().y; // 0 bottom → 1 top on the open cylinder
    const shimmer = sin(time.mul(1.3).add(uv().x.mul(12.56))).mul(0.15).add(0.85);
    m.colorNode = color(c).mul(float(1).sub(v).pow(1.8)).mul(shimmer).mul(strength);
    m.opacityNode = float(1).sub(v).pow(2).mul(0.16);
    return m;
  };

  // glowing rune architrave above the temple door
  const runeGeo = new THREE.PlaneGeometry(2.6, 0.42);
  const runeMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  {
    const u = uv().x, v = uv().y;
    const cellIdx = u.mul(9).floor();
    const fu = fract(u.mul(9));
    const gh = hash(cellIdx.add(3.7));
    // each cell draws a distinct dash-glyph: width/height gated by its hash
    const glyph = smoothstep(0.18, 0.24, fu).mul(float(1).sub(smoothstep(0.76, 0.82, fu)))
      .mul(smoothstep(0.16, 0.28, v.sub(gh.mul(0.28)))).mul(float(1).sub(smoothstep(0.72, 0.84, v.add(gh.mul(0.2)))));
    const pulse = sin(time.mul(1.1).add(u.mul(4))).mul(0.25).add(0.75);
    runeMat.colorNode = color(0x4d86ff).mul(glyph).mul(pulse).mul(2.4);
    runeMat.opacityNode = glyph;
  }

  S = {
    blockGeo: shadeFaces(new RoundedBoxGeometry(CELL * 1.02, COURSE * 1.02, CELL * 1.02, 1, 0.06)),
    blockGeoLo: shadeFaces(new THREE.BoxGeometry(CELL * 1.02, COURSE * 1.02, CELL * 1.02)),
    tileGeoLo: shadeFaces(new THREE.BoxGeometry(CELL * 0.985, 0.15, CELL * 0.985)),
    merlonGeo: shadeFaces(new RoundedBoxGeometry(0.72, 0.55, 0.72, 1, 0.05)),
    tileGeo: shadeFaces(new RoundedBoxGeometry(CELL * 0.985, 0.15, CELL * 0.985, 1, 0.045)),
    stepGeo: shadeFaces(new THREE.BoxGeometry(CELL * 1.0, TH / 4, CELL / 4 + 0.06)),
    cheekGeo: shadeFaces(new THREE.BoxGeometry(0.2, 0.32, CELL * 1.0)),
    bracketGeo: new THREE.BoxGeometry(0.14, 0.6, 0.14),
    bowlGeo: new THREE.CylinderGeometry(0.4, 0.2, 0.42, 8),
    postGeo: new THREE.CylinderGeometry(0.09, 0.11, 1.3, 6),
    plankGeo: new THREE.BoxGeometry((BRIDGE_SPAN / 12) * 0.8, 0.08, 1.15),
    flameGeo,
    wallGlowGeo: new THREE.PlaneGeometry(3.4, 3.0),
    floorGlowGeo: new THREE.PlaneGeometry(4.2, 4.2),
    bannerGeo,
    circleGeo: new THREE.CircleGeometry(1, 56),
    rubbleGeo: new THREE.DodecahedronGeometry(0.17, 0),
    crateGeo: shadeFaces(new THREE.BoxGeometry(0.72, 0.72, 0.72)),
    vineGeo,
    linkGeo: new THREE.BoxGeometry(0.07, 0.34, 0.16),
    mossGeo,
    colGeo,
    leafGeo,
    creeperGeo,
    emberGeo,
    emberMat,
    // craggy root spike under each island — nobody should see a flat underside
    plugGeo: (() => {
      const g = new THREE.CylinderGeometry(1, 0.06, 1, 8, 4);
      const pos = g.getAttribute("position");
      const rng2 = mulberry32(0x9e0c4);
      for (let i = 0; i < pos.count; i++) {
        const px2 = pos.getX(i), pz2 = pos.getZ(i);
        const r2 = Math.hypot(px2, pz2);
        if (r2 > 0.01) {
          const j = 0.78 + rng2() * 0.42;
          pos.setX(i, px2 * j);
          pos.setZ(i, pz2 * j);
        }
      }
      g.computeVertexNormals();
      return g;
    })(),
    plugMat: new THREE.MeshLambertNodeMaterial({ color: 0x10141f }),
    beamGeo,
    beamMatBlue: makeBeamMat(0x3e7bff, 0.9),
    beamMatWarm: makeBeamMat(0xffc26a, 0.7),
    brambleGeoA: buildBrambleGeo(0xb4a3b1e),
    brambleGeoB: buildBrambleGeo(0x7708a2),
    brambleMat: new THREE.MeshLambertNodeMaterial(),
    leafMat,
    wispGeo,
    runeGeo,
    vineMat,
    mossMat,
    wispMat,
    runeMat,
    portalGeo: new THREE.PlaneGeometry(1.8, 2.4),
    beaconGeo: new THREE.OctahedronGeometry(0.45),
    // Lambert = diffuse-only lighting: matte stone doesn't need GGX, and it
    // halves the per-light fragment cost across the entire masonry fill.
    stoneMat: makeStoneMat(),
    redMat,
    woodMat: new THREE.MeshLambertNodeMaterial(),
    flameWarm: makeFlameMat(0xffdd84, 0xff6a1a, 0xffeab0),
    flameBlue: makeFlameMat(0x9fd0ff, 0x2456ff, 0xeaf4ff),
    flameRed: makeFlameMat(0xffb08a, 0xff2410, 0xffe0c8),
    wallGlowMat,
    floorGlowMat,
    bannerMat,
    medallionBlue: makeMedallionMat(0x3d7dff, 0),
    medallionGold: makeMedallionMat(0xffb43a, 2),
    portalMat,
    beaconMat,
    smokeMat,
  };
  return S;
}

// ---------------------------------------------------------------------------
// Per-layout build.
// ---------------------------------------------------------------------------

/** A free-spanning rope bridge between two islands' gates. Shares the kit's
 *  geometries/materials; only per-span rope tubes are owned (and disposed). */
export function buildBridgeLink(a: THREE.Vector3, b: THREE.Vector3, slot: number, sceneRoot: THREE.Object3D): WorldHandle {
  const R = getShared();
  const pool = getSlot(slot, sceneRoot);
  const group = pool.group;
  group.name = "bridge-link";
  const ownGeos = pool.perBuildGeos;
  const delta = new THREE.Vector3().subVectors(b, a);
  const dist = delta.length();
  const dirN = delta.clone().normalize();
  const rotY = Math.atan2(dirN.z, dirN.x) * -1;
  const perp = new THREE.Vector3(-dirN.z, 0, dirN.x);
  const sagMax = Math.min(2.2, dist * 0.06);

  const planks: Inst[] = [];
  const nP = Math.max(6, Math.round(dist / 0.58));
  const plankW = 0.41; // R.plankGeo x-size × 0.8 packing
  for (let i = 0; i < nP; i++) {
    const t = (i + 0.5) / nP;
    const p = new THREE.Vector3().lerpVectors(a, b, t);
    const h1 = hash3(0x9a7b, i, nP, 7);
    planks.push(inst(
      p.x, p.y - Math.sin(t * Math.PI) * sagMax, p.z,
      rotY + (h1 - 0.5) * 0.07, (dist / nP / plankW) * 0.82, 1.2, 1.45, 0x4a3624,
    ));
  }
  putInstanced(pool, "bridgePlanks", R.plankGeo, R.woodMat, planks, true);

  for (const side of [-0.8, 0.8]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const p = new THREE.Vector3().lerpVectors(a, b, t);
      pts.push(new THREE.Vector3(
        p.x + perp.x * side, p.y + 0.7 - Math.sin(t * Math.PI) * (sagMax + 0.35), p.z + perp.z * side,
      ));
    }
    const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.05, 5);
    ownGeos.push(geo);
    const rope = new THREE.Mesh(geo, R.woodMat);
    group.add(rope);
    pool.perBuild.push(rope);
  }

  const posts: Inst[] = [];
  const stones: Inst[] = [];
  const flames: Inst[] = [];
  const c = new THREE.Color();
  for (const [end, sgn] of [[a, 1], [b, -1]] as const) {
    for (const side of [-0.8, 0.8]) {
      posts.push(inst(end.x + perp.x * side, end.y + 0.7, end.z + perp.z * side, rotY, 1.25, 1.5, 1.25, 0x3a2c1c));
    }
    c.setHSL(0.09, 0.3, 0.4);
    stones.push(inst(end.x + dirN.x * sgn * 0.4, end.y - 0.4, end.z + dirN.z * sgn * 0.4, rotY, 0.85, 1.2, 1.9, c.getHex()));
    flames.push(inst(end.x + perp.x * 0.8, end.y + 1.6, end.z + perp.z * 0.8, 0, 0.8, 0.85, 0.8, 0xffffff));
  }
  putInstanced(pool, "bridgePosts", R.postGeo, R.woodMat, posts, true);
  putInstanced(pool, "linkStones", R.blockGeo, R.stoneMat, stones, true);
  putInstanced(pool, "linkFlames", R.flameGeo, R.flameWarm, flames, false);

  return {
    group,
    lights: [],
    tick() {},
    dispose() { /* slots persist — pruneSlots() hides unused ones */ },
  };
}

export function buildWorld(l: Layout, slot: number, sceneRoot: THREE.Object3D, rootScale = 1): WorldHandle {
  const R = getShared();
  const { N, kind, tier, wallTop, wallBase, support } = l;
  const gi = (x: number, y: number) => y * N + x;
  const wx = (gx: number) => (gx - (N - 1) / 2) * CELL;
  const wz = (gy: number) => (gy - (N - 1) / 2) * CELL;
  const seed = l.seed;

  const pool = getSlot(slot, sceneRoot);
  const group = pool.group;
  group.name = "fortress";
  const addUnique = (o: THREE.Object3D) => { group.add(o); pool.perBuild.push(o); };
  // geometries unique to this layout (bridge ropes) — everything else is shared
  const perBuildGeos = pool.perBuildGeos;

  // ---------------------------------------------------------------- masonry
  const blocks: Inst[] = [];
  const merlons: Inst[] = [];
  const tiles: Inst[] = [];
  const redTiles: Inst[] = [];
  const stoneColor = new THREE.Color();

  const isTempleBuilding = (x: number, y: number) => y === 1 && l.temple !== null && Math.abs(x - l.temple.cx) <= 2;

  // Interior maze walls are slimmer than the corridors they divide: thin across
  // their run direction, with fatter posts at crossings. Ramparts (boundary or
  // void-facing), towers and the temple building stay full-width.
  const thin = Math.min(1, Math.max(0.25, l.params?.wallThin ?? 0.45));
  const post = Math.min(1, thin + 0.22); // crossing pillars slightly proud of the slabs
  const wallDims = (x: number, y: number): { sx: number; sz: number } => {
    if (x === 0 || y === 0 || x === N - 1 || y === N - 1) return { sx: 1, sz: 1 };
    if (isTempleBuilding(x, y)) return { sx: 1, sz: 1 };
    if (l.towers.some((t) => t.x === x && t.y === y)) return { sx: 1, sz: 1 };
    let voidAdj = false, fx = false, fz = false;
    for (let d = 0; d < 4; d++) {
      const n = gi(x + DX[d], y + DY[d]);
      if (kind[n] === VOID) voidAdj = true;
      if (kind[n] === FLOOR) (DX[d] !== 0 ? (fx = true) : (fz = true));
    }
    if (voidAdj) return { sx: 1, sz: 1 };
    if (fx && !fz) return { sx: thin, sz: 1 };
    if (fz && !fx) return { sx: 1, sz: thin };
    if (fx && fz) return { sx: post, sz: post };
    return { sx: Math.min(1, post + 0.1), sz: Math.min(1, post + 0.1) }; // interior junction posts
  };
  const wallHalf = (x: number, y: number, d: Dir): number => {
    const dims = wallDims(x, y);
    return (d <= 1 ? dims.sx : dims.sz) * CELL * 0.5;
  };

  // Occlusion tier: the height below which every side of a column is hidden by
  // its 4 neighbors — those courses never rasterize (topmost course always kept
  // for the visible cap face).
  const occlAt = (x: number, y: number): number => {
    let o = Infinity;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) return ABYSS;
      const n = gi(nx, ny);
      if (kind[n] === FLOOR) o = Math.min(o, tier[n]);
      else if (kind[n] === WALL) {
        // a slimmed wall no longer hides its neighbor's flank — only count
        // full-width neighbors as occluders above their base
        const nd = wallDims(nx, ny);
        o = Math.min(o, nd.sx === 1 && nd.sz === 1 ? wallTop[n] : wallBase[n]);
      } else return ABYSS;
    }
    return o;
  };

  const pushCourses = (
    x: number, y: number, baseTier: number, topTier: number,
    refFloorTier: number, scaleXZ: number, warm: number,
    dims: { sx: number; sz: number } = { sx: 1, sz: 1 },
  ) => {
    const cx = wx(x), cz = wz(y);
    const nCourses = Math.max(0, Math.round((topTier - baseTier) * TH / COURSE));
    const doorCell = l.doorMask[gi(x, y)] === 1;
    const occlH = occlAt(x, y) * TH;
    for (let k = 0; k < nCourses; k++) {
      const y0 = baseTier * TH + k * COURSE;
      const yMid = y0 + COURSE / 2;
      if (k < nCourses - 1 && y0 + COURSE <= occlH - 0.01) continue; // fully hidden
      if (doorCell && l.door) {
        const gapLo = l.door.tier * TH, gapHi = l.door.tier * TH + 2.6;
        if (yMid > gapLo && yMid < gapHi) continue; // doorway gap (lintel above survives)
      }
      const h1 = hash3(seed, x * 131 + y, k, 1);
      const h2v = hash3(seed, x * 131 + y, k, 2);
      const h3v = hash3(seed, x * 131 + y, k, 3);
      // baked AO: courses far below the nearest floor sit in shadowed crevices
      const rel = Math.min(1, Math.max(0, (yMid - refFloorTier * TH) / (2.6 * TH) + 0.72));
      const lum = (0.54 + h1 * 0.17) * (0.55 + 0.45 * rel);
      const hue = 0.092 + warm * 0.012 + (h2v - 0.5) * 0.016;
      const sat = 0.42 + warm * 0.08 + (h3v - 0.5) * 0.08;
      stoneColor.setHSL(hue, sat, lum);
      if (yMid < refFloorTier * TH + COURSE && h1 < 0.12) stoneColor.lerp(new THREE.Color(0x39442a), 0.45); // moss
      const jx = (h2v - 0.5) * 0.07 + ((k % 2) ? 0.035 : -0.035);
      const jz = (h3v - 0.5) * 0.07 + ((k % 2) ? -0.035 : 0.035);
      // cornice ring every 5th course on towers — segmented silhouette
      const cornice = scaleXZ > 1.2 && k % 5 === 4 ? 1.14 : 1;
      const s = scaleXZ * cornice * (0.985 + h1 * 0.045);
      blocks.push(inst(cx + jx, yMid, cz + jz, (h1 - 0.5) * 0.05, s * dims.sx, 1, s * dims.sz, stoneColor.getHex()));
    }
  };

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const c = gi(x, y);
      if (kind[c] === WALL) {
        let ref = wallBase[c];
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (nx >= 0 && ny >= 0 && nx < N && ny < N && kind[gi(nx, ny)] === FLOOR) ref = Math.max(ref, tier[gi(nx, ny)]);
        }
        const tower = l.towers.find((t) => t.x === x && t.y === y);
        const warm = isTempleBuilding(x, y) ? 1 : 0;
        const dims = wallDims(x, y);
        pushCourses(x, y, wallBase[c], wallTop[c], ref, tower ? tower.scale : 1, warm, dims);
        // slim walls expose strips of the cell — pave them so the corridor
        // floor reads as continuing beneath the wall
        if (dims.sx < 1 || dims.sz < 1) {
          const hp = hash2(seed, c, 23);
          stoneColor.setHSL(0.088, 0.22, 0.34 + hp * 0.1);
          tiles.push(inst(wx(x), wallBase[c] * TH + 0.07, wz(y), 0, 0.995, 1, 0.995, stoneColor.getHex()));
        }
        // battlement teeth ONLY where the wall meets the outside or the ravine —
        // interior maze walls keep clean tops (center studs read as lego bricks)
        let voidDir = -1;
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (nx < 0 || ny < 0 || nx >= N || ny >= N || kind[gi(nx, ny)] === VOID) { voidDir = d; break; }
        }
        if (voidDir >= 0 && !tower && !l.doorMask[c] && !l.ruinMask[c]) {
          const alongX = DY[voidDir] !== 0; // rim runs perpendicular to the void
          for (const off of [-0.58, 0.58]) {
            stoneColor.setHSL(0.09, 0.34, 0.38 + hash2(seed, c, 9) * 0.1);
            merlons.push(inst(
              wx(x) + (alongX ? off : 0), wallTop[c] * TH + 0.16, wz(y) + (alongX ? 0 : off),
              0, 0.8, 0.92, 0.8, stoneColor.getHex(),
            ));
          }
        }
        if (tower) {
          for (const [mx, mz] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) {
            stoneColor.setHSL(0.075, 0.3, 0.38);
            merlons.push(inst(wx(x) + mx * tower.scale, tower.top * TH + 0.18, wz(y) + mz * tower.scale, 0, 0.9, 1.15, 0.9, stoneColor.getHex()));
          }
        }
      } else if (kind[c] === FLOOR && support[c] < tier[c]) {
        pushCourses(x, y, support[c], tier[c], tier[c], 1, 0);
      }
    }
  }

  // temple facade: pilasters flanking the doorway + a proud lintel course
  if (l.temple && l.door) {
    const T = l.temple;
    const faceZ = wz(1) + CELL / 2 + 0.14;
    for (const px of [wx(T.cx - 1) + CELL * 0.38, wx(T.cx + 1) - CELL * 0.38]) {
      const nC = Math.round(((T.buildTop - T.platformTier) * TH - 0.4) / COURSE);
      for (let k = 0; k < nC; k++) {
        stoneColor.setHSL(0.1, 0.46, 0.5 + hash3(seed, k, 5, 8) * 0.1);
        blocks.push(inst(px, T.platformTier * TH + (k + 0.5) * COURSE, faceZ, 0, 0.34, 0.98, 0.22, stoneColor.getHex()));
      }
    }
    stoneColor.setHSL(0.1, 0.48, 0.56);
    blocks.push(inst(wx(T.cx), l.door.tier * TH + 2.75, faceZ, 0, 1.55, 0.85, 0.24, stoneColor.getHex()));
  }
  // pavilion roof slabs on towers
  for (const t of l.towers) {
    stoneColor.setHSL(0.09, 0.36, 0.42);
    blocks.push(inst(wx(t.x), t.top * TH + (t.beacon ? 1.9 : 0) + 0.1, wz(t.y), 0, t.scale * 1.22, t.beacon ? 0.55 : 0.45, t.scale * 1.22, stoneColor.getHex()));
    if (t.beacon) {
      // four corner posts holding the roof over the beacon
      for (const [mx, mz] of [[-0.62, -0.62], [0.62, -0.62], [-0.62, 0.62], [0.62, 0.62]]) {
        stoneColor.setHSL(0.09, 0.34, 0.38);
        blocks.push(inst(wx(t.x) + mx * t.scale, t.top * TH + 1.0, wz(t.y) + mz * t.scale, 0, 0.22, 2.4, 0.22, stoneColor.getHex()));
      }
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
        stoneColor.setHSL(0.015, 0.5, 0.14 + h1 * 0.05);
        target = redTiles;
      } else if (l.templeMask[c]) {
        stoneColor.setHSL(0.1, 0.4, 0.5 + h1 * 0.14);
      } else if (l.plazaMask[c]) {
        stoneColor.setHSL(0.09, 0.3, 0.43 + h1 * 0.12);
      } else {
        stoneColor.setHSL(0.088 + (h2v - 0.5) * 0.02, 0.24, 0.37 + h1 * 0.13);
      }
      target.push(inst(
        wx(x) + (h2v - 0.5) * 0.05, tier[c] * TH + 0.07, wz(y) + (h1 - 0.5) * 0.05,
        (h1 - 0.5) * 0.04, 0.985, 1, 0.985, stoneColor.getHex(),
      ));
    }
  }
  // ---------------------------------------------------------------- stairs
  const steps: Inst[] = [];
  const cheeks: Array<{ m: THREE.Matrix4; c: THREE.Color }> = [];
  const slope = Math.atan2(TH, CELL);
  for (const s of l.stairs) {
    const rot = dirRotY(s.dir);
    const fx = DX[s.dir], fz = DY[s.dir];
    for (let i = 0; i < 4; i++) {
      const along = -CELL / 2 + (i + 0.5) * (CELL / 4);
      const h1 = hash3(seed, s.x * 57 + s.y, i, 4);
      // lighter treads than the surrounding pavement so flights read at a glance
      stoneColor.setHSL(0.09, 0.28, 0.42 + h1 * 0.1);
      steps.push(inst(
        wx(s.x) + fx * along, s.tier * TH + (i + 0.5) * (TH / 4), wz(s.y) + fz * along,
        rot, 1, 1.06, 1, stoneColor.getHex(),
      ));
    }
    // sloped stringer cheeks flanking the flight — the strongest stair cue
    const px = -fz, pz = fx; // perpendicular
    const qYaw = new THREE.Quaternion().setFromAxisAngle(_axisY, rot);
    const qPitch = new THREE.Quaternion().setFromEuler(new THREE.Euler(-slope, 0, 0));
    const q = qYaw.clone().multiply(qPitch);
    for (const sgn of [-1, 1]) {
      stoneColor.setHSL(0.085, 0.26, 0.3 + hash3(seed, s.x, s.y, sgn + 5) * 0.06);
      const pos = new THREE.Vector3(
        wx(s.x) + px * sgn * (CELL / 2 - 0.1), s.tier * TH + TH * 0.5 + 0.02, wz(s.y) + pz * sgn * (CELL / 2 - 0.1),
      );
      cheeks.push({ m: new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1)), c: stoneColor.clone() });
    }
  }

  // ---------------------------------------------------------------- torches & braziers
  const brackets: Inst[] = [];
  const warmFlames: Inst[] = [];
  const blueFlames: Inst[] = [];
  const redFlames: Inst[] = [];
  const flameAnchors: Array<{ x: number; y: number; z: number }> = [];

  for (const t of l.torches) {
    const rot = dirRotY(t.dir);
    const fx = DX[t.dir], fz = DY[t.dir];
    const half = wallHalf(t.x, t.y, t.dir);
    const px = wx(t.x) + fx * (half + 0.12);
    const pz = wz(t.y) + fz * (half + 0.12);
    const py = t.tier * TH + 1.9;
    brackets.push(inst(px, py - 0.28, pz, rot, 1, 1, 1, 0x2a2018));
    warmFlames.push(inst(px + fx * 0.08, py, pz + fz * 0.08, rot, 1, 1, 1, 0xffffff));
    flameAnchors.push({ x: px, y: py + 0.3, z: pz });
  }

  const bowls: Inst[] = [];
  for (const b of l.braziers) {
    const px = wx(b.x), pz = wz(b.y);
    // totems stand on a carved stone pillar; plaza braziers sit on the ground
    const lift = b.totem ? 1.15 : 0;
    const py = b.tier * TH + 0.15 + lift;
    if (b.totem) {
      stoneColor.setHSL(0.09, 0.3, 0.3 + hash2(seed, b.x * 91 + b.y, 12) * 0.08);
      blocks.push(inst(px, b.tier * TH + 0.65, pz, hash2(seed, b.x, b.y) * 0.4, 0.2, 1.6, 0.2, stoneColor.getHex()));
    }
    bowls.push(inst(px, py + 0.42, pz, 0, 1, 1, 1, 0x241d16));
    const f = inst(px, py + 0.72, pz, 0, 1.55, 1.75, 1.55, 0xffffff);
    (b.kind === "blue" ? blueFlames : b.kind === "red" ? redFlames : warmFlames).push(f);
    flameAnchors.push({ x: px, y: py + 1.1, z: pz });
  }

  putInstanced(pool, "brackets", R.bracketGeo, R.woodMat, brackets, false);
  putInstanced(pool, "bowls", R.bowlGeo, R.woodMat, bowls, true);

  // fake local torchlight: wall glow + a pool of light on the floor beneath
  {
    const wallGlows: Inst[] = [];
    for (const t of l.torches) {
      const rot = dirRotY(t.dir);
      const fx = DX[t.dir], fz = DY[t.dir];
      const half = wallHalf(t.x, t.y, t.dir);
      wallGlows.push(inst(
        wx(t.x) + fx * (half + 0.05), t.tier * TH + 1.7, wz(t.y) + fz * (half + 0.05),
        rot, 1, 1, 1, 0xffffff,
      ));
    }
    putInstanced(pool, "wallGlows", R.wallGlowGeo, R.wallGlowMat, wallGlows, false);

    const floorGlows: Inst[] = [];
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const one = new THREE.Vector3(1, 1, 1);
    for (const t of l.torches) {
      const fx = DX[t.dir], fz = DY[t.dir];
      const half = wallHalf(t.x, t.y, t.dir);
      const p = new THREE.Vector3(wx(t.x) + fx * (half + 0.7), t.tier * TH + 0.19, wz(t.y) + fz * (half + 0.7));
      floorGlows.push({ m: new THREE.Matrix4().compose(p, q, one), c: new THREE.Color(0xffffff) });
    }
    for (const b of l.braziers) {
      const p = new THREE.Vector3(wx(b.x), b.tier * TH + 0.21, wz(b.y));
      const sc = new THREE.Vector3(1.6, 1.6, 1.6);
      floorGlows.push({ m: new THREE.Matrix4().compose(p, q, sc), c: new THREE.Color(0xffffff) });
    }
    putInstanced(pool, "floorGlows", R.floorGlowGeo, R.floorGlowMat, floorGlows, false);
  }

  // ---------------------------------------------------------------- banners
  {
    const items: Inst[] = [];
    for (const b of l.banners) {
      const rot = dirRotY(b.dir);
      const fx = DX[b.dir], fz = DY[b.dir];
      const half = wallHalf(b.x, b.y, b.dir);
      const hang = Math.min(b.top * TH - 0.5, b.tier * TH + 4.6);
      items.push(inst(
        wx(b.x) + fx * (half + 0.1), hang, wz(b.y) + fz * (half + 0.1),
        rot, 1, 1, 1, 0xffffff,
      ));
    }
    putInstanced(pool, "banners", R.bannerGeo, R.bannerMat, items, false);
  }

  // ---------------------------------------------------------------- medallions
  for (const m of l.medallions) {
    const mesh = new THREE.Mesh(R.circleGeo, m.kind === "blue" ? R.medallionBlue : R.medallionGold);
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.setScalar(m.r * CELL);
    mesh.position.set(wx(m.x), m.tier * TH + 0.17, wz(m.y));
    mesh.receiveShadow = true;
    addUnique(mesh);
  }

  // ---------------------------------------------------------------- temple portal
  if (l.door) {
    const mesh = new THREE.Mesh(R.portalGeo, R.portalMat);
    mesh.position.set(wx(l.door.x), l.door.tier * TH + 1.25, wz(l.door.y) + CELL / 2 - 0.18);
    addUnique(mesh);
    // glowing rune architrave carved into the lintel above the doorway
    const rune = new THREE.Mesh(R.runeGeo, R.runeMat);
    rune.position.set(wx(l.door.x), l.door.tier * TH + 2.95, wz(l.door.y) + CELL / 2 + 0.16);
    addUnique(rune);
  }

  // ---------------------------------------------------------------- bridge
  if (l.bridge) {
    const b = l.bridge;
    const x0 = wx(b.x0) + CELL * 0.4, x1 = wx(b.x1) - CELL * 0.4;
    const z = wz(b.y);
    const yTop = b.tier * TH + 0.1;
    const planks: Inst[] = [];
    const nP = 14;
    for (let i = 0; i < nP; i++) {
      const t = (i + 0.5) / nP;
      const x = x0 + (x1 - x0) * t;
      const sag = Math.sin(t * Math.PI) * 0.7;
      const h1 = hash3(seed, 999, i, 7);
      planks.push(inst(x, yTop - sag, z, (h1 - 0.5) * 0.1, 1, 1.2, 1.45, 0x4a3624));
    }
    putInstanced(pool, "ravinePlanks", R.plankGeo, R.woodMat, planks, true);
    for (const side of [-0.8, 0.8]) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        pts.push(new THREE.Vector3(x0 + (x1 - x0) * t, yTop + 0.7 - Math.sin(t * Math.PI) * 0.95, z + side));
      }
      const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.05, 5);
      perBuildGeos.push(geo);
      addUnique(new THREE.Mesh(geo, R.woodMat));
    }
    const posts: Inst[] = [];
    for (const px of [x0, x1]) for (const side of [-0.8, 0.8]) {
      posts.push(inst(px, yTop + 0.7, z + side, 0, 1.25, 1.45, 1.25, 0x3a2c1c));
    }
    putInstanced(pool, "ravinePosts", R.postGeo, R.woodMat, posts, true);
    // stone abutments anchoring both ends + a lantern flame on each near post
    for (const [ax, sgn] of [[x0, -1], [x1, 1]] as const) {
      stoneColor.setHSL(0.09, 0.3, 0.4);
      blocks.push(inst(ax + sgn * 0.5, yTop - 0.35, z, 0, 0.75, 1.15, 1.9, stoneColor.getHex()));
      warmFlames.push(inst(ax, yTop + 1.55, z + 0.8, 0, 0.8, 0.85, 0.8, 0xffffff));
      flameAnchors.push({ x: ax, y: yTop + 1.7, z: z + 0.8 });
    }
  }

  // ---------------------------------------------------------------- beacons
  for (const t of l.towers) {
    if (!t.beacon) continue;
    const mesh = new THREE.Mesh(R.beaconGeo, R.beaconMat);
    mesh.position.set(wx(t.x), t.top * TH + 1.0, wz(t.y));
    addUnique(mesh);
    flameAnchors.push({ x: wx(t.x), y: t.top * TH + 1.2, z: wz(t.y) });
  }

  // ---------------------------------------------------------------- smoke
  const smokes: THREE.Sprite[] = [];
  for (let k = 0; k < 18; k++) {
    const s = new THREE.Sprite(R.smokeMat);
    const a = hash2(seed, k, 41) * Math.PI * 2;
    const rad = 18 + hash2(seed, k, 42) * 26;
    if (k < 7 && l.bridge) {
      s.position.set(wx(l.bridge.x0 + 2) + (hash2(seed, k, 43) - 0.5) * 8, -1 - hash2(seed, k, 44) * 5, wz(Math.round(N * 0.75)) + (hash2(seed, k, 45) - 0.5) * 18);
    } else {
      s.position.set(Math.cos(a) * rad, -2 - hash2(seed, k, 46) * 6, Math.sin(a) * rad);
    }
    const sc = 9 + hash2(seed, k, 47) * 9;
    s.scale.set(sc, sc * 0.62, 1);
    (s.userData as { ph: number }).ph = hash2(seed, k, 48) * Math.PI * 2;
    (s.userData as { bx: number }).bx = s.position.x;
    smokes.push(s);
    addUnique(s);
  }

  // ---------------------------------------------- weathering & clutter pass
  const rubble: Inst[] = [];
  const crates: Inst[] = [];
  const vines: Inst[] = [];
  const leaves: Inst[] = [];
  const creepers: Inst[] = [];
  const bramblesA: Inst[] = [];
  const bramblesB: Inst[] = [];
  const links: Inst[] = [];
  const moss: Inst[] = [];
  const cols: Inst[] = [];
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
              stoneColor.setHSL(0.08, 0.22, 0.24 + ha * 0.2);
              const sc = 0.8 + hb * 1.2;
              rubble.push(inst(
                wx(x) + ox + (ha - 0.5) * 0.9, tier[c] * TH + 0.14 + sc * 0.07, wz(y) + oz + (hb - 0.5) * 0.9,
                hc * 6.28, sc, sc * (0.5 + hc * 0.4), sc, stoneColor.getHex(),
              ));
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
              stoneColor.setHSL(0.25 + hb * 0.05, 0.35, 0.24 + ha * 0.1);
              const sc = 0.7 + ha * 1.3;
              moss.push(inst(
                wx(x) + mx + (ha - 0.5) * 1.0, tier[c] * TH + 0.157 + k * 0.004, wz(y) + mz + (hb - 0.5) * 1.0,
                hb * 6.28, sc, 1, sc * (0.7 + hb * 0.5), stoneColor.getHex(),
              ));
            }
          }
          // crates in quiet dead ends the totems didn't claim
          let deg = 0;
          for (let d = 0; d < 4; d++) if (kind[gi(x + DX[d], y + DY[d])] === FLOOR) deg++;
          if (deg === 1 && !totemCells.has(c) && hash2(seed, c, 76) < 0.4 && !(x === l.entrance.x && y === l.entrance.y)) {
            const ha = hash2(seed, c, 77);
            crates.push(inst(wx(x) + (ha - 0.5) * 0.5, tier[c] * TH + 0.51, wz(y) + (ha - 0.5) * 0.4, ha * 1.5, 1, 1, 1, 0x4d3a22));
            if (ha < 0.45) crates.push(inst(wx(x) + (ha - 0.5) * 0.5 + 0.3, tier[c] * TH + 1.15, wz(y) + (ha - 0.5) * 0.4 - 0.2, ha * 4, 0.72, 0.72, 0.72, 0x423120));
          }
        }
        // moss on wall-top walkways too
        if (kind[c] === WALL && hash2(seed, c, 86) < 0.2 * decay) {
          const ha = hash2(seed, c, 87);
          stoneColor.setHSL(0.26, 0.32, 0.22 + ha * 0.08);
          const sc = 0.6 + ha * 0.9;
          moss.push(inst(
            wx(x) + (ha - 0.5) * 0.8, wallTop[c] * TH + 0.03, wz(y) + (0.5 - ha) * 0.8,
            ha * 6.28, sc, 1, sc, stoneColor.getHex(),
          ));
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
            stoneColor.setHSL(0.07 + ha * 0.02, 0.25, 0.16 + ha * 0.08);
            const item = inst(
              wx(x) + fx * (half + 0.04) + (fz !== 0 ? lat : 0),
              baseY,
              wz(y) + fz * (half + 0.04) + (fx !== 0 ? lat : 0),
              dirRotY(d as Dir), sc * (ha < 0.5 ? 1 : -1), sc * (0.75 + ha * 0.35), sc, stoneColor.getHex(),
            );
            (hbv < 0.5 ? bramblesA : bramblesB).push(item);
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
              stoneColor.setHSL(0.24 + hb * 0.06, 0.44, 0.36 + ha * 0.16);
              creepers.push(inst(
                wx(x) + fx * (half + 0.05) + (fz !== 0 ? lat : 0),
                tier[n] * TH + 0.15 + k * (availH / stack) * 0.92,
                wz(y) + fz * (half + 0.05) + (fx !== 0 ? lat : 0),
                rot, sx2, sy, 1, stoneColor.getHex(),
              ));
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
              const px2 = wx(x) + fx * (half + 0.08) + (fz !== 0 ? lat : 0);
              const pz2 = wz(y) + fz * (half + 0.08) + (fx !== 0 ? lat : 0);
              const py2 = wallTop[c] * TH - 0.05 - hb * 0.3;
              const rot = dirRotY(d as Dir);
              const sw = 1.1 + hb * 0.9, sh = 0.75 + ha * 0.8;
              stoneColor.setHSL(0.26 + hb * 0.06, 0.3, 0.2 + ha * 0.1);
              vines.push(inst(px2, py2, pz2, rot, sw * 0.5, sh, 1, stoneColor.getHex()));
              // the leaf cluster is what actually reads — brighter, bigger
              stoneColor.setHSL(0.24 + hb * 0.07, 0.45, 0.42 + ha * 0.16);
              leaves.push(inst(px2, py2, pz2, rot, sw, sh, sw, stoneColor.getHex()));
            }
          }
        }
      }
    }
    // ring of ancient columns around each medallion plaza — most broken, a few
    // still crowned with their capital
    for (let mIdx = 0; mIdx < l.medallions.length; mIdx++) {
      const m = l.medallions[mIdx];
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + mIdx * 0.4;
        const px2 = wx(m.x) + Math.cos(a) * (m.r + 0.55) * CELL;
        const pz2 = wz(m.y) + Math.sin(a) * (m.r + 0.55) * CELL * 0.98;
        const h = hash3(seed, mIdx * 31, k, 95);
        if (h > 0.8) continue; // a few are gone entirely
        const py2 = m.tier * TH + 0.12;
        stoneColor.setHSL(0.09, 0.28, 0.4 + h * 0.12);
        if (h < 0.35) {
          // intact column with capital
          const ch = 2.4 + h * 1.2;
          cols.push(inst(px2, py2, pz2, h * 6.28, 1, ch, 1, stoneColor.getHex()));
          blocks.push(inst(px2, py2 + ch + 0.12, pz2, h * 3, 0.26, 0.22, 0.26, stoneColor.getHex()));
        } else {
          // broken stump, slightly tilted, rubble at its foot
          const ch = 0.5 + h * 1.6;
          const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((h - 0.5) * 0.1, h * 6.28, (h - 0.6) * 0.1));
          const pos = new THREE.Vector3(px2, py2, pz2);
          cols.push({ m: new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, ch, 1)), c: stoneColor.clone() });
          const hr = hash3(seed, mIdx * 31, k, 96);
          stoneColor.setHSL(0.08, 0.2, 0.26 + hr * 0.1);
          rubble.push(inst(px2 + (hr - 0.5), py2 + 0.12, pz2 + (0.5 - hr), hr * 6, 0.7 + hr, 0.5, 0.7 + hr, stoneColor.getHex()));
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
          links.push(inst(
            wx(r.x) + fx * (CELL / 2 + out), topY + (endY - topY) * t, wz(r.y) + fz * (CELL / 2 + out),
            dirRotY(r.d) + (i % 2) * Math.PI / 2, 1.15, 1.15, 1.15, 0x191a20,
          ));
        }
      }
    }
  }

  // underside root spike: hides the flat bottoms of the abyss columns.
  // stacked upper layers get a stub (rootScale < 1) so their roots don't
  // skewer the block living beneath them
  {
    const halfW = (N * CELL) / 2;
    const depth = (26 + halfW * 0.5) * rootScale;
    const plug = new THREE.Mesh(R.plugGeo, R.plugMat);
    plug.scale.set(halfW * 0.8, depth, halfW * 0.8);
    plug.position.y = ABYSS * TH + 1.5 - depth / 2;
    addUnique(plug);
  }

  // ------------------------------------------------------- instanced meshes
  // created last so every section above could still contribute masonry/flames
  putInstanced(pool, "blocks", R.blockGeo, R.stoneMat, blocks);
  putInstanced(pool, "merlons", R.merlonGeo, R.stoneMat, merlons);
  putInstanced(pool, "tiles", R.tileGeo, R.stoneMat, tiles, true);
  putInstanced(pool, "redTiles", R.tileGeo, R.redMat, redTiles, true);
  putInstanced(pool, "steps", R.stepGeo, R.stoneMat, steps);
  putInstanced(pool, "cheeks", R.cheekGeo, R.stoneMat, cheeks);
  putInstanced(pool, "flamesW", R.flameGeo, R.flameWarm, warmFlames, false);
  putInstanced(pool, "flamesB", R.flameGeo, R.flameBlue, blueFlames, false);
  putInstanced(pool, "flamesR", R.flameGeo, R.flameRed, redFlames, false);
  putInstanced(pool, "rubble", R.rubbleGeo, R.stoneMat, rubble, true);
  putInstanced(pool, "crates", R.crateGeo, R.woodMat, crates, true);
  putInstanced(pool, "vines", R.vineGeo, R.vineMat, vines, false);
  putInstanced(pool, "leaves", R.leafGeo, R.leafMat, leaves, false);
  putInstanced(pool, "creepers", R.creeperGeo, R.leafMat, creepers, false);
  putInstanced(pool, "bramblesA", R.brambleGeoA, R.brambleMat, bramblesA, false);
  putInstanced(pool, "bramblesB", R.brambleGeoB, R.brambleMat, bramblesB, false);
  putInstanced(pool, "links", R.linkGeo, R.woodMat, links, false);
  putInstanced(pool, "moss", R.mossGeo, R.mossMat, moss, false);
  putInstanced(pool, "cols", R.colGeo, R.stoneMat, cols, true);
  // smoke wisps rising from every flame
  {
    const wisps: Inst[] = [];
    for (const a of flameAnchors) {
      const h = hash2(seed, Math.round(a.x * 7 + a.z * 13), 97);
      wisps.push(inst(a.x, a.y + 0.15, a.z, h * 6.28, 0.8 + h * 0.5, 0.8 + h * 0.6, 0.8 + h * 0.5, 0xffffff));
    }
    putInstanced(pool, "wisps", R.wispGeo, R.wispMat, wisps, false);
  }
  // drifting embers: a few near every flame + strays wandering the corridors
  {
    const embers: Inst[] = [];
    for (const a of flameAnchors) {
      const h = hash2(seed, Math.round(a.x * 11 + a.z * 5), 98);
      const n = 2 + Math.floor(h * 2);
      for (let k = 0; k < n; k++) {
        const hk = hash3(seed, Math.round(a.x * 3), k, 99);
        embers.push(inst(a.x + (hk - 0.5) * 1.4, a.y - 0.4, a.z + (h - 0.5) * 1.4, 0, 0.6 + hk, 0.6 + hk, 0.6 + hk, 0xffffff));
      }
    }
    for (let k = 0; k < 40; k++) {
      const hx = hash2(seed, k, 104), hz = hash2(seed, k, 105);
      const gx2 = 1 + Math.floor(hx * (N - 2)), gy2 = 1 + Math.floor(hz * (N - 2));
      const c2 = gi(gx2, gy2);
      if (kind[c2] !== FLOOR) continue;
      embers.push(inst(wx(gx2), tier[c2] * TH + 0.6, wz(gy2), 0, 0.5 + hx * 0.7, 0.5 + hx * 0.7, 0.5 + hx * 0.7, 0xffffff));
    }
    putInstanced(pool, "embers", R.emberGeo, R.emberMat, embers, false);
  }
  // landmark beams: the portal breathes blue into the night, the beacon gold
  if (l.door) {
    const beam = new THREE.Mesh(R.beamGeo, R.beamMatBlue);
    beam.position.set(wx(l.door.x), l.door.tier * TH + 2.2, wz(l.door.y));
    addUnique(beam);
  }
  for (const t of l.towers) {
    if (!t.beacon) continue;
    const beam = new THREE.Mesh(R.beamGeo, R.beamMatWarm);
    beam.scale.set(0.55, 0.8, 0.55);
    beam.position.set(wx(t.x), t.top * TH + 0.8, wz(t.y));
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
      let first = flameAnchors[0];
      for (const a of flameAnchors) if (a.x * a.x + a.z * a.z < first.x * first.x + first.z * first.z) first = a;
      chosen.push(first);
      const poolSize = l.N >= 25 ? 9 : 5; // satellites get a smaller light budget
      while (chosen.length < Math.min(poolSize, flameAnchors.length)) {
        let best = flameAnchors[0], bestD = -1;
        for (const a of flameAnchors) {
          let dMin = Infinity;
          for (const c of chosen) dMin = Math.min(dMin, Math.hypot(a.x - c.x, a.z - c.z));
          if (dMin > bestD) { bestD = dMin; best = a; }
        }
        if (bestD <= 0) break;
        chosen.push(best);
      }
    }
    let li = 0;
    for (const c of chosen) {
      lights.push({ x: c.x, y: c.y + 0.2, z: c.z, color: 0xff9a45, base: 50, dist: 19, ph: hash2(seed, li++, 61) * Math.PI * 2 });
    }
    if (l.door) {
      lights.push({ x: wx(l.door.x), y: l.door.tier * TH + 1.6, z: wz(l.door.y) + 1.6, color: 0x3e7bff, base: 26, dist: 16, ph: 1.1 });
    }
    for (const b of l.braziers) {
      if (b.kind !== "red") continue;
      lights.push({ x: wx(b.x), y: b.tier * TH + 1.4, z: wz(b.y), color: 0xff2c10, base: 34, dist: 13, ph: 4.2 });
    }
  }

  // ---------------------------------------------------------------- handle
  return {
    group,
    lights,
    tick(t: number) {
      for (const s of smokes) {
        const ud = s.userData as { ph: number; bx: number };
        s.position.x = ud.bx + Math.sin(t * 0.07 + ud.ph) * 3.2;
      }
    },
    dispose() { /* slots persist — pruneSlots() hides unused ones */ },
  };
}
