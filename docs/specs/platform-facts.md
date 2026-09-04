# 平台事实核查 (Platform Facts)

> 状态：M0 进行中（阶段 1 数据已采集；cron 闲置分布持续采集中）
> 探针：`eruoo-server-staging`（workers.dev）+ 独立 D1（APAC 区域），代码见 `probes/m0/`
> 方法：真实 Workers 环境实测；每项数据标注采样方式与样本量。取代旧 foundation.md §23 的文档快照。

## 1. CPU 预算（颠覆性发现）

| 负载                          | 实测 cpuTime | 结果                    |
| ----------------------------- | ------------ | ----------------------- |
| 1,000 次 SHA-256              | 5ms          | ok                      |
| 50,000 次 SHA-256             | 287ms        | ok                      |
| 200,000 次 SHA-256（第 1 次） | 1243ms       | ok                      |
| 200,000 次 SHA-256（第 2 次） | 899ms        | ok                      |
| 200,000 次 SHA-256（第 3 次） | 2020ms       | **exceededCpu（被杀）** |

结论：

- 实测通过的 899/1243ms 与被终止的 2020ms 划出弹性边界；同负载三次采样（1243/899/2020ms）波动大，边界并非固定值。
- 上一轮 `get-session` cpu=46–57ms 从未触发限制，与本实测一致——旧规格「CPU 接近 Free 10ms 上限、随时可能被杀」的紧迫判断不成立，但见下方弹性机制修正。
- **已判定：账号为 Workers Free**（2026-09-04，M0 推断）。依据：探针 cpu=2020ms 触发 `exceededCpu` 终止——Paid 默认 30s（可调至 5min），2020ms 仅为其 6.7%，探针未配置 `limits.cpu_ms`，Paid 下该行为无法解释；只有 Free 的「名义 10ms + isolate 弹性」能同时解释 899/1243ms 通过与 2020ms 被杀。owner 可在 Dashboard → Billing 复核推翻此判定（若推翻，本节结论需重写）。

官方文档机制（2026-09-03 版 Limits，M0 已复核）：

- Free 名义限制仍为 **10ms/请求**；Paid 默认 30s（可调至 5min）。
- 关键条款：_"Each isolate has some built-in flexibility to allow for cases where your Worker infrequently runs over the configured limit. If your Worker starts hitting the limit consistently, its execution will be terminated."_
- 即：**实测通过的 899/1243ms 是 isolate 弹性放行，并非限制提升**；2020ms 触发终止为弹性边界。生产 get-session 46–57ms 长期存活同样是弹性放行。

对 v2 的设计影响（已按弹性机制修正）：

- **不能把弹性当预算**：若账号为 Free，流量增长或平台策略变化都可能让「持续超限」成立而触发终止。CPU 优化保留为设计目标，但不设 10ms 硬线门禁。
- `get-session` 全链路 46–57ms 在 Free 下依赖弹性存活——v2 若保持 cookieCache（命中 ~1-6ms），绝大多数请求远离红线；未命中路径在 Free 下有弹性边界风险，**这是升级 Paid（$5/月）的主要论据，owner 决策**。
- M2 性能门禁：TTFB 缓存命中 <100ms（网络层）；cpuTime 分布纳入持续监控（Workers Logs），异常告警而非硬门禁。

## 2. workerd 计时语义（工程事实）

- **`Date.now()` 在纯 CPU 计算期间不前进**（passive ticking）：200,000 次哈希循环内 `Date.now()` 差值为 0ms。测量 CPU 耗时必须依赖平台日志（cpuTimeMs）或跨 I/O 边界计时。
- 影响：v2 工程中所有「耗时测量」类代码（审计、监控）不能用 `Date.now()` 测纯计算段。

## 3. D1 查询延迟（新建 APAC 库）

