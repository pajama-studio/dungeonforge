// The shared context threaded through the three world modes (chain forge,
// 3×3×3 cube, endless streaming). One mutable state bag instead of module
// globals, so each mode stays a plain function.

import type * as THREE from "three/webgpu";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Params } from "../gen/dungeon";
import type { GenPool } from "../gen/pool";
import type { WorldHandle } from "../scene/build";
import type { Environment } from "../scene/env";
import type { LightPool } from "./lights";
import type { WalkMap } from "./walkmap";
import type { StairTowers } from "./stairs";
import type { DungeonActors } from "./actors";

export type ForgeStage = "requested" | "generating" | "assembling" | "gpu-upload" | "ready" | "failed";

export interface ForgeStageDetail {
  /** Monotonic forge token. Reports from superseded runs are ignored. */
  token: number;
  seed: number;
  mode: string;
  detail?: string;
  completed?: number;
  total?: number;
  error?: string;
}

export interface Ctx {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGPURenderer;
  controls: OrbitControls;
  env: Environment;
  gen: GenPool;
  lights: LightPool;
  walk: WalkMap;
  stairs: StairTowers;
  actors: DungeonActors;
  /** Optional UI/telemetry sink. World builders report semantic stages while
   *  main.ts owns the final GPU queue completion and ready transition. */
  reportForgeStage?: (stage: ForgeStage, detail: ForgeStageDetail) => void;
  /** live handles — ticked every frame */
  worlds: WorldHandle[];
  genParams: Params;
  hud: { name: HTMLElement; seed: HTMLElement };
  state: {
    seed: number;
    endless: boolean;
    /** camera-refit threshold memory for forge() */
    lastExtent: number;
    /** forge token: a newer forge/cube supersedes an in-flight one */
    token: number;
    /** pixel-ratio CEILING for the current mode/world size — the adaptive-DPR
     *  loop in main.ts walks the actual ratio between 1.0 and this */
    prCap: number;
  };
}
