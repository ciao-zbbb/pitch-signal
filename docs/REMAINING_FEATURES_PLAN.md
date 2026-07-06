# PitchSignal 剩余功能实施计划 (v3)

> 生成日期：2026-06-30 ｜ v2 修订：2026-07-01（合并 DeepSeek / OpenAI / Gemini 三方评审）
> **v3 修订：2026-07-02** —— 全盘核实实际完成状态（不采信文档自称，逐项在代码里找证据）+ 整合预测模型方法论专题成果
> 修订依据：[FEEDBACK_CONSOLIDATION.md](FEEDBACK_CONSOLIDATION.md)（v2 决策留痕）、[prediction-methodology-review.md](prediction-methodology-review.md)（v3 新增 P4 依据）
> 派工与分支：[EXECUTION_GUIDE.md](EXECUTION_GUIDE.md)
>
> **v3 主要变化**：① 逐项代码核实，纠正若干"文档说完成、代码是半成品"的条目；② 新增 **P4 预测模型深化**（市场赔率/阵容身价/洲际修正/校准层，均有独立开源项目实证支持）；③ P3-5 标记为「已用更优方案完成」而非原计划路径；④ 标注**世界杯已开赛**（2026-06-11 起），后续排期原则从"赛前齐备"改为"不影响直播 + 补关键缺口"。

---

## 上下文：世界杯已进行中

当前日期 2026-07-02，2026 世界杯已进行约 3 周（揭幕战 2026-06-11）。这意味着：
- 任何改动优先级判断要先问"会不会影响正在直播的比赛体验"，其次才是"值不值得做"。
- P2-2（进球推送）这类"实时增强"类功能，越晚上线单场收益越低，但只要赛程未结束（决赛 7-19）仍有价值，不必因"已经晚了"而放弃。
- 预测模型类改动（P4）不在直播关键路径上，可以和直播稳定性工作并行推进，互不阻塞。

---

## 已完成（截至 2026-07-02，逐项代码核实）

| 功能 | 文件 | 核实证据 |
|------|------|------|
| Track A 后端（盘中重定价） | `lib/live-reprice.js` | — |
| Pressure Index 后端 + 前端 | `lib/services/pressure-index.js`, `static/js/match-renderers.js` | — |
| Match Moments 引擎 | `lib/services/moment-detector.js`, `lib/jobs/moment-sync.js` | — |
| FIFA API 桥接 | `lib/services/fifa-api.js`, `scripts/build-fifa-match-bridge.js` | — |
| xG 框架 | `lib/services/xg-service.js`, `lib/jobs/xg-collector.js` | 🟡 仍空转，但原因变了（2026-07-04 核实）：已配置真实 `API_FOOTBALL_KEY` 并实测——key 有效、`league=1`（World Cup）参数确认正确（2022 赛季能拉到 Qatar vs Ecuador 等真实赛程），但 API 直接返回 `errors:{"plan":"Free plans do not have access to this season, try from 2022 to 2024."}`——**免费层不含 2026 赛季数据，本届世界杯期间免费 key 实际拿不到任何数据**，需升级付费计划才能真正解锁，不只是"配个 key"这么简单 |
| 置信区间输出 | `lib/prediction.js` → `calcConfidenceInterval()` | — |
| 概率走势线 / 三色胜率弧形 / 出线概率 / bracket 点击 / 角球模型 / 赔率采集 | 同 v2 | — |
| **回测样本扩容至 964 场（1930-2022 全部世界杯）+ Elo 全历史热启动** ⓝ³ | `data/history/worldcup_*.json`, `data/elo-seed.json`, `lib/backtest.js`, `scripts/{fetch-worldcup-history,build-elo-seed}.js` | commit `fbb5713`+`8ec3172`+`761c2d2`+`4e6ca76`；方向准确率 42.19%→57.88% [95% CI 54.8-61.1%]，与业界 Elo 基线重叠；三方独立审计（数据对账/泄漏检查+独立复算/引用数字核查）通过 |
| **回测 Bootstrap 置信区间** ⓝ³ | `lib/backtest.js` → `bootstrapCI()` | 对应 backtest-backlog.md 问题2，已完成 |
| **P0-1~P0-5 全部完成** ⓝ³ | 见下 P0 表 | git merge 记录 + 代码证据双重核实 |
| **P1-1（最佳第三名）、P1-3（温度单位）完成** ⓝ³ | `lib/qualification.js:123-147/174/281`, `static/js/match-detail.js:526-550` | — |
| **P2-3（市场赔率分歧）、P2-4（用户预测vs模型）、P2-5（新闻/伤停注入）完成** ⓝ³ | `lib/routes/odds-divergence.js`, `lib/routes/user-predictions.js`, `lib/teamContext.js:169-`（真实 Tavily fetch，`TAVILY_API_KEY` 门控，无 key 优雅降级） | P2-5 此前一次审计误判为"半成品"——实际 fetch 循环存在，只是没滚动到那一段代码 |

