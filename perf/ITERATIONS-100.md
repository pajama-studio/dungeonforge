# Dungeonforge：第二阶段 100-loop 数据账本

日期：2026-08-07  
分支：`feature/gpu-destruction`  
固定 GPU 工作负载：早期基线使用 seed `359139884`；从 Loop 063 起的收敛 A/B 使用 seed
`2820997495`、20 blocks、1280×720、DPR=1、每个 loop 6 帧并等待 WebGPU queue 完成。
固定 CPU 工作负载：12 个确定性 layout、每轮生成并构建全部场景。

## 判定规则

- 每个 loop 必须写清假设、单变量改动、同条件数据与保留/回退结论。
- 稳态性能以 100 样本 median/P95 判断；短实验只用于筛选，不能作为最终胜出证据。
- 画质、玩法或正确性发生变化时，实例数/三角形/测试不变量必须一并记录，不能把删内容伪装成优化。
- 噪声区间内的结果记为持平；回退实验保留数据但不保留代码。
- 最终版本必须重新跑 CPU、GPU、LOD、破坏、导航与 roguelike 回归。

## 基线

| Loop | 变更/实验 | CPU gen median | CPU build median | GPU median | GPU P95 | Instances | Render objects | Triangles | 结论 |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| 000 | 当前 GPU destruction 版本；高细节全开 | 24.88 ms | 82.97 ms | 37.17 ms | 39.28 ms | 90,565 | 834 | 8,088,744 | 冻结基线 |

原始数据：[`artifacts/iterations/loop-000-cpu.json`](../artifacts/iterations/loop-000-cpu.json)、
[`artifacts/iterations/loop-000-gpu.json`](../artifacts/iterations/loop-000-gpu.json)。

## 逐 loop 实验

> 只在实验完成后追加一行，不预填结果。

