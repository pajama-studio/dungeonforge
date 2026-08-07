// The chain forge: N linked dungeon blocks grown on a coarse macro grid,
// bridged at facing gates, stacked pairs joined by spiral stair towers.

import type * as THREE from "three/webgpu";
import type { Layout } from "../gen/dungeon";
import { buildWorld, buildBridgeLink, type LightSpec } from "../scene/build";
import { pruneSlots } from "../scene/slots";
import { TH, CELL, ISLAND_GAP, PR_BASE, PR_LARGE } from "../config";
import type { Ctx } from "./context";
import { gateWorld, linkSag, findShaftAnyhow, ensureGate, nextFrame } from "./helpers";

export async function forge(ctx: Ctx, newSeed: number): Promise<void> {
  if (ctx.state.endless) return; // roaming owns the world in endless mode
  const seed = ctx.state.seed = newSeed >>> 0 || 1;
  const { genParams, state } = ctx;
  const nIsl = Math.max(1, Math.min(24, Math.round(genParams.islands)));

  // -- macro layout: blocks GROW on a coarse grid like WFC tiles — each new
  //    block attaches to a random placed block on a free side. Gates open
  //    toward tree neighbors (bridged) plus extra random sides that dangle
  //    over the abyss (step out and you fall).
  const tok = ++state.token;
  const h32 = (a: number, b: number) => (Math.imul(seed ^ a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b)) >>> 0;
  const macro: Array<{ mi: number; mj: number; mk: number; parent: number; dirFromParent: number }> = [
    { mi: 0, mj: 0, mk: 0, parent: -1, dirFromParent: -1 },
  ];
  const occupied = new Set(["0,0,0"]);
  // dirs 0-3 horizontal; dir 4 stacks a block a LAYER above, joined by stairs
  const MDX = [1, -1, 0, 0, 0], MDZ = [0, 0, 1, -1, 0], MDK = [0, 0, 0, 0, 1];
  for (let k = 1; k < nIsl; k++) {
    let placedOk = false;
    // default worlds top out the full six layers: if the remaining blocks are
    // only just enough to finish the spire, force-stack on the current summit
    const maxMk = macro.reduce((a, m) => Math.max(a, m.mk), 0);
    const mustSpire = nIsl >= 8 && maxMk < 5 && nIsl - k <= 5 - maxMk;
    for (let attempt = 0; attempt < 26 && !placedOk; attempt++) {
      let p: number, d: number;
      if (mustSpire && attempt < 13) {
        const tops = macro.map((m, i) => (m.mk === maxMk ? i : -1)).filter((i) => i >= 0);
        p = tops[h32(k, attempt) % tops.length];
        d = 4;
      } else {
        p = h32(k, attempt) % macro.length;
        // ~30% of growth goes UP — six layers should be the norm, not a treat
        d = h32(k, attempt + 100) % 100 < 30 ? 4 : h32(k, attempt + 200) % 4;
      }
      const mi = macro[p].mi + MDX[d], mj = macro[p].mj + MDZ[d], mk = macro[p].mk + MDK[d];
      if (mk > 5) continue; // six layers max — a proper sky-spire, not an endless ladder
      if (occupied.has(`${mi},${mj},${mk}`)) continue;
      occupied.add(`${mi},${mj},${mk}`);
      macro.push({ mi, mj, mk, parent: p, dirFromParent: d });
      placedOk = true;
    }
    if (!placedOk) break;
  }

  // gate sides per block: toward parent, toward children, plus dangling extras
  const gateSets: Array<Set<number>> = macro.map(() => new Set());
  for (let k = 1; k < macro.length; k++) {
    const d = macro[k].dirFromParent;
    if (d < 4) { // vertical neighbors join by stairs, not gate
      gateSets[macro[k].parent].add(d);
      gateSets[k].add(d ^ 1);
    }
  }
  for (let k = 0; k < macro.length; k++) {
    for (let d = 0; d < 4; d++) {
      if (!gateSets[k].has(d) && h32(k * 7, d + 300) % 100 < 35) gateSets[k].add(d); // broken sky-door
    }
  }

  const tForge = performance.now();
  // per-block VARIATION: satellites differ in size, growth style and age.
  // Layouts are awaited ONE AT A TIME inside the build loop (parents come
  // first in BFS order), so generation and building pipeline instead of
  // serializing: wall time is max(gen, build), not gen + build.
  const layoutPromises = macro.map((_, i) => {
    const s = i === 0 ? seed : (h32(i, 1) || 1);
    const gateSides = [...gateSets[i]];
    if (i === 0) return ctx.gen.generate(seed, genParams, { gateSides, rot: h32(0, 61) % 4 });
    const v = (n: number) => h32(i, n + 40) % 1000 / 1000;
    return ctx.gen.generate(s, genParams, {
      gateSides,
      // orientation & structure variety: each satellite faces its own way,
      // ~half go temple-less, a quarter go ravine-less
      rot: h32(i, 61) % 4,
      templeOn: v(8) < 0.55,
      ravineOn: v(9) < 0.75,
      size: [9, 11, 13][h32(i, 50) % 3] | 1,
      plazas: h32(i, 51) % 3 === 0 ? 0 : 1,
      totems: h32(i, 52) % 4,
      decay: Math.min(1, Math.max(0.1, genParams.decay + (v(3) - 0.5) * 0.5)),
      heightAmp: Math.max(0.5, genParams.heightAmp + (v(4) - 0.5) * 1.6),
      newest: Math.min(1, Math.max(0.2, genParams.newest + (v(5) - 0.5) * 0.5)),
      mound: i === 0 ? genParams.mound : genParams.mound * 0.4, // one temple rules the skyline
    });
  });

  ctx.worlds.length = 0; // slot pools persist; pruneSlots() hides the unused ones
  ctx.walk.clear();
  ctx.stairs.clear();
  const activeSlots = new Set<number>();

  // tree layout: place blocks in BFS order along their parent edges, sliding
  // each child so the two facing gates line up; bridge every parent-child pair
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let maxOy = 0;
  const allLights: LightSpec[] = [];
  const positions: Array<{ ox: number; oy: number; oz: number }> = [];
  const layouts: Layout[] = [];
  const handleIdx: number[] = [];

  // frame-budgeted batching: a warm island build is ~3ms, so several fit in
  // one frame — yield only when the budget is spent instead of once per island
  let frameStart = performance.now();
  for (let i = 0; i < layoutPromises.length; i++) {
    const l = await layoutPromises[i];
    if (tok !== state.token) return; // superseded while generating
    layouts.push(l);
    // the crossing must EXIST before alignment and build: if the generator
    // failed to carve either gate of a parent-child pair, open it now
    if (macro[i].parent >= 0 && macro[i].dirFromParent < 4) {
      if (ensureGate(layouts[macro[i].parent], macro[i].dirFromParent)) {
        // parent is already built — rebuild its slot with the carved doorway
        const pi = macro[i].parent;
        const wp = buildWorld(layouts[pi], pi, ctx.scene, macro[pi].dirFromParent === 4 ? 0 : 1, -1);
        wp.group.position.set(positions[pi].ox, positions[pi].oy, positions[pi].oz);
        ctx.worlds[handleIdx[pi]] = wp;
      }
      ensureGate(l, macro[i].dirFromParent ^ 1);
    }
    const half = (l.N * CELL) / 2;
    let ox = 0, oz = 0;
    let oy = 0;
    const pIdx = macro[i].parent;
    if (pIdx >= 0) {
      const d = macro[i].dirFromParent;
      const pp = positions[pIdx];
      if (d === 4) {
        // a LAYER above its parent — same footprint, joined by a stair tower.
        // clearance must top the parent's temple/towers (~22 world units)
        ox = pp.ox;
        oz = pp.oz;
        oy = pp.oy + 32 + ((h32(i, 141) % 1000) / 1000) * 5;
      } else {
        const pHalf = (layouts[pIdx].N * CELL) / 2;
        const fx = [1, -1, 0, 0][d], fz = [0, 0, 1, -1][d];
        ox = pp.ox + fx * (pHalf + ISLAND_GAP + half);
        oz = pp.oz + fz * (pHalf + ISLAND_GAP + half);
        oy = pp.oy + (((h32(i, 141) >>> 4) % 1000) / 1000 - 0.5) * 8.4;
        // slide on the cross axis so the two gates face each other
        const pg = layouts[pIdx].gates.find((g) => g.dir === d);
        const cg = l.gates.find((g) => g.dir === (d ^ 1));
        if (pg && cg) {
          if (fx !== 0) {
            const pz2 = pp.oz + (pg.y - (layouts[pIdx].N - 1) / 2) * CELL;
            oz = pz2 - (cg.y - (l.N - 1) / 2) * CELL;
          } else {
            const px2 = pp.ox + (pg.x - (layouts[pIdx].N - 1) / 2) * CELL;
            ox = px2 - (cg.x - (l.N - 1) / 2) * CELL;
          }
        }
      }
    }
    positions.push({ ox, oy, oz });
    maxOy = Math.max(maxOy, oy);

    // no rock cone under stacked blocks — there is a block directly beneath
    const w = buildWorld(l, i, ctx.scene, macro[i].dirFromParent === 4 ? 0 : 1, i * 0.05);
    activeSlots.add(i);
    w.group.position.set(ox, oy, oz);
    ctx.scene.add(w.group);
    handleIdx.push(ctx.worlds.length);
    ctx.worlds.push(w);
    for (const ls of w.lights) allLights.push({ ...ls, x: ls.x + ox, y: ls.y + oy, z: ls.z + oz });
    const isl = ctx.walk.addIsland(l, ox, oy, oz, i);
    minX = Math.min(minX, ox - half); maxX = Math.max(maxX, ox + half);
    minZ = Math.min(minZ, oz - half); maxZ = Math.max(maxZ, oz + half);

    // spiral stair tower joining a stacked pair — the relaxation ladder
    // guarantees one wherever the footprints share any walkable overlap
    if (pIdx >= 0 && macro[i].dirFromParent === 4) {
      const shaft = findShaftAnyhow(ctx.walk.islands[pIdx], isl);
      if (shaft) ctx.stairs.build(shaft.x, shaft.z, shaft.y0, shaft.y1);
    }
    if (pIdx >= 0) {
      const from = gateWorld(layouts[pIdx], positions[pIdx], macro[i].dirFromParent);
      const to = gateWorld(l, positions[i], macro[i].dirFromParent ^ 1);
      if (from && to) {
        ctx.worlds.push(buildBridgeLink(from, to, 1000 + i, ctx.scene, i * 0.05));
        activeSlots.add(1000 + i);
        ctx.walk.addLink(from.clone(), to.clone(), linkSag(from.distanceTo(to)));
      }
    }
    // shadow bakes are a full scene render each — every 8th island is plenty
    // (pipelines are warm after the first session compile)
    if ((i & 7) === 7) ctx.env.bakeShadows();
    if (performance.now() - frameStart > 24 && i < layoutPromises.length - 1) {
      await nextFrame();
      if (tok !== state.token) return; // superseded mid-build
      frameStart = performance.now();
    }
  }

  pruneSlots(activeSlots);
  ctx.lights.assign(allLights);
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const half = Math.max((maxX - minX) / 2, (maxZ - minZ) / 2, (layouts[0].N * CELL) / 2) + 4;
  const top = maxOy + 34; // stack base height + one block's worth of towers
  ctx.env.fit(half * 1.2, centerX, centerZ, top);
  // the far plane must outrun the chain: a fixed 400 sliced distant blocks
  // off mid-air (a clean diagonal cut) once chains spanned more than ~400
  // world units — scale it with the extent, past controls.maxDistance
  ctx.camera.far = Math.max(400, half * 6.5 + top * 2);
  ctx.camera.updateProjectionMatrix();
  const extent = half + top * 0.5; // reframe on height changes too (tall spires)
  if (Math.abs(state.lastExtent - extent) > 1) {
    ctx.controls.target.set(centerX, 3 * TH + top * 0.18, centerZ);
    ctx.camera.position.set(centerX + half * 0.75, half * 0.62 + top * 0.4, centerZ + half * 1.1);
    ctx.controls.maxDistance = (half + top * 0.5) * 5;
    state.lastExtent = extent;
    // fill rate is the budget: bigger worlds get a lower resolution ceiling
    // (the adaptive-DPR loop in main.ts walks the actual ratio)
    state.prCap = half > 95 ? PR_LARGE : PR_BASE;
  }
  ctx.env.bakeShadows();
  // the forge-rise animation is still settling — re-bake once it lands
  setTimeout(() => { if (tok === state.token) ctx.env.bakeShadows(); }, 1500);
  ctx.hud.name.textContent = `${nIsl} linked block${nIsl > 1 ? "s" : ""}`;
  const floorSum = layouts.reduce((s2, l) => s2 + l.stats.floor, 0);
  const forgeMs = Math.round(performance.now() - tForge);
  ctx.hud.seed.textContent = `seed ${seed} · ${nIsl} block${nIsl > 1 ? "s" : ""} · ${floorSum} floor · forged in ${forgeMs}ms`;
  const url = new URL(location.href);
  url.searchParams.set("seed", String(seed));
  url.searchParams.delete("mode"); // chain forge is the default mode
  history.replaceState(null, "", url);
}

export type { Layout };
