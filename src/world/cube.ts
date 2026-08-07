// 3×3×3 cube demo — 27 blocks in a solid lattice: every horizontal neighbor
// pair bridges, every vertical pair gets a spiral stair shaft. The showcase build.

import { buildWorld, buildBridgeLink, buildSupportPiers, type LightSpec } from "../scene/build";
import type { VerticalAnchor } from "../gen/dungeon";
import { pruneSlots } from "../scene/slots";
import { CELL, ISLAND_GAP, PR_LARGE, linkArc } from "../config";
import type { Ctx } from "./context";
import { gateWorld, verticalStairDock, Pacer } from "./helpers";

export async function forgeCube(ctx: Ctx): Promise<void> {
  if (ctx.state.endless) return;
  const { genParams, state } = ctx;
  const seed = state.seed;
  const tok = ++state.token;
  const size = 11, N = 2 * size + 1, pitch = N * CELL + ISLAND_GAP, LAYER = 36;
  const ch = (a: number, b: number, c: number, salt: number) =>
    (Math.imul(seed ^ Math.imul(a + 7, 73856093) ^ Math.imul(b + 7, 19349663) ^ Math.imul(c + 7, 83492791), 0x9e3779b1 ^ salt) >>> 0);
  const cells: Array<{ mi: number; mj: number; mk: number }> = [];
  for (let mk = 0; mk < 3; mk++) for (let mj = -1; mj <= 1; mj++) for (let mi = -1; mi <= 1; mi++) cells.push({ mi, mj, mk });
  const cellAt = (mi: number, mj: number, mk: number) => cells.findIndex((c) => c.mi === mi && c.mj === mj && c.mk === mk);
  const verticalByCell: VerticalAnchor[][] = cells.map(() => []);
  const center = (N - 1) / 2, radius = center - 5;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i], jUp = cellAt(c.mi, c.mj, c.mk + 1);
    if (jUp < 0) continue;
    let bx = 0, bz = 0, best = -Infinity;
    for (let z = -radius; z <= radius; z++) for (let x = -radius; x <= radius; x++) {
      const prior = verticalByCell[i];
      const sep = prior.length === 0 ? radius * 2 + 2 : Math.min(...prior.map((a) =>
        Math.max(Math.abs(a.x - center - x), Math.abs(a.y - center - z))));
      const score = sep + (ch(c.mi * 17 + x, c.mj * 19 + z, c.mk, 0x5a) % 1000) / 100000;
      if (score > best) { best = score; bx = x; bz = z; }
    }
    const id = 20_000 + jUp;
    const dockDir = (ch(c.mi, c.mj, c.mk, 0x5b) % 4) as 0 | 1 | 2 | 3;
    verticalByCell[i].push({ id, x: center + bx, y: center + bz, dockDir });
    verticalByCell[jUp].push({ id, x: center + bx, y: center + bz, dockDir });
  }
  // neighbors agree on the gate row via a shared edge hash, so blocks line up
  const edgeRow = (a: number, b: number, c: number, axis: number) => 3 + (ch(a, b, c, 0xe0 + axis) % (N - 6));

  const layouts = await Promise.all(cells.map((c, cellIndex) => {
    const gs: number[] = [], gr: number[] = [];
    if (c.mi < 1) { gs.push(0); gr.push(edgeRow(c.mi, c.mj, c.mk, 0)); }
    if (c.mi > -1) { gs.push(1); gr.push(edgeRow(c.mi - 1, c.mj, c.mk, 0)); }
    if (c.mj < 1) { gs.push(2); gr.push(edgeRow(c.mi, c.mj, c.mk, 1)); }
    if (c.mj > -1) { gs.push(3); gr.push(edgeRow(c.mi, c.mj - 1, c.mk, 1)); }
    return ctx.gen.generate(ch(c.mi, c.mj, c.mk, 0x77) || 1, genParams, {
      gateSides: gs, gateRows: gr, size, plazas: 1, totems: 2,
      verticalAnchors: verticalByCell[cellIndex],
      rot: ch(c.mi, c.mj, c.mk, 0xaa) % 4,
      templeOn: ch(c.mi, c.mj, c.mk, 0xab) % 100 < 60,
      mound: c.mi === 0 && c.mj === 0 && c.mk === 2 ? genParams.mound : genParams.mound * 0.3,
      decay: Math.min(1, Math.max(0.1, genParams.decay + ((ch(c.mi, c.mj, c.mk, 0x88) % 100) / 100 - 0.5) * 0.5)),
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
    const oy = c.mk * LAYER + ((ch(c.mi, c.mj, c.mk, 0x99) % 100) / 100 - 0.5) * 4.4;
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

  // bridges: every horizontally adjacent pair with facing gates
  let edgeSlot = 1000;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    for (const [dmi, dmj, dir] of [[1, 0, 0], [0, 1, 2]] as const) {
      const j = cellAt(c.mi + dmi, c.mj + dmj, c.mk);
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
    // stair shafts + carrying piers: every vertical pair
    const jUp = cellAt(c.mi, c.mj, c.mk + 1);
    if (jUp >= 0) {
      const dock = verticalStairDock(ctx.walk.islands[i], ctx.walk.islands[jUp], 20_000 + jUp);
      if (dock) ctx.stairs.build(dock.x, dock.z, dock.y0, dock.y1, dock);
      const piers = buildSupportPiers(ctx.walk.islands[i], ctx.walk.islands[jUp], edgeSlot, ctx.scene);
      ctx.worlds.push(piers);
      for (const blocker of piers.blockers) ctx.walk.addBlocker(blocker);
      activeSlots.add(edgeSlot++);
      await pacer.tick();
      if (tok !== state.token) return;
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
  ctx.env.fit(pitch * 2.1, 0, 0);
  ctx.camera.far = Math.max(400, pitch * 8); // see forge(): far must outrun the lattice
  ctx.camera.updateProjectionMatrix();
  ctx.controls.target.set(0, LAYER * 1.1, 0);
  ctx.camera.position.set(pitch * 1.9, LAYER * 2.1, pitch * 2.6);
  ctx.state.prCap = PR_LARGE;
  ctx.hud.name.textContent = "the Cube";
  ctx.hud.seed.textContent = `seed ${seed} · 3×3×3 · ${layouts.reduce((s2, l) => s2 + l.stats.floor, 0)} floor`;
}
