# Rust/WASM 迷宫核心 A/B

Rust 只接管生长树、tier height、braid 和 extra-loop 热点。它输出 `Int8Array tiers` 与 `Uint8Array open`，其余地标、叙事、旋转、验证和 Layout 组装仍在 TypeScript worker 中。

这样做的理由：

- WASM 边界每个 block 只复制两块小数组。
- 正式 worker 不下载/编译 WASM；实验模块只由独立 benchmark 加载。
- 任一失败都能回退 TypeScript 后端。
- Rust 返回 RNG draw count，TS 的后续 RNG 状态保持完全一致。

## 100 轮结果

工作负载为每轮 24 个不同 seed/尺寸，包含真实 typed-array 边界复制：

| 指标 | TypeScript | Rust/WASM |
|---|---:|---:|
| median | 2.137 ms | 1.135 ms |
| P95 | 5.760 ms | 2.857 ms |
| 核心加速 | 1.00× | 1.88× |
| 语义 checksum mismatch | — | 0 / 24 |
| release WASM | — | 24,919 bytes |

核心变快不等于页面冷启动变快。清缓存后的同 seed、20-island 对照中，普通 TS 首批可见为 416.6ms；即使把 module 只编译一次并提前发给 worker，WASM A/B 仍约 1.31s。各布局内部记录的生成时间仍只有约 5–14ms，额外时间主要来自多个 worker 的 WASM 实例化与 WebGPU 首管线编译争抢冷启动 CPU。

因此当前结论是：撤掉 demo 的运行时 WASM 接线，只保留可复现的 crate、产物和 benchmark；普通路径已经确认没有 `.wasm` resource request。Rust 本身不会自动提高地图质量；它提供的约 1.9× 内核预算应在下一阶段用于 4–8 个候选并行生成或支撑图计算，再按路径直径、环路分布、瓶颈、垂直变化和叙事约束评分择优。等单 worker/共享内存生命周期方案通过完整 forge 回归后，再考虑接回正式生成池。

复现：

```sh
npm run build:wasm
npm run bench:wasm -- --rounds 100 --output artifacts/wasm-maze-100.json
```

当前页面始终使用稳定的 TypeScript worker pool；`npm run bench:wasm` 是唯一启用 Rust/WASM 的 A/B 入口。
