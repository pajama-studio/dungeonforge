// Render-and-score search for the hand-painted masonry controls. Every loop
// is a real post-processed WebGPU frame captured through CDP. WebGPU swap
// canvases are not preserveDrawingBuffer surfaces, so drawImage(canvas) is an
// invalid measurement source on several Chrome/GPU combinations.

import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const port = Number(args.get("--port") ?? 9337);
const rounds = Number(args.get("--rounds") ?? 100);
const needle = args.get("--url") ?? "127.0.0.1:4173";
const targetPath = args.get("--target") ?? "/artifacts/image-feedback/handpaint-target-v1.png";
const output = args.get("--output") ?? "artifacts/image-feedback/visual-search-100.json";
const screenshot = args.get("--screenshot") ?? "artifacts/image-feedback/visual-search-best.png";

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
let pageLoaded = null;
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Page.loadEventFired") pageLoaded?.();
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

await call("Runtime.enable");
await call("Page.enable");
await call("Emulation.setDeviceMetricsOverride", {
  width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
});
const loaded = new Promise((resolve) => { pageLoaded = resolve; });
const url = new URL(page.url);
url.searchParams.set("seed", "2820997495");
url.searchParams.set("islands", "20");
url.searchParams.set("rev", `visual-search-${Date.now()}`);
await call("Page.navigate", { url: url.href });
await Promise.race([loaded, new Promise((_, reject) => setTimeout(() => reject(new Error("load timeout")), 15000))]);
pageLoaded = null;

const setupExpression = `(async()=>{
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const deadline=performance.now()+60000;
  while(!window.__df?.decorReady&&performance.now()<deadline)await sleep(100);
  if(!window.__df?.decorReady)throw Error('decor timeout');
  const d=window.__df, style=d.stoneStyle;
  if(!style)throw Error('stoneStyle hook missing');
  d.ctx.renderer.setAnimationLoop(null);
  d.ctx.renderer.setPixelRatio(1);
  d.controls.autoRotate=false;
  d.camera.position.set(43,14,0);
  d.controls.target.set(30,6,0);
  d.camera.lookAt(d.controls.target);
  d.setAllDetail(true);
  const queue=d.ctx.renderer.backend?.device?.queue;
  const waitGpu=queue?.onSubmittedWorkDone?()=>queue.onSubmittedWorkDone():()=>Promise.resolve();
  const draw=async()=>{d.postProcessing.render();await waitGpu()};
  await draw();await draw();

  const W=288,H=142;
  const sample=document.createElement('canvas');sample.width=W;sample.height=H;
  const sx=sample.getContext('2d',{willReadFrequently:true});
  const target=document.createElement('canvas');target.width=W;target.height=H;
  const tx=target.getContext('2d',{willReadFrequently:true});
  const image=new Image();image.crossOrigin='anonymous';image.src=${JSON.stringify(targetPath)}+'?v='+Date.now();
  await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('target image load failed: '+image.src))});
  // Exclude the title and bottom control bar. Both inputs use the same camera
  // aspect but imagegen may change exact pixel dimensions.
  tx.drawImage(image,0,image.height*(96/900),image.width,image.height*(714/900),0,0,W,H);

  const metrics=(ctx)=>{
    const p=ctx.getImageData(0,0,W,H).data;
    const lum=new Float32Array(W*H),satHist=new Array(12).fill(0),lumHist=new Array(20).fill(0);
    let warm=0,cool=0,dark=0,mid=0,satSum=0,edgeWarm=0,edgeN=0;
    for(let i=0,j=0;i<p.length;i+=4,j++){
      const r=p[i]/255,g=p[i+1]/255,b=p[i+2]/255;
      const hi=Math.max(r,g,b),lo=Math.min(r,g,b),s=hi===0?0:(hi-lo)/hi;
      const l=0.2126*r+0.7152*g+0.0722*b;lum[j]=l;
      lumHist[Math.min(19,l*20|0)]++;satHist[Math.min(11,s*12|0)]++;satSum+=s;
      if(l<0.10)dark++;if(l>=0.10&&l<0.32)mid++;
      if(r>b*1.13&&r>g*1.03&&l>0.09)warm++;
      if(b>r*1.12&&b>g*0.92&&l>0.07)cool++;
    }
    const gradHist=new Array(16).fill(0);let gradSum=0,gradHigh=0;
    for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){
      const i=y*W+x,gx=Math.abs(lum[i+1]-lum[i-1]),gy=Math.abs(lum[i+W]-lum[i-W]);
      const g=Math.min(1,(gx+gy)*2.2);gradHist[Math.min(15,g*16|0)]++;gradSum+=g;if(g>0.24)gradHigh++;
      if(g>0.16){const k=i*4;edgeWarm+=(p[k]-p[k+2])/255;edgeN++}
    }
    const n=W*H,gn=(W-2)*(H-2);
    for(const h of [lumHist,satHist])for(let i=0;i<h.length;i++)h[i]/=n;
    for(let i=0;i<gradHist.length;i++)gradHist[i]/=gn;
    return {lumHist,satHist,gradHist,warm:warm/n,cool:cool/n,dark:dark/n,mid:mid/n,
      sat:satSum/n,grad:gradSum/gn,gradHigh:gradHigh/gn,edgeWarm:edgeWarm/Math.max(1,edgeN)};
  };
  const targetMetrics=metrics(tx);
  const hist=(a,b)=>a.reduce((s,v,i)=>s+Math.abs(v-b[i]),0)/2;
  const score=(m)=>{
    const parts={
      luminance:hist(m.lumHist,targetMetrics.lumHist)*4.0,
      saturation:hist(m.satHist,targetMetrics.satHist)*1.6,
      gradients:hist(m.gradHist,targetMetrics.gradHist)*2.2,
      warm:Math.abs(m.warm-targetMetrics.warm)*2.0,
      cool:Math.abs(m.cool-targetMetrics.cool)*1.5,
      dark:Math.abs(m.dark-targetMetrics.dark)*1.2,
      mid:Math.abs(m.mid-targetMetrics.mid)*1.0,
      edgeWarm:Math.abs(m.edgeWarm-targetMetrics.edgeWarm)*1.4,
      highFrequency:Math.abs(m.gradHigh-targetMetrics.gradHigh)*1.5,
    };
    return {total:Object.values(parts).reduce((a,b)=>a+b,0),parts};
  };
  const halton=(i,b)=>{let f=1,r=0;while(i>0){f/=b;r+=f*(i%b);i=Math.floor(i/b)}return r};
  const lerp=(a,b,t)=>a+(b-a)*t;
  const candidate=(loop)=>{
    if(loop===1)return {base:.80,broadGrain:.16,midGrain:.13,fineGrain:.09,mortar:.42,streak:.22,wear:.16,pits:.40,crack:.55,warmEdge:0};
    if(loop===2)return {base:.79,broadGrain:.18,midGrain:.105,fineGrain:.028,mortar:.49,streak:.15,wear:.23,pits:.22,crack:.50,warmEdge:.68};
    const i=loop-1;
    return {
      base:lerp(.75,.84,halton(i,2)),broadGrain:lerp(.09,.23,halton(i,3)),
      midGrain:lerp(.055,.16,halton(i,5)),fineGrain:lerp(.012,.082,halton(i,7)),
      mortar:lerp(.34,.56,halton(i,11)),streak:lerp(.09,.26,halton(i,13)),
      wear:lerp(.12,.29,halton(i,17)),pits:lerp(.12,.42,halton(i,19)),
      crack:lerp(.32,.64,halton(i,23)),warmEdge:lerp(.05,.95,halton(i,29)),
    };
  };
  const set=(c)=>{for(const [key,value] of Object.entries(c))style[key].value=value};
  window.__visualSearch={
    targetMetrics,
    geometry:{instances:(()=>{let n=0;d.ctx.scene.traverse(o=>{if(o.visible&&o.isInstancedMesh)n+=o.count});return n})()},
    async render(loop){
      const params=candidate(loop);set(params);const t0=performance.now();await draw();
      return {loop,params,renderMs:performance.now()-t0};
    },
    async measure(dataUrl){
      const image=new Image();image.src=dataUrl;
      await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('capture load failed'))});
      sx.clearRect(0,0,W,H);sx.drawImage(image,0,0,W,H);
      const m=metrics(sx),s=score(m);
      return {score:s.total,components:s.parts,metrics:m};
    },
    async apply(params){set(params);await draw();await draw()},
  };
  return {targetMetrics,geometry:window.__visualSearch.geometry};
})()`;

