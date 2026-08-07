const opts = new Map();
for (let i = 2; i < process.argv.length; i += 2) opts.set(process.argv[i], process.argv[i + 1]);
const port = Number(opts.get("--port") ?? 9337);
const rounds = Number(opts.get("--rounds") ?? 12);
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
const gpuErrors = [];
const failures = [];
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.consoleAPICalled") {
    const line = message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
    if (/GPUValidationError|Invalid CommandBuffer|Instance range/.test(line)) gpuErrors.push(line);
  } else if (message.method === "Log.entryAdded") {
    const line = message.params.entry.text;
    if (/GPUValidationError|Invalid CommandBuffer|Instance range/.test(line)) gpuErrors.push(line);
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
      while (window.__df.ctx.state.token === previousToken && performance.now() < deadline) await sleep(20);
      let stableSince = performance.now();
      let worldCount = -1;
      while (performance.now() < deadline) {
        const nextCount = window.__df.ctx.worlds.length;
        if (nextCount !== worldCount) { worldCount = nextCount; stableSince = performance.now(); }
        if (worldCount > 0 && performance.now() - stableSince >= 500) break;
        await sleep(50);
      }
      await sleep(100);
      window.__df.postProcessing.render();
      await (queue?.onSubmittedWorkDone?.() ?? Promise.resolve());
      const undersized = [];
      window.__df.ctx.scene.traverse((object) => {
        if (!object.isInstancedMesh || object.count === 0) return;
        const matrixCapacity = object.instanceMatrix?.count ?? 0;
        const colorCapacity = object.instanceColor?.count ?? Infinity;
        if (matrixCapacity < object.count || colorCapacity < object.count) {
          undersized.push({ name: object.name, count: object.count, matrixCapacity, colorCapacity });
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
        seed, token: window.__df.ctx.state.token, worlds: worldCount, undersized,
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
const navigationFailures = results.filter((result) =>
  result.routePoints === 0 || result.unreachable > 0 || result.ungroundedRoutePoints > 0 || result.blockedRoutePoints > 0
);
const report = { rounds: results.length, gpuErrors, failures, undersized, navigationFailures, results };
console.log(JSON.stringify(report));
ws.close();
if (gpuErrors.length || failures.length || undersized.length || navigationFailures.length || results.length !== rounds) process.exitCode = 1;
