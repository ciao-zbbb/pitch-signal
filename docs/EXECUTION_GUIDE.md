# PitchSignal 执行指南

> 生成日期：2026-07-01
> 用途：用户据此**派工**，每个分支由指派者实现；汇总者（Claude）负责**收尾与检验**。
> 配套：[FEEDBACK_CONSOLIDATION.md](FEEDBACK_CONSOLIDATION.md)（决策依据）、[REMAINING_FEATURES_PLAN.md](REMAINING_FEATURES_PLAN.md)（任务全集）。

---

## 1. 分支体系

### 集成分支
- 从 `main` 切出 **`release/wc2026`**，作为本批所有功能的汇合点。
- 各功能分支从 `release/wc2026` 切出，PR 回 `release/wc2026`。
- 整批验收通过后，`release/wc2026` 一次性合回 `main`。

### 功能分支命名 `<优先级>/<短横线主题>`
| 分支 | 对应任务 |
|------|---------|
| `p0/fifa-api-resilience` | P0-1 FIFA-API 容错 + schema 校验 |
| `p0/health-enhance` | P0-2 /health 增强 |
| `p0/score-writeback` | P0-3 终场比分回写 |
| `p0/live-score-state-machine` | P0-4 实时比分 + 状态机 |
| `p0/logger-trycatch` | P0-5 关键路径 try/catch + 日志 |
| `p1/qualification-third-place` | P1-1 最佳第三名 |
| `p1/venuefactor-rootcause` | P1-2 venueFactor 根因 |
| `p1/temp-units` | P1-3 温度单位 |
| `p1/bracket-verify` | P1-4 bracket matchId 校验 |
| `p1/ux-acceptance` | P1-5 体验验收 |
| `p2/sub-impact` | P2-1 换人影响 |
| `p2/pwa-push` | P2-2 PWA 推送 |
| `p2/odds-divergence` | P2-3 赔率分歧 |
| `p2/user-predictions` | P2-4 用户预测 |
| `p2/teamcontext-news` | P2-5 新闻注入 |
| `p2/bot-kb` | P2-6 Bot 知识库 |
| `p3/track-b-calibration` | P3-1 压力校准 |
| `p3/calibration-panel` | P3-2 校准报告面板 |
| ~~`p3/penalty-model`~~ | P3-3 点球模型 —— ✅ 已完成（PR 待合并），见下方 P3-3 说明 |
| `p3/lineup-ci` | P3-4 阵容 CI |
| `p3/backtest-expansion` | P3-5 回测样本 + param-sweep |
| `p3/corner-backtest` | P3-6 角球准确率回测 |
| `chore/a11y` | 贯穿 a11y/色盲 |
| `chore/new-module-tests` | 贯穿 新模块测试 |
| `docs/dataflow-mermaid` | 贯穿 README 数据流图 |

### 提交与合并门槛
- 提交规范：沿用现有 Conventional Commits（`feat:`/`fix:`/`chore:`/`docs:`）。
- **每个 PR 合入 `release/wc2026` 前必须**：① `npm test` 全绿；② 本地 `/health` 返回 healthy；③ PR 描述附核查证据（截图/日志/API 响应）；④ 不引入新外部依赖（除非已在边界中显式批准，如 `web-push`）。

---

## 2. 角色分工矩阵

| 角色 | 承接分支 |
|------|---------|
| **后端 Node.js** | `p0/fifa-api-resilience`、`p0/health-enhance`、`p0/score-writeback`、`p1/venuefactor-rootcause`、`p2/odds-divergence`(后端)、`p3/track-b-calibration`、`p3/calibration-panel`(后端)、`p3/penalty-model`、`p3/lineup-ci` |
| **前端 vanilla JS/SVG** | `p1/qualification-third-place`(前端)、`p1/temp-units`、`p1/bracket-verify`、`p1/ux-acceptance`、`p2/odds-divergence`(前端)、`p2/user-predictions`(前端)、`p3/calibration-panel`(前端)、`chore/a11y` |
| **全栈** | `p0/live-score-state-machine`、`p0/logger-trycatch`、`p2/sub-impact`、`p2/pwa-push`、`p2/user-predictions`(完整)、`p2/teamcontext-news`、`p2/bot-kb` |
| **数据/分析** | `p3/track-b-calibration`(回测部分)、`p3/penalty-model`(数据)、`p3/backtest-expansion`、`p3/corner-backtest` |
| **DevOps/平台** | Railway env/密钥/闸门治理、日志持久化、`release/wc2026` 部署回归 |

