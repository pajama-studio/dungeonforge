// Does this scene respond to an environment map at all? 34 of its materials are
// MeshLambertNodeMaterial, and whether the WebGPU node path feeds IBL into a
// Lambert lighting model is not something to assume. Set one at runtime and
// measure.
import { chromium } from "playwright";
const OUT = process.argv[2];
const browser = await chromium.launch({ args: ["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__df?.coreReady === true, { timeout: 180000 }).catch(()=>{});
await page.waitForTimeout(20000);
await page.evaluate(() => {
  const df = window.__df;
  df.controls.autoRotate = false; df.controls.enabled = false;
  const pin = () => { df.camera.position.set(4,7,8); df.camera.lookAt(11,7,11);
    df.camera.updateMatrixWorld(true); requestAnimationFrame(pin); };
  pin();
});
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/no-ibl.png` });

const applied = await page.evaluate(async () => {
  const THREE = window.__df.ctx?.THREE ?? (await import("three/webgpu"));
  const scene = window.__df.ctx.scene;
  const renderer = window.__df.ctx.renderer;
  // A plain vertical gradient is enough to answer "does it respond".
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const t = 1 - y / size, i = (y * size + x) * 4;
    data[i] = 90 + t * 90; data[i+1] = 120 + t * 90; data[i+2] = 150 + t * 80; data[i+3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.needsUpdate = true;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(tex).texture;
  scene.environmentIntensity = 1.0;
  return !!scene.environment;
});
await page.waitForTimeout(3500);
await page.screenshot({ path: `${OUT}/with-ibl.png` });
console.log("environment applied:", applied);
await browser.close();
