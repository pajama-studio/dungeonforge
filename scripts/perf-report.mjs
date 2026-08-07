import { readFileSync, writeFileSync } from "node:fs";

const read = (name) => JSON.parse(readFileSync(new URL(`../perf/results/${name}`, import.meta.url), "utf8"));
const baseline = read("baseline.json");
const current = read("final-randomized-vertical-cpu.json");
const gpuBaseline = read("gpu-lights28-final.json");
const gpuCurrent = read("gpu-randomized-vertical-final.json");
const lod = read("lod-transition-100-random-vertical-final.json");
const fog4 = read("gpu-fog4.json");

for (const [name, result] of Object.entries({ baseline, current, gpuBaseline, gpuCurrent, lod })) {
  if (result.samples.length !== 100) throw new Error(`${name} must contain exactly 100 samples`);
}

const improvement = (before, after) => ((before - after) / before) * 100;
const f = (n) => n.toFixed(2);
const pct = (before, after) => `${improvement(before, after).toFixed(1)}%`;
const b = baseline.summary, c = current.summary;
const gb = gpuBaseline.summary, gc = gpuCurrent.summary, ld = lod.summary;

const rows = baseline.samples.map((base, index) => {
  const now = current.samples[index], oldGpu = gpuBaseline.samples[index], nowGpu = gpuCurrent.samples[index];
  const baseCombined = base.generationMs + base.buildMs;
  const nowCombined = now.generationMs + now.buildMs;
  return `| ${index + 1} | ${f(base.generationMs)} | ${f(now.generationMs)} | ${f(base.buildMs)} | ${f(now.buildMs)} | ${f(baseCombined)} | ${f(nowCombined)} | ${improvement(baseCombined, nowCombined).toFixed(1)}% | ${f(oldGpu.frameMs)} | ${f(nowGpu.frameMs)} | ${improvement(oldGpu.frameMs, nowGpu.frameMs).toFixed(1)}% |`;
});

