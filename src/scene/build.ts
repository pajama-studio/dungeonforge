// Turns a Layout into meshes. Everything repeated is instanced; per-instance
// color carries baked AO + hue variation; all glow goes through emissiveNode so
// the MRT-emissive bloom pass picks it up and nothing else does.
//
// Materials & geometries are created ONCE and shared across regenerations —
// WebGPU pipeline compilation is the expensive part of a rebuild, so a re-forge
// only recreates InstancedMesh instance buffers (near-instant).

import * as THREE from "three/webgpu";
import {
  color, vec2, vec3, uv, time, sin, positionLocal,
  instanceIndex, hash, smoothstep, length, fract, abs, mix, float, atan, max,
} from "three/tsl";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import type { Layout, Dir } from "../gen/dungeon";
import { FLOOR, WALL, ABYSS, DX, DY } from "../gen/dungeon";
import { hash2, hash3 } from "../gen/rng";
import { TH, CELL } from "./env";

const COURSE = TH / 2; // one masonry course = half a tier
const BRIDGE_SPAN = 3.2 * CELL; // ravine is always 3 cells + 2×0.4-cell setback

export interface WorldHandle {
  group: THREE.Group;
  tick: (t: number) => void;
  dispose: () => void;
}

interface Inst { m: THREE.Matrix4; c: THREE.Color }

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _axisY = new THREE.Vector3(0, 1, 0);

function makeInstanced(
  geom: THREE.BufferGeometry, mat: THREE.Material, items: Inst[],
  shadows = true,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geom, mat, Math.max(items.length, 1));
  for (let i = 0; i < items.length; i++) {
    mesh.setMatrixAt(i, items[i].m);
    mesh.setColorAt(i, items[i].c);
  }
  mesh.count = items.length;
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  mesh.frustumCulled = false; // single fortress-sized bounds; always in view
  return mesh;
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
  merlonGeo: THREE.BufferGeometry;
  tileGeo: THREE.BufferGeometry;
  stepGeo: THREE.BufferGeometry;
  bracketGeo: THREE.BufferGeometry;
  bowlGeo: THREE.BufferGeometry;
  postGeo: THREE.BufferGeometry;
  plankGeo: THREE.BufferGeometry;
  flameGeo: THREE.BufferGeometry;
  wallGlowGeo: THREE.BufferGeometry;
  floorGlowGeo: THREE.BufferGeometry;
  bannerGeo: THREE.BufferGeometry;
  circleGeo: THREE.BufferGeometry;   // unit radius; scaled per medallion
  portalGeo: THREE.BufferGeometry;
  beaconGeo: THREE.BufferGeometry;
  stoneMat: THREE.MeshStandardNodeMaterial;
  redMat: THREE.MeshStandardNodeMaterial;
  woodMat: THREE.MeshStandardNodeMaterial;
  flameWarm: THREE.MeshStandardNodeMaterial;
  flameBlue: THREE.MeshStandardNodeMaterial;
  flameRed: THREE.MeshStandardNodeMaterial;
  wallGlowMat: THREE.MeshStandardNodeMaterial;
  floorGlowMat: THREE.MeshStandardNodeMaterial;
  bannerMat: THREE.MeshStandardNodeMaterial;
  medallionBlue: THREE.MeshStandardNodeMaterial;
  medallionGold: THREE.MeshStandardNodeMaterial;
  portalMat: THREE.MeshStandardNodeMaterial;
  beaconMat: THREE.MeshStandardNodeMaterial;
  smokeMat: THREE.SpriteNodeMaterial;
}

let S: SharedRes | null = null;

function makeFlameMat(cA: number, cB: number, cCore: number): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, roughness: 1,
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
  mat.colorNode = vec3(0);
  mat.emissiveNode = ramp.mul(shape).mul(flick.mul(0.4).add(3.2));
  mat.opacityNode = shape;
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
  mat.emissiveNode = color(theme).mul(pattern).mul(pulse).mul(0.8);
  return mat;
}

