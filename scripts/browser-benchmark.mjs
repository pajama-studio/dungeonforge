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
const detail = opts.get("--detail") !== "false";
const forcedLod = opts.has("--lod")
  ? Math.max(0, Math.min(2, Math.round(Number(opts.get("--lod")))))
  : null;
const middleFull = opts.get("--middle-full") === "true";
const fixedSeed = opts.get("--seed");
const clustered = opts.get("--clustered");
const ambientOcclusion = opts.get("--ao");
const gpuScene = opts.get("--gpu-scene");
const farShadows = opts.has("--far-shadows")
  ? opts.get("--far-shadows") === "true"
  : null;
const occludeFirst = opts.get("--occlude-first") === "true";
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
let pageLoadResolve = null;
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === "Page.loadEventFired") {
    pageLoadResolve?.();
    return;
  }
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
const pageLoaded = new Promise((resolve) => { pageLoadResolve = resolve; });
if (fixedSeed !== undefined) {
  const fixedUrl = new URL(target.url);
  fixedUrl.searchParams.set("seed", fixedSeed);
  if (clustered === "true") fixedUrl.searchParams.set("clustered", "1");
  else if (clustered === "false") fixedUrl.searchParams.set("clustered", "0");
  if (ambientOcclusion === "true") fixedUrl.searchParams.set("ao", "1");
  else if (ambientOcclusion === "false") fixedUrl.searchParams.delete("ao");
  if (gpuScene === "true") fixedUrl.searchParams.set("gpuscene", "1");
  else if (gpuScene === "false") fixedUrl.searchParams.set("gpuscene", "0");
  await call("Page.navigate", { url: fixedUrl.href });
} else {
  await call("Page.reload", { ignoreCache: true });
}
await Promise.race([
  pageLoaded,
  new Promise((_, reject) => setTimeout(() => reject(new Error("Page reload timed out")), 15000)),
]);
pageLoadResolve = null;
const expression = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = performance.now() + 60000;
  while ((!window.__df || !window.__df.decorReady) && performance.now() < deadline) await sleep(100);
  if (!window.__df) throw new Error("Dungeonforge dev hook did not initialize");
  if (!window.__df.decorReady) throw new Error("Decor pipelines did not finish warming within 60 seconds");
  if (${JSON.stringify(farShadows)} !== null
    && window.__df.masonry.farShadows !== ${JSON.stringify(farShadows)}) {
    const beforeToken = window.__df.ctx.state.token;
    window.__df.masonry.setFarShadows(${JSON.stringify(farShadows)});
    document.getElementById("seedInput").value = String(window.__df.ctx.state.seed);
    document.getElementById("btnGo").click();
    while ((window.__df.ctx.state.token <= beforeToken || window.__df.ctx.state.reforging)
      && performance.now() < deadline) await sleep(20);
    if (window.__df.ctx.state.token <= beforeToken || window.__df.ctx.state.reforging) {
      throw new Error("far-shadow reforge timed out");
    }
  }
  // Player/skinning is demand-loaded and absent here, but WebGPU may still be
  // retiring asynchronous pipeline work immediately after incremental decor
  // reveal. Keep the historical four-second settle window so 100-loop results
  // remain comparable with the existing baseline rather than sampling its tail.
  await sleep(4000);
  const { ctx, postProcessing } = window.__df;
  ctx.renderer.setAnimationLoop(null);
  // The app's adaptive controller may have walked DPR to any value in
  // [0.85, cap] during startup. Benchmarks must compare the same number of
  // pixels, so lock the backing targets after stopping the animation loop.
  ctx.renderer.setPixelRatio(1);
  if (${forceDestruction}) {
    // Benchmark-only worst case: keep the fixed compute pool awake for every
    // measured draw. TypeScript-private fields remain normal JS properties.
    await window.__df.ensureDestruction();
    window.__df.destruction.activeUntil = Infinity;
    window.__df.destruction.mesh.visible = true;
  }
  if (${JSON.stringify(forcedLod)} === null) window.__df.setAllDetail(${detail});
  else {
    window.__df.masonry.forceLod(${JSON.stringify(forcedLod)});
    window.__df.gpuScene?.tick(window.__df.camera);
  }
  if (${middleFull}) {
    let fullCourse = null;
    ctx.scene.traverse((o) => {
      if (!fullCourse && o.isMesh && o.geometry?.name === "blockGeo") fullCourse = o.geometry;
    });
    if (!fullCourse) throw new Error("full masonry geometry was not found");
    ctx.scene.traverse((o) => {
      if (o.isMesh && o.geometry?.name === "blockMiddleGeo") o.geometry = fullCourse;
    });
  }
  if (${occludeFirst}) {
    let firstSlot;
    ctx.scene.traverse((object) => {
      if (firstSlot !== undefined || object.name !== "colsLo") return;
      if (!object.userData?.gpuSceneManaged) return;
      firstSlot = object.parent?.userData?.slot;
    });
    if (firstSlot !== undefined) {
      window.__df.gpuScene?.setOccludingSlots(new Set([firstSlot]));
      window.__df.gpuScene?.tick(window.__df.camera);
    }
  }
  window.__df.controls.autoRotate = false;
  // Cinematic mode moves OrbitControls.target during the four-second pipeline
  // settle. Derive one deterministic target from authored island anchors so
  // GPU on/off runs render the exact same view and pixel workload.
  const islands = ctx.walk.islands;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const island of islands) {
    minX = Math.min(minX, island.ox); maxX = Math.max(maxX, island.ox);
    minY = Math.min(minY, island.oy); maxY = Math.max(maxY, island.oy);
    minZ = Math.min(minZ, island.oz); maxZ = Math.max(maxZ, island.oz);
  }
  const target = window.__df.controls.target;
  if (islands.length > 0) target.set(
    (minX + maxX) * 0.5,
    (minY + maxY) * 0.5 + 7,
    (minZ + maxZ) * 0.5
  );
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
    window.__df.gpuScene?.tick(window.__df.camera);
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
  const gpuSceneValidation = window.__df.gpuScene?.stats.enabled
    ? await window.__df.gpuScene.readbackValidation()
    : null;
  let instances = 0, visibleRenderObjects = 0, submittedRenderObjects = 0, triangles = 0;
  const geometryMap = new Map();
  ctx.scene.traverse((o) => {
    if (!o.visible || !o.isMesh) return;
    visibleRenderObjects++;
    const gpuSceneCount = o.name === "gpu-scene-masonry-high"
      ? gpuSceneValidation?.high
      : o.name === "gpu-scene-masonry-mid" ? gpuSceneValidation?.middle
        : o.name === "gpu-scene-low-masonry-shadow" ? gpuSceneValidation?.lowMasonry?.shadow
          : o.name === "gpu-scene-low-masonry-plain" ? gpuSceneValidation?.lowMasonry?.plain
            : o.name === "gpu-scene-low-surface-tiles-shadow" ? gpuSceneValidation?.lowSurfaces?.tiles?.shadow
              : o.name === "gpu-scene-low-surface-tiles-plain" ? gpuSceneValidation?.lowSurfaces?.tiles?.plain
                : o.name === "gpu-scene-low-surface-steps-shadow" ? gpuSceneValidation?.lowSurfaces?.steps?.shadow
                  : o.name === "gpu-scene-low-surface-steps-plain" ? gpuSceneValidation?.lowSurfaces?.steps?.plain
                    : o.name === "gpu-scene-low-surface-columns-shadow" ? gpuSceneValidation?.lowSurfaces?.columns?.shadow
                      : o.name === "gpu-scene-low-surface-columns-plain" ? gpuSceneValidation?.lowSurfaces?.columns?.plain
                        : o.name === "gpu-scene-low-surface-planks-shadow" ? gpuSceneValidation?.lowSurfaces?.planks?.shadow
                          : o.name === "gpu-scene-low-surface-planks-plain" ? gpuSceneValidation?.lowSurfaces?.planks?.plain
                            : o.name === "gpu-scene-global-decor-banners"
                              ? (gpuSceneValidation?.lowSurfaces?.banners?.plain ?? 0)
                                + (gpuSceneValidation?.lowSurfaces?.banners?.shadow ?? 0)
                              : o.name === "gpu-scene-global-decor-redTiles"
                                ? (gpuSceneValidation?.lowSurfaces?.redTiles?.plain ?? 0)
                                  + (gpuSceneValidation?.lowSurfaces?.redTiles?.shadow ?? 0)
                                : undefined;
    const instanceCount = gpuSceneCount ?? (o.isInstancedMesh ? o.count : 1);
    if (o.isInstancedMesh) instances += instanceCount;
    const pos = o.geometry && o.geometry.getAttribute && o.geometry.getAttribute("position");
    if (!pos) return;
    const drawInstances = instanceCount;
    if (drawInstances <= 0) return;
    submittedRenderObjects++;
    const trisEach = (o.geometry.index ? o.geometry.index.count : pos.count) / 3;
    const contribution = trisEach * drawInstances;
    triangles += contribution;
    const key = o.geometry.name || (o.geometry.type + ":" + trisEach);
    const entry = geometryMap.get(key) || { geometry: key, renderObjects: 0, instances: 0, triangles: 0, trianglesEach: trisEach, objects: {} };
    entry.renderObjects++;
    entry.instances += drawInstances;
    entry.triangles += contribution;
    const objectName = o.name || "(unnamed)";
    entry.objects[objectName] = (entry.objects[objectName] || 0) + drawInstances;
    geometryMap.set(key, entry);
  });
  const geometryBreakdown = [...geometryMap.values()].sort((a, b) => b.triangles - a.triangles);
  return {
    samples, instances, visibleRenderObjects, submittedRenderObjects, triangles, geometryBreakdown,
    gpuWait: Boolean(queue && queue.onSubmittedWorkDone), pixelRatio: ctx.renderer.getPixelRatio(),
    destructionCompute: ${destruction},
    destructionStats: window.__df.destruction ? { ...window.__df.destruction.stats } : null,
    gpuSceneStats: window.__df.gpuScene ? { ...window.__df.gpuScene.stats } : null,
    gpuSceneValidation,
    pageUrl: location.href,
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
    workload: { rounds, warmup, drawsPerLoop, detail, forcedLod, farShadows, occludeFirst, middleFull, url: data.pageUrl },
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
