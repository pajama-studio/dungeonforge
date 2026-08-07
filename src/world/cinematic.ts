// Cinematic flythrough — a dual-spline rig (position curve + look-target
// curve, both closed CatmullRoms sampled by arc length) built from whatever
// world currently exists: the envelope, a medallion plaza, the longest rope
// bridge, the tallest block. Establishing wide → dive toward the front →
// low glide past the plaza → alongside the great bridge → rounding the
// spire → cresting over the crown, then it loops until any input.

import * as THREE from "three/webgpu";
import { TH, CELL } from "../config";
import type { Ctx } from "./context";

export class Cinematic {
  active = false;
  private pos: THREE.CatmullRomCurve3 | null = null;
  private tgt: THREE.CatmullRomCurve3 | null = null;
  private t0 = 0;
  private readonly dur = 42;
  private lastLook = new THREE.Vector3();

  constructor(private ctx: Ctx) {}

  /** build the path from the CURRENT world and start looping */
  start(t: number): boolean {
    const isl = this.ctx.walk.islands;
    if (isl.length === 0) return false;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = 0;
    for (const i of isl) {
      const h = (i.l.N * CELL) / 2;
      minX = Math.min(minX, i.ox - h); maxX = Math.max(maxX, i.ox + h);
      minZ = Math.min(minZ, i.oz - h); maxZ = Math.max(maxZ, i.oz + h);
      maxY = Math.max(maxY, i.oy);
    }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const half = Math.max(maxX - minX, maxZ - minZ) / 2 + 10;
    const top = maxY + 30;

    // anchors of interest
    const tall = isl.reduce((a, b) => (b.oy > a.oy ? b : a));
    const plazaIsl = isl.find((i) => i.l.medallions.length > 0) ?? isl[0];
    const pm = plazaIsl.l.medallions[0] ?? { ...plazaIsl.l.entrance, tier: 0 };
    const plaza = new THREE.Vector3(
      plazaIsl.ox + (pm.x - (plazaIsl.l.N - 1) / 2) * CELL,
      plazaIsl.oy + (("tier" in pm ? pm.tier : 0) as number) * TH + 2,
      plazaIsl.oz + (pm.y - (plazaIsl.l.N - 1) / 2) * CELL,
    );
    let link = this.ctx.walk.links[0];
    for (const l of this.ctx.walk.links) {
      if (!link || l.a.distanceTo(l.b) > link.a.distanceTo(link.b)) link = l;
    }
    const lm = link ? link.a.clone().lerp(link.b, 0.5) : plaza.clone();
    const ld = link ? link.b.clone().sub(link.a).normalize() : new THREE.Vector3(1, 0, 0);
    const lperp = new THREE.Vector3(-ld.z, 0, ld.x);

    const P = [
      new THREE.Vector3(cx + half * 1.6, top * 0.7 + 30, cz + half * 2.0),
      new THREE.Vector3(cx - half * 0.5, top * 0.3 + 16, cz + half * 1.45),
      plaza.clone().add(new THREE.Vector3(18, 17, 24)),
      lm.clone().add(lperp.clone().multiplyScalar(22)).add(new THREE.Vector3(0, 11, 0)),
      new THREE.Vector3(tall.ox + 36, tall.oy + 28, tall.oz - 32),
      new THREE.Vector3(cx - half * 1.4, top + 44, cz - half * 0.9),
    ];
    const T = [
      new THREE.Vector3(cx, top * 0.35, cz),
      new THREE.Vector3(cx, top * 0.22, cz),
      plaza.clone().add(new THREE.Vector3(0, 4, 0)),
      lm.clone().add(new THREE.Vector3(0, 3, 0)),
      new THREE.Vector3(tall.ox, tall.oy + 12, tall.oz),
      new THREE.Vector3(cx, top * 0.4, cz),
    ];
    this.pos = new THREE.CatmullRomCurve3(P, true, "centripetal");
    this.tgt = new THREE.CatmullRomCurve3(T, true, "centripetal");
    this.t0 = t;
    this.active = true;
    this.ctx.controls.enabled = false;
    this.ctx.controls.autoRotate = false;
    return true;
  }

  /** hand the camera back to orbit, aimed where the shot was looking */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.ctx.controls.target.copy(this.lastLook);
    this.ctx.controls.enabled = true;
  }

  update(t: number): void {
    if (!this.active || !this.pos || !this.tgt) return;
    const u = ((t - this.t0) / this.dur) % 1;
    this.ctx.camera.position.copy(this.pos.getPointAt(u));
    this.lastLook.copy(this.tgt.getPointAt(u));
    this.ctx.camera.lookAt(this.lastLook);
  }
}
