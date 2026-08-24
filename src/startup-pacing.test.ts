import { describe, expect, it } from "vitest";

import {
  isEffectivelyVisible, parseStartupBatch, startupRenderWork,
  type VisibilityNode,
} from "./startup-pacing";

describe("startup batch pacing", () => {
  it("uses the authored fallback when the URL parameter is absent or empty", () => {
    expect(parseStartupBatch(null, 5, 12)).toBe(5);
    expect(parseStartupBatch("", 5, 12)).toBe(5);
    expect(parseStartupBatch("  ", 2, 8)).toBe(2);
  });

  it("accepts finite overrides and clamps them to the safe range", () => {
    expect(parseStartupBatch("4.6", 3, 12)).toBe(5);
    expect(parseStartupBatch("0", 3, 12)).toBe(1);
    expect(parseStartupBatch("99", 3, 12)).toBe(12);
    expect(parseStartupBatch("-2", 3, 12, 0)).toBe(0);
    expect(parseStartupBatch("0", 3, 12, 0)).toBe(0);
  });

  it("rejects non-numeric overrides", () => {
    expect(parseStartupBatch("fast", 3, 12)).toBe(3);
    expect(parseStartupBatch("Infinity", 3, 12)).toBe(3);
  });

  it("rejects drawable children hidden by any ancestor", () => {
    const root: VisibilityNode = { visible: true, parent: null };
    const dormantGroup: VisibilityNode = { visible: false, parent: root };
    const visibleChild: VisibilityNode = { visible: true, parent: dormantGroup };
    expect(isEffectivelyVisible(visibleChild)).toBe(false);
    dormantGroup.visible = true;
    expect(isEffectivelyVisible(visibleChild)).toBe(true);
    visibleChild.visible = false;
    expect(isEffectivelyVisible(visibleChild)).toBe(false);
  });

  it("weights material, shadow and visible group children", () => {
    const basic = { material: { type: "MeshBasicNodeMaterial" } };
    const standard = { material: { type: "MeshStandardNodeMaterial" } };
    const shadowed = { ...standard, castShadow: true };
    expect(startupRenderWork(basic)).toBe(1);
    expect(startupRenderWork(standard)).toBe(2);
    expect(startupRenderWork(shadowed)).toBe(3);
    expect(startupRenderWork({
      children: [basic, standard, { ...shadowed, visible: false }],
    })).toBe(3);
  });
});