| Loop | 假设/单变量实验 | GPU median | GPU P95 | Instances | Triangles | 相对 Loop 000 | 结论 |
|---:|---|---:|---:|---:|---:|---:|---|
| 001 | 强制全场低 LOD，诊断高模 masonry 与 detail 的上限成本 | 25.82 ms | 29.89 ms | 72,144 | 1,164,454 | median -30.6%；triangles -85.6% | 诊断成立；不以全局降画质方式合入，Loop 002 定向减 masonry 高模 |
| 002 | masonry 高模从 108-triangle rounded box 换成 68-triangle 单段 chamfer box | 34.02 ms | 38.88 ms | 90,565 | 5,760,144 | median -8.5%；P95 -1.0%；triangles -28.8% | 保留；远景截图轮廓与磨损层次通过检查 |
| 003 | 石材 grain 复用已有 2.2× 四层噪声，删除近重复的 1.8× 四层采样 | 33.19 ms | 34.86 ms | 90,565 | 5,760,144 | 较 002 median -2.4%、P95 -10.3% | 保留；首跑冷态分布另存，60 帧 warm-up 复测通过 |
| 004 | 雨痕四层噪声改成双正弦连续场 | 33.54 ms | 61.14 ms | 90,565 | 5,760,144 | 较 003 median +1.1%、P95 +75.4% | 回退；没有可证明收益且尖峰恶化 |
| 005 | benchmark 增加真实 submitted mesh 与逐 geometry 三角形归因 | 33.46 ms* | 37.23 ms* | 90,565 | 5,760,144 | 20-sample 诊断；top 3 geometry 占 89.9% triangles | 保留观测能力；`submitted=729`，下一步按贡献排序优化 |
| 006 | tile/merlon 108-triangle rounded box 换成 68-triangle chamfer box | 33.17 ms | 53.71 ms | 90,565 | 5,308,664 | 较 003 median -0.1%；triangles -7.8% | 保留同画质减面；P95 含一段系统尖峰，不宣称改善 |
| 007 | 当前 768-slot debris compute/render 活动态基线（40 samples） | 31.09 ms* | 33.41 ms* | 91,333 | 5,317,880 | compute 300 frames；debris 9,216 triangles | 冻结破坏活动上限 |
| 008 | debris 断裂形体/尺寸分层/落地停转，容量、draw、triangles 不变 | 31.58 ms* | 34.08 ms* | 91,333 | 5,317,880 | 较 007 median +1.6%；同预算视觉升级 | 保留；12 hits/128 fragments/2 breaches，0 GPU error |
| 009 | roguelike 最小闭环：移动、战斗、遗物、下层、死亡 | — | — | — | — | 浏览器 E2E 五阶段全部通过 | 保留；纯规则 3 tests + WebGPU 集成回归 |
| 010 | 每层 encounter budget，跨 block 均匀激活 16 + 4×depth 敌人 | — | — | 73→16 active（Depth 1） | — | AI/draw 敌人数 -78.1% | 保留；Depth 2 实测 20，完整回归通过 |
| 011 | 游戏态配对基准（近景，100 loops） | 1.90 ms total* | 13.52 ms* | 16 enemies | — | idle render 1.50 ms；game CPU 0.10 ms；净增 median 0.40 ms | 建立玩法帧预算；Loop 012 攻击无效实例上传 |
| 012 | 敌人 idle bob 迁到共享 GPU NodeMaterial，仅移动/受击/死亡时上传矩阵 | 2.05 ms total* | 11.96 ms* | 16 enemies | — | 同跑 idle 2.05 ms；game CPU 0.10 ms；净增 median ≈0.00 ms | 保留；绝对值受本轮系统负载抬升，可信结论限于同跑配对差值 |
| 013 | 远景 masonry 使用同 instance tint/face shading 的最小 Lambert，删除亚像素 mortar/noise/crack/normal 计算 | 23.10 ms | 25.10 ms | 80,555 | 1,132,624 | 同版本低 LOD 基线 24.70/26.56 ms；median -6.5%、P95 -5.5% | 保留；实例/几何不变，前后截图通过；异常首跑另存 |
| 014 | 量化整块 interior-course cull 的真实覆盖率 | — | — | 61,736 potential | — | 仅 19 courses 被整块剔除（0.03%） | 诊断成立；不能靠四邻域整块 cull，Loop 015 改剔除上下互遮面 |
| 015 | 41,687 个中间 course 改用无上下 cap/横向 bevel 的开放 prism，首尾/可破坏 passage 保持完整 | 32.58 ms | 34.26 ms | 100,343 | 3,684,208 | 同场景 full-course A/B 33.39/34.82 ms、5,851,932 tri；median -2.4%、tri -37.0% | 保留；连续墙面减 block 感；12-impact 破坏/导航/WebGPU 回归通过 |
| 016 | 高/低 LOD 都拆分 middle-course draw | 25.78 ms | 28.16 ms | 80,555 | 965,876 | 较 013 少 14.7% tri，但 submitted objects 449→469、median +11.6% | 回退低 LOD 拆分；远景 draw overhead 大于省下的面 |
| 017 | 低 LOD 重新把 cap+middle 批量合并为单实例池，保存 high→low 破坏映射 | 24.80 ms* | 38.96 ms* | 80,555 | 1,132,624 | submitted objects 469→449；恢复单 draw/slot | 保留结构；P95 有系统尖峰，Loop 018 继续处理零 count twins |
| 018 | inactive LOD/fade twins 同时设 visible=false，不让 count=0 对象进入 renderer bookkeeping | 21.32 ms | 22.82 ms | 80,555 | 1,132,624 | visible objects 892→749；较 017 median -14.0%；较 013 -7.7% | 保留；第二次 100-loop 确认无尖峰 |
| 019 | 高细节态验证 inactive low/fade twins 同样不提交 | 27.86 ms | 30.23 ms | 100,343 | 3,684,208 | visible objects 932→769；较 015 median -14.5%、P95 -11.7% | 保留；高/低 LOD 均受益 |
| 020 | 专项 100× 单岛 far→near→far 配对基线 | 20.25 ms promote | 57.82 ms promote P95 | 20 islands | — | 首轮逐岛 promotion 多为 50–66 ms；max 65.90 ms | 诊断成立：实际带灯 render object 未被精确预热 |
| 021 | 预热 layer 同步启用全部真实 lights，匹配运行态 pipeline key | 18.00 ms promote | 23.22 ms promote P95 | 20 islands | — | 较 020 median -11.1%、P95 -59.8%；max 53.40 ms | 保留；逐岛冷峰清除，仅余首个全局峰值 |
| 022 | `decorReady` 前冻结 LOD scheduler，消除 animation loop 与异步 stage/restore 竞争 | 17.70 ms promote | 23.41 ms promote P95 | 20 islands | — | max 53.40→29.00 ms（-45.7%）；demote P95 22.61→21.30 ms | 保留；首次靠近不再出现 >30 ms 编译峰 |
| 023 | masonry/LOD 改造后的 roguelike 浏览器全链路回归 | — | — | 16→20 active enemies | — | moved 3.14；relic/kill/Depth2/death 全通过；0 GPU error | 通过；玩法与高低 LOD/实例映射无回归 |
| 024 | Space 接入 GLB authored 横斩 clip，并回归可测试 attack count | — | — | — | — | E2E 实播 2 次 attack；relic/kill/Depth2/death 继续通过 | 保留；攻击从纯数值判定变成可见动作 |
| 025 | 当前 fixed 768-slot debris compute/render 活动态重基线（40 samples） | 26.34 ms* | 28.63 ms* | 91,103 | 3,388,908 | 768 debris slots / 9,216 tri / 单 draw | 冻结新场景破坏预算 |
| 026 | 落地前判断 sleep、独立有符号三轴翻滚、按尺寸分级寿命与退场缩放 | 26.28 ms* | 27.85 ms* | 91,103 | 3,388,908 | 较 025 median -0.3%、P95 -2.7%；容量/面数不变 | 保留；首跑受系统尖峰污染，第二次确认 |
| 027 | 24 次真实 raycast/compute 视觉与容量验证 | — | — | 192 spawned / 768 cap | 9,216 debris tri | ray median 2.30 ms、P95 3.40 ms；0 GPU/buffer error | 视觉诊断：核心碎块仍偏大偏黄；本镜头未命中 breach |
| 028 | 每击 1 核块+4 中片+5 细屑，缩小尺度并改为墙体中性石色 | — | — | 240 spawned / 768 cap | 9,216 debris tri | 同 24 impacts 碎片层次 +25%；ray median 2.20 ms；固定 GPU draw/tri 不变 | 保留；截图细化明显，0 GPU/buffer error |
| 029 | 每第 3 层加入 1 个 1.5× Warden（2.75× HP、1.6× damage） | — | — | Depth 3: 24 enemies / 1 elite | — | E2E 到 Depth 3；攻击/relic/kill/death 全通过；0 GPU error | 保留；相同敌人预算内增加楼层节奏 |
| 030 | 当前 CPU 100-loop 重基线（每 loop 12 layouts） | gen 20.23 ms | build 66.01 ms | 40,482 | — | combined 85.59 ms；checksum 331311743 | 冻结 masonry split/roguelike 后 CPU 基线 |
| 031 | low masonry 中间数组改 direct segmented upload 首跑 | gen 23.46 ms* | build 69.65 ms* | 40,482 | — | build P95 149.28→106.59 ms，但整机负载抬高 median | 不单独下结论；暂停本项目动画后做 Loop 032 A/B |
| 032 | 暂停 demo 后 legacy-copy→direct-upload 受控 100+100 A/B | gen 16.07 ms | build 50.43 ms | 40,482 | — | legacy build 62.08→50.43 ms（-18.8%）；combined 82.76→66.53（-19.6%） | 保留 direct；checksum/instances/objects 完全一致 |
| 033 | 反向切回 legacy-copy 再跑 100，排除时间趋势 | gen 17.46 ms | build 52.95 ms | 40,482 | — | 对比 032 direct：build +5.0%、combined +6.6%、build P95 +23.0% | 再次证明 direct 胜出；最终恢复 direct 版本 |
| 034 | 远景 Lambert→白色 unlit，测试移除固定灯池 fragment cost | 19.54 ms | 22.21 ms | 72,989 | 1,058,766 | 同场景 Lambert 20.45/22.16 ms；median -4.4% | 回退白色版本：截图严重过曝，不能以破坏夜景换性能 |
| 035 | unlit 加冷灰能量系数 `0x697686` | 19.82 ms* | 24.12 ms* | 72,989 | 1,058,766 | 12-sample 视觉筛选；仍明显偏亮且平 | 不通过视觉门槛 |
| 036 | unlit 降至夜景系数 `0x303846` | 20.05 ms* | 20.55 ms* | 72,989 | 1,058,766 | 8-sample；亮度接近但失去月光/火光层次 | 不通过视觉门槛 |
| 037 | unlit 改环境+单月光 dot+顶面天光 | 19.82 ms* | — | 72,989 | 1,058,766 | 10-sample；方向性恢复但每块顶面形成密集亮点 | 回退整个 unlit 分支；它强化 block 感 |
| 038 | 远景把连续 masonry courses 合并成单根墙柱，门洞/塔檐仍切段 | 22.17 ms* | 33.06 ms* | 23,254 | 461,946 | instances -68.1%；triangles -56.4%；low masonry instances -87.7% | 结构与减弱 block 感通过；本轮 DPR 受 adaptive controller 影响，仅用作复杂度证据 |
| 039 | 删除合并墙柱上的 analytic seam fragment，恢复最小 Lambert | 23.69 ms* | 30.25 ms* | 23,254 | 461,946 | 几何不变；截图去除密集横缝，视觉更像整体墙体 | 保留视觉改动；GPU 仍受未锁 DPR 干扰，不做性能结论 |
| 040 | benchmark 强制 DPR=1；逐 course→合并墙柱受控 100+100 GPU A/B | 22.18 ms | 24.94 ms | 23,254 | 461,946 | legacy 22.43/25.23 ms、72,989 instances、1,058,766 tri；median -1.1%、P95 -1.2% | 保留合并墙柱；同时修正后续 GPU 测量方法 |
| 041 | 合并墙柱当前 CPU 100-loop：量化实例上传与额外 span 构建成本 | gen 17.92 ms | build 60.10 ms | 19,166/batch | — | combined 78.60 ms；较旧 direct 基线实例 -52.7% | 建立当前 CPU 样本；因系统负载差异，Loop 042 做紧邻反向 A/B |
| 042 | 同代码仅把 low upload 反切回逐 course，100-loop CPU A/B | gen 16.27 ms | build 64.33 ms | 40,482/batch | — | 合并版 build -6.6%、combined -2.4%；合并版 P95 96.76 vs 195.83 ms | 回退逐 course 对照；合并墙柱 CPU/GPU 双端均通过 |
| 043 | DPR=1、固定 768-slot debris compute/render 的 100-loop 新基线 | 20.45 ms | 23.74 ms | 24,022 | 471,162 | debris 768 instances / 9,216 tri / 1 draw | 冻结精细化前成本；包含强制 compute 活跃 |
| 044 | debris 每顶点同步三轴法线旋转，加入动态月光/天光切面 | 21.41 ms | 24.90 ms | 24,022 | 471,162 | 首跑较 043 median +4.7%，视觉信息增加但算术偏多 | 回退动态法线光，保留实验数据 |
| 045 | 只保留局部新鲜断面双色；无新增 geometry、draw 或 state buffer | 21.37 ms | 25.26 ms | 24,022 | 471,162 | 相同固定预算；相对后置原版 046 median -1.4%、P95 -1.7% | 保留；成本落在系统噪声内，断面可读性提升 |
| 046 | 完全恢复原 debris shader 的反向 100-loop 对照 | 21.67 ms | 25.70 ms | 24,022 | 471,162 | 证明 043 是较轻系统时段；双色版本无可测回归 | 恢复 045 双色最终版，动态切面光继续回退 |
| 047 | 真实 24-impact 破坏、缺口导航、容量与 WebGPU 回归 | — | — | 260 spawned / 768 cap | 9,216 debris tri | raycast 1.90 ms median / 4.80 ms P95；1 breach；0 unreachable/GPU error | 通过；双色断面、尺寸分层与导航缺口共同保留 |
| 048 | 清层加入 deterministic 三选一誓约，选择前锁住出口 | — | — | Depth 1/2/3: 16/20/24 enemies | — | 45/45 unit；E2E 2 rewards、Depth 3 Warden、death；0 GPU error | 保留；从纯清怪推进到每层可构筑的 roguelike 决策 |
| 049 | 三选一状态机/UI 后的 100-loop 配对玩法基准 | 1.40 ms total* | 17.00 ms* | 16 enemies | — | idle/render median 1.30 ms；game CPU 0.10 ms median / 0.20 ms P95 | 保留；奖励 UI 在战斗关闭态，正常帧成本未增加 |
| 050 | low scene 增加 object-name 归因，定位仍在用 high blockGeo 的来源 | 22.43 ms* | — | 22,595 | 443,836 | 2,256 high instances / 153,408 tri：support `blocks` + `linkStones` | 诊断成立；桥/承重柱占低景约 34.6% triangles |
| 051 | pooled mesh 写稳定 key 名称，验证 support 1,826 + links 430 | 25.58 ms* | — | 41,169* | 1,182,484* | reload 竞态使新页面在 setAllDetail 后重新打开 detail | 保留观测命名；本轮性能数据作废并驱动 Loop 052 |
| 052 | browser benchmark 等待真实 `Page.loadEventFired` 再取 dev hook | 20.94 ms* | 25.86 ms* | 22,595 | 443,836 | 10-sample；恢复预期 437 submitted / low counts | 保留测量修复；消除旧 execution context 竞态 |
| 053 | 桥体/承重柱加入共享-buffer high/low twin | 23.37 ms | 33.88 ms | 22,595 | 317,500 | triangles -28.5%；submitted 437 不变 | 几何目标成立但首个 low pipeline 时段偏慢，继续反向 A/B |
| 054 | twin 结构不变，仅反切 68-tri high geometry/material | 22.25 ms | 26.64 ms | 22,595 | 443,836 | 对照比 053 快，可能是新 pipeline/系统时段效应 | 不下结论，恢复 low 做反向确认 |
| 055 | low twin 反向跑首次尝试 | — | — | — | — | exact pipeline warm-up 超过旧 30 s guard；无样本落盘 | 正确中止；守卫放宽 60 s，不把冷编译混入稳态 |
| 056 | low twin 反向 100-loop 确认 | 21.72 ms | 24.08 ms | 22,595 | 317,500 | 较 054 median -2.4%、P95 -9.6%；triangles -28.5% | 保留 link/support LOD；双向 A/B 通过 |
| 057 | 远景隐藏 71 个 sub-pixel flame objects，保留灯池/建筑发光 | 21.51 ms | 26.77 ms | 22,073 | 315,412 | submitted 437→366（-16.2%）；median -1.0%；截图火光氛围仍可读 | 保留；P95 有系统尖峰，后续最终基准复核 |
| 058 | Warden 真实击杀赏金：独立 shard 奖励与 run 统计 | — | — | Depth 3: 24 / 1 elite | — | 46 unit；E2E Warden bounty 15、4 attacks、0 GPU error | 保留；精英从数值放大变为有构筑资源回报 |
| 059 | Shift dash 初版 + E2E | — | — | — | — | 46 tests/build 通过；E2E 因 reload 竞态得到 dashes=0、chest 未结算 | 实现暂不判定；修脚本与 key 归一化后 Loop 060 重跑 |
| 060 | load-event-safe roguelike E2E + normalized Shift | — | — | — | — | moved 1.53；dashes 1；2 oaths；Warden bounty 15；Depth 3/death；0 GPU error | 保留 2.35×/0.22 s dash、0.25 s i-frame、1.05 s cooldown |
| 061 | dash/Warden 后 100-loop gameplay 配对 | 1.00 ms total* | 14.02 ms* | 16 enemies | — | game CPU median 0.10 ms / P95 0.105 ms；idle/render median 1.00 ms | 保留；新增状态无稳态成本 |
| 062 | low floors 按同 tier/叙事表面做横向 greedy spans | 21.90 ms | 28.08 ms | 20,958 | 303,976 | tiles 7,527→5,794；但页面 seed 已被 E2E 改写 | 视觉通过、性能不可横比；Loop 063 固定 seed 后重测 |
| 063 | browser benchmark 支持 `--seed` 强制导航并记录实际 URL | 19.73 ms* | 22.18 ms* | 19,909 | 289,444 | fixed seed 2820997495；20-sample 方法验证 | 保留测量修复；后续 GPU A/B 固定页面内容 |
| 064 | greedy low floors 固定 seed 100-loop | 19.90 ms | 22.96 ms | 19,909 | 289,444 | tiles 5,363；总 instances 较 cell 版 -9.8% | 待反向 A/B |
| 065 | low floors 反切 one-cell-one-box | 19.74 ms | 22.78 ms | 22,073 | 315,412 | 比 064 median -0.8%；draw 数相同 | GPU 不支持胜出；恢复 greedy 再确认 |
| 066 | greedy floors 反向确认 | 20.09 ms | 24.74 ms | 19,909 | 289,444 | 两次 greedy 均比 cell 慢 0.8–1.8%，但实例/tri 明显更少 | GPU 轻微代价；Loop 067–068 测构建端后决策 |
| 067 | greedy floor CPU 100-loop | gen 13.62 ms | build 50.21 ms | 18,004/batch | — | combined 64.06 ms | 与紧邻 cell A/B 对比 |
| 068 | cell floor CPU 100-loop | gen 14.29 ms | build 54.31 ms | 19,166/batch | — | greedy build -7.6%、combined -7.5%；batch instances -6.1% | 保留 greedy；加载/上传与连续地面收益高于约 1% GPU 差异 |
| 069 | high-detail floor 68-triangle chamfer box 基线 | 37.07 ms | 54.97 ms | 89,778 | 3,306,064 | tiles 7,648 / 520,064 tri | 冻结 open-slab 前基线 |
| 070 | high floor 改无隐藏底面的 22-triangle chamfer slab | 36.21 ms | 71.08 ms | 89,778 | 2,954,256 | total tri -10.6%；median -2.3%；截图无缺面 | 保留；P95 含整机尖峰，不归功于改动 |
| 071 | wall-top merlons 同样改 22-triangle open slab | 36.57 ms | 67.94 ms | 89,778 | 2,793,164 | merlon tri 238,136→77,044；total -5.5%；median +1.0% noise | 保留同画质确定性减面 |
| 072 | ordinary wall bottom→16-tri open side，top→22-tri open-cap | 34.57 ms | 89.46 ms | 89,778 | 2,308,254 | full blocks 19,515→9,547；total tri -17.4%；median -5.5% | 保留；新增 stable top draw 后仍净胜 |
| 073 | 新 top mesh 的 24-impact destruction/navigation 回归 | — | — | 260 spawned / 768 cap | 9,216 debris tri | 1 breach；0 unreachable/undersized/GPU error；ray median 1.90 ms | 通过；top/mid/full 三池共享破坏路径安全 |
| 074 | open-cap 后 100× LOD transition | 15.40 ms promote | 21.23 ms P95 | 20 islands | — | promote max 27.10；demote 15.60/P95 20.22/max 26.60 | 通过；优于 Loop 022 的 23.41 P95 / 29.00 max |
| 075 | passage break courses 68→16 tri，复用现有 open pool | 37.32 ms | 101.42 ms | 89,778 | 1,947,114 | tri -15.6%；首个时段 median 反向 +8.0% | 不单跑判定，做双向 A/B |
| 076 | passage courses 反切 full mesh | 36.56 ms | 53.71 ms | 89,778 | 2,308,254 | 比 075 median -2.0%；P95 系统分布差异大 | 恢复 open 再确认 |
| 077 | open passage 反向 100-loop | 36.11 ms | 72.32 ms | 89,778 | 1,947,114 | 较 076 median -1.2%；tri -15.6%；与 075 合看首跑受负载污染 | 保留 open break courses；不宣称 P95 改善 |
| 078 | open passage 24-impact 破坏/导航最终回归 | — | — | 260 spawned / 768 cap | 9,216 debris tri | 1 breach；0 unreachable/undersized/GPU error；ray median 1.80 ms | 通过；整组坍塌与真实可行进缺口保持正确 |
| 079 | 当前最终几何下 fixed 768-slot debris 活动态基线 | 18.93 ms | 21.75 ms | 20,677 | 293,094 | debris 768 / 9,216 tri / 1 draw | 冻结 GPU dust 前基线 |
| 080 | 从 chip state 派生 768 GPU billboard dust，零新增 compute state | 21.87 ms | 26.17 ms | 21,445 | 294,630 | +1 transparent draw / +1,536 tri；对 079 首跑 median +15.5% | 暂不保留；先排除死亡槽透明 overdraw |
| 081 | inactive dust quad 顶点停放 `PARK_Y` | 21.86 ms | 53.11 ms | 21,445 | 294,630 | median 几乎不变；P95 遇系统尖峰 | 停放不能证明额外透明 pipeline 值得保留 |
| 082 | 完整回退 dust draw 的反向 100-loop | 21.98 ms | 25.24 ms | 20,677 | 293,094 | 同时段 dust median 属噪声，但仍多透明 pipeline 且 P95 略差 | 回退 dust；保留零 draw 断面双色/非对称碎片/1+4+5 分级 |
| 083 | 冻结代码后的最终 CPU 100-loop | gen 12.93 ms | build 47.07 ms | 18,004/batch | — | combined 59.81 ms；较 Loop 030 gen -36.1%、build -28.7%、combined -30.1% | 通过 CPU 收敛门槛 |
| 084 | 最终 low LOD，DPR=1、100-loop | 20.59 ms | 23.37 ms | 19,909 | 283,878 | 366 submitted；48.56 FPS median | 通过；截图归档 |
| 085 | 最终 high LOD，DPR=1、100-loop | 35.50 ms | 39.90 ms | 89,778 | 1,947,114 | 较同 seed Loop 069 median -4.2%、P95 -27.4%、tri -41.1% | 通过 high-detail 收敛门槛 |
| 086 | 最终 LOD transition 首跑 | 17.95 ms promote | 26.95 ms P95 | 20 islands | — | max 30.30 ms；demote 17.45/P95 24.18/max 27.60 | 接近门槛；Loop 098 在其余验证后反向确认 |
| 087 | 最终 24-impact destruction/navigation | — | — | 280 spawned / 768 cap | 9,216 debris tri | 2 breaches；0 unreachable/undersized/GPU error；ray 1.90/5.40 ms | 通过 |
| 088 | 最终 roguelike 浏览器 E2E | — | — | 16→20→24 / 1 Warden | — | moved 5.21；dash 1；2 oaths；bounty 15；Depth 3/death；0 GPU error | 通过玩法收敛门槛 |
| 089 | 最终 gameplay 100-loop | 1.40 ms total* | 17.53 ms* | 16 enemies | — | CPU 0.10/0.20 ms；idle 1.60、game render 1.30 ms | 通过玩法帧预算 |
| 090 | 连续 12 seed re-forge / WebGPU buffer / route 压力回归 | — | — | 12 worlds | — | 12/12；0 GPU error、undersized、unreachable、ungrounded、blocked | 应用通过；外层 shell 误用 zsh 保留变量不影响完整 artifact |
| 091 | architecture occlusion 脚本首试 | — | — | — | — | 旧默认 CDP 9338；本 demo 为 9337，连接被拒绝 | 无应用结论；使用正确端口重跑 |
| 092 | architecture occlusion 正确端口首试 | — | — | — | — | reload 时旧 execution context 被导航关闭 | 无应用结论；补 load-event barrier |
| 093 | load-safe architecture occlusion 回归 | — | — | 1 occluding slot / 40 fades | — | transparentPlayerMeshes 0；建筑 fade 生效 | 通过：透明的是挡人的建筑，不是角色 |
| 094 | cross-block court route 回归首跑 | — | — | 3 courts | — | 1,884 route points；0 unreachable/ungrounded/blocked；stone count 在 LOD 后误读 0 | 路线通过；修观测时机 |
| 095 | court stone count 在 LOD 切换前冻结 | — | — | 58 stone instances | — | 3 courts；1,884 points；0 unreachable/ungrounded/blocked | 通过跨 block court 与路线门槛 |
| 096 | strict TypeScript + unit/build 总门禁首跑 | — | — | — | — | `tsc` 捕获 debris TSL vec3 重赋值的类型推断错误；runtime/build 此前正常 | 中止后续门禁；局部 TSL expression 标 opaque 后重跑 |
| 097 | `tsc --noEmit` + 47 unit + production build + diff-check | — | — | — | — | 四项 exit 0；bundle 1,141.55 kB / gzip 328.59 kB | 通过代码质量门槛 |
| 098 | LOD transition 反向最终确认 | 2.70 ms promote | 15.02 ms P95 | 20 islands | — | max 19.70；demote 2.60/P95 15.05/max 17.90 | 通过；证明 Loop 086 是整机负载时段，不是冷 pipeline 回归 |
| 099 | load-event-safe 连续 20-seed re-forge 最终压力回归 | — | — | 20 worlds | — | 累计 37,923 route points；0 GPU error、buffer undersized、unreachable、ungrounded、blocked | 通过随机地图稳定性门槛 |
| 100 | 最终本地可玩态验收与画面归档 | — | — | 62,803 | — | 20 islands / 41 worlds / 1,735 route points；16 enemies；768 debris capacity；0 unreachable、undersized、GPU error、exception | 通过；demo 保持在 Roguelike Depth 1 可继续游玩 |

