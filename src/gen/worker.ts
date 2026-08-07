/// <reference lib="webworker" />
// Generation worker: the generator is pure data (zero THREE imports), so it
// runs entirely off the main thread. Typed arrays are transferred, not copied.

import { generate, type Layout, type Params } from "./dungeon";

self.onmessage = (e: MessageEvent<{ id: number; seed: number; params?: Partial<Params> }>) => {
  const { id, seed, params } = e.data;
  const layout = generate({ ...params, seed });
  const transfers = [
    layout.kind.buffer, layout.tier.buffer, layout.wallTop.buffer,
    layout.wallBase.buffer, layout.support.buffer, layout.stairMask.buffer,
    layout.redMask.buffer, layout.templeMask.buffer, layout.plazaMask.buffer,
    layout.doorMask.buffer, layout.shaftMask.buffer, layout.volumeMask.buffer,
  ];
  (self as unknown as Worker).postMessage({ id, layout }, transfers as Transferable[]);
};

export type GenRequest = { id: number; seed: number };
export type GenResponse = { id: number; layout: Layout };
