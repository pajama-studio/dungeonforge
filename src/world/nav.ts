// The navigation system. This world's "navmesh" is EXACT, not approximated:
// the walkable surface is already a grid (island floor cells), so the mesh is
// the cell graph itself — nodes are (island, cell), intra-island edges are
// Δtier ≤ 1 neighbor moves, and PORTALS stitch islands together (rope-bridge
// crossings and spiral stair towers). Everything that navigates — the route
// overlay, the skeleton walker, future NPCs — queries this one structure.
//
// NavOverlay draws it: a translucent quad per walkable cell (cyan), stair
// cells in amber, portal cells (bridge gates / stair feet) in magenta.

import * as THREE from "three/webgpu";
import { FLOOR, DX, DY } from "../gen/dungeon";
import { TH, CELL } from "../config";
import type { Ctx } from "./context";
import type { IslandWalk, LinkWalk } from "./walkmap";
import type { StairTower } from "./stairs";
import { getKit } from "../scene/kit";
import { stairXZAtHeight } from "./spiral";

export const NAV_K = 1 << 20; // key = islandIndex * NAV_K + cellIndex

/** Points are appended while BFS is backtracking goal → source, then the
 *  whole list is reversed. Direction-aware fractions prevent reverse bridge
 *  traversals from becoming a self-intersecting 0→.75→.5→.25→1 loop. */
export const bridgeBacktrackFractions = (forward: boolean): readonly number[] =>
  forward ? [0.75, 0.5, 0.25] : [0.25, 0.5, 0.75];

export interface NavPortal {
  to: number;
  kind: "link" | "stair";
  link?: LinkWalk;
  tower?: StairTower;
  up?: boolean;
  /** orientation of LinkWalk.a → LinkWalk.b for this directed portal */
  forward?: boolean;
}

export interface NavBfs {
  dist: Map<number, number>;
  prev: Map<number, { k: number; via?: NavPortal }>;
}

export class NavMesh {
  portals = new Map<number, NavPortal[]>();
  /** island-level adjacency derived from the portals */
  adj: Array<Set<number>> = [];
  private builtSignature = "";

  constructor(private ctx: Ctx) {}

  private get islands(): IslandWalk[] { return this.ctx.walk.islands; }

  /** (re)build the graph when the world changed */
  ensure(): boolean {
    const islands = this.islands;
    if (islands.length === 0) return false;
    // Large modes are paced over many frames. A user can open the route while
    // islands exist but before every bridge/stair/blocker has been appended;
    // token-only caching would then freeze that incomplete portal graph for
    // the rest of the forge. Counts form a cheap live topology revision.
    const signature = [
      this.ctx.state.token, islands.length, this.ctx.walk.links.length,
      this.ctx.stairs.towers.length, this.ctx.walk.blockers.length, this.ctx.walk.revision,
    ].join(":");
    if (this.builtSignature === signature) return true;
    this.portals.clear();
    this.adj = islands.map(() => new Set<number>());
    const add = (from: number, p: NavPortal) => {
      const arr = this.portals.get(from) ?? [];
      arr.push(p);
      this.portals.set(from, arr);
      this.adj[Math.floor(from / NAV_K)].add(Math.floor(p.to / NAV_K));
    };
    for (const link of this.ctx.walk.links) {
      const a = this.locate(link.a.x, link.a.y, link.a.z);
      const b = this.locate(link.b.x, link.b.y, link.b.z);
      if (a === null || b === null || a === b) continue;
      add(a, { to: b, kind: "link", link, forward: true });
      add(b, { to: a, kind: "link", link, forward: false });
    }
    for (const tw of this.ctx.stairs.towers) {
      const lo = this.locate(tw.lowerDock.x, tw.lowerDock.y, tw.lowerDock.z);
      const hi = this.locate(tw.upperDock.x, tw.upperDock.y, tw.upperDock.z);
      if (lo === null || hi === null || lo === hi) continue;
      add(lo, { to: hi, kind: "stair", tower: tw, up: true });
      add(hi, { to: lo, kind: "stair", tower: tw, up: false });
    }
    this.builtSignature = signature;
    return true;
  }

