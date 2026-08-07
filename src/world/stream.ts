// Endless streaming mode. A 3×3 macro-cell window follows the camera/player.
// Blocks derive from hash(seed, mi, mj) so the infinite world is consistent;
// edge hashes decide where neighbors agree to open gates (each side carves the
// nearest fit — a slightly diagonal bridge just means the masons disagreed).
// Slot pools make roaming cheap: after the first nine cells, no render object
// is ever created.

import type * as THREE from "three/webgpu";
import type { Layout } from "../gen/dungeon";
import { buildWorld, buildBridgeLink, type WorldHandle, type LightSpec } from "../scene/build";
import { pruneSlots } from "../scene/slots";
import { CELL, ISLAND_GAP, linkArc } from "../config";
import type { Ctx } from "./context";
import { gateWorld, nextFrame } from "./helpers";

interface StreamCell {
  key: string; mi: number; mj: number; slot: number; l: Layout;
  ox: number; oy: number; oz: number; handle: WorldHandle;
}

export class EndlessWorld {
  private cells = new Map<string, StreamCell>();
  private pending = new Set<string>();
  private freeSlots: number[] = [];
  private nextSlot = 10;
  private edgeSlotMap = new Map<string, number>();
  /** live bridge handles — rebuilding an unchanged bridge every refresh would
   *  rewrite its instances for nothing AND replay its forge-rise animation */
  private edgeHandles = new Map<string, WorldHandle>();
  private freeEdgeSlots: number[] = [];
  private nextEdgeSlot = 2000;
  private timer = -10;
  /** one island build per frame — see ensureCell */
  private buildChain: Promise<void> = Promise.resolve();

  constructor(private ctx: Ctx) {}

  /** drop all streaming state (window contents regenerate on the next update) */
  reset(): void {
    this.cells.clear();
    this.pending.clear();
    this.freeSlots.length = 0;
    this.edgeSlotMap.clear();
    this.edgeHandles.clear();
    this.freeEdgeSlots.length = 0;
    this.timer = -10;
  }

