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
| ~~`p3/calibration-panel`~~ | P3-2 校准报告面板 —— ✅ 已完成，见下方 P3 章节说明，不再派工 |
| `p3/penalty-model` | P3-3 点球模型 |
| `p3/lineup-ci` | P3-4 阵容 CI |
| ~~`p3/backtest-expansion`~~ | P3-5 回测样本 + param-sweep —— ✅ 已完成，见下方 P3 章节说明，不再派工 |
| `p3/corner-backtest` | P3-6 角球准确率回测 |
| `fix/knockout-score-writeback` | P0-3-补 淘汰赛比分回写缺口 |
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

> **2026-07-07 更新**：P3-2/P3-5 已完成，不再是待派工项（见下方说明）。P3-3/P3-4 已实现，PR 待合并（[#5](https://github.com/ciao-zbbb/pitch-signal/pull/5)、[#6](https://github.com/ciao-zbbb/pitch-signal/pull/6)），具体规格见各自 PR 描述。P3-1 的检测 bug 已修（PR #7），但置换检验分析本身还没跑；P3-6 框架已完成（PR #4），真实数据评估还在等生产样本量。**关键前提——本地样本量不能代表生产环境**：本地 `data/predictions.db` 是开发库，判断"样本够不够"必须去生产环境核实（导出快照最安全，避免误连生产连接池）。

### P3-1 · `p3/track-b-calibration`
- **目的**：压力指数当前只展示不影响概率（[pressure-index.js:6](../lib/services/pressure-index.js:6)），须回测验证后升级。
- **现状**：数据采集端已就绪且检测 bug 已修——`detectSurge` 原本"从最新往回数、遇第一个低于阈值就 break"的严格连续计数，被压力指数逐分钟 delta 的单分钟低谷打断导致系统性漏报，生产实测长期为 **0 条** `sustained_pressure_alert`；PR #7（`fix/matches-seed-surge`）改成"最近 5 快照中至少 3 个 ≥65"的滑动窗口 + 补"期间未进球"否决，已上线，样本会开始积累。
- **方式**：从 `match_moments`（`type='sustained_pressure_alert'`）拉 alert，统计 alert 后 5/10/15 分钟进球率 vs base rate；显著才给 `live-reprice.js` lambdaRemaining 加 calibrated 系数（≤+15%）。
- **边界**：IN = 回测分析 + 通过后才实现加权；OUT = 未通过验证**不得**改概率，系数不得超过 +15%。**统计**：用置换检验/控制整体错误率，防多重比较，而非裸 p<0.05。
- **前置核实**：去生产环境核实 PR #7 上线后 `sustained_pressure_alert` 实际积累了多少条 + 对应比赛终场比分是否已回写（见下方 P0-3-补，淘汰赛比分回写目前仍有缺口，会影响这里能凑到的样本）。
- **核查**：分析报告含置换检验 p 值与效应量；加权仅在显著时启用且 ≤+15%；`npm test` 绿。
- **依赖**：P0-3（终场比分回写，注意淘汰赛缺口见 P0-3-补）、足够世界杯数据（生产环境核实）。

### ~~P3-2 · `p3/calibration-panel`~~（✅ 已完成）
- **实现**：`lib/backtest-calibration.js`（`fitPlatt()` + `buildCalibrationReport()`）读 `prediction_snapshots` JOIN `post_match_reviews` 算 Brier + 10 桶校准曲线；`GET /api/calibration-report`（`lib/routes/calibration.js`）；`scripts/test-calibration-report.js` 通过，含样本不足时 Platt 正确标记 `unavailable` 的断言。

### P3-3 · `p3/penalty-model`（✅ 已完成，PR 待合并 [#5](https://github.com/ciao-zbbb/pitch-signal/pull/5)）
详见 PR #5 描述：历史点球命中率（76 队，RSSSF）替换 `live-reprice.js:92-93` 硬编码 50/50，`test-penalty-model.js`（19 断言）通过。

### P3-4 · `p3/lineup-ci`（✅ 已完成，PR 待合并 [#6](https://github.com/ciao-zbbb/pitch-signal/pull/6)）
详见 PR #6 描述：`PredictionService.predictMatch()` 接入 `lineups-source.js` 的 `getLineups()` 判定首发是否公布，驱动 `lineupUncertainty`，`test-lineup-ci.js`（8 断言）通过。

### ~~P3-5 · `p3/backtest-expansion`~~（✅ 已完成，路径与原计划不同）
原计划是"混入 Euro/Copa 到 300+ 场"；实际做法是全量 1930-2022 世界杯正赛 964 场 + martj42 49k 场用于 Elo 热启动，详见 [REMAINING_FEATURES_PLAN.md](REMAINING_FEATURES_PLAN.md) P3-5 行与 [prediction-methodology-review.md](prediction-methodology-review.md)。

### P3-6 · `p3/corner-backtest`（🟡 框架已完成，PR 待合并 [#4](https://github.com/ciao-zbbb/pitch-signal/pull/4)，真实评估待样本量）
- **现状**：`lib/corner-model.js` 已把角球预测公式提取为独立模块（纯提取，公式未变）；`scripts/test-corner-backtest.js` 五段评估（单元/真实DB只读/合成/敏感度/边界）框架已完成，合成数据 MAE 1.90 < 2.0 目标，但这只是框架自检，不代表真实预测准确率。
- **前置核实**：生产环境 `match_live_stats` 表已有多少场 `home_corners`/`away_corners` 是非零真实终场值（本地库不能代表）——达到 20-48 场再跑真实评估、据此调风格系数。
- **依赖**：足够已结束比赛（生产环境核实）。

---

### P0-3-补 · `fix/knockout-score-writeback`（待派工，新发现的缺口）
- **目的**：`score-writeback.js`（P0-3）的机制本身没问题，但 2026-07-06/07 核实发现两层缺口：① `matches` 表播种函数 `seedRealGroups()`（[db.js:540](../lib/db.js:540)）一直未被调用，生产库该表长期为空——已由 PR #7 修复（启动时幂等补种）。② `seedRealGroups()` 只播种 12 个小组 **72 场小组赛**，`writebackMatchScore()` 是纯 UPDATE 语义（[score-writeback.js:99-104](../lib/services/score-writeback.js:99) 查不到行直接返回 `match_not_found`，不插入），**淘汰赛阶段的比赛没有任何机制往 `matches` 表插入对应行，回写会持续静默失败**——决赛 7-19，这个缺口现在每天都在发生。
- **推荐方案**：不新增"淘汰赛播种 job"，改为让 `writebackMatchScore()` 在查不到匹配行时走 upsert（用已验证过的 `resolveTeamToRatingsId()` 结果直接 `INSERT`，`group_id=NULL`、`played=1`、真实终场比分），理由：不用额外维护"何时该播种哪场淘汰赛"的调度逻辑，且顺带解决"淘汰赛历史场次数据缺失"——重新跑一遍 `scripts/sync_completed_matches.js`（带够大的 `daysBack`）即可回填。如果实现者认为反过来（提前从 bracket JSON 播种赛程）更合适，需要先跟需求方确认，两条路径都可行但影响别处怎么查这张表。
- **边界**：IN = upsert 逻辑 + `stage` 透传 + 回归测试；OUT = 不改小组赛现有 UPDATE 路径行为（`test-score-writeback.js` 现有用例必须照旧全绿）、不新建播种 job、不改 `resolveTeamToRatingsId()`。
- **前置核实**：① `lib/jobs/moment-sync.js:224` 调用 `writebackMatchScore()` 时 `m`/`fifaMatch` 有没有现成的轮次/阶段字段可透传，不确定就先打印真实淘汰赛数据看结构。② `group_id=NULL` 插入在 `foreign_keys=ON` 下是否真的不报错（NULL 天然豁免 FK 检查，但要跑一次真实验证）。③ 新增的 `(group_id, match_number)` 唯一索引（PR #7）对多行 `group_id=NULL` 是否冲突（SQLite 唯一索引里 NULL 互不冲突，允许多行，但要写测试验证不要假设）。
- **核查**：新增回归测试验证"两支从未在 `matches` 表出现过的球队"的淘汰赛终场比分调用能成功插入新行；同一场重复回写幂等不重复插入；现有 `test-score-writeback.js`（6 用例）保持全绿；手动验证一场已结束的真实淘汰赛比赛，确认插入后 `matches` 表里 `stage` 字段有意义。
- **依赖**：建议先合并 PR #7，避免同时改 `lib/db.js`/`score-writeback.js` 邻近逻辑造成不必要冲突。

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
