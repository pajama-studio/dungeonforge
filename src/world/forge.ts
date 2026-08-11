// The chain forge: a constrained 3D spine plus Markov-rewritten branches,
// bridged at facing gates, stacked pairs joined through shared stair courts.

import type * as THREE from "three/webgpu";
import { Vector3 } from "three/webgpu";
import { FOOTPRINT_KINDS, type Dir, type Layout, type VerticalAnchor } from "../gen/dungeon";
import {
  buildWorld, buildBridgeLink, buildSupportPiers, horizontalLinkArc, horizontalLinkWalkWidth,
  type HorizontalLinkStyle, type LightSpec,
} from "../scene/build";
import { pruneSlots } from "../scene/slots";
import { TH, CELL, DISTRICT_COURT_GAP, DISTRICT_GAP, ISLAND_GAP, PR_BASE, PR_LARGE } from "../config";
import type { Ctx } from "./context";
import { gateWorld, verticalStairDock, groundStairDock, ensureGate, fuseDistrictBoundary, Pacer, type VerticalStairDock } from "./helpers";
import { generateSpatialPlan, planVerticalAnchors, planGroundEntrance } from "../markov/spatial-plan";

export async function forge(ctx: Ctx, newSeed: number): Promise<void> {
  if (ctx.state.endless) return; // roaming owns the world in endless mode
  const seed = ctx.state.seed = newSeed >>> 0 || 1;
  const { genParams, state } = ctx;
  const nIsl = Math.max(1, Math.min(24, Math.round(genParams.islands)));

  // -- Macro layout is now a real 3D generative program. A constrained path
  //    first guarantees start→summit progression; ordered Markov rules then
  //    grow optional branches from the path's live frontier.
  const tok = ++state.token;
  ctx.reportForgeStage?.("generating", {
    token: tok, seed, mode: "chain", detail: "solving spatial plan and maze workers", completed: 0, total: nIsl,
  });
  const h32 = (a: number, b: number) => (Math.imul(seed ^ a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b)) >>> 0;
  const spatialPlan = generateSpatialPlan(nIsl, seed);
  const macro = spatialPlan.cells;

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

  // a block "has ground" only if NO block occupies the macro cell beneath it —
  // dirFromParent===4 alone misses horizontally-attached upper-layer blocks
  // that happen to sit over another branch (they'd grow a rock cone plunging
  // toward the roof below)
  const idxByKey = new Map(macro.map((m, i) => [`${m.mi},${m.mj},${m.mk}`, i] as const));
  const belowIdx = new Map<number, number>();
  for (let i = 0; i < macro.length; i++) {
    const b = idxByKey.get(`${macro[i].mi},${macro[i].mj},${macro[i].mk - 1}`);
    if (b !== undefined) belowIdx.set(i, b);
  }

  const tForge = performance.now();
  const blockSizes = macro.map((_, i) => i === 0
    ? Math.max(7, Math.min(23, Math.round(genParams.size)))
    : [9, 11, 13][h32(i, 50) % 3]);
  const blockN = blockSizes.map((s) => 2 * s + 1);
  // Shared court coordinates are collapsed from constraint domains. Selecting
  // one propagates exclusions through both participating blocks before the
  // next vertical link is solved.
  const verticalByBlock: VerticalAnchor[][] = planVerticalAnchors(macro, blockN, seed);
  // Orientation is decided here rather than inline in the generate() call,
  // because the ground entrance has to be sited against the rotation its block
  // will actually be built with — the temple it must avoid is stamped in grid
  // space while the anchor is requested in world space.
  const rots = macro.map((_, i) => h32(i, 61) % 4);
  // The one way into the world. Reserved before any maze is solved, exactly
  // like a stair court, and on failure the block re-rolls rather than moving it.
  const groundEntrance = planGroundEntrance(macro, blockN, seed, verticalByBlock, rots);
  /** Resolved once the owning block is placed — the spawn and the route walker
   *  both start from here. */
  let groundDock: VerticalStairDock | null = null;
  if (groundEntrance) verticalByBlock[groundEntrance.block].push(groundEntrance.anchor);
  // per-block VARIATION: satellites differ in size, growth style and age.
  // Layouts are awaited ONE AT A TIME inside the build loop (parents come
  // first in BFS order), so generation and building pipeline instead of
  // serializing: wall time is max(gen, build), not gen + build.
  const layoutPromises = macro.map((_, i) => {
    const s = i === 0 ? seed : (h32(i, 1) || 1);
    const gateSides = [...gateSets[i]];
    const v = (n: number) => h32(i, n + 40) % 1000 / 1000;
    const role = macro[i].role;
    const roleDecay = role === "overgrowth" ? 0.25 : role === "archive" ? -0.18 : role === "sanctum" ? -0.28 : 0;
    const roleTotems = role === "forge" ? 5 : role === "pilgrim" ? 4 : role === "sanctum" ? 2 : h32(i, 52) % 4;
    const rolePlazas = role === "pilgrim" || role === "sanctum" ? 2 : role === "threshold" ? 0 : 1;
    return ctx.gen.generate(s, genParams, {
      gateSides,
      verticalAnchors: verticalByBlock[i],
      groundAnchorId: groundEntrance?.block === i ? groundEntrance.anchor.id : undefined,
      narrativeRole: role,
      districtId: macro[i].district,
      storyLandmark: macro[i].landmark,
      // Adjacent and stacked districts get different generation domains; the
      // footprint is solved together with gates/courts rather than clipped in
      // the renderer.
      footprint: FOOTPRINT_KINDS[(h32(i, 170) + macro[i].mk) % FOOTPRINT_KINDS.length],
      // orientation & structure variety: each satellite faces its own way,
      // ~half go temple-less, a quarter go ravine-less
      rot: rots[i],
      // One readable goal portal at the narrative summit. Other districts use
      // their own scene grammar instead of repeating the same temple stamp.
      templeOn: macro[i].landmark,
      ravineOn: v(9) < 0.75,
      size: blockSizes[i],
      plazas: rolePlazas,
      totems: roleTotems,
      decay: Math.min(1, Math.max(0.08, genParams.decay + roleDecay + (v(3) - 0.5) * 0.35)),
      heightAmp: Math.max(0.5, genParams.heightAmp + (v(4) - 0.5) * 1.6),
      newest: Math.min(1, Math.max(0.2, genParams.newest + (v(5) - 0.5) * 0.5)),
      mound: macro[i].landmark ? genParams.mound * 1.25 : genParams.mound * 0.25,
    });
  });

  // Preserve the currently visible dungeon until at least one replacement
  // layout exists. Shared instance pools switch into assembly only after this
  // await; main.ts keeps a snapshot visible until GPU submission completes.
  const firstLayout = await layoutPromises[0];
  if (tok !== state.token) return;
  ctx.reportForgeStage?.("assembling", {
    token: tok, seed, mode: "chain", detail: "placing blocks, links and supports", completed: 0, total: nIsl,
  });

  ctx.worlds.length = 0; // slot pools persist; pruneSlots() hides the unused ones
  ctx.walk.clear();
  ctx.stairs.clear();
  ctx.actors.clear();
  const activeSlots = new Set<number>();

  // tree layout: place blocks in BFS order along their parent edges, sliding
  // each child so the two facing gates line up; bridge every parent-child pair
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let maxOy = 0;
  const allLightsByIsland: LightSpec[][] = [];
  const positions: Array<{ ox: number; oy: number; oz: number }> = [];
  const layouts: Layout[] = [];
  const handleIdx: number[] = [];

  // sub-step pacing: EVERY costly unit (one island build, one gate repair,
  // one bridge, one pier set, one shadow bake) is followed by a budget check,
  // so no frame ever carries more than ~one unit past the 6ms budget
  const pacer = new Pacer(6);
  for (let i = 0; i < layoutPromises.length; i++) {
    const l = i === 0 ? firstLayout : await layoutPromises[i];
    if (tok !== state.token) return; // superseded while generating
    layouts.push(l);
    // the crossing must EXIST before alignment and build: if the generator
    // failed to carve either gate of a parent-child pair, open it now
    if (macro[i].parent >= 0 && macro[i].dirFromParent < 4) {
      const pi = macro[i].parent;
      const linkSide = macro[i].dirFromParent as Dir;
      const childSide = (linkSide ^ 1) as Dir;
      let parentChanged = ensureGate(layouts[pi], linkSide);
      ensureGate(l, childSide);
      const style = macro[i].joinFromParent;
      if (style === "causeway" || style === "gallery" || style === "court") {
        const depth = style === "court" ? 4 : 3;
        parentChanged = fuseDistrictBoundary(layouts[pi], linkSide, 2, depth) > 0 || parentChanged;
        fuseDistrictBoundary(l, childSide, 2, depth);
        // The parent IslandWalk already exists. Its Layout is shared by
        // reference, but the cached stair-direction map must follow removed
        // edge stairs after the room apron mutation.
        const parentWalk = ctx.walk.islands.find((island) => island.slot === pi);
        if (parentWalk) parentWalk.stairDir = new Map(layouts[pi].stairs.map((stair) => [stair.y * layouts[pi].N + stair.x, stair.dir]));
      }
      if (parentChanged) {
        // parent is already built — rebuild its slot with the carved doorway
        const wp = buildWorld(layouts[pi], pi, ctx.scene, belowIdx.has(pi) ? 0 : 1, -1);
        wp.group.position.set(positions[pi].ox, positions[pi].oy, positions[pi].oz);
        ctx.worlds[handleIdx[pi]] = wp;
        allLightsByIsland[pi] = wp.lights.map((ls) => ({
          ...ls,
          x: ls.x + positions[pi].ox,
          y: ls.y + positions[pi].oy,
          z: ls.z + positions[pi].oz,
        }));
        await pacer.tick();
        if (tok !== state.token) return;
      }
    }
    const half = (l.N * CELL) / 2;
    let ox = 0, oz = 0;
    let oy = 0;
    const pIdx = macro[i].parent;
    if (pIdx >= 0) {
      const d = macro[i].dirFromParent;
      const pp = positions[pIdx];
      if (d === 4) {
        // Center stacking keeps the pre-generated local anchor offsets at one
        // exact world x/z on both floors, independent of footprint size.
        ox = pp.ox;
        oz = pp.oz;
        oy = pp.oy + 32 + ((h32(i, 141) % 1000) / 1000) * 5;
      } else {
        const pHalf = (layouts[pIdx].N * CELL) / 2;
        const fx = [1, -1, 0, 0][d], fz = [0, 0, 1, -1][d];
        const seamGap = macro[i].joinFromParent === "court"
          ? DISTRICT_COURT_GAP
          : macro[i].district === macro[pIdx].district ? DISTRICT_GAP : ISLAND_GAP;
        ox = pp.ox + fx * (pHalf + seamGap + half);
        oz = pp.oz + fz * (pHalf + seamGap + half);
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

    // no rock cone wherever a block sits directly beneath
    const w = buildWorld(l, i, ctx.scene, belowIdx.has(i) ? 0 : 1, i * 0.05);
    activeSlots.add(i);
    w.group.position.set(ox, oy, oz);
    ctx.scene.add(w.group);
    handleIdx.push(ctx.worlds.length);
    ctx.worlds.push(w);
    allLightsByIsland[i] = w.lights.map((ls) => ({ ...ls, x: ls.x + ox, y: ls.y + oy, z: ls.z + oz }));
    const isl = ctx.walk.addIsland(l, ox, oy, oz, i);
    minX = Math.min(minX, ox - half); maxX = Math.max(maxX, ox + half);
    minZ = Math.min(minZ, oz - half); maxZ = Math.max(maxZ, oz + half);
    await pacer.tick(); // the island build is the heaviest single step
    if (tok !== state.token) return;
    ctx.reportForgeStage?.("assembling", {
      token: tok, seed, mode: "chain", detail: "placing blocks, links and supports", completed: i + 1, total: nIsl,
    });

    // The way in: a tower dropping from this block's shaft landing into the
    // open abyss. Built like a stair court because it is one — the only
    // difference is that its lower end is the ground rather than a parent.
    if (groundEntrance?.block === i) {
      const dock = groundStairDock({ l, ...positions[i] }, groundEntrance.anchor.id);
      if (dock) {
        ctx.stairs.build(dock.x, dock.z, dock.y0, dock.y1, dock);
        groundDock = dock;
      }
    }

    // Generator-owned interior stair court joining this stacked pair.
    if (pIdx >= 0 && macro[i].dirFromParent === 4) {
      const dock = verticalStairDock(
        { l: layouts[pIdx], ...positions[pIdx] }, { l, ...positions[i] }, i,
      );
      if (dock) ctx.stairs.build(dock.x, dock.z, dock.y0, dock.y1, dock);
      // masonry piers so the stacked block is CARRIED, not levitating
      const piers = buildSupportPiers(
        { l: layouts[pIdx], ...positions[pIdx] }, { l, ...positions[i] },
        1000 + i, ctx.scene, i * 0.05,
      );
      ctx.worlds.push(piers);
      for (const blocker of piers.blockers) ctx.walk.addBlocker(blocker);
      activeSlots.add(1000 + i);
      await pacer.tick();
      if (tok !== state.token) return;
    }
    if (pIdx >= 0 && macro[i].dirFromParent < 4) {
      const from = gateWorld(layouts[pIdx], positions[pIdx], macro[i].dirFromParent);
      const to = gateWorld(l, positions[i], macro[i].dirFromParent ^ 1);
      if (from && to) {
        const style = macro[i].joinFromParent as HorizontalLinkStyle;
        ctx.worlds.push(buildBridgeLink(from, to, 1000 + i, ctx.scene, i * 0.05, style));
        activeSlots.add(1000 + i);
        ctx.walk.addLink(
          from.clone(), to.clone(),
          horizontalLinkArc(style, from.distanceTo(to)), horizontalLinkWalkWidth(style),
        );
        await pacer.tick();
        if (tok !== state.token) return;
      }
    }
    // shadow bakes are a full scene render each — every 8th island is plenty
    // (pipelines are warm after the first session compile). The bake lands in
    // the NEXT rendered frame, so hand it a frame with an empty CPU budget.
    if ((i & 7) === 7) {
      ctx.env.bakeShadows();
      await pacer.tick();
      if (tok !== state.token) return;
    }
  }

  // second pass: piers for over-another-branch blocks (not their d=4 parent —
  // those were piered in-loop). The block below may be built LATER in BFS
  // order, so its position only exists once the loop is done.
  for (const [i, b] of belowIdx) {
    if (macro[i].dirFromParent === 4 && macro[i].parent === b) continue;
    if (!positions[i] || !positions[b]) continue;
    const piers = buildSupportPiers(
      { l: layouts[b], ...positions[b] }, { l: layouts[i], ...positions[i] },
      3000 + i, ctx.scene, i * 0.05,
    );
    ctx.worlds.push(piers);
    for (const blocker of piers.blockers) ctx.walk.addBlocker(blocker);
    activeSlots.add(3000 + i);
    await pacer.tick();
    if (tok !== state.token) return;
  }

  // Populate only after every shared boundary has finished mutating both
  // layouts. Actors and the portal chest then choose cells from the final
  // continuous floor graph rather than a pre-fusion block snapshot.
  for (let i = 0; i < layouts.length; i++) {
    ctx.actors.addIsland(layouts[i], positions[i], i);
    if ((i & 3) === 3) await pacer.tick();
    if (tok !== state.token) return;
  }

  pruneSlots(activeSlots);
  // Round-robin keeps every island represented when the fixed shader light
  // budget is smaller than the number of submitted flame anchors.
  const interleavedLights: LightSpec[] = [];
  for (let li = 0; interleavedLights.length < ctx.lights.size; li++) {
    let any = false;
    for (const islandLights of allLightsByIsland) {
      if (!islandLights[li]) continue;
      interleavedLights.push(islandLights[li]);
      any = true;
      if (interleavedLights.length >= ctx.lights.size) break;
    }
    if (!any) break;
  }
  ctx.lights.assign(interleavedLights);
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
    ctx.controls.target.set(centerX, 3 * TH + top * 0.13, centerZ);
    const cameraCandidate = new Vector3(
      centerX + half * 0.64,
      Math.max(38, half * 0.34 + top * 0.27),
      centerZ + half * 1.08,
    );
    // The art-directed dragon is intentionally colossal and can overlap the
    // maze. Keep the establishing camera low, but never spawn it inside the
    // streamed wing/body volume. This is a one-time framing correction only;
    // OrbitControls remains unrestricted afterward.
    const dragonSupport = ctx.scene.getObjectByName("streamed-colossal-perched-dragon-slot");
    if (dragonSupport) {
      const dragonCenter = dragonSupport.getWorldPosition(new Vector3());
      const dx = cameraCandidate.x - dragonCenter.x;
      const dz = cameraCandidate.z - dragonCenter.z;
      const flatDistance = Math.hypot(dx, dz);
      const exclusion = Math.max(340, half * 2.65);
      if (flatDistance < exclusion) {
        const inv = exclusion / Math.max(0.001, flatDistance);
        cameraCandidate.x = dragonCenter.x + dx * inv;
        cameraCandidate.z = dragonCenter.z + dz * inv;
      }
    }
    ctx.camera.position.copy(cameraCandidate);
    ctx.controls.maxDistance = (half + top * 0.5) * 5;
    state.lastExtent = extent;
    // fill rate is the budget: bigger worlds get a lower resolution ceiling
    // (the adaptive-DPR loop in main.ts walks the actual ratio)
    state.prCap = half > 95 ? PR_LARGE : PR_BASE;
  }
  ctx.env.bakeShadows();
  // the forge-rise animation is still settling — re-bake once it lands
  setTimeout(() => { if (tok === state.token) ctx.env.bakeShadows(); }, 1500);
  const storyNames: Record<string, string> = {
    threshold: "Gate", archive: "Archive", ossuary: "Ossuary", forge: "Forge",
    pilgrim: "Pilgrim Court", overgrowth: "Wild Ruin", sanctum: "Sanctum",
  };
  const roleOrder = ["threshold", "archive", "ossuary", "forge", "pilgrim", "overgrowth"];
  const presentRoles = new Set(macro.map((cell) => cell.role));
  const story = roleOrder.filter((role) => presentRoles.has(role as typeof macro[number]["role"]))
    .map((role) => storyNames[role]);
  story.push(storyNames.sanctum);
  ctx.hud.name.textContent = `${spatialPlan.stats.districts} districts · ${story.join(" → ")}`;
  const floorSum = layouts.reduce((s2, l) => s2 + l.stats.floor, 0);
  const forgeMs = Math.round(performance.now() - tForge);
  ctx.hud.seed.textContent = `seed ${seed} · ${spatialPlan.stats.layers} layers · ${spatialPlan.stats.fusedLinks} fused seams · ${spatialPlan.stats.crossBlockCourts} cross-block courts · ${floorSum} floor · forged in ${forgeMs}ms`;
  ctx.reportForgeStage?.("assembling", {
    token: tok, seed, mode: "chain", detail: "scene graph complete", completed: nIsl, total: nIsl,
  });
  const url = new URL(location.href);
  url.searchParams.set("seed", String(seed));
  url.searchParams.delete("mode"); // chain forge is the default mode
  history.replaceState(null, "", url);
}

export type { Layout };
