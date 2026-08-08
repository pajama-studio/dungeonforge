// End-to-end bridge contract: every rendered crossing has an analytic walk
// strip, a visible nav overlay strip, unblocked samples, and clean reforge
// teardown. Captures the first crossing from a close gameplay camera.

import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const opts = new Map();
for (let i = 2; i < process.argv.length; i += 2) opts.set(process.argv[i], process.argv[i + 1]);
const port = Number(opts.get("--port") ?? 9337);
const needle = opts.get("--url") ?? "127.0.0.1:4173";
const seed = opts.get("--seed") ?? "2820997495";
const screenshot = opts.get("--screenshot") ?? "artifacts/bridge-nav-final.png";
const styleScreenshot = opts.get("--style-screenshot");

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
const gpuErrors = [];
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Page.loadEventFired") loaded?.();
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    const line = message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
    if (/WebGPU|GPUValidation|CommandBuffer|buffer size/i.test(line)) gpuErrors.push(line);
  }
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
await call("Emulation.setDeviceMetricsOverride", {
  width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
});
const pageLoaded = new Promise((resolve) => { loaded = resolve; });
const url = new URL(page.url);
url.searchParams.set("seed", seed);
url.searchParams.set("islands", "20");
url.searchParams.set("rev", `bridge-${Date.now()}`);
await call("Page.navigate", { url: url.href });
await Promise.race([pageLoaded, new Promise((_, reject) => setTimeout(() => reject(new Error("load timeout")), 15000))]);
loaded = null;

const checked = await call("Runtime.evaluate", {
  expression: `(async()=>{
    const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
    const deadline=performance.now()+90000;
    while((!window.__df?.coreReady||!window.__df.startupTiming.forgeReadyAt)&&performance.now()<deadline)await sleep(20);
    const d=window.__df;
    if(!d?.startupTiming.forgeReadyAt)throw Error('forge-ready timeout');
    while(!d.decorReady&&performance.now()<deadline)await sleep(25);
    if(!d.decorReady)throw Error('decor-ready timeout');
    d.controls.autoRotate=false;
    d.setAllDetail(true);
    d.navOverlay.show();
    const bad=[];
    for(let linkIndex=0;linkIndex<d.ctx.walk.links.length;linkIndex++){
      const link=d.ctx.walk.links[linkIndex];
      for(let sample=0;sample<=20;sample++){
        const t=sample/20;
        const x=link.a.x+(link.b.x-link.a.x)*t;
        const z=link.a.z+(link.b.z-link.a.z)*t;
        const y=link.a.y+(link.b.y-link.a.y)*t+Math.sin(t*Math.PI)*link.arc+.05;
        const hit=d.ctx.walk.sample(x,z,y);
        if(!hit.ok||d.ctx.walk.isBlocked(x,y+.4,z)||Math.abs(hit.y-y)>.18)bad.push({linkIndex,sample,t,hit,expectedY:y});
      }
    }
    const link=d.ctx.walk.links.find(item=>Math.hypot(item.b.x-item.a.x,item.b.z-item.a.z)>8)||d.ctx.walk.links[0];
    if(!link)throw Error('no crossing generated');
    const center=link.a.clone().lerp(link.b,.5);center.y+=Math.sin(Math.PI*.5)*link.arc;
    const dx=link.b.x-link.a.x,dz=link.b.z-link.a.z,len=Math.hypot(dx,dz);
    const px=-dz/len,pz=dx/len;
    d.controls.target.copy(center).add({x:0,y:.5,z:0});
    d.camera.position.set(center.x+px*12-dx/len*5,center.y+9,center.z+pz*12-dz/len*5);
    d.camera.lookAt(d.controls.target);
    d.ctx.renderer.setPixelRatio(1);
    d.postProcessing.render();
    await d.ctx.renderer.backend?.device?.queue?.onSubmittedWorkDone?.();
    return {links:d.ctx.walk.links.length,bad,overlay:{...d.navOverlay.stats},startup:{...d.startupTiming}};
  })()`,
  awaitPromise: true, returnByValue: true, timeout: 100000,
});
if (checked.exceptionDetails) throw new Error(checked.exceptionDetails.text);
const result = checked.result.value;
const capture = await call("Page.captureScreenshot", { format: "png" });
mkdirSync(dirname(screenshot), { recursive: true });
writeFileSync(screenshot, Buffer.from(capture.data, "base64"));
if (styleScreenshot) {
  await call("Runtime.evaluate", {
    expression: `(async()=>{const d=window.__df;d.navOverlay.hide();d.postProcessing.render();await d.ctx.renderer.backend?.device?.queue?.onSubmittedWorkDone?.()})()`,
    awaitPromise: true, timeout: 30000,
  });
  const styleCapture = await call("Page.captureScreenshot", { format: "png" });
  mkdirSync(dirname(styleScreenshot), { recursive: true });
  writeFileSync(styleScreenshot, Buffer.from(styleCapture.data, "base64"));
}

const transition = await call("Runtime.evaluate", {
  expression: `(()=>{
    document.getElementById('btnNew').click();
    let visibleSlots=0,visibleSupports=0;
    window.__df.ctx.scene.traverse(object=>{
      if(!object.isGroup||!object.visible||object.userData.slot===undefined)return;
      visibleSlots++;
      if(object.name==='support-piers')visibleSupports++;
    });
    return {visibleSlots,visibleSupports,worldHandles:window.__df.ctx.worlds.length};
  })()`,
  returnByValue: true,
});
if (transition.exceptionDetails) throw new Error(transition.exceptionDetails.text);
result.reforgeImmediate = transition.result.value;
result.gpuErrors = gpuErrors;
result.failures = [];
if (result.bad.length) result.failures.push(`${result.bad.length} unwalkable bridge samples`);
if (result.overlay.links !== result.links || result.overlay.linkInstances < result.links) result.failures.push("bridge overlay incomplete");
if (result.reforgeImmediate.visibleSlots !== 0 || result.reforgeImmediate.visibleSupports !== 0) result.failures.push("stale slots visible at reforge boundary");
if (gpuErrors.length) result.failures.push(`${gpuErrors.length} WebGPU errors`);
console.log(JSON.stringify(result));
if (result.failures.length) process.exitCode = 1;
ws.close();