const setup = await call("Runtime.evaluate", {
  expression: setupExpression, awaitPromise: true, returnByValue: true, timeout: 90000,
});
if (setup.exceptionDetails) throw new Error(setup.exceptionDetails.text);

const loops = [];
let best = null;
for (let loop = 1; loop <= rounds; loop++) {
  const rendered = await call("Runtime.evaluate", {
    expression: `window.__visualSearch.render(${loop})`,
    awaitPromise: true, returnByValue: true, timeout: 30000,
  });
  if (rendered.exceptionDetails) throw new Error(`render ${loop}: ${rendered.exceptionDetails.text}`);
  const captured = await call("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: false,
    clip: { x: 0, y: 96, width: 1440, height: 714, scale: 0.2 },
  });
  const measured = await call("Runtime.evaluate", {
    expression: `window.__visualSearch.measure(${JSON.stringify(`data:image/png;base64,${captured.data}`)})`,
    awaitPromise: true, returnByValue: true, timeout: 30000,
  });
  if (measured.exceptionDetails) throw new Error(`measure ${loop}: ${measured.exceptionDetails.text}`);
  const row = { ...rendered.result.value, ...measured.result.value };
  loops.push(row);
  if (!best || row.score < best.score) best = row;
  if (loop % 10 === 0) console.error(`visual loop ${loop}/${rounds}: ${row.score.toFixed(4)}; best ${best.loop}=${best.score.toFixed(4)}`);
}

const applied = await call("Runtime.evaluate", {
  expression: `window.__visualSearch.apply(${JSON.stringify(best.params)})`,
  awaitPromise: true, returnByValue: true, timeout: 30000,
});
if (applied.exceptionDetails) throw new Error(applied.exceptionDetails.text);
const baseline = loops[0];
const result = {
  rounds, targetMetrics: setup.result.value.targetMetrics, baseline, best,
  improvement: (baseline.score - best.score) / baseline.score,
  loops, geometry: setup.result.value.geometry,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
const captured = await call("Page.captureScreenshot", { format: "png" });
mkdirSync(dirname(screenshot), { recursive: true });
writeFileSync(screenshot, Buffer.from(captured.data, "base64"));
console.log(JSON.stringify({
  rounds: result.rounds, baselineScore: result.baseline.score, bestScore: result.best.score,
  improvement: result.improvement, bestLoop: result.best.loop, bestParams: result.best.params,
  baselineMetrics: result.baseline.metrics, bestMetrics: result.best.metrics, targetMetrics: result.targetMetrics,
}));
ws.close();
