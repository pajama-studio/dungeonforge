// The Route — a full 3D breadth-first search over everything walkable:
// per-island floor grids (Δtier ≤ 1 moves), rope-bridge crossings, and the
// spiral stair towers between layers. It proves the whole map is reachable
// from the spawn, picks the FARTHEST island as the goal, and draws the path
// as a glowing tube (dashes march toward the goal; stairs render as a helix).

import * as THREE from "three/webgpu";
import { FLOOR, DX, DY } from "../gen/dungeon";
import { TH, CELL, STAIR } from "../config";
import type { Ctx } from "./context";
import type { IslandWalk, LinkWalk } from "./walkmap";
import type { StairTower } from "./stairs";
import { getKit } from "../scene/kit";

const K = 1 << 20; // key = islandIndex * K + cellIndex

interface Portal {
  to: number; // target key
  kind: "link" | "stair";
  link?: LinkWalk;
  tower?: StairTower;
  up?: boolean; // stair direction of travel
}

export class RoutePath {
  private mesh: THREE.Mesh | null = null;
  private geo: THREE.BufferGeometry | null = null;
  private shownToken = -1;
  private curve: THREE.CatmullRomCurve3 | null = null;
  private curveLen = 0;
  private curveToken = -1;
  visible = false;

  constructor(private ctx: Ctx) {}

  /** compute (or reuse) the route curve for the current world */
  ensure(): { curve: THREE.CatmullRomCurve3; length: number; points: number } | null {
    if (this.curveToken !== this.ctx.state.token || !this.curve) {
      const pts = this.compute();
      if (!pts || pts.length < 2) return null;
      this.curve = new THREE.CatmullRomCurve3(pts, false, "centripetal", 0.35);
      this.curveLen = this.curve.getLength();
      this.curveToken = this.ctx.state.token;
    }
    return { curve: this.curve, length: this.curveLen, points: this.curve.points.length };
  }

