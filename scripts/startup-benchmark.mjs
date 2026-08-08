// Cold-navigation startup timing through the existing Chrome CDP session.
// Measures the app's own milestones from module evaluation, avoiding network
// clock skew and keeping before/after runs directly comparable.

import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const opts = new Map();
for (let i = 2; i < process.argv.length; i += 2) opts.set(process.argv[i], process.argv[i + 1]);
const port = Number(opts.get("--port") ?? 9337);
const needle = opts.get("--url") ?? "127.0.0.1:4173";
const seed = opts.get("--seed") ?? "2820997495";
const islands = opts.get("--islands") ?? "20";
const output = opts.get("--output");
const waitDecor = opts.get("--decor") !== "false";

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find((entry) => entry.type === "page" && entry.url.includes(needle));
if (!page) throw new Error(`No page containing ${needle}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let nextId = 0;
const pending = new Map();
let loaded = null;
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Page.loadEventFired") loaded?.();
  if (!message.id) return;
  const job = pending.get(message.id);
  if (!job) return;
  pending.delete(message.id);
  message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

await call("Page.enable");
await call("Runtime.enable");
const pageLoaded = new Promise((resolve) => { loaded = resolve; });
const url = new URL(page.url);
url.searchParams.set("seed", seed);
url.searchParams.set("islands", islands);
url.searchParams.set("rev", `startup-${Date.now()}`);
await call("Page.navigate", { url: url.href });
await Promise.race([pageLoaded, new Promise((_, reject) => setTimeout(() => reject(new Error("load timeout")), 15000))]);
loaded = null;

const expression = `(async()=>{
  const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
  const deadline=performance.now()+120000;
  while(!window.__df?.coreReady&&performance.now()<deadline)await sleep(10);
  if(!window.__df?.coreReady)throw Error('core-ready timeout');
  const atCore={...window.__df.startupTiming,observedAt:performance.now(),worlds:window.__df.ctx.worlds.length,
    generationMs:window.__df.ctx.walk.islands.map(island=>island.l.stats.genMs)};
  if(${waitDecor}){
    while(!window.__df?.decorReady&&performance.now()<deadline)await sleep(25);
    if(!window.__df?.decorReady)throw Error('decor-ready timeout');
  }
  const t={...window.__df.startupTiming};
  const loading=getComputedStyle(document.getElementById('loading'));
  return {url:location.href,atCore,final:t,loadingOpacity:Number(loading.opacity),worlds:window.__df.ctx.worlds.length,
    generatorBackend:window.__df.ctx.gen.backend,
    wasmResources:performance.getEntriesByType('resource').filter(entry=>entry.name.includes('.wasm')).map(entry=>({name:entry.name,duration:entry.duration,bytes:entry.transferSize})),
    firstVisibleMs:(t.firstVisibleAt||t.coreReadyAt)-t.startedAt,
    coreReadyMs:t.coreReadyAt-t.startedAt,forgeReadyMs:t.forgeReadyAt?t.forgeReadyAt-t.startedAt:null,
    decorReadyMs:t.decorReadyAt?t.decorReadyAt-t.startedAt:null};
})()`;
const evaluated = await call("Runtime.evaluate", {
  expression, awaitPromise: true, returnByValue: true, timeout: 130000,
});
if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
const result = evaluated.result.value;
if (output) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result));
ws.close();
