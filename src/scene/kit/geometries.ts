// Shared geometry kit — built ONCE and reused by every regeneration. WebGPU
// pipeline compilation keys off geometry/material identity, so keeping these
// stable means a re-forge only refills instance buffers.

import * as THREE from "three/webgpu";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { mulberry32 } from "../../gen/rng";
import { TH, CELL, COURSE, BRIDGE_SPAN } from "../../config";

/** Bake painterly form shading into vertex colors: tops catch the sky, each side
 *  face gets its own value so every block edge reads as a distinct plane.
 *  Multiplies with per-instance color (NodeMaterial does vertexColor × instanceColor). */
export function shadeFaces(geo: THREE.BufferGeometry): THREE.BufferGeometry {
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

export interface GeoKit {
  blockGeo: THREE.BufferGeometry;
  blockGeoLo: THREE.BufferGeometry;
  tileGeo: THREE.BufferGeometry;
  tileGeoLo: THREE.BufferGeometry;
  merlonGeo: THREE.BufferGeometry;
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
  rootGeo: THREE.BufferGeometry;
  leafGeo: THREE.BufferGeometry;
  creeperGeo: THREE.BufferGeometry;
  brambleGeoA: THREE.BufferGeometry;
  brambleGeoB: THREE.BufferGeometry;
  wispGeo: THREE.BufferGeometry;
  runeGeo: THREE.BufferGeometry;
  arrowGeo: THREE.BufferGeometry;
  navCellGeo: THREE.BufferGeometry;
  plugGeo: THREE.BufferGeometry;
  emberGeo: THREE.BufferGeometry;
  beamGeo: THREE.BufferGeometry;
  circleGeo: THREE.BufferGeometry;   // unit radius; scaled per medallion
  portalGeo: THREE.BufferGeometry;
  beaconGeo: THREE.BufferGeometry;
}

export function makeGeometries(): GeoKit {
  const flameGeoBase = new THREE.PlaneGeometry(0.55, 1.02);
  flameGeoBase.translate(0, 0.51, 0);
  const flameGeoCross = flameGeoBase.clone().rotateY(Math.PI / 2);
  const flameGeo = BufferGeometryUtils.mergeGeometries([flameGeoBase, flameGeoCross]);
  flameGeoBase.dispose(); flameGeoCross.dispose();

  const bannerGeo = new THREE.PlaneGeometry(1.35, 2.55, 1, 10);
  bannerGeo.translate(0, -1.275, 0);

  // hanging vines: pinned at the top, swaying tip
  const vineGeo = new THREE.PlaneGeometry(0.24, 1.9, 1, 6);
  vineGeo.translate(0, -0.95, 0);

  // moss patches: flat blobs, edges eaten by noise in the material
  const mossGeo = new THREE.CircleGeometry(0.62, 12);
  mossGeo.rotateX(-Math.PI / 2);

  // ancient column (unit height, base at y=0, gentle entasis taper)
  const colGeo = new THREE.CylinderGeometry(0.16, 0.2, 1, 8);
  colGeo.translate(0, 0.5, 0);

  // hanging root strand: unit length, origin at the rim, thick where it grips
  // the stone and wandering as it trails into the abyss
  const rootGeo = (() => {
    const g = new THREE.CylinderGeometry(0.025, 0.15, 1, 5, 7, true);
    g.translate(0, -0.5, 0);
    const p = g.getAttribute("position");
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i); // -1..0, 0 at the rim
      const sag = -y; // 0 at the grip, 1 at the tip
      p.setX(i, p.getX(i) + (Math.sin(y * 9.4) * 0.09 + Math.sin(y * 4.1 + 1.7) * 0.13) * sag);
      p.setZ(i, p.getZ(i) + Math.cos(y * 7.3) * 0.09 * sag);
    }
    g.computeVertexNormals();
    return g;
  })();

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

  // torch smoke: crossed quads, upward-thinning wisps
  const wispBase = new THREE.PlaneGeometry(0.7, 2.6);
  wispBase.translate(0, 1.3, 0);
  const wispCross = wispBase.clone().rotateY(Math.PI / 2);
  const wispGeo = BufferGeometryUtils.mergeGeometries([wispBase, wispCross]);
  wispBase.dispose(); wispCross.dispose();

  // drifting embers: tiny crossed quads
  const emberBase = new THREE.PlaneGeometry(0.09, 0.09);
  const emberCross = emberBase.clone().rotateY(Math.PI / 2);
  const emberGeo = BufferGeometryUtils.mergeGeometries([emberBase, emberCross]);
  emberBase.dispose(); emberCross.dispose();

  // landmark light beams (portal / beacon): open cylinders fading with height
  const beamGeo = new THREE.CylinderGeometry(0.9, 1.6, 16, 12, 1, true);
  beamGeo.translate(0, 8, 0);

  // glowing rune architrave above the temple door
  const runeGeo = new THREE.PlaneGeometry(2.6, 0.42);

  // navmesh overlay cell: a thin quad per walkable cell
  const navCellGeo = new THREE.PlaneGeometry(CELL * 0.94, CELL * 0.94);
  navCellGeo.rotateX(-Math.PI / 2);

  // navigation chevron: two flat wings meeting in a tip that points along +z
  const arrowGeo = (() => {
    const wingL = new THREE.PlaneGeometry(0.46, 0.15);
    wingL.rotateX(-Math.PI / 2);
    wingL.rotateY(0.75);
    wingL.translate(-0.145, 0, -0.03);
    const wingR = new THREE.PlaneGeometry(0.46, 0.15);
    wingR.rotateX(-Math.PI / 2);
    wingR.rotateY(-0.75);
    wingR.translate(0.145, 0, -0.03);
    const merged = BufferGeometryUtils.mergeGeometries([wingL, wingR]);
    wingL.dispose(); wingR.dispose();
    merged.rotateY(Math.PI); // tip forward (+z = direction of travel)
    return merged;
  })();

  // craggy root spike under each island — nobody should see a flat underside
  const plugGeo = (() => {
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
  })();

  return {
    blockGeo: shadeFaces(new RoundedBoxGeometry(CELL * 1.02, COURSE * 1.02, CELL * 1.02, 1, 0.06)),
    blockGeoLo: shadeFaces(new THREE.BoxGeometry(CELL * 1.02, COURSE * 1.02, CELL * 1.02)),
    tileGeo: shadeFaces(new RoundedBoxGeometry(CELL * 0.985, 0.15, CELL * 0.985, 1, 0.045)),
    tileGeoLo: shadeFaces(new THREE.BoxGeometry(CELL * 0.985, 0.15, CELL * 0.985)),
    merlonGeo: shadeFaces(new RoundedBoxGeometry(0.72, 0.55, 0.72, 1, 0.05)),
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
    rootGeo,
    leafGeo,
    creeperGeo,
    brambleGeoA: buildBrambleGeo(0xb4a3b1e),
    brambleGeoB: buildBrambleGeo(0x7708a2),
    wispGeo,
    runeGeo,
    arrowGeo,
    navCellGeo,
    plugGeo,
    emberGeo,
    beamGeo,
    portalGeo: new THREE.PlaneGeometry(1.8, 2.4),
    beaconGeo: new THREE.OctahedronGeometry(0.45),
  };
}
