# MarkovJunior 子集移植与三维空间生成

日期：2026-08-07  
运行环境：Apple Silicon / Node v22.22.2 / Chrome WebGPU Metal

## 已移植

- 紧凑符号网格与 bit-wave 输入模式。
- 3D rewrite rule、通配输出、Z 轴旋转和镜像对称。
- Markov `one` 执行语义与局部增量匹配缓存。
- 带方向成本的确定性 3D A* 路径。
- 约束域塌缩，用于上下 block 共享楼梯庭院。
- block 内局部三维 grammar：平层生长、上升与下沉规则，避开跨层楼梯井。

没有移植原项目的 XML 解释器、GUI、VOX/PNG 资源读取与渲染器。原作者 MIT 许可保存在 `third_party/MarkovJunior-LICENSE`。

## 结构验证

- 100 个 seed × 20 block：全部为 20 个唯一三维节点，父节点严格先于子节点，全部连通，并达到 6 层。
- 100 个 block 内体积：每个至少 10 个 grammar 单元、至少 2 个高度层。
- 上下层楼梯庭院通过同一 link id 和同一中心相对坐标传播给两侧 block。
- Vitest 34/34、TypeScript `--noEmit`、Vite production build 全部通过。

## CPU：100 loop

每个 loop 连续生成并构建 12 个固定布局，warmup 12 loop。所有 loop 的 checksum、实例数和 render object 数稳定。

| 版本 | 生成 median | 生成 P95 | 构建 median | 构建 P95 | 合计 median |
|---|---:|---:|---:|---:|---:|
| 第一版 Markov 移植 | 34.40 ms | 43.71 ms | 50.88 ms | 65.63 ms | 84.77 ms |
| 数字索引缓存 | 19.94 ms | 23.65 ms | 41.61 ms | 47.55 ms | 62.33 ms |
| 稀疏符号初始化 | 13.68 ms | 16.17 ms | 39.34 ms | 44.45 ms | 52.87 ms |
| 三维结构 + 建筑透明 twin 最终版 | 14.49 ms | 17.45 ms | 42.15 ms | 48.90 ms | 56.59 ms |

最终版相对第一版移植：生成 median 降低 **57.9%**，构建 median 降低 **17.2%**，合计降低 **33.2%**。最终版包含额外 12 个预热透明 render object（每个稳定 slot 三个），正常视图的实例数量不翻倍。

原始逐 loop 数据：

- `results/markov-port-cpu.json`
- `results/markov-port-numeric-cache-cpu.json`
- `results/markov-port-sparse-cache-cpu.json`
- `results/markov-spatial-fade-final-cpu.json`

## GPU 与 LOD：100 loop

固定 1280×720、8 block，每个 GPU loop 连续提交 6 帧并等待 WebGPU queue：

| 指标 | 移植前最终版 | Markov + fade 最终版 | 变化 |
|---|---:|---:|---:|
| frame median | 19.85 ms | 16.68 ms | **16.0% 更快** |
| frame P95 | 22.59 ms | 17.02 ms | **24.7% 更快** |
| median FPS | 50.38 | 59.94 | **19.0% 更高** |

LOD 远→近压力测试 100 loop：切换 CPU median 为 0 ms，首帧 P95 20.02 ms、最大 23.60 ms；没有恢复到早期 200–400 ms 的首次管线尖峰。

原始数据：`results/gpu-markov-fade-final.json`、`results/lod-transition-100-markov-fade.json`。

## 遮挡行为

- 已删除人物的 GreaterDepth/xray duplicate。
- LOS 命中墙体、承重柱或楼梯核心时，切换对应建筑的透明 twin；人物材质不变。
- 浏览器实测：命中 1 个建筑 slot，xray mesh 为 0，透明人物 mesh 为 0。

截图：`markov-fade-final-8.png`、`architecture-occlusion.png`。