> ⓝ³ = v3 新核实为「已完成」或「重大进展」。ⓝ（v2 认定）见历史 diff。

---

## P0 — 上线前稳定性骨架 ✅ 全部完成

| 项 | 状态 | 证据 |
|---|---|---|
| P0-1 FIFA-API 容错 + schema 校验 | ✅ | `lib/services/fifa-api.js:51-119`（schema 校验 + 缓存降级 + stale 标记） |
| P0-2 `/health` 增强 | ✅ | `lib/routes/health.js:8-38`（FIFA 连通状态 + job 时间戳） |
| P0-3 终场比分回写 job | 🟡 机制本身完成，但发现遗留缺口（2026-07-06/07 核实） | `lib/services/score-writeback.js:57-100` + `moment-sync.js:199-223`。**发现两个问题**：① `matches` 表播种函数 `seedRealGroups()` 一直没被调用，生产库该表长期为空，回写永远查不到行——PR #7（`fix/matches-seed-surge`）已修，启动时自动补种。② `seedRealGroups()` 只播种 12 个小组 72 场**小组赛**，score-writeback 是纯 UPDATE 语义（查不到行直接 `match_not_found`，不插入），**淘汰赛阶段的比赛仍然没有对应行，回写会继续静默失败**（决赛 7-19 前每天都在发生）——待派工，规格见 [EXECUTION_GUIDE.md](EXECUTION_GUIDE.md) P0-3-补 一节。 |
| P0-4 实时比分条 + 状态机 | ✅ | `lib/db.js:308-327`（match_live_stats schema）+ `live-state-machine.js` |
| P0-5 关键路径 try/catch + 日志 | ✅ | `lib/logger.js` + 各 job 的 `safeExec` 用法 |

淘汰赛比分回写缺口待补（见上 P0-3），其余无遗留项。

---

## P1 — 低风险高确定性纠偏

| 项 | 状态 | 剩余工作 |
|---|---|---|
| P1-1 出线概率补最佳第三名 | ✅ 完成 | 无 |
| P1-2 venueFactor `applied=false` 根因 | ✅ 完成 | `scripts/diagnose-venue-factor.js` 遍历 104 场并区分 applied/no-effect/unverifiable/mismatch；当前 0 mismatch，21 场 applied，输出 λ 前后证据。 |
| P1-3 温度单位统一 | ✅ 完成 | 无 |
| P1-4 bracket matchId 校验 | ✅ 完成 | `scripts/validate-bracket-ids.js` 常驻校验完整 bracket、季军赛、重复 ID、轮次、阶段和开球时间；当前 32/32 匹配，0 failures。 |
| P1-5 体验验收 | ✅ 完成 | 桌面 1280px 与移动端 320px 的 Live/Schedule/Prediction/Standings/HUD 已完成真实浏览器验收；记录见 `docs/P1-5_UX_ACCEPTANCE.md`。生产环境待 GitHub source redeploy 后复验。 |

