// Square spiral staircases (old-stairwell style): flights wind around a square
// core with corner turns. Walking up is FREE — the ground sampler returns the
// continuous spiral height (see world/spiral.ts), so the player simply walks
// the flights.

import * as THREE from "three/webgpu";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { STAIR } from "../config";
import { getKit, shadeFaces } from "../scene/kit";

export interface StairTower { x: number; z: number; y0: number; y1: number }

export class StairTowers {
  readonly towers: StairTower[] = [];
  private meshes: THREE.Object3D[] = [];

  constructor(private scene: THREE.Scene) {}

  build(x: number, z: number, y0: number, y1: number): void {
    const parts: THREE.BufferGeometry[] = [];
    const m = STAIR.M, P = 8 * m;
    const rc = (STAIR.CORE + STAIR.A) / 2; // radial centerline of the treads
    const span = STAIR.A - STAIR.CORE + 0.2;
    const nSteps = Math.ceil((y1 - y0 + 0.6) / STAIR.RISE);
    for (let i = 0; i < nSteps; i++) {
      const s = (i * STAIR.STEP) % P;
      const side = Math.floor(s / (2 * m));
      const along = (s % (2 * m)) - m;
      // sides 0/2 run along x (tread depth radial in z); sides 1/3 run along z
      const tread = side % 2 === 0
        ? new THREE.BoxGeometry(0.6, 0.12, span)
        : new THREE.BoxGeometry(span, 0.12, 0.6);
      if (side === 0) tread.translate(along, i * STAIR.RISE - 0.3, -rc);
      else if (side === 1) tread.translate(rc, i * STAIR.RISE - 0.3, along);
      else if (side === 2) tread.translate(-along, i * STAIR.RISE - 0.3, rc);
      else tread.translate(-rc, i * STAIR.RISE - 0.3, -along);
      parts.push(tread);
    }
    // solid square core the flights wind around
    const core = new THREE.BoxGeometry(STAIR.CORE * 2, y1 - y0 + 2.2, STAIR.CORE * 2);
    core.translate(0, (y1 - y0) / 2 + 0.4, 0);
    parts.push(core);
    // per-face shading vertex colors keep the tower reading like the masonry kit
    const geo = shadeFaces(BufferGeometryUtils.mergeGeometries(parts));
    for (const g of parts) g.dispose();
    const mesh = new THREE.Mesh(geo, getKit().stairMat);
    mesh.position.set(x, y0, z);
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.meshes.push(mesh);
    this.towers.push({ x, z, y0, y1 });
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
