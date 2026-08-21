import { describe, expect, it } from "vitest";

import {
  establishingDistanceScale,
  establishingLandmarkWeight,
  establishingVerticalFov,
} from "./framing";

describe("establishing shot framing", () => {
  it("keeps the authored framing at 4:3 and wider", () => {
    expect(establishingDistanceScale(4 / 3)).toBe(1);
    expect(establishingDistanceScale(16 / 9)).toBe(1);
    expect(establishingVerticalFov(16 / 9)).toBe(36);
    expect(establishingLandmarkWeight(4 / 3)).toBe(0.78);
    expect(establishingLandmarkWeight(16 / 9)).toBe(0.78);
  });

  it("backs up and recentres toward the dungeon on portrait canvases", () => {
    expect(establishingDistanceScale(0.75)).toBe(1.15);
    expect(establishingVerticalFov(0.75)).toBe(46);
    expect(establishingLandmarkWeight(0.75)).toBeCloseTo(0.68);
    expect(establishingDistanceScale(1)).toBeGreaterThan(1);
    expect(establishingVerticalFov(1)).toBeGreaterThan(36);
  });

  it("handles malformed aspect values without destabilising the camera", () => {
    expect(establishingDistanceScale(0)).toBe(1);
    expect(establishingDistanceScale(Number.NaN)).toBe(1);
    expect(establishingVerticalFov(0)).toBe(36);
    expect(establishingVerticalFov(Number.NaN)).toBe(36);
    expect(establishingLandmarkWeight(Number.POSITIVE_INFINITY)).toBe(0.78);
  });
});
