// FIXED global light pool: three's WebGPU forward path recompiles every
// pipeline whenever the scene's light count changes — so the count never does.
// Islands submit LightSpecs; the pool re-aims existing lights at them.

import * as THREE from "three/webgpu";
import type { CinematicLightSpec, LightSpec } from "../scene/build";
import { LIGHT_POOL_SIZE } from "../config";

export class LightPool {
  private pool: THREE.PointLight[] = [];
  private specs: LightSpec[] = [];
  private readonly oracleKey: THREE.SpotLight;
  private readonly dragonBounce: THREE.PointLight;
  private readonly dragonRim: THREE.PointLight;
  /** Three of the global slots are permanently reserved for the landmark rig. */
  readonly dynamicSize: number;

  constructor(scene: THREE.Scene, readonly size = LIGHT_POOL_SIZE) {
    this.dynamicSize = Math.max(0, size - 3);
    for (let i = 0; i < this.dynamicSize; i++) {
      const pl = new THREE.PointLight(0xff9a45, 0, 15, 2);
      pl.name = `dungeon-light-${i}`;
      this.pool.push(pl);
      scene.add(pl);
    }

    // A narrow, shadowless raking key reveals only the oracle's face. Keeping
    // it allocated from startup avoids a WebGPU pipeline rebuild when the
    // streamed sculpture arrives.
    this.oracleKey = new THREE.SpotLight(0x78a6ca, 0, 280, Math.PI / 7, 0.72, 2);
    this.oracleKey.name = "cinematic-oracle-face-key";
    this.oracleKey.castShadow = false;
    this.oracleKey.target.name = "cinematic-oracle-face-target";
    scene.add(this.oracleKey, this.oracleKey.target);

    // Low, restrained hoard bounce: an external light on the rock, never an
    // emissive dragon material. The cool moon remains the dragon's main rim.
    this.dragonBounce = new THREE.PointLight(0xa86545, 0, 210, 2);
    this.dragonBounce.name = "cinematic-dragon-hoard-bounce";
    this.dragonBounce.castShadow = false;
    scene.add(this.dragonBounce);

    // Cold point source behind the dragon separates its silhouette without
    // making the stone emissive. Reserving one point slot keeps the exact old
    // shader topology: 15 point lights + one oracle spotlight.
    this.dragonRim = new THREE.PointLight(0x6f9fe8, 0, 390, 1.8);
    this.dragonRim.name = "cinematic-dragon-rim";
    this.dragonRim.castShadow = false;
    scene.add(this.dragonRim);
  }

  assign(specs: LightSpec[]): void {
    this.specs = specs.slice(0, this.dynamicSize);
    for (let i = 0; i < this.dynamicSize; i++) {
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

  /** Re-aim the two persistent cinematic slots after every procedural fit. */
  setCinematic(specs: CinematicLightSpec[]): void {
    const spot = specs.find((spec) => spec.role === "oracle-key")
      ?? specs.find((spec) => spec.kind === "spot" && spec.role !== "dragon-rim");
    if (spot) {
      this.oracleKey.position.set(spot.x, spot.y, spot.z);
      this.oracleKey.target.position.set(
        spot.targetX ?? spot.x,
        spot.targetY ?? spot.y,
        spot.targetZ ?? spot.z - 1,
      );
      this.oracleKey.color.setHex(spot.color);
      this.oracleKey.intensity = spot.base;
      this.oracleKey.distance = spot.dist;
      this.oracleKey.angle = spot.angle ?? Math.PI / 7;
      this.oracleKey.penumbra = spot.penumbra ?? 0.72;
    } else {
      this.oracleKey.intensity = 0;
    }

    const point = specs.find((spec) => spec.role === "dragon-focus")
      ?? specs.find((spec) => spec.kind === "point");
    if (point) {
      this.dragonBounce.position.set(point.x, point.y, point.z);
      this.dragonBounce.color.setHex(point.color);
      this.dragonBounce.intensity = point.base;
      this.dragonBounce.distance = point.dist;
    } else {
      this.dragonBounce.intensity = 0;
    }

    const rim = specs.find((spec) => spec.role === "dragon-rim");
    if (rim) {
      this.dragonRim.position.set(rim.x, rim.y, rim.z);
      this.dragonRim.color.setHex(rim.color);
      this.dragonRim.intensity = rim.base;
      this.dragonRim.distance = rim.dist;
    } else {
      this.dragonRim.intensity = 0;
    }
  }

  /** torch flicker — two incommensurate sines per light, phase from the spec.
   *  `damp` (0..1) scales the oscillation: from afar dozens of asynchronous
   *  flickers made the whole dungeon shimmer, so distance calms them. */
  tick(t: number, damp = 1): void {
    for (let i = 0; i < this.specs.length; i++) {
      const s = this.specs[i];
      this.pool[i].intensity = s.base * (0.82 + damp * (0.12 * Math.sin(t * 7.3 + s.ph) + 0.06 * Math.sin(t * 13.1 + s.ph * 1.7)));
    }
  }
}
