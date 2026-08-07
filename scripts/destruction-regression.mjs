// Real-browser WebGPU destruction regression. It repeatedly raycasts screen
// points, waits for compute simulation, and fails on GPU validation errors or
// any instance count/capacity mismatch.

import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const opts = new Map();
for (let i = 2; i < process.argv.length; i += 2) opts.set(process.argv[i], process.argv[i + 1]);
const port = Number(opts.get("--port") ?? 9337);
const wanted = Number(opts.get("--impacts") ?? 24);
const urlNeedle = opts.get("--url") ?? "127.0.0.1:4173";
const screenshot = opts.get("--screenshot");

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((entry) => entry.type === "page" && entry.url.includes(urlNeedle));
if (!target) throw new Error(`No page containing ${urlNeedle} on CDP port ${port}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map();
const gpuErrors = [];
const failures = [];
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.consoleAPICalled") {
    const line = message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
    if (/GPUValidationError|Invalid CommandBuffer|Instance range|binding size/i.test(line)) gpuErrors.push(line);
  } else if (message.method === "Log.entryAdded") {
    const line = message.params.entry.text;
    if (/GPUValidationError|Invalid CommandBuffer|Instance range|binding size/i.test(line)) gpuErrors.push(line);
  } else if (message.method === "Runtime.exceptionThrown") {
    failures.push(message.params.exceptionDetails.text);
  }
  if (!message.id) return;
  const job = pending.get(message.id);
  if (!job) return;
  pending.delete(message.id);
  if (message.error) job.reject(new Error(message.error.message));
  else job.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

await call("Runtime.enable");
await call("Log.enable");
await call("Page.enable");
await call("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 750));
await call("Emulation.setDeviceMetricsOverride", {
  width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
});

const evaluated = await call("Runtime.evaluate", {
  expression: `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const readyBy = performance.now() + 40000;
    while ((!window.__df || !window.__df.decorReady) && performance.now() < readyBy) await sleep(100);
    if (!window.__df?.decorReady) throw new Error("Dungeonforge did not become render-ready");
    window.__df.controls.autoRotate = false;
    const destruction = window.__df.destruction;
    const canvas = window.__df.ctx.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const impacts = [];
    const samples = [];
    for (let ring = 0; ring < 7 && impacts.length < ${wanted}; ring++) {
      const cols = 16 + ring * 3;
      const rows = 9 + ring * 2;
      for (let row = 1; row < rows && impacts.length < ${wanted}; row++) {
        for (let col = 1; col < cols && impacts.length < ${wanted}; col++) {
          const x = rect.left + rect.width * (col / cols);
          const y = rect.top + rect.height * (row / rows);
          const t0 = performance.now();
          const hit = destruction.blastClientPoint(x, y);
          const raycastMs = performance.now() - t0;
          samples.push(raycastMs);
          if (hit) {
            impacts.push({ x, y, raycastMs });
            await sleep(34);
          }
        }
      }
    }
    await sleep(1400);
    const queue = window.__df.ctx.renderer.backend?.device?.queue;
    await (queue?.onSubmittedWorkDone?.() ?? Promise.resolve());
    const undersized = [];
    const masonryCull = { potential: 0, interior: 0, authoredGaps: 0, emitted: 0 };
    window.__df.ctx.scene.traverse((object) => {
      if (object.userData?.masonryCull) {
        for (const key of Object.keys(masonryCull)) masonryCull[key] += object.userData.masonryCull[key];
      }
      if (!object.isInstancedMesh || object.count === 0) return;
      const matrixCapacity = object.instanceMatrix?.count ?? 0;
      const colorCapacity = object.instanceColor?.count ?? Infinity;
      if (matrixCapacity < object.count || colorCapacity < object.count) {
        undersized.push({ name: object.name, count: object.count, matrixCapacity, colorCapacity });
      }
    });
    const sorted = [...samples].sort((a, b) => a - b);
    const tour = window.__df.nav.tour();
    return {
      requested: ${wanted}, impacts: impacts.length,
      fragments: destruction.stats.spawned,
      capacity: destruction.stats.capacity,
      breaches: destruction.stats.breaches,
      breachFloorInstances: destruction.breachMesh.count,
      walkRevision: window.__df.ctx.walk.revision,
      routePoints: tour?.pts.length ?? 0,
      unreachable: tour?.unreachable.length ?? window.__df.ctx.walk.islands.length,
      masonryCull,
      raycasts: samples.length,
      raycastMedianMs: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
      raycastP95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      undersized,
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
  timeout: 180000,
});

if (evaluated.exceptionDetails) failures.push(evaluated.exceptionDetails.text);
const result = evaluated.result?.value ?? null;
if (screenshot) {
  const captured = await call("Page.captureScreenshot", { format: "png" });
  mkdirSync(dirname(screenshot), { recursive: true });
  writeFileSync(screenshot, Buffer.from(captured.data, "base64"));
}
const report = { gpuErrors, failures, result };
console.log(JSON.stringify(report));
ws.close();
if (
  gpuErrors.length || failures.length || !result || result.impacts < wanted ||
  result.undersized.length || result.breaches < 1 || result.unreachable > 0
) process.exitCode = 1;
