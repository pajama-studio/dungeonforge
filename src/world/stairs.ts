// Square spiral staircases (old-stairwell style): flights wind around a square
// core with corner turns. Walking up is FREE — the ground sampler returns the
// continuous spiral height (see world/spiral.ts), so the player simply walks
// the flights.
//
// Every tower is a VARIANT: diameter, pitch, tread cut and core mass differ
// per position (deterministic hash — no Math.random). The variant lives on
// the StairTower record, and walkmap / nav / the mesh all read those fields.

import * as THREE from "three/webgpu";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { STAIR } from "../config";
import { getKit, shadeFaces } from "../scene/kit";
import type { StairSpan } from "./spiral";

export interface StairTower extends StairSpan {
  x: number; z: number;
  /** outer walkable half-width and solid core half-width */
  a: number; core: number;
}

export class StairTowers {
  readonly towers: StairTower[] = [];
  private meshes: THREE.Object3D[] = [];

  constructor(private scene: THREE.Scene) {}

  build(x: number, z: number, y0: number, y1: number): void {
    // deterministic per-position variant
    const h = (n: number) => {
      const v = Math.sin(x * 127.1 + z * 311.7 + y0 * 74.7 + n * 53.29) * 43758.5453;
      return v - Math.floor(v);
    };
    const m = STAIR.M * (0.85 + h(1) * 0.42);          // mid-ring half-width
    const core = STAIR.CORE * (m / STAIR.M);            // core scales with it
    const a = core + (STAIR.A - STAIR.CORE);            // tread span constant
    const rise = STAIR.RISE * (0.85 + h(2) * 0.4);      // pitch varies
    const treadT = 0.1 + h(3) * 0.07;                   // tread slab thickness
    const treadW = 0.52 + h(4) * 0.24;                  // tread cut along the run

    const parts: THREE.BufferGeometry[] = [];
    const P = 8 * m;
    const rc = (core + a) / 2; // radial centerline of the treads
    const span = a - core + 0.2;
    const nSteps = Math.ceil((y1 - y0 + 0.6) / rise);
    for (let i = 0; i < nSteps; i++) {
      const s = (i * STAIR.STEP) % P;
      const side = Math.floor(s / (2 * m));
      const along = (s % (2 * m)) - m;
      // sides 0/2 run along x (tread depth radial in z); sides 1/3 run along z
      const tread = side % 2 === 0
        ? new THREE.BoxGeometry(treadW, treadT, span)
        : new THREE.BoxGeometry(span, treadT, treadW);
      if (side === 0) tread.translate(along, i * rise - 0.3, -rc);
      else if (side === 1) tread.translate(rc, i * rise - 0.3, along);
      else if (side === 2) tread.translate(-along, i * rise - 0.3, rc);
      else tread.translate(-rc, i * rise - 0.3, -along);
      parts.push(tread);
    }
    // solid square core the flights wind around; tall towers get a heavier
    // core with a capstone so the silhouette varies with the variant
    const core2 = core * 2;
    const coreGeo = new THREE.BoxGeometry(core2, y1 - y0 + 2.2, core2);
    coreGeo.translate(0, (y1 - y0) / 2 + 0.4, 0);
    parts.push(coreGeo);
    if (h(5) > 0.45) {
      const cap = new THREE.BoxGeometry(core2 + 0.5, 0.5, core2 + 0.5);
      cap.translate(0, y1 - y0 + 1.7, 0);
      parts.push(cap);
    }
    // per-face shading vertex colors keep the tower reading like the masonry kit
    const geo = shadeFaces(BufferGeometryUtils.mergeGeometries(parts));
    for (const g of parts) g.dispose();
    const mesh = new THREE.Mesh(geo, getKit().stairMat);
    mesh.position.set(x, y0, z);
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.meshes.push(mesh);
    this.towers.push({ x, z, y0, y1, m, a, core, rise });
  }

  clear(): void {
    for (const m of this.meshes) {
      m.removeFromParent();
      (m as THREE.Mesh).geometry?.dispose(); // per-tower merges are unique — free them
    }
    this.meshes.length = 0;
    this.towers.length = 0;
  }
}
