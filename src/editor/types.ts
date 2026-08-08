// Shared editor vocabulary. Kept dependency-free so the catalog, the gizmo
// core and the panel can all import it without a cycle.

import type * as THREE from "three/webgpu";

/** One entry in the asset library. `build()` returns a fresh, unparented
 *  object; the editor owns placement, naming and persistence from there. */
export interface AssetDef {
  id: string;
  label: string;
  group: string;
  /** emoji shown in the palette tile — cheap, themeable, zero image loads */
  icon: string;
  /** Streamed assets resolve asynchronously; kit primitives resolve instantly. */
  build: () => THREE.Object3D | Promise<THREE.Object3D>;
  /** default uniform scale applied at spawn */
  scale?: number;
  /** sits on the ground plane rather than at the focus point */
  grounded?: boolean;
}

/** A placed instance, as persisted. World transform only — the asset id is
 *  enough to rebuild the object, so saves stay tiny and version-tolerant. */
export interface PlacementRecord {
  uid: string;
  assetId: string;
  name: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

/** Everything an edited dungeon needs to come back exactly as it was. */
export interface SceneDocument {
  version: 1;
  seed: number;
  mode: string;
  params: Record<string, number | string | boolean>;
  placements: PlacementRecord[];
}

export type GizmoMode = "translate" | "rotate" | "scale";
