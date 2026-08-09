// Is the distant shader worth its pop? Measure the frame cost of running the
// near material at every tier against the normal LOD split, from one camera in
// one session.
import { chromium } from "playwright";

const browser = await chromium.launch({ args: ["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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

async function frameCost(label) {
  const r = await page.evaluate(() => new Promise((resolve) => {
    const deltas = []; let last = performance.now(); let n = 0;
    const tick = () => {
      const now = performance.now();
      deltas.push(now - last); last = now;
      if (++n < 140) requestAnimationFrame(tick);
      else {
        deltas.sort((a, b) => a - b);
        const ri = window.__df.ctx.renderer.info;
        resolve({
          median: deltas[Math.floor(deltas.length / 2)],
          p90: deltas[Math.floor(deltas.length * 0.9)],
          calls: ri.render?.calls ?? 0,
          tris: ri.render?.triangles ?? 0,
        });
      }
    };
    requestAnimationFrame(tick);
  }));
  console.log(`${label.padEnd(26)} median ${r.median.toFixed(2)}ms  p90 ${r.p90.toFixed(2)}ms  calls ${r.calls}  tris ${r.tris.toLocaleString()}`);
  return r;
}

const normal = await frameCost("normal LOD split");
await page.evaluate(() => window.__df.masonry.forceLod(2));
await page.waitForTimeout(4000);
const near = await frameCost("near shader everywhere");

const d = 100 * (near.median - normal.median) / normal.median;
console.log(`\nnear-everywhere costs ${d >= 0 ? "+" : ""}${d.toFixed(1)}% median frame time`);
await browser.close();