  /** map a world point onto (island, cell) — nearest floor by height. Bridge
   *  endpoints sit just OUTSIDE the gate cell, so search a 3×3 neighborhood. */
  locate(x: number, y: number, z: number): number | null {
    const isl = this.islands;
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
        const floorY = w.oy + w.l.tier[c] * TH + 0.16;
        if (this.ctx.walk.isBlocked(
          w.ox + (gx - (N - 1) / 2) * CELL,
          floorY + 0.39,
          w.oz + (gy - (N - 1) / 2) * CELL,
        )) continue;
        const yDiff = Math.abs(floorY - y);
        if (yDiff > 3.2) continue;
        const score = yDiff + (Math.abs(dx2) + Math.abs(dy2)) * 0.4;
        if (score < bestScore) { bestScore = score; best = i * NAV_K + c; }
      }
    }
    return best;
  }

  /** a photogenic representative cell for an island: plaza → temple forecourt → entrance */
  repCell(i: number): number | null {
    const l = this.islands[i].l, N = l.N;
    const cand: Array<[number, number]> = [];
    if (l.medallions[0]) cand.push([l.medallions[0].x, l.medallions[0].y]);
    if (l.door) cand.push([l.door.x + DX[l.doorDir], l.door.y + DY[l.doorDir]]);
    cand.push([l.entrance.x, l.entrance.y]);
    for (const [x, y] of cand) {
      const c = y * N + x;
      if (x >= 0 && y >= 0 && x < N && y < N && l.kind[c] === FLOOR && !this.isBlockedCell(i, c)) return i * NAV_K + c;
    }
    for (let c = 0; c < N * N; c++) if (l.kind[c] === FLOOR && !this.isBlockedCell(i, c)) return i * NAV_K + c;
    return null;
  }

  spawnKey(): number | null {
    return this.islands.length ? this.repCell(0) : null;
  }

  cellPoint(key: number): THREE.Vector3 {
    const isl = this.islands[Math.floor(key / NAV_K)];
    const c = key % NAV_K, N = isl.l.N;
    return new THREE.Vector3(
      isl.ox + (c % N - (N - 1) / 2) * CELL,
      isl.oy + isl.l.tier[c] * TH + 0.55,
      isl.oz + (Math.floor(c / N) - (N - 1) / 2) * CELL,
    );
  }

  isBlockedCell(islandIndex: number, c: number): boolean {
    const isl = this.islands[islandIndex], N = isl.l.N;
    return this.ctx.walk.isBlocked(
      isl.ox + (c % N - (N - 1) / 2) * CELL,
      isl.oy + isl.l.tier[c] * TH + 0.55,
      isl.oz + (Math.floor(c / N) - (N - 1) / 2) * CELL,
    );
  }

  /** breadth-first search from `start`; stops early when `stopAt` is settled */
  bfs(start: number, stopAt?: number): NavBfs {
    const islands = this.islands;
    const dist = new Map<number, number>();
    const prev = new Map<number, { k: number; via?: NavPortal }>();
    dist.set(start, 0);
    const q: number[] = [start];
    for (let h = 0; h < q.length; h++) {
      const k = q[h];
      if (k === stopAt) break;
      const d = dist.get(k)!;
      const iIdx = Math.floor(k / NAV_K), c = k % NAV_K;
      const w = islands[iIdx], N = w.l.N;
      const x = c % N, y = Math.floor(c / N);
      for (let dd = 0; dd < 4; dd++) {
        const nx = x + DX[dd], ny = y + DY[dd];
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const nc = ny * N + nx;
        if (w.l.kind[nc] !== FLOOR || this.isBlockedCell(iIdx, nc) || Math.abs(w.l.tier[nc] - w.l.tier[c]) > 1) continue;
        const nk = iIdx * NAV_K + nc;
        if (!dist.has(nk)) { dist.set(nk, d + 1); prev.set(nk, { k }); q.push(nk); }
      }
      for (const p of this.portals.get(k) ?? []) {
        if (!dist.has(p.to)) { dist.set(p.to, d + 8); prev.set(p.to, { k, via: p }); q.push(p.to); }
      }
    }
    return { dist, prev };
  }

  /** reconstruct start→goal as world points, with bridge sag and stair helix */
  tracePoints(prev: NavBfs["prev"], goal: number): THREE.Vector3[] {
    const pts: THREE.Vector3[] = [];
    let cur: number | undefined = goal;
    while (cur !== undefined) {
      pts.push(this.cellPoint(cur));
      const step: { k: number; via?: NavPortal } | undefined = prev.get(cur);
      if (step?.via) {
        const via = step.via;
        if (via.kind === "link" && via.link) {
          const { a, b, arc } = via.link;
          const samples = bridgeBacktrackFractions(via.forward !== false);
          for (const tt of samples) {
            const p = a.clone().lerp(b, tt);
            p.y += Math.sin(tt * Math.PI) * arc + 0.45;
            pts.push(p);
          }
        } else if (via.kind === "stair" && via.tower) {
          const tw = via.tower;
          const fromDock = via.up ? tw.upperDock : tw.lowerDock;
          const fromStep = via.up ? tw.upperStep : tw.lowerStep;
          const toStep = via.up ? tw.lowerStep : tw.upperStep;
          const toDock = via.up ? tw.lowerDock : tw.upperDock;
          pts.push(new THREE.Vector3(fromDock.x, fromDock.y + 0.4, fromDock.z));
          pts.push(new THREE.Vector3(fromStep.x, fromStep.y + 0.4, fromStep.z));
          const from = via.up ? tw.y1 : tw.y0;
          const to = via.up ? tw.y0 : tw.y1;
          // dense sampling: the tour curve smooths these points, and sparse
          // helix knots would get pulled inward through the tower core
          const stepY = 0.45 * Math.sign(to - from);
          for (let h = from; Math.sign(to - h) === Math.sign(stepY) && Math.abs(to - h) > 0.4; h += stepY) {
            const p = stairXZAtHeight(tw, h);
            pts.push(new THREE.Vector3(tw.x + p.x, h + 0.4, tw.z + p.z));
          }
          pts.push(new THREE.Vector3(toStep.x, toStep.y + 0.4, toStep.z));
          pts.push(new THREE.Vector3(toDock.x, toDock.y + 0.4, toDock.z));
        }
      }
      cur = step?.k;
    }
    pts.reverse();
    return pts;
  }

  /** island-hop BFS distances over the adjacency graph */
  private islandBFS(src: number): number[] {
    const d = new Array<number>(this.islands.length).fill(-1);
    d[src] = 0;
    const q = [src];
    for (let h = 0; h < q.length; h++) {
      for (const j of this.adj[q[h]]) if (d[j] < 0) { d[j] = d[q[h]] + 1; q.push(j); }
    }
    return d;
  }

  /** the GRAND TOUR: visit EVERY reachable block and CLIMB to the summit
   *  last. The finale B is the HIGHEST block — spire layers chain one below
   *  the next, so the closing legs are the ascent itself and the top is only
   *  reached by climbing everything beneath it. The start A is the block
   *  farthest from the summit by hops (leftmost on ties); side branches are
   *  cleared along the way (DFS pre-order, the branch toward B deferred
   *  last), consecutive targets joined by shortest paths. */
  tour(): { pts: THREE.Vector3[]; unreachable: number[] } | null {
    if (!this.ensure()) return null;
    const islands = this.islands;
    let B = 0;
    for (let i = 0; i < islands.length; i++) if (islands[i].oy > islands[B].oy) B = i;
    const dB = this.islandBFS(B);
    let A = B;
    for (let i = 0; i < dB.length; i++) {
      if (dB[i] > dB[A] || (dB[i] === dB[A] && islands[i].ox < islands[A].ox)) A = i;
    }
    const order: number[] = [];
    const seen = new Set<number>([A]);
    const stack = [A];
    while (stack.length > 0) {
      const i = stack.pop()!;
      order.push(i);
      // pushed FIRST = explored LAST: the child nearest B sinks to the bottom
      // of the stack, so the tour drains every side branch before the finale
      const kids = [...this.adj[i]].filter((j) => !seen.has(j))
        .sort((a2, b2) => (dB[a2] - dB[b2]) || (b2 - a2));
      for (const j of kids) { seen.add(j); stack.push(j); }
    }
    // cycles can surface B early — force it to stay the closing target
    const bAt = order.indexOf(B);
    if (bAt >= 0 && bAt !== order.length - 1) { order.splice(bAt, 1); order.push(B); }
    const unreachable = islands.map((_, i) => i).filter((i) => !seen.has(i));
    if (unreachable.length > 0) {
      console.warn(`[nav] UNREACHABLE islands: ${unreachable.join(", ")} — repairs should have prevented this`);
    }
    let cur = this.repCell(A);
    if (cur === null) return null;
    const all: THREE.Vector3[] = [];
    for (const iIsl of order) {
      const target = this.repCell(iIsl);
      if (target === null || target === cur) continue;
      const { dist, prev } = this.bfs(cur, target);
      if (!dist.has(target)) continue;
      const leg = this.tracePoints(prev, target);
      if (all.length > 0) leg.shift(); // joint point is shared with the last leg
      all.push(...leg);
      cur = target;
    }
    return all.length >= 2 ? { pts: all, unreachable } : null;
  }
}

