import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const output = process.argv[2] ?? "artifacts/img2three/dragon-slate-spire/tripo-custom/runtime-contact.png";
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
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const requestId = ++id;
  pending.set(requestId, { resolve, reject });
  ws.send(JSON.stringify({ id: requestId, method, params }));
});

await call("Runtime.enable");
await call("Page.enable");
await call("Page.bringToFront");
await call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
const review = await call("Runtime.evaluate", {
  expression: `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const THREE = await import('/node_modules/.vite/deps/three_webgpu.js');
    const deadline = performance.now() + 60000;
    let scene, perch, dragon, skinned;
    while (performance.now() < deadline) {
      scene = window.__df?.ctx?.scene;
      perch = scene?.getObjectByName('colossal-dragon-slate-spire');
      dragon = scene?.getObjectByName('tripo-v3.1-colossal-perched-abyss-dragon');
      skinned = dragon?.getObjectByProperty('isSkinnedMesh', true);
      if (perch?.userData.streamState === 'ready' && skinned) break;
      await sleep(100);
    }
    if (!perch || !skinned) throw new Error('dragon/perch not ready');
    const { ctx, postProcessing, controls } = window.__df;
    ctx.renderer.setAnimationLoop(null);
    controls.autoRotate = false;
    controls.enabled = false;
    document.querySelectorAll('#hud,#runHud,#runToast,#runReward,#modes,#tools,#params,#tip,#loading,#forgeStatus,#forgeSnapshot,#dragonGizmoPanel').forEach((node) => node.style.display = 'none');
    const landmark = scene.getObjectByName('dragon-slate-spire-landmark');
    const inside = (object, ancestor) => {
      for (let node = object; node; node = node.parent) if (node === ancestor) return true;
      return false;
    };
    scene.traverse((object) => {
      if ((object.isMesh || object.isLine || object.isSprite) && !inside(object, landmark)) object.visible = false;
    });
    for (const child of landmark.children) child.visible = child === perch || child.name === 'streamed-colossal-perched-dragon-slot';
    perch.visible = true;
    dragon.visible = true;
    const names = ['fore_left','fore_right','hind_left','hind_right'];
    const feet = names.map((name) => skinned.skeleton.bones.find((bone) => bone.name === name + '_foot').getWorldPosition(new THREE.Vector3()));
    const targets = names.map((name) => skinned.skeleton.bones.find((bone) => bone.name === 'ik_' + name + '_target').getWorldPosition(new THREE.Vector3()));
    const center = feet.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / feet.length);
    center.y -= 12;
    const cameraOffset = new THREE.Vector3(155, 82, 172);
    ctx.camera.position.copy(center).add(cameraOffset);
    ctx.camera.lookAt(center);
    ctx.camera.near = 1;
    ctx.camera.far = 2200;
    ctx.camera.updateProjectionMatrix();
    postProcessing.render();
    postProcessing.render();
    const queue = ctx.renderer.backend?.device?.queue;
    if (queue?.onSubmittedWorkDone) await queue.onSubmittedWorkDone();
    return {
      camera: ctx.camera.position.toArray(),
      center: center.toArray(),
      errors: Object.fromEntries(names.map((name, index) => [name, feet[index].distanceTo(targets[index])])),
      surfaceHits: Object.fromEntries((landmark.getObjectByName('streamed-colossal-perched-dragon-slot')?.userData.legIkTargets ?? []).map((entry) => [entry.name, entry.surfaceHit])),
      triangles: perch.userData.renderTriangles,
      vertices: perch.userData.renderVertices,
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
  timeout: 80000,
});
if (review.exceptionDetails) throw new Error(review.exceptionDetails.exception?.description ?? review.exceptionDetails.text);
const capture = await call("Page.captureScreenshot", { format: "png" });
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, Buffer.from(capture.data, "base64"));
console.log(JSON.stringify({ output, ...review.result.value }, null, 2));
ws.close();
