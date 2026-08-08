import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const opts = new Map();
for (let i = 2; i < process.argv.length; i += 2) opts.set(process.argv[i], process.argv[i + 1]);
const port = Number(opts.get("--port") ?? 9337);
const output = opts.get("--output") ?? "artifacts/atmosphere/duel-lighting.png";
const reportFile = opts.get("--report") ?? output.replace(/\.png$/i, ".json");
const seed = opts.get("--seed") ?? "359139884";

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find((entry) => entry.type === "page" && entry.url.includes("127.0.0.1:4173"));
if (!page) throw new Error("Dungeonforge page not found");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Runtime.exceptionThrown") consoleErrors.push(message.params.exceptionDetails.text);
  if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
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
await call("Page.enable");
await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await call("Page.navigate", {
  url: `http://127.0.0.1:4173/?seed=${seed}&gen=typescript&islands=8&duel=${Date.now()}`,
});

const prepared = await call("Runtime.evaluate", {
  expression: `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = performance.now() + 90000;
    while ((!window.__df?.decorReady ||
      window.__df.ctx.scene.getObjectByName('abyssal-cephalopod-oracle')?.userData.streamState !== 'ready' ||
      window.__df.ctx.scene.getObjectByName('streamed-colossal-perched-dragon-slot')?.userData.streamState !== 'ready') &&
      performance.now() < deadline) await sleep(100);
    const { ctx, postProcessing } = window.__df;
    const THREE = await import('/node_modules/.vite/deps/three_webgpu.js');
    const oracle = ctx.scene.getObjectByName('abyssal-cephalopod-oracle');
    const dragon = ctx.scene.getObjectByName('tripo-v3.1-colossal-perched-abyss-dragon');
    const perch = ctx.scene.getObjectByName('colossal-dragon-perch-column');
    if (!oracle || !dragon || !perch) throw new Error('duel landmarks not ready');

    ctx.renderer.setAnimationLoop(null);
    window.__df.controls.autoRotate = false;
    document.querySelectorAll('#hud,#runHud,#runToast,#runReward,#modes,#tools,#params,#tip,#loading,#forgeStatus,#forgeSnapshot').forEach((node) => node.style.display = 'none');

    oracle.updateWorldMatrix(true, true);
    dragon.updateWorldMatrix(true, true);
    perch.updateWorldMatrix(true, true);
    const oracleBox = new THREE.Box3().setFromObject(oracle);
    const dragonBox = new THREE.Box3().setFromObject(dragon);
    const perchBox = new THREE.Box3().setFromObject(perch);
    const box = oracleBox.clone().union(dragonBox).union(perchBox);
    box.expandByPoint(window.__df.controls.target);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = size.length() * 0.5;
    // Side-stage view: oracle (-Z) and dragon (+Z) occupy opposing sides while
    // the dungeon remains the illuminated subject between them.
    const direction = new THREE.Vector3(-1, 0.22, 0.04).normalize();
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(ctx.camera.fov * 0.5)) * 1.08;
    const focus = center.clone();
    focus.y = THREE.MathUtils.lerp(box.min.y, box.max.y, 0.48);
    ctx.camera.position.copy(focus).addScaledVector(direction, distance);
    ctx.camera.near = 0.5;
    ctx.camera.far = Math.max(ctx.camera.far, distance + radius * 3);
    ctx.camera.lookAt(focus);
    ctx.camera.updateProjectionMatrix();
    postProcessing.render();
    postProcessing.render();
    await ctx.renderer.backend?.device?.queue?.onSubmittedWorkDone?.();

    const lightInfo = ['cinematic-oracle-face-key', 'cinematic-dragon-hoard-bounce'].map((name) => {
      const light = ctx.scene.getObjectByName(name);
      return light && { name, type: light.type, position: light.position.toArray(), intensity: light.intensity, distance: light.distance, color: light.color.getHexString() };
    });
    const emissive = [];
    oracle.traverse((object) => {
      if (!object.isMesh) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material?.isMeshStandardMaterial) emissive.push({ color: material.emissive.getHexString(), intensity: material.emissiveIntensity });
      }
    });
    return {
      camera: ctx.camera.position.toArray(), focus: focus.toArray(), bounds: size.toArray(),
      oracleBounds: { min: oracleBox.min.toArray(), max: oracleBox.max.toArray() },
      dragonBounds: { min: dragonBox.min.toArray(), max: dragonBox.max.toArray() },
      perchBounds: { min: perchBox.min.toArray(), max: perchBox.max.toArray() },
      oracleState: oracle.userData.streamState, dragonState: dragon.parent?.userData.streamState,
      lights: lightInfo, oracleEmissive: emissive,
      startup: window.__df.startupTiming,
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
  timeout: 100000,
});
if (prepared.exceptionDetails) throw new Error(prepared.exceptionDetails.text);

const captured = await call("Page.captureScreenshot", { format: "png" });
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, Buffer.from(captured.data, "base64"));
const report = { ...prepared.result.value, consoleErrors, output };
mkdirSync(dirname(reportFile), { recursive: true });
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
ws.close();
