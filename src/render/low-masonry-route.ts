export const LOW_MASONRY_ROUTE = {
  farShadow: 0,
  farPlain: 1,
  farMiddleShadow: 2,
  farMiddlePlain: 3,
  middleShadow: 4,
  middlePlain: 5,
  allShadow: 6,
  allPlain: 7,
} as const;

export type LowMasonryRoute = typeof LOW_MASONRY_ROUTE[keyof typeof LOW_MASONRY_ROUTE];
export type LowMasonryBucket = "shadow" | "plain" | null;

/** CPU mirror of the compute shader's route table. LOD 3 is the internal
 * hidden/occluded tier; public slot tiers remain 0 far, 1 middle and 2 high. */
export function lowMasonryBucket(route: LowMasonryRoute, lod: number): LowMasonryBucket {
  switch (route) {
    case LOW_MASONRY_ROUTE.farShadow: return lod === 0 ? "shadow" : null;
    case LOW_MASONRY_ROUTE.farPlain: return lod === 0 ? "plain" : null;
    case LOW_MASONRY_ROUTE.farMiddleShadow: return lod <= 1 ? "shadow" : null;
    case LOW_MASONRY_ROUTE.farMiddlePlain: return lod <= 1 ? "plain" : null;
    case LOW_MASONRY_ROUTE.middleShadow: return lod === 1 ? "shadow" : null;
    case LOW_MASONRY_ROUTE.middlePlain: return lod === 1 ? "plain" : null;
    case LOW_MASONRY_ROUTE.allShadow: return lod <= 2 ? "shadow" : null;
    case LOW_MASONRY_ROUTE.allPlain: return lod <= 2 ? "plain" : null;
  }
}
