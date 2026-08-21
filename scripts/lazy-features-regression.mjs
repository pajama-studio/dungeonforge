// Verifies that optional editor/gameplay systems stay off the cold path and
// still wake through the same buttons a player uses.

import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const opts = new Map();
for (let i = 2; i < process.argv.length; i += 2) opts.set(process.argv[i], process.argv[i + 1]);
const port = Number(opts.get("--port") ?? 9337);
const urlNeedle = opts.get("--url") ?? "127.0.0.1:4173";
const output = opts.get("--output");
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
const errors = [];
const gpuErrors = [];
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Page.loadEventFired") pageLoadResolve?.();
  if (message.method === "Runtime.exceptionThrown") {
    const details = message.params.exceptionDetails;
    errors.push(details.exception?.description ?? details.text);
  } else if (message.method === "Log.entryAdded") {
    const line = message.params.entry.text;
    if (message.params.entry.level === "error") errors.push(line);
    if (/GPUValidationError|Invalid CommandBuffer|Instance range|binding size/i.test(line)) gpuErrors.push(line);
  } else if (message.method === "Runtime.consoleAPICalled") {
    const line = message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
    if (/GPUValidationError|Invalid CommandBuffer|Instance range|binding size/i.test(line)) gpuErrors.push(line);
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
await call("Log.enable");
await call("Page.enable");
await call("Page.bringToFront");
await call("Emulation.setDeviceMetricsOverride", {
  width: 1200, height: 900, deviceScaleFactor: 1, mobile: false,
});
const pageLoaded = new Promise((resolve) => { pageLoadResolve = resolve; });
await call("Page.reload", { ignoreCache: true });
await Promise.race([
  pageLoaded,
  new Promise((_, reject) => setTimeout(() => reject(new Error("page reload timeout")), 15000)),
]);
pageLoadResolve = null;

const evaluated = await call("Runtime.evaluate", {
  expression: `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = performance.now() + 90000;
    while (!window.__df?.decorReady && performance.now() < deadline) await sleep(50);
    if (!window.__df?.decorReady) throw new Error('decor-ready timeout');
    window.__df.controls.autoRotate = false;
    const optionalResources = () => performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => ['world/destruction.ts', 'player/player.ts', 'editor/shots.ts']
        .some((fragment) => name.includes(fragment)));
    const initial = {
      destruction: window.__df.destruction === null,
      player: window.__df.player === null,
      cameraShots: window.__df.cameraShots === null,
      optionalResources: optionalResources(),
    };

    const shotsStarted = performance.now();
    document.getElementById('btnShots').click();
    while (!window.__df.cameraShots?.open && performance.now() < deadline) await sleep(10);
    const shotsOpenedMs = performance.now() - shotsStarted;
    const shotsOpened = window.__df.cameraShots?.open === true;
    document.getElementById('btnShots').click();
    await sleep(20);
    const shotsClosed = window.__df.cameraShots?.open === false;

    const playerStarted = performance.now();
    document.getElementById('btnWalk').click();
    while ((!window.__df.player || document.getElementById('btnWalk').disabled)
      && performance.now() < deadline) await sleep(20);
    const playerLoadedMs = performance.now() - playerStarted;
    const playerLoaded = Boolean(window.__df.player);
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    const destructionStarted = performance.now();
    document.getElementById('btnBreak').click();
    while (!window.__df.destruction?.enabled && performance.now() < deadline) await sleep(20);
    const destructionReadyMs = performance.now() - destructionStarted;
    const destructionEnabled = window.__df.destruction?.enabled === true;
    document.getElementById('btnBreak').click();
    await sleep(20);
    const destructionDisabled = window.__df.destruction?.enabled === false;
    await (window.__df.ctx.renderer.backend?.device?.queue?.onSubmittedWorkDone?.() ?? Promise.resolve());
    return {
      initial,
      shots: { opened: shotsOpened, closed: shotsClosed, readyMs: shotsOpenedMs },
      player: { loaded: playerLoaded, readyMs: playerLoadedMs },
      destruction: { enabled: destructionEnabled, disabled: destructionDisabled, readyMs: destructionReadyMs },
      finalOptionalResources: optionalResources(),
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
  timeout: 120000,
});
if (evaluated.exceptionDetails) {
  errors.push(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text);
}
const result = evaluated.result?.value ?? null;
const report = { errors, gpuErrors, result };
if (output) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report));
ws.close();
if (
  errors.length || gpuErrors.length || !result
  || !result.initial.destruction || !result.initial.player || !result.initial.cameraShots
  || result.initial.optionalResources.length !== 0
  || !result.shots.opened || !result.shots.closed
  || !result.player.loaded
  || !result.destruction.enabled || !result.destruction.disabled
) process.exitCode = 1;
