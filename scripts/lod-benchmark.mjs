// Browser LOD transition benchmark. Measures the CPU visibility swap and the
// first GPU-complete frame after far→near / near→far changes separately.

import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const port = Number(args.get("--port") ?? 9337);
const rounds = Number(args.get("--rounds") ?? 100);
const needle = args.get("--url") ?? "127.0.0.1:4173";
const output = args.get("--output");
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((t) => t.type === "page" && t.url.includes(needle));
if (!target) throw new Error(`No page containing ${needle}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", ({ data }) => {
  const msg = JSON.parse(data), p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

await call("Page.reload", { ignoreCache: true });
const evaluated = await call("Runtime.evaluate", {
  expression: `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const deadline=performance.now()+45000;
    while((!window.__df || !window.__df.decorReady) && performance.now()<deadline) await sleep(100);
    if(!window.__df?.decorReady) throw new Error("detail warm-up did not finish");
    const df=window.__df, renderer=df.ctx.renderer;
    renderer.setAnimationLoop(null);
    const queue=renderer.backend?.device?.queue;
    const done=()=>queue?.onSubmittedWorkDone?.() ?? Promise.resolve();
    const draw=async()=>{const t=performance.now();df.postProcessing.render();await done();return performance.now()-t};
    for(let i=0;i<12;i++) await draw();
    const samples=[];
    for(let loop=1;loop<=${rounds};loop++){
      df.setAllDetail(false); await draw();
      let t=performance.now(); df.setAllDetail(true); const toggleOnMs=performance.now()-t;
      const firstOnMs=await draw(), steadyOnMs=await draw();
      t=performance.now(); df.setAllDetail(false); const toggleOffMs=performance.now()-t;
      const firstOffMs=await draw();
      samples.push({loop,toggleOnMs,firstOnMs,steadyOnMs,toggleOffMs,firstOffMs});
    }
    return {samples,gpuWait:Boolean(queue?.onSubmittedWorkDone)};
  })()`,
  awaitPromise: true,
  returnByValue: true,
  timeout: 120000,
});
if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
const data = evaluated.result.value;
const q = (key, p) => {
  const a = data.samples.map((s) => s[key]).sort((x, y) => x - y);
  const at = (a.length - 1) * p, lo = Math.floor(at), hi = Math.ceil(at);
  return a[lo] + (a[hi] - a[lo]) * (at - lo);
};
const result = {
  schema: 1,
  label: "lod-transition-final",
  workload: { rounds, url: target.url },
  summary: {
    firstTransitionMs: data.samples[0].firstOnMs,
    transitionMedianMs: q("firstOnMs", 0.5),
    transitionP95Ms: q("firstOnMs", 0.95),
    transitionMaxMs: Math.max(...data.samples.map((s) => s.firstOnMs)),
    toggleMedianMs: q("toggleOnMs", 0.5),
    gpuWait: data.gpuWait,
  },
  samples: data.samples,
};
if (output) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result));
ws.close();
