import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const opts = new Map();
for (let i = 2; i < process.argv.length; i += 2) opts.set(process.argv[i], process.argv[i + 1]);
const output = opts.get("--output") ?? "artifacts/atmosphere/review.png";
const seed = opts.get("--seed") ?? "359139884";
const pages = await (await fetch("http://127.0.0.1:9337/json/list")).json();
const page = pages.find((entry) => entry.type === "page" && entry.url.includes("127.0.0.1:4173"));
if (!page) throw new Error("Dungeonforge page not found");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let id = 0;
const pending = new Map();
const errors = [];
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
  if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) {
    errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
  }
  if (!message.id) return;
  const job = pending.get(message.id);
  if (!job) return;
  pending.delete(message.id);
  message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const requestId = ++id;
  pending.set(requestId, { resolve, reject });
  ws.send(JSON.stringify({ id: requestId, method, params }));
});

await call("Runtime.enable");
await call("Page.enable");
await call("Page.bringToFront");
await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
if (!process.argv.includes("--no-nav")) {
  await call("Page.navigate", { url: `http://127.0.0.1:4173/?seed=${seed}&gen=typescript&islands=8&atmosphere=${Date.now()}` });
}
const evaluated = await call("Runtime.evaluate", {
  expression: `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = performance.now() + 45000;
    while ((!window.__df?.coreReady || window.__df?.ctx?.scene?.getObjectByName('streamed-colossal-perched-dragon-slot')?.userData.streamState !== 'ready') && performance.now() < deadline) await sleep(100);
    const { ctx, postProcessing, controls, dragonPlacement } = window.__df;
    await dragonPlacement?.setActive(false);
    controls.autoRotate = false;
    ctx.renderer.setAnimationLoop(null);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, top = 0;
    for (const island of ctx.walk.islands) {
      const halfCell = island.l.N * 2.2 / 2;
      minX = Math.min(minX, island.ox - halfCell); maxX = Math.max(maxX, island.ox + halfCell);
      minZ = Math.min(minZ, island.oz - halfCell); maxZ = Math.max(maxZ, island.oz + halfCell);
      top = Math.max(top, island.oy + 34);
    }
    const cx = (minX + maxX) * .5, cz = (minZ + maxZ) * .5;
    const half = Math.max(maxX - minX, maxZ - minZ) * .5;
    if (!${process.argv.includes("--default-camera")}) {
      ctx.camera.position.set(cx + half * .82, half * .58 + top * .36, cz + half * 1.32);
      controls.target.set(cx, 18 + top * .2, cz);
      ctx.camera.lookAt(controls.target);
      ctx.camera.updateProjectionMatrix();
    }
    document.querySelectorAll('#hud,#runHud,#runToast,#runReward,#modes,#tools,#params,#tip,#loading,#forgeStatus,#forgeSnapshot,#dragonGizmoPanel').forEach((node) => node.style.display = 'none');
    const samples = [];
    for (let i = 0; i < 6; i++) {
      const start = performance.now();
      postProcessing.render();
      await ctx.renderer.backend?.device?.queue?.onSubmittedWorkDone?.();
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    let particleDraws = 0, particleInstances = 0;
    ctx.scene.traverse((object) => {
      if (!object.userData?.atmosphereParticles) return;
      particleDraws++;
      particleInstances += object.count ?? 1;
    });
    const bedrock = ctx.scene.getObjectByName('terraced-weathered-abyss-bedrock');
    return {
      camera: ctx.camera.position.toArray(), target: controls.target.toArray(),
      renderMedianMs: samples[Math.floor(samples.length / 2)], samples,
      particles: { draws: particleDraws, instances: particleInstances },
      bedrock: bedrock && {
        terrain: bedrock.userData.terrain,
        vertices: bedrock.geometry.getAttribute('position')?.count,
        triangles: bedrock.geometry.index?.count / 3,
        draws: 1,
      },
      startup: window.__df.startupTiming,
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
  timeout: 60000,
});
if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
const screenshot = await call("Page.captureScreenshot", { format: "png" });
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, Buffer.from(screenshot.data, "base64"));
const report = { ...evaluated.result.value, errors, output };
writeFileSync(output.replace(/\.png$/i, ".json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
ws.close();
