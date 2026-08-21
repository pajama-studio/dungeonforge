// Cold-navigation startup timing through the existing Chrome CDP session.
// Measures the app's own milestones from module evaluation, avoiding network
// clock skew and keeping before/after runs directly comparable.

import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const opts = new Map();
for (let i = 2; i < process.argv.length; i += 2) opts.set(process.argv[i], process.argv[i + 1]);
const port = Number(opts.get("--port") ?? 9337);
const needle = opts.get("--url") ?? "127.0.0.1:4173";
const baseUrl = opts.get("--base-url");
const seed = opts.get("--seed") ?? "2820997495";
const islands = opts.get("--islands") ?? "20";
const output = opts.get("--output");
const screenshot = opts.get("--screenshot");
const cpuProfile = opts.get("--cpu-profile");
const waitDecor = opts.get("--decor") !== "false";
const waitPost = opts.get("--wait-post") === "true";
const waitAppMs = Number(opts.get("--wait-app-ms") ?? "0");
const bringToFront = opts.get("--bring-to-front") === "true";
const freezeCamera = opts.get("--freeze-camera") === "true";
const inventory = opts.get("--inventory") === "true";
const hiddenObjects = (opts.get("--hide-objects") ?? "").split(",").filter(Boolean);
const viewportWidth = Number(opts.get("--width") ?? "1200");
const viewportHeight = Number(opts.get("--height") ?? "900");
const viewportDpr = Number(opts.get("--dpr") ?? "1");
const reforgeSeed = opts.get("--reforge-seed");
const reforgeSettleMs = Number(opts.get("--reforge-settle-ms") ?? "500");
const navigate = opts.get("--navigate") !== "false";

