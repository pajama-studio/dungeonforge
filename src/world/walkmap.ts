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

export interface IslandWalk {
  l: Layout; ox: number; oy: number; oz: number; slot: number;
  stairDir: Map<number, number>;
}
export interface LinkWalk { a: THREE.Vector3; b: THREE.Vector3; sag: number }

export class WalkMap {
  readonly islands: IslandWalk[] = [];
  readonly links: LinkWalk[] = [];

  constructor(readonly stairs: StairTowers) {}

  clear(): void {
    this.islands.length = 0;
    this.links.length = 0;
  }

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
        0.7,
      );
    }
    return isl;
  }

  addLink(a: THREE.Vector3, b: THREE.Vector3, sag: number): void {
    this.links.push({ a, b, sag });
  }

  /** stacked layers overlap in xz — candidates are ranked by |y - refY| so the
   *  sampler resolves to whichever floor the player is actually on */
  readonly sample: GroundSampler = (x, z, refY = 0): GroundHit => {
    let best: GroundHit | null = null;
    let bestScore = Infinity;
    // square spiral staircases: analytic height on the winding flights
    for (const st of this.stairs.towers) {
      const dx = x - st.x, dz = z - st.z;
      const rInf = Math.max(Math.abs(dx), Math.abs(dz));
      if (rInf > STAIR.A + 0.2) continue;
      if (rInf < STAIR.CORE + 0.05) {
        if (bestScore > 1) { bestScore = 1; best = { y: 0, ok: false, solid: true }; }
        continue;
      }
      const y = spiralHeight(st, dx, dz, refY);
      const score = Math.abs(refY - y);
      if (score < bestScore) { bestScore = score; best = { y, ok: true }; }
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
    if (best) return best;
    for (const lk of this.links) {
      const abx = lk.b.x - lk.a.x, abz = lk.b.z - lk.a.z;
      const len2 = abx * abx + abz * abz;
      const t = ((x - lk.a.x) * abx + (z - lk.a.z) * abz) / len2;
      if (t < 0 || t > 1) continue;
      const px = lk.a.x + abx * t, pz = lk.a.z + abz * t;
      if (Math.hypot(x - px, z - pz) > 1.1) continue;
      return { y: lk.a.y + (lk.b.y - lk.a.y) * t - Math.sin(t * Math.PI) * lk.sag + 0.05, ok: true };
    }
    return { y: 0, ok: false };
  };
}
