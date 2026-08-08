// Paired steady-state gameplay benchmark. Each sample renders the same scene
// once idle, then advances hero animation + enemy AI/instances and renders it
// again. Queue waits make the delta include real WebGPU uploads/submission.

import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const port = Number(args.get("--port") ?? 9337);
const rounds = Number(args.get("--rounds") ?? 100);
const warmup = Number(args.get("--warmup") ?? 30);
const needle = args.get("--url") ?? "127.0.0.1:4173";
const output = args.get("--output");
const screenshot = args.get("--screenshot");
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
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data), job = pending.get(message.id);
  if (!job) return;
  pending.delete(message.id);
  message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const callId = ++id;
  pending.set(callId, { resolve, reject });
  ws.send(JSON.stringify({ id: callId, method, params }));
});

await call("Page.reload", { ignoreCache: true });
await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
const evaluated = await call("Runtime.evaluate", {
  expression: `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const deadline=performance.now()+45000;
    while((!window.__df?.decorReady)&&performance.now()<deadline) await sleep(100);
    if(!window.__df?.decorReady) throw new Error('render did not become ready');
    const df=window.__df;
    await df.startRogueRun();
    const renderer=df.ctx.renderer, queue=renderer.backend?.device?.queue;
    renderer.setAnimationLoop(null);
    df.controls.autoRotate=false;
    df.setAllDetail(true);
    const done=()=>queue?.onSubmittedWorkDone?.()??Promise.resolve();
    const draw=async()=>{const t=performance.now();df.postProcessing.render();await done();return performance.now()-t};
    const stepGame=()=>{
      const t=performance.now();
      const player=df.player;
      player.update(1/60,{f:0,s:0},0,df.ctx.walk.sample);
      df.ctx.actors.stepCombat(1/60,player.group.position,df.ctx.walk.sample,df.rogue.state.attack,false);
      df.ctx.actors.tick(performance.now()/1000,1/60);
      return performance.now()-t;
    };
    if (${Boolean(process.argv.includes("--screenshot"))}) {
      const p=df.player.group.position, camera=df.camera;
      camera.position.set(p.x+4.2,p.y+3.2,p.z+5.2);
      camera.lookAt(p.x,p.y+1.15,p.z);
    }
    for(let i=0;i<${warmup};i++){stepGame();await draw();}
    const samples=[];
    for(let loop=1;loop<=${rounds};loop++){
      const idleFrameMs=await draw();
      const cpuUpdateMs=stepGame();
      const gameFrameMs=await draw();
      samples.push({loop,idleFrameMs,cpuUpdateMs,gameFrameMs,totalGameMs:cpuUpdateMs+gameFrameMs});
    }
    return {samples,enemies:df.rogue.state.enemiesAlive,gpuWait:Boolean(queue?.onSubmittedWorkDone)};
  })()`,
  awaitPromise: true,
  returnByValue: true,
  timeout: 180000,
});
if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
const data = evaluated.result.value;
const q = (key, p) => {
  const values = data.samples.map((sample) => sample[key]).sort((a, b) => a - b);
  const at = (values.length - 1) * p, lo = Math.floor(at), hi = Math.ceil(at);
  return values[lo] + (values[hi] - values[lo]) * (at - lo);
};
const result = {
  schema: 1,
  label: "roguelike-gameplay-paired",
  workload: { rounds, warmup, url: target.url, enemies: data.enemies },
  summary: {
    idleMedianMs: q("idleFrameMs", 0.5),
    idleP95Ms: q("idleFrameMs", 0.95),
    cpuUpdateMedianMs: q("cpuUpdateMs", 0.5),
    cpuUpdateP95Ms: q("cpuUpdateMs", 0.95),
    gameRenderMedianMs: q("gameFrameMs", 0.5),
    totalGameMedianMs: q("totalGameMs", 0.5),
    totalGameP95Ms: q("totalGameMs", 0.95),
    gpuWait: data.gpuWait,
  },
  samples: data.samples,
};
if (output) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
}
if (screenshot) {
  const captured = await call("Page.captureScreenshot", { format: "png" });
  mkdirSync(dirname(screenshot), { recursive: true });
  writeFileSync(screenshot, Buffer.from(captured.data, "base64"));
}
console.log(JSON.stringify(result));
ws.close();
