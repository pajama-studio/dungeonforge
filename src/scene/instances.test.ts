// InstList must compose exactly what Matrix4.compose would — the render path
// trusts these raw floats without ever round-tripping through THREE objects.

import { describe, it, expect } from "vitest";
import { Matrix4, Quaternion, Vector3, Euler } from "three";
import { InstArena, InstList } from "./instances";
import { getSlot, putInstanced, putInstancedTwin } from "./slots";
import * as THREE from "three/webgpu";

describe("InstList", () => {
  it("pushY matches Matrix4.compose for yaw+scale", () => {
    const list = new InstList();
    const cases = [
      { x: 1.5, y: -2, z: 3.25, rotY: 0, sx: 1, sy: 1, sz: 1 },
      { x: -4, y: 0.16, z: 9, rotY: 1.234, sx: 0.45, sy: 1.06, sz: 2.2 },
      { x: 0, y: 0, z: 0, rotY: -2.9, sx: 1.45, sy: 0.5, sz: 1.45 },
    ];
    for (const c of cases) list.pushY(c.x, c.y, c.z, c.rotY, c.sx, c.sy, c.sz, { r: 1, g: 1, b: 1 });

    const m = new Matrix4();
    const q = new Quaternion();
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      q.setFromEuler(new Euler(0, c.rotY, 0));
      m.compose(new Vector3(c.x, c.y, c.z), q, new Vector3(c.sx, c.sy, c.sz));
      for (let e = 0; e < 16; e++) {
        expect(list.mats[i * 16 + e]).toBeCloseTo(m.elements[e], 5);
      }
    }
  });

  it("grows past its initial capacity and keeps colors aligned", () => {
    const list = new InstList();
    for (let i = 0; i < 1000; i++) {
      list.pushY(i, 2 * i, 3 * i, 0, 1, 1, 1, { r: i / 1000, g: 0.5, b: 0.25 });
    }
    expect(list.count).toBe(1000);
    expect(list.mats[999 * 16 + 12]).toBe(999);
    expect(list.mats[999 * 16 + 14]).toBe(3 * 999);
    expect(list.cols[999 * 3]).toBeCloseTo(0.999, 5);
    expect(list.cols[999 * 3 + 2]).toBeCloseTo(0.25, 5);
  });

  it("pushMatrix stores elements verbatim", () => {
    const list = new InstList();
    const m = new Matrix4().compose(
      new Vector3(1, 2, 3),
      new Quaternion().setFromEuler(new Euler(0.3, 0.6, -0.2)),
      new Vector3(2, 0.5, 1),
    );
    list.pushMatrix(m.elements, { r: 0.1, g: 0.2, b: 0.3 });
    for (let e = 0; e < 16; e++) expect(list.mats[e]).toBeCloseTo(m.elements[e], 6);
  });

  it("tracks translation bounds and resets them when reused", () => {
    const arena = new InstArena();
    const first = arena.take(2);
    first.pushY(-4, 7, 2, 0, 1, 1, 1, { r: 1, g: 0, b: 0 });
    first.pushY(3, -2, 9, 0, 1, 1, 1, { r: 0, g: 1, b: 0 });
    expect([first.minX, first.minY, first.minZ]).toEqual([-4, -2, 2]);
    expect([first.maxX, first.maxY, first.maxZ]).toEqual([3, 7, 9]);

    arena.reset();
    const reused = arena.take(2);
    expect(reused).toBe(first);
    expect(reused.count).toBe(0);
    expect(reused.minX).toBe(Infinity);
    expect(reused.maxX).toBe(-Infinity);
  });
});

describe("instanced render-object twins", () => {
  const makeList = (count: number) => {
    const list = new InstList(count);
    for (let i = 0; i < count; i++) {
      list.pushY(i, 0, 0, 0, 1, 1, 1, { r: 1, g: 1, b: 1 });
    }
    return list;
  };

  it("recreates a cached twin when its source grows from 327 to 352 instances", () => {
    const pool = getSlot(98_327);
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const sourceMaterial = new THREE.MeshBasicMaterial();
    const twinMaterial = new THREE.MeshBasicMaterial({ transparent: true });

    // ceil(204 × 1.6) = 327: this is the exact stale GPU buffer capacity from
    // the reported 3924-byte instanceColor binding (327 × RGB × 4 bytes).
    putInstanced(pool, "source", geometry, sourceMaterial, makeList(204));
    putInstancedTwin(pool, "twin", "source", geometry, twinMaterial);
    const oldTwin = pool.meshes.get("twin")!;
    expect(oldTwin.instanceColor!.count).toBe(327);

    // The next forge requires 352 instances and replaces the source buffers.
    putInstanced(pool, "source", geometry, sourceMaterial, makeList(352));
    const grownSource = pool.meshes.get("source")!;
    putInstancedTwin(pool, "twin", "source", geometry, twinMaterial);
    const grownTwin = pool.meshes.get("twin")!;

    expect(grownTwin).not.toBe(oldTwin);
    expect(grownTwin.instanceMatrix).toBe(grownSource.instanceMatrix);
    expect(grownTwin.instanceColor).toBe(grownSource.instanceColor);
    expect(grownTwin.instanceMatrix.count).toBeGreaterThanOrEqual(352);
    expect(grownTwin.instanceColor!.count).toBeGreaterThanOrEqual(352);
    expect(grownTwin.count).toBe(352);

    geometry.dispose();
    sourceMaterial.dispose();
    twinMaterial.dispose();
  });
});
