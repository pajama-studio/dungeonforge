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
const closeup = opts.get("--closeup") === "true";

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
let pageLoadResolve = null;
const gpuErrors = [];
const failures = [];
const frameBlocks = [];
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Page.loadEventFired") {
    pageLoadResolve?.();
    return;
  }
  if (message.method === "Runtime.consoleAPICalled") {
    const line = message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
    if (line === "[destruction-regression] start") frameBlocks.length = 0;
    if (/GPUValidationError|Invalid CommandBuffer|Instance range|binding size/i.test(line)) gpuErrors.push(line);
    if (/^\[frame\] render\(\) blocked/.test(line)) frameBlocks.push(line);
  } else if (message.method === "Log.entryAdded") {
    const line = message.params.entry.text;
    if (/GPUValidationError|Invalid CommandBuffer|Instance range|binding size/i.test(line)) gpuErrors.push(line);
  } else if (message.method === "Runtime.exceptionThrown") {
    const details = message.params.exceptionDetails;
    failures.push(details.exception?.description ?? details.exception?.value ?? details.text);
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
await call("Page.bringToFront");
// Fix the backing size before application modules create WebGPU targets.
// Resizing after load invalidates every render object and makes the harness,
// rather than destruction, responsible for the measured frame blocks.
await call("Emulation.setDeviceMetricsOverride", {
  width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
});
const pageLoaded = new Promise((resolve) => { pageLoadResolve = resolve; });
await call("Page.reload", { ignoreCache: true });
await Promise.race([
  pageLoaded,
  new Promise((_, reject) => setTimeout(() => reject(new Error("Page reload timed out")), 15000)),
]);
pageLoadResolve = null;

const evaluated = await call("Runtime.evaluate", {
  expression: `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const readyBy = performance.now() + 40000;
    while ((!window.__df || !window.__df.decorReady) && performance.now() < readyBy) await sleep(100);
    if (!window.__df?.decorReady) throw new Error("Dungeonforge did not become render-ready");
    console.log("[destruction-regression] start");
    window.__df.controls.autoRotate = false;
    const destruction = await window.__df.ensureDestruction();
    const warmupStarted = performance.now();
    await destruction.warmup();
    const warmupMs = performance.now() - warmupStarted;
    const sampleFrameDeltas = async (count) => {
      const deltas = [];
      let previous = await new Promise((resolve) => requestAnimationFrame(resolve));
      for (let i = 0; i < count; i++) {
        const next = await new Promise((resolve) => requestAnimationFrame(resolve));
        deltas.push(next - previous);
        previous = next;
      }
      return deltas;
    };
    const summarizeFrames = (values) => {
      const ordered = [...values].sort((a, b) => a - b);
      return {
        median: ordered[Math.floor(ordered.length * 0.5)] ?? 0,
        p95: ordered[Math.floor(ordered.length * 0.95)] ?? 0,
        max: ordered[ordered.length - 1] ?? 0,
      };
    };
    const idleFrames = summarizeFrames(await sampleFrameDeltas(10));
    if (${closeup}) {
      let source = null;
      window.__df.ctx.scene.traverse((object) => {
        if (!source && object.isInstancedMesh && object.name === "blockMids" && (object.userData?.n ?? 0) > 0) source = object;
      });
      if (!source) throw new Error("No masonry source available for close-up");
      source.updateWorldMatrix(true, false);
      const world = source.matrixWorld.clone();
      const local = source.matrixWorld.clone();
      const focus = window.__df.camera.position.clone();
      const origin = window.__df.camera.position.clone().setFromMatrixPosition(source.matrixWorld);
      let bestScore = -Infinity;
      // GPU Scene deliberately keeps the raycast-authority source at count 0;
      // userData.n is its logical instance count.
      const count = source.userData.n;
      for (let i = 0; i < count; i++) {
        source.getMatrixAt(i, local);
        world.multiplyMatrices(source.matrixWorld, local);
        const x = world.elements[12], y = world.elements[13], z = world.elements[14];
        // Prefer a lower outer façade: exposed enough for a clean ray, close
        // enough to a real floor that the physical settling is also visible.
        const score = Math.hypot(x - origin.x, z - origin.z) - Math.abs(y - (origin.y + 3.4)) * 0.9;
        if (score > bestScore) { bestScore = score; focus.set(x, y, z); }
      }
      const view = focus.clone().sub(origin);
      view.y = Math.max(2.2, Math.abs(view.y) * 0.2);
      view.normalize();
      window.__df.controls.autoRotate = false;
      window.__df.controls.target.copy(focus);
      window.__df.camera.position.copy(focus).addScaledVector(view, 8.5);
      window.__df.camera.lookAt(focus);
      window.__df.camera.updateMatrixWorld(true);
      await sampleFrameDeltas(3);
    }
    const canvas = window.__df.ctx.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const impacts = [];
    const samples = [];
    let firstVisibleFrameMs = 0;
    let fractureFrames = { median: 0, p95: 0, max: 0 };
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
            if (impacts.length === 1) {
              const frameStarted = performance.now();
              fractureFrames = summarizeFrames(await sampleFrameDeltas(8));
              firstVisibleFrameMs = performance.now() - frameStarted;
            }
            await sleep(34);
          }
        }
      }
    }
    // The hero landmarks can legitimately cover most of the old fixed click
    // grid. Keep the first pass user-like, then deliberately project authored
    // breach bands into screen space so this regression always exercises the
    // topology mutation instead of depending on an accidental camera angle.
    let breachProbeAttempts = 0;
    if (${!closeup} && destruction.stats.breaches === 0) {
      const candidates = [];
      const breachSources = [];
      window.__df.ctx.scene.traverse((object) => {
        if (object.isInstancedMesh && object.userData?.masonry?.byInstance?.size) breachSources.push(object);
      });
      for (const mesh of breachSources) {
        const structure = mesh.userData?.masonry;
        if (!structure?.byInstance?.size) continue;
        mesh.updateWorldMatrix(true, false);
        const local = mesh.matrixWorld.clone();
        const world = mesh.matrixWorld.clone();
        const seen = new Set();
        for (const [instanceId, breach] of structure.byInstance) {
          if (seen.has(breach) || breach.opened) continue;
          seen.add(breach);
          mesh.getMatrixAt(instanceId, local);
          world.multiplyMatrices(mesh.matrixWorld, local);
          const point = mesh.position.clone().setFromMatrixPosition(world);
          const distance = point.distanceTo(window.__df.camera.position);
          const ndc = point.clone().project(window.__df.camera);
          if (ndc.z < -1 || ndc.z > 1 || Math.abs(ndc.x) > 0.94 || Math.abs(ndc.y) > 0.9) continue;
          candidates.push({ ndc, distance });
        }
      }
      candidates.sort((a, b) => a.distance - b.distance);
      for (const candidate of candidates.slice(0, 48)) {
        const x = rect.left + (candidate.ndc.x + 1) * 0.5 * rect.width;
        const y = rect.top + (1 - candidate.ndc.y) * 0.5 * rect.height;
        // Up to four layers may overlap the selected band in this cinematic
        // camera. Each click still goes through the public raycast path.
        for (let layer = 0; layer < 4 && destruction.stats.breaches === 0; layer++) {
          breachProbeAttempts++;
          destruction.blastClientPoint(x, y);
        }
        if (destruction.stats.breaches > 0) break;
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
    const debrisColors = destruction.mesh.instanceColor?.array ?? [];
    const touchedColorCount = Math.min(destruction.stats.spawned, destruction.stats.capacity) * 3;
    const debrisColorBuckets = new Set();
    for (let i = 0; i < touchedColorCount; i += 3) {
      debrisColorBuckets.add(
        Math.round(debrisColors[i] * 31) + ":" +
        Math.round(debrisColors[i + 1] * 31) + ":" +
        Math.round(debrisColors[i + 2] * 31)
      );
    }
    return {
      requested: ${wanted}, impacts: impacts.length,
      breachProbeAttempts,
      fragments: destruction.stats.spawned,
      inheritedColors: destruction.stats.inheritedColors,
      commandCommits: destruction.stats.commandCommits,
      bufferDirtyMarks: destruction.stats.commandCommits * 5,
      legacyBufferDirtyMarks: destruction.stats.spawned * 5,
      uploadedCommandBytes: destruction.stats.uploadedCommandBytes,
      fullUploadEquivalentBytes: destruction.stats.fullUploadEquivalentBytes,
      commandUploadReduction: destruction.stats.fullUploadEquivalentBytes > 0
        ? 1 - destruction.stats.uploadedCommandBytes / destruction.stats.fullUploadEquivalentBytes : 0,
      inheritedColorRatio: destruction.stats.spawned > 0
        ? destruction.stats.inheritedColors / destruction.stats.spawned : 0,
      debrisMaterial: destruction.mesh.material.name,
      debrisMaterialClass: destruction.mesh.material.constructor.name,
      debrisColorCapacity: destruction.mesh.instanceColor?.count ?? 0,
      debrisColorBuckets: debrisColorBuckets.size,
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
      warmupMs,
      firstVisibleFrameMs,
      idleFrames,
      fractureFrames,
      undersized,
      gpuSceneHiddenInstances: window.__df.gpuScene?.stats.hiddenInstances ?? 0,
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
  timeout: 180000,
});

if (evaluated.exceptionDetails) {
  failures.push(
    evaluated.exceptionDetails.exception?.description ??
    evaluated.exceptionDetails.exception?.value ??
    evaluated.exceptionDetails.text,
  );
}
const result = evaluated.result?.value ?? null;
if (screenshot) {
  const captured = await call("Page.captureScreenshot", { format: "png" });
  mkdirSync(dirname(screenshot), { recursive: true });
  writeFileSync(screenshot, Buffer.from(captured.data, "base64"));
}
const report = { gpuErrors, failures, frameBlocks, result };
console.log(JSON.stringify(report));
ws.close();
if (
  gpuErrors.length || failures.length || !result || result.impacts < wanted ||
  result.undersized.length || (!closeup && result.breaches < 1) || result.unreachable > 0 ||
  result.inheritedColorRatio !== 1 || result.debrisMaterial !== "gpu-debris-authored-stone" ||
  result.debrisColorCapacity < result.capacity ||
  (closeup && result.gpuSceneHiddenInstances < 1)
) process.exitCode = 1;
