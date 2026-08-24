// Measure the value pop at a LOD switch: same camera, same frame budget, only
// the pinned tier differs. Screenshot comparison across page loads is useless
// here — the visible set drifts — so pin the camera and sample in one session.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const OUT = process.argv[2];
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

for (const level of [2, 1, 0]) {
  await page.evaluate((l) => window.__df.masonry.forceLod(l), level);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/lod-${level}.png` });
  console.log("shot lod", level);
}
await browser.close();