## 100-loop 收敛结果

- CPU：相对 Loop 030，生成 median `20.23 → 12.93 ms`（-36.1%），构建 median
  `66.01 → 47.07 ms`（-28.7%），合计 `85.59 → 59.81 ms`（-30.1%）。
- GPU/high：同 seed 的三角形 `3,306,064 → 1,947,114`（-41.1%），median
  `37.07 → 35.50 ms`（-4.2%），P95 `54.97 → 39.90 ms`（-27.4%）。
- GPU/low：最终 `19,909` instances、`283,878` triangles、`366` submitted objects，
  DPR=1 median `20.59 ms` / P95 `23.37 ms`。
- LOD：最终靠近切换 median `2.70 ms` / P95 `15.02 ms` / max `19.70 ms`；
  远离切换 median `2.60 ms` / P95 `15.05 ms` / max `17.90 ms`。
- 破坏：固定 `768` GPU debris slots、单 draw、`9,216` triangles；每击生成
  `1` 核块 + `4` 中片 + `5` 细屑，具有非对称断面、分级寿命、落地停转和真实导航缺口。
- Roguelike：移动、冲刺无敌帧、攻击、敌群、Warden、宝箱遗物、三选一誓约、清层锁门、
  下层与死亡重开均已贯通；最终玩法 CPU median `0.10 ms`。
