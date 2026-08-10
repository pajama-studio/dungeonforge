// A sparse cemetery belt for the otherwise empty abyss bedrock. Tree geometry
// is baked offline from pajama-studio/lowpoly-tree-generator's editable recipe;
// runtime work is limited to instanced LOD draws plus one grave draw; only the
// two tiers participating in a transition can be submitted per archetype.

import { assetUrl } from "../assets";
import * as THREE from "three/webgpu";
import { cameraPosition, length, positionWorld, smoothstep } from "three/tsl";
import { hash2 } from "../gen/rng";
import { ABYSS } from "../gen/dungeon";
import { TH } from "../config";

type Tier = 0 | 1 | 2;
type Variant = 0 | 1 | 2;
type Placement = {
  matrix: THREE.Matrix4;
  center: THREE.Vector3;
  radius: number;
  variant: Variant;
};

type BakedTreeAsset = {
  geometries: Record<string, Record<"near" | "mid" | "far", ReturnType<THREE.BufferGeometry["toJSON"]>>>;
};

const TREE_CAPACITY = 34;
const TREE_VARIANT_CAPACITY = Math.ceil(TREE_CAPACITY / 3);
const GRAVE_CAPACITY = 76;
const FLOOR_Y = ABYSS * TH - 11.82;
const TREE_ASSET = assetUrl("abyss/cemetery/dead-tree-lods.json");

function cemeteryAngle(seed: number, index: number, salt: number): number {
  // Two side chapels plus a decaying foreground crescent. The foreground is
  // offset from the +Z dragon axis, so it fills the player's empty approach
  // without intersecting the dragon column or turning into a uniform ring.
  const zone = index % 3;
  const center = zone === 0 ? 0 : zone === 1 ? Math.PI : 0.88;
  const span = zone === 2 ? 0.7 : 1.08;
  return center + (hash2(seed, index, salt) - 0.5) * span;
}

function makeTreePlacements(seed: number): Placement[] {
  const placements: Placement[] = [];
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const euler = new THREE.Euler();
  for (let i = 0; i < TREE_CAPACITY; i++) {
    const a = cemeteryAngle(seed, i, 201);
    const radius = 57 + hash2(seed, i, 202) * 22;
    const heightScale = 1.4 + hash2(seed, i, 203) * 1.45;
    position.set(Math.cos(a) * radius, FLOOR_Y, Math.sin(a) * radius);
    euler.set(
      (hash2(seed, i, 204) - 0.5) * 0.13,
      hash2(seed, i, 205) * Math.PI * 2,
      (hash2(seed, i, 206) - 0.5) * 0.18,
    );
    quaternion.setFromEuler(euler);
    const widthScale = heightScale * (0.78 + hash2(seed, i, 207) * 0.34);
    scale.set(widthScale, heightScale, widthScale);
    placements.push({
      matrix: new THREE.Matrix4().compose(position, quaternion, scale),
      center: position.clone().add(new THREE.Vector3(0, heightScale * 4.1, 0)),
      radius: heightScale * 5.7,
      variant: (i % 3) as Variant,
    });
  }
  return placements;
}

function makeGraveGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, 0);
  shape.lineTo(-0.53, 1.05);
  shape.lineTo(-0.38, 1.43);
  shape.lineTo(0, 1.72);
  shape.lineTo(0.38, 1.43);
  shape.lineTo(0.53, 1.05);
  shape.lineTo(0.5, 0);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.28,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: 0.055,
    bevelThickness: 0.045,
    curveSegments: 1,
  });
  geometry.translate(0, 0.04, -0.14);
  geometry.computeVertexNormals();
  geometry.name = "abyssGravestoneGeo";
  return geometry;
}