---

## P2 — 世界杯期间高价值新功能

| 项 | 状态 | 说明 |
|---|---|---|
| P2-1 换人影响追踪 | ✅ 完成 | 取换人前后 10 分钟 Pressure Index，以每侧至少 3 个快照计算线性回归斜率差，写入 `match_moments.raw_json.substitution_impact`；Bench 展示 ↑/↓/→，不足明确标记。 |
| P2-2 PWA 推送（进球推送） | 🟡 代码+生产部署已完成，**真机送达验收待做**（2026-07-04）| `web-push` 真实发送 + 404/410 失效订阅自动清理；`selectPushableGoals()` 双重防重放；sw.js push/notificationclick + hash 深链全链路打通；`test-pwa-push.js` + 全量测试通过。**2026-07-04 生产部署核实**：Railway GitHub redeploy `0acf97b4` 已上线，`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` 已配置，远程直接验证 `/health` healthy、`/api/push/public-key` 返回真实公钥、`/api/push/subscribe` 空 body 正确 400。**唯一剩余**：还没有真实进球场景下的真机送达验证（订阅 → 收到通知 → 点击跳转对应比赛），需等一场有进球的比赛做一次端到端验收 |
| P2-3 市场赔率分歧展示 | ✅ 完成 | 见上「已完成」 |
| P2-4 用户预测 vs 模型 | ✅ 完成 | 见上「已完成」 |
| P2-5 新闻/伤停注入 TeamContext | ✅ 完成 | 见上「已完成」，依赖 `TAVILY_API_KEY` 是否配置 |
| P2-6 Bot 知识库注入出线概率 + 赛事情境 | ✅ **完成**（commit `e0aa816`，2026-07-03，生产已核实） | 根因是线上 `group_standings` 表为空而 UI 走 `/api/standings`；改为复用 `/api/standings` 路由（`lib/routes/matchup.js:252` 同款模式），DB 仅作 legacy fallback。部署后确认生产 bot 引用真实 W/D/L/GF/GA/GD 数字；记录见 `docs/P2-6_BOT_PRODUCTION_ACCEPTANCE.md`。 |

---

## P3 — 需数据样本/分析验证后才上

