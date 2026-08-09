// Shared geometry kit — built ONCE and reused by every regeneration. WebGPU
// pipeline compilation keys off geometry/material identity, so keeping these
// stable means a re-forge only refills instance buffers.

import * as THREE from "three/webgpu";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { mulberry32 } from "../../gen/rng";
import { TH, CELL, COURSE, BRIDGE_SPAN } from "../../config";

/** A one-segment chamfered box with the same readable silhouette as the
 * rounded-box kit, but without tessellating every flat face into a 3×3 grid.
 * 6 octagonal faces + 12 edge quads + 8 corner triangles = 68 triangles,
 * versus RoundedBoxGeometry(segments=1)'s 108. Geometry is non-indexed on
 * purpose so every plane owns a hard normal for the painterly face shading. */
export function chamferBoxGeometry(
  width: number, height: number, depth: number, bevel: number,
): THREE.BufferGeometry {
  const hx = width / 2, hy = height / 2, hz = depth / 2;
  const b = Math.max(0, Math.min(bevel, hx, hy, hz));
  if (b === 0) return new THREE.BoxGeometry(width, height, depth);
  const ix = hx - b, iy = hy - b, iz = hz - b;
  const positions: number[] = [];
  const normals: number[] = [];
  const addFace = (vertices: THREE.Vector3[], expected: THREE.Vector3) => {
    const edgeA = new THREE.Vector3().subVectors(vertices[1], vertices[0]);
    const edgeB = new THREE.Vector3().subVectors(vertices[2], vertices[0]);
    if (new THREE.Vector3().crossVectors(edgeA, edgeB).dot(expected) < 0) vertices.reverse();
    const n = expected.clone().normalize();
    for (let i = 1; i < vertices.length - 1; i++) {
      for (const v of [vertices[0], vertices[i], vertices[i + 1]]) {
        positions.push(v.x, v.y, v.z);
        normals.push(n.x, n.y, n.z);
      }
    }
  };
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // Six broad faces. Their clipped corners are the only extra topology on
  // the flat planes; edge and corner planes below close the shell.
  for (const s of [-1, 1]) {
    addFace([
      v(s * hx, -iy, -hz), v(s * hx, iy, -hz), v(s * hx, hy, -iz), v(s * hx, hy, iz),
      v(s * hx, iy, hz), v(s * hx, -iy, hz), v(s * hx, -hy, iz), v(s * hx, -hy, -iz),
    ], v(s, 0, 0));
    addFace([
      v(-hx, s * hy, -iz), v(-ix, s * hy, -hz), v(ix, s * hy, -hz), v(hx, s * hy, -iz),
      v(hx, s * hy, iz), v(ix, s * hy, hz), v(-ix, s * hy, hz), v(-hx, s * hy, iz),
    ], v(0, s, 0));
    addFace([
      v(-ix, -hy, s * hz), v(ix, -hy, s * hz), v(hx, -iy, s * hz), v(hx, iy, s * hz),
      v(ix, hy, s * hz), v(-ix, hy, s * hz), v(-hx, iy, s * hz), v(-hx, -iy, s * hz),
    ], v(0, 0, s));
  }

  // Twelve bevel strips, grouped by their free axis.
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    addFace([
      v(sx * hx, sy * iy, -iz), v(sx * ix, sy * hy, -iz),
      v(sx * ix, sy * hy, iz), v(sx * hx, sy * iy, iz),
    ], v(sx, sy, 0));
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    addFace([
      v(sx * hx, -iy, sz * iz), v(sx * ix, -iy, sz * hz),
      v(sx * ix, iy, sz * hz), v(sx * hx, iy, sz * iz),
    ], v(sx, 0, sz));
  }
  for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    addFace([
      v(-ix, sy * hy, sz * iz), v(-ix, sy * iy, sz * hz),
      v(ix, sy * iy, sz * hz), v(ix, sy * hy, sz * iz),
    ], v(0, sy, sz));
  }

  // Eight tiny corner planes preserve highlights and chipped silhouettes.
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    addFace([
      v(sx * hx, sy * iy, sz * iz),
      v(sx * ix, sy * hy, sz * iz),
      v(sx * ix, sy * iy, sz * hz),
    ], v(sx, sy, sz));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** A wall course with another course directly above and below never exposes
 * horizontal faces. Extrude only its XZ ring: four wall planes plus vertical
 * corner bevels, with no mutually-hidden caps or horizontal bevel bands. */