| 场景                                                   | 服务端计时（查询本身） | 平台 wallTime          | 备注                                                   |
| ------------------------------------------------------ | ---------------------- | ---------------------- | ------------------------------------------------------ |
| 热查询 `SELECT 1`（部署后连续 curl ×5）                | 21–28ms                | 1.2–29ms（P99 38.6ms） | 应用计时与平台 wall 吻合                               |
| 热查询 `probe_session` 表（第 2 次起，2 样本）         | 22ms                   | —                      | 与 SELECT 1 等价，小表页缓存开销可忽略                 |
| 冷查询 `probe_session` 表（部署后首次 fetch）          | 402ms                  | —                      | isolate 冷启动为主，与 cron */5 的 450–485ms 量级吻合  |
| `*/5` cron scheduled SELECT 1（5 分钟闲置后，3 样本）  | —                      | **450–485ms**          | cpu≈2.2ms，wall 差值为 isolate 冷启动 + I/O            |
| 每小时 cron `probe_session` 表（1 小时闲置，15:00:37） | —                      | **468.7ms**            | cpu=1.6ms；与 5 分钟间隔一致 → 闲置 5min→1h 冷路径平坦 |
| 单次 fetch `/probe/d1`（CPU 测试间隙）                 | ~25ms                  | 397ms                  | 样本 1，可能 isolate 冷启动                            |

- 生产 D1（`eruoo-server`）**已确认为 APAC 区域**（wrangler d1 info 实测，2026-09-04）——与新建 staging D1 同区域，区域不是上一轮延迟问题的差异因素。
- **生产 504 的 D1 挂起（wall 30s+/cpu 1-6ms）在新 D1 上未复现**：部署后首日全部 D1 invocation wall ≤485ms。但生产挂起为间歇性（多端点同挂同恢复、持续数小时），新库观察样本仍少（约 15 次调用）——cron 持续采集积累证据，不下「新库免疫」结论。
- **生产 Worker（`eruoo-server-production`）最近 24h 复核（09-03 20:00 → 09-04 14:40 UTC）**：18 次调用全部 success，零挂起（wall 最大 1397ms）；wallP50 分布 1.7ms（cookieCache 命中）至 1397ms（重操作）；cpu 1–108ms。生产流量约 **18 次/天**（个人项目量级，Free 额度无压力）。504 时段的挂起未再现，但间歇性结论不变——修复部署（`832dc0d8`）后的观察窗口仍短。
- **数据读取通道已打通**：Cloudflare GraphQL Analytics API（wrangler OAuth token 可用）`workersInvocationsAdaptive` 数据集，按 `dimensions{datetime,status}` 分组取 `quantiles{wallTimeP50,wallTimeP99,cpuTimeP50}`。**单位为 μs**（以 exceededCpu 行 wall=2423253μs=2423ms 与 tail 实测交叉验证锁定——初读误判为 29s 挂起，系单位误读，已纠正）。
- **采集中**：闲置后首次查询（冷）分布。cron 已于 2026-09-04 14:2x UTC 切换为每小时（`0 * * * *`，版本 `a70e23da`），改进版探针（`adbcfd53`）在 scheduled 内计时并 `console.log`，15:00 UTC 起每小时输出纯 D1 查询耗时。
  - 阶段 3（时间线已定）：今晚 22:00 UTC 暂停探针 cron（部署无 triggers 版本）→ 明天 ~14:00 UTC 人工 `curl /probe/session`（约 16 小时闲置）采长闲置数据点。**注意**：M1 骨架部署会接管 staging Worker（探针退场），若 owner 在今晚前确认 M1 开工，阶段 3 改为在 M1 Worker 上临时挂探针 cron 补采或接受 1 小时间隔数据作为结论基础（冷启动地板 400–485ms 已有 4+ 独立样本支撑）。
  - 阶段 1 的 `*/5` 保温对照数据（2026-09-04 14:20/14:25/14:30 UTC 三条 cron 记录）已入上述表格。

### §3 对 M2 的设计影响（初步，M2 议程输入）

- **isolate 冷启动地板 ≈ 400–485ms**：无法通过代码消除，任何「首次请求/低频端点」的 TTFB 预期都应以此为地板而非 100ms。M2 的 `get-session TTFB < 100ms` 目标因此只对**热路径**成立；冷启动场景的合理目标是 < 600ms。
- cookieCache 的延迟价值被 M0 数据直接量化：命中路径（1–2ms cpu，免 D1）避开冷启动 + D1 两项开销；未命中路径在冷 isolate 上叠加 ~400ms 启动 + ~22ms 查询。
- v2 是否需要「预热 cron」保持 isolate 热（类似 */5 探针对 D1 的保温）→ M2 议程探讨项。

