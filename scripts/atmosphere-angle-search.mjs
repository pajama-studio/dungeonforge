import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const outputDir = process.argv[2] ?? "artifacts/atmosphere/angles";
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
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
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
await call("Emulation.setDeviceMetricsOverride", { width: 960, height: 600, deviceScaleFactor: 1, mobile: false });
mkdirSync(outputDir, { recursive: true });

const views = [
  [0.76, 0.18, 0.65], [-0.76, 0.18, 0.65],
  [0.76, 0.18, -0.65], [-0.76, 0.18, -0.65],
  [0.12, 0.16, 1], [1, 0.16, 0.12],
];
const report = [];
for (let index = 0; index < views.length; index++) {
  const evaluated = await call("Runtime.evaluate", {
    expression: `(async () => {
      const THREE = await import('/node_modules/.vite/deps/three_webgpu.js');
      const { ctx, postProcessing, controls } = window.__df;
      const oracle = ctx.scene.getObjectByName('abyssal-cephalopod-oracle');
      const dragon = ctx.scene.getObjectByName('tripo-v3.1-colossal-perched-abyss-dragon');
      if (!oracle || !dragon) throw new Error('landmarks not ready');
      oracle.updateWorldMatrix(true, true); dragon.updateWorldMatrix(true, true);
      const oracleBox = new THREE.Box3().setFromObject(oracle);
      const dragonBox = new THREE.Box3().setFromObject(dragon);
      const oracleAnchor = oracleBox.getCenter(new THREE.Vector3());
      oracleAnchor.y = THREE.MathUtils.lerp(oracleBox.min.y, oracleBox.max.y, .66);
      const dragonAnchor = dragonBox.getCenter(new THREE.Vector3());
      dragonAnchor.y = THREE.MathUtils.lerp(dragonBox.min.y, dragonBox.max.y, .58);
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, mazeTop = -Infinity;
      for (const island of ctx.walk.islands) {
        const halfCell = island.l.N * 2.2 * .5;
        minX = Math.min(minX, island.ox - halfCell); maxX = Math.max(maxX, island.ox + halfCell);
        minZ = Math.min(minZ, island.oz - halfCell); maxZ = Math.max(maxZ, island.oz + halfCell);
        mazeTop = Math.max(mazeTop, island.oy + 34);
      }
      const mazeAnchor = new THREE.Vector3((minX + maxX) * .5, mazeTop * .38, (minZ + maxZ) * .5);
      const focus = oracleAnchor.clone().multiplyScalar(.29)
        .addScaledVector(dragonAnchor, .38)
        .addScaledVector(mazeAnchor, .33);
      const direction = new THREE.Vector3(...${JSON.stringify(views[index])}).normalize();
      const landmarkSpan = oracleAnchor.distanceTo(dragonAnchor);
      const distance = Math.max(430, landmarkSpan * 1.34);
      ctx.camera.position.copy(focus).addScaledVector(direction, distance);
      ctx.camera.fov = 48;
      ctx.camera.near = .5;
      ctx.camera.far = Math.max(ctx.camera.far, distance * 2.4);
      controls.target.copy(focus);
      ctx.camera.lookAt(focus);
      ctx.camera.updateProjectionMatrix();
      postProcessing.render(); postProcessing.render();
      await ctx.renderer.backend?.device?.queue?.onSubmittedWorkDone?.();
      return { camera: ctx.camera.position.toArray(), focus: focus.toArray(), distance, oracleAnchor: oracleAnchor.toArray(), dragonAnchor: dragonAnchor.toArray() };
    })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: 30000,
  });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
  const shot = await call("Page.captureScreenshot", { format: "png" });
  const file = join(outputDir, `angle-${index + 1}.png`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  report.push({ index: index + 1, direction: views[index], ...evaluated.result.value, file });
}
writeFileSync(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
ws.close();
