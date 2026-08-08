// Code-native abyss landmarks reconstructed from the admitted img2threejs
// references.  The hero geometry is deliberately silhouette-heavy and keeps
// the whole exterior layer to a small, fixed draw-call count: stone/cavity
// pairs for the instanced wardens, buried skull and distant oracle, plus the
// shared arch, rubble and chain batches.

import * as THREE from "three/webgpu";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { color } from "three/tsl";
import { hash2 } from "../gen/rng";
import { ABYSS } from "../gen/dungeon";
import { TH } from "../config";
import { makeHandPaintedLandmarkStoneMaterial } from "./kit/materials";

type AddPart = (
  geometry: THREE.BufferGeometry,
  position: [number, number, number],
  scale?: [number, number, number],
  rotation?: [number, number, number],
) => void;

function mergedParts(build: (add: AddPart) => void): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  build((geometry, p, s = [1, 1, 1], r = [0, 0, 0]) => {
    let part = geometry;
    if (part.index) {
      part = part.toNonIndexed();
      geometry.dispose();
    }
    for (const key of Object.keys(part.attributes)) {
      if (key !== "position" && key !== "normal") part.deleteAttribute(key);
    }
    matrix.compose(
      position.set(...p),
      quaternion.setFromEuler(euler.set(...r)),
      scale.set(...s),
    );
    part.applyMatrix4(matrix);
    parts.push(part);
  });
  const merged = BufferGeometryUtils.mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error("failed to merge abyss landmark geometry");
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function paintFacets(geometry: THREE.BufferGeometry, dark: number, light: number, seed: number): void {
  const pos = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const colors = new Float32Array(pos.count * 3);
  const lo = new THREE.Color(dark);
  const hi = new THREE.Color(light);
  const c = new THREE.Color();
  for (let tri = 0; tri < pos.count; tri += 3) {
    const cx = (pos.getX(tri) + pos.getX(tri + 1) + pos.getX(tri + 2)) / 3;
    const cy = (pos.getY(tri) + pos.getY(tri + 1) + pos.getY(tri + 2)) / 3;
    const cz = (pos.getZ(tri) + pos.getZ(tri + 1) + pos.getZ(tri + 2)) / 3;
    const raw = Math.sin(cx * 12.9898 + cy * 78.233 + cz * 37.719 + seed * 0.173) * 43758.5453;
    const grain = raw - Math.floor(raw);
    const top = normal ? Math.max(0, (normal.getY(tri) + normal.getY(tri + 1) + normal.getY(tri + 2)) / 3) : 0;
    c.copy(lo).lerp(hi, Math.min(1, 0.18 + grain * 0.42 + top * 0.22));
    for (let n = 0; n < 3; n++) {
      colors[(tri + n) * 3] = c.r;
      colors[(tri + n) * 3 + 1] = c.g;
      colors[(tri + n) * 3 + 2] = c.b;
    }
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

/** A low-sided, tapered curve mesh. Non-uniform radii and the Catmull-Rom
 * centreline produce real three-dimensional appendages that hold from side
 * views; they are not stacked cylinders or a camera-facing relief. */
function facetedTube(
  points: Array<[number, number, number]>,
  radii: number[],
  segments = 20,
  sides = 7,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, "centripetal");
  const frames = curve.computeFrenetFrames(segments, false);
  const positions: number[] = [];
  const indices: number[] = [];
  const centre = new THREE.Vector3();
  const radial = new THREE.Vector3();
  const radiusAt = (t: number) => {
    const f = t * (radii.length - 1);
    const i = Math.min(radii.length - 2, Math.floor(f));
    return THREE.MathUtils.lerp(radii[i], radii[i + 1], f - i);
  };
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, centre);
    const radius = radiusAt(t);
    for (let j = 0; j < sides; j++) {
      const a = j / sides * Math.PI * 2;
      const facet = 1 + Math.sin((i * 17 + j * 29) * 1.731) * 0.035;
      radial.copy(frames.normals[i]).multiplyScalar(Math.cos(a));
      radial.addScaledVector(frames.binormals[i], Math.sin(a)).multiplyScalar(radius * facet);
      positions.push(centre.x + radial.x, centre.y + radial.y, centre.z + radial.z);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * sides + j;
      const b = i * sides + (j + 1) % sides;
      const c = (i + 1) * sides + j;
      const d = (i + 1) * sides + (j + 1) % sides;
      indices.push(a, c, b, b, c, d);
    }
  }
  const startCentre = positions.length / 3;
  curve.getPointAt(0, centre);
  positions.push(centre.x, centre.y, centre.z);
  const endCentre = positions.length / 3;
  curve.getPointAt(1, centre);
  positions.push(centre.x, centre.y, centre.z);
  for (let j = 0; j < sides; j++) {
    indices.push(startCentre, (j + 1) % sides, j);
    const a = segments * sides + j;
    const b = segments * sides + (j + 1) % sides;
    indices.push(endCentre, a, b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function swordBladeGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-2.3, 0);
  shape.lineTo(0, -5.4);
  shape.lineTo(2.3, 0);
  shape.lineTo(2.0, 22);
  shape.lineTo(0, 24.2);
  shape.lineTo(-2.0, 22);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 1.1,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: 0.18,
    bevelThickness: 0.16,
    curveSegments: 1,
  });
  geometry.translate(0, 0, -0.55);
  return geometry;
}

function guardianStoneGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    // Throne and rubble plinth establish side-view thickness and embed every
    // lower contact instead of leaving a freestanding mannequin.
    add(new THREE.BoxGeometry(22, 3.2, 12), [0, 1.6, -1]);
    add(new THREE.BoxGeometry(15.5, 30, 6.2), [0, 19, -5.2], [1, 1, 1], [0.03, 0, 0]);
    add(new THREE.BoxGeometry(4.8, 29, 5.2), [-10.2, 16.5, -4], [1, 1, 1], [0, 0, -0.08]);
    add(new THREE.BoxGeometry(4.8, 26, 5.2), [10.2, 15, -4], [1, 1, 1], [0, 0, 0.06]);
    for (let k = 0; k < 8; k++) {
      const side = k & 1 ? 1 : -1;
      add(new THREE.IcosahedronGeometry(1, 1), [side * (4.5 + (k % 3) * 2.2), 1.2 + (k % 2), -1 + (k % 4) * 1.8], [2.5, 1.5, 2.2]);
    }

    // Seated legs, feet and plate-like knees.
    add(new THREE.IcosahedronGeometry(1, 2), [-4.7, 10.2, 0], [4.3, 7.8, 4.1], [0.03, 0, -0.08]);
    add(new THREE.IcosahedronGeometry(1, 2), [4.7, 10.2, 0], [4.3, 7.8, 4.1], [-0.03, 0, 0.08]);
    add(new THREE.IcosahedronGeometry(1, 1), [-5.2, 4.2, 4.1], [4.7, 2.2, 5.6]);
    add(new THREE.IcosahedronGeometry(1, 1), [5.2, 4.2, 4.1], [4.7, 2.2, 5.6]);
    add(new THREE.BoxGeometry(6.2, 2.2, 5), [-4.6, 14.8, 2.2], [1, 1, 1], [0.08, 0, -0.1]);
    add(new THREE.BoxGeometry(6.2, 2.2, 5), [4.6, 14.8, 2.2], [1, 1, 1], [-0.08, 0, 0.1]);

    // Torso core and layered collar/chest plates.
    add(new THREE.IcosahedronGeometry(1, 2), [0, 29.4, -0.2], [10.2, 9.1, 4.8]);
    add(new THREE.IcosahedronGeometry(1, 1), [0, 34.2, 2.5], [6.2, 1.45, 3.4], [0.05, 0, 0]);
    add(new THREE.IcosahedronGeometry(1, 1), [0, 31.5, 3.2], [5.6, 1.35, 3.15], [-0.06, 0, 0]);
    add(new THREE.OctahedronGeometry(3.7, 0), [0, 28.8, 4.3], [1.15, 1.25, 0.42], [0, 0, Math.PI / 4]);

    // Three overlapping pauldron tiers per side; the uneven cant keeps the two
    // instances from reading as stacks of identical boxes in moonlight.
    for (const side of [-1, 1]) {
      for (let tier = 0; tier < 3; tier++) {
        add(
          new THREE.IcosahedronGeometry(1, 1),
          [side * (8.0 + tier * 0.55), 34.2 - tier * 2.15, 0.4 + tier * 0.55],
          [5.3 - tier * 0.35, 1.55 - tier * 0.08, 3.5 - tier * 0.22],
          [0.04 * tier, side * 0.06, side * (0.26 - tier * 0.055)],
        );
      }
      add(new THREE.IcosahedronGeometry(1, 1), [side * 8.3, 27.1, 1.4], [3.2, 5.8, 3.0], [0, 0, side * 0.17]);
      add(new THREE.IcosahedronGeometry(1, 1), [side * 4.9, 23.3, 4.1], [5.0, 2.6, 2.8], [0, side * 0.12, side * 0.20]);
      add(new THREE.IcosahedronGeometry(1, 1), [side * 2.6, 23.0, 5.0], [2.7, 2.1, 2.0]);
      for (let finger = 0; finger < 4; finger++) {
        add(new THREE.BoxGeometry(0.75, 1.15, 1.8), [side * (0.75 + finger * 0.58), 21.8 - finger * 0.07, 6.1], [1, 1, 1], [0, 0, side * 0.12]);
      }
    }

    // Helmet, cheek guards and an irregular broken crown.
    add(new THREE.IcosahedronGeometry(1, 2), [0, 42.2, 0.5], [4.8, 5.8, 4.0]);
    add(new THREE.CylinderGeometry(5.2, 4.8, 2.5, 9), [0, 45.3, 0.4]);
    add(new THREE.BoxGeometry(2.5, 6.2, 1.8), [-2.2, 39.6, 4.1], [1, 1, 1], [0.08, 0.12, 0.12]);
    add(new THREE.BoxGeometry(2.5, 6.2, 1.8), [2.2, 39.6, 4.1], [1, 1, 1], [0.08, -0.12, -0.12]);
    add(new THREE.OctahedronGeometry(2.0, 0), [0, 39.5, 5.0], [0.8, 1.8, 0.7]);
    add(new THREE.CylinderGeometry(5.3, 5.0, 2.2, 9), [0, 48.0, 0.3]);
    const crownHeights = [5.0, 6.6, 7.8, 6.9, 5.5, 4.7, 5.8];
    for (let k = 0; k < crownHeights.length; k++) {
      const x = (k - 3) * 1.45;
      add(new THREE.ConeGeometry(1.1, crownHeights[k] * 0.78, 4), [x, 50.0 + crownHeights[k] * 0.33, 0.2 + Math.abs(k - 3) * 0.18], [1, 1, 0.9], [0.04 * (k & 1 ? 1 : -1), 0, (k - 3) * 0.025]);
    }

    // Sword, pommel, guard and raised fuller. The blade tip penetrates the
    // plinth, while both hands overlap the pommel by more than 0.02 units.
    add(swordBladeGeometry(), [0, 1.4, 6.2]);
    add(new THREE.BoxGeometry(9.2, 1.1, 1.5), [0, 25.9, 6.2]);
    add(new THREE.CylinderGeometry(0.8, 0.8, 4.0, 7), [0, 28.0, 6.2]);
    add(new THREE.OctahedronGeometry(1.3, 0), [0, 30.2, 6.2]);
    add(new THREE.BoxGeometry(0.55, 20.2, 1.22), [0, 11.8, 6.8]);
  });
  paintFacets(geometry, 0x293950, 0x65758c, 71);
  return geometry;
}

