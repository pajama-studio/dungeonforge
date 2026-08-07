import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const port = Number(args.get("--port") ?? 9338);
const screenshot = args.get("--screenshot") ?? "perf/architecture-occlusion.png";
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((item) => item.type === "page" && item.url.includes("127.0.0.1:4173"));
if (!target) throw new Error("Dungeonforge page not found");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data), job = pending.get(message.id);
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
await call("Page.reload", { ignoreCache: true });
const result = await call("Runtime.evaluate", {
  expression: `(async()=>{
    const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
    let deadline=performance.now()+45000;
    while((!window.__df?.decorReady) && performance.now()<deadline) await sleep(100);
    if(!window.__df?.decorReady) throw new Error("warm-up timeout");
    await window.__df.startWalk();
    deadline=performance.now()+45000;
    let hits;
    while(performance.now()<deadline){
      hits=window.__df.skeletonOccluders();
      if(hits.slots.size+hits.stairs.size>0) break;
      await sleep(80);
    }
    if(!hits || hits.slots.size+hits.stairs.size===0) throw new Error("route never entered an occluded view");
    await sleep(120);
    window.__df.ctx.renderer.setAnimationLoop(null);
    window.__df.postProcessing.render();
    await window.__df.ctx.renderer.backend?.device?.queue?.onSubmittedWorkDone?.();
    let xrayMeshes=0, fadedArchitecture=0, transparentPlayerMeshes=0;
    window.__df.ctx.scene.traverse((object)=>{
      if((object.name||"").includes("occluded-xray")) xrayMeshes++;
      if(object.visible && object.material?.name?.includes("occluding-")) fadedArchitecture++;
    });
    window.__df.player?.group.traverse((object)=>{
      if(object.material?.transparent && object.material?.opacity<0.99) transparentPlayerMeshes++;
    });
    return {
      slotHits:hits.slots.size, stairHits:hits.stairs.size,
      fadedArchitecture, xrayMeshes, transparentPlayerMeshes,
      walkU:window.__df.walkU,
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
  timeout: 120000,
});
if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
const capture = await call("Page.captureScreenshot", { format: "png" });
mkdirSync(dirname(screenshot), { recursive: true });
writeFileSync(screenshot, Buffer.from(capture.data, "base64"));
console.log(JSON.stringify(result.result.value));
ws.close();