## 4. 请求额度与 cron 预算

- 探针 cron 当前为每小时（阶段 2）= 24 次/天（前期 `*/5` 阶段 288 次/天），对 Free 100k/天请求额度可忽略。
- 账号 cron 总数：生产 2 个 + 探针 1 个 = 3/5（Free 上限 5）。M7 收敛发布前需复核。

## 5. 待办（M0 剩余项）

- [x] 账号计划——已判定 Free（依据见 §1；owner 可在 Dashboard → Billing 复核推翻）。
- [x] 生产 D1 区域——已确认 APAC（2026-09-04，wrangler d1 info）。
- [~] 阶段 2 冷查询采集：15:00 UTC 首点已采（468.7ms，与 5min 间隔一致）；16:00 起继续积累（16:00 点带 console.log 纯 D1 计时）。
- [ ] 阶段 3 长闲置采集（暂停 cron，6–24 小时间隔人工触发；可在 M1 期间并行进行）。
- [x] Workers Free 官方限制复核——已确认名义 10ms + isolate 弹性条款（2026-09-03 版 Limits 文档）。

## 6. 采样环境说明

- 时间：2026-09-04 14:16 UTC 之后（探针部署于 `e490b50a`）。
- 采集方式：curl 触发 + `wrangler tail --format json`（cpuTime/wallTime/outcome 来自平台观测）；D1 服务端计时来自响应体。
- 局限：CPU 样本少（n=3 for 200k），波动大；结论按量级判断，不追求精确阈值。

## 7. 探针口径变更记录

| 时间（UTC） | 版本              | cron 查询口径                    | 备注                                                                                                                            |
| ----------- | ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 09-04 14:16 | e490b50a          | `SELECT 1`（*/5）                | 3 个数据点：wall 450–485ms / cpu ≈2.2ms                                                                                         |
| 09-04 14:2x | a70e23da→adbcfd53 | `SELECT 1`（每小时）+ 计时日志   | 15:00 起每小时一点                                                                                                              |
| 09-04 14:43 | 00b89d1c          | `probe_session` 表查询（每小时） | 表为模拟 Better Auth session 行形态（`wrangler d1 execute` 直接创建，1 行固定数据），比 SELECT 1 多含表页缓存开销；15:00 起生效 |

> `probe_session` 建表语句：`CREATE TABLE probe_session (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, data TEXT)` + 1 行固定数据（id=`probe-fixed-row`）。

## 8. 探针退场记录（M1 接管 staging，2026-09-04 15:53 UTC）

- v2 骨架（版本 `21130d07`）按 D2 决策替换 `eruoo-server-staging`，探针 cron 随之移除。
- 阶段 2 数据封存：cron 采样共 4 点（`*/5` ×3：450–485ms；每小时 ×1：468.7ms），全部录入 §3 表格；**冷路径平坦性结论（5min↔1h 一致）已有足够样本支撑**。16:00 及之后的 cron 点不再产生（可接受——结论不依赖更多点）。
- 阶段 3（6–24h 长闲置）**降级为可选项**：若 M2 期间需要，将探针以独立 Worker 临时部署补采（probes/m0 代码保留）；现有数据已支撑全部设计决策（冷启动地板 ~470ms、TTFB 冷热分流目标）。
- console.log 纯 D1 计时未能采到（16:00 点被替换抢占）——wallTime 数据（§3）已足够，无信息缺口。

### 部署工程事实（M1 实施踩坑记录）

- `@cloudflare/vite-plugin` 构建后，`wrangler deploy --env staging` 会被 `.wrangler/deploy/config.json` 劫持，**丢失 env 语义**（部署到顶层 name，误建 `eruoo-server-v2` 后已删除）。规避：`wrangler deploy --config wrangler.jsonc --env staging`（已固化到 package.json scripts）。此为旧工程 sanitize-build.ts 存在的根因（L2 之谜的一部分）。
