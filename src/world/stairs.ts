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
import { stairXZAtHeight, stairXZAtS, type StairSpan } from "./spiral";

export interface StairDockPoint { x: number; y: number; z: number }
export interface StairLanding { a: StairDockPoint; b: StairDockPoint; width: number }

export interface StairDock {
  lower: StairDockPoint;
  upper: StairDockPoint;
  /** side of both fortress walls that the external tower docks to */
  side: number;
}

export interface StairTower extends StairSpan {
  x: number; z: number;
  /** outer walkable half-width and solid core half-width */
  a: number; core: number;
  lowerDock: StairDockPoint;
  upperDock: StairDockPoint;
  lowerStep: StairDockPoint;
  upperStep: StairDockPoint;
  landings: [StairLanding, StairLanding];
}

export class StairTowers {
  readonly towers: StairTower[] = [];
  private meshes: THREE.Object3D[] = [];
  private fadeMeshes: THREE.Mesh[] = [];

  constructor(private scene: THREE.Scene) {}

  build(x: number, z: number, y0: number, y1: number, dock?: StairDock): void {
    // deterministic per-position variant
    const h = (n: number) => {
      const v = Math.sin(x * 127.1 + z * 311.7 + y0 * 74.7 + n * 53.29) * 43758.5453;
      return v - Math.floor(v);
    };
    const m = STAIR.M * (0.85 + h(1) * 0.42);          // mid-ring half-width
    const halfTread = (STAIR.A - STAIR.CORE) / 2;
    const core = Math.max(0.32, m - halfTread);
    const a = m + halfTread;                             // analytic m is the drawn centreline
    const P = 8 * m;
    const height = Math.max(0.1, y1 - y0);
    // End both flights at the SAME face of the tower. The previous arbitrary
    // pitch left the top tread on a random side, so its visual landing often
    // ran through the solid core instead of meeting the upper floor.
    const targetRise = STAIR.RISE * (0.88 + h(2) * 0.28);
    const targetLoopRise = P * targetRise / STAIR.STEP;
    const loops = Math.max(1, Math.round(height / targetLoopRise));
    const rise = height * STAIR.STEP / (loops * P);
    const treadT = 0.1 + h(3) * 0.07;                   // tread slab thickness
    const treadW = 0.52 + h(4) * 0.24;                  // tread cut along the run

    // The perimeter phase selects the point nearest the wall: +x dock sees
    // the west face, -x the east face, +z the north face, -z the south face.
    const side = dock?.side ?? 0;
    const phase = [7 * m, 3 * m, 1 * m, 5 * m][side] ?? 0;
    const spanData: StairSpan = { y0, y1, m, rise, phase };
    const loXZ = stairXZAtHeight(spanData, y0);
    const hiXZ = stairXZAtHeight(spanData, y1);
    const lowerStep = { x: x + loXZ.x, y: y0, z: z + loXZ.z };
    const upperStep = { x: x + hiXZ.x, y: y1, z: z + hiXZ.z };
    const lowerDock = dock?.lower ?? { x, y: y0, z };
    const upperDock = dock?.upper ?? { x, y: y1, z };
    const landings: [StairLanding, StairLanding] = [
      { a: lowerDock, b: lowerStep, width: 1.35 },
      { a: upperDock, b: upperStep, width: 1.35 },
    ];

    const parts: THREE.BufferGeometry[] = [];
    const rc = m; // exactly the same centreline used by spiralHeight()
    const span = a - core + 0.2;
    // Each step is a BLOCK, not a slab: it carries its own riser down to meet
    // the step below, the way a cut-stone spiral actually works. A slab of
    // thickness treadT (0.10-0.17) against a rise of ~0.26 left more than half
    // the height as open air, so the flight read as a stack of plates threaded
    // on a post — see-through, and visibly not a thing you could climb.
    //
    // Costs nothing: the same box, taller, translated so its walking surface
    // stays exactly where the analytic spiralHeight() sampler expects it. The
    // ground sampler is untouched by design — the geometry now agrees with the
    // height field that was always there.
    const stepH = rise + treadT;
    const addTread = (s: number, localY: number): void => {
      const p = stairXZAtS(s, m);
      const ringSide = Math.floor((((s % P) + P) % P) / (2 * m));
      // sides 0/2 run along x (tread depth radial in z); sides 1/3 run along z
      const tread = ringSide % 2 === 0
        ? new THREE.BoxGeometry(treadW, stepH, span)
        : new THREE.BoxGeometry(span, stepH, treadW);
      // Keep the top face where the slab's top face used to be.
      const top = localY - 0.12 + treadT / 2;
      tread.translate(p.x, top - stepH / 2, p.z);
      parts.push(tread);

      // No parapet here, and that is a decision rather than an omission. A
      // 0.62 rail on the outer edge of every step was tried and reverted: one
      // per step joins into a continuous wall that hides the treads entirely,
      // turning a readable flight into a slotted column. The steps ARE the
      // silhouette, and anything at their outer edge competes with them.
    };
    const fullSteps = Math.floor(height / rise);
    for (let i = 0; i <= fullSteps; i++) addTread(phase + i * STAIR.STEP, i * rise);
    // height/rise is rarely integral because a loop perimeter is continuous;
    // add one exact cap tread instead of clamping several overshooting steps
    // onto the top landing at unrelated x/z positions.
    if (height - fullSteps * rise > rise * 0.08) {
      addTread(phase + height / rise * STAIR.STEP, height);
    }

    // Real floor-to-floor docks: broad stone slabs run from each gate to the
    // first/last tread, with low curb stones that frame (but do not block) the
    // walking surface. These make the connection legible from the overview.
    for (const landing of landings) {
      const dx = landing.b.x - landing.a.x, dz = landing.b.z - landing.a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const ang = Math.atan2(dx, dz);
      const mx = (landing.a.x + landing.b.x) / 2 - x;
      const mz = (landing.a.z + landing.b.z) / 2 - z;
      const ly = landing.a.y - y0;
      const slab = new THREE.BoxGeometry(landing.width, 0.24, len + 0.35);
      slab.rotateY(ang);
      slab.translate(mx, ly - 0.11, mz);
      parts.push(slab);
      const px = Math.cos(ang), pz = -Math.sin(ang);
      for (const sign of [-1, 1]) {
        const curb = new THREE.BoxGeometry(0.16, 0.38, len + 0.2);
        curb.rotateY(ang);
        curb.translate(
          mx + px * sign * (landing.width / 2 - 0.08),
          ly + 0.08,
          mz + pz * sign * (landing.width / 2 - 0.08),
        );
        parts.push(curb);
      }
    }
    // solid square core the flights wind around; tall towers get a heavier
    // core with a capstone so the silhouette varies with the variant
    const core2 = core * 2;
    // Coursed, not one tall box. A single extrusion reads as a painted slab the
    // moment a tower is seen in the open rather than between fortress walls —
    // which the entrance tower is, standing alone on its dais out in the abyss.
    // Courses cost ~12 triangles each and make it masonry.
    const courseH = 0.94;
    const courses = Math.max(1, Math.round((y1 - y0 + 2.2) / courseH));
    for (let k = 0; k < courses; k++) {
      const wobble = (h(30 + k) - 0.5) * 0.09;
      const brick = new THREE.BoxGeometry(core2 + wobble, courseH * 0.94, core2 + wobble);
      // Alternate the course inset so the joint line reads at a distance.
      brick.translate((k & 1) * 0.02, (k + 0.5) * courseH - 0.7, 0);
      parts.push(brick);
    }
    if (h(5) > 0.45) {
      const cap = new THREE.BoxGeometry(core2 + 0.5, 0.5, core2 + 0.5);
      cap.translate(0, y1 - y0 + 1.7, 0);
      parts.push(cap);
    }
    // per-face shading vertex colors keep the tower reading like the masonry kit
    const geo = shadeFaces(BufferGeometryUtils.mergeGeometries(parts));
    for (const g of parts) g.dispose();
    const R = getKit();
    const mesh = new THREE.Mesh(geo, R.stairMat);
    mesh.position.set(x, y0, z);
    mesh.name = "vertical-stair-dock";
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.meshes.push(mesh);
    const fade = new THREE.Mesh(geo, R.stairFadeMat);
    fade.position.copy(mesh.position);
    fade.name = "vertical-stair-occluder-fade";
    fade.visible = false;
    fade.renderOrder = 40;
    this.scene.add(fade);
    this.fadeMeshes.push(fade);
    this.towers.push({
      x, z, y0, y1, m, a, core, rise, phase,
      lowerDock, upperDock, lowerStep, upperStep, landings,
    });
  }

  setOccluded(indices: ReadonlySet<number>): void {
    for (let i = 0; i < this.meshes.length; i++) {
      this.meshes[i].visible = !indices.has(i);
      this.fadeMeshes[i].visible = indices.has(i);
    }
  }

  /** Put real fade twins on the isolated warm-up layer for one hidden draw. */
  stageFadeWarmup(layer: number): () => void {
    const saved = this.fadeMeshes.map((mesh) => ({
      mesh, visible: mesh.visible, culled: mesh.frustumCulled, mask: mesh.layers.mask,
    }));
    for (const { mesh } of saved) {
      mesh.visible = true;
      mesh.frustumCulled = false;
      mesh.layers.set(layer);
    }
    return () => {
      for (const s of saved) {
        s.mesh.visible = s.visible;
        s.mesh.frustumCulled = s.culled;
        s.mesh.layers.mask = s.mask;
      }
    };
  }

  clear(): void {
    for (const m of this.meshes) {
      m.removeFromParent();
      (m as THREE.Mesh).geometry?.dispose(); // per-tower merges are unique — free them
    }
    for (const m of this.fadeMeshes) m.removeFromParent();
    this.meshes.length = 0;
    this.fadeMeshes.length = 0;
    this.towers.length = 0;
  }
}