function makeGravePlacements(seed: number): Placement[] {
  const placements: Placement[] = [];
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const euler = new THREE.Euler();
  for (let i = 0; i < GRAVE_CAPACITY; i++) {
    const a = cemeteryAngle(seed, i, 221) + (hash2(seed, i, 222) - 0.5) * 0.34;
    const radius = 49 + hash2(seed, i, 223) * 28;
    const s = 1.55 + hash2(seed, i, 224) * 1.5;
    position.set(Math.cos(a) * radius, FLOOR_Y + 0.02, Math.sin(a) * radius);
    // Most graves roughly face the maze, with old subsidence providing the
    // irregular lean. Rotating every stone randomly looked like debris.
    euler.set(
      (hash2(seed, i, 225) - 0.5) * 0.18,
      a + Math.PI / 2 + (hash2(seed, i, 226) - 0.5) * 0.42,
      (hash2(seed, i, 227) - 0.5) * 0.22,
    );
    quaternion.setFromEuler(euler);
    scale.set(s * (0.72 + hash2(seed, i, 228) * 0.45), s, s * (0.8 + hash2(seed, i, 229) * 0.3));
    placements.push({
      matrix: new THREE.Matrix4().compose(position, quaternion, scale),
      center: position.clone().add(new THREE.Vector3(0, s * 0.9, 0)),
      radius: s * 1.3,
      variant: 0,
    });
  }
  return placements;
}

