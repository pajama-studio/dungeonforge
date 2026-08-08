// Offline-only cemetery asset bake. The runtime deliberately does not import
// the generator (and its CSG dependencies): first paint stays small and the
// resulting trees can be rendered as three InstancedMesh LOD tiers.
// Source generator: https://github.com/pajama-studio/lowpoly-tree-generator

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  buildLowpolyTreePreviewGeometry,
  createLowpolyTreeRecipe,
} from "../../lowpoly-tree-generator/src/index.js";

const output = resolve("public/assets/abyss/cemetery/dead-tree-lods.json");

const shared = {
  height: 8,
  baseRadius: 0.55,
  tipRadius: 0.12,
  rootLength: 1.25,
  branchCount: 6,
  branchStart: 0.28,
  branchLength: 3.0,
  branchLift: 0.1,
  branchArc: 0.76,
  branchCurve: 0.62,
  branchSpread: 0.92,
  secondaryBranchLength: 1.65,
  secondaryBranchLift: 0.16,
  canopyEnabled: false,
  // Cold blue-black bark; vertex colour is retained by every LOD.
  barkColor: 0x394b5d,
};

const archetypes = {
  crookedNeck: {
    leanX: 0.95, leanZ: -0.28,
    bendX: 1.75, bendZ: -0.65,
    upperBendX: -1.4, upperBendZ: 0.45,
    sCurveX: 0.78, tipCurlX: -0.72, tipCurlZ: 0.55,
    branchPhase: 0.18,
  },
  splitWidow: {
    leanX: -0.38, leanZ: 0.8,
    bendX: -0.9, bendZ: 1.5,
    upperBendX: 1.05, upperBendZ: -1.18,
    sCurveZ: 0.72, tipCurlX: 0.5, tipCurlZ: -0.9,
    branchCount: 7, branchStart: 0.22, branchPhase: 0.51,
    secondaryBranchCount: 3,
  },
  stormClaw: {
    leanX: -0.82, leanZ: -0.6,
    bendX: -1.35, bendZ: -1.15,
    upperBendX: -0.85, upperBendZ: 1.22,
    sCurveX: -0.62, tipCurlX: 0.82, tipCurlZ: 0.68,
    branchLength: 3.35, branchLift: -0.02, branchPhase: 0.82,
  },
};

const tiers = {
  near: {
    sections: 7, sides: 6,
    rootCount: 5, rootSegments: 3, rootProfileSides: 3,
    branchSegments: 4, branchSides: 4,
    secondaryBranchCount: 2, secondaryBranchSegments: 3, secondaryBranchSides: 3,
  },
  mid: {
    sections: 5, sides: 5,
    rootCount: 4, rootSegments: 2, rootProfileSides: 3,
    branchSegments: 3, branchSides: 3,
    secondaryBranchCount: 1, secondaryBranchSegments: 2, secondaryBranchSides: 3,
  },
  far: {
    sections: 4, sides: 3,
    rootCount: 0,
    branchSegments: 2, branchSides: 3,
    secondaryBranchCount: 0,
  },
};

const geometries = {};
const stats = {};
for (const [archetype, shape] of Object.entries(archetypes)) {
  geometries[archetype] = {};
  stats[archetype] = {};
  for (const [tier, detail] of Object.entries(tiers)) {
    const recipe = createLowpolyTreeRecipe({ ...shared, ...shape, ...detail }, {
      kind: "deadTree",
      name: `Abyss ${archetype} ${tier}`,
    });
    const built = buildLowpolyTreePreviewGeometry(recipe);
    built.geometry.name = `abyssDeadTree-${archetype}-${tier}`;
    geometries[archetype][tier] = built.geometry.toJSON();
    stats[archetype][tier] = built.stats;
    built.geometry.dispose();
  }
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify({
  schema: 1,
  source: "pajama-studio/lowpoly-tree-generator",
  preset: "leafless-crooked-grove",
  geometries,
  stats,
})}\n`);
console.log(JSON.stringify({ output, stats }, null, 2));
