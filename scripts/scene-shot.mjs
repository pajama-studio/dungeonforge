// Screenshot the running dungeon while sweeping the fracture uniform, so the
// crack layer can be judged under real scene lighting rather than a studio
// render. Driving the uniform directly avoids a re-forge: it is a uniform, so
// it takes effect on the next frame with no pipeline rebuild.
import { chromium } from "playwright";

const OUT = process.argv[2];
const LEVELS = process.argv.slice(3).map(Number);

// Dungeonforge renders through WebGPURenderer, and headless Chromium keeps
// WebGPU behind flags — without these the page throws
// "createIndirectStorageAttribute is not a function" and never draws.
const browser = await chromium.launch({
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan,UseSkiaRenderer",
    "--use-angle=metal",
    "--ignore-gpu-blocklist",
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (window).__df?.coreReady === true, { timeout: 180_000 })
  .catch(() => errors.push("coreReady never became true"));
await page.waitForTimeout(18_000); // decor + streamed landmarks

// Fracture is a close-range surface feature; from the default wide camera it
// contributes nothing and an A/B proves nothing. Park the camera against the
// masonry and freeze it so both exposures share one viewpoint.
const framed = await page.evaluate(() => {
  const df = (window).__df;
  if (!df?.camera || !df?.controls) return false;
  df.controls.autoRotate = false;
  df.controls.enabled = false;
  df.camera.position.set(6.5, 5.2, 12.0);
  df.controls.target.set(0.5, 3.4, 0.5);
  df.camera.lookAt(df.controls.target);
  df.controls.update?.();
  return true;
});
if (!framed) errors.push("camera/controls not exposed; using default view");
await page.waitForTimeout(2500);

for (const level of LEVELS) {
  const applied = await page.evaluate((v) => {
    const s = (window).__df?.stoneStyle;
    if (!s?.damage) return null;
    s.damage.value = v;
    return s.damage.value;
  }, level);
  if (applied === null) { errors.push("stoneStyle.damage not exposed"); break; }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/damage-${level}.png` });
  console.log("shot damage", applied);
}

await browser.close();
console.log(errors.length ? `ERRORS:\n${errors.slice(0, 5).join("\n")}` : "no page errors");