## 2.1 派工拆分建议

> 给外部实现者派工时，按「输入 / 输出 / 验收证据」拆包；不要只发功能名。

| 工作包 | 分支 | 可并行性 | 交付物 | 验收证据 |
|--------|------|----------|--------|----------|
| 稳定性探针 | `p0/fifa-api-resilience`, `p0/health-enhance` | 可并行，建议先做 | FIFA API schema/fallback；`/health` 业务健康字段 | 缺字段/超时模拟；`curl /health` 响应 |
| 比分闭环 | `p0/score-writeback`, `p0/live-score-state-machine` | 先后端后前端 | 终场比分回写；实时比分与状态展示 | 已结束比赛幂等回写；进行中/中场/结束态截图 |
| 日志兜底 | `p0/logger-trycatch` | 可独立 | 关键 job try/catch + 上下文日志 | 人为抛错进程不退出，日志含 match/job 上下文 |
| 赛制纠偏 | `p1/qualification-third-place` | 可独立 | 最佳第三名跨组概率 + 前端黄条 | 构造数据单测；浏览器出线页截图 |
| 数据映射纠偏 | `p1/venuefactor-rootcause`, `p1/bracket-verify`, `p1/temp-units` | 可并行，注意前端冲突 | 诊断脚本、别名/ID/单位修复 | 覆盖率报告；0 失配；单位切换截图 |
| 体验验收 | `p1/ux-acceptance`, `chore/a11y` | P0/P1 功能稳定后做 | 对照 UI-AUDIT 的修复清单 | 320px/桌面截图；触控尺寸和色盲可读性检查 |
| 新功能包 | `p2/sub-impact`, `p2/odds-divergence`, `p2/user-predictions`, `p2/teamcontext-news`, `p2/bot-kb` | 可拆人并行 | 各功能闭环 + 降级策略 | API 用例、浏览器截图、无数据时 fallback |
| 推送包 | `p2/pwa-push` | 依赖 DevOps VAPID | 订阅、进球通知、点击回比赛 | 真机订阅到 notificationclick 闭环 |
| 数据分析包 | `p3/*` | 等 P0-3 和样本积累 | 回测/校准/参数工作流 | 报告含样本量、效应量、误差指标 |

派工备注：
- 每个实现者开工前先读本文件对应任务的「边界 IN-OUT」和 [FEEDBACK_CONSOLIDATION.md](FEEDBACK_CONSOLIDATION.md) 的相关证据，避免重复开发已完成模块。
- 改 `static/js/match-renderers.js` 的任务须串行或频繁 rebase：`p0/live-score-state-machine`、`p1/temp-units`、`p2/sub-impact`。
- P3 分析类任务不得提前改概率权重；先交报告，结论通过后再实现。
- 所有新模块测试沿用现有 `scripts/test-*.js` + Node `assert`，不引入测试框架。

---

## 3. 任务规格（六段制：目的 / 方式 / 边界 IN-OUT / 前置核实 / 结果核查 / 依赖）

> 所有 `file:line` 均已核实，可点击核对。

### P0-1 · `p0/fifa-api-resilience`
- **目的**：[fifa-api.js](../lib/services/fifa-api.js) 是唯一桥接源，限流/结构变动会让全站停摆。
- **方式**：对响应做字段 schema 校验；缓存上次成功响应（复用 `middleware/cache.js`），失败/限流时回退缓存并标 `stale:true`。
- **边界**：IN = schema 校验 + 缓存 fallback + 降级标记；OUT = 不新增第二数据源、不改预测公式、不引校验库（手写校验）。
- **前置核实**：列出 `fifa-api.js` 实际消费的字段清单。
- **核查**：模拟 FIFA 返回缺字段/超时，全站不崩、返回 stale 数据；`npm test` 绿。
- **依赖**：无。

