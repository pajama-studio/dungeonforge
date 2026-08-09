// The far horizon: real rock instead of the box canyon.
//
// What stood here was 31 mesas, each a cluster of jittered BoxGeometry, merged
// and vertex-tinted. It held up in silhouette and fell apart the moment a camera
// came near, which is what got it cut. This puts generated stone back in the
// same arc.
//
// The arc itself is worth keeping from the old version, because it was doing
// real work: a horseshoe centred on -Z, tallest across the narrative back, its
// density and height falling off toward both ends, and open toward +Z where the
// default camera approaches and the dragon perch needs a sightline. A closed
// ring reads as an arena; this reads as a canyon that happens to be enclosed.
//
// Cost is five draw calls — one InstancedMesh per model — for the whole horizon.
// Every piece is 8k triangles with a 512 albedo, because at 60-140 units behind
// a mist curtain that is already more than the distance can resolve.

import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

import { hash2 } from "../gen/rng";
import { ABYSS } from "../gen/dungeon";
import { TH } from "../config";

/** Where the arc sits and how it opens. Shared with the old mesa ring so the
 *  enclosure keeps the shape the lighting and camera work were tuned against. */
const ARC_CENTER = -Math.PI / 2;
const ARC_SPAN = Math.PI * 1.34; // 241 degrees: enclosure with one clear vista

/** blender-optimize-tripo.py normalises everything it emits to this height. */
export const ASSET_HEIGHT = 10;

export interface HorizonPieceSpec {
  /** File under /assets/abyss/horizon. */
  name: string;
  /** How many of it stand in the ring. */
  count: number;
  /** World height range. Assets are normalised to 10 by the optimiser, so this
   *  is what actually decides their scale. */
  height: [number, number];
  /** Distance from the fortress centre. */
  radius: [number, number];
  /** Salt, so two pieces with the same count do not land on the same angles. */
  salt: number;
}

export const HORIZON_PIECES: readonly HorizonPieceSpec[] = [
  // Broad terraced cliffs carry the near wall and most of the enclosure.
  { name: "horizon-cliff-terrace", count: 10, height: [46, 104], radius: [62, 92], salt: 11 },
  // Gaunt spires break the skyline where the cliffs would otherwise flatten.
  { name: "horizon-spire-needle", count: 8, height: [38, 96], radius: [56, 86], salt: 23 },
  // Ruins sit further out and read as another city that did not survive either.
  { name: "horizon-tower-ruin", count: 5, height: [30, 62], radius: [104, 148], salt: 37 },
  { name: "horizon-ziggurat-ruin", count: 4, height: [26, 50], radius: [98, 140], salt: 53 },
  { name: "horizon-arch-buttress", count: 4, height: [24, 46], radius: [88, 132], salt: 71 },
];

/** Angle for the k-th of n pieces along the horseshoe, jittered per salt. */
export function arcAngle(seed: number, k: number, count: number, salt: number): number {
  const u = count <= 1 ? 0.5 : k / (count - 1);
  return ARC_CENTER - ARC_SPAN / 2 + ARC_SPAN * u + (hash2(seed, k, salt) - 0.5) * 0.22;
}

/** Height envelope: 1 across the back, falling to 0 at both open ends.
 *
 *  The exponent matters. A plain sine leaves the ends too tall and the canyon
 *  ends like a cut cylinder; below 1 it decays faster than it rises, so the wall
 *  thins out before it stops. */
export function arcEnvelope(k: number, count: number): number {
  const u = count <= 1 ? 0.5 : k / (count - 1);
  return Math.pow(Math.sin(u * Math.PI), 0.62);
}

export interface HorizonPlacement {
  x: number;
  y: number;
  z: number;
  scale: number;
  yaw: number;
  tilt: number;
}

/** Deterministic layout for one piece. Pure, so it can be tested without a GPU
 *  and without loading a single byte of geometry. */