- 稳定性：47 项单测、strict TypeScript、production build、diff-check 全通过；最终 20-seed
  压力回归累计 37,923 路线点，所有导航与 WebGPU 检查为 0 失败。

原始数据：[`loop-001`](../artifacts/iterations/loop-001-gpu.json)、
[`loop-002`](../artifacts/iterations/loop-002-gpu.json)。
Loop 003：[`冷态首跑`](../artifacts/iterations/loop-003-gpu.json)、
[`稳态确认`](../artifacts/iterations/loop-003b-gpu.json)。
Loop 004 失败数据：[`artifacts/iterations/loop-004-gpu.json`](../artifacts/iterations/loop-004-gpu.json)。
Loop 005（20 样本诊断）：[`artifacts/iterations/loop-005-gpu.json`](../artifacts/iterations/loop-005-gpu.json)。
Loop 006：[`artifacts/iterations/loop-006-gpu.json`](../artifacts/iterations/loop-006-gpu.json)。
Debris：[`loop-007 baseline`](../artifacts/iterations/loop-007-gpu.json)、
[`loop-008 refined`](../artifacts/iterations/loop-008-gpu.json)。
Roguelike：[`Loop 009 E2E screenshot`](../artifacts/iterations/loop-009-roguelike.png)、
[`Loop 010 budget screenshot`](../artifacts/iterations/loop-010-roguelike-budget.png)、
[`Loop 011 paired benchmark`](../artifacts/iterations/loop-011-gameplay.json)、
[`Loop 012 GPU enemy animation`](../artifacts/iterations/loop-012-gameplay.json)。
LOD material：[`Loop 013 before`](../artifacts/iterations/loop-013a-gpu.json)、
[`after/spiky run`](../artifacts/iterations/loop-013b-gpu.json)、
[`confirmation`](../artifacts/iterations/loop-013c-gpu.json)。
Masonry：[`Loop 014 cull diagnostic`](../artifacts/iterations/loop-014-cull-diagnostic.json)、
[`Loop 015 full-course A/B`](../artifacts/iterations/loop-015a-full-course.json)、
[`open-course result`](../artifacts/iterations/loop-015-gpu.json)、
[`destruction regression`](../artifacts/iterations/loop-015-destruction.json)。
LOD batching：[`Loop 016 failed split`](../artifacts/iterations/loop-016-gpu.json)、
[`Loop 017 recombined`](../artifacts/iterations/loop-017-gpu.json)、
[`Loop 018 first run`](../artifacts/iterations/loop-018-gpu.json)、
[`Loop 018 confirmation`](../artifacts/iterations/loop-018b-gpu.json)。
High detail：[`Loop 019`](../artifacts/iterations/loop-019-gpu.json)。
LOD transition：[`Loop 020 baseline`](../artifacts/iterations/loop-020-lod-transition.json)、
[`Loop 021 exact-light warmup`](../artifacts/iterations/loop-021-lod-transition.json)、
[`Loop 022 race-free warmup`](../artifacts/iterations/loop-022-lod-transition.json)。
Roguelike regression：[`Loop 023`](../artifacts/iterations/loop-023-roguelike-regression.json)、
[`Loop 024 attack animation`](../artifacts/iterations/loop-024-roguelike-regression.json)。
Refined debris：[`Loop 025 baseline`](../artifacts/iterations/loop-025-gpu.json)、
[`Loop 026 confirmation`](../artifacts/iterations/loop-026b-gpu.json)、
[`Loop 027 live impacts`](../artifacts/iterations/loop-027-destruction.json)、
[`Loop 028 finer mix`](../artifacts/iterations/loop-028-destruction.json)。
Warden：[`Loop 029 Depth-3 E2E`](../artifacts/iterations/loop-029-roguelike-regression.json)。
CPU upload：[`Loop 030 baseline`](../artifacts/iterations/loop-030-cpu.json)、
[`Loop 031 noisy first run`](../artifacts/iterations/loop-031-cpu.json)、
[`Loop 032 legacy`](../artifacts/iterations/loop-032a-cpu.json)、
[`Loop 032 direct`](../artifacts/iterations/loop-032b-cpu.json)、
[`Loop 033 reverse legacy`](../artifacts/iterations/loop-033-cpu.json)。
Low-material rejected branch：[`Loop 034 Lambert baseline`](../artifacts/iterations/loop-034a-gpu.json)、
[`Loop 034 white unlit`](../artifacts/iterations/loop-034b-gpu.json)、
[`Loop 035 calibrated`](../artifacts/iterations/loop-035-gpu.json)、
[`Loop 036 night calibrated`](../artifacts/iterations/loop-036-gpu.json)、
[`Loop 037 one-moon`](../artifacts/iterations/loop-037-gpu.json)。
Merged low masonry：[`Loop 038 columns`](../artifacts/iterations/loop-038-gpu.json)、
[`Loop 039 no seams`](../artifacts/iterations/loop-039-gpu.json)、
[`Loop 040 legacy DPR=1`](../artifacts/iterations/loop-040a-gpu.json)、
[`Loop 040 merged DPR=1`](../artifacts/iterations/loop-040b-gpu.json)、
[`Loop 041 merged CPU`](../artifacts/iterations/loop-041-cpu.json)、
[`Loop 042 legacy CPU`](../artifacts/iterations/loop-042-cpu.json)。
Fine debris：[`Loop 043 baseline`](../artifacts/iterations/loop-043-gpu.json)、
[`Loop 044 rejected facet light`](../artifacts/iterations/loop-044-gpu.json)、
[`Loop 045 fracture tint`](../artifacts/iterations/loop-045-gpu.json)、
[`Loop 046 reverse baseline`](../artifacts/iterations/loop-046-gpu.json)、
[`Loop 047 live destruction`](../artifacts/iterations/loop-047-destruction.json)。
Roguelike oaths：[`Loop 048 E2E`](../artifacts/iterations/loop-048-roguelike-regression.json)、
[`Loop 049 gameplay`](../artifacts/iterations/loop-049-gameplay.json)。
Link/support LOD：[`Loop 050 attribution`](../artifacts/iterations/loop-050-gpu.json)、
[`Loop 051 named diagnostic`](../artifacts/iterations/loop-051-gpu.json)、
[`Loop 052 race-free diagnostic`](../artifacts/iterations/loop-052-gpu.json)、
[`Loop 053 low twins`](../artifacts/iterations/loop-053-gpu.json)、
[`Loop 054 high A/B`](../artifacts/iterations/loop-054-gpu.json)、
[`Loop 056 low reverse`](../artifacts/iterations/loop-056-gpu.json)、
[`Loop 057 flame cull`](../artifacts/iterations/loop-057-gpu.json)。
Roguelike combat：[`Loop 058 Warden`](../artifacts/iterations/loop-058-roguelike-regression.json)、
[`Loop 059 failed dash E2E`](../artifacts/iterations/loop-059-roguelike-regression.json)、
[`Loop 060 dash E2E`](../artifacts/iterations/loop-060-roguelike-regression.json)、
[`Loop 061 gameplay`](../artifacts/iterations/loop-061-gameplay.json)。
Greedy floors：[`Loop 062 initial`](../artifacts/iterations/loop-062-gpu.json)、
[`Loop 063 fixed-seed method`](../artifacts/iterations/loop-063-gpu.json)、
[`Loop 064 greedy`](../artifacts/iterations/loop-064-gpu.json)、
[`Loop 065 cell A/B`](../artifacts/iterations/loop-065-gpu.json)、
[`Loop 066 greedy reverse`](../artifacts/iterations/loop-066-gpu.json)、
[`Loop 067 greedy CPU`](../artifacts/iterations/loop-067-cpu.json)、
[`Loop 068 cell CPU`](../artifacts/iterations/loop-068-cpu.json)。
Open surfaces：[`Loop 069 floor baseline`](../artifacts/iterations/loop-069-gpu.json)、
[`Loop 070 open floors`](../artifacts/iterations/loop-070-gpu.json)、
[`Loop 071 open merlons`](../artifacts/iterations/loop-071-gpu.json)、
[`Loop 072 wall caps`](../artifacts/iterations/loop-072-gpu.json)、
[`Loop 073 destruction`](../artifacts/iterations/loop-073-destruction.json)、
[`Loop 074 LOD`](../artifacts/iterations/loop-074-lod-transition.json)、
[`Loop 075 open passage`](../artifacts/iterations/loop-075-gpu.json)、
[`Loop 076 full passage A/B`](../artifacts/iterations/loop-076-gpu.json)、
[`Loop 077 open reverse`](../artifacts/iterations/loop-077-gpu.json)、
[`Loop 078 destruction`](../artifacts/iterations/loop-078-destruction.json)。
Dust rejected branch：[`Loop 079 baseline`](../artifacts/iterations/loop-079-gpu.json)、
[`Loop 080 dust`](../artifacts/iterations/loop-080-gpu.json)、
[`Loop 081 parked dust`](../artifacts/iterations/loop-081-gpu.json)、
[`Loop 082 rollback`](../artifacts/iterations/loop-082-gpu.json)。
Final convergence：[`Loop 083 CPU`](../artifacts/iterations/loop-083-cpu.json)、
[`Loop 084 low GPU`](../artifacts/iterations/loop-084-gpu.json)、
[`Loop 085 high GPU`](../artifacts/iterations/loop-085-gpu.json)、
[`Loop 086 LOD first`](../artifacts/iterations/loop-086-lod-transition.json)、
[`Loop 087 destruction`](../artifacts/iterations/loop-087-destruction.json)、
[`Loop 088 roguelike`](../artifacts/iterations/loop-088-roguelike-regression.json)、
[`Loop 089 gameplay`](../artifacts/iterations/loop-089-final-gameplay.json)、
[`Loop 090 re-forge`](../artifacts/iterations/loop-090-reforge-regression.json)、
[`Loop 093 occlusion`](../artifacts/iterations/loop-093-occlusion.json)、
[`Loop 095 court`](../artifacts/iterations/loop-095-court.json)、
[`Loop 098 LOD confirm`](../artifacts/iterations/loop-098-lod-transition.json)、
[`Loop 099 20-seed re-forge`](../artifacts/iterations/loop-099-reforge-regression.json)、
[`Loop 100 acceptance`](../artifacts/iterations/loop-100-acceptance.json)、
[`Loop 100 screenshot`](../artifacts/iterations/loop-100-final-demo.png)。