function getShared(): SharedRes {
  if (S) return S;

  const flameGeoBase = new THREE.PlaneGeometry(0.55, 1.02);
  flameGeoBase.translate(0, 0.51, 0);
  const flameGeoCross = flameGeoBase.clone().rotateY(Math.PI / 2);
  const flameGeo = BufferGeometryUtils.mergeGeometries([flameGeoBase, flameGeoCross]);
  flameGeoBase.dispose(); flameGeoCross.dispose();

  const bannerGeo = new THREE.PlaneGeometry(1.15, 2.05, 1, 10);
  bannerGeo.translate(0, -1.025, 0);

  const bannerMat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.9 });
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
  }

  const wallGlowMat = new THREE.MeshStandardNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, roughness: 1,
  });
  {
    const ph = hash(instanceIndex.toFloat().add(0.83)).mul(6.2832);
    const flick = sin(time.mul(8.9).add(ph)).mul(0.1).add(sin(time.mul(14.7).add(ph.mul(1.9))).mul(0.06)).add(0.86);
    const fall = smoothstep(0.5, 0.04, length(uv().sub(vec2(0.5, 0.42))));
    wallGlowMat.colorNode = vec3(0);
    wallGlowMat.emissiveNode = color(0xff8a35).mul(fall).mul(flick).mul(0.42);
    wallGlowMat.opacityNode = fall;
  }

  const floorGlowMat = new THREE.MeshStandardNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, roughness: 1,
  });
  {
    const ph = hash(instanceIndex.toFloat().add(0.59)).mul(6.2832);
    const flick = sin(time.mul(8.3).add(ph)).mul(0.09).add(sin(time.mul(13.9).add(ph.mul(2.3))).mul(0.05)).add(0.88);
    const fall = smoothstep(0.5, 0.03, length(uv().sub(0.5)));
    floorGlowMat.colorNode = vec3(0);
    floorGlowMat.emissiveNode = color(0xff9440).mul(fall).mul(flick).mul(0.5);
    floorGlowMat.opacityNode = fall;
  }

  const portalMat = new THREE.MeshStandardNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, roughness: 1,
  });
  {
    const p = uv().sub(vec2(0.5, 0.42));
    const r = length(p);
    const swirl = sin(r.mul(22).sub(time.mul(2.1)).add(atan(p.y, p.x).mul(3)));
    const glow = float(0.3).div(r.add(0.16));
    portalMat.colorNode = vec3(0);
    portalMat.emissiveNode = color(0x3e7bff).mul(glow.mul(swirl.mul(0.22).add(1))).mul(1.6);
    portalMat.opacityNode = smoothstep(0.62, 0.12, r);
  }

  const beaconMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.4 });
  beaconMat.colorNode = color(0x332a18);
  beaconMat.emissiveNode = color(0xffe4a0).mul(sin(time.mul(2.2)).mul(0.2).add(1)).mul(4.5);

  const redMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, vertexColors: true });
  redMat.emissiveNode = color(0xff2a08).mul(sin(time.mul(1.7)).mul(0.25).add(0.85)).mul(0.55);

  const smokeMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  smokeMat.colorNode = color(0x2b3a58);
  smokeMat.opacityNode = smoothstep(0.5, 0.08, length(uv().sub(0.5))).mul(0.13);

  S = {
    blockGeo: shadeFaces(new RoundedBoxGeometry(CELL * 1.02, COURSE * 1.02, CELL * 1.02, 1, 0.06)),
    merlonGeo: shadeFaces(new RoundedBoxGeometry(0.72, 0.55, 0.72, 1, 0.05)),
    tileGeo: shadeFaces(new RoundedBoxGeometry(CELL * 0.985, 0.15, CELL * 0.985, 1, 0.045)),
    stepGeo: shadeFaces(new THREE.BoxGeometry(CELL * 1.0, TH / 4, CELL / 4 + 0.06)),
    bracketGeo: new THREE.BoxGeometry(0.14, 0.6, 0.14),
    bowlGeo: new THREE.CylinderGeometry(0.4, 0.2, 0.42, 8),
    postGeo: new THREE.CylinderGeometry(0.09, 0.11, 1.3, 6),
    plankGeo: new THREE.BoxGeometry((BRIDGE_SPAN / 12) * 0.8, 0.08, 1.15),
    flameGeo,
    wallGlowGeo: new THREE.PlaneGeometry(3.4, 3.0),
    floorGlowGeo: new THREE.PlaneGeometry(4.2, 4.2),
    bannerGeo,
    circleGeo: new THREE.CircleGeometry(1, 56),
    portalGeo: new THREE.PlaneGeometry(1.8, 2.4),
    beaconGeo: new THREE.OctahedronGeometry(0.45),
    stoneMat: new THREE.MeshStandardNodeMaterial({ roughness: 0.93, metalness: 0.02, vertexColors: true }),
    redMat,
    woodMat: new THREE.MeshStandardNodeMaterial({ roughness: 0.9 }),
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

export function buildWorld(l: Layout): WorldHandle {
  const R = getShared();
  const { N, kind, tier, wallTop, wallBase, support } = l;
  const gi = (x: number, y: number) => y * N + x;
  const wx = (gx: number) => (gx - (N - 1) / 2) * CELL;
  const wz = (gy: number) => (gy - (N - 1) / 2) * CELL;
  const seed = l.seed;

  const group = new THREE.Group();
  group.name = "fortress";
  // geometries unique to this layout (bridge ropes) — everything else is shared
  const perBuildGeos: THREE.BufferGeometry[] = [];

  // ---------------------------------------------------------------- masonry
  const blocks: Inst[] = [];
  const merlons: Inst[] = [];
  const stoneColor = new THREE.Color();

  const isTempleBuilding = (x: number, y: number) => y === 1 && l.temple !== null && Math.abs(x - l.temple.cx) <= 2;

  const pushCourses = (
    x: number, y: number, baseTier: number, topTier: number,
    refFloorTier: number, scaleXZ: number, warm: number,
  ) => {
    const cx = wx(x), cz = wz(y);
    const nCourses = Math.max(0, Math.round((topTier - baseTier) * TH / COURSE));
    const doorCell = l.doorMask[gi(x, y)] === 1;
    for (let k = 0; k < nCourses; k++) {
      const y0 = baseTier * TH + k * COURSE;
      const yMid = y0 + COURSE / 2;
      if (doorCell && l.door) {
        const gapLo = l.door.tier * TH, gapHi = l.door.tier * TH + 2.6;
        if (yMid > gapLo && yMid < gapHi) continue; // doorway gap (lintel above survives)
      }
      const h1 = hash3(seed, x * 131 + y, k, 1);
      const h2v = hash3(seed, x * 131 + y, k, 2);
      const h3v = hash3(seed, x * 131 + y, k, 3);
      // baked AO: courses far below the nearest floor sit in shadowed crevices
      const rel = Math.min(1, Math.max(0, (yMid - refFloorTier * TH) / (2.6 * TH) + 0.72));
      const lum = (0.43 + h1 * 0.16) * (0.5 + 0.5 * rel);
      const hue = 0.075 + warm * 0.012 + (h2v - 0.5) * 0.018;
      const sat = 0.30 + warm * 0.1 + (h3v - 0.5) * 0.08;
      stoneColor.setHSL(hue, sat, lum);
      if (yMid < refFloorTier * TH + COURSE && h1 < 0.12) stoneColor.lerp(new THREE.Color(0x39442a), 0.45); // moss
      const jx = (h2v - 0.5) * 0.07 + ((k % 2) ? 0.035 : -0.035);
      const jz = (h3v - 0.5) * 0.07 + ((k % 2) ? -0.035 : 0.035);
      const s = scaleXZ * (0.985 + h1 * 0.045);
      blocks.push(inst(cx + jx, yMid, cz + jz, (h1 - 0.5) * 0.05, s, 1, s, stoneColor.getHex()));
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
        pushCourses(x, y, wallBase[c], wallTop[c], ref, tower ? tower.scale : 1, warm);
        // merlon checkerboard on exposed tops
        let exposed = x === 0 || y === 0 || x === N - 1 || y === N - 1;
        for (let d = 0; d < 4 && !exposed; d++) {
          const n = gi(x + DX[d], y + DY[d]);
          if (kind[n] !== WALL) exposed = true;
        }
        if (exposed && !tower && (x + y) % 2 === 0 && !l.doorMask[c]) {
          stoneColor.setHSL(0.075, 0.3, 0.33 + hash2(seed, c, 9) * 0.12);
          merlons.push(inst(wx(x), wallTop[c] * TH + 0.26, wz(y), 0, 1, 1, 1, stoneColor.getHex()));
        }
        if (tower) {
          for (const [mx, mz] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) {
            stoneColor.setHSL(0.075, 0.3, 0.38);
            merlons.push(inst(wx(x) + mx * tower.scale, tower.top * TH + 0.26, wz(y) + mz * tower.scale, 0, 0.9, 1.15, 0.9, stoneColor.getHex()));
          }
        }
      } else if (kind[c] === FLOOR && support[c] < tier[c]) {
        pushCourses(x, y, support[c], tier[c], tier[c], 1, 0);
      }
    }
  }

  group.add(makeInstanced(R.blockGeo, R.stoneMat, blocks));
  group.add(makeInstanced(R.merlonGeo, R.stoneMat, merlons));

  // ---------------------------------------------------------------- floors
  const tiles: Inst[] = [];
  const redTiles: Inst[] = [];
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
        stoneColor.setHSL(0.095, 0.34, 0.4 + h1 * 0.14);
      } else if (l.plazaMask[c]) {
        stoneColor.setHSL(0.085, 0.24, 0.34 + h1 * 0.12);
      } else {
        stoneColor.setHSL(0.08 + (h2v - 0.5) * 0.02, 0.16, 0.28 + h1 * 0.12);
      }
      target.push(inst(
        wx(x) + (h2v - 0.5) * 0.05, tier[c] * TH + 0.07, wz(y) + (h1 - 0.5) * 0.05,
        (h1 - 0.5) * 0.04, 0.985, 1, 0.985, stoneColor.getHex(),
      ));
    }
  }
  group.add(makeInstanced(R.tileGeo, R.stoneMat, tiles, true));
  group.add(makeInstanced(R.tileGeo, R.redMat, redTiles, true));

  // ---------------------------------------------------------------- stairs
  const steps: Inst[] = [];
  for (const s of l.stairs) {
    const rot = dirRotY(s.dir);
    const fx = DX[s.dir], fz = DY[s.dir];
    for (let i = 0; i < 4; i++) {
      const along = -CELL / 2 + (i + 0.5) * (CELL / 4);
      const h1 = hash3(seed, s.x * 57 + s.y, i, 4);
      stoneColor.setHSL(0.08, 0.22, 0.33 + h1 * 0.1);
      steps.push(inst(
        wx(s.x) + fx * along, s.tier * TH + (i + 0.5) * (TH / 4), wz(s.y) + fz * along,
        rot, 1, 1, 1, stoneColor.getHex(),
      ));
    }
  }
  group.add(makeInstanced(R.stepGeo, R.stoneMat, steps));

  // ---------------------------------------------------------------- torches & braziers
  const brackets: Inst[] = [];
  const warmFlames: Inst[] = [];
  const blueFlames: Inst[] = [];
  const redFlames: Inst[] = [];
  const flameAnchors: Array<{ x: number; y: number; z: number }> = [];

  for (const t of l.torches) {
    const rot = dirRotY(t.dir);
    const fx = DX[t.dir], fz = DY[t.dir];
    const px = wx(t.x) + fx * (CELL / 2 + 0.12);
    const pz = wz(t.y) + fz * (CELL / 2 + 0.12);
    const py = t.tier * TH + 1.9;
    brackets.push(inst(px, py - 0.28, pz, rot, 1, 1, 1, 0x2a2018));
    warmFlames.push(inst(px + fx * 0.08, py, pz + fz * 0.08, rot, 1, 1, 1, 0xffffff));
    flameAnchors.push({ x: px, y: py + 0.3, z: pz });
  }

  const bowls: Inst[] = [];
  for (const b of l.braziers) {
    const px = wx(b.x), pz = wz(b.y), py = b.tier * TH + 0.15;
    bowls.push(inst(px, py + 0.42, pz, 0, 1, 1, 1, 0x241d16));
    const f = inst(px, py + 0.72, pz, 0, 1.55, 1.75, 1.55, 0xffffff);
    (b.kind === "blue" ? blueFlames : b.kind === "red" ? redFlames : warmFlames).push(f);
    flameAnchors.push({ x: px, y: py + 1.1, z: pz });
  }

  group.add(makeInstanced(R.bracketGeo, R.woodMat, brackets, false));
  group.add(makeInstanced(R.bowlGeo, R.woodMat, bowls, true));

  // fake local torchlight: wall glow + a pool of light on the floor beneath
  {
    const wallGlows: Inst[] = [];
    for (const t of l.torches) {
      const rot = dirRotY(t.dir);
      const fx = DX[t.dir], fz = DY[t.dir];
      wallGlows.push(inst(
        wx(t.x) + fx * (CELL / 2 + 0.05), t.tier * TH + 1.7, wz(t.y) + fz * (CELL / 2 + 0.05),
        rot, 1, 1, 1, 0xffffff,
      ));
    }
    group.add(makeInstanced(R.wallGlowGeo, R.wallGlowMat, wallGlows, false));

    const floorGlows: Inst[] = [];
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const one = new THREE.Vector3(1, 1, 1);
    for (const t of l.torches) {
      const fx = DX[t.dir], fz = DY[t.dir];
      const p = new THREE.Vector3(wx(t.x) + fx * (CELL / 2 + 0.7), t.tier * TH + 0.19, wz(t.y) + fz * (CELL / 2 + 0.7));
      floorGlows.push({ m: new THREE.Matrix4().compose(p, q, one), c: new THREE.Color(0xffffff) });
    }
    for (const b of l.braziers) {
      const p = new THREE.Vector3(wx(b.x), b.tier * TH + 0.21, wz(b.y));
      const sc = new THREE.Vector3(1.6, 1.6, 1.6);
      floorGlows.push({ m: new THREE.Matrix4().compose(p, q, sc), c: new THREE.Color(0xffffff) });
    }
    group.add(makeInstanced(R.floorGlowGeo, R.floorGlowMat, floorGlows, false));
  }

  group.add(makeInstanced(R.flameGeo, R.flameWarm, warmFlames, false));
  group.add(makeInstanced(R.flameGeo, R.flameBlue, blueFlames, false));
  group.add(makeInstanced(R.flameGeo, R.flameRed, redFlames, false));

  // ---------------------------------------------------------------- banners
  {
    const items: Inst[] = [];
    for (const b of l.banners) {
      const rot = dirRotY(b.dir);
      const fx = DX[b.dir], fz = DY[b.dir];
      const hang = Math.min(b.top * TH - 0.5, b.tier * TH + 4.6);
      items.push(inst(
        wx(b.x) + fx * (CELL / 2 + 0.1), hang, wz(b.y) + fz * (CELL / 2 + 0.1),
        rot, 1, 1, 1, 0xffffff,
      ));
    }
    group.add(makeInstanced(R.bannerGeo, R.bannerMat, items, false));
  }

  // ---------------------------------------------------------------- medallions
  for (const m of l.medallions) {
    const mesh = new THREE.Mesh(R.circleGeo, m.kind === "blue" ? R.medallionBlue : R.medallionGold);
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.setScalar(m.r * CELL);
    mesh.position.set(wx(m.x), m.tier * TH + 0.17, wz(m.y));
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // ---------------------------------------------------------------- temple portal
  if (l.door) {
    const mesh = new THREE.Mesh(R.portalGeo, R.portalMat);
    mesh.position.set(wx(l.door.x), l.door.tier * TH + 1.25, wz(l.door.y) + CELL / 2 - 0.18);
    group.add(mesh);
  }

  // ---------------------------------------------------------------- bridge
  if (l.bridge) {
    const b = l.bridge;
    const x0 = wx(b.x0) + CELL * 0.4, x1 = wx(b.x1) - CELL * 0.4;
    const z = wz(b.y);
    const yTop = b.tier * TH + 0.1;
    const planks: Inst[] = [];
    const nP = 12;
    for (let i = 0; i < nP; i++) {
      const t = (i + 0.5) / nP;
      const x = x0 + (x1 - x0) * t;
      const sag = Math.sin(t * Math.PI) * 0.55;
      const h1 = hash3(seed, 999, i, 7);
      planks.push(inst(x, yTop - sag, z, (h1 - 0.5) * 0.12, 1, 1, 1, 0x4a3624));
    }
    group.add(makeInstanced(R.plankGeo, R.woodMat, planks, true));
    for (const side of [-0.55, 0.55]) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        pts.push(new THREE.Vector3(x0 + (x1 - x0) * t, yTop + 0.55 - Math.sin(t * Math.PI) * 0.7, z + side));
      }
      const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.035, 5);
      perBuildGeos.push(geo);
      group.add(new THREE.Mesh(geo, R.woodMat));
    }
    const posts: Inst[] = [];
    for (const px of [x0, x1]) for (const side of [-0.55, 0.55]) {
      posts.push(inst(px, yTop + 0.55, z + side, 0, 1, 1, 1, 0x3a2c1c));
    }
    group.add(makeInstanced(R.postGeo, R.woodMat, posts, true));
  }

  // ---------------------------------------------------------------- beacons
  for (const t of l.towers) {
    if (!t.beacon) continue;
    const mesh = new THREE.Mesh(R.beaconGeo, R.beaconMat);
    mesh.position.set(wx(t.x), t.top * TH + 1.0, wz(t.y));
    group.add(mesh);
    flameAnchors.push({ x: wx(t.x), y: t.top * TH + 1.2, z: wz(t.y) });
  }

  // ---------------------------------------------------------------- smoke
  const smokes: THREE.Sprite[] = [];
  for (let k = 0; k < 22; k++) {
    const s = new THREE.Sprite(R.smokeMat);
    const a = hash2(seed, k, 41) * Math.PI * 2;
    const rad = 18 + hash2(seed, k, 42) * 26;
    if (k < 8 && l.bridge) {
      s.position.set(wx(l.bridge.x0 + 2) + (hash2(seed, k, 43) - 0.5) * 8, -1 - hash2(seed, k, 44) * 5, wz(Math.round(N * 0.75)) + (hash2(seed, k, 45) - 0.5) * 18);
    } else {
      s.position.set(Math.cos(a) * rad, -2 - hash2(seed, k, 46) * 6, Math.sin(a) * rad);
    }
    const sc = 9 + hash2(seed, k, 47) * 9;
    s.scale.set(sc, sc * 0.62, 1);
    (s.userData as { ph: number }).ph = hash2(seed, k, 48) * Math.PI * 2;
    (s.userData as { bx: number }).bx = s.position.x;
    smokes.push(s);
    group.add(s);
  }

  // ---------------------------------------------------------------- lights
  const lights: Array<{ light: THREE.PointLight; base: number; ph: number }> = [];
  {
    const chosen: Array<{ x: number; y: number; z: number }> = [];
    if (flameAnchors.length > 0) {
      let first = flameAnchors[0];
      for (const a of flameAnchors) if (a.x * a.x + a.z * a.z < first.x * first.x + first.z * first.z) first = a;
      chosen.push(first);
      while (chosen.length < Math.min(9, flameAnchors.length)) {
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
      const pl = new THREE.PointLight(0xff9a45, 50, 19, 2);
      pl.position.set(c.x, c.y + 0.2, c.z);
      group.add(pl);
      lights.push({ light: pl, base: 50, ph: hash2(seed, li++, 61) * Math.PI * 2 });
    }
    if (l.door) {
      const pl = new THREE.PointLight(0x3e7bff, 26, 16, 2);
      pl.position.set(wx(l.door.x), l.door.tier * TH + 1.6, wz(l.door.y) + 1.6);
      group.add(pl);
      lights.push({ light: pl, base: 26, ph: 1.1 });
    }
    for (const b of l.braziers) {
      if (b.kind !== "red") continue;
      const pl = new THREE.PointLight(0xff2c10, 34, 13, 2);
      pl.position.set(wx(b.x), b.tier * TH + 1.4, wz(b.y));
      group.add(pl);
      lights.push({ light: pl, base: 34, ph: 4.2 });
    }
  }

  // ---------------------------------------------------------------- handle
  return {
    group,
    tick(t: number) {
      for (const L of lights) {
        L.light.intensity = L.base * (0.82 + 0.12 * Math.sin(t * 7.3 + L.ph) + 0.06 * Math.sin(t * 13.1 + L.ph * 1.7));
      }
      for (const s of smokes) {
        const ud = s.userData as { ph: number; bx: number };
        s.position.x = ud.bx + Math.sin(t * 0.07 + ud.ph) * 3.2;
      }
    },
    dispose() {
      group.removeFromParent();
      for (const g of perBuildGeos) g.dispose();
      group.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) o.dispose(); // frees instance buffers; shared geo/mat stay alive
      });
    },
  };
}