export function buildAbyssCemetery(seed: number): {
  group: THREE.Group;
  tick: (camera: THREE.Camera) => void;
  invalidate: () => void;
  dispose: () => void;
} {
  const group = new THREE.Group();
  group.name = "abyss-cemetery-instanced-lod";
  const treePlacements = makeTreePlacements(seed);
  const gravePlacements = makeGravePlacements(seed);
  const treeMeshes: THREE.InstancedMesh[][] = [[], [], []];
  let graveMesh: THREE.InstancedMesh | null = null;
  let disposed = false;
  let dirty = true;
  let lastCameraPosition = new THREE.Vector3(Infinity, Infinity, Infinity);
  let lastCameraQuaternion = new THREE.Quaternion();

  const makeTreeMaterial = (tier: Tier): THREE.MeshLambertNodeMaterial => {
    const material = new THREE.MeshLambertNodeMaterial({ vertexColors: true });
    const distance = length(positionWorld.sub(cameraPosition));
    // Adjacent LODs overlap inside broad dithered transition bands. Keeping the
    // material in the opaque pass avoids sorted-transparency artifacts, while
    // alpha-hash turns what used to be a one-frame silhouette jump into a
    // spatially stable dissolve.
    if (tier === 0) {
      material.opacityNode = smoothstep(175, 220, distance).oneMinus();
    } else if (tier === 1) {
      material.opacityNode = smoothstep(150, 190, distance)
        .mul(smoothstep(315, 365, distance).oneMinus());
    } else {
      material.opacityNode = smoothstep(290, 340, distance)
        .mul(smoothstep(480, 540, distance).oneMinus());
    }
    material.transparent = false;
    material.depthWrite = true;
    material.alphaHash = true;
    return material;
  };

  const treeMaterials = [makeTreeMaterial(0), makeTreeMaterial(1), makeTreeMaterial(2)];

  const graveMaterial = new THREE.MeshLambertNodeMaterial({
    color: 0x465b70,
  });
  const graveGeometry = makeGraveGeometry();
  graveMesh = new THREE.InstancedMesh(graveGeometry, graveMaterial, GRAVE_CAPACITY);
  graveMesh.name = "instanced-abyss-gravestones";
  graveMesh.count = 0;
  graveMesh.castShadow = false;
  graveMesh.receiveShadow = false;
  graveMesh.frustumCulled = false; // per-instance frustum test below
  graveMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(graveMesh);

  // Stream after the playable maze. Parsing 79 KB of baked geometry is far
  // cheaper than shipping/running the CSG generator and cannot delay first paint.
  const loadTimer = window.setTimeout(() => {
    void fetch(TREE_ASSET)
      .then((response) => {
        if (!response.ok) throw new Error(`dead tree LOD asset ${response.status}`);
        return response.json() as Promise<BakedTreeAsset>;
      })
      .then((asset) => {
        if (disposed) return;
        const loader = new THREE.BufferGeometryLoader();
        const archetypes = ["crookedNeck", "splitWidow", "stormClaw"];
        for (let variant = 0; variant < archetypes.length; variant++) {
          const archetype = archetypes[variant];
          for (const [tier, key] of (["near", "mid", "far"] as const).entries()) {
            const geometry = loader.parse(asset.geometries[archetype][key]);
            geometry.name = `abyssDeadTree-${archetype}-${key}`;
            geometry.computeBoundingSphere();
            const mesh = new THREE.InstancedMesh(geometry, treeMaterials[tier], TREE_VARIANT_CAPACITY);
            mesh.name = `instanced-abyss-dead-trees-${archetype}-${key}`;
            mesh.count = 0;
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            mesh.frustumCulled = false;
            mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            treeMeshes[variant].push(mesh);
            group.add(mesh);
          }
        }
        dirty = true;
      })
      .catch((error) => console.warn("[cemetery] tree stream failed", error));
  }, 1800);

  const projection = new THREE.Matrix4();
  const frustum = new THREE.Frustum();
  const sphere = new THREE.Sphere();
  const worldCenter = new THREE.Vector3();
  const worldScale = new THREE.Vector3();

  const tick = (camera: THREE.Camera) => {
    const treeReady = treeMeshes.every((variant) => variant.length === 3);
    if (!graveMesh || (treeMeshes.some((variant) => variant.length > 0) && !treeReady)) return;
    if (!dirty && camera.position.distanceToSquared(lastCameraPosition) < 1.5
      && 1 - Math.abs(camera.quaternion.dot(lastCameraQuaternion)) < 0.00008) return;
    dirty = false;
    lastCameraPosition.copy(camera.position);
    lastCameraQuaternion.copy(camera.quaternion);
    camera.updateMatrixWorld();
    group.updateWorldMatrix(true, false);
    projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projection);
    group.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), worldScale);
    const inheritedScale = Math.max(worldScale.x, worldScale.y, worldScale.z);

    if (treeReady) {
      const counts = Array.from({ length: 3 }, () => [0, 0, 0]);
      for (const placement of treePlacements) {
        worldCenter.copy(placement.center).applyMatrix4(group.matrixWorld);
        sphere.set(worldCenter, placement.radius * inheritedScale);
        const distance = camera.position.distanceTo(worldCenter) - sphere.radius;
        if (distance > 550 || !frustum.intersectsSphere(sphere)) continue;
        // Fill both geometries in transition bands. The shader above performs
        // the actual cross-fade, so camera motion cannot expose a hard LOD swap.
        const tiers: Tier[] = [];
        if (distance < 230) tiers.push(0);
        if (distance > 135 && distance < 380) tiers.push(1);
        if (distance > 275) tiers.push(2);
        for (const tier of tiers) {
          const count = counts[placement.variant][tier]++;
          treeMeshes[placement.variant][tier].setMatrixAt(count, placement.matrix);
        }
      }
      for (let variant = 0; variant < 3; variant++) {
        for (let tier = 0; tier < 3; tier++) {
          treeMeshes[variant][tier].count = counts[variant][tier];
          treeMeshes[variant][tier].visible = counts[variant][tier] > 0;
          treeMeshes[variant][tier].instanceMatrix.needsUpdate = true;
        }
      }
    }

    let graveCount = 0;
    for (const placement of gravePlacements) {
      worldCenter.copy(placement.center).applyMatrix4(group.matrixWorld);
      sphere.set(worldCenter, placement.radius * inheritedScale);
      if (camera.position.distanceTo(worldCenter) - sphere.radius > 245 || !frustum.intersectsSphere(sphere)) continue;
      graveMesh.setMatrixAt(graveCount++, placement.matrix);
    }
    graveMesh.count = graveCount;
    graveMesh.visible = graveCount > 0;
    graveMesh.instanceMatrix.needsUpdate = true;
    group.userData.culling = {
      trees: treeMeshes.map((variant) => variant.map((mesh) => mesh.count)),
      graves: graveCount,
      totalTrees: treePlacements.length,
      totalGraves: gravePlacements.length,
    };
  };

  return {
    group,
    tick,
    invalidate() { dirty = true; },
    dispose() {
      disposed = true;
      window.clearTimeout(loadTimer);
      group.removeFromParent();
      graveGeometry.dispose();
      graveMaterial.dispose();
      for (const variant of treeMeshes) {
        for (const mesh of variant) {
          mesh.geometry.dispose();
        }
      }
      treeMaterials.forEach((material) => material.dispose());
    },
  };
}
