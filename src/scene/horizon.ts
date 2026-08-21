// The far horizon: real rock instead of the box canyon.
//
// What stood here was 31 mesas, each a cluster of jittered BoxGeometry, merged
// and vertex-tinted. It held up in silhouette and fell apart the moment a camera
// came near, which is what got it cut. This puts generated stone back in the
// same arc.
//
// The old arc idea was doing useful enclosure work, but even a sparse, evenly
// sampled horseshoe still reads from high orbit as a redundant rim around the
// level. The replacement is three detached back-country clusters centred on
// -Z and fully open toward +Z where the default camera approaches. Large gaps
// between them keep the cavern feeling vast and stop the skyline competing
// with the titan skull/oracle landmarks.
//
// Cost is five draw calls — one InstancedMesh per model — for the whole horizon.
// Every piece is 8k triangles with a 512 albedo, because at 150-260 units behind
// a mist curtain that is already more than the distance can resolve.

import { assetUrl } from "../assets";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { hash2 } from "../gen/rng";
import { ABYSS } from "../gen/dungeon";
import { TH } from "../config";
import { createGltfDracoLoader } from "./gltf-draco";

/** Three detached masses across the narrative back. Do not turn this back into
 *  evenly sampled arc endpoints: those endpoints are what looked like a rock
 *  ring from the overhead/editor camera. */
const CLUSTER_ANGLES = [-2.7, -1.62, -0.54] as const;
const CLUSTER_JITTER = 0.34;

/** blender-optimize-tripo.py normalises everything it emits to this height. */
export const ASSET_HEIGHT = 10;

export interface HorizonPieceSpec {
  /** File under abyss/horizon, resolved through assetUrl. */
  name: string;
  /** How many of it stand among the detached clusters. */
  count: number;
  /** World height range. Assets are normalised to 10 by the optimiser, so this
   *  is what actually decides their scale. */
  height: [number, number];
  /** Distance from the fortress centre. */
  radius: [number, number];
  /** Salt, so two piece types with the same count do not land alike. */
  salt: number;
}

export const HORIZON_PIECES: readonly HorizonPieceSpec[] = [
  // Eleven pieces across three clusters imply geology without rebuilding a
  // continuous arena wall. Everything also sits farther out and lower than
  // the former 16-piece arc.
  { name: "horizon-cliff-terrace", count: 3, height: [22, 48], radius: [148, 196], salt: 11 },
  { name: "horizon-spire-needle", count: 3, height: [28, 58], radius: [158, 216], salt: 23 },
  // Ruins sit farther still and read as isolated remnants in fog, not a fence.
  { name: "horizon-tower-ruin", count: 2, height: [20, 38], radius: [190, 245], salt: 37 },
  { name: "horizon-ziggurat-ruin", count: 1, height: [18, 30], radius: [205, 258], salt: 53 },
  { name: "horizon-arch-buttress", count: 2, height: [15, 29], radius: [180, 238], salt: 71 },
];

/** Angle for the k-th piece among three separated clusters, jittered per salt. */
export function arcAngle(seed: number, k: number, _count: number, salt: number): number {
  const cluster = (k + salt) % CLUSTER_ANGLES.length;
  return CLUSTER_ANGLES[cluster]
    + (hash2(seed, k, salt) - 0.5) * CLUSTER_JITTER;
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
  // Envelope still varies repeated assets by height; the separated angle
  // clusters, rather than this envelope, now define the overall silhouette.
  const height = lo + (hi - lo) * (envelope * 0.75 + hash2(seed, k, spec.salt + 2) * 0.25);
  return {
    x: Math.cos(angle) * radius,
    // Sunk slightly, so nothing reads as resting on an invisible shelf.
    y: baseY - height * 0.06,
    z: Math.sin(angle) * radius,
    scale: height / ASSET_HEIGHT,
    // Face roughly inward, then wander — a ring of pieces all square to the
    // centre reads as a fence.
    // With only a handful of distant remnants, each repeated inward-facing
    // silhouette is conspicuous. Give the isolated clusters a wider yaw range
    // so they read as collapsed geology rather than surviving fence posts.
    yaw: angle + Math.PI / 2 + (hash2(seed, k, spec.salt + 3) - 0.5) * 2.2,
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
  group.userData.streamState = "loading";
  // Driver/visual comparison escape hatch. The production path below is the
  // lean distant material; `?horizonPbr=1` restores the imported materials so
  // cold-start A/B runs can compare the exact same geometry and placement.
  const useImportedPbr = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("horizonPbr") === "1";

  const draco = createGltfDracoLoader();
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
    loader.load(assetUrl(`abyss/horizon/${spec.name}.glb`), (gltf) => {
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

      const authoredMaterial = (Array.isArray(sourceMesh.material)
        ? sourceMesh.material[0]
        : sourceMesh.material) as THREE.MeshStandardMaterial;
      // These pieces live 150–260 units behind the fog curtain. Their imported
      // PBR materials still made the cold ScenePass build five Standard-node
      // graphs (metalness/roughness included) even though the screen cannot
      // resolve that response. Preserve each authored albedo and tint, but put
      // it on the already-resident Lambert path used by the dungeon stone.
      // This keeps the detached silhouettes textured and moon-lit while
      // removing five unnecessary PBR realizations from complete-scene boot.
      const material = useImportedPbr
        ? authoredMaterial
        : new THREE.MeshLambertNodeMaterial({
          color: authoredMaterial.color?.clone() ?? new THREE.Color(0x435565),
          map: authoredMaterial.map ?? null,
          vertexColors: geometry.hasAttribute("color"),
          flatShading: true,
        });
      if (!useImportedPbr) material.name = `distant-horizon-painted-${spec.name}`;
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

  const ready = Promise.all(HORIZON_PIECES.map(one)).then(() => {
    group.userData.streamState = "ready";
    group.userData.streamReadyAt = performance.now();
  });

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
