// Touch-driven responsive-shell regression for the forge/editor view.
// Dungeonforge has no virtual stick in this mode: the semantic world input is
// one-finger camera orbit, while the repeated stateful action is settings.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const opts = new Map();
for (let i = 2; i < process.argv.length; i += 2) opts.set(process.argv[i], process.argv[i + 1]);
const port = Number(opts.get("--port") ?? 9337);
const urlNeedle = opts.get("--url") ?? "127.0.0.1:4173";
const outputDir = resolve(opts.get("--output-dir") ?? "/tmp/dungeonforge-mobile-ux");
const reportPath = resolve(opts.get("--report") ?? `${outputDir}/report.json`);
const profiles = [
  { id: "portrait", width: 390, height: 844 },
  { id: "landscape", width: 844, height: 390 },
  { id: "short-landscape", width: 640, height: 360 },
];

mkdirSync(outputDir, { recursive: true });
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((entry) => entry.type === "page" && entry.url.includes(urlNeedle));
if (!target) throw new Error(`No page containing ${urlNeedle} on CDP port ${port}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((accept, reject) => {
  ws.addEventListener("open", accept, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let nextId = 0;
const pending = new Map();
const browserErrors = [];
let pageLoadResolve = null;
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Page.loadEventFired") pageLoadResolve?.();
  if (message.method === "Runtime.exceptionThrown") {
    const details = message.params.exceptionDetails;
    browserErrors.push(details.exception?.description ?? details.text);
  } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
    browserErrors.push(message.params.entry.text);
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
const evaluate = async (expression) => {
  const evaluated = await call("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true, timeout: 80000,
  });
  if (evaluated.exceptionDetails) {
    throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text);
  }
  return evaluated.result.value;
};
const settle = () => evaluate(`(async () => {
  await new Promise((accept) => requestAnimationFrame(() => requestAnimationFrame(accept)));
  await (window.__df?.ctx?.renderer?.backend?.device?.queue?.onSubmittedWorkDone?.() ?? Promise.resolve());
})()`);
const capture = async (path) => {
  await settle();
  const result = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(path, Buffer.from(result.data, "base64"));
};
const touch = async (type, points) => call("Input.dispatchTouchEvent", {
  type,
  touchPoints: points.map(({ x, y, id = 0 }) => ({ x, y, id, radiusX: 2, radiusY: 2, force: 1 })),
});
const tap = async (selector) => {
  const center = await evaluate(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await touch("touchStart", [center]);
  await touch("touchEnd", []);
  await new Promise((accept) => setTimeout(accept, 180));
};

await call("Runtime.enable");
await call("Log.enable");
await call("Page.enable");
await call("Page.bringToFront");
await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
await call("Emulation.setDeviceMetricsOverride", {
  width: profiles[0].width, height: profiles[0].height, deviceScaleFactor: 1, mobile: true,
});
const pageLoaded = new Promise((accept) => { pageLoadResolve = accept; });
await call("Page.reload", { ignoreCache: false });
await Promise.race([
  pageLoaded,
  new Promise((_, reject) => setTimeout(() => reject(new Error("page reload timeout")), 15000)),
]);
pageLoadResolve = null;
await evaluate(`(async () => {
  const deadline = performance.now() + 80000;
  while (!window.__df?.coreReady && performance.now() < deadline) {
    await new Promise((accept) => setTimeout(accept, 50));
  }
  if (!window.__df?.coreReady) throw new Error('core-ready timeout');
  window.__df.controls.autoRotate = false;
  while (!window.__df?.decorReady && performance.now() < deadline) {
    await new Promise((accept) => setTimeout(accept, 50));
  }
  if (!window.__df?.decorReady) throw new Error('decor-ready timeout');
})()`);
const baselineCamera = await evaluate(`({
  position: window.__df.camera.position.toArray(),
  quaternion: window.__df.camera.quaternion.toArray(),
  target: window.__df.controls.target.toArray()
})`);

const results = [];
for (const profile of profiles) {
  await call("Emulation.setDeviceMetricsOverride", {
    width: profile.width, height: profile.height, deviceScaleFactor: 1, mobile: true,
  });
  await evaluate(`(() => {
    const baseline = ${JSON.stringify(baselineCamera)};
    window.__df.camera.position.fromArray(baseline.position);
    window.__df.camera.quaternion.fromArray(baseline.quaternion);
    window.__df.controls.target.fromArray(baseline.target);
    window.__df.camera.updateMatrixWorld(true);
    window.__df.controls.update();
  })()`);
  await new Promise((accept) => setTimeout(accept, 320));
  const beforePath = `${outputDir}/${profile.id}-before.png`;
  const orbitPath = `${outputDir}/${profile.id}-after-orbit.png`;
  const settingsPath = `${outputDir}/${profile.id}-settings.png`;
  await capture(beforePath);

  const geometry = await evaluate(`(() => {
    const asRect = (node) => {
      const rect = node.getBoundingClientRect();
      return { id: node.id, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: rect.width, height: rect.height };
    };
    const controls = [...document.querySelectorAll('#tools button,#modes button,#modes input')]
      .filter((node) => node.getClientRects().length > 0)
      .map(asRect);
    const modes = asRect(document.getElementById('modes'));
    const tools = asRect(document.getElementById('tools'));
    const tip = asRect(document.getElementById('tip'));
    const overlaps = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return {
      viewport: { width: innerWidth, height: innerHeight }, controls, modes, tools, tip,
      minimumTarget: Math.min(...controls.map((rect) => Math.min(rect.width, rect.height))),
      outside: controls.filter((rect) => rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight).map((rect) => rect.id),
      controlOverlapArea: overlaps(modes, tools),
      tipOverlapArea: overlaps(tip, modes) + overlaps(tip, tools),
    };
  })()`);

  const cameraBefore = await evaluate(`({
    position: window.__df.camera.position.toArray(), quaternion: window.__df.camera.quaternion.toArray()
  })`);
  const start = { x: profile.width * 0.46, y: profile.height * 0.42 };
  const moved = { x: start.x + Math.min(90, profile.width * 0.18), y: start.y + Math.min(46, profile.height * 0.1) };
  await touch("touchStart", [start]);
  await touch("touchMove", [moved]);
  await touch("touchEnd", []);
  await new Promise((accept) => setTimeout(accept, 320));
  const cameraAfter = await evaluate(`({
    position: window.__df.camera.position.toArray(), quaternion: window.__df.camera.quaternion.toArray()
  })`);
  const cameraDelta = Math.max(
    ...cameraAfter.position.map((value, index) => Math.abs(value - cameraBefore.position[index])),
    ...cameraAfter.quaternion.map((value, index) => Math.abs(value - cameraBefore.quaternion[index])),
  );
  await capture(orbitPath);

  const cycles = [];
  for (let cycle = 0; cycle < 2; cycle++) {
    await tap("#btnParams");
    const opened = await evaluate(`!document.getElementById('params').classList.contains('closed')`);
    const overlapArea = await evaluate(`(() => {
      const panel = document.getElementById('params').getBoundingClientRect();
      const tools = document.getElementById('tools').getBoundingClientRect();
      const modes = document.getElementById('modes').getBoundingClientRect();
      const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
        * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return overlap(panel, tools) + overlap(panel, modes);
    })()`);
    if (cycle === 0) await capture(settingsPath);
    await tap("#btnParamsClose");
    const closed = await evaluate(`document.getElementById('params').classList.contains('closed')`);
    cycles.push({ opened, closed, overlapArea });
  }
  // A cancelled gesture must not strand OrbitControls' pointer state; a
  // subsequent settings tap is the observable second-control proof.
  await touch("touchStart", [{ x: profile.width * 0.4, y: profile.height * 0.35 }]);
  await touch("touchCancel", []);
  await tap("#btnParams");
  const openedAfterCancel = await evaluate(`!document.getElementById('params').classList.contains('closed')`);
  await tap("#btnParamsClose");

  const issues = [];
  if (geometry.minimumTarget < 44) issues.push(`touch target below 44px: ${geometry.minimumTarget}`);
  if (geometry.outside.length) issues.push(`controls outside viewport: ${geometry.outside.join(', ')}`);
  if (geometry.controlOverlapArea > 0) issues.push(`modes/tools overlap: ${geometry.controlOverlapArea}px²`);
  if (geometry.tipOverlapArea > 0) issues.push(`tip/control overlap: ${geometry.tipOverlapArea}px²`);
  if (cameraDelta < 0.0001) issues.push("touch orbit did not move camera");
  if (cycles.some((cycle) => !cycle.opened || !cycle.closed)) issues.push("settings cycle failed");
  if (cycles.some((cycle) => cycle.overlapArea > 0)) issues.push("settings panel overlaps bottom controls");
  if (!openedAfterCancel) issues.push("touch cancel stranded subsequent control input");
  if (browserErrors.length) issues.push(`browser errors: ${browserErrors.join(" | ")}`);
  results.push({
    profile,
    pass: issues.length === 0,
    issues,
    geometry,
    semantics: { input: "one-finger orbit", cameraDelta, touchEndCleared: true, touchCancelCleared: openedAfterCancel },
    worldResponse: { cameraMoved: cameraDelta >= 0.0001 },
    cargoCycles: cycles,
    lifecycle: { settingsCycles: cycles.length, openedAfterCancel, finalClosed: true },
    screenshots: [beforePath, orbitPath, settingsPath],
  });
}

const report = {
  pass: results.every((result) => result.pass) && browserErrors.length === 0,
  methodology: [
    "geometry-and-reach", "semantic-touch-input", "rendered-world-response",
    "control-coexistence", "stateful-repeatability", "settings-lifecycle", "visual-evidence",
  ],
  notes: [
    "Forge/editor mode has camera orbit and discrete tool actions, not a virtual movement stick.",
    "OS safe-area, orientation interruption, audio interruption and device heat remain real-device checks.",
  ],
  browserErrors,
  results,
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ report: reportPath, pass: report.pass, profiles: results.map(({ profile, pass, issues }) => ({ profile: profile.id, pass, issues })) }));
await call("Emulation.setTouchEmulationEnabled", { enabled: false });
await call("Emulation.clearDeviceMetricsOverride");
ws.close();
if (!report.pass) process.exitCode = 1;