// ---------------------------------------------------------------------------
// NavOverlay — draw the navmesh itself.
// ---------------------------------------------------------------------------

export class NavOverlay {
  private mesh: THREE.InstancedMesh | null = null;
  private shownToken = -1;
  private shownRevision = -1;
  visible = false;

  constructor(private ctx: Ctx, private nav: NavMesh) {}

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  show(): void {
    if (this.visible || !this.nav.ensure()) return;
    const islands = this.ctx.walk.islands;
    const R = getKit();
    // portal cells glow magenta: collect every key that anchors a crossing
    const portalCells = new Set<number>();
    for (const [k, ps] of this.nav.portals) {
      portalCells.add(k);
      for (const p of ps) portalCells.add(p.to);
    }
    let total = 0;
    for (const w of islands) total += w.l.stats.floor;
    const mesh = new THREE.InstancedMesh(R.navCellGeo, R.navMat, total);
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    let n = 0;
    for (let i = 0; i < islands.length; i++) {
      const w = islands[i], N = w.l.N;
      for (let c = 0; c < N * N; c++) {
        if (w.l.kind[c] !== FLOOR || this.nav.isBlockedCell(i, c)) continue;
        m.makeTranslation(
          w.ox + (c % N - (N - 1) / 2) * CELL,
          w.oy + w.l.tier[c] * TH + 0.24,
          w.oz + (Math.floor(c / N) - (N - 1) / 2) * CELL,
        );
        mesh.setMatrixAt(n, m);
        if (portalCells.has(i * NAV_K + c)) col.setHex(0xff4fd8);      // crossing anchor
        else if (w.l.stairMask[c]) col.setHex(0xffb347);               // stair ramp
        else col.setHex(0x3fd9de);                                     // plain walkable
        mesh.setColorAt(n, col);
        n++;
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    this.mesh = mesh;
    this.ctx.scene.add(mesh);
    this.shownToken = this.ctx.state.token;
    this.shownRevision = this.ctx.walk.revision;
    this.visible = true;
  }

  hide(): void {
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.dispose();
      this.mesh = null;
    }
    this.visible = false;
  }

  tick(): void {
    if (this.visible && (
      this.ctx.state.token !== this.shownToken || this.ctx.walk.revision !== this.shownRevision
    )) this.hide();
  }
}
