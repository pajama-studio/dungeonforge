// What a click can grab. The rule has to land on the semantic entity —
// neither an anonymous sub-mesh nor the bag that holds every landmark — and
// it has to hold for the real hierarchies the generator produces.

import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { selectableEntity, surfaceAlignment } from "./stage";

function node(name: string, children: THREE.Object3D[] = []): THREE.Object3D {
  const object = new THREE.Group();
  object.name = name;
  for (const child of children) object.add(child);
  return object;
}

function bag(count: number, name = ""): THREE.Object3D[] {
  return Array.from({ length: count }, (_, i) => node(`${name}filler-${i}`));
}

describe("selectableEntity", () => {
  it("picks the landmark entity, not the sub-mesh or the landmark bag", () => {
    const mesh = new THREE.Mesh();
    const shell = node("tripo-v3.1-abyssal-oracle-render-shell", [mesh]);
    const oracle = node("abyssal-cephalopod-oracle", [shell]);
    // the real landmark root holds ~19 children — a bag, not a thing
    const landmarkRoot = node("abyss-landmarks", [oracle, ...bag(18)]);
    const environment = node("environment", [landmarkRoot]);
    const scene = new THREE.Scene();
    scene.add(environment);

    expect(selectableEntity(mesh, scene)?.name).toBe("abyssal-cephalopod-oracle");
  });

  it("picks a whole island for masonry parented straight to the scene", () => {
    const blocks = new THREE.Mesh();
    blocks.name = "blocks";
    const fortress = node("fortress", [blocks]);
    const scene = new THREE.Scene();
    scene.add(fortress);

    expect(selectableEntity(blocks, scene)?.name).toBe("fortress");
  });

  it("picks a leaf entity that sits directly under a container", () => {
    const pool = new THREE.Mesh();
    pool.name = "maze-basin-bioluminescent-pool";
    const landmarkRoot = node("abyss-landmarks", [pool, ...bag(18)]);
    const scene = new THREE.Scene();
    scene.add(landmarkRoot);

    expect(selectableEntity(pool, scene)?.name).toBe("maze-basin-bioluminescent-pool");
  });

  it("refuses editor scaffolding and GPU-managed masonry", () => {
    const scene = new THREE.Scene();
    for (const name of [
      "editor-transform-gizmo",
      "dragon-placement-transform-anchor",
      "gpu-scene-masonry",
    ]) {
      const mesh = new THREE.Mesh();
      mesh.name = name;
      scene.add(mesh);
      expect(selectableEntity(mesh, scene)).toBeNull();
    }
  });

  it("never adopts the editor's own placement layer as world geometry", () => {
    // placements are picked by uid on a separate path; if this rule ever
    // returned them too, a click would select the same prop twice over
    const mesh = new THREE.Mesh();
    const layer = node("editor-placements", [node("crate-p1", [mesh])]);
    const scene = new THREE.Scene();
    scene.add(layer);
    expect(selectableEntity(mesh, scene)).toBeNull();
  });

  it("refuses a bare container and unnamed graphs", () => {
    const scene = new THREE.Scene();
    const container = node("abyss-landmarks", bag(9));
    scene.add(container);
    expect(selectableEntity(container, scene)).toBeNull();

    const orphan = new THREE.Mesh(); // unnamed, straight under the scene
    scene.add(orphan);
    expect(selectableEntity(orphan, scene)).toBeNull();
  });
});

describe("surfaceAlignment", () => {
  it("leaves props upright on flat ground", () => {
    expect(surfaceAlignment(new THREE.Vector3(0, 1, 0))).toBeNull();
  });

  it("leaves props upright on a wall rather than laying them on their side", () => {
    expect(surfaceAlignment(new THREE.Vector3(1, 0, 0))).toBeNull();
    expect(surfaceAlignment(new THREE.Vector3(0, 0.1, 0.99).normalize())).toBeNull();
  });

  it("tilts a prop to match a slope", () => {
    const slope = new THREE.Vector3(0.5, 0.8, 0).normalize();
    const tilt = surfaceAlignment(slope);
    expect(tilt).not.toBeNull();
    // the prop's local up must end up pointing along the surface normal
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(tilt!);
    expect(up.angleTo(slope)).toBeLessThan(1e-6);
  });
});
