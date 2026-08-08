// Walkability data captured at forge time for the play modes. The ground is
// ANALYTIC everywhere (grid tiers, stair ramps, spiral towers, bridge sag) —
// never a mesh raycast.

import * as THREE from "three/webgpu";
import type { Layout } from "../gen/dungeon";
import { FLOOR } from "../gen/dungeon";
import type { GroundSampler, GroundHit } from "../player/player";
import { TH, CELL, STAIR } from "../config";
import { StairTowers } from "./stairs";
import { spiralHeight } from "./spiral";
import type { WorldBlocker } from "../scene/build";

export interface IslandWalk {
  l: Layout; ox: number; oy: number; oz: number; slot: number;
  stairDir: Map<number, number>;
}
/** `arc` is the SIGNED mid-span lift: stone arch bridges rise (+), the
 *  islands' internal rope bridges still sag (−) */
export interface LinkWalk { a: THREE.Vector3; b: THREE.Vector3; arc: number; width: number }

export class WalkMap {
  readonly islands: IslandWalk[] = [];
  readonly links: LinkWalk[] = [];
  readonly blockers: WorldBlocker[] = [];
  /** Topology-only revision: structural breaches can mutate a shared Layout
   * without starting a full forge/token cycle. */
  revision = 0;

  constructor(readonly stairs: StairTowers) {}

  clear(): void {
    this.islands.length = 0;
    this.links.length = 0;
    this.blockers.length = 0;
    this.revision++;
  }

  touch(): void { this.revision++; }

  addIsland(l: Layout, ox: number, oy: number, oz: number, slot: number): IslandWalk {
    const isl: IslandWalk = {
      l, ox, oy, oz, slot,
      stairDir: new Map(l.stairs.map((s) => [s.y * l.N + s.x, s.dir])),
    };
    this.islands.push(isl);
    // the island's own ravine bridge is walkable too (span along x or z)
    if (l.bridge) {
      const b = l.bridge;
      const at = (b.at - (l.N - 1) / 2) * CELL;
      const c0 = (b.s0 - (l.N - 1) / 2) * CELL + CELL * 0.4;
      const c1 = (b.s1 - (l.N - 1) / 2) * CELL - CELL * 0.4;
      const by = oy + b.tier * TH + 0.1;
      this.addLink(
        b.axis === 0 ? new THREE.Vector3(ox + c0, by, oz + at) : new THREE.Vector3(ox + at, by, oz + c0),
        b.axis === 0 ? new THREE.Vector3(ox + c1, by, oz + at) : new THREE.Vector3(ox + at, by, oz + c1),
        -0.7, 1.5,
      );
    }
    return isl;
  }

  addLink(a: THREE.Vector3, b: THREE.Vector3, arc: number, width = 2.2): void {
    this.links.push({ a, b, arc, width });
  }

  addBlocker(blocker: WorldBlocker): void {
    this.blockers.push(blocker);
  }

  isBlocked(x: number, y: number, z: number): boolean {
    for (const b of this.blockers) {
      if (y < b.y0 - 0.2 || y > b.y1 + 0.2) continue;
      if (Math.hypot(x - b.x, z - b.z) <= b.radius) return true;
    }
    return false;
  }

  /** stacked layers overlap in xz — candidates are ranked by |y - refY| so the
   *  sampler resolves to whichever floor the player is actually on */
  readonly sample: GroundSampler = (x, z, refY = 0): GroundHit => {
    let best: GroundHit | null = null;
    let bestScore = Infinity;
    if (this.isBlocked(x, refY, z)) return { y: 0, ok: false, solid: true };
    // square spiral staircases: analytic height on the winding flights
    for (const st of this.stairs.towers) {
      const dx = x - st.x, dz = z - st.z;
      const rInf = Math.max(Math.abs(dx), Math.abs(dz));
      if (rInf > st.a + 0.2) continue;
      if (rInf < st.core + 0.05) {
        if (bestScore > 1) { bestScore = 1; best = { y: 0, ok: false, solid: true }; }
        continue;
      }
      const y = spiralHeight(st, dx, dz, refY);
      const score = Math.abs(refY - y);
      if (score < bestScore) { bestScore = score; best = { y, ok: true }; }
    }
    // Horizontal stone landings between each floor gate and the first/last
    // tread. They are first-class walkable surfaces, not decorative bridges.
    for (const st of this.stairs.towers) {
      for (const landing of st.landings) {
        const abx = landing.b.x - landing.a.x, abz = landing.b.z - landing.a.z;
        const len2 = abx * abx + abz * abz;
        if (len2 < 1e-6) continue;
        const t = Math.min(1, Math.max(0, ((x - landing.a.x) * abx + (z - landing.a.z) * abz) / len2));
        const px = landing.a.x + abx * t, pz = landing.a.z + abz * t;
        if (Math.hypot(x - px, z - pz) > landing.width / 2) continue;
        const score = Math.abs(refY - landing.a.y);
        if (score < bestScore) { bestScore = score; best = { y: landing.a.y, ok: true }; }
      }
    }
    for (const isl of this.islands) {
      const { l, ox, oz } = isl;
      const gx = Math.round((x - ox) / CELL + (l.N - 1) / 2);
      const gy = Math.round((z - oz) / CELL + (l.N - 1) / 2);
      if (gx < 0 || gy < 0 || gx >= l.N || gy >= l.N) continue;
      const c = gy * l.N + gx;
      if (l.kind[c] === 2) {
        const score = Math.abs(refY - isl.oy) + 2; // walls score by layer proximity
        if (score < bestScore) { bestScore = score; best = { y: 0, ok: false, solid: true }; }
        continue;
      }
      if (l.kind[c] !== FLOOR) continue;
      let y = l.tier[c] * TH + 0.16 + isl.oy;
      const sd = isl.stairDir.get(c);
      if (sd !== undefined) {
        const cx = ox + (gx - (l.N - 1) / 2) * CELL;
        const cz = oz + (gy - (l.N - 1) / 2) * CELL;
        const fx = [1, -1, 0, 0][sd], fz = [0, 0, 1, -1][sd];
        const t = Math.min(1, Math.max(0, ((x - cx) * fx + (z - cz) * fz) / CELL + 0.5));
        y += t * TH;
      }
      const score = Math.abs(refY - y);
      if (score < bestScore) { bestScore = score; best = { y, ok: true }; }
    }
    // Evaluate authored crossing decks even when their broad, short seam
    // overlaps the boundary wall's rounded grid cell. Returning the wall first
    // made the first/last quarter of an intra-district causeway render as a
    // floor but sample as solid. Height ranking still lets a genuinely nearer
    // stacked floor win.
    for (const lk of this.links) {
      const abx = lk.b.x - lk.a.x, abz = lk.b.z - lk.a.z;
      const len2 = abx * abx + abz * abz;
      const t = ((x - lk.a.x) * abx + (z - lk.a.z) * abz) / len2;
      if (t < 0 || t > 1) continue;
      const px = lk.a.x + abx * t, pz = lk.a.z + abz * t;
      if (Math.hypot(x - px, z - pz) > lk.width / 2) continue;
      const y = lk.a.y + (lk.b.y - lk.a.y) * t + Math.sin(t * Math.PI) * lk.arc + 0.05;
      const score = Math.abs(refY - y);
      if (score < bestScore) { bestScore = score; best = { y, ok: true }; }
    }
    return best ?? { y: 0, ok: false };
  };
}
