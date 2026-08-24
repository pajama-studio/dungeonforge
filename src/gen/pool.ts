// Generation runs in a WORKER POOL (pure data, transferable typed arrays) —
// islands of a chain generate in parallel; the main thread only fills instance
// buffers. Requests are id-tagged so stale responses are dropped.

import type { Layout, Params } from "./dungeon";

export class GenPool {
  readonly backend = "typescript" as const;
  private workers: Worker[];
  private nextId = 0;
  private rr = 0;
  private pending = new Map<number, {
    resolve: (layout: Layout) => void;
    reject: (error: Error) => void;
  }>();

  constructor(size = Math.min(4, Math.max(2, Math.floor((navigator.hardwareConcurrency || 4) / 2)))) {
    this.workers = Array.from({ length: size }, () =>
      new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }));
    for (const w of this.workers) {
      w.onmessage = (e: MessageEvent<{
        id: number;
        layout?: Layout;
        error?: string;
      }>) => {
        const request = this.pending.get(e.data.id);
        if (e.data.error || !e.data.layout) {
          request?.reject(new Error(e.data.error ?? "Dungeon worker returned no layout"));
        } else {
          request?.resolve(e.data.layout);
        }
        this.pending.delete(e.data.id);
      };
    }
  }

  generate(seed: number, params: Params, overrides: Partial<Params> = {}): Promise<Layout> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      const worker = this.rr++ % this.workers.length;
      this.workers[worker].postMessage({
        id, seed, params: { ...params, ...overrides },
      });
    });
  }
}