### P0-2 · `p0/health-enhance`
- **目的**：[health.js](../lib/routes/health.js) 现仅 DB+uptime+memory，不足以判断业务健康。
- **方式**：在既有端点对象上扩展返回 `fifaApi: ok|stale|down` + 各定时任务 `lastSyncAt` 时间戳。
- **边界**：IN = 增强既有 `GET /health`；OUT = **不新建端点**、不改状态码语义（DB 不可达仍 503）。
- **前置核实**：定时任务（moment-sync/xg/odds/lineups）在哪记录最后成功时间。
- **核查**：`curl /health` 含新字段；停掉某 job 后时间戳停更可见。
- **依赖**：可与 P0-1 共享 FIFA 连通探测。

### P0-3 · `p0/score-writeback`
- **目的**：`matches` 表（[db.js:307](../lib/db.js:307)）有 `home_score/away_score/played` 但无终场回写，P3 校准缺实际结果。
- **方式**：新 job 或在 [moment-sync.js](../lib/jobs/moment-sync.js) 监听终场 moment，回写 `home_score/away_score/played=1`。
- **边界**：IN = 终场结果落库 + 幂等（重复不覆盖错值）；OUT = 不改 moment 检测逻辑、不动淘汰赛点球比分语义。
- **前置核实**：终场 moment 的 type 与 payload 字段；比分权威来源（ESPN/FIFA）。
- **核查**：跑一场已结束比赛，`matches` 行被正确回写；重复执行结果幂等。
- **依赖**：是 `p3/calibration-panel`、`p3/track-b-calibration` 的前置。

### P0-4 · `p0/live-score-state-machine`
- **目的**：[match_live_stats](../lib/db.js:273) 无比分/status；用户只见概率不见比分。
- **方式**：采集当前比分；状态机 `pre/match/ht/et/pen/end`；前端在概率走势同面板加比分条，按状态切换展示。
- **边界**：IN = 状态机 + 比分条 + 状态驱动的展示切换；OUT = 不重写概率引擎、不改 moment 表结构（比分可走内存/ESPN 实时，不强制建列）。
- **前置核实**：实时比分现有从哪取（ESPN scoreboard？）；ht/et/pen 的判定信号来源。
- **核查**：用进行中/中场/加时/点球各状态比赛核对展示正确切换；移动端比分条不溢出。
- **依赖**：无（与 P1 前端任务注意 `match-renderers.js` 合并冲突）。

### P0-5 · `p0/logger-trycatch`
- **目的**：重定价/moment-sync/推送等关键路径异常缺上下文。
- **方式**：关键路径加 try/catch，接入既有 [logger.js](../lib/logger.js)（结构化 JSON），记录 match_id 等上下文；DevOps 配 Railway 日志持久化。
- **边界**：IN = try/catch + 既有 logger；OUT = **不引入 pino**、不改日志格式契约。
- **前置核实**：现有 logger 的调用约定（`createLogger(module)`）。
- **核查**：人为抛错时日志含模块名+上下文，进程不退出；`npm test` 绿。
- **依赖**：无。

---

### P1-1 · `p1/qualification-third-place`
- **目的**：[qualification.js:177-180](../lib/qualification.js:177) 把小组第 3、4 名一律记 eliminated；2026 赛制需 8 个最佳第三名晋级，当前缺失。
- **方式**：后端在蒙特卡洛每次模拟收集**各组第三名**，按 2026 规则跨组排名取前 8，统计 `thirdPlaceQualifyProb`；前端在出线展示加第三名概率（黄）色条。
- **边界**：IN = 跨组最佳第三名概率 + 前端展示 + 浏览器验证；OUT = 不改淘汰赛对阵生成、不动一/二名既有逻辑。
- **前置核实**：确认 2026 最佳第三名比较口径（积分→净胜→进球→…）；确认前端出线渲染函数位置（`elo-prediction.js`）。
- **核查**：构造一组数据验证第三名概率合理（同组第三名概率随积分单调）；前端各组黄色条出现；`npm test` 绿（新增 `scripts/test-third-place.js`）。
- **依赖**：无。

