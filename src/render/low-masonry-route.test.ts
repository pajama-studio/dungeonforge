import { describe, expect, it } from "vitest";

import { LOW_MASONRY_ROUTE, lowMasonryBucket } from "./low-masonry-route";

describe("low masonry GPU route table", () => {
  it("routes far-only sources to exactly one far bucket", () => {
    expect([0, 1, 2, 3].map((lod) => lowMasonryBucket(LOW_MASONRY_ROUTE.farShadow, lod)))
      .toEqual(["shadow", null, null, null]);
    expect([0, 1, 2, 3].map((lod) => lowMasonryBucket(LOW_MASONRY_ROUTE.farPlain, lod)))
      .toEqual(["plain", null, null, null]);
  });

  it("keeps bridge/support shells through far and middle tiers", () => {
    expect([0, 1, 2, 3].map((lod) => lowMasonryBucket(LOW_MASONRY_ROUTE.farMiddleShadow, lod)))
      .toEqual(["shadow", "shadow", null, null]);
    expect([0, 1, 2, 3].map((lod) => lowMasonryBucket(LOW_MASONRY_ROUTE.farMiddlePlain, lod)))
      .toEqual(["plain", "plain", null, null]);
  });

  it("shows exact-transform low twins only in the middle tier", () => {
    expect([0, 1, 2, 3].map((lod) => lowMasonryBucket(LOW_MASONRY_ROUTE.middleShadow, lod)))
      .toEqual([null, "shadow", null, null]);
    expect([0, 1, 2, 3].map((lod) => lowMasonryBucket(LOW_MASONRY_ROUTE.middlePlain, lod)))
      .toEqual([null, "plain", null, null]);
  });

  it("keeps non-LOD props in every playable tier but hides dormant slots", () => {
    expect([0, 1, 2, 3].map((lod) => lowMasonryBucket(LOW_MASONRY_ROUTE.allShadow, lod)))
      .toEqual(["shadow", "shadow", "shadow", null]);
    expect([0, 1, 2, 3].map((lod) => lowMasonryBucket(LOW_MASONRY_ROUTE.allPlain, lod)))
      .toEqual(["plain", "plain", "plain", null]);
  });
});
