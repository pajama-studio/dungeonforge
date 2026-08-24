import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const opts = new Map();
for (let i = 2; i < process.argv.length; i += 2) opts.set(process.argv[i], process.argv[i + 1]);
const port = Number(opts.get("--port") ?? 9337);
const rounds = Number(opts.get("--rounds") ?? 12);
const output = opts.get("--output");
const urlNeedle = opts.get("--url") ?? "127.0.0.1:4173";

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
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Page.loadEventFired") { pageLoadResolve?.(); return; }
  if (message.method === "Runtime.consoleAPICalled") {
    const line = message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
    if (/GPUValidationError|Invalid CommandBuffer|Instance range/.test(line)) gpuErrors.push(line);
  } else if (message.method === "Log.entryAdded") {
    const line = message.params.entry.text;
    if (/GPUValidationError|Invalid CommandBuffer|Instance range/.test(line)) gpuErrors.push(line);
  } else if (message.method === "Runtime.exceptionThrown") {
    failures.push(
      message.params.exceptionDetails.exception?.description
        ?? message.params.exceptionDetails.text,
    );
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
    const readyBy = performance.now() + 30000;
    while ((!window.__df || !window.__df.decorReady) && performance.now() < readyBy) await sleep(100);
    if (!window.__df?.decorReady) throw new Error("Dungeonforge did not become render-ready");
    const input = document.getElementById("seedInput");
    const button = document.getElementById("btnGo");
    const queue = window.__df.ctx.renderer.backend?.device?.queue;
    const seeds = Array.from({ length: ${rounds} }, (_, index) =>
      (359139884 + Math.imul(index + 1, 2654435761)) >>> 0
    );
    const results = [];
    for (const seed of seeds) {
      const previousToken = window.__df.ctx.state.token;
      input.value = String(seed);
      button.click();
      const deadline = performance.now() + 15000;
      let snapshotSeen = false;
      const lifecycle = [];
      while (window.__df.ctx.state.token === previousToken && performance.now() < deadline) {
        snapshotSeen ||= document.getElementById('forgeSnapshot').classList.contains('show');
        const stage = window.__df.forgeRun?.stage;
        if (stage && lifecycle.at(-1) !== stage) lifecycle.push(stage);
        await sleep(20);
      }
      let worldCount = window.__df.ctx.worlds.length;
      while (performance.now() < deadline) {
        snapshotSeen ||= document.getElementById('forgeSnapshot').classList.contains('show');
        const stage = window.__df.forgeRun?.stage;
        if (stage && lifecycle.at(-1) !== stage) lifecycle.push(stage);
        worldCount = window.__df.ctx.worlds.length;
        if (stage === 'ready' || stage === 'failed') break;
        await sleep(25);
      }
      const forgeRun = window.__df.forgeRun;
      await sleep(320);
      window.__df.postProcessing.render();
      await (queue?.onSubmittedWorkDone?.() ?? Promise.resolve());
      const undersized = [];
      const stalePoolObjects = [];
      window.__df.ctx.scene.traverse((object) => {
        if (!object.isInstancedMesh || object.count === 0) return;
        const matrixCapacity = object.instanceMatrix?.count ?? 0;
        const colorCapacity = object.instanceColor?.count ?? Infinity;
        if (matrixCapacity < object.count || colorCapacity < object.count) {
          undersized.push({ name: object.name, count: object.count, matrixCapacity, colorCapacity });
        }
        const pool = object.parent;
        if (!pool?.isGroup) return;
        const allowed = pool.name === 'support-piers'
          ? new Set(['blocks', 'blocksLo'])
          : (pool.name === 'bridge-link' || pool.name.startsWith('district-'))
            ? new Set(['linkStones', 'linkStonesLo', 'linkBowls', 'linkFlames'])
            : null;
        if (allowed && !allowed.has(object.name)) {
          stalePoolObjects.push({ pool: pool.name, object: object.name, count: object.count });
        }
      });
      const tour = window.__df.nav.tour();
      let ungroundedRoutePoints = 0, blockedRoutePoints = 0;
      const invalidRouteExamples = [];
      if (tour) {
        for (const point of tour.pts) {
          const ground = window.__df.ctx.walk.sample(point.x, point.z, point.y);
          const blocked = window.__df.ctx.walk.isBlocked(point.x, point.y, point.z);
          if (!ground.ok) ungroundedRoutePoints++;
          if (blocked) blockedRoutePoints++;
          if ((!ground.ok || blocked) && invalidRouteExamples.length < 4) {
            invalidRouteExamples.push({ x: point.x, y: point.y, z: point.z, ground, blocked });
          }
        }
      }
      results.push({
        seed, token: window.__df.ctx.state.token, worlds: worldCount, undersized, stalePoolObjects,
        lifecycle, snapshotSeen, snapshotReleased: !document.getElementById('forgeSnapshot').classList.contains('show'),
        forgeRun,
        routePoints: tour?.pts.length ?? 0,
        unreachable: tour?.unreachable.length ?? window.__df.ctx.walk.islands.length,
        ungroundedRoutePoints, blockedRoutePoints, invalidRouteExamples,
      });
    }
    return results;
  })()`,
  awaitPromise: true,
  returnByValue: true,
  timeout: 240000,
});

if (evaluated.exceptionDetails) failures.push(evaluated.exceptionDetails.text);
const results = evaluated.result?.value ?? [];
const undersized = results.flatMap((result) => result.undersized);
const stalePoolObjects = results.flatMap((result) => result.stalePoolObjects);
const navigationFailures = results.filter((result) =>
  result.routePoints === 0 || result.unreachable > 0 || result.ungroundedRoutePoints > 0 || result.blockedRoutePoints > 0
);
const lifecycleFailures = results.filter((result) =>
  result.forgeRun?.stage !== "ready"
  || result.forgeRun?.seed !== result.seed
  || !result.snapshotSeen
  || !result.snapshotReleased
  || !(result.forgeRun?.timings?.generating >= 0)
  || !(result.forgeRun?.timings?.assembling >= 0)
  || !(result.forgeRun?.timings?.["gpu-upload"] >= 0)
);
const report = { rounds: results.length, gpuErrors, failures, undersized, stalePoolObjects, navigationFailures, lifecycleFailures, results };
if (output) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report));
ws.close();
if (gpuErrors.length || failures.length || undersized.length || stalePoolObjects.length || navigationFailures.length || lifecycleFailures.length || results.length !== rounds) process.exitCode = 1;