export function placeHorizonPiece(
  seed: number,
  spec: HorizonPieceSpec,
  k: number,
  baseY: number,
): HorizonPlacement {
  const envelope = arcEnvelope(k, spec.count);
  const angle = arcAngle(seed, k, spec.count, spec.salt);
  const radius = spec.radius[0] + hash2(seed, k, spec.salt + 1) * (spec.radius[1] - spec.radius[0]);
  const [lo, hi] = spec.height;
  // Envelope drives height, so the wall is tallest across the closed back.
  const height = lo + (hi - lo) * (envelope * 0.75 + hash2(seed, k, spec.salt + 2) * 0.25);
  return {
    x: Math.cos(angle) * radius,
    // Sunk slightly, so nothing reads as resting on an invisible shelf.
    y: baseY - height * 0.06,
    z: Math.sin(angle) * radius,
    scale: height / ASSET_HEIGHT,
    // Face roughly inward, then wander — a ring of pieces all square to the
    // centre reads as a fence.
    yaw: angle + Math.PI / 2 + (hash2(seed, k, spec.salt + 3) - 0.5) * 1.5,
    tilt: (hash2(seed, k, spec.salt + 4) - 0.5) * 0.09,
  };
}

export interface HorizonRing {
  group: THREE.Group;
  /** Resolves once every piece has streamed in; never rejects. */
  ready: Promise<void>;
  dispose(): void;
}

/** Build the ring and start streaming it.
 *
 *  Deferred rather than blocking: the horizon is the last thing a player looks
 *  at and the first thing that would delay a first frame. Until it arrives the
 *  mist curtain carries the enclosure on its own, which is what it did between
 *  the box canyon being cut and this landing.
 */
export function buildHorizonRing(seed: number): HorizonRing {
  const group = new THREE.Group();
  group.name = "horizon-ring";

  const draco = new DRACOLoader();
  draco.setDecoderPath("/draco/gltf/");
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);

  const baseY = ABYSS * TH - 12;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();
  const meshes: THREE.InstancedMesh[] = [];
  let disposed = false;

  const one = (spec: HorizonPieceSpec) => new Promise<void>((resolve) => {
    loader.load(`/assets/abyss/horizon/${spec.name}.glb`, (gltf) => {
      if (disposed) { resolve(); return; }
      let source: THREE.Mesh | null = null;
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!source && mesh.isMesh) source = mesh;
      });
      if (!source) { resolve(); return; }
      const sourceMesh = source as THREE.Mesh;
      const geometry = sourceMesh.geometry.clone();
      geometry.applyMatrix4(sourceMesh.matrixWorld);
      // Sit the piece on its own base rather than its centre, so `y` means the
      // ground line and a taller piece grows upward instead of sinking.
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
      geometry.computeBoundingSphere();

      const material = Array.isArray(sourceMesh.material) ? sourceMesh.material[0] : sourceMesh.material;
      const mesh = new THREE.InstancedMesh(geometry, material, spec.count);
      mesh.name = `horizon-${spec.name}`;
      // Nothing this far out should cost a shadow pass; the sun never resolves
      // it and the map budget is spent on the fortress.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      for (let k = 0; k < spec.count; k++) {
        const p = placeHorizonPiece(seed, spec, k, baseY);
        mesh.setMatrixAt(k, matrix.compose(
          position.set(p.x, p.y, p.z),
          quaternion.setFromEuler(euler.set(p.tilt, p.yaw, p.tilt * 0.6)),
          scale.setScalar(p.scale),
        ));
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      meshes.push(mesh);
      group.add(mesh);
      resolve();
    }, undefined, (error) => {
      // One missing piece must not take the horizon with it.
      console.warn(`[horizon] ${spec.name} failed to stream`, error);
      resolve();
    });
  });

  const ready = Promise.all(HORIZON_PIECES.map(one)).then(() => undefined);

  return {
    group,
    ready,
    dispose() {
      disposed = true;
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) material.dispose();
      }
      meshes.length = 0;
      group.clear();
      draco.dispose();
    },
  };
}