### P1-2 · `p1/venuefactor-rootcause`
- **目的**：venueFactor 已乘进 λ（[prediction.js:203](../lib/prediction.js:203)），但部分场次 `applied=false`，因子未生效。
- **方式**：诊断脚本遍历赛程，输出每场 `computeForMatch` 的 applied 与失败原因（缺 espn_id / 场地名未匹配 / 数据缺失）；场地名加别名模糊匹配；未匹配记 warning。
- **边界**：IN = 根因报告 + 别名映射修复 + `scripts/test-venue-factor.js`；OUT = 不调 venueFactor 数值模型、不动 Poisson 公式。
- **前置核实**：`data/wc2026/venues.json` 与 `teams.json` 的场地/球队键格式。
- **核查**：诊断脚本 `applied=true` 覆盖率达标；某场打印接入前后 λ 变化；`npm test` 绿。
- **依赖**：无。

### P1-3 · `p1/temp-units`
- **目的**：天气面板硬编码 `°C`（[match-detail.js:519](../static/js/match-detail.js:519)、[match-renderers.js:1666](../static/js/match-renderers.js:1666)），源数据未必带单位。
- **方式**：统一字段（`weather.json` 存 `tC/feelsC` 摄氏；[venueFactors.js:193](../lib/venueFactors.js:193) 已有 °F 换算）；按数值范围自动判别（>50 视为 °F）或天气 API 强制单位；前端单位偏好持久化（localStorage）。
- **边界**：IN = 单位统一/判别 + 偏好持久化；OUT = 不改天气数据源、不改 venueFactor 温度公式。
- **前置核实**：天气数据实际单位（确认 `tC` 确为摄氏）。
- **核查**：注入 °F/°C 两类样本显示均正确；切换单位刷新后保持。
- **依赖**：注意与 P0-4 同改 `match-renderers.js`，协调合并顺序。

### P1-4 · `p1/bracket-verify`
- **目的**：bracket 点击已接（[bracket.js:266](../static/js/bracket.js:266)），matchId 错位则打不开。
- **方式**：校验脚本遍历 bracket JSON 所有 matchId 在 ESPN/FIFA 赛程查找，输出缺失/失配并修复；真机点击确认打开 HUD。
- **边界**：IN = 校验脚本 + 数据修复 + 点击验证；OUT = 不重写 bracket 渲染、不改 HUD。
- **前置核实**：bracket JSON 路径与 matchId 字段名。
- **核查**：脚本输出 0 失配；浏览器逐个点击淘汰赛节点均打开对应比赛。
- **依赖**：无。

### P1-5 · `p1/ux-acceptance`
- **目的**：原计划漏体验验收。
- **方式**：HUD/Standings/Prediction 对照 [UI-AUDIT-REPORT.md](../design_handoff_pitchsignal/UI-AUDIT-REPORT.md)（动态 max-width、Live/Schedule 细节）；真实浏览器冒烟；移动端 ≥44px / 320px（记忆 `feedback-hud-mobile-layout`）。
- **边界**：IN = 走查清单 + 真机冒烟 + 必要的样式微调；OUT = 不做大改版、不引 UI 框架。
- **前置核实**：UI-AUDIT-REPORT.md 未关闭项清单。
- **核查**：逐项对照表打勾；320px / 桌面截图对照；关键按钮 ≥44px。
- **依赖**：建议在 P0/P1 功能稳定后做。

---

