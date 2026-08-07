// The Route — the navmesh's GRAND TOUR (every reachable block, spawn first)
// drawn as flat chevron decals marching toward the direction of travel, and
// shared with the skeleton walker as a single arc-length curve.

import * as THREE from "three/webgpu";
import type { Ctx } from "./context";
import type { NavMesh } from "./nav";
import { getKit } from "../scene/kit";

export class RoutePath {
  private mesh: THREE.InstancedMesh | null = null;
  private shownToken = -1;
  private curve: THREE.CatmullRomCurve3 | null = null;
  private curveLen = 0;
  private curveToken = -1;
  visible = false;

  constructor(private ctx: Ctx, private nav: NavMesh) {}

  /** compute (or reuse) the tour curve for the current world */
  ensure(): { curve: THREE.CatmullRomCurve3; length: number } | null {
    if (this.curveToken !== this.ctx.state.token || !this.curve) {
      const tour = this.nav.tour();
      if (!tour) return null;
      this.curve = new THREE.CatmullRomCurve3(tour.pts, false, "centripetal", 0.35);
      this.curveLen = this.curve.getLength();
      this.curveToken = this.ctx.state.token;
    }
    return { curve: this.curve, length: this.curveLen };
  }

  show(): void {
    if (this.visible) return;
    const rc = this.ensure();
    if (!rc) return;
    // one flat chevron every ~1.7 units of arc, oriented along the tangent
    const R = getKit();
    const n = Math.max(2, Math.floor(rc.length / 1.7));
    const mesh = new THREE.InstancedMesh(R.arrowGeo, R.arrowMat, n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const s = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n;
      const p = rc.curve.getPointAt(u);
      const tan = rc.curve.getTangentAt(u);
      p.y -= 0.28; // settle toward the pavement (curve floats at +0.55)
      q.setFromAxisAngle(up, Math.atan2(tan.x, tan.z));
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    this.mesh = mesh;
    this.ctx.scene.add(mesh);
    this.shownToken = this.ctx.state.token;
    this.visible = true;
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  hide(): void {
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.dispose(); // instance buffers only — geometry/material are kit-shared
      this.mesh = null;
    }
    this.visible = false;
  }

  /** a re-forge invalidates the drawn route */
  tick(): void {
    if (this.visible && this.ctx.state.token !== this.shownToken) this.hide();
  }
}
