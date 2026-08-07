// Monument modes — macro layouts that tell a story through their shape.
//
// ▲ ZIGGURAT: terraces shrink 3×3 → 2×2 → 1 toward a summit sanctum. Each
//   layer sits on the SEAMS of the one below (half-pitch offset), so every
//   upper block overlaps four lower roofs. The story is an ascent: the base
//   is ruined warren (heavy decay, rubble, brambles), each terrace climbs
//   cleaner, and only the crown carries a temple.
//
// ◆ RELIQUARY: a suspended diamond, 1 → 2×2 → 3×3 → 2×2 → 1. The bottom tip
//   is the Sealed Vault — fully decayed, no plazas, no totems, lit only by
//   its red chamber. The waist is the living fortress. The crown tip is
//   pristine and carries the sanctum. Two poles of one story.
//
// Both reuse the whole kit: worker-pool generation, slot pools, in-layer rope
// bridges at agreed gate rows, spiral stair shafts through the layer overlaps.

import { buildWorld, buildBridgeLink, buildSupportPiers, type LightSpec } from "../scene/build";
import type { VerticalAnchor } from "../gen/dungeon";
import { pruneSlots } from "../scene/slots";
import { CELL, ISLAND_GAP, PR_LARGE, TH, linkArc } from "../config";
import type { Ctx } from "./context";
import { gateWorld, verticalStairDock, Pacer } from "./helpers";

export type Monument = "ziggurat" | "reliquary";

const LAYER = 34;

interface MCell { mi: number; mj: number; mk: number }