### P2-1 · `p2/sub-impact`
- **目的**：换人已入 `match_moments`（type=`substitution_key`），未追踪后续压力/xG 斜率变化。
- **方式**：后端取换人前后 N 分钟 `match_live_stats` 算 Pressure Index 斜率差，存 `match_moments.raw_json.substitution_impact`；前端 `renderBenchAnalysis()` 换人条目旁显示 ↑/↓。
- **边界**：IN = 斜率差计算 + 展示；OUT = 不把 impact 喂进概率模型。**窗口最少快照数 ≥3，不足标「数据不足」**，不生成误导箭头。
- **前置核实**：`match_live_stats` 采样频率是否足够支撑前后窗口。
- **核查**：构造足/不足样本两类，箭头/「数据不足」分别正确；`npm test` 绿。
- **依赖**：无。

### P2-2 · `p2/pwa-push`
- **目的**：有 manifest，SW 只做静态缓存，无推送。
- **方式**：后端 `lib/services/push-service.js`（`web-push`）+ `POST /api/push/subscribe` + `push_subscriptions` 表（`CREATE TABLE IF NOT EXISTS` 模式 + migrations 数组）；`moment-sync.js` 检测 `goal` 推送。前端 `sw.js` push handler + `notificationclick` 解析 `matchId` 打开比赛；关键页离线 fallback + 「离线数据，上次更新 XX:XX」。
- **边界**：IN = 订阅/推送/点击闭环 + 离线 fallback；OUT = 不做账号体系、不推非进球事件（首版仅 goal）。**唯一批准的新依赖：`web-push`**。
- **前置核实**：VAPID env 是否已配（DevOps）；SW 现有缓存策略。
- **核查**：真机订阅→进球→收到通知→点击打开对应比赛；断网打开关键页显示离线 fallback。
- **依赖**：VAPID env（DevOps 先行）。

### P2-3 · `p2/odds-divergence`
- **目的**：赔率采集已存在（[odds-collector.js:29](../lib/jobs/odds-collector.js:29)、[the-odds-api.js](../lib/services/the-odds-api.js)、[routes/odds.js](../lib/routes/odds.js)），缺「模型 vs 市场分歧」展示。
- **方式**：复用既有采集 + 隐含概率（去 vig），新增 `model_vs_market_delta`，`|model-market|>0.08` 标 divergence；前端 hud-winprob 下加黄色提示行。
- **边界**：IN = 分歧计算 + 落库 + 前端提示；OUT = **不把赔率作权重喂进模型**（仅 benchmark）；POLYMARKET 闸门保持关闭。
- **前置核实**：`match_odds_benchmark` 表是否已建（当前未见→按既有模式新建）；隐含概率去 vig 是否已实现。
- **核查**：构造模型/市场差值用例验证阈值；分歧场显示提示、无分歧不显示。
- **依赖**：无（赔率采集已就绪）。

### P2-4 · `p2/user-predictions`
- **目的**：赛前用户下注，赛后比准确率，社交属性。
- **方式**：`user_predictions` 表（匿名 session UUID）；`POST /api/user-predict`、`GET /api/user-predict/:matchId`（社区概率）；前端赛前卡片加 主/平/客 按钮 + 「社区：52% 主胜」。
- **边界**：IN = 投票/统计/展示；OUT = 不做账号。**防刷**：同 session 同场只投一次（可改）+ 频率限制（复用 `middleware/rate-limit.js`，如 5s/次）；展示剔除异常时段。
- **前置核实**：`middleware/rate-limit.js` 现有用法。
- **核查**：连点被限频；同场重复投票为「修改」而非累加；社区百分比正确。
- **依赖**：无。

### P2-5 · `p2/teamcontext-news`
- **目的**：[teamContext.js:80](../lib/teamContext.js:80) TODO——实时新闻/伤停未喂给预测 AI 上下文。
- **方式**：Tavily 抓取的 match/team 新闻清洗后注入 `TeamContextManager`，供 Phase 2 AI 微调。
- **边界**：IN = 新闻清洗 + 注入；OUT = **无数据返回空数组，绝不编造**（沿用现有约定）；不改 AI 微调闸门状态。
- **前置核实**：Tavily 现有抓取入口；`TeamContextManager` 注入接口。
- **核查**：有伤停新闻时上下文含真实条目，无新闻时为空数组；不出现编造内容。
- **依赖**：无。