| 项 | 状态 | 说明 |
|---|---|---|
| P3-1 Track B 压力指数校准 | 🟡 检测 bug 已修（PR #7），分析待做 | `sustained_pressure_alert` 此前因 `detectSurge` 严格连续计数漏报，生产实测长期为 0 条；PR #7 改滑动窗口（近 5 快照≥3 个≥65）+ 补"期间未进球"否决后已解锁，样本会开始积累。真正的置换检验分析仍未跑（需等生产样本量达标，去生产库核实，别信本地库） |
| P3-2 Calibration 校准报告面板 | ✅ 已完成（2026-07-06 核实） | `lib/backtest-calibration.js`（`fitPlatt()` + `buildCalibrationReport()`）+ `lib/routes/calibration.js`（`GET /api/calibration-report`），`scripts/test-calibration-report.js` 通过（含样本不足时 Platt 正确标记 unavailable 的断言） |
| P3-3 点球专项模型 | ✅ 已完成，PR 待合并（[#5](https://github.com/ciao-zbbb/pitch-signal/pull/5)） | 历史点球命中率（76 队，RSSSF）替换 `live-reprice.js` 硬编码 50/50；`test-penalty-model.js`（19 断言）通过 |
| P3-4 阵容 CI 动态收窄 | ✅ 已完成，PR 待合并（[#6](https://github.com/ciao-zbbb/pitch-signal/pull/6)） | `PredictionService.predictMatch()` 查 `lineups-source.js` 的 `getLineups()` 判定首发是否公布，接入 `lineupUncertainty`；`test-lineup-ci.js`（8 断言）通过 |
| P3-5 回测样本扩充 | ✅ **已完成，但路径与原计划不同** | 原计划是"混入 Euro/Copa 到 300+ 场"；实际做法是全量 1930-2022 世界杯正赛 964 场（openfootball，CC0）+ martj42 49k 场用于 Elo 热启动，不混赛事等级做评估——这是三方研究交叉验证过的更优方案（详见 [prediction-methodology-review.md](prediction-methodology-review.md)）。**Euro/Copa 继续导入进正赛评估集仍是可选加强项，非阻塞，价值有限**（964 场 CI 已经和业界基线重叠） |
| P3-6 角球准确率回测 | 🟡 框架已完成，PR 待合并（[#4](https://github.com/ciao-zbbb/pitch-signal/pull/4)），真实数据评估待样本量达标 | `lib/corner-model.js` 提取角球预测公式为独立模块；`test-corner-backtest.js` 五段评估（单元/真实DB/合成/敏感度/边界）；合成数据 MAE 1.90 < 2.0 目标，但真实评估仍等 20-48 场生产完赛数据 |

---

## P4 — 预测模型深化（新增，源自方法论专题）

> 背景：session6-7 做了两轮外部研究（制度化系统 + 10 个开源同行项目）+ 964 场实证回测，结论见 [prediction-methodology-review.md](prediction-methodology-review.md)。核心判断：**数学模型（Elo+Poisson）已到该模型族天花板（~60%），继续调参收益趋近于零**；真正还有空间的是三个新信号轨道。按预期收益排序：

### P4-1 市场赔率轨道（最高优先级，唯一确证能超越60%的路径）
**目的**：所有研究源一致结论——市场赔率是唯一稳定跑赢纯 Elo/Poisson 的信号。
**做什么**：
- `lib/prediction.js calcOddsFactor()` 当前用简单比例去水（`1/odds` 归一化），换成 **Shin's method**（处理冷门溢价，业界公认更准，尤其在世界杯小组赛这种大冷门常见的场景）
- **复用 P2-3 已建成的基建**：`lib/services/the-odds-api.js`、`lib/jobs/odds-collector.js`、`lib/routes/odds-divergence.js` 已经在跑，这不是从零开始的专题，是在已有采集链路上换一个更准的去水算法 + 决定融合策略
- 决定"并排展示 vs 贝叶斯融合"：playmobil 的哲学是"市场只做基准，绝不进模型输入"；我们 `prediction.js` 现有 Polymarket 贝叶斯融合设计（当前 `POLYMARKET_ENABLED=false` 闸门关闭）是相反哲学。这个决策需要专门讨论，不是纯技术问题
**工作量**：Shin's method 替换 0.5天 + 融合策略讨论与实现 1-2天（取决于选哪条路）

### P4-2 阵容身价信号（三个独立项目支持）
**目的**：hjjbh1314、playmobil、SilvioBaratto 三个互不相关的项目都独立发现阵容市场身价（Transfermarkt 类数据）是有效强度锚点，尤其在实力悬殊场次能把模型拉近市场共识。
**做什么**：调研 Transfermarkt 数据可得性（有无免费/合规 API 或数据集）；作为 Elo 先验的混合权重，用 `compareBaseline()` 验收，不达标不上线。
**工作量**：数据调研 0.5天 + 实现验收 1天（数据源不确定，工作量有浮动）

### P4-3 洲际强度修正（有具体实测数字支撑）
**目的**：hjjbh1314 实测：跨洲比赛用洲际强度修正能把方向准确率从 56.8% 提到 58.3%。我们已有 49k 场全历史数据（`data/elo-seed.json` 生成用的 CSV），不需要额外拉数据。
**做什么**：按 UEFA/CONMEBOL/AFC/CONCACAF/CAF/OFC 拟合跨洲比赛的强度修正量（学习值参考 hjjbh1314：UEFA +117/CONMEBOL +104/AFC +18/CONCACAF −27/CAF −40/OFC −171 Elo分），**注入概率头**而不是当普通 ML 特征喂（playmobil 已证明后者无效——这是两个项目结论看似矛盾、实为做法不同的关键点）。
**工作量**：1-1.5天

### P4-4 校准层（合并原 P3-2）
**目的**：hjjbh1314 实测 Platt scaling 能修正"疫情后主场优势系统性衰减未被发现"这类真实偏差（RPS 0.1704→0.1698，小而真）。我们自己的 964 场回测 Brier 也还有约 0.057 的差距，主要来自校准而非方向。
**做什么**：`lib/backtest-calibration.js`（新建，原 P3-2 计划）读 `prediction_snapshots` 对比实际结果，算 Brier + 10 桶校准曲线；Platt scaling 拟合修正系数；`GET /api/calibration-report` + 前端「模型表现」子 Tab。
**依赖**：P0-3（已完成，终场比分回写）。
**工作量**：后端 1.5 + 前端 1 + 校准拟合 0.5

### P4-5 参数打扫（低优先，现在可以安全做）
**目的**：`lib/prediction.js:59` `eloGuidedLambda()` 里的 `baseLambda = 1.5` 是 `globalAvgGoals` 从 2.5 改成 1.2 时漏改的孤立过期常数（session6 定位，一直未修）。现在有 964 场基线，可以用 `compareBaseline()` 安全验收这类小改动了。
**做什么**：改成与当前 `globalAvgGoals=1.2` 一致的量纲（约 0.6），跑 `compareBaseline` 验收后再定是否合并。
**工作量**：0.5天（含验收）

### 明确不做（有三重独立证据支撑）
- 不引入 ML/梯度提升层——同特征下无增益，小样本更差
- 不做双变量 Poisson（Karlis-Ntzoufras）——无证据优于 Dixon-Coles
- 不自爬博彩网站——ToS 风险，P4-1 走正规 API

---

## 贯穿项（随时可并）

| 项 | 状态 |
|---|---|
| a11y / 色盲 | ✅ 完成近期快修 | 核心按钮/Tab ≥44px；Standings 与 HUD Tab 有选中状态；概率条有 ARIA 标签、百分比常显及非纯颜色图案区分；320px 无页面级横向溢出。 |
| 新模块补测试 | ✅ `test-bot-kb.js` 已注册进 `test-runner.js`（2026-07-03 核实，文档之前过期）；P0/P1 系列多数靠既有测试间接覆盖，无专项 |
| README 数据流图 | 🟡 后台任务 `task_0368a662` 进行中（2026-07-03 发出） |
| env/闸门治理 | ✅ `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` 已补录 README（2026-07-03） |
| AI 复盘历史回填 | 🟡 后台任务 `task_d6f98ff4` 进行中（2026-07-03 发出） |

---

## 技术债

- ~~ratings.json 数据源~~ → 已纠正（v2）
- ~~botKnowledgeBase 注入~~ → 已升级为 P2-6（进行中）
- i18n 迁移 → 仍是低优先，不变
- **新增（v3）**：`lib/prediction.js:59 baseLambda=1.5` 过期常数 → 见 P4-5

---

## 建议排期（世界杯进行中，非赛前）

1. ~~P2-6 收尾~~ ✅ 完成（`fe7d167`，2026-07-02）
2. ~~P2-2 PWA 推送~~ ✅ 完成（`ab2b030`，分支 `p2/pwa-push`，2026-07-02；待部署 VAPID key 后真机验收）
3. **P4-1 市场赔率轨道**（预测模型侧最高杠杆，且不占直播关键路径，当前最高优先级）
4. **P1-2/P1-4 诊断脚本 + P1-5 真机验收**（低成本，插空做）
5. P2-1、P4-2~P4-5、a11y、P3 系列——按团队带宽排

## 分工与分支
见 [EXECUTION_GUIDE.md](EXECUTION_GUIDE.md)：角色分工矩阵、分支体系、工作顺序、每任务 IN/OUT 边界与核查标准。（v3 未改动分支体系，P4 系列建议沿用 `p2/*` 同款分支命名，如 `p4/odds-shin-method`）