export function openCourseGeometry(
  width: number, height: number, depth: number, bevel: number,
): THREE.BufferGeometry {
  const hx = width / 2, hy = height / 2, hz = depth / 2;
  const b = Math.max(0, Math.min(bevel, hx, hz));
  const ring: number[][] = b > 0
    ? [
      [-hx + b, -hz], [hx - b, -hz], [hx, -hz + b], [hx, hz - b],
      [hx - b, hz], [-hx + b, hz], [-hx, hz - b], [-hx, -hz + b],
    ]
    : [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
  const positions: number[] = [];
  const normals: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], c = ring[(i + 1) % ring.length];
    const dx = c[0] - a[0], dz = c[1] - a[1];
    // `ring` runs clockwise in XZ as seen from +Y. The previous winding used
    // the inward normal (−dz,+dx), so FrontSide materials discarded ordinary
    // middle courses from outside the wall. Low LOD uses a closed BoxGeometry,
    // which is why bricks appeared to vanish only after approaching an island.
    const nx = dz, nz = -dx;
    const inv = 1 / Math.hypot(nx, nz);
    for (const [x, y, z] of [
      [a[0], -hy, a[1]], [c[0], hy, c[1]], [c[0], -hy, c[1]],
      [a[0], -hy, a[1]], [a[0], hy, a[1]], [c[0], hy, c[1]],
    ]) {
      positions.push(x, y, z);
      normals.push(nx * inv, 0, nz * inv);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** A course sealed at both ends, built from the same octagonal ring rather
 *  than reusing the general-purpose chamfer box.
 *
 *  Why this exists: courses are deliberately jittered — each is offset by up to
 *  0.11 and scaled 0.965..1.035 for the hand-laid look — so the course above
 *  covers perhaps 90% of the one below. The uncovered ring around the edge is
 *  exactly where a missing cap becomes a window into the hollow interior. No
 *  neighbour test can fix that, because "has a course above" was never the same
 *  question as "is covered".
 *
 *  16 side triangles + 6 top + 6 bottom = 28, against 68 for chamferBoxGeometry
 *  which spends most of its budget on corner and cap bevel planes nobody sees
 *  at this size.
 */
export function sealedCourseGeometry(
  width: number, height: number, depth: number, bevel: number,
): THREE.BufferGeometry {
  // Sides once, from the open course; caps from the two slab variants with
  // their own side rings discarded, so the ring is not tripled.
  const sides = openCourseGeometry(width, height, depth, bevel);
  const top = capOnly(openChamferSlabGeometry(width, height, depth, bevel), 1);
  const base = capOnly(openBaseGeometry(width, height, depth, bevel), -1);
  const merged = BufferGeometryUtils.mergeGeometries([sides, top, base]);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** Keep only the triangles whose normal points along +Y or -Y — the cap of a
 *  slab, discarding its vertical ring. */
function capOnly(source: THREE.BufferGeometry, sign: number): THREE.BufferGeometry {
  const position = source.getAttribute("position");
  const normal = source.getAttribute("normal");
  const positions: number[] = [];
  const normals: number[] = [];
  for (let i = 0; i < position.count; i += 3) {
    if (normal.getY(i) * sign < 0.5) continue;
    for (let v = 0; v < 3; v++) {
      positions.push(position.getX(i + v), position.getY(i + v), position.getZ(i + v));
      normals.push(normal.getX(i + v), normal.getY(i + v), normal.getZ(i + v));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  return geometry;
}

/** Mirror of openChamferSlabGeometry: bottom cap plus the vertical ring, no
 *  top. Needed by the column planner for a course that has masonry above it
 *  but open air below — the case that produced see-through banding when the
 *  only options were "sealed", "capped" and "open at both ends".
 */
export function openBaseGeometry(
  width: number, height: number, depth: number, bevel: number,
): THREE.BufferGeometry {
  const source = openChamferSlabGeometry(width, height, depth, bevel);
  const position = source.getAttribute("position") as THREE.BufferAttribute;
  const normal = source.getAttribute("normal") as THREE.BufferAttribute;
  // Flip through the XZ plane, then reverse winding so faces still point out.
  for (let i = 0; i < position.count; i++) {
    position.setY(i, -position.getY(i));
    normal.setY(i, -normal.getY(i));
  }
  for (let i = 0; i < position.count; i += 3) {
    for (const attr of [position, normal]) {
      const ax = attr.getX(i + 1), ay = attr.getY(i + 1), az = attr.getZ(i + 1);
      attr.setXYZ(i + 1, attr.getX(i + 2), attr.getY(i + 2), attr.getZ(i + 2));
      attr.setXYZ(i + 2, ax, ay, az);
    }
  }
  position.needsUpdate = true;
  normal.needsUpdate = true;
  source.computeBoundingBox();
  source.computeBoundingSphere();
  return source;
}

/** A floor slab only exposes its chamfered top and outer vertical ring. The
 * old general-purpose chamfer box spent 46 of 68 triangles on a sealed bottom
 * and corner/cap planes hidden inside supporting masonry. */
export function openChamferSlabGeometry(
  width: number, height: number, depth: number, bevel: number,
): THREE.BufferGeometry {
  const hx = width / 2, hy = height / 2, hz = depth / 2;
  const b = Math.max(0, Math.min(bevel, hx, hz));
  const ring = b > 0
    ? [
      [-hx + b, -hz], [hx - b, -hz], [hx, -hz + b], [hx, hz - b],
      [hx - b, hz], [-hx + b, hz], [-hx, hz - b], [-hx, -hz + b],
    ]
    : [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
  const positions: number[] = [];
  const normals: number[] = [];
  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    positions.push(x, y, z); normals.push(nx, ny, nz);
  };
  // Top octagon: six triangles, clockwise ring reversed to face +Y.
  for (let i = 1; i < ring.length - 1; i++) {
    for (const p of [ring[0], ring[i + 1], ring[i]]) push(p[0], hy, p[1], 0, 1, 0);
  }
  // Eight side strips include the four corner bevel planes. No bottom cap.
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], c = ring[(i + 1) % ring.length];
    const dx = c[0] - a[0], dz = c[1] - a[1];
    const inv = 1 / Math.hypot(dx, dz), nx = dz * inv, nz = -dx * inv;
    for (const [x, y, z] of [
      [a[0], -hy, a[1]], [c[0], hy, c[1]], [c[0], -hy, c[1]],
      [a[0], -hy, a[1]], [a[0], hy, a[1]], [c[0], hy, c[1]],
    ]) push(x, y, z, nx, 0, nz);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Twelve-triangle fractured hexahedron for GPU debris. Each logical corner
 * gets a stable asymmetric inset, then triangles are split to hard normals.
 * It costs exactly the same triangle count as the old box but catches light
 * as broken stone instead of eight identical miniature bricks. */
export function fracturedBlockGeometry(
  width: number, height: number, depth: number,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(width, height, depth).toNonIndexed();
  const position = geo.getAttribute("position");
  const cornerScale = [
    [0.82, 0.94, 0.86], [0.96, 0.82, 0.91], [0.88, 1.00, 0.79], [1.00, 0.89, 0.96],
    [0.91, 0.78, 1.00], [0.79, 0.96, 0.88], [1.00, 0.86, 0.83], [0.86, 1.00, 0.97],
  ];
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    const corner = (x > 0 ? 1 : 0) | (y > 0 ? 2 : 0) | (z > 0 ? 4 : 0);
    const s = cornerScale[corner];
    position.setXYZ(i, x * s[0], y * s[1], z * s[2]);
  }
  position.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return shadeFaces(geo);
}

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
  blockMiddleGeo: THREE.BufferGeometry;
  blockTopGeo: THREE.BufferGeometry;
  blockBaseGeo: THREE.BufferGeometry;
  debrisGeo: THREE.BufferGeometry;
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
  stainGeo: THREE.BufferGeometry;
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
  architecturalBayGeo: THREE.BufferGeometry;
  towerRoofGeo: THREE.BufferGeometry;
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

  // Floor stains share one cheap splatter silhouette. The central pool and
  // four detached drops are merged once; per-instance non-uniform scale/yaw
  // then makes blood and damp grime read as authored decals without textures,
  // extra objects, or a decal projector per mark.
  const stainGeo = (() => {
    const parts: THREE.BufferGeometry[] = [];
    const addDrop = (radius: number, x: number, z: number, segments: number) => {
      const g = new THREE.CircleGeometry(radius, segments);
      g.rotateX(-Math.PI / 2);
      g.translate(x, 0, z);
      parts.push(g);
    };
    addDrop(0.58, 0, 0, 14);
    addDrop(0.13, 0.67, 0.16, 7);
    addDrop(0.09, -0.61, -0.27, 6);
    addDrop(0.065, 0.34, -0.55, 6);
    addDrop(0.052, -0.29, 0.64, 5);
    const merged = BufferGeometryUtils.mergeGeometries(parts);
    for (const g of parts) g.dispose();
    return merged;
  })();

  // ancient column (unit height, base at y=0, gentle entasis taper)
  const colGeo = new THREE.CylinderGeometry(0.16, 0.2, 1, 8);
  colGeo.translate(0, 0.5, 0);
  shadeFaces(colGeo);

  // One repeated Gothic façade bay replaces the visual grammar of isolated
  // wall cells with a continuous building elevation. Adjacent instances share
  // their edge buttresses and cornice, while the central voussoir arch breaks
  // the square silhouette. It remains one instanced draw per island.
  const architecturalBayGeo = (() => {
    const parts: THREE.BufferGeometry[] = [];
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const euler = new THREE.Euler();
    const add = (
      geometry: THREE.BufferGeometry,
      p: [number, number, number],
      s: [number, number, number] = [1, 1, 1],
      r: [number, number, number] = [0, 0, 0],
    ) => {
      matrix.compose(position.set(...p), quaternion.setFromEuler(euler.set(...r)), scale.set(...s));
      geometry.applyMatrix4(matrix);
      parts.push(geometry);
    };
    // Continuous sill and crown make neighboring cells read as one façade.
    add(new THREE.BoxGeometry(CELL * 1.08, 0.24, 0.38), [0, 0.18, 0.08]);
    add(new THREE.BoxGeometry(CELL * 1.12, 0.32, 0.5), [0, 4.86, 0.1]);
    add(new THREE.BoxGeometry(CELL * 1.02, 0.16, 0.32), [0, 3.92, 0.12]);
    // Half-buttresses overlap at bay seams, producing full tapered piers.
    for (const side of [-1, 1]) {
      add(new THREE.CylinderGeometry(0.27, 0.46, 4.55, 5), [side * CELL * 0.5, 2.28, 0.16], [1, 1, 0.72], [0, Math.PI / 5, 0]);
      add(new THREE.BoxGeometry(0.68, 0.3, 0.64), [side * CELL * 0.5, 4.58, 0.14]);
    }
    // Pointed stone surround: paired jambs and nine chunky voussoirs.
    for (const side of [-1, 1]) {
      add(new THREE.BoxGeometry(0.3, 2.45, 0.34), [side * 0.88, 1.48, 0.22]);
      add(new THREE.BoxGeometry(0.5, 0.26, 0.42), [side * 0.88, 0.2, 0.22]);
    }
    for (let i = 0; i < 9; i++) {
      const a = i / 8 * Math.PI;
      const x = Math.cos(a) * 0.88;
      const y = 2.7 + Math.sin(a) * 1.02 + Math.abs(Math.cos(a)) * 0.2;
      add(new THREE.BoxGeometry(0.44, 0.62, 0.4), [x, y, 0.24], [1, 1, 1], [0, 0, a - Math.PI / 2]);
    }
    const merged = BufferGeometryUtils.mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (!merged) throw new Error("failed to merge architectural façade bay");
    return shadeFaces(merged);
  })();

  // A low-poly hexagonal slate roof changes tower silhouettes without adding
  // per-tower objects. The shallow eave prevents it reading as a raw cone.
  const towerRoofGeo = (() => {
    const eave = new THREE.CylinderGeometry(1.08, 1.08, 0.12, 6);
    eave.translate(0, 0.06, 0);
    const roof = new THREE.ConeGeometry(1, 1, 6, 1, false);
    roof.translate(0, 0.62, 0);
    const merged = BufferGeometryUtils.mergeGeometries([eave, roof], false);
    eave.dispose();
    roof.dispose();
    if (!merged) throw new Error("failed to merge tower roof");
    return shadeFaces(merged);
  })();

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

  const kit: GeoKit = {
    // Same 68/16/22-triangle topology, but a broader hand-cut arris. The old
    // 0.06 bevel was sub-pixel in ordinary gameplay and left the masonry
    // reading as perfectly extruded cubes even with a detailed shader.
    blockGeo: shadeFaces(chamferBoxGeometry(CELL * 1.08, COURSE * 1.06, CELL * 1.08, 0.11)),
    blockGeoLo: shadeFaces(new THREE.BoxGeometry(CELL * 1.08, COURSE * 1.06, CELL * 1.08)),
    // Sealed, not open: jittered courses only partially cover each other, so
    // an uncapped middle course shows its hollow interior through the gap.
    blockMiddleGeo: shadeFaces(sealedCourseGeometry(CELL * 1.08, COURSE * 1.06, CELL * 1.08, 0.11)),
    blockTopGeo: shadeFaces(sealedCourseGeometry(CELL * 1.08, COURSE * 1.06, CELL * 1.08, 0.11)),
    blockBaseGeo: shadeFaces(sealedCourseGeometry(CELL * 1.08, COURSE * 1.06, CELL * 1.08, 0.11)),
    debrisGeo: fracturedBlockGeometry(CELL * 1.08, COURSE * 1.06, CELL * 1.08),
    tileGeo: shadeFaces(openChamferSlabGeometry(CELL * 0.985, 0.15, CELL * 0.985, 0.065)),
    tileGeoLo: shadeFaces(new THREE.BoxGeometry(CELL * 0.985, 0.15, CELL * 0.985)),
    merlonGeo: shadeFaces(openChamferSlabGeometry(0.72, 0.55, 0.72, 0.07)),
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
    rubbleGeo: shadeFaces(new THREE.DodecahedronGeometry(0.17, 0)),
    crateGeo: shadeFaces(new THREE.BoxGeometry(0.72, 0.72, 0.72)),
    vineGeo,
    linkGeo: new THREE.BoxGeometry(0.07, 0.34, 0.16),
    mossGeo,
    stainGeo,
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
    architecturalBayGeo,
    towerRoofGeo,
  };
  for (const [name, geometry] of Object.entries(kit)) geometry.name = name;
  return kit;
}