### P2-6 · `p2/bot-kb`
- **目的**：[botKnowledgeBase.js](../lib/botKnowledgeBase.js) 可读出线概率/standings/context，让 Chat 也能答。
- **方式**：把 qualification、standings、match context 注入 Bot 回答。
- **边界**：IN = 数据注入；OUT = 不改 Bot 对话框架。
- **前置核实**：botKnowledgeBase 现有数据装配方式。
- **核查**：问「X 队出线概率」时 Bot 给出真实数值。
- **依赖**：建议 P1-1 完成后做（复用最佳第三名数据）。

---

### P3-1 · `p3/track-b-calibration`
- **目的**：压力指数当前只展示不影响概率，须回测验证后升级。
- **方式**：从 `match_live_stats` 拉 `sustained_pressure_alert`，统计 alert 后 5/10/15 分钟进球率 vs base rate；显著才给 `live-reprice.js` lambdaRemaining 加 calibrated 系数（≤+15%）。
- **边界**：IN = 回测分析 + 通过后才实现加权；OUT = 未通过验证**不得**改概率。**统计**：用置换检验/控制整体错误率，防多重比较，而非裸 p<0.05。
- **前置核实**：需 P0-3 积累的实际结果 + 足够 alert 样本。
- **核查**：分析报告含置换检验 p 值与效应量；加权仅在显著时启用且 ≤+15%。
- **依赖**：P0-3、足够世界杯数据。

### P3-2 · `p3/calibration-panel`
- **目的**：差异化卖点——展示模型是否过度自信。
- **方式**：`lib/backtest-calibration.js` 读 `prediction_snapshots` 对比结果算 Brier + 10 桶校准曲线；`GET /api/calibration-report`；前端「预测」页加「模型表现」子 Tab。
- **边界**：IN = Brier/校准曲线/方向正确率；OUT = 不改预测引擎。
- **前置核实**：`prediction_snapshots` 字段是否够算 Brier。
- **核查**：已知样本手算 Brier 与接口一致；校准曲线 SVG 渲染。
- **依赖**：P0-3（实际结果）。

### ~~P3-3 · `p3/penalty-model`~~（✅ 已完成，2026-07-06）
- **目的**：点球大战当前是硬编码对称假设。
- **实现**：`data/penalty-shootout-stats.json` 收录 76 支球队历史点球命中率（来源 RSSSF）；`lib/live-reprice.js` 新增 `getPenaltyConversionRate()` + `penaltyShootoutWinProb()`（标准 5 轮 + 突然死亡独立 Bernoulli 模型），替换原硬编码 `penaltySkillHome/Away = 0.5`；显式传入时仍优先（保留旧调用/测试兼容），否则按 `homeTeamCode`/`awayTeamCode` 查历史命中率计算，`penHome + penAway` 恒为 1。
- **调用方接入**：`lib/routes/prediction.js`（`getTeamCodesForMatch()`）、`lib/jobs/moment-sync.js` 均已传入双方代码；`lib/backtest.js` 的历史回测调用未传 `matchId`，不触碰新逻辑，无回测数据泄漏风险。
- **边界**：IN = 数据整理 + 命中率替换默认值；OUT = 不改常规时间/加时赛的 Poisson 逻辑，只改点球大战这一段；缺数据优雅回退到 0.5。
- **核查**：`scripts/test-penalty-model.js`（19 项断言）验证对称输入=0.5、命中率不同方向正确、缺数据回退、显式 override 优先级、常规时间不受影响；`npm test` 全绿。
- **依赖**：无。

### P3-4 · `p3/lineup-ci`
- **目的**：`calcConfidenceInterval()` 已吃 `lineupUncertainty`（[prediction.js:427](../lib/prediction.js:427)），缺数据源驱动。
- **方式**：**先核实**首发确认值存于何表/字段（`lineups-sync.js` 已在赛前 50 分钟同步，但 `pre_match_snapshots.has_confirmed_lineup` 未见于 schema）；建立后换算成 `lineupUncertainty` 传入预测链路。
- **边界**：IN = 数据源对接 + 传参；OUT = 不改 CI 公式系数本身。
- **前置核实**：**关键**——lineup 确认状态当前是否落库、落在哪。
- **核查**：首发公布后该场 CI 收窄、未公布时维持宽。
- **依赖**：lineups-sync 数据落库情况。