export async function forgeMonument(ctx: Ctx, kind: Monument): Promise<void> {
  if (ctx.state.endless) return;
  const { genParams, state } = ctx;
  const seed = state.seed;
  const tok = ++state.token;
  const size = Math.min(13, Math.max(9, Math.round(genParams.size))) | 1;
  const N = 2 * size + 1;
  // Keep the half-pitch terrace offsets on the dungeon cell lattice. This is
  // visually the same gap (~15u), but now a lower and upper generated anchor
  // can resolve to one exact world x/z instead of two almost-matching cells.
  let gapCells = Math.ceil(ISLAND_GAP / CELL);
  if ((N + gapCells) % 2 !== 0) gapCells++;
  const pitchCells = N + gapCells;
  const pitch = pitchCells * CELL;
  const ch = (a: number, b: number, c: number, salt: number) =>
    (Math.imul(seed ^ Math.imul(a + 9, 73856093) ^ Math.imul(b + 9, 19349663) ^ Math.imul(c + 9, 83492791), 0x9e3779b1 ^ salt) >>> 0);

  // layer plan, bottom → top. Odd/even sizes are both centered on the axis,
  // which gives consecutive layers the half-pitch offset for free.
  const plan = kind === "ziggurat" ? [3, 2, 1] : [1, 2, 3, 2, 1];
  const L = plan.length;
  const cells: MCell[] = [];
  plan.forEach((s, k) => {
    const off = (s - 1) / 2;
    for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) {
      cells.push({ mi: i - off, mj: j - off, mk: k });
    }
  });

  // the story lives in the per-layer generation parameters
  const storyFor = (c: MCell) => {
    const t = L === 1 ? 1 : c.mk / (L - 1);
    const jit = ((ch(c.mi * 2, c.mj * 2, c.mk, 0x88) % 100) / 100 - 0.5) * 0.15;
    const rot = ch(c.mi * 2, c.mj * 2, c.mk, 0xaa) % 4;
    if (kind === "ziggurat") {
      const apex = c.mk === L - 1;
      return {
        rot,
        // ONLY the crown carries a true temple; some base blocks keep small shrines
        templeOn: apex || ch(c.mi * 2, c.mj * 2, c.mk, 0x92) % 100 < 35,
        decay: Math.min(1, Math.max(0.08, 0.82 - 0.68 * t + jit)),
        mound: apex ? Math.max(3.5, genParams.mound * 1.2) : 0.25,
        plazas: c.mk === 0 ? 1 : apex ? 1 : 1,
        totems: apex ? 0 : 1 + (ch(c.mi, c.mj, c.mk, 0x91) % 3),
      };
    }
    const lowTip = c.mk === 0, highTip = c.mk === L - 1;
    return {
      rot,
      templeOn: highTip || (!lowTip && ch(c.mi * 2, c.mj * 2, c.mk, 0x92) % 100 < 40),
      decay: lowTip ? 1 : highTip ? 0.06 : Math.min(1, Math.max(0.15, 0.75 - 0.55 * t + jit)),
      mound: highTip ? Math.max(3.5, genParams.mound * 1.2) : 0,
      plazas: lowTip ? 0 : highTip ? 1 : 1,
      totems: lowTip ? 0 : 1 + (ch(c.mi, c.mj, c.mk, 0x91) % 3),
    };
  };

  // in-layer gates: neighbors agree on the row via a shared edge hash
  const edgeRow = (a: number, b: number, c: number, axis: number) =>
    3 + (ch(Math.round(a * 2), Math.round(b * 2), c, 0xe0 + axis) % (N - 6));
  const at = (mi: number, mj: number, mk: number) =>
    cells.findIndex((c) => c.mi === mi && c.mj === mj && c.mk === mk);

  const belowFor = (i: number): number[] => {
    const c = cells[i], below: number[] = [];
    for (const [si, sj] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, 0]] as const) {
      const j = at(c.mi + si, c.mj + sj, c.mk - 1);
      if (j >= 0) below.push(j);
    }
    return below;
  };
  const verticalByCell: VerticalAnchor[][] = cells.map(() => []);
  const verticalParent = new Int16Array(cells.length).fill(-1);
  const center = (N - 1) / 2;
  const centerCellX = (i: number) => Math.round(cells[i].mi * pitchCells);
  const centerCellZ = (i: number) => Math.round(cells[i].mj * pitchCells);
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].mk === 0) continue;
    const below = belowFor(i);
    if (below.length === 0) continue;
    const p = below[ch(Math.round(cells[i].mi * 2), Math.round(cells[i].mj * 2), cells[i].mk, 0x5c) % below.length];
    verticalParent[i] = p;
    const pcx = centerCellX(p), pcz = centerCellZ(p);
    const ccx = centerCellX(i), ccz = centerCellZ(i);
    const x0 = Math.max(pcx - center + 2, ccx - center + 2);
    const x1 = Math.min(pcx + center - 2, ccx + center - 2);
    const z0 = Math.max(pcz - center + 2, ccz - center + 2);
    const z1 = Math.min(pcz + center - 2, ccz + center - 2);
    let wx = Math.round((x0 + x1) / 2), wz = Math.round((z0 + z1) / 2), best = -Infinity;
    const prior = [
      ...verticalByCell[p].map((a) => ({ x: pcx + a.x - center, z: pcz + a.y - center })),
      ...verticalByCell[i].map((a) => ({ x: ccx + a.x - center, z: ccz + a.y - center })),
    ];
    for (let z = Math.ceil(z0); z <= Math.floor(z1); z++) for (let x = Math.ceil(x0); x <= Math.floor(x1); x++) {
      const sep = prior.length === 0 ? N : Math.min(...prior.map((a) =>
        Math.max(Math.abs(a.x - x), Math.abs(a.z - z))));
      const score = sep + (ch(x, z, i, 0x5d) % 1000) / 100000;
      if (score > best) { best = score; wx = x; wz = z; }
    }
    const id = 30_000 + i;
    const dockDir = (ch(wx, wz, i, 0x5e) % 4) as 0 | 1 | 2 | 3;
    verticalByCell[p].push({ id, x: wx - pcx + center, y: wz - pcz + center, dockDir });
    verticalByCell[i].push({ id, x: wx - ccx + center, y: wz - ccz + center, dockDir });
  }

  const layouts = await Promise.all(cells.map((c, cellIndex) => {
    const gs: number[] = [], gr: number[] = [];
    if (at(c.mi + 1, c.mj, c.mk) >= 0) { gs.push(0); gr.push(edgeRow(c.mi, c.mj, c.mk, 0)); }
    if (at(c.mi - 1, c.mj, c.mk) >= 0) { gs.push(1); gr.push(edgeRow(c.mi - 1, c.mj, c.mk, 0)); }
    if (at(c.mi, c.mj + 1, c.mk) >= 0) { gs.push(2); gr.push(edgeRow(c.mi, c.mj, c.mk, 1)); }
    if (at(c.mi, c.mj - 1, c.mk) >= 0) { gs.push(3); gr.push(edgeRow(c.mi, c.mj - 1, c.mk, 1)); }
    return ctx.gen.generate(ch(c.mi * 2, c.mj * 2, c.mk, 0x77) || 1, genParams, {
      gateSides: gs, gateRows: gr, size, verticalAnchors: verticalByCell[cellIndex], ...storyFor(c),
    });
  }));
  if (tok !== state.token) return;

  ctx.worlds.length = 0;
  ctx.walk.clear();
  ctx.stairs.clear();
  ctx.actors.clear();
  const activeSlots = new Set<number>();
  const allLightsByCell: LightSpec[][] = [];

  const pacer = new Pacer(6);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i], l = layouts[i];
    const ox = c.mi * pitch, oz = c.mj * pitch;
    const oy = c.mk * LAYER;
    const w = buildWorld(l, i, ctx.scene, c.mk === 0 ? 1 : 0, i * 0.04);
    activeSlots.add(i);
    w.group.position.set(ox, oy, oz);
    ctx.worlds.push(w);
    allLightsByCell.push(w.lights.map((ls) => ({ ...ls, x: ls.x + ox, y: ls.y + oy, z: ls.z + oz })));
    ctx.walk.addIsland(l, ox, oy, oz, i);
    ctx.actors.addIsland(l, { ox, oy, oz }, i);
    await pacer.tick();
    if (tok !== state.token) return;
    if ((i & 7) === 7) {
      ctx.env.bakeShadows();
      await pacer.tick();
      if (tok !== state.token) return;
    }
  }

  // in-layer rope bridges between adjacent blocks with facing gates
  let edgeSlot = 1000;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    for (const [dmi, dmj, dir] of [[1, 0, 0], [0, 1, 2]] as const) {
      const j = at(c.mi + dmi, c.mj + dmj, c.mk);
      if (j < 0) continue;
      const from = gateWorld(layouts[i], ctx.walk.islands[i], dir);
      const to = gateWorld(layouts[j], ctx.walk.islands[j], dir ^ 1);
      if (!from || !to) continue;
      ctx.worlds.push(buildBridgeLink(from, to, edgeSlot, ctx.scene));
      activeSlots.add(edgeSlot++);
      ctx.walk.addLink(from.clone(), to.clone(), linkArc(from.distanceTo(to)));
      await pacer.tick();
      if (tok !== state.token) return;
    }
    // Spiral stair shaft down through the generator-selected shared court.
    // Every supporting neighbor also gets masonry piers under its quadrant of
    // the overlap — upper terraces must read as CARRIED, not floating.
    if (c.mk > 0) {
      const below = belowFor(i);
      let stairDone = false;
      for (const j of below) {
        if (!stairDone && j === verticalParent[i]) {
          const dock = verticalStairDock(ctx.walk.islands[j], ctx.walk.islands[i], 30_000 + i);
          if (dock) { ctx.stairs.build(dock.x, dock.z, dock.y0, dock.y1, dock); stairDone = true; }
        }
        const piers = buildSupportPiers(ctx.walk.islands[j], ctx.walk.islands[i], edgeSlot, ctx.scene);
        ctx.worlds.push(piers);
        for (const blocker of piers.blockers) ctx.walk.addBlocker(blocker);
        activeSlots.add(edgeSlot++);
        await pacer.tick();
        if (tok !== state.token) return;
      }
    }
  }

  // fair light distribution: round-robin across cells into the fixed pool
  const interleaved: LightSpec[] = [];
  for (let li = 0; interleaved.length < ctx.lights.size * 2; li++) {
    let any = false;
    for (const arr of allLightsByCell) if (arr[li]) { interleaved.push(arr[li]); any = true; }
    if (!any) break;
  }
  pruneSlots(activeSlots);
  ctx.lights.assign(interleaved);
  setTimeout(() => { if (tok === state.token) ctx.env.bakeShadows(); }, 1500);

  const maxS = Math.max(...plan);
  const half = ((maxS - 1) * pitch + N * CELL) / 2 + 6;
  const top = (L - 1) * LAYER + 34;
  ctx.env.fit(half * 1.25, 0, 0, top);
  ctx.camera.far = Math.max(400, half * 6.5 + top * 2);
  ctx.camera.updateProjectionMatrix();
  ctx.controls.target.set(0, 3 * TH + top * 0.3, 0);
  ctx.camera.position.set(half * 1.1, top * 0.72 + 30, half * 1.7);
  ctx.controls.maxDistance = (half + top * 0.5) * 5;
  state.lastExtent = 0; // force the next chain forge to reframe
  state.prCap = PR_LARGE;

  ctx.hud.name.textContent = kind === "ziggurat" ? "the Ziggurat" : "the Reliquary";
  const floors = layouts.reduce((s2, l) => s2 + l.stats.floor, 0);
  ctx.hud.seed.textContent = `seed ${seed} · ${kind} · ${cells.length} blocks · ${floors} floor`;
  const url = new URL(location.href);
  url.searchParams.set("seed", String(seed));
  url.searchParams.set("mode", kind);
  history.replaceState(null, "", url);
}
