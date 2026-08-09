import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";

import { brambleCaneGeometry, brambleClumpGeometry, scatterBrambles, CANE_DEFAULTS } from "./brambles";

const positions = (g: THREE.BufferGeometry) => g.getAttribute("position").array as Float32Array;

describe("bramble canes", () => {
  it("is bit-for-bit deterministic for a seed", () => {
    // The whole no-sync doctrine rests on this: every client grows the same
    // briar from the same integer, so the bed never has to go over the wire.
    const a = positions(brambleCaneGeometry(1234, 7));
    const b = positions(brambleCaneGeometry(1234, 7));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("grows a different cane for a different salt", () => {
    const a = positions(brambleCaneGeometry(1234, 7));
    const b = positions(brambleCaneGeometry(1234, 8));
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("roots at the ground and arches back down", () => {
    const p = positions(brambleCaneGeometry(99, 1));
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < p.length; i += 3) { minY = Math.min(minY, p[i]); maxY = Math.max(maxY, p[i]); }
    // Nothing may hang below the bed — a cane that starts underground reads as
    // clipping through the silt.
    expect(minY).toBeGreaterThan(-CANE_DEFAULTS.radius * 3);
    // And it must actually arch: the crown is well above the root.
    expect(maxY).toBeGreaterThan(CANE_DEFAULTS.rise * 0.6);
  });

  it("produces no degenerate triangles", () => {
    // A zero-area triangle gets a NaN normal from computeVertexNormals, which
    // shows up as one black shard that is very hard to trace back here.
    const g = brambleCaneGeometry(7, 3);
    const p = positions(g);
    const n = g.getAttribute("normal").array as Float32Array;
    for (let i = 0; i < n.length; i++) expect(Number.isFinite(n[i])).toBe(true);
    let degenerate = 0;
    for (let i = 0; i < p.length; i += 9) {
      const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
      const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
      const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
      if (Math.hypot(cx, cy, cz) < 1e-12) degenerate++;
    }
    expect(degenerate).toBe(0);
  });

  it("is non-indexed so normals stay per-face", () => {
    // Faceted shading is the kit's look; an indexed cane would average normals
    // across the tube and go smooth.
    const g = brambleCaneGeometry(5, 5);
    expect(g.getIndex()).toBeNull();
    expect(g.getAttribute("color").count).toBe(g.getAttribute("position").count);
  });

  it("stays within a triangle budget a thicket can afford", () => {
    const tris = brambleClumpGeometry(11, 0).getAttribute("position").count / 3;
    // 900 instances at this size is the whole bed; keep a clump cheap enough
    // that the thicket stays a rounding error against the masonry.
    expect(tris).toBeLessThan(600);
  });
});

describe("bramble scatter", () => {
  const scatterInto = (count: number, radius: number, center = new THREE.Vector3(4, -2, -7)) => {
    const mesh = new THREE.InstancedMesh(brambleClumpGeometry(3, 0), new THREE.MeshBasicMaterial(), count);
    scatterBrambles(mesh, 2026, center, radius);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    return Array.from({ length: count }, (_, i) => {
      mesh.getMatrixAt(i, m);
      return p.setFromMatrixPosition(m).clone();
    });
  };

  it("keeps every clump inside the basin and out of the statue's pool", () => {
    const center = new THREE.Vector3(4, -2, -7);
    const radius = 40;
    for (const p of scatterInto(120, radius, center)) {
      const d = Math.hypot(p.x - center.x, p.z - center.z);
      expect(d).toBeLessThanOrEqual(radius + 1e-6);
      expect(d).toBeGreaterThanOrEqual(radius * 0.18 - 1e-6);
      expect(p.y).toBeCloseTo(center.y, 6); // seated on the bed, not floating
    }
  });

  it("spreads by area, not by radius", () => {
    // Drawing the radius uniformly bunches everything at the middle. sqrt(u)
    // is what makes the density even, and this is the check that catches a
    // regression to the naive version.
    const radius = 40;
    const ps = scatterInto(800, radius);
    const half = radius / Math.SQRT2; // half the area lies inside this circle
    const inner = ps.filter((p) => Math.hypot(p.x - 4, p.z + 7) < half).length;
    expect(inner / ps.length).toBeGreaterThan(0.35);
    expect(inner / ps.length).toBeLessThan(0.62);
  });

  it("places the same thicket for the same seed", () => {
    const a = scatterInto(60, 25).map((p) => p.toArray().join(","));
    const b = scatterInto(60, 25).map((p) => p.toArray().join(","));
    expect(a).toEqual(b);
  });
});