### P3-5 · `p3/backtest-expansion`
- **目的**：[backtest-backlog.md:5](backtest-backlog.md:5) 仅 128 场，显著性不足；`param-sweep.js` 无上线工作流。
- **方式**：导入 Euro 2020/2024、Copa 2021 至 300+ 场（标记来源）；建立定期跑 `param-sweep.js` + 一键更新生产参数的工作流。
- **边界**：IN = 数据导入（格式兼容现有 `data/history/`）+ 寻优工作流；OUT = 不引入 AUTO_CALIBRATION（保持关闭）。
- **前置核实**：`data/history/worldcup_*.json` 格式。
- **核查**：回测样本 ≥300；param-sweep 输出最优参数并可一键写入配置。
- **依赖**：无。

### P3-6 · `p3/corner-backtest`
- **目的**：角球模型已上线（[matchup.js:805](../lib/routes/matchup.js:805)），需准确率评估。
- **方式**：累计 20-48 场后统计方向正确率与 MAE（目标 <2.0），据此调风格系数。
- **边界**：IN = 评估脚本 + 系数微调；OUT = 不重写角球模型。
- **前置核实**：实际角球结果数据来源。
- **核查**：评估报告含 MAE 与方向正确率。
- **依赖**：足够已结束比赛。

---

### 贯穿 · `chore/a11y` / `chore/new-module-tests` / `docs/dataflow-mermaid`
- **a11y**：色条叠图案（斜线/点状）+ 百分比常显 + 关键状态文字标签。核查：色盲模拟下可区分、文字始终可读。
- **新模块测试**：为 P0–P3 新模块写同构 `scripts/test-*.js`（`assert`，**不引框架**）。核查：纳入 `npm test`。
- **数据流图**：README 加 Mermaid（FIFA API → Bridge → DB → Prediction → Frontend + 定时任务）。核查：图与实际 jobs 一致。

---

## 4. 工作顺序（批次推进）

1. **第 0 批（汇总者已完成）**：三份文档产出。派工者据此创建 `release/wc2026` 与功能分支。
2. **第 1 批 · P0**：稳定性骨架先合。`p0/score-writeback` 须先于所有 P3 校准类任务。
3. **第 2 批 · P1**：低风险纠偏 + 体验验收，前端任务可与 P0 后端并行（注意 `match-renderers.js` 合并协调）。
4. **第 3 批 · P2**：新功能。`p2/pwa-push` 等 DevOps 配好 VAPID env 再开工。
5. **第 4 批 · P3**：需样本/分析，最后做，依赖 P0-3 已积累结果数据。
6. **贯穿分支**：随时可并。

**并行冲突提示**：`p0/live-score-state-machine`、`p1/temp-units`、`p2/sub-impact` 都改 `static/js/match-renderers.js`，建议串行或勤 rebase。

---

## 5. 汇总者（Claude）的收尾与检验职责

> 用户派人实现，我不写业务代码；以下是我在每个 PR / 每批的把关动作。

- **逐 PR**：跑 `/code-review`、`npm test`、用 preview 工具真机冒烟（`/health`、关键 API、目标页面行为），核对 PR 证据是否齐全，再批准合入 `release/wc2026`。
- **批次收尾**：合 `release/wc2026` 前整体回归——bundle 重建、service worker 缓存验证、Railway 部署后 `/health` 与关键 API 复检。
- **文档收尾**：核对每个「验证/增强」任务能在 [FEEDBACK_CONSOLIDATION.md](FEEDBACK_CONSOLIDATION.md) A 表对应到证据行；更新 CHANGELOG 与项目记忆。
- **介入边界**：仅在用户要求时介入；不主动推动实现，不替指派者写功能代码。