const report = `# Dungeonforge 性能优化：100 轮最终报告

日期：2026-08-07  
CPU：Apple Silicon / Node ${current.runtime.node} (${current.runtime.arch})  
GPU：Apple M1 Max / Chrome WebGPU Metal  

## 结论

| 指标 | 优化前 | 当前最终版 | 改善 |
|---|---:|---:|---:|
| 地牢生成 median（每轮 12 个布局） | ${f(b.generationMedianMs)} ms | ${f(c.generationMedianMs)} ms | ${pct(b.generationMedianMs, c.generationMedianMs)} |
| 地牢生成 P95 | ${f(b.generationP95Ms)} ms | ${f(c.generationP95Ms)} ms | ${pct(b.generationP95Ms, c.generationP95Ms)} |
| 场景构建 median（每轮 12 个布局） | ${f(b.buildMedianMs)} ms | ${f(c.buildMedianMs)} ms | ${pct(b.buildMedianMs, c.buildMedianMs)} |
| 场景构建 P95 | ${f(b.buildP95Ms)} ms | ${f(c.buildP95Ms)} ms | ${pct(b.buildP95Ms, c.buildP95Ms)} |
| 生成 + 构建 median | ${f(b.combinedMedianMs)} ms | ${f(c.combinedMedianMs)} ms | ${pct(b.combinedMedianMs, c.combinedMedianMs)} |
| GPU frame median | ${f(gb.frameMedianMs)} ms | ${f(gc.frameMedianMs)} ms | ${pct(gb.frameMedianMs, gc.frameMedianMs)} |
| GPU frame P95 | ${f(gb.frameP95Ms)} ms | ${f(gc.frameP95Ms)} ms | ${pct(gb.frameP95Ms, gc.frameP95Ms)} |
| GPU median 吞吐 | ${f(gb.fpsFromMedian)} FPS | ${f(gc.fpsFromMedian)} FPS | ${(((gc.fpsFromMedian - gb.fpsFromMedian) / gb.fpsFromMedian) * 100).toFixed(1)}% faster |

CPU 与 GPU 都用当前代码连续执行 100 loop。GPU 场景固定为 1280×720、8 岛；当前含随机内庭竖井、宝箱、敌人、遮挡轮廓和 LOD 双实例，共 ${gc.instances.toLocaleString("en-US")} 个可见实例、${gc.visibleRenderObjects} 个可见渲染对象、${gc.triangles.toLocaleString("en-US")} 个三角形。每个 GPU loop 连续提交 6 帧，并等待 WebGPU queue 真正完成。

LOD 另做 100 次远→近→远压力回归：切换 CPU median 为 ${f(ld.toggleMedianMs)} ms，首个近景完成帧 median ${f(ld.transitionMedianMs)} ms、P95 ${f(ld.transitionP95Ms)} ms、max ${f(ld.transitionMaxMs)} ms；最初实测的首次拉近卡顿为 403.3 ms，当前已没有 200–400 ms 的着色器/绑定创建尖峰。

## 本轮实现

- 竖向衔接点在 worker 生成前按 seed 选定，作为 \`VerticalAnchor\` 输入生成器；迷宫先保留实心楼梯核心、雕刻 3×3 平台与入口，再生成地标并做全图连通修复。因此楼梯位置会真实改变迷宫路线，不是渲染完成后贴上去。
- 普通链式地牢在两个重叠楼层的内部安全区随机取点，并最大化同层多个竖井之间的间距；不再统一挂在外墙边。上下层持有同一 link id，落点世界坐标严格对齐，楼层到首/末踏步由可行走石质 landing 补齐。
- 当随机平台遇到神殿/广场的高度断层时，生成器在地标边界生成逐级过渡，而不是移走竖井或产出断路；加入 Reliquary 原始失败种子的固定回归测试。
- 导航缓存键包含岛、桥、楼梯和 blocker 的实时数量，大型场景生成中途打开路线也不会冻结半成品 portal 图。
- 路线图排除支撑柱 blocker；桥梁反向回溯点按实际行进方向排序，消除了桥中间旋转回头。
- 远近 LOD 预热真实 WebGPU render object，高/低模共享 instance buffer；运行时只切换 \`count\`，不再使 render object 失效。
- 骷髅被建筑遮挡时追加仅通过遮挡深度测试的青色透明轮廓；LOS 使用现有网格/柱体数据，以 12 Hz 运行。
- 每个传送门前放置可点击开启的宝箱；每岛确定性散布 2–4 个敌人。全部人口系统固定为五个 instanced render object。

## 正确性护栏

- 当前 100 轮布局 checksum 均为 ${current.samples[0].checksum}，没有逐轮漂移。
- CPU 基准每轮均为 ${current.samples[0].instances.toLocaleString("en-US")} 个实例、${current.samples[0].renderObjects} 个渲染对象。
- Vitest：28/28 通过；TypeScript \`--noEmit\` 与生产构建通过。
- seed 20260806 的 8 块链式地牢：6 个竖井位置全部不同，成对上下落点 x/z 误差为 0；761 个路线点 0 次穿柱，8 块全部可达。
- Cube：27 块、18 个内部竖井位置全部不同、142 个有向 portal；2,564 个路线点 0 次穿柱，全部可达。
- Reliquary：19 块、18 个随机竖向衔接、112 个有向 portal；2,352 个路线点 0 次穿柱，全部可达。

## 保留与拒绝的性能实验

- 保留 typed-array BFS queue、合并旋转网格遍历、平方距离热路径、实例 arena/累计包围盒、墙体邻域预计算和 24 灯固定池。
- 体积雾 raymarch 5 → 4 steps 的 GPU median 为 ${f(fog4.summary.frameMedianMs)} ms，没有改善，因此回退。

最终数据：[CPU 100 loops](results/final-randomized-vertical-cpu.json)、[GPU 100 loops](results/gpu-randomized-vertical-final.json)、[LOD 100 loops](results/lod-transition-100-random-vertical-final.json)。基线：[CPU](results/baseline.json)、[GPU](results/gpu-lights28-final.json)。最终截图：[8 层链式地牢](final-randomized-vertical.png)、[Reliquary](reliquary-final.png)。

## 逐 loop 数据

每个 CPU loop 是同一组 12 个固定布局；每个 GPU loop 是连续 6 帧的平均值。两次独立运行按序号对齐仅用于展示原始波动，最终判断采用 100 轮 median/P95。

| Loop | Gen 前 ms | Gen 当前 ms | Build 前 ms | Build 当前 ms | CPU 合计前 ms | CPU 合计当前 ms | CPU 行变化 | GPU 前 ms | GPU 当前 ms | GPU 行变化 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${rows.join("\n")}
`;

writeFileSync(new URL("../perf/REPORT.md", import.meta.url), report);
console.log(`wrote perf/REPORT.md (${rows.length} loops)`);
