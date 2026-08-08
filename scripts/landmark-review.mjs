import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const opts = new Map();
for (let i = 2; i < process.argv.length; i += 2) opts.set(process.argv[i], process.argv[i + 1]);
const port = Number(opts.get("--port") ?? 9337);
const outputDir = opts.get("--out-dir") ?? "artifacts/img2three/review";
const seed = opts.get("--seed") ?? "359139884";

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((item) => item.type === "page" && item.url.includes("127.0.0.1:4173"));
if (!target) throw new Error("Dungeonforge page not found");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
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
await call("Page.enable");
await call("Page.bringToFront");
await call("Emulation.setDeviceMetricsOverride", { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
await call("Page.navigate", { url: `http://127.0.0.1:4173/?seed=${seed}&gen=typescript&islands=8&review=landmarks` });
await new Promise((resolve) => setTimeout(resolve, 14500));

const defaultNames = [
  "tripo-v3.1-colossal-oathbound-wardens",
  "buried-dragon-skull",
  "abyssal-cephalopod-oracle",
  "tripo-v3.1-colossal-perched-abyss-dragon",
  "dragon-hoard-barrow-gate",
];
const names = (opts.get("--names") ?? defaultNames.join(",")).split(",").filter(Boolean);
const views = {
  front: [0, 0.06, 1],
  threeQuarter: [0.86, 0.24, 0.51],
  side: [1, 0.08, 0.08],
  high: [0.2, 0.62, 1],
};
const report = {};
mkdirSync(outputDir, { recursive: true });

for (const name of names) {
  const prepared = await call("Runtime.evaluate", {
    expression: `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const THREE = await import('/node_modules/.vite/deps/three_webgpu.js');
      const deadline = performance.now() + 60000;
      while ((!window.__df || !window.__df.coreReady) && performance.now() < deadline) await sleep(100);
      const { ctx } = window.__df;
      ctx.renderer.setAnimationLoop(null);
      window.__df.controls.autoRotate = false;
      // Neutral review lighting: remove gameplay fog/sky so topology and
      // material errors cannot hide in the intended abyss atmosphere.
      ctx.scene.fogNode = null;
      ctx.scene.backgroundNode = null;
      ctx.scene.background = new THREE.Color(0x59636d);
      document.querySelectorAll('#hud,#runHud,#runToast,#runReward,#modes,#tools,#params,#tip,#loading,#forgeStatus,#forgeSnapshot').forEach((node) => node.style.display = 'none');
      let target = ctx.scene.getObjectByName(${JSON.stringify(name)});
      while (!target && performance.now() < deadline) {
        await sleep(100);
        target = ctx.scene.getObjectByName(${JSON.stringify(name)});
      }
      if (!target) throw new Error('missing target: ${name}');
      if (target.isInstancedMesh) target.count = 1;
      const isInside = (object, ancestor) => {
        for (let node = object; node; node = node.parent) if (node === ancestor) return true;
        return false;
      };
      ctx.scene.traverse((object) => {
        if ((object.isMesh || object.isLine || object.isSprite) && !isInside(object, target)) object.visible = false;
      });
      target.visible = true;
      target.traverse((object) => {
        if (!object.userData?.proceduralFallback) object.visible = true;
      });
      const reviewFill = new THREE.HemisphereLight(0xb7c7df, 0x27303b, 1.7);
      const reviewKey = new THREE.DirectionalLight(0xfff1d8, 2.4);
      reviewKey.position.set(-80, 120, 110);
      ctx.scene.add(reviewFill, reviewKey);
      target.updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(target);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const instanceQ = new THREE.Quaternion();
      if (target.isInstancedMesh) {
        const m = new THREE.Matrix4();
        target.getMatrixAt(0, m);
        m.decompose(new THREE.Vector3(), instanceQ, new THREE.Vector3());
      } else target.getWorldQuaternion(instanceQ);
      window.__landmarkReview = { target, center, size, instanceQ, THREE };
      return { center: center.toArray(), size: size.toArray(), modelStats: target.parent?.userData?.modelStats ?? target.parent?.parent?.userData?.modelStats ?? null };
    })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: 80000,
  });
  if (prepared.exceptionDetails) throw new Error(prepared.exceptionDetails.text);
  report[name] = { bounds: prepared.result.value, views: {} };
  for (const [view, direction] of Object.entries(views)) {
    const rendered = await call("Runtime.evaluate", {
      expression: `(async () => {
        const { ctx, postProcessing } = window.__df;
        const review = window.__landmarkReview;
        const THREE = review.THREE;
        const isInside = (object, ancestor) => {
          for (let node = object; node; node = node.parent) if (node === ancestor) return true;
          return false;
        };
        ctx.scene.traverse((object) => {
          if ((object.isMesh || object.isLine || object.isSprite) && !isInside(object, review.target)) object.visible = false;
        });
        const dir = new THREE.Vector3(${direction.join(",")}).normalize();
        const maxDim = Math.max(review.size.x, review.size.y, review.size.z);
        const distance = maxDim / (2 * Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov) / 2)) * 1.28;
        ctx.camera.position.copy(review.center).addScaledVector(dir, distance);
        ctx.camera.lookAt(review.center);
        ctx.camera.far = Math.max(ctx.camera.far, distance + maxDim * 2.5);
        ctx.camera.updateProjectionMatrix();
        postProcessing.render();
        postProcessing.render();
        const queue = ctx.renderer.backend?.device?.queue;
        if (queue?.onSubmittedWorkDone) await queue.onSubmittedWorkDone();
        return { camera: ctx.camera.position.toArray(), distance };
      })()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 30000,
    });
    if (rendered.exceptionDetails) throw new Error(rendered.exceptionDetails.text);
    const captured = await call("Page.captureScreenshot", { format: "png" });
    const file = `${outputDir}/${name}-${view}.png`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(captured.data, "base64"));
    report[name].views[view] = { file, ...rendered.result.value };
  }
}

writeFileSync(`${outputDir}/review.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
ws.close();