function guardianVoidGeometry(): THREE.BufferGeometry {
  return mergedParts((add) => {
    add(new THREE.CircleGeometry(1, 9), [0, 42.7, 4.25], [3.45, 0.72, 1], [0, 0, 0]);
    add(new THREE.BoxGeometry(2.1, 5.7, 0.35), [0, 39.6, 5.25], [1, 1, 1], [0, 0, 0]);
  });
}

function dragonSkullStoneGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    // Cranium and progressively tapered muzzle volumes.
    add(new THREE.IcosahedronGeometry(1, 2), [0, 14.2, -1.5], [13.5, 9.2, 10.0], [0.02, 0, 0.02]);
    add(new THREE.IcosahedronGeometry(1, 2), [0, 11.0, 8.5], [10.5, 6.2, 7.8]);
    add(new THREE.IcosahedronGeometry(1, 1), [0, 8.4, 18.0], [7.5, 4.5, 7.3]);
    add(new THREE.IcosahedronGeometry(1, 1), [0, 7.0, 26.0], [4.9, 3.2, 6.0]);
    add(facetedTube([[0, 10.0, 24.0], [0, 13.6, 27.2], [0, 18.2, 27.8]], [1.5, 1.0, 0.08], 8, 6), [0, 0, 0]);
    add(new THREE.TorusGeometry(3.7, 1.05, 6, 12), [-5.2, 15.7, 12.05], [1.08, 0.92, 1], [0, 0, -0.10]);
    add(new THREE.TorusGeometry(3.7, 1.05, 6, 12), [5.2, 15.7, 12.05], [1.08, 0.92, 1], [0, 0, 0.10]);
    for (const side of [-1, 1]) {
      add(facetedTube([
        [side * 5.4, 8.0, 8.2], [side * 5.1, 7.1, 15.5], [side * 4.4, 6.5, 23.0], [side * 3.3, 6.0, 29.0],
      ], [1.25, 1.05, 0.85, 0.5], 14, 7), [0, 0, 0]);
      add(facetedTube([
        [side * 5.0, 2.8, 7.5], [side * 4.8, 2.0, 15.0], [side * 4.0, 1.8, 22.0], [side * 2.9, 2.0, 27.0],
      ], [1.15, 1.0, 0.75, 0.42], 13, 7), [0, 0, 0]);
    }

    // Real side arches around the orbit; these keep an open socket from front
    // and three-quarter views instead of painting a black circle on a sphere.
    for (const side of [-1, 1]) {
      add(facetedTube([
        [side * 5.2, 20.2, 2.2], [side * 9.2, 18.8, 5.8], [side * 11.0, 14.2, 10.5], [side * 8.6, 10.0, 14.2],
      ], [1.9, 1.65, 1.35, 1.1], 11, 7), [0, 0, 0]);
      add(facetedTube([
        [side * 5.0, 6.1, 8.8], [side * 6.2, 4.6, 14.6], [side * 5.8, 3.7, 21.8], [side * 4.2, 3.0, 28.0],
      ], [1.75, 1.55, 1.2, 0.72], 13, 7), [0, 0, 0]);
    }

    // One dominant swept rear horn, one damaged partner and four cheek spikes.
    add(facetedTube([[5, 20, -5], [8, 25, -10], [10, 31, -17], [9, 37, -27]], [3.0, 2.5, 1.55, 0.12], 18, 7), [0, 0, 0]);
    add(facetedTube([[-6, 20, -5], [-10, 24, -10], [-12, 28, -16], [-12, 31, -20]], [2.8, 2.2, 1.25, 0.18], 14, 7), [0, 0, 0]);
    const spikeRoots: Array<[number, number, number, number]> = [
      [-11, 15, 0, -1], [11, 15, 0, 1], [-10, 10, 10, -1], [10, 10, 10, 1],
    ];
    for (const [x, y, z, side] of spikeRoots) {
      add(facetedTube([[x, y, z], [x + side * 4, y + 3, z - 1], [x + side * 7, y + 5, z - 2]], [1.6, 0.9, 0.08], 7, 6), [0, 0, 0]);
    }

    // Broken jaw hinge blocks and a few fossil chips that bridge into rubble.
    add(new THREE.IcosahedronGeometry(1, 1), [-7.6, 5.4, 5.0], [3.2, 3.1, 3.6]);
    add(new THREE.IcosahedronGeometry(1, 1), [7.6, 5.4, 5.0], [3.2, 3.1, 3.6]);
    for (let k = 0; k < 9; k++) {
      const a = -0.45 + k * 0.46;
      add(new THREE.IcosahedronGeometry(1, 1), [Math.cos(a) * (10 + k % 3), 0.8 + k % 2, 5 + Math.sin(a) * 12], [2.2 + k % 2, 1.5 + (k % 3) * 0.4, 2.0]);
    }
  });
  paintFacets(geometry, 0x34445a, 0x758299, 113);
  return geometry;
}

function dragonSkullTeethGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    // Teeth are a separate merged colour batch. They keep the inherited fossil
    // material family but stay readable against the near-black mouth gap.
    for (let k = 0; k < 12; k++) {
      const side = k & 1 ? 1 : -1;
      const row = Math.floor(k / 2);
      const z = 8.8 + row * 3.45;
      const height = 3.0 + (row % 3) * 0.68;
      add(new THREE.ConeGeometry(0.82 + (row % 2) * 0.12, height, 7), [side * (5.1 - row * 0.36), 6.0 - height / 2, z], [1, 1, 0.82], [0, 0, Math.PI + side * 0.08]);
      if (row < 5) add(new THREE.ConeGeometry(0.68, height * 0.78, 7), [side * (4.9 - row * 0.31), 2.8 + height * 0.32, z + 0.62], [1, 1, 0.82], [0, 0, side * 0.08]);
    }
  });
  paintFacets(geometry, 0x66758b, 0xa7b1c0, 139);
  return geometry;
}

function dragonSkullVoidGeometry(): THREE.BufferGeometry {
  return mergedParts((add) => {
    add(new THREE.CircleGeometry(1, 12), [-5.2, 15.7, 11.9], [4.5, 4.15, 1], [0, 0, -0.10]);
    add(new THREE.CircleGeometry(1, 12), [5.2, 15.7, 11.9], [4.5, 4.15, 1], [0, 0, 0.10]);
    add(new THREE.CircleGeometry(1, 7), [-1.45, 8.7, 32.1], [0.72, 1.0, 1], [0, 0, -0.08]);
    add(new THREE.CircleGeometry(1, 7), [1.45, 8.7, 32.1], [0.72, 1.0, 1], [0, 0, 0.08]);
    add(new THREE.BoxGeometry(9.4, 2.9, 21), [0, 4.3, 19.0]);
  });
}

const ORACLE_TENTACLES: Array<Array<[number, number, number]>> = [
  [[-6.4, 37, 10], [-11.5, 31, 13], [-14.5, 22, 15], [-10.5, 11, 14], [-18.5, 0, 10]],
  [[-4.7, 37, 12], [-7.8, 30, 16], [-3.2, 21, 18], [-9.0, 10, 16], [-5.4, -4, 12]],
  [[-2.4, 36, 13], [0.2, 29, 18], [-5.0, 20, 19], [1.0, 9, 18], [-4.2, -6, 13]],
  [[-0.8, 36, 14], [2.2, 28, 19], [-1.8, 18, 20], [3.8, 8, 18], [0.2, -7, 13]],
  [[1.2, 36, 14], [5.2, 29, 18], [0.5, 20, 20], [6.6, 10, 17], [3.8, -4, 12]],
  [[3.2, 37, 13], [8.4, 31, 16], [4.2, 21, 19], [10.0, 12, 15], [8.2, 0, 11]],
  [[5.2, 37, 11], [11.0, 32, 14], [13.8, 24, 15], [9.0, 15, 14], [16.5, 4, 9]],
  [[7.1, 38, 9], [12.0, 34, 12], [17.2, 28, 11], [14.5, 20, 9], [21.0, 12, 6]],
];

function oracleStoneGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    // Stepped cliff throne and irregular buttresses bury every appendage end.
    add(new THREE.BoxGeometry(34, 7, 13), [0, 1.0, -4]);
    add(new THREE.BoxGeometry(28, 39, 10), [0, 23, -7]);
    for (let k = 0; k < 14; k++) {
      const side = k & 1 ? 1 : -1;
      const rank = Math.floor(k / 2);
      const h = 7 + (rank % 4) * 5 + (k % 3) * 2;
      add(new THREE.BoxGeometry(4.0 + (k % 2), h, 5.5), [side * (11 + rank * 2.15), h / 2, -2 - (rank % 2) * 2], [1, 1, 1], [0, side * 0.05, side * (k % 3 - 1) * 0.035]);
    }

    // Convex rear cap, facial mask and cheek masses have enough z thickness to
    // hold at side and orbit angles.
    add(new THREE.IcosahedronGeometry(1, 2), [0, 49, 0], [14.2, 13.8, 10.5]);
    add(new THREE.IcosahedronGeometry(1, 2), [0, 41.0, 7.0], [12.4, 10.0, 7.2]);
    add(new THREE.IcosahedronGeometry(1, 1), [-7.2, 40, 10.0], [5.4, 6.0, 4.2], [0, 0.08, -0.08]);
    add(new THREE.IcosahedronGeometry(1, 1), [7.2, 40, 10.0], [5.4, 6.0, 4.2], [0, -0.08, 0.08]);
    add(new THREE.OctahedronGeometry(3.5, 1), [0, 39.6, 14.0], [0.65, 1.25, 0.75]);
    add(new THREE.TorusGeometry(3.25, 1.05, 6, 12), [-5.1, 45.1, 15.45], [1.1, 0.75, 1], [0, 0, -0.10]);
    add(new THREE.TorusGeometry(3.25, 1.05, 6, 12), [5.1, 45.1, 15.45], [1.1, 0.75, 1], [0, 0, 0.10]);
    add(facetedTube([[-9.5, 46, 8], [-5.5, 48.5, 12.0], [0, 49.2, 13.5], [5.5, 48.5, 12], [9.5, 46, 8]], [2.2, 2.0, 2.2, 2.0, 2.2], 16, 8), [0, 0, 0]);

    // Crown band and broken vertical teeth.
    add(new THREE.CylinderGeometry(10.2, 10.6, 3.2, 11), [0, 62.5, -0.2]);
    const crown = [6.0, 8.5, 7.0, 10.0, 8.0, 6.5, 8.8];
    for (let k = 0; k < crown.length; k++) {
      const a = (k / crown.length - 0.5) * 1.8;
      add(new THREE.BoxGeometry(2.7, crown[k], 3.1), [Math.sin(a) * 9.2, 64 + crown[k] * 0.42, Math.cos(a) * 3.2 - 0.8], [1, 1, 0.86], [0.03 * (k & 1 ? 1 : -1), a * 0.12, (k - 3) * 0.025]);
    }

    // Eight different S-curves. Roots start inside the facial mask and tips
    // overlap the throne/base, satisfying the no-floating attachment contract.
    for (let k = 0; k < ORACLE_TENTACLES.length; k++) {
      const rootRadius = 2.7 - Math.abs(k - 3.5) * 0.08;
      add(facetedTube(ORACLE_TENTACLES[k], [rootRadius, 2.45, 2.05, 1.55, 0.65], 24, 9), [0, 0, 0]);
    }
    for (let k = 0; k < 12; k++) {
      const a = k / 12 * Math.PI * 2;
      add(new THREE.IcosahedronGeometry(1, 1), [Math.cos(a) * (11 + k % 3), 0.2 + k % 2, 3 + Math.sin(a) * 7], [2.2 + k % 2, 1.3 + (k % 3) * 0.3, 1.9]);
    }
  });
  paintFacets(geometry, 0x2f4159, 0x6b7c94, 191);
  return geometry;
}

function oracleVoidGeometry(): THREE.BufferGeometry {
  return mergedParts((add) => {
    add(new THREE.CircleGeometry(1, 12), [-5.1, 45.1, 15.4], [3.8, 2.25, 1], [0, 0, -0.10]);
    add(new THREE.CircleGeometry(1, 12), [5.1, 45.1, 15.4], [3.8, 2.25, 1], [0, 0, 0.10]);
    add(new THREE.BoxGeometry(0.65, 8.5, 0.45), [-1.05, 56.0, 10.0], [1, 1, 1], [0, 0, -0.22]);
    add(new THREE.BoxGeometry(0.55, 5.0, 0.45), [1.0, 54.0, 10.2], [1, 1, 1], [0, 0, 0.30]);
  });
}

function brokenArchGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    add(new THREE.BoxGeometry(2.2, 15, 2.6), [-6, 7.5, 0], [1, 1, 1], [0, 0, -0.03]);
    add(new THREE.BoxGeometry(2.2, 11, 2.6), [6, 5.5, 0], [1, 1, 1], [0, 0, 0.05]);
    add(new THREE.BoxGeometry(6.5, 2.1, 2.6), [-2.2, 14.5, 0], [1, 1, 1], [0, 0, 0.06]);
    add(new THREE.BoxGeometry(3.2, 2.1, 2.6), [4.3, 13.2, 0], [1, 1, 1], [0, 0, -0.13]);
  });
  paintFacets(geometry, 0x172238, 0x40516b, 233);
  return geometry;
}

/** One authored backing mass for the streamed oracle. It is deliberately a
 * cliff, not a statue pedestal: a broad centre shelf guarantees the model's
 * back penetrates stone, while staggered buttresses break the top/side outline
 * so it can merge into the environment's larger horseshoe wall. */
function oracleBackingCliffGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    add(new THREE.BoxGeometry(86, 92, 26), [0, 44, 0]);
    add(new THREE.BoxGeometry(62, 34, 34), [-12, 100, -2], [1, 1, 1], [0.02, 0.04, -0.04]);
    add(new THREE.BoxGeometry(44, 28, 30), [25, 116, -3], [1, 1, 1], [-0.03, -0.08, 0.08]);
    const strata = [
      [-58, 20, 18, 43, 28], [-49, 61, 24, 78, 24], [-61, 99, 16, 45, 22],
      [58, 19, 20, 41, 30], [50, 60, 25, 75, 24], [62, 101, 17, 48, 22],
      [-35, 129, 23, 30, 24], [2, 134, 29, 34, 26], [38, 132, 21, 27, 23],
    ] as const;
    for (let i = 0; i < strata.length; i++) {
      const [x, y, w, h, d] = strata[i];
      add(
        new THREE.BoxGeometry(w, h, d), [x, y, -2 - (i % 3) * 2],
        [1, 1, 1], [(i % 2 ? 1 : -1) * 0.035, (i - 4) * 0.018, (i % 3 - 1) * 0.055],
      );
    }
    // Angular foot rocks make the wall continue below the fog line rather
    // than ending at one horizontal shelf.
    for (let i = 0; i < 14; i++) {
      const x = -66 + i * 10.2;
      const h = 15 + (i * 13 % 19);
      add(new THREE.IcosahedronGeometry(1, 1), [x, h * 0.42 - 4, 7 + (i % 4) * 2], [7 + (i % 3) * 2, h * 0.72, 8 + (i % 2) * 3], [i * 0.07, i * 0.19, (i % 3 - 1) * 0.12]);
    }
  });
  paintFacets(geometry, 0x111a2b, 0x34465f, 419);
  return geometry;
}

/** Colossal freestanding basalt stack for the dragon. Overlapping low-sided
 * strata form one merged mesh: broadly cylindrical at a distance, eroded and
 * asymmetric up close, with a real expanded foot and a wide top perch. */
function dragonPerchColumnGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    const layers = [
      // y, height, bottom radius, top radius, x, z, sides, yaw
      [9, 22, 39, 35, 0, 0, 11, 0.08],
      [28, 21, 35, 32, -1.8, 1.2, 10, -0.11],
      [47, 22, 32, 29, 1.4, -1.1, 12, 0.17],
      [66, 21, 29, 27, -1.2, -0.4, 9, -0.06],
      [84, 20, 27, 25, 1.0, 1.4, 11, 0.13],
      [101, 19, 25, 23.5, -0.4, -0.8, 10, -0.15],
      [116, 14, 26.5, 25.5, 0.6, 0.2, 12, 0.05],
    ] as const;
    for (const [y, height, bottom, top, x, z, sides, yaw] of layers) {
      add(new THREE.CylinderGeometry(top, bottom, height, sides, 1, false), [x, y, z], [1, 1, 1], [0, yaw, 0]);
    }
    // Long asymmetric fracture ribs interrupt the stacked-cylinder silhouette.
    // They overlap deeply with the core, reading as one eroded basalt mass.
    for (let i = 0; i < 10; i++) {
      const a = i / 10 * Math.PI * 2 + (i % 3) * 0.17;
      const y = 17 + (i * 19 % 83);
      const radius = 27 + (i % 4) * 2.4;
      add(
        new THREE.IcosahedronGeometry(1, 1),
        [Math.cos(a) * radius, y, Math.sin(a) * radius],
        [6 + (i % 3) * 1.6, 11 + (i % 4) * 3.2, 5 + ((i + 1) % 3) * 1.5],
        [(i % 3 - 1) * 0.16, a, (i % 2 ? 1 : -1) * (0.12 + (i % 3) * 0.04)],
      );
    }
    // Broken stratum shelves catch raking light at three different heights.
    for (let shelf = 0; shelf < 3; shelf++) {
      const y = 36 + shelf * 31;
      for (let i = 0; i < 5; i++) {
        const a = i / 5 * Math.PI * 2 + shelf * 0.61;
        add(
          new THREE.IcosahedronGeometry(1, 1),
          [Math.cos(a) * (29 - shelf * 1.5), y + (i % 2), Math.sin(a) * (29 - shelf * 1.5)],
          [8 + (i % 2) * 2, 2.3 + (i % 3) * 0.6, 5.5 + ((i + shelf) % 2) * 2],
          [0.1 * i, a, (i % 2 ? 1 : -1) * 0.08],
        );
      }
    }
    // Broad foundation claws make the pillar visibly meet the abyss bedrock.
    for (let i = 0; i < 13; i++) {
      const a = i / 13 * Math.PI * 2;
      const radius = 33 + (i % 3) * 5;
      add(
        new THREE.IcosahedronGeometry(1, 1),
        [Math.cos(a) * radius, 4 + (i % 2) * 2, Math.sin(a) * radius],
        [12 + (i % 4) * 2, 8 + (i % 3) * 3, 9 + (i % 2) * 3],
        [i * 0.17, a, (i % 3 - 1) * 0.13],
      );
    }
    // Broken lip stones widen the usable top without turning it into a clean
    // manufactured disc. The centre remains flat enough for four foot anchors.
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * Math.PI * 2 + 0.14;
      add(
        new THREE.IcosahedronGeometry(1, 1),
        [Math.cos(a) * 23.5, 122 + (i % 3) * 0.8, Math.sin(a) * 23.5],
        [6 + (i % 2) * 2, 2.4 + (i % 3) * 0.5, 5 + ((i + 1) % 3)],
        [i * 0.11, a * 0.7, (i % 2 ? 1 : -1) * 0.08],
      );
    }
    // Four broad, irregular landing pads sit inside the crown. They are not a
    // clean platform, but guarantee visible rock under every admitted foot.
    const footPads = [[-18, -15], [18, -15], [-17, 15], [17, 15]] as const;
    for (let i = 0; i < footPads.length; i++) {
      const [x, z] = footPads[i];
      add(
        new THREE.IcosahedronGeometry(1, 1), [x, 123.0 + (i % 2) * 0.55, z],
        [8.8, 2.0 + (i % 3) * 0.35, 7.4], [0.06 * i, i * 0.47, (i % 2 ? 1 : -1) * 0.06],
      );
    }
  });
  paintFacets(geometry, 0x121d2e, 0x42536b, 463);
  return geometry;
}

/** Reusable one-draw arch bay. Local +Z follows the path tangent, so a row of
 * instances becomes a readable arcade rather than unrelated portal props. */
function abyssArcadeBayGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    add(new THREE.BoxGeometry(7.4, 0.55, 5.4), [0, 0.15, 0]);
    for (const side of [-1, 1]) {
      add(new THREE.BoxGeometry(1.25, 7.4, 1.55), [side * 3.0, 3.8, 0]);
      add(new THREE.BoxGeometry(2.05, 0.8, 2.25), [side * 3.0, 0.45, 0]);
      add(new THREE.BoxGeometry(1.65, 0.65, 1.95), [side * 3.0, 7.45, 0]);
    }
    // Nine chunky voussoirs form a real semicircular crown. Their tangential
    // cant and overlap remove the flat-lintel/box-gate read from a distance.
    for (let i = 0; i < 9; i++) {
      const a = i / 8 * Math.PI;
      const x = Math.cos(a) * 3.0;
      const y = 7.2 + Math.sin(a) * 3.0;
      add(new THREE.BoxGeometry(1.15, 1.55, 1.65), [x, y, 0], [1, 1, 1], [0, 0, a - Math.PI / 2]);
    }
    // Shallow side rubble ties each repeated bay into the bedrock while
    // preserving a wide clear visual centreline.
    for (const side of [-1, 1]) {
      add(new THREE.IcosahedronGeometry(1, 1), [side * 3.9, 0.6, 0.9], [1.4, 0.85, 1.7], [0.2, side * 0.4, side * 0.12]);
      add(new THREE.IcosahedronGeometry(1, 0), [side * 3.65, 0.45, -1.3], [1.0, 0.7, 1.25], [-0.1, side * 0.25, -side * 0.09]);
    }
  });
  paintFacets(geometry, 0x162236, 0x4a5b72, 487);
  return geometry;
}

/** Dragon-side narrative kit: the column is treated as an ancient treasure
 * barrow rather than a generic monster pedestal.  The vocabulary is the
 * western hoard-guardian tradition (burial mound, oath stones and captured
 * arms), kept deliberately separate from pearl/cloud/water dragon motifs. */
function dragonHoardGateGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    // A rough cairn facade overlaps the cylindrical column foot, so the gate
    // reads as an excavation in the rock rather than a freestanding prop.
    for (let i = 0; i < 13; i++) {
      const side = i & 1 ? 1 : -1;
      add(
        new THREE.IcosahedronGeometry(1, i % 3 ? 1 : 0),
        [side * (6.4 + (i % 4) * 2.3), 2.1 + (i % 5) * 2.1, 1.2 + (i % 3)],
        [3.6 + (i % 3), 2.5 + (i % 4), 3.2 + (i % 2)],
        [i * 0.13, side * i * 0.06, side * (i % 3 - 1) * 0.08],
      );
    }
    // Corbelled entrance stones and nine wedge-like crown blocks. The clear
    // black opening is supplied by a separate cavity mesh below.
    for (const side of [-1, 1]) {
      add(new THREE.BoxGeometry(3.1, 12.5, 4.2), [side * 6.15, 6.25, 0], [1, 1, 1], [0, 0, side * 0.04]);
      add(new THREE.BoxGeometry(4.2, 1.4, 5.0), [side * 6.15, 0.7, 0.15]);
    }
    for (let i = 0; i < 9; i++) {
      const a = i / 8 * Math.PI;
      add(
        new THREE.BoxGeometry(2.45, 3.0, 4.5),
        [Math.cos(a) * 6.05, 11.9 + Math.sin(a) * 5.8, 0],
        [1, 1, 1],
        [0, 0, a - Math.PI / 2],
      );
    }
    // Broken royal torque/threshold: readable treasure-language without a
    // costly glittering coin pile.
    add(new THREE.TorusGeometry(3.2, 0.42, 5, 13, Math.PI * 1.55), [0, 1.15, -2.35], [1, 0.62, 1], [Math.PI / 2, 0, -0.28]);
    add(new THREE.OctahedronGeometry(0.72, 0), [-3.1, 1.25, -2.35]);
    add(new THREE.OctahedronGeometry(0.72, 0), [3.1, 1.25, -2.35]);
  });
  paintFacets(geometry, 0x111a2b, 0x46566c, 503);
  return geometry;
}

function dragonHoardVoidGeometry(): THREE.BufferGeometry {
  return mergedParts((add) => {
    add(new THREE.BoxGeometry(8.8, 8.4, 0.5), [0, 5.0, 2.3]);
    add(new THREE.CircleGeometry(4.4, 12), [0, 9.2, 2.3], [1, 1, 1]);
  });
}

/** A single tribute/trophy marker. Seven GPU instances turn the arcade's last
 * approach into a procession without placing gameplay obstacles in the maze. */
function dragonOathStelaGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    add(new THREE.BoxGeometry(4.8, 1.0, 3.6), [0, 0.5, 0]);
    add(new THREE.BoxGeometry(3.45, 9.2, 1.45), [0, 5.2, 0], [1, 1, 1], [0.015, 0, -0.025]);
    add(new THREE.ConeGeometry(2.35, 3.5, 4), [0, 11.25, 0], [1, 1, 0.68], [0, Math.PI / 4, 0]);
    // Shield and inverted sword are sculptural silhouettes, not text decals.
    add(new THREE.CylinderGeometry(1.55, 1.55, 0.48, 9), [0, 6.0, -0.95], [1, 1.15, 1], [Math.PI / 2, 0, 0]);
    add(new THREE.BoxGeometry(0.36, 5.7, 0.55), [0, 5.8, -1.32]);
    add(new THREE.BoxGeometry(2.6, 0.34, 0.62), [0, 7.65, -1.32]);
    add(new THREE.ConeGeometry(0.55, 1.4, 4), [0, 2.25, -1.32], [1, 1, 0.72], [0, Math.PI / 4, Math.PI]);
  });
  paintFacets(geometry, 0x182338, 0x526176, 521);
  return geometry;
}

function dragonWardStoneGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    add(new THREE.BoxGeometry(2.8, 4.6, 1.4), [0, 2.3, 0], [1, 1, 1], [0.04, 0, -0.025]);
    add(new THREE.ConeGeometry(1.75, 2.5, 5), [0, 5.65, 0], [1, 1, 0.78]);
    add(new THREE.BoxGeometry(3.8, 0.65, 2.2), [0, 0.32, 0]);
  });
  paintFacets(geometry, 0x131e30, 0x3e5068, 541);
  return geometry;
}

/** Three thick strokes form a deliberately invented dragon-ward rune. It is
 * fantasy iconography rather than a claimed historical alphabet. */
function dragonWardRuneGeometry(): THREE.BufferGeometry {
  return mergedParts((add) => {
    add(new THREE.BoxGeometry(0.34, 3.15, 0.16), [0, 2.75, -0.79], [1, 1, 1], [0, 0, 0.48]);
    add(new THREE.BoxGeometry(0.34, 3.15, 0.16), [0, 2.75, -0.80], [1, 1, 1], [0, 0, -0.48]);
    add(new THREE.BoxGeometry(2.2, 0.32, 0.17), [0, 2.25, -0.82]);
  });
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  return geometry.index ? geometry.index.count / 3 : geometry.getAttribute("position").count / 3;
}

