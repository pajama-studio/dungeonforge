// The shared render kit: geometries + materials, built once per session and
// reused by every regeneration (see geometries.ts / materials.ts for why).

import { makeGeometries, type GeoKit } from "./geometries";
import { makeMaterials, type MatKit } from "./materials";

export { shadeFaces } from "./geometries";
export type Kit = GeoKit & MatKit;

let kit: Kit | null = null;

export function getKit(): Kit {
  if (!kit) kit = { ...makeGeometries(), ...makeMaterials() };
  return kit;
}
