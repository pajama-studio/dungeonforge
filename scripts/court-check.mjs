import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const port = Number(args.get("--port") ?? 9337);
const needle = args.get("--url") ?? "127.0.0.1:4173";
const screenshot = args.get("--screenshot") ?? "perf/cross-block-court.png";
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((entry) => entry.type === "page" && entry.url.includes(needle));
if (!target) throw new Error(`No page containing ${needle}`);

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

const evaluated = await call("Runtime.evaluate", {
  expression: `(async()=>{
    const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
    const deadline=performance.now()+30000;
    while(!window.__df?.decorReady && performance.now()<deadline) await sleep(100);
    if(!window.__df?.decorReady) throw new Error("Dungeonforge did not become ready");
    const df=window.__df;
    const courts=[];
    df.ctx.scene.traverse(object=>{ if(object.name==="district-court" && object.visible) courts.push(object); });
    if(courts.length===0) throw new Error("Seed generated no cross-block court");
    const court=courts[0];
    court.updateWorldMatrix(true,true);
    const stones=court.children.find(child=>child.isInstancedMesh && child.count>0);
    if(!stones?.boundingSphere) throw new Error("Court has no bounded stone instances");
    const stoneInstances=stones.count;
    const center=stones.boundingSphere.center.clone();
    court.localToWorld(center);
    df.ctx.renderer.setAnimationLoop(null);
    df.setAllDetail(true);
    df.controls.target.copy(center);
    df.camera.position.set(center.x+17,center.y+13,center.z+19);
    df.camera.lookAt(center.x,center.y+0.8,center.z);
    df.postProcessing.render();
    await (df.ctx.renderer.backend?.device?.queue?.onSubmittedWorkDone?.() ?? Promise.resolve());
    const route=df.nav.tour();
    let ungrounded=0,blocked=0;
    for(const point of route?.pts??[]){
      if(!df.ctx.walk.sample(point.x,point.z,point.y).ok) ungrounded++;
      if(df.ctx.walk.isBlocked(point.x,point.y,point.z)) blocked++;
    }
    return {courts:courts.length,stoneInstances,center:{x:center.x,y:center.y,z:center.z},routePoints:route?.pts.length??0,unreachable:route?.unreachable.length??-1,ungrounded,blocked};
  })()`,
  awaitPromise: true,
  returnByValue: true,
  timeout: 120000,
});
if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text);
const report = evaluated.result.value;
const capture = await call("Page.captureScreenshot", { format: "png" });
mkdirSync(dirname(screenshot), { recursive: true });
writeFileSync(screenshot, Buffer.from(capture.data, "base64"));
console.log(JSON.stringify(report));
ws.close();
if (report.unreachable !== 0 || report.ungrounded !== 0 || report.blocked !== 0) process.exitCode = 1;