const TRIPO_ORACLE_RENDER = "/assets/abyss/oracle/oracle-render-30k.glb";
const TRIPO_ORACLE_DESTRUCTION_PROXY = "/assets/abyss/oracle/oracle-destruction-proxy-2500.glb";
const TRIPO_WARDEN_RENDER = "/assets/abyss/warden/warden-render-30k.glb";
const TRIPO_WARDEN_RANK_RENDER = "/assets/abyss/warden/warden-rank-render-8k.glb";
const TRIPO_WARDEN_DESTRUCTION_PROXY = "/assets/abyss/warden/warden-destruction-proxy-2500.glb";
const TRIPO_DRAGON_RENDER = "/assets/abyss/dragon/dragon-render-45k.glb";

// Neural landmark shells are Draco-compressed and streamed only after the
// first visible frame. Keeping one shared decoder avoids three independent
// WASM compilations while preserving the no-I/O startup path.
const tripoDracoLoader = new DRACOLoader();
const tripoGltfLoader = new GLTFLoader();
tripoGltfLoader.setDRACOLoader(tripoDracoLoader);
// Dragon is re-exported geometry-only and uncompressed. It bypasses the shared
// Draco worker queue so the three other neural landmarks cannot starve it or
// compile all hero assets in the same frame.
const dragonGltfLoader = new GLTFLoader();

function disposeLoadedGraph(group: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>();
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    for (const material of materials) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      material.dispose();
    }
  });
  for (const texture of textures) texture.dispose();
}

function paintDragonStone(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute("position");
  if (!position) return;
  const colors = new Float32Array(position.count * 3);
  const dark = new THREE.Color(0x18263a);
  const light = new THREE.Color(0x53677e);
  const value = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const raw = Math.sin(x * 5.71 + y * 2.93 + z * 4.17) * 43758.5453;
    const chip = raw - Math.floor(raw);
    const strata = Math.sin(y * 2.45 + Math.sin(x * 0.7) * 0.8) * 0.5 + 0.5;
    const shade = THREE.MathUtils.clamp(0.18 + chip * 0.28 + strata * 0.24, 0, 1);
    value.copy(dark).lerp(light, shade);
    colors[i * 3] = value.r;
    colors[i * 3 + 1] = value.g;
    colors[i * 3 + 2] = value.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

/** Stream the neural render shell only after the browser has produced its
 * first frame. The code-native oracle remains a zero-I/O fallback and is
 * swapped out with a short material fade; the closed QuadRemesher proxy stays
 * unloaded until destruction/physics asks for it. */
function streamTripoOracle(slot: THREE.Group, fallback: THREE.Group | null): () => void {
  let cancelled = false;
  let timeoutId = 0;
  let deferFrameId = 0;
  let loaded: THREE.Group | null = null;
  let frameId = 0;

  const start = () => {
    if (cancelled) return;
    tripoGltfLoader.load(TRIPO_ORACLE_RENDER, (gltf) => {
      loaded = gltf.scene;
      if (cancelled) {
        disposeLoadedGraph(loaded);
        loaded = null;
        return;
      }
      loaded.name = "tripo-v3.1-abyssal-oracle-render-shell";
      // Blender export is 10 units tall and faces +X. At 10.2×, the streamed
      // shell is a true environment-scale monument (102 local units before
      // the adaptive world fit), not a normal gameplay prop.
      loaded.scale.setScalar(10.2);
      loaded.rotation.y = -Math.PI / 2;
      loaded.userData.source = "tripo-v3.1-20260211";
      loaded.userData.renderTriangles = 30_000;
      loaded.userData.destructionProxyUrl = TRIPO_ORACLE_DESTRUCTION_PROXY;

      const faded: Array<{
        material: THREE.Material;
        opacity: number;
        transparent: boolean;
        depthWrite: boolean;
      }> = [];
      loaded.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.frustumCulled = true;
        const prepare = (source: THREE.Material) => {
          const material = source.clone();
          const stoneMaterial = material as THREE.MeshStandardMaterial;
          if (stoneMaterial.isMeshStandardMaterial) {
            // Tripo's baked stone is intentionally dark. The face is revealed
            // by the fixed cinematic spotlight, never by self-illumination.
            stoneMaterial.color.multiplyScalar(1.35);
            stoneMaterial.metalness = 0;
            stoneMaterial.roughness = Math.max(0.86, stoneMaterial.roughness);
            stoneMaterial.emissive.set(0x000000);
            stoneMaterial.emissiveIntensity = 0;
          }
          faded.push({
            material,
            opacity: material.opacity,
            transparent: material.transparent,
            depthWrite: material.depthWrite,
          });
          material.transparent = true;
          material.opacity = 0;
          material.depthWrite = false;
          return material;
        };
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map(prepare)
          : prepare(mesh.material);
      });
      slot.add(loaded);

      const fadeStart = performance.now();
      const fade = (now: number) => {
        if (cancelled || !loaded) return;
        const alpha = THREE.MathUtils.smoothstep((now - fadeStart) / 520, 0, 1);
        for (const entry of faded) entry.material.opacity = entry.opacity * alpha;
        if (alpha < 1) {
          frameId = requestAnimationFrame(fade);
          return;
        }
        if (fallback) {
          fallback.visible = false;
          slot.remove(fallback);
          fallback.traverse((object) => {
            const mesh = object as THREE.Mesh;
            mesh.geometry?.dispose();
          });
        }
        for (const entry of faded) {
          entry.material.opacity = entry.opacity;
          entry.material.transparent = entry.transparent;
          entry.material.depthWrite = entry.depthWrite;
          entry.material.needsUpdate = true;
        }
        slot.userData.streamState = "ready";
      };
      slot.userData.streamState = "fading";
      frameId = requestAnimationFrame(fade);
    }, undefined, (error) => {
      slot.userData.streamState = "fallback";
      console.warn("Deferred Tripo oracle load failed; retaining procedural fallback", error);
    });
  };

  slot.userData.streamState = "deferred";
  slot.userData.destructionProxyUrl = TRIPO_ORACLE_DESTRUCTION_PROXY;
  // requestIdleCallback may fire while the GPU is still compiling the first
  // scene. Two painted frames plus a short delay make the stream provably
  // post-first-visible instead of competing with startup for CPU/GPU time.
  deferFrameId = requestAnimationFrame(() => {
    deferFrameId = requestAnimationFrame(() => {
      timeoutId = window.setTimeout(start, 2200);
    });
  });

  return () => {
    cancelled = true;
    if (timeoutId) clearTimeout(timeoutId);
    if (deferFrameId) cancelAnimationFrame(deferFrameId);
    if (frameId) cancelAnimationFrame(frameId);
    if (loaded) disposeLoadedGraph(loaded);
    loaded = null;
  };
}

interface WardenStream {
  sync: () => void;
  dispose: () => void;
}

/** One neural mesh, two GPU instances. No procedural fallback is constructed:
 * a failed/late network request leaves the reserved exterior positions empty
 * rather than showing the rejected code-native mannequins. */
function streamTripoWardens(
  slot: THREE.Group,
  matrices: THREE.Matrix4[],
  options: { url: string; name: string; triangles: number; delay: number },
): WardenStream {
  let cancelled = false;
  let timeoutId = 0;
  let deferFrameId = 0;
  let frameId = 0;
  let instances: THREE.InstancedMesh | null = null;
  const ownedTextures = new Set<THREE.Texture>();

  const sync = () => {
    if (!instances) return;
    // Fill every allocated row before the mesh can enter a render list. This
    // is the invariant that prevents the prior WebGPU instance-range overrun.
    for (let i = 0; i < matrices.length; i++) instances.setMatrixAt(i, matrices[i]);
    instances.instanceMatrix.needsUpdate = true;
    instances.computeBoundingSphere();
  };

  const start = () => {
    if (cancelled) return;
    tripoGltfLoader.load(options.url, (gltf) => {
      if (cancelled) {
        disposeLoadedGraph(gltf.scene);
        return;
      }
      gltf.scene.updateMatrixWorld(true);
      let source: THREE.Mesh | null = null;
      gltf.scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!source && mesh.isMesh) source = mesh;
      });
      if (!source) {
        disposeLoadedGraph(gltf.scene);
        slot.userData.streamState = "failed";
        return;
      }
      const sourceMesh = source as THREE.Mesh;
      const geometry = sourceMesh.geometry.clone();
      geometry.applyMatrix4(sourceMesh.matrixWorld);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();

      const prepareMaterial = (original: THREE.Material) => {
        const material = original.clone();
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) ownedTextures.add(value);
        const stoneMaterial = material as THREE.MeshStandardMaterial;
        if (stoneMaterial.isMeshStandardMaterial) {
          // Cool the baked neutral-grey albedo into the same blue-black family
          // as the oracle while retaining the authored edge/value texture.
          stoneMaterial.color.multiply(new THREE.Color(0.76, 0.9, 1.08));
          stoneMaterial.metalness = 0;
          stoneMaterial.roughness = Math.max(0.88, stoneMaterial.roughness);
          stoneMaterial.emissive.set(0x0c1a2d);
          stoneMaterial.emissiveIntensity = 0.64;
        }
        material.transparent = true;
        material.opacity = 0;
        material.depthWrite = false;
        return material;
      };
      const materials = Array.isArray(sourceMesh.material)
        ? sourceMesh.material.map(prepareMaterial)
        : prepareMaterial(sourceMesh.material);
      instances = new THREE.InstancedMesh(geometry, materials, matrices.length);
      instances.name = options.name;
      instances.castShadow = false;
      instances.receiveShadow = false;
      instances.frustumCulled = true;
      instances.userData.source = "tripo-v3.1-20260211";
      instances.userData.renderTrianglesPerInstance = options.triangles;
      instances.userData.destructionProxyUrl = TRIPO_WARDEN_DESTRUCTION_PROXY;
      sync();
      slot.add(instances);

      // Source geometry/material wrappers are no longer needed. Texture data
      // remains owned by the cloned render material above.
      gltf.scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of sourceMaterials) material.dispose();
      });

      const fadeStart = performance.now();
      const fade = (now: number) => {
        if (cancelled || !instances) return;
        const alpha = THREE.MathUtils.smoothstep((now - fadeStart) / 520, 0, 1);
        const liveMaterials = Array.isArray(instances.material) ? instances.material : [instances.material];
        for (const material of liveMaterials) material.opacity = alpha;
        if (alpha < 1) {
          frameId = requestAnimationFrame(fade);
          return;
        }
        for (const material of liveMaterials) {
          material.opacity = 1;
          material.transparent = false;
          material.depthWrite = true;
          material.needsUpdate = true;
        }
        slot.userData.streamState = "ready";
      };
      slot.userData.streamState = "fading";
      frameId = requestAnimationFrame(fade);
    }, undefined, (error) => {
      slot.userData.streamState = "failed";
      console.warn("Deferred Tripo warden load failed; leaving rejected procedural guards absent", error);
    });
  };

  slot.userData.streamState = "deferred";
  slot.userData.destructionProxyUrl = TRIPO_WARDEN_DESTRUCTION_PROXY;
  deferFrameId = requestAnimationFrame(() => {
    deferFrameId = requestAnimationFrame(() => {
      timeoutId = window.setTimeout(start, options.delay);
    });
  });

  return {
    sync,
    dispose() {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (deferFrameId) cancelAnimationFrame(deferFrameId);
      if (frameId) cancelAnimationFrame(frameId);
      if (instances) {
        instances.removeFromParent();
        instances.geometry.dispose();
        const materials = Array.isArray(instances.material) ? instances.material : [instances.material];
        for (const material of materials) material.dispose();
      }
      for (const texture of ownedTextures) texture.dispose();
      instances = null;
    },
  };
}

