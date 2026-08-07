import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const opts = new Map();
for (let i = 2; i < process.argv.length; i += 2) opts.set(process.argv[i], process.argv[i + 1]);
const port = Number(opts.get("--port") ?? 9337);
const rounds = Number(opts.get("--rounds") ?? 100);
const warmup = Number(opts.get("--warmup") ?? 15);
const drawsPerLoop = Number(opts.get("--draws") ?? 6);
const label = opts.get("--label") ?? "browser";
const output = opts.get("--output");
const screenshot = opts.get("--screenshot");
const destruction = opts.get("--destruction") === "true";
const forceDestruction = opts.get("--force-destruction") === "true";
const urlNeedle = opts.get("--url") ?? "127.0.0.1:4173";

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((t) => t.type === "page" && t.url.includes(urlNeedle));
if (!target) throw new Error(`No page containing ${urlNeedle} on CDP port ${port}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (!msg.id) return;
  const job = pending.get(msg.id);
  if (!job) return;
  pending.delete(msg.id);
  if (msg.error) job.reject(new Error(msg.error.message));
  else job.resolve(msg.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

await call("Runtime.enable");
await call("Page.enable");
await call("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 720,
  deviceScaleFactor: 1,
  mobile: false,
});
await call("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 750));
const expression = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = performance.now() + 30000;
  while ((!window.__df || !window.__df.decorReady) && performance.now() < deadline) await sleep(100);
  if (!window.__df) throw new Error("Dungeonforge dev hook did not initialize");
  if (!window.__df.decorReady) throw new Error("Decor pipelines did not finish warming within 30 seconds");
  // Player/skinning pipelines are intentionally compiled in the background
  // after first paint. Let that one-time work finish before sampling or the
  // first half of a 100-loop run measures compilation, not steady rendering.
  await sleep(4000);
  const { ctx, postProcessing } = window.__df;
  ctx.renderer.setAnimationLoop(null);
  if (${forceDestruction} && window.__df.destruction) {
    // Benchmark-only worst case: keep the fixed compute pool awake for every
    // measured draw. TypeScript-private fields remain normal JS properties.
    window.__df.destruction.activeUntil = Infinity;
    window.__df.destruction.mesh.visible = true;
  }
  window.__df.setAllDetail(true);
  window.__df.controls.autoRotate = false;
  const target = window.__df.controls.target;
  const viewDist = Math.max(70, ctx.state.lastExtent * 1.3);
  window.__df.camera.position.set(
    target.x + viewDist * 0.62,
    target.y + viewDist * 0.48,
    target.z + viewDist * 0.9
  );
  window.__df.camera.lookAt(target);
  const queue = ctx.renderer.backend && ctx.renderer.backend.device && ctx.renderer.backend.device.queue;
  const waitGpu = queue && queue.onSubmittedWorkDone ? () => queue.onSubmittedWorkDone() : () => Promise.resolve();
  const draw = async () => {
    ${destruction ? "window.__df.destruction?.tick(1 / 60);" : ""}
    postProcessing.render();
    await waitGpu();
  };
  for (let i = 0; i < ${warmup}; i++) await draw();
  const samples = [];
  for (let loop = 1; loop <= ${rounds}; loop++) {
    const t0 = performance.now();
    for (let drawIndex = 0; drawIndex < ${drawsPerLoop}; drawIndex++) await draw();
    samples.push({ loop, frameMs: (performance.now() - t0) / ${drawsPerLoop} });
  }
  let instances = 0, visibleRenderObjects = 0, triangles = 0;
  ctx.scene.traverse((o) => {
    if (!o.visible || !o.isMesh) return;
    visibleRenderObjects++;
    if (o.isInstancedMesh) instances += o.count;
    const pos = o.geometry && o.geometry.getAttribute && o.geometry.getAttribute("position");
    if (pos) triangles += (o.geometry.index ? o.geometry.index.count : pos.count) / 3 * (o.isInstancedMesh ? o.count : 1);
  });
  return {
    samples, instances, visibleRenderObjects, triangles,
    gpuWait: Boolean(queue && queue.onSubmittedWorkDone),
    destructionCompute: ${destruction},
    destructionStats: window.__df.destruction ? { ...window.__df.destruction.stats } : null,
  };
})()`;
const evaluated = await call("Runtime.evaluate", {
  expression,
  awaitPromise: true,
  returnByValue: true,
  timeout: 120000,
});
if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
const data = evaluated.result.value;

const quantile = (values, q) => {
  const a = [...values].sort((x, y) => x - y);
  const p = (a.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return a[lo] + (a[hi] - a[lo]) * (p - lo);
};
const values = data.samples.map((s) => s.frameMs);
const result = {
  schema: 1,
  label,
  workload: { rounds, warmup, drawsPerLoop, url: target.url },
  summary: {
    frameMedianMs: quantile(values, 0.5),
    frameP95Ms: quantile(values, 0.95),
    fpsFromMedian: 1000 / quantile(values, 0.5),
    ...Object.fromEntries(Object.entries(data).filter(([key]) => key !== "samples")),
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
