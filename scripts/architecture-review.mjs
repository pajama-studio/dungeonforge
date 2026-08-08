import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const opts = new Map();
for (let i = 2; i < process.argv.length; i += 2) opts.set(process.argv[i], process.argv[i + 1]);
const port = Number(opts.get("--port") ?? 9337);
const seed = opts.get("--seed") ?? "359139884";
const output = opts.get("--output") ?? "artifacts/architecture/facade-review.png";
const reportFile = output.replace(/\.png$/i, ".json");

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find((entry) => entry.type === "page" && entry.url.includes("127.0.0.1:4173"));
if (!page) throw new Error("Dungeonforge page not found");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let nextId = 0;
const pending = new Map();
const errors = [];
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
  if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) {
    errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
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

await call("Runtime.enable");
await call("Page.enable");
await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await call("Page.navigate", { url: `http://127.0.0.1:4173/?seed=${seed}&gen=typescript&islands=8&architecture=${Date.now()}` });
const evaluated = await call("Runtime.evaluate", {
  expression: `(async()=>{
    const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
    const deadline=performance.now()+30000;
    while((!window.__df?.coreReady||!window.__df?.decorReady)&&performance.now()<deadline)await sleep(50);
    const {ctx,postProcessing}=window.__df;
    let bays=[];
    ctx.scene.traverse(object=>{if(object.name==='architecturalBays'&&object.count>0)bays.push(object)});
    while(!bays.length&&performance.now()<deadline){
      await sleep(50); bays=[];
      ctx.scene.traverse(object=>{if(object.name==='architecturalBays'&&object.count>0)bays.push(object)});
    }
    if(!bays.length)throw Error('no architectural bays');
    const mesh=bays.sort((a,b)=>b.count-a.count)[0];
    mesh.updateWorldMatrix(true,false);
    const local=mesh.matrixWorld.clone().identity();
    mesh.getMatrixAt(0,local);
    const world=mesh.matrixWorld.clone().multiply(local);
    const center=mesh.position.clone().set(0,2.5,0).applyMatrix4(world);
    const normal=mesh.position.clone().set(0,0,1).transformDirection(world);
    const up=mesh.position.clone().set(0,1,0).transformDirection(world);
    ctx.camera.position.copy(center).addScaledVector(normal,18).addScaledVector(up,2.5);
    ctx.camera.lookAt(center.clone().addScaledVector(up,0.8));
    ctx.camera.near=.2; ctx.camera.far=Math.max(ctx.camera.far,1200); ctx.camera.updateProjectionMatrix();
    window.__df.controls.autoRotate=false;
    ctx.renderer.setAnimationLoop(null);
    document.querySelectorAll('#hud,#runHud,#runToast,#runReward,#modes,#tools,#params,#tip,#loading,#forgeStatus,#forgeSnapshot').forEach(node=>node.style.display='none');
    postProcessing.render(); postProcessing.render();
    await ctx.renderer.backend?.device?.queue?.onSubmittedWorkDone?.();
    return {camera:ctx.camera.position.toArray(),focus:center.toArray(),normal:normal.toArray(),
      bayObjects:bays.length,bayInstances:bays.reduce((sum,item)=>sum+item.count,0),
      towerRoofInstances:(()=>{let n=0;ctx.scene.traverse(o=>{if(o.name==='towerRoofs')n+=o.count??0});return n})(),
      trianglesPerBay:mesh.geometry.index?mesh.geometry.index.count/3:mesh.geometry.getAttribute('position').count/3,
      startup:window.__df.startupTiming};
  })()`,
  awaitPromise: true,
  returnByValue: true,
  timeout: 40000,
});
if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
const captured = await call("Page.captureScreenshot", { format: "png" });
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, Buffer.from(captured.data, "base64"));
const report = { ...evaluated.result.value, errors, output };
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
ws.close();