/** Deferred one-shell dragon. We intentionally keep one stable 45k topology
 * instead of a distance LOD ladder: for a single hero silhouette the saved
 * triangles are not worth the wing/head pop the user already observed on
 * masonry. Draco keeps transfer to ~1.15 MB and the decoder is shared. */
function streamTripoDragon(slot: THREE.Group): () => void {
  let cancelled = false;
  let timeoutId = 0;
  let deferFrameId = 0;
  let frameId = 0;
  let loaded: THREE.Group | null = null;

  const start = () => {
    if (cancelled) return;
    dragonGltfLoader.load(TRIPO_DRAGON_RENDER, (gltf) => {
      if (cancelled) {
        disposeLoadedGraph(gltf.scene);
        return;
      }
      loaded = gltf.scene;
      loaded.name = "tripo-v3.1-colossal-perched-abyss-dragon";
      // Blender-normalized shell is ten units high. The art-direction target
      // is a truly colossal environment silhouette: three times the admitted
      // 8.2× baseline, with feet still anchored through the parent slot.
      loaded.scale.setScalar(24.6);
      // Local +X is the verified head/forward axis. Move the body toward the
      // maze while keeping the slot/column world placement unchanged.
      loaded.position.x = 64;
      loaded.userData.source = "tripo-v3.1-20260211";
      loaded.userData.renderTriangles = 45_000;
      loaded.userData.lodPolicy = "stable-hero-shell-no-pop";
      const dragonStone = makeHandPaintedLandmarkStoneMaterial();
      dragonStone.transparent = true;
      dragonStone.opacity = 0;
      dragonStone.depthWrite = false;
      const sourceTextures = new Set<THREE.Texture>();
      const sourceMaterials = new Set<THREE.Material>();
      loaded.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        const originals = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of originals) {
          sourceMaterials.add(material);
          for (const entry of Object.values(material)) if (entry instanceof THREE.Texture) sourceTextures.add(entry);
        }
        paintDragonStone(mesh.geometry);
        mesh.material = dragonStone;
      });
      for (const material of sourceMaterials) material.dispose();
      for (const texture of sourceTextures) texture.dispose();
      slot.add(loaded);
      const fadeStart = performance.now();
      const fade = (now: number) => {
        if (cancelled || !loaded) return;
        const alpha = THREE.MathUtils.smoothstep((now - fadeStart) / 620, 0, 1);
        dragonStone.opacity = alpha;
        if (alpha < 1) {
          frameId = requestAnimationFrame(fade);
          return;
        }
        dragonStone.opacity = 1;
        dragonStone.transparent = false;
        dragonStone.depthWrite = true;
        dragonStone.needsUpdate = true;
        slot.userData.streamState = "ready";
      };
      slot.userData.streamState = "fading";
      frameId = requestAnimationFrame(fade);
    }, undefined, (error) => {
      slot.userData.streamState = "failed";
      console.warn("Deferred Tripo dragon load failed", error);
    });
  };

  slot.userData.streamState = "deferred";
  slot.userData.renderUrl = TRIPO_DRAGON_RENDER;
  deferFrameId = requestAnimationFrame(() => {
    deferFrameId = requestAnimationFrame(() => {
      timeoutId = window.setTimeout(start, 7800);
    });
  });
  return () => {
    cancelled = true;
    if (timeoutId) clearTimeout(timeoutId);
    if (deferFrameId) cancelAnimationFrame(deferFrameId);
    if (frameId) cancelAnimationFrame(frameId);
    if (loaded) {
      loaded.removeFromParent();
      disposeLoadedGraph(loaded);
    }
    loaded = null;
  };
}

