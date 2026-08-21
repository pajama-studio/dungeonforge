import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const valueAfter = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const parseVector = (name) => {
  const value = valueAfter(name, "");
  if (!value) return null;
  const vector = value.split(",").map(Number);
  if (vector.length !== 3 || vector.some((component) => !Number.isFinite(component))) {
    throw new Error(`${name} must be x,y,z`);
  }
  return vector;
};

const port = valueAfter("--port", "9337");
const urlMatch = valueAfter("--url-match", "127.0.0.1:4173");
const output = valueAfter("--output", "/tmp/dungeonforge-composition.png");
const waitAppMs = Number(valueAfter("--wait-app-ms", "0"));
const emulateViewport = valueAfter("--emulation", "true") !== "false";
const bringToFront = valueAfter("--bring-to-front", "true") !== "false";
const camera = parseVector("--camera");
const target = parseVector("--target");
const hiddenNames = valueAfter("--hide", "").split(",").filter(Boolean);
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find((entry) => entry.type === "page" && entry.url.includes(urlMatch));
if (!page) throw new Error(`Dungeonforge page matching ${urlMatch} not found`);

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
if (bringToFront) await call("Page.bringToFront");
if (emulateViewport) {
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
}
const review = await call("Runtime.evaluate", {
  expression: `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = performance.now() + 60000;
    while (!window.__df?.decorReady && performance.now() < deadline) await sleep(100);
    const waitAppMs = ${JSON.stringify(waitAppMs)};
    while (performance.now() < waitAppMs && performance.now() < deadline) await sleep(100);
    const THREE = await import('/node_modules/.vite/deps/three_webgpu.js');
    const { camera: runtimeCamera, controls, ctx, postProcessing } = window.__df;
    // Do not instantiate the editor merely to close it. Its lazy bootstrap
    // restores saved lights and scene helpers, which invalidates the exact
    // render state this read-only startup review is meant to measure.
    if (window.__df.editor?.open) await window.__df.openEditor(false);
    const requestedCamera = ${JSON.stringify(camera)};
    const requestedTarget = ${JSON.stringify(target)};
    const hiddenNames = ${JSON.stringify(hiddenNames)};
    const hidden = [];
    for (const name of hiddenNames) {
      const object = ctx.scene.getObjectByName(name);
      if (!object) continue;
      hidden.push([object, object.visible]);
      object.visible = false;
    }
    window.__compositionRestore = () => {
      for (const [object, visible] of hidden) object.visible = visible;
      postProcessing.render();
      delete window.__compositionRestore;
    };
    if (requestedCamera) runtimeCamera.position.fromArray(requestedCamera);
    if (requestedTarget) controls.target.fromArray(requestedTarget);
    if (requestedCamera || requestedTarget || hiddenNames.length > 0) {
      runtimeCamera.lookAt(controls.target);
      controls.update();
      ctx.env.tick(runtimeCamera);
      postProcessing.render();
      postProcessing.render();
      const queue = ctx.renderer.backend?.device?.queue;
      if (queue?.onSubmittedWorkDone) await queue.onSubmittedWorkDone();
    }

    const objectBounds = (object) => {
      if (!object) return null;
      object.updateWorldMatrix(true, true);
      const box = new THREE.Box3();
      let found = false;
      object.traverse((child) => {
        if (!child.isMesh || !child.visible) return;
        if (child.isSkinnedMesh) child.computeBoundingBox();
        else if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
        const childBox = child.isSkinnedMesh ? child.boundingBox : child.geometry.boundingBox;
        if (!childBox) return;
        box.union(childBox.clone().applyMatrix4(child.matrixWorld));
        found = true;
      });
      return found ? box : null;
    };
    const project = (box) => {
      if (!box) return null;
      const min = new THREE.Vector3(Infinity, Infinity, Infinity);
      const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      for (let corner = 0; corner < 8; corner++) {
        const point = new THREE.Vector3(
          corner & 1 ? box.max.x : box.min.x,
          corner & 2 ? box.max.y : box.min.y,
          corner & 4 ? box.max.z : box.min.z,
        ).project(runtimeCamera);
        min.min(point);
        max.max(point);
      }
      return { min: min.toArray(), max: max.toArray() };
    };
    const describe = (object) => {
      const box = objectBounds(object);
      return box && {
        world: { min: box.min.toArray(), max: box.max.toArray() },
        ndc: project(box),
      };
    };
    const dungeonBox = new THREE.Box3();
    let hasDungeon = false;
    for (const world of ctx.worlds) {
      const box = objectBounds(world.group);
      if (box) { dungeonBox.union(box); hasDungeon = true; }
    }
    const dragon = ctx.scene.getObjectByName('tripo-v3.1-colossal-perched-abyss-dragon');
    const perch = ctx.scene.getObjectByName('colossal-dragon-slate-spire');
    return {
      camera: runtimeCamera.position.toArray(),
      target: controls.target.toArray(),
      fov: runtimeCamera.fov,
      dungeon: hasDungeon ? {
        world: { min: dungeonBox.min.toArray(), max: dungeonBox.max.toArray() },
        ndc: project(dungeonBox),
      } : null,
      dragon: describe(dragon),
      perch: describe(perch),
      landmarkStreams: window.__df.landmarkStreams?.(),
      cinematicLights: [
        'cinematic-oracle-face-key',
        'cinematic-dragon-hoard-bounce',
        'cinematic-dragon-rim',
      ].map((name) => {
        const light = ctx.scene.getObjectByName(name);
        return light && {
          name,
          intensity: light.intensity,
          color: light.color?.getHexString(),
          position: light.position.toArray(),
        };
      }),
      sceneLights: (() => {
        const lights = [];
        ctx.scene.traverse((object) => {
          if (object.isLight) lights.push({
            name: object.name,
            type: object.type,
            intensity: object.intensity,
            parent: object.parent?.name,
          });
        });
        return lights;
      })(),
      streamTimings: {
        dragon: ((data) => data && ({
          state: data.streamState,
          startedAt: data.streamStartedAt,
          preparedAt: data.streamPreparedAt,
          readyAt: data.streamReadyAt,
        }))(dragon?.parent?.userData),
        perch: ((data) => data && ({
          state: data.streamState,
          requestedAt: data.streamRequestedAt,
          readyAt: data.streamReadyAt,
        }))(perch?.userData),
        oracle: ((data) => data && ({
          state: data.streamState,
          readyAt: data.streamReadyAt,
        }))(ctx.scene.getObjectByName('streamed-abyssal-oracle-slot')?.userData),
      },
      rendererState: {
        pixelRatio: ctx.renderer.getPixelRatio(),
        size: ctx.renderer.getSize(new THREE.Vector2()).toArray(),
        contextNode: {
          id: ctx.renderer.contextNode?.id,
          version: ctx.renderer.contextNode?.version,
        },
      },
      godrayVolume: (() => {
        const volume = ctx.env.godrayVolume;
        return volume && {
          bottom: volume.bottom.value.toArray(),
          top: volume.top.value.toArray(),
          params: volume.params.value.toArray(),
        };
      })(),
      dragonState: dragon?.parent?.userData?.streamState,
      perchState: perch?.userData?.streamState,
      startupTiming: window.__df.startupTiming,
      postResources: performance.getEntriesByType('resource')
        .filter((entry) => entry.name.includes('/render/post.ts')
          || (entry.name.includes('/post-') && entry.name.endsWith('.js')))
        .map((entry) => ({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          transferSize: entry.transferSize,
        })),
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
  timeout: 80000,
});
if (review.exceptionDetails) {
  throw new Error(review.exceptionDetails.exception?.description ?? review.exceptionDetails.text);
}
const capture = await call("Page.captureScreenshot", { format: "png" });
await call("Runtime.evaluate", { expression: "window.__compositionRestore?.()" });
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, Buffer.from(capture.data, "base64"));
console.log(JSON.stringify({ output, ...review.result.value }, null, 2));
ws.close();
