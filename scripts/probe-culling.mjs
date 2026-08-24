import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__df?.coreReady === true, { timeout: 180000 }).catch(()=>{});
await page.waitForTimeout(20000);
const out = await page.evaluate(() => {
  const df = window.__df;
  const r = { gpu: df?.gpuScene?.stats ?? null, renderer: null, pools: null };
  const ri = df?.ctx?.renderer?.info;
  if (ri) r.renderer = { calls: ri.render?.calls, tris: ri.render?.triangles, programs: ri.programs?.length };
  // Count instances per mesh key across slot pools
  // Walk the scene graph: what is actually submitted, and how.
  const scene = df.ctx?.scene;
  const byType = {}; let instanced = 0, instancedInstances = 0, plainMeshes = 0, visibleMeshes = 0;
  const topKeys = {};
  scene?.traverse((o) => {
    if (!o.isMesh) return;
    const t = o.isInstancedMesh ? "InstancedMesh" : "Mesh";
    byType[t] = (byType[t] ?? 0) + 1;
    if (o.visible) visibleMeshes++;
    if (o.isInstancedMesh) {
      instanced++;
      instancedInstances += o.count ?? 0;
      if (o.visible && (o.count ?? 0) > 0) topKeys[o.name || "(unnamed)"] = (topKeys[o.name || "(unnamed)"] ?? 0) + 1;
    } else plainMeshes++;
  });
  r.graph = { byType, instanced, instancedInstances, plainMeshes, visibleMeshes };
  // Instance counts per key, which is what actually decides where merging pays.
  const perKey = {};
  scene?.traverse((o) => {
    if (!o.isInstancedMesh || !o.visible) return;
    const n = o.count ?? 0;
    if (!n) return;
    const k = o.name || "(unnamed)";
    perKey[k] = perKey[k] ?? { meshes: 0, instances: 0 };
    perKey[k].meshes++; perKey[k].instances += n;
  });
  r.perKey = Object.entries(perKey).sort((a,b)=>b[1].instances-a[1].instances).slice(0,16)
    .map(([k,v]) => `${k}: ${v.instances} inst across ${v.meshes} meshes`);
  const sm = df.ctx?.renderer?.shadowMap;
  r.shadows = sm ? { enabled: sm.enabled, type: sm.type } : null;
  const lights = []; scene?.traverse((o)=>{ if (o.isLight && o.castShadow) lights.push(o.type); });
  r.shadowCasters = lights;
  return r;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
