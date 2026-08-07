// The Route — the navmesh's GRAND TOUR (every reachable block, left end
// first) drawn as one thin glowing filament whose light pulses stream toward
// the goal, and shared with the skeleton walker as a single arc-length curve.

import * as THREE from "three/webgpu";
import type { Ctx } from "./context";
import type { NavMesh } from "./nav";
import { getKit } from "../scene/kit";
import { routeFlow } from "../scene/kit/materials";

export class RoutePath {
  private mesh: THREE.Mesh | null = null;
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
    // one thin filament along the whole tour; pulse spacing stays ~2.4 world
    // units regardless of tour length (the material reads routeFlow)
    const R = getKit();
    const segs = Math.min(4000, Math.max(64, Math.floor(rc.length / 0.8)));
    const geo = new THREE.TubeGeometry(rc.curve, segs, 0.085, 5, false);
    geo.translate(0, -0.18, 0); // settle toward the pavement (curve floats at +0.45)
    routeFlow.value = Math.max(8, Math.round(rc.length / 2.4));
    const mesh = new THREE.Mesh(geo, R.routeBeamMat);
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
      this.mesh.geometry.dispose(); // per-tour tube — the material is kit-shared
      this.mesh = null;
    }
    this.visible = false;
  }

  /** a re-forge invalidates the drawn route */
  tick(): void {
    if (this.visible && this.ctx.state.token !== this.shownToken) this.hide();
  }
}