  private eh32(a: number, b: number, salt: number): number {
    return (Math.imul(this.ctx.state.seed ^ Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663), 0x9e3779b1 ^ salt)) >>> 0;
  }
  private size(): number {
    return Math.min(11, Math.max(9, Math.round(this.ctx.genParams.size))) | 1; // 9 live blocks — keep them lean
  }
  pitch(): number {
    return (2 * this.size() + 1) * CELL + ISLAND_GAP;
  }
  private edgeInfo(mi: number, mj: number, horiz: boolean): { has: boolean; row: number } {
    const N = 2 * this.size() + 1;
    const h = this.eh32(mi * 2 + (horiz ? 0 : 1), mj * 2 + (horiz ? 1 : 0), 0x5eed);
    return { has: h % 100 < 72, row: 3 + ((h >>> 8) % (N - 6)) };
  }

  private async ensureCell(mi: number, mj: number): Promise<void> {
    const key = `${mi},${mj}`;
    if (this.cells.has(key) || this.pending.has(key)) return;
    this.pending.add(key);
    const { ctx } = this;
    const size = this.size();
    const gateSides: number[] = [];
    const gateRows: number[] = [];
    const edges = [
      { e: this.edgeInfo(mi, mj, true), side: 0 },
      { e: this.edgeInfo(mi - 1, mj, true), side: 1 },
      { e: this.edgeInfo(mi, mj, false), side: 2 },
      { e: this.edgeInfo(mi, mj - 1, false), side: 3 },
    ];
    for (const { e, side } of edges) if (e.has) { gateSides.push(side); gateRows.push(e.row); }
    const l = await ctx.gen.generate(this.eh32(mi, mj, 0x11) || 1, ctx.genParams, {
      gateSides, gateRows, size,
      rot: this.eh32(mi, mj, 0x44) % 4,
      templeOn: this.eh32(mi, mj, 0x55) % 100 < 65,
      ravineOn: this.eh32(mi, mj, 0x66) % 100 < 75,
      mound: mi === 0 && mj === 0 ? ctx.genParams.mound : ctx.genParams.mound * 0.45,
      plazas: this.eh32(mi, mj, 0x33) % 3 === 0 ? 2 : 1,
    });
    this.pending.delete(key);
    if (!ctx.state.endless) return;
    // serialize builds one per frame: when the camera crosses a corner, three
    // workers can resolve together and would stack three island builds (plus
    // three shadow bakes) into a single frame
    this.buildChain = this.buildChain.then(() => nextFrame());
    await this.buildChain;
    if (!ctx.state.endless) return;
    const slot = this.freeSlots.pop() ?? this.nextSlot++;
    const pitch = this.pitch();
    const ox = mi * pitch, oz = mj * pitch;
    const oy = ((this.eh32(mi, mj, 0x22) % 1000) / 1000 - 0.5) * 5.2;
    const w = buildWorld(l, slot, ctx.scene);
    w.group.position.set(ox, oy, oz);
    this.cells.set(key, { key, mi, mj, slot, l, ox, oy, oz, handle: w });
    this.refresh();
  }

  /** rebuild the live world set (handles, walk data, lights, inter-cell bridges) */
  private refresh(): void {
    const { ctx } = this;
    ctx.worlds.length = 0;
    ctx.walk.clear();
    const allLights: LightSpec[] = [];
    const activeSlots = new Set<number>();
    for (const cell of this.cells.values()) {
      activeSlots.add(cell.slot);
      ctx.worlds.push(cell.handle);
      ctx.walk.addIsland(cell.l, cell.ox, cell.oy, cell.oz, cell.slot);
      for (const ls of cell.handle.lights) allLights.push({ ...ls, x: ls.x + cell.ox, y: ls.y + cell.oy, z: ls.z + cell.oz });
    }
    // inter-cell bridges for every present pair that agreed on a gate
    const activeEdges = new Set<string>();
    for (const cell of this.cells.values()) {
      for (const [dmi, dmj, horiz, dir] of [[1, 0, true, 0], [0, 1, false, 2]] as const) {
        const nb = this.cells.get(`${cell.mi + dmi},${cell.mj + dmj}`);
        if (!nb || !this.edgeInfo(cell.mi, cell.mj, horiz).has) continue;
        const from = gateWorld(cell.l, cell, dir);
        const to = gateWorld(nb.l, nb, dir ^ 1);
        if (!from || !to) continue;
        const eKey = `${horiz ? "h" : "v"}${cell.mi},${cell.mj}`;
        let slot = this.edgeSlotMap.get(eKey);
        if (slot === undefined) {
          slot = this.freeEdgeSlots.pop() ?? this.nextEdgeSlot++;
          this.edgeSlotMap.set(eKey, slot);
        }
        activeEdges.add(eKey);
        activeSlots.add(slot);
        let h = this.edgeHandles.get(eKey);
        if (!h) {
          h = buildBridgeLink(from, to, slot, ctx.scene);
          this.edgeHandles.set(eKey, h);
        }
        ctx.worlds.push(h);
        ctx.walk.addLink(from.clone(), to.clone(), linkArc(from.distanceTo(to)));
      }
    }
    for (const [k, slot] of this.edgeSlotMap) {
      if (!activeEdges.has(k)) {
        this.edgeSlotMap.delete(k);
        this.edgeHandles.delete(k);
        this.freeEdgeSlots.push(slot);
      }
    }
    pruneSlots(activeSlots);
    ctx.lights.assign(allLights);
    ctx.env.bakeShadows();
  }

  /** self-throttled: refills the 3×3 window around the focus, evicts the rest */
  update(t: number, focus: THREE.Vector3): void {
    if (!this.ctx.state.endless) return;
    if (t - this.timer < 0.4) return;
    this.timer = t;
    const pitch = this.pitch();
    const fi = Math.round(focus.x / pitch), fj = Math.round(focus.z / pitch);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) void this.ensureCell(fi + di, fj + dj);
    let evicted = false;
    for (const cell of [...this.cells.values()]) {
      if (Math.max(Math.abs(cell.mi - fi), Math.abs(cell.mj - fj)) > 1) {
        this.cells.delete(cell.key);
        this.freeSlots.push(cell.slot);
        evicted = true;
      }
    }
    if (evicted) this.refresh();
    this.ctx.env.fit(pitch * 1.7, fi * pitch, fj * pitch);
  }
}
