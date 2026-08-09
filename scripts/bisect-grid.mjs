// Zero one stone term at a time and shoot the same close-up. Whichever removal
// kills the lattice is the term drawing it. Guessing has now failed twice.
import { chromium } from "playwright";
const OUT = process.argv[2];
const browser = await chromium.launch({ args: ["--enable-unsafe-webgpu","--use-angle=metal","--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__df?.coreReady === true, { timeout: 180000 }).catch(()=>{});
await page.waitForTimeout(20000);
await page.evaluate(() => {
  const df = window.__df;
  df.controls.autoRotate = false; df.controls.enabled = false;
  const pin = () => { df.camera.position.set(6.0,5.0,6.5); df.camera.lookAt(12,4.4,12);
    df.camera.updateMatrixWorld(true); requestAnimationFrame(pin); };
  pin();
});
await page.waitForTimeout(3000);
// Snapshot the defaults once so each variant restores from a clean slate.
await page.evaluate(() => {
  const s = window.__df.stoneStyle; const base = {};
  for (const [k, v] of Object.entries(s)) if (v && typeof v.value === "number") base[k] = v.value;
  window.__dfBase = base;
});

const terms = ["baseline","paintedRelief","mortar","crack","damage","streak","pits","wear"];
for (const term of terms) {
  await page.evaluate((t) => {
    const s = window.__df.stoneStyle;
    // restore everything first
    for (const [k, v] of Object.entries(window.__dfBase ?? {})) s[k].value = v;
    if (t !== "baseline" && s[t]) s[t].value = 0;
  }, term);
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${OUT}/${term}.png` });
  console.log("shot", term);
}
await browser.close();
