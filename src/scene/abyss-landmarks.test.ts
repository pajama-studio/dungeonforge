import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";

import { samplePerchSurfaceXZ, samplePerchSurfacesXZ } from "./abyss-landmarks";

describe("batched perch surface sampling", () => {
  it("matches independent highest-upward triangle queries", () => {
    const geometry = new THREE.PlaneGeometry(12, 10, 9, 7);
    geometry.rotateX(-Math.PI / 2);
    const position = geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i), z = position.getZ(i);
      position.setY(i, Math.sin(x * 0.63) * 0.8 + Math.cos(z * 0.47) * 0.55);
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();
    const queries = [
      { x: -4.2, z: -2.8 }, { x: -1.1, z: 3.2 },
      { x: 2.7, z: -0.4 }, { x: 5.4, z: 4.1 }, { x: 20, z: 20 },
    ];
    const expected = queries.map(({ x, z }) => samplePerchSurfaceXZ(geometry, x, z));
    const actual = samplePerchSurfacesXZ(geometry, queries);
    for (let i = 0; i < queries.length; i++) {
      const actualHit = actual[i];
      const expectedHit = expected[i];
      expect(actualHit?.triangle ?? null).toBe(expectedHit?.triangle ?? null);
      if (!actualHit || !expectedHit) continue;
      expect(actualHit.point.distanceTo(expectedHit.point)).toBeLessThan(1e-8);
      expect(actualHit.normal.distanceTo(expectedHit.normal)).toBeLessThan(1e-8);
    }
    geometry.dispose();
  });
});
