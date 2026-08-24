// A/B inside one page load: same camera, same seed, only the toggle differs.
// Comparing separate runs is useless — the visible set differs by a few percent
// frame to frame, which is the same size as the effect being measured.
import { chromium } from "playwright";

const browser = await chromium.launch({ args: ["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__df?.coreReady === true, { timeout: 180000 }).catch(()=>{});
await page.waitForTimeout(20000);

// Pin the camera so the visible set cannot drift between samples.
await page.evaluate(() => {
  const df = window.__df;
  df.controls.autoRotate = false; df.controls.enabled = false;
  const pin = () => { df.camera.position.set(3,6,7); df.camera.lookAt(10,7,10);
    df.camera.updateMatrixWorld(true); requestAnimationFrame(pin); };
  pin();
});
await page.waitForTimeout(3000);

async function sample(label) {
  // Average several frames: info resets per render, so one read is a sample of
  // one frame, not a stable number.
  const runs = [];
  for (let i = 0; i < 8; i++) {
    runs.push(await page.evaluate(() => {
      const ri = window.__df.ctx.renderer.info;
      let visible = 0;
      window.__df.ctx.scene.traverse((o) => { if (o.isMesh && o.visible) visible++; });
      return { calls: ri.render?.calls ?? 0, tris: ri.render?.triangles ?? 0, visible };
    }));
    await page.waitForTimeout(220);
  }
  const med = (k) => runs.map(r=>r[k]).sort((a,b)=>a-b)[Math.floor(runs.length/2)];
  console.log(`${label.padEnd(22)} calls ${String(med("calls")).padStart(7)}  tris ${String(med("tris")).padStart(9)}  visibleMeshes ${med("visible")}`);
  return { calls: med("calls"), tris: med("tris") };
}

const off = await sample("far shadows OFF");
await page.evaluate(() => window.__df.masonry.setFarShadows(true));
await page.evaluate(() => document.querySelector("#btnForge")?.click?.());
await page.waitForTimeout(15000);
const on = await sample("far shadows ON");

console.log(`\ndelta: ${(on.calls - off.calls)} calls (${(100*(on.calls-off.calls)/Math.max(1,on.calls)).toFixed(1)}% of the ON figure)`);
await browser.close();
