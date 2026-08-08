/* tslint:disable */
/* eslint-disable */

export class MazeCore {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly cycle_rank: number;
    readonly dead_ends: number;
    readonly open: Uint8Array;
    readonly rng_draws: number;
    readonly tier_span: number;
    readonly tiers: Int8Array;
    readonly vertical_edges: number;
}

export function generate_maze_core(size: number, seed: number, newest: number, braid: number, loops: number, height_amp: number, mound_height: number, volume_bias: Int8Array): MazeCore;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_mazecore_free: (a: number, b: number) => void;
    readonly generate_maze_core: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly mazecore_cycle_rank: (a: number) => number;
    readonly mazecore_dead_ends: (a: number) => number;
    readonly mazecore_open: (a: number, b: number) => void;
    readonly mazecore_rng_draws: (a: number) => number;
    readonly mazecore_tier_span: (a: number) => number;
    readonly mazecore_tiers: (a: number, b: number) => void;
    readonly mazecore_vertical_edges: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
