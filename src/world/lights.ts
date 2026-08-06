// FIXED global light pool: three's WebGPU forward path recompiles every
// pipeline whenever the scene's light count changes — so the count never does.
// Islands submit LightSpecs; the pool re-aims existing lights at them.

import * as THREE from "three/webgpu";
import type { LightSpec } from "../scene/build";
import { LIGHT_POOL_SIZE } from "../config";

export class LightPool {
  private pool: THREE.PointLight[] = [];
  private specs: LightSpec[] = [];

  constructor(scene: THREE.Scene, readonly size = LIGHT_POOL_SIZE) {
    for (let i = 0; i < size; i++) {
      const pl = new THREE.PointLight(0xff9a45, 0, 15, 2);
      this.pool.push(pl);
      scene.add(pl);
    }
  }

  assign(specs: LightSpec[]): void {
    this.specs = specs.slice(0, this.size);
    for (let i = 0; i < this.size; i++) {
      const pl = this.pool[i];
      const s = this.specs[i];
      if (s) {
        pl.position.set(s.x, s.y, s.z);
        pl.color.setHex(s.color);
        pl.distance = s.dist;
        pl.intensity = s.base;
      } else {
        pl.intensity = 0;
      }
    }
  }

  /** torch flicker — two incommensurate sines per light, phase from the spec */
  tick(t: number): void {
    for (let i = 0; i < this.specs.length; i++) {
      const s = this.specs[i];
      this.pool[i].intensity = s.base * (0.82 + 0.12 * Math.sin(t * 7.3 + s.ph) + 0.06 * Math.sin(t * 13.1 + s.ph * 1.7));
    }
  }
}
