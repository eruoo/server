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
- **待确认**：账号当前是 Workers Free 还是 Paid？whoami 不显示计划；owner 确认即可（影响结论解释与 §23 目标）。

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

| 场景                               | 服务端计时（查询本身） | 备注           |
| ---------------------------------- | ---------------------- | -------------- |
| 热查询 `SELECT 1`（连续 5 次）     | 21–28ms                | 无表、无数据   |
| 单次外部观测 wall（含网络/冷启动） | ~397ms                 | 样本 1，待扩样 |

- 生产 D1（`eruoo-server`）**已确认为 APAC 区域**（wrangler d1 info 实测，2026-09-04）——与新建 staging D1 同区域，区域不是上一轮延迟问题的差异因素。
- **待采集**：闲置后首次查询（冷）分布。当前探针 cron 为 `*/5`（保温状态），需按阶段调整 cron 间隔采集：
  - 阶段 2：改为每小时（`0 * * * *`），采 1 小时间隔冷查询。
  - 阶段 3：暂停 cron，人工间隔 6–24 小时后 curl 一次，采长闲置数据。

## 4. 请求额度与 cron 预算

- 探针 cron `*/5` = 288 次/天，对 Free 100k/天请求额度可忽略。
- 账号 cron 总数：生产 2 个 + 探针 1 个 = 3/5（Free 上限 5）。M7 收敛发布前需复核。

## 5. 待办（M0 剩余项）

- [ ] 确认账号计划（Free/Paid）——owner 确认（whoami 无计划信息）。
- [x] 生产 D1 区域——已确认 APAC（2026-09-04，wrangler d1 info）。
- [ ] 阶段 2/3 冷查询采集（调整探针 cron 后等待数据）。
- [x] Workers Free 官方限制复核——已确认名义 10ms + isolate 弹性条款（2026-09-03 版 Limits 文档）。

## 6. 采样环境说明

- 时间：2026-09-04 14:16 UTC 之后（探针部署于 `e490b50a`）。
- 采集方式：curl 触发 + `wrangler tail --format json`（cpuTime/wallTime/outcome 来自平台观测）；D1 服务端计时来自响应体。
- 局限：CPU 样本少（n=3 for 200k），波动大；结论按量级判断，不追求精确阈值。
