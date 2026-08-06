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
import { TH, CELL, COURSE } from "../config";
import { getKit } from "./kit";
import { getSlot, putInstanced } from "./slots";
import { InstList } from "./instances";

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

const _axisY = new THREE.Vector3(0, 1, 0);
const _hexColor = new THREE.Color();
const _mat4 = new THREE.Matrix4();
const MOSS_TINT = new THREE.Color(0x39442a);

/** scratch color from a hex literal (InstList copies r/g/b at push time) */
const hex = (h: number): THREE.Color => _hexColor.setHex(h);

const dirRotY = (d: Dir): number => (d === 0 ? Math.PI / 2 : d === 1 ? -Math.PI / 2 : d === 2 ? 0 : Math.PI);

// ---------------------------------------------------------------------------
// Bridge links.
// ---------------------------------------------------------------------------

/** A free-spanning rope bridge between two islands' gates. Shares the kit's
 *  geometries/materials; only per-span rope tubes are owned (and disposed). */
export function buildBridgeLink(a: THREE.Vector3, b: THREE.Vector3, slot: number, sceneRoot: THREE.Object3D): WorldHandle {
  const R = getKit();
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

  const planks = new InstList();
  const nP = Math.max(6, Math.round(dist / 0.58));
  const plankW = 0.41; // plankGeo x-size × 0.8 packing
  for (let i = 0; i < nP; i++) {
    const t = (i + 0.5) / nP;
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    const pz = a.z + (b.z - a.z) * t;
    const h1 = hash3(0x9a7b, i, nP, 7);
    planks.pushY(
      px, py - Math.sin(t * Math.PI) * sagMax, pz,
      rotY + (h1 - 0.5) * 0.07, (dist / nP / plankW) * 0.82, 1.2, 1.45, hex(0x4a3624),
    );
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

  const posts = new InstList();
  const stones = new InstList();
  const flames = new InstList();
  const c = new THREE.Color();
  for (const [end, sgn] of [[a, 1], [b, -1]] as const) {
    for (const side of [-0.8, 0.8]) {
      posts.pushY(end.x + perp.x * side, end.y + 0.7, end.z + perp.z * side, rotY, 1.25, 1.5, 1.25, hex(0x3a2c1c));
    }
    c.setHSL(0.09, 0.3, 0.4);
    stones.pushY(end.x + dirN.x * sgn * 0.4, end.y - 0.4, end.z + dirN.z * sgn * 0.4, rotY, 0.85, 1.2, 1.9, c);
    flames.pushY(end.x + perp.x * 0.8, end.y + 1.6, end.z + perp.z * 0.8, 0, 0.8, 0.85, 0.8, hex(0xffffff));
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

// ---------------------------------------------------------------------------
// Per-layout build.
// ---------------------------------------------------------------------------

export function buildWorld(l: Layout, slot: number, sceneRoot: THREE.Object3D, rootScale = 1): WorldHandle {
  const R = getKit();
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
  const blocks = new InstList();
  const merlons = new InstList();
  const tiles = new InstList();
  const redTiles = new InstList();
  const stoneColor = new THREE.Color();

  const isTempleBuilding = (x: number, y: number) => y === 1 && l.temple !== null && Math.abs(x - l.temple.cx) <= 2;
  const towerAt = new Map<number, Layout["towers"][number]>(l.towers.map((t) => [t.y * N + t.x, t]));

  // Interior maze walls are slimmer than the corridors they divide: thin across
  // their run direction, with fatter posts at crossings. Ramparts (boundary or
  // void-facing), towers and the temple building stay full-width.
  const thin = Math.min(1, Math.max(0.25, l.params?.wallThin ?? 0.45));
  const post = Math.min(1, thin + 0.22); // crossing pillars slightly proud of the slabs
  // dims are consulted repeatedly (occlusion checks ask about all 4 neighbors
  // of every wall cell) — memoize per cell
  const dimsCache = new Float32Array(N * N * 2).fill(-1);
  const wallDims = (x: number, y: number): { sx: number; sz: number } => {
    const ci = gi(x, y) * 2;
    if (dimsCache[ci] >= 0) return { sx: dimsCache[ci], sz: dimsCache[ci + 1] };
    let sx = 1, sz = 1;
    const full = x === 0 || y === 0 || x === N - 1 || y === N - 1
      || isTempleBuilding(x, y) || towerAt.has(gi(x, y));
    if (!full) {
      let voidAdj = false, fx = false, fz = false;
      for (let d = 0; d < 4; d++) {
        const n = gi(x + DX[d], y + DY[d]);
        if (kind[n] === VOID) voidAdj = true;
        if (kind[n] === FLOOR) (DX[d] !== 0 ? (fx = true) : (fz = true));
      }
      if (!voidAdj) {
        if (fx && !fz) { sx = thin; }
        else if (fz && !fx) { sz = thin; }
        else if (fx && fz) { sx = post; sz = post; }
        else { sx = sz = Math.min(1, post + 0.1); } // interior junction posts
      }
    }
    dimsCache[ci] = sx; dimsCache[ci + 1] = sz;
    return { sx, sz };
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
      if (yMid < refFloorTier * TH + COURSE && h1 < 0.12) stoneColor.lerp(MOSS_TINT, 0.45); // moss
      const jx = (h2v - 0.5) * 0.07 + ((k % 2) ? 0.035 : -0.035);
      const jz = (h3v - 0.5) * 0.07 + ((k % 2) ? -0.035 : 0.035);
      // cornice ring every 5th course on towers — segmented silhouette
      const cornice = scaleXZ > 1.2 && k % 5 === 4 ? 1.14 : 1;
      const s = scaleXZ * cornice * (0.985 + h1 * 0.045);
      blocks.pushY(cx + jx, yMid, cz + jz, (h1 - 0.5) * 0.05, s * dims.sx, 1, s * dims.sz, stoneColor);
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
        const tower = towerAt.get(c);
        const warm = isTempleBuilding(x, y) ? 1 : 0;
        const dims = wallDims(x, y);
        pushCourses(x, y, wallBase[c], wallTop[c], ref, tower ? tower.scale : 1, warm, dims);
        // slim walls expose strips of the cell — pave them so the corridor
        // floor reads as continuing beneath the wall
        if (dims.sx < 1 || dims.sz < 1) {
          const hp = hash2(seed, c, 23);
          stoneColor.setHSL(0.088, 0.22, 0.34 + hp * 0.1);
          tiles.pushY(wx(x), wallBase[c] * TH + 0.07, wz(y), 0, 0.995, 1, 0.995, stoneColor);
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
            merlons.pushY(
              wx(x) + (alongX ? off : 0), wallTop[c] * TH + 0.16, wz(y) + (alongX ? 0 : off),
              0, 0.8, 0.92, 0.8, stoneColor,
            );
          }
        }
        if (tower) {
          for (const [mx, mz] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) {
            stoneColor.setHSL(0.075, 0.3, 0.38);
            merlons.pushY(wx(x) + mx * tower.scale, tower.top * TH + 0.18, wz(y) + mz * tower.scale, 0, 0.9, 1.15, 0.9, stoneColor);
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
        blocks.pushY(px, T.platformTier * TH + (k + 0.5) * COURSE, faceZ, 0, 0.34, 0.98, 0.22, stoneColor);
      }
    }
    stoneColor.setHSL(0.1, 0.48, 0.56);
    blocks.pushY(wx(T.cx), l.door.tier * TH + 2.75, faceZ, 0, 1.55, 0.85, 0.24, stoneColor);
  }
  // pavilion roof slabs on towers
  for (const t of l.towers) {
    stoneColor.setHSL(0.09, 0.36, 0.42);
    blocks.pushY(wx(t.x), t.top * TH + (t.beacon ? 1.9 : 0) + 0.1, wz(t.y), 0, t.scale * 1.22, t.beacon ? 0.55 : 0.45, t.scale * 1.22, stoneColor);
    if (t.beacon) {
      // four corner posts holding the roof over the beacon
      for (const [mx, mz] of [[-0.62, -0.62], [0.62, -0.62], [-0.62, 0.62], [0.62, 0.62]]) {
        stoneColor.setHSL(0.09, 0.34, 0.38);
        blocks.pushY(wx(t.x) + mx * t.scale, t.top * TH + 1.0, wz(t.y) + mz * t.scale, 0, 0.22, 2.4, 0.22, stoneColor);
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
      target.pushY(
        wx(x) + (h2v - 0.5) * 0.05, tier[c] * TH + 0.07, wz(y) + (h1 - 0.5) * 0.05,
        (h1 - 0.5) * 0.04, 0.985, 1, 0.985, stoneColor,
      );
    }
  }
  // ---------------------------------------------------------------- stairs
  const steps = new InstList();
  const cheeks = new InstList();
  const slope = Math.atan2(TH, CELL);
  for (const s of l.stairs) {
    const rot = dirRotY(s.dir);
    const fx = DX[s.dir], fz = DY[s.dir];
    for (let i = 0; i < 4; i++) {
      const along = -CELL / 2 + (i + 0.5) * (CELL / 4);
      const h1 = hash3(seed, s.x * 57 + s.y, i, 4);
      // lighter treads than the surrounding pavement so flights read at a glance
      stoneColor.setHSL(0.09, 0.28, 0.42 + h1 * 0.1);
      steps.pushY(
        wx(s.x) + fx * along, s.tier * TH + (i + 0.5) * (TH / 4), wz(s.y) + fz * along,
        rot, 1, 1.06, 1, stoneColor,
      );
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
      cheeks.pushMatrix(_mat4.compose(pos, q, new THREE.Vector3(1, 1, 1)).elements, stoneColor);
    }
  }

  // ---------------------------------------------------------------- torches & braziers
  const brackets = new InstList();
  const warmFlames = new InstList();
  const blueFlames = new InstList();
  const redFlames = new InstList();
  const flameAnchors: Array<{ x: number; y: number; z: number }> = [];

  for (const t of l.torches) {
    const rot = dirRotY(t.dir);
    const fx = DX[t.dir], fz = DY[t.dir];
    const half = wallHalf(t.x, t.y, t.dir);
    const px = wx(t.x) + fx * (half + 0.12);
    const pz = wz(t.y) + fz * (half + 0.12);
    const py = t.tier * TH + 1.9;
    brackets.pushY(px, py - 0.28, pz, rot, 1, 1, 1, hex(0x2a2018));
    warmFlames.pushY(px + fx * 0.08, py, pz + fz * 0.08, rot, 1, 1, 1, hex(0xffffff));
    flameAnchors.push({ x: px, y: py + 0.3, z: pz });
  }

  const bowls = new InstList();
  for (const b of l.braziers) {
    const px = wx(b.x), pz = wz(b.y);
    // totems stand on a carved stone pillar; plaza braziers sit on the ground
    const lift = b.totem ? 1.15 : 0;
    const py = b.tier * TH + 0.15 + lift;
    if (b.totem) {
      stoneColor.setHSL(0.09, 0.3, 0.3 + hash2(seed, b.x * 91 + b.y, 12) * 0.08);
      blocks.pushY(px, b.tier * TH + 0.65, pz, hash2(seed, b.x, b.y) * 0.4, 0.2, 1.6, 0.2, stoneColor);
    }
    bowls.pushY(px, py + 0.42, pz, 0, 1, 1, 1, hex(0x241d16));
    const target = b.kind === "blue" ? blueFlames : b.kind === "red" ? redFlames : warmFlames;
    target.pushY(px, py + 0.72, pz, 0, 1.55, 1.75, 1.55, hex(0xffffff));
    flameAnchors.push({ x: px, y: py + 1.1, z: pz });
  }

  putInstanced(pool, "brackets", R.bracketGeo, R.woodMat, brackets, false);
  putInstanced(pool, "bowls", R.bowlGeo, R.woodMat, bowls, true);

  // fake local torchlight: wall glow + a pool of light on the floor beneath
  {
    const wallGlows = new InstList();
    for (const t of l.torches) {
      const rot = dirRotY(t.dir);
      const fx = DX[t.dir], fz = DY[t.dir];
      const half = wallHalf(t.x, t.y, t.dir);
      wallGlows.pushY(
        wx(t.x) + fx * (half + 0.05), t.tier * TH + 1.7, wz(t.y) + fz * (half + 0.05),
        rot, 1, 1, 1, hex(0xffffff),
      );
    }
    putInstanced(pool, "wallGlows", R.wallGlowGeo, R.wallGlowMat, wallGlows, false);

    const floorGlows = new InstList();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const big = new THREE.Vector3(1.6, 1.6, 1.6);
    for (const t of l.torches) {
      const fx = DX[t.dir], fz = DY[t.dir];
      const half = wallHalf(t.x, t.y, t.dir);
      pos.set(wx(t.x) + fx * (half + 0.7), t.tier * TH + 0.19, wz(t.y) + fz * (half + 0.7));
      floorGlows.pushMatrix(_mat4.compose(pos, q, one).elements, hex(0xffffff));
    }
    for (const b of l.braziers) {
      pos.set(wx(b.x), b.tier * TH + 0.21, wz(b.y));
      floorGlows.pushMatrix(_mat4.compose(pos, q, big).elements, hex(0xffffff));
    }
    putInstanced(pool, "floorGlows", R.floorGlowGeo, R.floorGlowMat, floorGlows, false);
  }

  // ---------------------------------------------------------------- banners
  {
    const items = new InstList();
    for (const b of l.banners) {
      const rot = dirRotY(b.dir);
      const fx = DX[b.dir], fz = DY[b.dir];
      const half = wallHalf(b.x, b.y, b.dir);
      const hang = Math.min(b.top * TH - 0.5, b.tier * TH + 4.6);
      items.pushY(
        wx(b.x) + fx * (half + 0.1), hang, wz(b.y) + fz * (half + 0.1),
        rot, 1, 1, 1, hex(0xffffff),
      );
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
    const planks = new InstList();
    const nP = 14;
    for (let i = 0; i < nP; i++) {
      const t = (i + 0.5) / nP;
      const x = x0 + (x1 - x0) * t;
      const sag = Math.sin(t * Math.PI) * 0.7;
      const h1 = hash3(seed, 999, i, 7);
      planks.pushY(x, yTop - sag, z, (h1 - 0.5) * 0.1, 1, 1.2, 1.45, hex(0x4a3624));
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
    const posts = new InstList();
    for (const px of [x0, x1]) for (const side of [-0.8, 0.8]) {
      posts.pushY(px, yTop + 0.7, z + side, 0, 1.25, 1.45, 1.25, hex(0x3a2c1c));
    }
    putInstanced(pool, "ravinePosts", R.postGeo, R.woodMat, posts, true);
    // stone abutments anchoring both ends + a lantern flame on each near post
    for (const [ax, sgn] of [[x0, -1], [x1, 1]] as const) {
      stoneColor.setHSL(0.09, 0.3, 0.4);
      blocks.pushY(ax + sgn * 0.5, yTop - 0.35, z, 0, 0.75, 1.15, 1.9, stoneColor);
      warmFlames.pushY(ax, yTop + 1.55, z + 0.8, 0, 0.8, 0.85, 0.8, hex(0xffffff));
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
  const rubble = new InstList();
  const crates = new InstList();
  const vines = new InstList();
  const leaves = new InstList();
  const creepers = new InstList();
  const bramblesA = new InstList();
  const bramblesB = new InstList();
  const links = new InstList();
  const moss = new InstList();
  const cols = new InstList();
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
              rubble.pushY(
                wx(x) + ox + (ha - 0.5) * 0.9, tier[c] * TH + 0.14 + sc * 0.07, wz(y) + oz + (hb - 0.5) * 0.9,
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
              stoneColor.setHSL(0.25 + hb * 0.05, 0.35, 0.24 + ha * 0.1);
              const sc = 0.7 + ha * 1.3;
              moss.pushY(
                wx(x) + mx + (ha - 0.5) * 1.0, tier[c] * TH + 0.157 + k * 0.004, wz(y) + mz + (hb - 0.5) * 1.0,
                hb * 6.28, sc, 1, sc * (0.7 + hb * 0.5), stoneColor,
              );
            }
          }
          // crates in quiet dead ends the totems didn't claim
          let deg = 0;
          for (let d = 0; d < 4; d++) if (kind[gi(x + DX[d], y + DY[d])] === FLOOR) deg++;
          if (deg === 1 && !totemCells.has(c) && hash2(seed, c, 76) < 0.4 && !(x === l.entrance.x && y === l.entrance.y)) {
            const ha = hash2(seed, c, 77);
            crates.pushY(wx(x) + (ha - 0.5) * 0.5, tier[c] * TH + 0.51, wz(y) + (ha - 0.5) * 0.4, ha * 1.5, 1, 1, 1, hex(0x4d3a22));
            if (ha < 0.45) crates.pushY(wx(x) + (ha - 0.5) * 0.5 + 0.3, tier[c] * TH + 1.15, wz(y) + (ha - 0.5) * 0.4 - 0.2, ha * 4, 0.72, 0.72, 0.72, hex(0x423120));
          }
        }
        // moss on wall-top walkways too
        if (kind[c] === WALL && hash2(seed, c, 86) < 0.2 * decay) {
          const ha = hash2(seed, c, 87);
          stoneColor.setHSL(0.26, 0.32, 0.22 + ha * 0.08);
          const sc = 0.6 + ha * 0.9;
          moss.pushY(
            wx(x) + (ha - 0.5) * 0.8, wallTop[c] * TH + 0.03, wz(y) + (0.5 - ha) * 0.8,
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
            stoneColor.setHSL(0.07 + ha * 0.02, 0.25, 0.16 + ha * 0.08);
            const target = hbv < 0.5 ? bramblesA : bramblesB;
            target.pushY(
              wx(x) + fx * (half + 0.04) + (fz !== 0 ? lat : 0),
              baseY,
              wz(y) + fz * (half + 0.04) + (fx !== 0 ? lat : 0),
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
              stoneColor.setHSL(0.24 + hb * 0.06, 0.44, 0.36 + ha * 0.16);
              creepers.pushY(
                wx(x) + fx * (half + 0.05) + (fz !== 0 ? lat : 0),
                tier[n] * TH + 0.15 + k * (availH / stack) * 0.92,
                wz(y) + fz * (half + 0.05) + (fx !== 0 ? lat : 0),
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
              const px2 = wx(x) + fx * (half + 0.08) + (fz !== 0 ? lat : 0);
              const pz2 = wz(y) + fz * (half + 0.08) + (fx !== 0 ? lat : 0);
              const py2 = wallTop[c] * TH - 0.05 - hb * 0.3;
              const rot = dirRotY(d as Dir);
              const sw = 1.1 + hb * 0.9, sh = 0.75 + ha * 0.8;
              stoneColor.setHSL(0.26 + hb * 0.06, 0.3, 0.2 + ha * 0.1);
              vines.pushY(px2, py2, pz2, rot, sw * 0.5, sh, 1, stoneColor);
              // the leaf cluster is what actually reads — brighter, bigger
              stoneColor.setHSL(0.24 + hb * 0.07, 0.45, 0.42 + ha * 0.16);
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
        const px2 = wx(m.x) + Math.cos(a) * (m.r + 0.55) * CELL;
        const pz2 = wz(m.y) + Math.sin(a) * (m.r + 0.55) * CELL * 0.98;
        const h = hash3(seed, mIdx * 31, k, 95);
        if (h > 0.8) continue; // a few are gone entirely
        const py2 = m.tier * TH + 0.12;
        stoneColor.setHSL(0.09, 0.28, 0.4 + h * 0.12);
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
          stoneColor.setHSL(0.08, 0.2, 0.26 + hr * 0.1);
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
            wx(r.x) + fx * (CELL / 2 + out), topY + (endY - topY) * t, wz(r.y) + fz * (CELL / 2 + out),
            dirRotY(r.d) + (i % 2) * Math.PI / 2, 1.15, 1.15, 1.15, hex(0x191a20),
          );
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
    const wisps = new InstList();
    for (const a of flameAnchors) {
      const h = hash2(seed, Math.round(a.x * 7 + a.z * 13), 97);
      wisps.pushY(a.x, a.y + 0.15, a.z, h * 6.28, 0.8 + h * 0.5, 0.8 + h * 0.6, 0.8 + h * 0.5, hex(0xffffff));
    }
    putInstanced(pool, "wisps", R.wispGeo, R.wispMat, wisps, false);
  }
  // drifting embers: a few near every flame + strays wandering the corridors
  {
    const embers = new InstList();
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
      embers.pushY(wx(gx2), tier[c2] * TH + 0.6, wz(gy2), 0, 0.5 + hx * 0.7, 0.5 + hx * 0.7, 0.5 + hx * 0.7, hex(0xffffff));
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
      // farthest-point sampling: maximal coverage from a tiny light budget
      let first = flameAnchors[0];
      for (const a of flameAnchors) if (a.x * a.x + a.z * a.z < first.x * first.x + first.z * first.z) first = a;
      chosen.push(first);
      const poolSize = l.N >= 25 ? 9 : 5; // satellites get a smaller light budget
      while (chosen.length < Math.min(poolSize, flameAnchors.length)) {
        let best = flameAnchors[0], bestD = -1;
        for (const a of flameAnchors) {
          let dMin = Infinity;
          for (const c2 of chosen) dMin = Math.min(dMin, Math.hypot(a.x - c2.x, a.z - c2.z));
          if (dMin > bestD) { bestD = dMin; best = a; }
        }
        if (bestD <= 0) break;
        chosen.push(best);
      }
    }
    let li = 0;
    for (const c2 of chosen) {
      lights.push({ x: c2.x, y: c2.y + 0.2, z: c2.z, color: 0xff9a45, base: 50, dist: 19, ph: hash2(seed, li++, 61) * Math.PI * 2 });
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
