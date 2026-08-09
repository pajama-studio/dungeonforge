// Sweep exposure in one session with the camera pinned, so "too dark" gets a
// number instead of a vibe.
import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__df?.coreReady === true, { timeout: 180000 }).catch(()=>{});
await page.waitForTimeout(20000);
await page.evaluate(() => {
  const df = window.__df;
  df.controls.autoRotate = false; df.controls.enabled = false;
  const pin = () => { df.camera.position.set(6,9,7); df.camera.lookAt(13,4,13);
    df.camera.updateMatrixWorld(true); requestAnimationFrame(pin); };
  pin();
});
await page.waitForTimeout(3000);
for (const e of [2.1, 2.5, 2.9, 3.3]) {
  await page.evaluate((v) => { window.__df.ctx.renderer.toneMappingExposure = v; }, e);
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${process.argv[2]}/exp-${e}.png` });
  console.log("shot", e);
}
await browser.close();
