// Paired real-WebGPU benchmark for a single island's far<->near LOD switch.
// Pipelines are already warm; each sample includes the state mutation, one
// post frame and queue completion, which is the hitch the user perceives.

import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const opts = new Map();
for (let i = 2; i < process.argv.length; i += 2) opts.set(process.argv[i], process.argv[i + 1]);
const port = Number(opts.get("--port") ?? 9337);
const rounds = Number(opts.get("--rounds") ?? 100);
const label = opts.get("--label") ?? "lod-transition";
const output = opts.get("--output");
const needle = opts.get("--url") ?? "127.0.0.1:4173";
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((entry) => entry.type === "page" && entry.url.includes(needle));
if (!target) throw new Error(`No page containing ${needle}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let id = 0;
const pending = new Map();
let pageLoadResolve = null;
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Page.loadEventFired") { pageLoadResolve?.(); return; }
  if (!message.id) return;
  const job = pending.get(message.id);
  if (!job) return;
  pending.delete(message.id);
  message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const callId = ++id;
  pending.set(callId, { resolve, reject });
  ws.send(JSON.stringify({ id: callId, method, params }));
});

await call("Runtime.enable");
await call("Page.enable");
const pageLoaded = new Promise((resolve) => { pageLoadResolve = resolve; });
await call("Page.reload", { ignoreCache: true });
await Promise.race([
  pageLoaded,
  new Promise((_, reject) => setTimeout(() => reject(new Error("Page reload timed out")), 15000)),
]);
pageLoadResolve = null;
await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
const evaluated = await call("Runtime.evaluate", {
  expression: `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const deadline=performance.now()+45000;
    while(!window.__df?.decorReady&&performance.now()<deadline) await sleep(100);
    if(!window.__df?.decorReady) throw new Error('render did not become ready');
    await sleep(3000);
    const df=window.__df, renderer=df.ctx.renderer, post=df.postProcessing;
    renderer.setAnimationLoop(null);
    df.controls.autoRotate=false;
    const queue=renderer.backend?.device?.queue;
    const wait=()=>queue?.onSubmittedWorkDone?.()??Promise.resolve();
    const draw=async()=>{ post.render(); await wait(); };
    df.setAllDetail(false);
    for(let i=0;i<20;i++) await draw();
    const islands=[...df.ctx.walk.islands].sort((a,b)=>a.slot-b.slot);
    const promote=[], demote=[], warm=[];
    for(let loop=0;loop<${rounds};loop++){
      const island=islands[loop%islands.length];
      const slots=[island.slot,1000+island.slot,3000+island.slot];
      while(!df.areSlotsLodWarm(slots,2)){
        const restore=df.stageSlotLodWarmup(slots,2);
        const wt=performance.now(); await draw(); restore?.();
        warm.push(performance.now()-wt);
      }
      let t=performance.now(); df.setSlotDetail(island.slot,true); await draw();
      promote.push(performance.now()-t);
      t=performance.now(); df.setSlotDetail(island.slot,false); await draw();
      demote.push(performance.now()-t);
    }
    return { promote,demote,warm,islands:islands.length };
  })()`,
  awaitPromise: true, returnByValue: true, timeout: 180000,
});
if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
const raw = evaluated.result.value;
const q = (values, n) => {
  const a = [...values].sort((x, y) => x - y), p = (a.length - 1) * n;
  const lo = Math.floor(p), hi = Math.ceil(p);
  return a[lo] + (a[hi] - a[lo]) * (p - lo);
};
const stats = (a) => ({ medianMs: q(a, 0.5), p95Ms: q(a, 0.95), maxMs: Math.max(...a) });
const report = {
  schema: 2, label, rounds, islands: raw.islands,
  warmFrames: raw.warm.length, warm: raw.warm.length ? stats(raw.warm) : null,
  promote: stats(raw.promote), demote: stats(raw.demote), samples: raw,
};
if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); }
console.log(JSON.stringify(report));
ws.close();
