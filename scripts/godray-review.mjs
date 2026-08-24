import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const output = process.argv[2] ?? "artifacts/atmosphere/godray-aperture-review.png";
const pages = await (await fetch("http://127.0.0.1:9337/json/list")).json();
const page = pages.find((entry) => entry.type === "page" && entry.url.includes("127.0.0.1:4173"));
if (!page) throw new Error("Dungeonforge preview page not found");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let id = 0;
const pending = new Map();
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const requestId = ++id;
  pending.set(requestId, { resolve, reject });
  ws.send(JSON.stringify({ id: requestId, method, params }));
});

await call("Runtime.enable");
await call("Page.enable");
await call("Page.bringToFront");
await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
const review = await call("Runtime.evaluate", {
  expression: `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = performance.now() + 80000;
    while ((!window.__df?.coreReady || !window.__df?.ctx?.scene) && performance.now() < deadline) await sleep(100);
    const df = window.__df;
    if (!df?.coreReady) throw new Error('dungeon core did not become ready');
    const { ctx, controls, postProcessing } = df;
    const aperture = ctx.scene.getObjectByName('procedural-overhead-cavern-godray-aperture');
    const moon = ctx.scene.getObjectByProperty('isDirectionalLight', true);
    if (!aperture || !moon) throw new Error('godray aperture or moon missing');
    ctx.renderer.setAnimationLoop(null);
    controls.autoRotate = false;
    controls.enabled = false;
    document.querySelectorAll('#hud,#runHud,#runToast,#runReward,#modes,#tools,#params,#tip,#loading,#forgeStatus,#forgeSnapshot,#dragonGizmoPanel').forEach((node) => node.style.display = 'none');
    const center = moon.target.position.clone();
    const roofY = aperture.userData.aperture.roofY;
    ctx.camera.fov = 46;
    ctx.camera.position.set(center.x + 170, Math.max(92, roofY * 0.29), center.z + 430);
    ctx.camera.lookAt(center.x, roofY * 0.43, center.z);
    ctx.camera.near = 1;
    ctx.camera.far = 2600;
    ctx.camera.updateProjectionMatrix();
    const samples = [];
    for (let i = 0; i < 7; i++) {
      const started = performance.now();
      postProcessing.render();
      const queue = ctx.renderer.backend?.device?.queue;
      if (queue?.onSubmittedWorkDone) await queue.onSubmittedWorkDone();
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    return {
      camera: ctx.camera.position.toArray(),
      lookAt: [center.x, roofY * 0.43, center.z],
      aperture: aperture.userData.aperture,
      godrays: df.godrayStats,
      renderSamplesMs: samples,
      renderMedianMs: samples[Math.floor(samples.length / 2)],
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
  timeout: 90000,
});
if (review.exceptionDetails) throw new Error(review.exceptionDetails.exception?.description ?? review.exceptionDetails.text);
const capture = await call("Page.captureScreenshot", { format: "png" });
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, Buffer.from(capture.data, "base64"));
console.log(JSON.stringify({ output, ...review.result.value }, null, 2));
ws.close();