export function buildAbyssLandmarks(seed: number): THREE.Group {
  const root = new THREE.Group();
  root.name = "abyss-landmarks-img2three";
  const stone = new THREE.MeshLambertNodeMaterial({ vertexColors: true, flatShading: true, emissive: 0x09111f });
  const abyss = new THREE.MeshBasicNodeMaterial();
  abyss.colorNode = color(0x010308);
  const wardGlow = new THREE.MeshBasicNodeMaterial({ color: 0x6a8da8, transparent: true, opacity: 0.78 });

  const wardenSlot = new THREE.Group();
  wardenSlot.name = "streamed-oathbound-warden-slot";
  root.add(wardenSlot);
  const wardenMatrices = [new THREE.Matrix4(), new THREE.Matrix4()];
  const wardenRankMatrices = Array.from({ length: 6 }, () => new THREE.Matrix4());
  const wardenStream = streamTripoWardens(wardenSlot, wardenMatrices, {
    url: TRIPO_WARDEN_RENDER,
    name: "tripo-v3.1-colossal-oathbound-wardens",
    triangles: 29_999,
    delay: 4200,
  });
  const wardenRankStream = streamTripoWardens(wardenSlot, wardenRankMatrices, {
    url: TRIPO_WARDEN_RANK_RENDER,
    name: "tripo-v3.1-oathbound-warden-rank",
    triangles: 8_000,
    delay: 6000,
  });

  const skullStoneGeo = dragonSkullStoneGeometry();
  const skullTeethGeo = dragonSkullTeethGeometry();
  const skullVoidGeo = dragonSkullVoidGeometry();
  const skull = new THREE.Group();
  skull.name = "buried-dragon-skull";
  const skullMesh = new THREE.Mesh(skullStoneGeo, stone);
  const skullTeeth = new THREE.Mesh(skullTeethGeo, stone);
  const skullVoid = new THREE.Mesh(skullVoidGeo, abyss);
  skullMesh.castShadow = false;
  skullTeeth.castShadow = false;
  skullVoid.renderOrder = 1;
  skull.add(skullMesh, skullTeeth, skullVoid);
  root.add(skull);

  const oracle = new THREE.Group();
  oracle.name = "abyssal-cephalopod-oracle";
  const oracleWallGeo = oracleBackingCliffGeometry();
  const oracleWall = new THREE.Mesh(oracleWallGeo, stone);
  oracleWall.name = "oracle-backing-horseshoe-cliff";
  oracleWall.castShadow = false;
  oracleWall.receiveShadow = false;
  root.add(oracleWall, oracle);
  const cancelOracleStream = streamTripoOracle(oracle, null);

  const dragonPerchGeo = dragonPerchColumnGeometry();
  const dragonPerch = new THREE.Mesh(dragonPerchGeo, stone);
  dragonPerch.name = "colossal-dragon-perch-column";
  dragonPerch.castShadow = false;
  dragonPerch.receiveShadow = false;
  root.add(dragonPerch);
  const dragonSlot = new THREE.Group();
  dragonSlot.name = "streamed-colossal-perched-dragon-slot";
  root.add(dragonSlot);
  const cancelDragonStream = streamTripoDragon(dragonSlot);

  const hoardGateGeo = dragonHoardGateGeometry();
  const hoardGateVoidGeo = dragonHoardVoidGeometry();
  const hoardGate = new THREE.Mesh(hoardGateGeo, stone);
  const hoardGateVoid = new THREE.Mesh(hoardGateVoidGeo, abyss);
  hoardGate.name = "dragon-hoard-barrow-gate";
  hoardGateVoid.name = "dragon-hoard-barrow-cavity";
  hoardGate.castShadow = false;
  hoardGateVoid.renderOrder = 1;
  root.add(hoardGate, hoardGateVoid);

  const oathStelaGeo = dragonOathStelaGeometry();
  const oathStelae = new THREE.InstancedMesh(oathStelaGeo, stone, 7);
  oathStelae.name = "dragon-hoard-oath-stelae";
  oathStelae.castShadow = false;
  oathStelae.receiveShadow = false;
  root.add(oathStelae);

  const wardStoneGeo = dragonWardStoneGeometry();
  const wardRuneGeo = dragonWardRuneGeometry();
  const wardStones = new THREE.InstancedMesh(wardStoneGeo, stone, 8);
  const wardRunes = new THREE.InstancedMesh(wardRuneGeo, wardGlow, 8);
  wardStones.name = "dragon-hoard-ward-stones";
  wardRunes.name = "dragon-hoard-ward-runes";
  wardStones.castShadow = false;
  wardRunes.castShadow = false;
  root.add(wardStones, wardRunes);

  const arcadeGeo = abyssArcadeBayGeometry();
  const arcade = new THREE.InstancedMesh(arcadeGeo, stone, 17);
  arcade.name = "oracle-to-dragon-bedrock-arcade";
  arcade.castShadow = false;
  arcade.receiveShadow = false;
  root.add(arcade);

  const matrix = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();

  // Sparse exterior ruins remain instanced and are never navigation/collision.
  const archGeo = brokenArchGeometry();
  const arches = new THREE.InstancedMesh(archGeo, stone, 7);
  for (let k = 0; k < arches.count; k++) {
    const side = k & 1 ? 1 : -1;
    const x = side * (42 + hash2(seed, k, 320) * 44);
    const z = -4 - hash2(seed, k, 321) * 100;
    const y = ABYSS * TH - 14 + hash2(seed, k, 322) * 13;
    const sc = 0.6 + hash2(seed, k, 323) * 0.75;
    arches.setMatrixAt(k, matrix.compose(
      p.set(x, y, z),
      q.setFromEuler(new THREE.Euler(0, hash2(seed, k, 324) * Math.PI, (hash2(seed, k, 325) - 0.5) * 0.18)),
      s.set(sc, sc, sc),
    ));
  }
  arches.castShadow = false;
  arches.receiveShadow = false;
  arches.name = "distant-broken-arches";
  root.add(arches);

  // IcosahedronGeometry detail 0 is already non-indexed in this Three build.
  const cragGeo = new THREE.IcosahedronGeometry(1, 0);
  paintFacets(cragGeo, 0x172238, 0x40516b, 271);
  // Only the eight grounded burial rocks remain. The former 26 randomly
  // suspended chunks read as generator debris and had no structural support.
  const crags = new THREE.InstancedMesh(cragGeo, stone, 8);
  crags.castShadow = false;
  crags.name = "floating-abyss-rubble";
  root.add(crags);

  const chainPoints: number[] = [];
  for (let k = 0; k < 10; k++) {
    const x = (hash2(seed, k, 340) - 0.5) * 180;
    const z = -15 - hash2(seed, k, 341) * 105;
    const top = 22 + hash2(seed, k, 342) * 28;
    const bottom = ABYSS * TH - 14 + hash2(seed, k, 343) * 10;
    for (let n = 0; n < 8; n++) {
      const y0 = top + (bottom - top) * (n / 8);
      const y1 = top + (bottom - top) * ((n + 0.62) / 8);
      chainPoints.push(x + Math.sin(n * 0.8 + k) * 0.65, y0, z, x + Math.sin((n + 0.62) * 0.8 + k) * 0.65, y1, z);
    }
  }
  const chainGeo = new THREE.BufferGeometry();
  chainGeo.setAttribute("position", new THREE.Float32BufferAttribute(chainPoints, 3));
  const chainMat = new THREE.LineBasicNodeMaterial({ color: 0x1b2638, transparent: true, opacity: 0.72 });
  const chains = new THREE.LineSegments(chainGeo, chainMat);
  chains.name = "distant-hanging-chains";
  root.add(chains);

  const fit = (half: number, top: number) => {
    // Blender-normalized neural source is 10 units tall. The 8.8–12.2 scale
    // makes each guardian a 88–122 unit monument while preserving one shared
    // draw call for both sides.
    const guardianScale = Math.max(8.8, Math.min(12.2, 8.2 + top / 28));
    const guardianX = half + 34 + guardianScale * 2.4;
    const guardianZ = -Math.min(48, half * 0.22);
    wardenMatrices[0].compose(
      p.set(-guardianX, ABYSS * TH - 11, guardianZ),
      q.setFromEuler(new THREE.Euler(0, -0.12, 0)),
      s.setScalar(guardianScale),
    );
    wardenMatrices[1].compose(
      p.set(guardianX, ABYSS * TH - 11, guardianZ),
      q.setFromEuler(new THREE.Euler(0, Math.PI + 0.12, 0)),
      s.setScalar(guardianScale),
    );
    wardenStream.sync();
    // Six lower-LOD wardens form two ceremonial ranks along the closed arc.
    // The central gap belongs to the oracle, and every base is embedded in the
    // procedural wall outside the complete maze bounding radius.
    const rankAngles = [-2.76, -2.42, -2.08, -1.06, -0.72, -0.38];
    for (let i = 0; i < wardenRankMatrices.length; i++) {
      const sideDepth = i % 3;
      const radius = half + 54 + sideDepth * 7;
      const angle = rankAngles[i];
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const rankScale = Math.max(5.8, Math.min(7.4, guardianScale * (0.59 + sideDepth * 0.025)));
      wardenRankMatrices[i].compose(
        p.set(x, ABYSS * TH - 11 - rankScale * 0.34, z),
        q.setFromEuler(new THREE.Euler(0, Math.atan2(z, -x), 0)),
        s.setScalar(rankScale),
      );
    }
    wardenRankStream.sync();

    const skullScale = Math.max(1.2, Math.min(2.2, 1.08 + top / 145));
    const burialY = ABYSS * TH - 12;
    skull.scale.setScalar(skullScale);
    skull.position.set(-half * 0.32, burialY - skullScale * 4.4, -(half + 52));
    skull.rotation.set(-0.28, 0.22, -0.54);

    // Dedicated burial rubble wraps the lower jaw/rear cranium after each fit.
    for (let k = 0; k < crags.count; k++) {
      const qk = k + 20;
      const u = k / 7;
      const a = -0.35 + u * Math.PI * 1.3;
      const radius = skullScale * (9 + hash2(seed, qk, 350) * 8);
      const sc = skullScale * (1.5 + hash2(seed, qk, 351) * 2.1);
      crags.setMatrixAt(k, matrix.compose(
        p.set(skull.position.x + Math.cos(a) * radius, burialY - sc * 0.45 + hash2(seed, qk, 352), skull.position.z + Math.sin(a) * radius),
        q.setFromEuler(new THREE.Euler(hash2(seed, qk, 353) * 2, hash2(seed, qk, 354) * 3, hash2(seed, qk, 355) * 2)),
        s.set(sc * 1.35, sc * 0.7, sc),
      ));
    }

    // The gigantic oracle occupies the highest, closed side of the horseshoe
    // wall (-Z). Local +Z faces the maze; the separate cliff overlaps its back
    // and swallows the lower body/tentacle roots so it never reads as a prop
    // floating in the abyss.
    const oracleScale = Math.max(1.85, Math.min(2.75, 1.55 + top / 105));
    oracle.scale.setScalar(oracleScale);
    oracle.position.set(half * 0.08, burialY - oracleScale * 2.4, -(half + 86));
    // Local +Z is the face direction for both fallback and streamed shell.
    oracle.rotation.y = Math.atan2(-oracle.position.x, -oracle.position.z);
    oracleWall.scale.set(oracleScale * 1.05, oracleScale, oracleScale);
    oracleWall.position.set(
      oracle.position.x,
      burialY - oracleScale * 8,
      oracle.position.z - oracleScale * 30,
    );
    oracleWall.rotation.y = oracle.rotation.y;

    // Landmark light rig: a cold, oblique face key comes from the maze side
    // and grazes across the oracle's brow/tentacle roots. The offset prevents
    // the backing cliff from flattening into the same value as the face.
    const oracleForward = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), oracle.rotation.y);
    const oracleRight = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), oracle.rotation.y);
    const oracleFace = oracle.position.clone()
      .addScaledVector(oracleForward, oracleScale * 12)
      .add(new THREE.Vector3(0, oracleScale * 58, 0));
    const oracleLight = oracleFace.clone()
      .addScaledVector(oracleForward, oracleScale * 36)
      .addScaledVector(oracleRight, -oracleScale * 24)
      .add(new THREE.Vector3(0, oracleScale * 10, 0));

    // Counter-landmark at the open (+Z) side: a freestanding cylindrical
    // basalt stack rooted at the same bedrock plane as the environment. Its
    // top rises above the maze and exposes four stable dragon-foot anchors.
    const perchBaseY = ABYSS * TH - 12;
    // Lower the standing plane by 20% while preserving X/Z placement. The
    // dragon slot follows perchTopY, so shortening cannot leave it floating.
    const mazeClearance = Math.max(70, Math.min(124, top * 0.24));
    const unloweredPerchHeight = Math.max(118, top + mazeClearance - perchBaseY);
    const perchHeight = Math.max(94, unloweredPerchHeight * 0.8);
    const perchScaleY = perchHeight / 124;
    const perchNarrativeScale = Math.max(0.9, Math.min(1.32, 0.82 + half / 260));
    // The three-times hero dragon needs a real four-foot platform, not the
    // former needle pedestal. Widen only the geology; gates/stelae retain a
    // human-readable narrative scale below.
    const perchScaleXZ = perchNarrativeScale * 3.15;
    dragonPerch.scale.set(perchScaleXZ, perchScaleY, perchScaleXZ);
    // Fit against the COMPLETE maze bound. The widened geological foot reaches
    // about 58 local units, so center distance includes its scaled radius plus
    // an 18-unit safety moat. No seed can push the column back into a block.
    const perchFootRadius = 58 * perchScaleXZ;
    dragonPerch.position.set(-half * 0.14, perchBaseY, half + perchFootRadius + 18);
    dragonPerch.rotation.y = -0.08;
    const perchTopY = perchBaseY + 124 * perchScaleY;
    dragonSlot.position.set(dragonPerch.position.x, perchTopY + 0.8, dragonPerch.position.z);
    // Multi-view verification shows Tripo's dragon faces local +X (the Blender
    // +X review is its true frontal view). Rotate that axis toward the live
    // oracle: from the +Z perch this resolves to approximately +90 degrees.
    const dragonToOracleX = oracle.position.x - dragonPerch.position.x;
    const dragonToOracleZ = oracle.position.z - dragonPerch.position.z;
    dragonSlot.rotation.y = Math.atan2(-dragonToOracleZ, dragonToOracleX);
    dragonSlot.scale.setScalar(Math.max(0.88, Math.min(1.12, 0.82 + half / 240)));
    dragonSlot.userData.faceTarget = oracle.position.toArray();
    dragonSlot.userData.faceAxis = "local-positive-x";
    dragonPerch.userData.perch = {
      mazeTopY: top,
      adaptiveClearance: mazeClearance,
      unloweredHeight: unloweredPerchHeight,
      finalHeight: perchHeight,
      topY: perchTopY,
      radius: 23 * perchScaleXZ,
      facingYaw: Math.PI,
      headTarget: [0, top * 0.55, half * 0.45],
      footAnchors: [
        [-18 * perchScaleXZ, perchTopY, -15 * perchScaleXZ],
        [18 * perchScaleXZ, perchTopY, -15 * perchScaleXZ],
        [-17 * perchScaleXZ, perchTopY, 15 * perchScaleXZ],
        [17 * perchScaleXZ, perchTopY, 15 * perchScaleXZ],
      ],
    };

    // The dragon-side cultural grammar is an ancient hoard barrow. Its gate
    // faces the maze while a curved sequence of oath/trophy stones receives
    // the exterior arcade. Everything remains outside nav and collision.
    const dragonX = dragonPerch.position.x;
    const dragonZ = dragonPerch.position.z;
    const gateScale = 1.28 * perchNarrativeScale;
    hoardGate.scale.set(gateScale, gateScale, gateScale);
    hoardGateVoid.scale.copy(hoardGate.scale);
    hoardGate.position.set(dragonX, perchBaseY + 0.45, dragonZ - 33 * perchScaleXZ);
    hoardGateVoid.position.copy(hoardGate.position);
    hoardGate.rotation.y = -0.08;
    hoardGateVoid.rotation.y = hoardGate.rotation.y;

    // The dragon is rock, not a lamp. A dim amber source hidden above the
    // hoard gate supplies believable low bounce while moonlight owns the rim.
    const hoardBounce = new THREE.Vector3(
      dragonX,
      perchTopY + Math.max(18, perchNarrativeScale * 24),
      dragonZ - 27 * perchScaleXZ,
    );

    root.userData.cinematicLights = [
      {
        kind: "spot",
        x: oracleLight.x,
        y: oracleLight.y,
        z: oracleLight.z,
        targetX: oracleFace.x,
        targetY: oracleFace.y,
        targetZ: oracleFace.z,
        color: 0x78a6ca,
        base: 7200,
        dist: Math.max(220, oracleScale * 132),
        ph: 0,
        angle: Math.PI / 7.5,
        penumbra: 0.78,
      },
      {
        kind: "point",
        x: hoardBounce.x,
        y: hoardBounce.y,
        z: hoardBounce.z,
        color: 0xa86545,
        base: 1850,
        dist: Math.max(160, perchNarrativeScale * 185),
        ph: 0,
      },
    ];

    for (let i = 0; i < oathStelae.count; i++) {
      const u = i / (oathStelae.count - 1);
      const angle = THREE.MathUtils.lerp(-Math.PI / 2, 0.08, u);
      const radius = (41 + Math.sin(u * Math.PI) * 4.5) * perchScaleXZ;
      const stelaScale = (0.92 + hash2(seed, i, 551) * 0.17) * perchNarrativeScale;
      oathStelae.setMatrixAt(i, matrix.compose(
        p.set(dragonX + Math.cos(angle) * radius, perchBaseY + 0.5, dragonZ + Math.sin(angle) * radius),
        q.setFromEuler(new THREE.Euler(0, -angle - Math.PI / 2 + (hash2(seed, i, 552) - 0.5) * 0.08, (hash2(seed, i, 553) - 0.5) * 0.035)),
        s.set(stelaScale, stelaScale * (0.96 + hash2(seed, i, 554) * 0.12), stelaScale),
      ));
    }
    oathStelae.instanceMatrix.needsUpdate = true;
    oathStelae.computeBoundingSphere();

    for (let i = 0; i < wardStones.count; i++) {
      const angle = i / wardStones.count * Math.PI * 2 + 0.16;
      const radius = 24.5 * perchScaleXZ;
      const runeScale = 0.92 * perchNarrativeScale;
      const wardMatrix = matrix.compose(
        p.set(dragonX + Math.cos(angle) * radius, perchTopY - 2.3, dragonZ + Math.sin(angle) * radius),
        q.setFromEuler(new THREE.Euler(0, -angle - Math.PI / 2, 0)),
        s.set(runeScale, runeScale * (0.92 + hash2(seed, i, 556) * 0.1), runeScale),
      );
      wardStones.setMatrixAt(i, wardMatrix);
      wardRunes.setMatrixAt(i, wardMatrix);
    }
    wardStones.instanceMatrix.needsUpdate = true;
    wardRunes.instanceMatrix.needsUpdate = true;
    wardStones.computeBoundingSphere();
    wardRunes.computeBoundingSphere();

    // A half-ellipse links the asymmetric endpoints exactly: the oracle stays
    // close to the closed wall while the greatly widened dragon column moves
    // farther out. The +X bow remains beyond the complete maze bound.
    const arcadeCenterZ = (oracle.position.z + dragonPerch.position.z) * 0.5;
    const arcadeRadiusZ = (dragonPerch.position.z - oracle.position.z) * 0.5;
    const arcadeRadiusX = Math.max(half + 76, arcadeRadiusZ * 0.72);
    for (let i = 0; i < arcade.count; i++) {
      const u = i / (arcade.count - 1);
      const angle = -Math.PI / 2 + u * Math.PI;
      const bow = Math.sin(u * Math.PI) * 9 + (hash2(seed, i, 491) - 0.5) * 3;
      const x = Math.cos(angle) * (arcadeRadiusX + bow);
      const z = arcadeCenterZ + Math.sin(angle) * arcadeRadiusZ;
      const tangentX = -Math.sin(angle) * arcadeRadiusX;
      const tangentZ = Math.cos(angle) * arcadeRadiusZ;
      const bayScale = 1.02 + Math.sin(u * Math.PI) * 0.18 + hash2(seed, i, 492) * 0.06;
      arcade.setMatrixAt(i, matrix.compose(
        p.set(x, perchBaseY + 0.6 + hash2(seed, i, 493) * 0.7, z),
        q.setFromEuler(new THREE.Euler(0, Math.atan2(tangentX, tangentZ), (hash2(seed, i, 494) - 0.5) * 0.025)),
        s.set(bayScale, bayScale * (0.96 + hash2(seed, i, 495) * 0.08), bayScale),
      ));
    }
    arcade.instanceMatrix.needsUpdate = true;
    arcade.computeBoundingSphere();

    crags.instanceMatrix.needsUpdate = true;
    crags.computeBoundingSphere();
  };
  (root.userData as { fit?: (half: number, top: number) => void }).fit = fit;
  (root.userData as { dispose?: () => void }).dispose = () => {
    cancelOracleStream();
    cancelDragonStream();
    wardenStream.dispose();
    wardenRankStream.dispose();
  };
  root.userData.modelStats = {
    guardianTrianglesPerInstance: 29_999,
    guardianStreamedBytes: 1_235_916,
    guardianDestructionProxyTriangles: 2_500,
    guardianDestructionProxyBytes: 45_356,
    guardianHeroInstances: 2,
    guardianRankTrianglesPerInstance: 8_000,
    guardianRankInstances: 6,
    guardianRankStreamedBytes: 369_540,
    dragonSkullTriangles: triangleCount(skullStoneGeo) + triangleCount(skullTeethGeo) + triangleCount(skullVoidGeo),
    oracleTriangles: 0,
    oracleStreamedTriangles: 30_000,
    oracleDestructionProxyTriangles: 2_500,
    oracleStreamedBytes: 1_138_856,
    oracleDestructionProxyBytes: 45_356,
    oracleBackingCliffTriangles: triangleCount(oracleWallGeo),
    dragonPerchColumnTriangles: triangleCount(dragonPerchGeo),
    dragonStreamedTriangles: 45_000,
    dragonStreamedBytes: 1_153_400,
    dragonLodPolicy: "stable-hero-shell-no-pop",
    dragonHoardGateTriangles: triangleCount(hoardGateGeo) + triangleCount(hoardGateVoidGeo),
    dragonOathStelaTrianglesPerInstance: triangleCount(oathStelaGeo),
    dragonOathStelaInstances: oathStelae.count,
    dragonWardTrianglesPerInstance: triangleCount(wardStoneGeo) + triangleCount(wardRuneGeo),
    dragonWardInstances: wardStones.count,
    arcadeTrianglesPerBay: triangleCount(arcadeGeo),
    arcadeInstances: arcade.count,
    drawObjects: 18,
    navigation: false,
    collision: false,
  };
  fit(42, 42);
  return root;
}
