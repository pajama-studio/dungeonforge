import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const opts = new Map();
for (let i = 2; i < process.argv.length; i += 2) opts.set(process.argv[i], process.argv[i + 1]);
const port = Number(opts.get("--port") ?? 9337);
const output = opts.get("--output") ?? "artifacts/tripo/oracle/runtime-check.json";
const screenshot = opts.get("--screenshot") ?? "artifacts/tripo/oracle/runtime-check.png";
const seed = opts.get("--seed") ?? "359139884";

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
const consoleErrors = [];
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Runtime.exceptionThrown") consoleErrors.push(message.params.exceptionDetails.text);
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
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
await call("Page.navigate", {
  url: `http://127.0.0.1:4173/?seed=${seed}&gen=typescript&islands=8&rev=tripo-near-${Date.now()}`,
});

const result = await call("Runtime.evaluate", {
  expression: `(async()=>{
    const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
    const deadline=performance.now()+90000;
    while(!window.__df?.coreReady&&performance.now()<deadline)await sleep(10);
    if(!window.__df?.coreReady)throw Error('core-ready timeout');
    const firstVisibleMs=window.__df.startupTiming.firstVisibleAt-window.__df.startupTiming.startedAt;
    let oracle;
    while(!(oracle=window.__df.ctx.scene.getObjectByName('abyssal-cephalopod-oracle'))&&performance.now()<deadline)await sleep(50);
    while(oracle?.userData.streamState!=='ready'&&performance.now()<deadline)await sleep(50);
    if(oracle?.userData.streamState!=='ready')throw Error('oracle stream timeout: '+oracle?.userData.streamState);
    const THREE=await import('/node_modules/.vite/deps/three_webgpu.js');
    const box=new THREE.Box3().setFromObject(oracle);
    const center=box.getCenter(new THREE.Vector3());
    const size=box.getSize(new THREE.Vector3());
    const mazeCenter=window.__df.controls.target.clone();
    const distanceXZ=Math.hypot(center.x-mazeCenter.x,center.z-mazeCenter.z);
    const focus=mazeCenter.clone().lerp(center,0.62);
    const span=Math.max(distanceXZ,size.length());
    window.__df.controls.autoRotate=false;
    window.__df.controls.target.copy(focus);
    window.__df.camera.position.copy(focus).add(new THREE.Vector3(0.72,0.48,0.78).normalize().multiplyScalar(span*1.15));
    window.__df.camera.lookAt(focus);
    window.__df.camera.updateProjectionMatrix();
    document.querySelectorAll('#hud,#runHud,#runToast,#runReward,#modes,#tools,#params,#tip,#loading').forEach(node=>node.style.display='none');
    window.__df.postProcessing.render();
    window.__df.postProcessing.render();
    await window.__df.ctx.renderer.backend?.device?.queue?.onSubmittedWorkDone?.();
    const resource=performance.getEntriesByType('resource').find(entry=>entry.name.endsWith('/assets/abyss/oracle/oracle-render-30k.glb'));
    return {
      firstVisibleMs,
      coreReadyMs:window.__df.startupTiming.coreReadyAt-window.__df.startupTiming.startedAt,
      decorReadyMs:window.__df.startupTiming.decorReadyAt-window.__df.startupTiming.startedAt,
      streamState:oracle.userData.streamState,
      childNames:oracle.children.map(child=>child.name),
      mazeDistanceXZ:distanceXZ,
      boundsSize:size.toArray(),
      resource:resource&&{startTime:resource.startTime,duration:resource.duration,transferSize:resource.transferSize,decodedBodySize:resource.decodedBodySize},
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
  timeout: 100000,
});
if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
const report = { ...result.result.value, consoleErrors };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
const captured = await call("Page.captureScreenshot", { format: "png" });
mkdirSync(dirname(screenshot), { recursive: true });
writeFileSync(screenshot, Buffer.from(captured.data, "base64"));
console.log(JSON.stringify(report));
ws.close();