  show(): void {
    if (this.visible) return;
    const rc = this.ensure();
    if (!rc) return;
    this.geo = new THREE.TubeGeometry(rc.curve, Math.min(1600, rc.points * 2), 0.14, 5);
    this.mesh = new THREE.Mesh(this.geo, getKit().routeMat);
    this.mesh.frustumCulled = false;
    this.ctx.scene.add(this.mesh);
    this.shownToken = this.ctx.state.token;
    this.visible = true;
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  hide(): void {
    if (this.mesh) { this.mesh.removeFromParent(); this.mesh = null; }
    this.geo?.dispose();
    this.geo = null;
    this.visible = false;
  }

  /** a re-forge invalidates the drawn route */
  tick(): void {
    if (this.visible && this.ctx.state.token !== this.shownToken) this.hide();
  }

  /** map a world point onto (island, cell) — nearest floor by height. Bridge
   *  endpoints sit just OUTSIDE the gate cell, so the rounded cell can land
   *  off-grid or on the wall: search the 3×3 neighborhood and keep the best. */
  private locate(x: number, y: number, z: number): number | null {
    const isl = this.ctx.walk.islands;
    let best: number | null = null, bestScore = Infinity;
    for (let i = 0; i < isl.length; i++) {
      const w = isl[i], N = w.l.N;
      const gx0 = Math.round((x - w.ox) / CELL + (N - 1) / 2);
      const gy0 = Math.round((z - w.oz) / CELL + (N - 1) / 2);
      for (let dy2 = -1; dy2 <= 1; dy2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
        const gx = gx0 + dx2, gy = gy0 + dy2;
        if (gx < 0 || gy < 0 || gx >= N || gy >= N) continue;
        const c = gy * N + gx;
        if (w.l.kind[c] !== FLOOR) continue;
        const yDiff = Math.abs(w.oy + w.l.tier[c] * TH + 0.16 - y);
        if (yDiff > 3.2) continue;
        const score = yDiff + (Math.abs(dx2) + Math.abs(dy2)) * 0.4;
        if (score < bestScore) { bestScore = score; best = i * K + c; }
      }
    }
    return best;
  }

  private cellPoint(isl: IslandWalk, c: number): THREE.Vector3 {
    const N = isl.l.N;
    return new THREE.Vector3(
      isl.ox + (c % N - (N - 1) / 2) * CELL,
      isl.oy + isl.l.tier[c] * TH + 0.55,
      isl.oz + (Math.floor(c / N) - (N - 1) / 2) * CELL,
    );
  }

  /** BFS over the whole walkable world; returns the path polyline, or null */
  private compute(): THREE.Vector3[] | null {
    const { walk, stairs } = this.ctx;
    const islands = walk.islands;
    if (islands.length === 0) return null;

    // portals: bridge endpoints and stair tower feet/heads mapped onto cells
    const portals = new Map<number, Portal[]>();
    const addPortal = (from: number, p: Portal) => {
      const arr = portals.get(from) ?? [];
      arr.push(p);
      portals.set(from, arr);
    };
    for (const link of walk.links) {
      const a = this.locate(link.a.x, link.a.y, link.a.z);
      const b = this.locate(link.b.x, link.b.y, link.b.z);
      if (a === null || b === null || a === b) continue;
      addPortal(a, { to: b, kind: "link", link });
      addPortal(b, { to: a, kind: "link", link });
    }
    for (const tw of stairs.towers) {
      const lo = this.locate(tw.x, tw.y0, tw.z);
      const hi = this.locate(tw.x, tw.y1, tw.z);
      if (lo === null || hi === null || lo === hi) continue;
      addPortal(lo, { to: hi, kind: "stair", tower: tw, up: true });
      addPortal(hi, { to: lo, kind: "stair", tower: tw, up: false });
    }

    // spawn = island 0's plaza (same as ⚔ Enter)
    const l0 = islands[0];
    const sc = l0.l.medallions[0] ?? l0.l.entrance;
    const start = this.locate(
      l0.ox + (sc.x - (l0.l.N - 1) / 2) * CELL,
      l0.oy + (l0.l.medallions[0]?.tier ?? 0) * TH + 0.16,
      l0.oz + (sc.y - (l0.l.N - 1) / 2) * CELL,
    );
    if (start === null) return null;

    const dist = new Map<number, number>();
    const prev = new Map<number, { k: number; via?: Portal }>();
    dist.set(start, 0);
    const q: number[] = [start];
    for (let h = 0; h < q.length; h++) {
      const k = q[h];
      const d = dist.get(k)!;
      const iIdx = Math.floor(k / K), c = k % K;
      const w = islands[iIdx], N = w.l.N;
      const x = c % N, y = Math.floor(c / N);
      for (let dd = 0; dd < 4; dd++) {
        const nx = x + DX[dd], ny = y + DY[dd];
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const nc = ny * N + nx;
        if (w.l.kind[nc] !== FLOOR || Math.abs(w.l.tier[nc] - w.l.tier[c]) > 1) continue;
        const nk = iIdx * K + nc;
        if (!dist.has(nk)) { dist.set(nk, d + 1); prev.set(nk, { k }); q.push(nk); }
      }
      for (const p of portals.get(k) ?? []) {
        if (!dist.has(p.to)) { dist.set(p.to, d + 8); prev.set(p.to, { k, via: p }); q.push(p.to); }
      }
    }

    // reachability report + goal: the island whose closest cell is farthest
    let goalIsl = -1, goalIslDist = -1;
    const unreachable: number[] = [];
    for (let i = 0; i < islands.length; i++) {
      const N = islands[i].l.N;
      let min = Infinity;
      for (let c = 0; c < N * N; c++) {
        if (islands[i].l.kind[c] !== FLOOR) continue;
        const d = dist.get(i * K + c);
        if (d !== undefined && d < min) min = d;
      }
      if (min === Infinity) { unreachable.push(i); continue; }
      if (min > goalIslDist) { goalIslDist = min; goalIsl = i; }
    }
    if (unreachable.length > 0) {
      console.warn(`[route] UNREACHABLE islands: ${unreachable.join(", ")} — repairs should have prevented this`);
    }
    if (goalIsl < 0) return null;

    // goal cell: the temple forecourt if the island has one, else its deepest cell
    const gw = islands[goalIsl];
    let goal: number | null = null;
    if (gw.l.door) {
      const fx = DX[gw.l.doorDir], fz = DY[gw.l.doorDir];
      const c = (gw.l.door.y + fz) * gw.l.N + (gw.l.door.x + fx);
      if (dist.has(goalIsl * K + c)) goal = goalIsl * K + c;
    }
    if (goal === null) {
      let best = -1;
      for (const [k, d] of dist) {
        if (Math.floor(k / K) === goalIsl && d > best) { best = d; goal = k; }
      }
    }
    if (goal === null) return null;

    // reconstruct goal→start, emitting curve points (reversed at the end)
    const pts: THREE.Vector3[] = [];
    let cur: number | undefined = goal;
    while (cur !== undefined) {
      const iIdx = Math.floor(cur / K);
      pts.push(this.cellPoint(islands[iIdx], cur % K));
      const step: { k: number; via?: Portal } | undefined = prev.get(cur);
      if (step?.via) {
        const via = step.via;
        if (via.kind === "link" && via.link) {
          // sagging bridge midpoints (walking goal→start here, so t descends)
          const { a, b, sag } = via.link;
          for (const tt of [0.75, 0.5, 0.25]) {
            const p = a.clone().lerp(b, tt);
            p.y -= Math.sin(tt * Math.PI) * sag - 0.45;
            pts.push(p);
          }
        } else if (via.kind === "stair" && via.tower) {
          // helix down/up the spiral: perimeter position from height
          const tw = via.tower;
          const m = STAIR.M, P = 8 * m, slope = STAIR.RISE / STAIR.STEP;
          const sToXZ = (s: number): [number, number] => {
            const side = Math.floor((s % P) / (2 * m)), u = (s % P) - side * 2 * m - m;
            if (side === 0) return [u, -m];
            if (side === 1) return [m, u];
            if (side === 2) return [-u, m];
            return [-m, -u];
          };
          // emit from the cell we're LEAVING (higher when via.up, since we
          // walk the chain backwards) down/up to the other end
          const from = via.up ? tw.y1 : tw.y0;
          const to = via.up ? tw.y0 : tw.y1;
          const stepY = 0.8 * Math.sign(to - from);
          for (let h = from; Math.sign(to - h) === Math.sign(stepY) && Math.abs(to - h) > 0.4; h += stepY) {
            const [dx, dz] = sToXZ(Math.max(0, (h - tw.y0) / slope));
            pts.push(new THREE.Vector3(tw.x + dx, h + 0.4, tw.z + dz));
          }
        }
      }
      cur = step?.k;
    }
    pts.reverse();
    return pts;
  }
}