const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find((entry) => entry.type === "page" && entry.url.includes(needle));
if (!page) throw new Error(`No page containing ${needle}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let nextId = 0;
const pending = new Map();
let loaded = null;
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Page.loadEventFired") loaded?.();
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

await call("Page.enable");
await call("Runtime.enable");
if (cpuProfile) {
  await call("Profiler.enable");
  await call("Profiler.setSamplingInterval", { interval: 500 });
  await call("Profiler.start");
}
if (bringToFront) await call("Page.bringToFront");
// Lock the review viewport BEFORE application modules evaluate. Changing DPR
// after the first WebGPU render invalidates every render object and turns the
// harness itself into the largest startup hitch. A no-navigation inspection
// must therefore preserve the viewport that produced the measured startup.
if (navigate) {
  await call("Emulation.setDeviceMetricsOverride", {
    width: viewportWidth,
    height: viewportHeight,
    deviceScaleFactor: viewportDpr,
    mobile: false,
  });
}
if (navigate) {
  const pageLoaded = new Promise((resolve) => { loaded = resolve; });
  const url = new URL(baseUrl ?? page.url);
  url.searchParams.set("seed", seed);
  url.searchParams.set("islands", islands);
  url.searchParams.set("rev", `startup-${Date.now()}`);
  await call("Page.navigate", { url: url.href });
  await Promise.race([pageLoaded, new Promise((_, reject) => setTimeout(() => reject(new Error("load timeout")), 15000))]);
  loaded = null;
}

const expression = `(async()=>{
  const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
  const deadline=performance.now()+120000;
  while(!window.__df?.coreReady&&performance.now()<deadline)await sleep(10);
  if(!window.__df?.coreReady)throw Error('core-ready timeout');
  // Review state must not inherit an authoring overlay from a previous CDP
  // action. Closing an inactive gizmo is a no-op and does not import its lazy
  // TransformControls chunk; closing an active one only detaches the helper.
  await window.__df.dragonPlacement?.setActive(false);
  if(${freezeCamera}){
    // Do not synthesize pointer input here. OrbitControls attempts pointer
    // capture for every pointerdown and browsers reject capture for an event
    // that has no active hardware pointer, leaving an unrelated exception for
    // the next regression harness to collect. Freeze the review camera through
    // the public controls state instead.
    window.__df.controls.autoRotate=false;
    window.__df.controls.enabled=false;
  }
  const atCore={...window.__df.startupTiming,observedAt:performance.now(),worlds:window.__df.ctx.worlds.length,
    generationMs:window.__df.ctx.walk.islands.map(island=>island.l.stats.genMs)};
  if(${waitPost}){
    while(!window.__df.startupTiming.postReadyAt&&performance.now()<deadline)await sleep(10);
    if(!window.__df.startupTiming.postReadyAt)throw Error('post-ready timeout');
  }
  if(${waitDecor}){
    while(!window.__df?.decorReady&&performance.now()<deadline)await sleep(25);
    if(!window.__df?.decorReady)throw Error('decor-ready timeout');
  }
  while(performance.now()<${JSON.stringify(waitAppMs)}&&performance.now()<deadline)await sleep(25);
  const reforgeSeed=${JSON.stringify(reforgeSeed)};
  let reforge;
  if(reforgeSeed!==undefined){
    const beforeRun=window.__df.forgeRun;
    const beforeToken=beforeRun?.token??0;
    const frameGapIndex=window.__df.startupTiming.frameGaps.length;
    const renderBlockIndex=window.__df.startupTiming.renderBlocks.length;
    const programsBefore=window.__df.ctx.renderer.info.memory.programs;
    const pipelinesBefore=window.__df.ctx.renderer._pipelines?.caches?.size??0;
    const requestedAt=performance.now();
    const input=document.getElementById('seedInput');
    input.value=String(reforgeSeed);
    document.getElementById('btnGo').click();
    while(performance.now()<deadline){
      const run=window.__df.forgeRun;
      if(run?.token>beforeToken&&(run.stage==='ready'||run.stage==='failed'))break;
      await sleep(10);
    }
    const run=window.__df.forgeRun;
    if(!run||run.token<=beforeToken)throw Error('reforge timeout');
    await sleep(${JSON.stringify(reforgeSettleMs)});
    reforge={
      seed:Number(reforgeSeed),stage:run.stage,error:run.error,
      observedMs:performance.now()-requestedAt,
      transactionMs:run.completedAt?run.completedAt-run.startedAt:null,
      stageTimings:run.timings,
      frameGaps:window.__df.startupTiming.frameGaps.slice(frameGapIndex),
      renderBlocks:window.__df.startupTiming.renderBlocks.slice(renderBlockIndex),
      programsBefore,programsAfter:window.__df.ctx.renderer.info.memory.programs,
      pipelinesBefore,pipelinesAfter:window.__df.ctx.renderer._pipelines?.caches?.size??0,
      camera:{position:window.__df.camera.position.toArray(),target:window.__df.controls.target.toArray(),fov:window.__df.camera.fov},
      worlds:window.__df.ctx.worlds.length,
    };
  }
  if(${JSON.stringify(Boolean(screenshot))}){
    for(const name of ${JSON.stringify(hiddenObjects)}){
      const object=window.__df.ctx.scene.getObjectByName(name);
      if(object)object.visible=false;
    }
    await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
    const queue=window.__df.ctx.renderer.backend?.device?.queue;
    await (queue?.onSubmittedWorkDone?.()??Promise.resolve());
  }
  const t={...window.__df.startupTiming};
  const loading=getComputedStyle(document.getElementById('loading'));
  const environmentObjects=${JSON.stringify(inventory)}?(()=>{
    const objects=[];
    window.__df.ctx.scene.getObjectByName('environment')?.traverse(object=>{
      if(!(object.isMesh||object.isLine||object.isSprite))return;
      const geometry=object.geometry;
      const indexCount=geometry?.index?.count??0;
      const vertexCount=geometry?.getAttribute?.('position')?.count??0;
      const path=[];
      for(let node=object;node;node=node.parent)path.push(node.name||node.type);
      objects.push({name:object.name||object.type,parent:object.parent?.name||object.parent?.type,
        path:path.reverse().join('/'),
        type:object.type,visible:object.visible,castShadow:object.castShadow===true,
        instances:Number.isFinite(object.count)?object.count:1,
        material:(Array.isArray(object.material)?object.material[0]:object.material)?.name||
          (Array.isArray(object.material)?object.material[0]:object.material)?.type,
        triangles:indexCount>0?indexCount/3:vertexCount/3});
    });
    return objects;
  })():undefined;
  const worldObjects=${JSON.stringify(inventory)}?(()=>{
    const objects=[];
    const roots=[...new Set(window.__df.ctx.worlds.map(world=>world.group))];
    for(const root of roots)root.traverse(object=>{
      if(!(object.isMesh||object.isLine||object.isSprite))return;
      const geometry=object.geometry;
      const indexCount=geometry?.index?.count??0;
      const vertexCount=geometry?.getAttribute?.('position')?.count??0;
      const path=[];
      for(let node=object;node;node=node.parent)path.push(node.name||node.type);
      objects.push({name:object.name||object.type,parent:object.parent?.name||object.parent?.type,
        path:path.reverse().join('/'),type:object.type,visible:object.visible,
        castShadow:object.castShadow===true,instances:Number.isFinite(object.count)?object.count:1,
        authoredInstances:object.isInstancedMesh?(object.userData.n??0):1,
        gpuSceneManaged:object.userData.gpuSceneManaged===true,
        material:(Array.isArray(object.material)?object.material[0]:object.material)?.name||
          (Array.isArray(object.material)?object.material[0]:object.material)?.type,
        triangles:indexCount>0?indexCount/3:vertexCount/3});
    });
    return objects;
  })():undefined;
  return {url:location.href,atCore,final:t,reforge,
    runtime:{reforging:window.__df.ctx.state.reforging,token:window.__df.ctx.state.token,
      visibility:document.visibilityState,hasFocus:document.hasFocus(),forgeRun:window.__df.forgeRun},
    loadingOpacity:Number(loading.opacity),worlds:window.__df.ctx.worlds.length,
    generatorBackend:window.__df.ctx.gen.backend,
    worldBuilds:window.__df.ctx.worlds.map(world=>({name:world.group.name,
      ms:world.group.userData.buildMs??null,masonryBuild:world.group.userData.masonryBuild??null})),
    landmarkStreams:window.__df.landmarkStreams?.(),
    dragonStream:(()=>{const slot=window.__df.ctx.scene.getObjectByName('streamed-colossal-perched-dragon-slot');return slot?{
      state:slot.userData.streamState,startedAt:slot.userData.streamStartedAt,
      preparedAt:slot.userData.streamPreparedAt,readyAt:slot.userData.streamReadyAt,
      surfaceSampleMs:slot.userData.surfaceSampleMs,surfaceSampleMode:slot.userData.surfaceSampleMode}:null})(),
    oracleStream:(()=>{const slot=window.__df.ctx.scene.getObjectByName('abyssal-cephalopod-oracle');return slot?{
      state:slot.userData.streamState,startedAt:slot.userData.streamStartedAt,
      readyAt:slot.userData.streamReadyAt}:null})(),
    gpuSceneStats:(()=>{const stats=window.__df.gpuScene?.stats;return stats?{
      ...stats,
      lowMasonry:stats.lowMasonry?{...stats.lowMasonry}:undefined,
      lowSurfaces:stats.lowSurfaces?{
        ...stats.lowSurfaces,
        tiles:stats.lowSurfaces.tiles?{...stats.lowSurfaces.tiles}:undefined,
        steps:stats.lowSurfaces.steps?{...stats.lowSurfaces.steps}:undefined,
        columns:stats.lowSurfaces.columns?{...stats.lowSurfaces.columns}:undefined,
        planks:stats.lowSurfaces.planks?{...stats.lowSurfaces.planks}:undefined,
      }:undefined,
    }:null})(),
    camera:{position:window.__df.camera.position.toArray(),target:window.__df.controls.target.toArray(),fov:window.__df.camera.fov},
    environmentObjects,worldObjects,
    heroResources:performance.getEntriesByType('resource')
      .filter(entry=>entry.name.startsWith('https://props.pajama.studio/')&&entry.name.endsWith('.glb'))
      .map(entry=>({name:entry.name,initiatorType:entry.initiatorType,startTime:entry.startTime,
        duration:entry.duration,fetchStart:entry.fetchStart,responseStart:entry.responseStart,
        responseEnd:entry.responseEnd,transferSize:entry.transferSize,
        encodedBodySize:entry.encodedBodySize,decodedBodySize:entry.decodedBodySize,
        deliveryType:entry.deliveryType??null})),
    wasmResources:performance.getEntriesByType('resource').filter(entry=>entry.name.includes('.wasm')).map(entry=>({name:entry.name,duration:entry.duration,bytes:entry.transferSize})),
    firstVisibleMs:(t.firstVisibleAt||t.coreReadyAt)-t.startedAt,
    coreReadyMs:t.coreReadyAt-t.startedAt,forgeReadyMs:t.forgeReadyAt?t.forgeReadyAt-t.startedAt:null,
    decorReadyMs:t.decorReadyAt?t.decorReadyAt-t.startedAt:null};
})()`;
const evaluated = await call("Runtime.evaluate", {
  expression, awaitPromise: true, returnByValue: true, timeout: 130000,
});
if (cpuProfile) {
  const sampled = await call("Profiler.stop");
  mkdirSync(dirname(cpuProfile), { recursive: true });
  writeFileSync(cpuProfile, `${JSON.stringify(sampled.profile)}\n`);
}
if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);
const result = evaluated.result.value;
if (output) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
}
if (screenshot) {
  const capture = await call("Page.captureScreenshot", { format: "png" });
  mkdirSync(dirname(screenshot), { recursive: true });
  writeFileSync(screenshot, Buffer.from(capture.data, "base64"));
  result.screenshot = screenshot;
}
console.log(JSON.stringify(result));
ws.close();
