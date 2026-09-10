# 运维、数据保护与发布规格

> 属于 [完整架构规格](architecture.md)，状态与其一致。2026-09-09 owner 已明确免费优先、备份交由 Agent 推荐，并确认生产尚未有效使用、可以从零开始。本文采用空存储、每日备份保留 30 天，以及 GitHub Actions 单一发布平台。2026-09-10 按架构 Q8 沿用稳定资源名；具体接线状态见实施记录。

## 1. 环境与配置

一个 `wrangler.jsonc`：顶层是可运行的本地配置，`env.staging` 与 `env.production` 是明确的远端目标。非继承 bindings/vars 各环境完整声明，禁止依赖默认 target 猜测。继续锁定 `compatibility_date=2026-08-19` 与 `nodejs_compat`，升级单独验证。

| 环境       | Origin / Worker                                                                | 存储与身份                                               |
| ---------- | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| local      | `http://localhost:5173`，Vite strictPort                                       | 本地模拟 D1/R2/Workflow，本地独立 GitHub App，无定时任务 |
| staging    | `https://eruoo-server-staging.l709937065.workers.dev` / `eruoo-server-staging` | 独立验证 D1、R2、GitHub App；不引用生产凭证或数据        |
| production | `https://auth.eruoo.me` / `eruoo-server-production`                            | 新空 D1、专用私有 R2，首次绑定核验 ID；workers.dev 禁用  |

`name` 是可继承配置，不能按 bindings/vars 的规则处理。必须显式设置 `env.production.name = "eruoo-server-production"`，并保留 staging 的显式名称。当前顶层名称是 `eruoo-server-v2`；生产环境若省略 name，会派生为 `eruoo-server-v2-production`。源配置和构建后 flattened config 均须核验精确生产名称，不一致时在 migration 和部署前停止。

各环境资源名称与 ID 只由实际 `wrangler.jsonc` 维护，不在此文复制第二份可能过时的清单。资源名不随应用版本变化，环境隔离仍以实际 ID、bucket 和 Workflow 归属核验。重建初始 schema 基线时，staging 同样换用新空 D1，不能向当前已应用旧 ledger 的库重放新基线；生产资源在首次接线时创建并核验。获得针对旧库的当次从零重建授权后，可以先导出留档、再删除并按原名重建；同名不代表沿用原 UUID 或 schema。数据库初始化前暂停旧 cron，并断开旧 Cloudflare Builds；旧版认证会暂时不可用，直到新版迁移和发布完成。API export 所需 database/account ID 必须与选定绑定对应，由同一环境配置产生并核对。

### 1.1 配置输入

| 名称                                        | 所属面         | 用途与校验                                                                                           |
| ------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`、`OWNER_GITHUB_ID`             | 所有身份请求   | 固定合法 Origin、精确 owner；禁止从 Host/代理头推断                                                  |
| `DB`                                        | 身份/API/维护  | 目标 D1 binding，开发时也必须存在                                                                    |
| `ASSETS`                                    | SPA            | 同源静态资源                                                                                         |
| `CF_VERSION_METADATA`                       | 观测/备份      | 平台 version ID；不把 tag 猜成 Git SHA                                                               |
| `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`  | GitHub 登录    | 每环境独立，secret 只在平台 Secret/本地忽略文件                                                      |
| `BETTER_AUTH_SECRETS`                       | 身份与私钥     | `version:value` 列表，version 非负整数且不重复，值至少 32 字符；实际生成使用 32 随机字节以上的编码值 |
| `AUDIT_IP_HASH_SECRET`                      | 安全请求与审计 | 至少 32 UTF-8 bytes，IP HMAC 与 cursor 签名分域                                                      |
| `AUTH_RATE_LIMITER`、`API_KEY_RATE_LIMITER` | HTTP           | 不同 namespace 的原生 Workers rate limiting bindings                                                 |
| `DATABASE_BACKUP_WORKFLOW`、`BACKUPS`       | 备份           | 同环境 Workflow 与专用私有 R2 Standard                                                               |
| `CF_ACCOUNT_ID`、`D1_DATABASE_ID`           | export         | 分别与选定环境的 account_id、DB database_id 精确一致；公开标识，不是 secret                          |
| `D1_EXPORT_API_TOKEN`                       | export         | 最小所需 D1 export 权限，失败不可退回宽权限 token                                                    |

沿用既有 runtime 变量和 binding 名称，不为重设计新增兼容别名。实际生产 DB/BACKUPS 指向新建空 D1 和独立空 R2 bucket；Worker 域名、名称和无需变化的其他资源继续沿用，发布核对目标 ID。首次启用生成新的 BETTER_AUTH_SECRETS，旧 Cookie 不作为新系统登录状态。

配置按能力校验：身份配置错误阻止依赖它的动态功能；备份 token 错误只阻止备份。审计 HMAC 缺失阻止需要安全审计的身份/管理/业务操作，但 `/health`、静态错误页和 metadata 仍可达。有效配置下的单次审计写失败适用 §3 的规则。这个范围收敛替代旧“审计配置缺失导致所有动态响应失效”的做法。

不增加 `AUTH_MODE`、`USE_CACHE`、`SKIP_CHECKS`、`BOOTSTRAP_PRODUCTION` 等运行开关。CORS 空集和 owner 值是安全策略，不提供浏览器输入的覆盖路径。`VITE_*` 只能放可公开值。

### 1.2 本地运行与产物

目标 `pnpm run dev` 在启动前应用本地 migration，再以固定端口启动 Vite；无远端副作用。不复制生产数据库。本地 GitHub 凭证缺失时明确报配置错误，不能生成含 `undefined` 的 OAuth callback。测试使用合成凭证和固定 provider stub，无需真实第三方账号。

SPA assets fallback 只处理页面导航；`/api/*`、`/.well-known/*`、`/problems/*`、`/health` 由 Worker 优先处理，API 404 不返回 HTML。哈希静态资源可长期 immutable；HTML、身份响应和私有 API 禁止公共缓存。CSP、HSTS（生产）、nosniff、frame-ancestors 和 Referrer-Policy 由一个入口策略管理；动态响应由 Worker 设置响应头；直出的 SPA/静态资源由 `public/_headers` 设置对应策略。文档及 Vue/对话框需要内联 style，因此 HTML 的 style-src 允许 unsafe-inline，script-src 仍仅 self，不允许内联脚本；JSON 接口不需要该样式例外。

## 2. 限流与成本边界

以 operation ID 作为稳定 key，禁止使用任意 URL/path/query 构造无限基数的数据库桶。连接 IP 只取平台可信头；本地无可信 IP 使用测试值，不信任外部自报的 forwarded-for。

| 流量                                             | 粗入口策略                                             | 持久策略                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 已登记的交互认证与 token operation               | `AUTH_RATE_LIMITER`，每 operation + IP 10/60 秒        | Better Auth 显式设置 `rateLimit: { window: 60, max: 100 }`；插件有更严格专用规则时保留并测试 |
| `GET /api/status` 携带 x-api-key                 | 独立 `API_KEY_RATE_LIMITER`，每 operation + IP 5/60 秒 | 每 key 计数由架构规格定义                                                                    |
| get-session、静态响应、未知/禁用路径、非支持方法 | 不做数据库限流计数                                     | 无                                                                                           |
| 内部 Cron/Workflow                               | 不经过 HTTP 限流                                       | 维护任务自身的批次、重试、容量预算                                                           |

认证粗入口沿用既有生产阈值。Better Auth 持久限流则是目标变更：原审查基线的 `src/worker/auth.ts` 未设置 window/max；当前实现已显式设置 60/100 并关闭 `/get-session` 计数。锁定的 1.7.2 默认值为 `window: 10, max: 100`。目标将计数窗口统一为 60 秒，收紧持续请求的持久限流，作为 location 局部入口限制之外的保护。这不是库默认。实现保留 `enabled: true`、`storage: "database"` 和 `/get-session: false`，显式加入 window/max，并通过实际请求的阈值、窗口重置和插件专用规则测试。

限流 binding 异常或 5 秒内未返回时 503，不继续高成本认证；API Key status 在入口限流通过后只使用请求剩余的 5 秒读预算，迟到 limiter 结果不能重新启动认证；429 返回合适的 Retry-After，不追加 D1 拒绝审计。未知路径直接 404。多个 limiter 不串行检查同一个 operation。

原生 rate limiting 是 location 局部、近似限制，用于抑制常见放大，不是跨 IP/跨 location 的全球精确配额。[Cloudflare rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。

同账号相同 namespace 和 key 会跨 Worker 共享计数，因此 staging/production 的两种 limiter 必须使用四个互不相同的 namespace。实际值由 `wrangler.jsonc` 维护，生产沿用既有 namespace；不能只用 Worker 名区分环境。发布构建核对环境间隔离，阈值不因这项配置修复而改变。

成本原则为**免费优先，按需求决定是否付费**：先用当前套餐验证完整流程、资源用量和尾延迟；能满足就保持免费。若免费限制影响实际需求，比较付费方案与继续维护规避逻辑的成本，向 owner 给出实测缺口、预计月费和推荐。现阶段无需预先指定付费预算，也不自动升级。有限重试、入口限流和容量告警仍作为运行保护保留，但不再把免费额度写成不可变的架构约束。

## 3. 安全审计与清理

保留 `security_audit_events`。事件包括 GitHub/Passkey 登录、Passkey/API Key 创建/更新/删除、key 过期/拒绝、OAuth grant/reuse/撤销、敏感操作拒绝、签名 key 轮换、配置变更与恢复完成。事件名和字段沿用 OpenAPI；仅实际实现的动作产生事件，不为满足枚举虚构操作。

- 成功的普通列表/status/get-session 不逐请求记审计。429 不记拒绝审计，避免写入放大。
- 不记录 Cookie、token、原始 key、Passkey assertion、SQL、原始 IP、OAuth state 或 signed URL。IP 仅用可信来源的 HMAC 指纹；metadata 每事件显式 allowlist。
- 安全状态先在同步路径提交，审计以操作结果驱动。`waitUntil` 只可用于尽力审计，绝不托管撤销、token 签发或必须完成的数据变更。
- 审计写入瞬时失败不回滚已完成操作；输出脱敏 `audit_write_failed` 与 requestId。该设计允许少量审计丢失，不宣称审计与所有库 mutation 跨表原子。
- 查询保留 180 天，cursor 按 `(occurredAt DESC,id DESC)` 排他推进，默认 50/上限 100，绑定 type/outcome/from/to；输入变化使旧 cursor 失效，禁止 offsets 扫全表。
- 每天 04:00 Asia/Shanghai 清理，Cron 为 `0 20 * * *`。审计正常物理保留约 181 天；失败会延长物理保留，查询仍过滤到 180 天。
- 同一次清理处理过期 verification、rateLimit 行以及 [OAuth 清理边界](protocol-contract.md#45-oauth-清理边界)。每批最多 500 行、每类最多 10 批；超过批次留待下一天并记录 backlog，禁止提高定时频率隐性补偿。
- 该 Cron 不删除 Session（包括已过期行）、Passkey、用户或其他未到期凭证；Session 的正常过期处理与退出仍由 Better Auth 负责。删除 Session 会使 OAuth token 的 sessionId 按既有外键置空，不能以清理浏览器 Session 代替按 client/family 撤销应用授权。
- 条件带固定 scheduledTime，旧/重复 Cron 可幂等执行。内部清理不需要 owner Session，也不走公网 API。

不引入消息队列、事务 outbox 或全局业务事件总线；如未来需要强审计零丢失，这是不同的数据一致性需求，不能加几个重试就冒充实现。

## 4. 独立备份

### 4.1 目标与保留

推荐并采用：每天 03:00 Asia/Shanghai，Cron `0 19 * * *`；新快照保留 30 天，满期由 R2 lifecycle 删除。正常调度与导出成功时，恢复点间隔约 24 小时；任务延迟或失败时，实际可恢复点取最近有效快照，不能保证仍在 24 小时内。UI 在最近一次失败时立即提示，或在最近成功超过 26 小时时提示备份过旧。RTO 不作未经演练的小时数保证，以实际恢复记录为准。

取舍：服务当前以身份、凭证和授权状态为主，优先缩短可能丢失的近期变更窗口；没有已确认的半年历史还原需求，因此不增加“每日 + 每周 + 每月”多层保留规则。正常稳态约 30 份快照，预留到期删除延迟与重试空间；例如每份 100 MB，按 33 份估算约 3.3 GB，此估算仅含该环境的备份 bucket，不包含账号其他 R2 对象。R2 Standard 当前免费含 10 GB-month/月，但最终是否免费必须用实际 SQL 大小、操作量和账号总用量核对。[R2 pricing](https://developers.cloudflare.com/r2/pricing/)。

首次启用使用独立空 bucket，可新建，也可在完整盘点确认无对象、无其他项目引用后沿用已有专用私有桶。唯一快照前缀为 `d1/daily/`，配置一条 30 天对象删除规则；保留平台默认的未完成 multipart 清理规则，不叠加全桶删除或存储类别迁移。不导入旧快照，不实现旧前缀读取、180 天保留过渡或新旧对象迁移。新快照到期删除可能有延迟，容量检查仍需统计实际对象。[Object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)。

首次接线集中完成：确认新 D1 为空、R2 bucket 无对象且没有其他项目引用，读取已有 lifecycle 和 Worker cron，准备精确差异，经当次授权执行并读回。沿用空桶时移除旧全桶 180 天删除规则，改为 `d1/daily/` 前缀 30 天规则。数据库重建前核实旧库内容和绑定关系并保留私有导出；不迁移旧 ledger 或数据。旧 cron 在准备期间保持停用，新 cron 随正式发布启用。除此之外的旧资源清理不作为上线前置条件。

之后的常规代码发布不重做资源创建或 lifecycle 配置；只有这些配置发生变更时，才重新核对实际状态、准备差异并取得对应执行授权。未来有真实业务数据后，不得因本次从零授权缩短其既定保留期。

使用官方路径 D1 REST full SQL export → signed URL 流 → 私有 R2；不做增量备份、压缩、multipart、数据库镜像或跨账号复制。Cloudflare Secret 不在快照内，必须由 owner 的凭证管理流程另行保管；缺失解密 secret 可能使快照部分状态不可用。[官方备份示例](https://developers.cloudflare.com/workflows/examples/backup-d1/)。

Time Travel 是平台短期原地恢复能力；当前 Free 文档为 7 天、Paid 为 30 天。由于既有恢复原则要求新建隔离 D1，它不作为标准自动恢复路径，也不能替代独立快照。[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)。

### 4.2 六步流程

| 步骤       | 操作                                                                                       | 故障处理                                                     |
| ---------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 派发       | Cron 精确分派；`database-backup-v1-{scheduledTime}` 确定性 instance ID，单元素 createBatch | 创建失败使 invocation 失败；未知 Cron 只告警，不执行其他维护 |
| 取得执行权 | 首个 durable step 记录真实 startedAt，D1 原子取得 `database-backup` lease                  | 未取得则停止；不把并发拒绝覆盖为最新备份失败                 |
| 导出       | 一次 full SQL export；不指定 tables/no_data；持久保存 bookmark                             | 无法确认启动结果时不自动再启动一个 export                    |
| 等待       | 有界轮询同一 bookmark                                                                      | 截止即停止，不重新开始 export；保留上一份快照                |
| 保存       | 验证 signed URL 响应、完整盘点专用 bucket、预算检查、条件 put                              | 不覆盖已有不同对象；失败仅清理本次明确拥有的无效对象         |
| 记终态     | 对象验证成功才写 `database_backup_health=ok`，其他终态记脱敏 failure                       | 健康写入失败输出日志；不能把上传前状态当成功                 |

Cron 只做派发，长任务由 Workflow 完成。instance ID 命名保持稳定，相同 scheduledTime 的重复派发在同一 Workflow 资源内去重；v1 只是命名空间，不要求迁移旧实例。初始免费部署使用这条已定义的调用路径，不依赖付费 direct schedules；即使以后付费，也不自动更换调度架构。Free 完成实例当前保留 3 天，确定性 ID 只在平台保留期内去重，不建设永久时间槽台账。超过保留期的重新投递可能形成另一次备份。[Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/)。

### 4.3 有限预算与并发

| 边界                     | 值                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------- |
| export 启动              | 总尝试 1 次                                                                             |
| poll                     | 间隔 55 秒，最多 15 次观察，每次最多 2 次 HTTP 尝试                                     |
| export 截止              | 从 durable startedAt 起 15 分钟，先到次数/时间边界即停止                                |
| 整体上传截止             | 从 startedAt 起 30 分钟；每个上传 step timeout 15 分钟                                  |
| signed URL 获取/上传重试 | 总尝试 2 次，先检查同一 object key 是否已成功                                           |
| 外部 HTTP 预算           | 最坏 `1 + 15×2 + 2 = 33` 次；D1/R2 binding 调用另计并纳入实测                           |
| lease                    | startedAt 起 46 分钟，包含 16 分钟提交保护期；使用 ownerId 条件释放，不删除别人的 lease |
| R2 项目预算              | 总量达 8,000,000,000 bytes 告警；新总量必须严格小于 9,000,000,000 bytes                 |
| 单 SQL 对象              | 必须有规范正整数 Content-Length 且严格小于 5 GiB                                        |

`retries.limit` 配置额外重试次数：启动 export 为 0，poll 和上传为 1，分别对应总尝试 1 / 2 / 2 次。2026-09-10 staging 与锁定的原生 Workflow 引擎均确认 `limit: 1` 会执行两次；不能用把 limit 当总次数的测试替身证明预算。启动失败始终抛出默认名称的 `NonRetryableError`，禁止改写其 name，否则平台可能把它作为普通错误重试。其他永久错误同样不重试；可重试步骤最终失败后，健康记录从 Workflow RPC 的固定错误包装中仅恢复 allowlist 错误码。

以上是初始运行预算，不是平台性能承诺或永久免费上限。存储到达告警线时核算未来 30 天需求与月费，必要时请求 owner 调整预算；未批准新预算前，达到现有写入上限仍停止新增并明确报告备份失败，不隐性产生未评估的费用。所有对外 fetch 使用 `redirect:manual`，并由状态码校验直接拒绝 3xx，避免 Bearer 误转发与额外请求；当前锁定的 workerd 原生 Request 会拒绝 `redirect:error`，不能以替换 fetch 的测试证明兼容。继续校验状态码、JSON schema、bookmark 和 signed URL 的 HTTPS。signed URL 不写日志，响应流直接传给 R2.put，不整库读入 Worker 内存。

专用 bucket 只能由持有 lease 的备份 Workflow 写入。相比旧实现，正常路径只在已知 Content-Length、准备 put 时做**一次完整容量盘点**；第一次 export 前盘点删去，因为它不能替代写入前的新鲜检查。所有对象及后缀都计入，最多 10 页 × 1000 对象，超出即失败并告警，不无限扫描。达到容量边界时停止新增，不提前删除未到保留期的快照。

lease 解决重叠盘点/写入的竞争，不是可取消 R2 操作的证明。无法确认旧上传已结束时，不允许人工强制夺取租约后继续写；先停止旧实例并核实对象。平台取消/超时、停止 polling 后 export 结束的真实行为，必须在 staging 验收，不能由定时器推断。官方 export API 本轮可读，但该副作用行为未在本轮重新部署验证。

### 4.4 对象与终态

新系统只维护一种 SQL 快照格式，格式号沿用 2；Content-Type 为 `application/sql`，无 Content-Encoding。唯一 key 为 `d1/daily/YYYY/MM/DD/{timestamp}--revision-{revision}--workflow-{instanceId}.sql`；恢复器只接受该格式，不为旧快照添加兼容分支。时间为 UTC，timestamp 为 ISO 时间去掉 `-`、`:`、`.`；revision/instanceId 只保留字母数字及 `._-`，长度上限分别为 128/100，空值拒绝。

custom metadata 的字符串字段固定为：`backupFormat="2"`、`backupContents="full-database"`、`auditEvents="included"`、`credentials="included"`、`createdAt`（UTC ISO）、`exportBookmark`、`sourceRevision`、`sourceRevisionTag`、`sourceRevisionTimestamp`、`workflowInstanceId`、`contentLength`。迁移 ledger 与摘要从 SQL 内容读取/计算。该格式以旧实现的有界 export/上传逻辑为参考，按新 schema 建立合成 golden fixture；复用已验证机制不构成旧快照兼容要求。

条件 put 只创建不存在的 key；同 key 重试只在 metadata/size 均匹配时复用。实际 put 大小必须匹配 Content-Length。不同对象冲突失败，不以 overwrite 修复。恢复下载用 R2 HEAD 的单次 put ETag/大小与本地文件比对；ETag 用于字节一致性，不当作独立真实性证明。

`database_backup_health` 是最近终态的唯一 UI 来源，沿用现有表与 OpenAPI union。更新按 `(startedAt,completedAt)` 单调推进，同次失败不能覆盖已验证成功；旧实例不覆盖新实例。状态不包含 raw exception、R2 key 或下载链接。未开始/未取得 lease 的任务不虚构 attempt，D1 完全不可用时由平台日志兜底。

bucket 保持私有，禁用 r2.dev、自定义域名、浏览器 CORS 和下载 API。完整快照含认证与审计状态，访问权等同接触敏感数据库。

## 5. 恢复流程

恢复是一个人工发起的运维事务，不能由“最新备份失败”自动触发。只导入新建的 `eruoo-server-restore-*` 空 D1；禁止覆盖生产 D1。

1. **本地计划**：输入可信 R2 HEAD 描述与 SQL 文件，检查 format/size/ETag/metadata；以受限制 SQLite 执行 dump，验证 schema、外键和 migration ledger 为仓库的精确前缀。输出源快照、目标版本、清理范围、切换与回退步骤。
2. **建立目标并导入**：执行时获得明确授权，创建隔离 D1，导入完整 SQL，再应用尚未执行的向前 migration；target ID 必须不同于生产。
3. **清除可复活的安全状态**：删除 Session、verification、Passkey、API Key、OAuth token/consent/tombstone、限流、旧 JWKS、维护 lease/health 和快照内审计；保留 GitHub owner 关联但清空 provider tokens；静态 client/resource 按当前清单恢复。若存在 `deployment_migrations`，同时清除其源库记录；规划器严格验证这张运维表的 schema，不把它当作任意附加表放行。
4. **建立新信任**：向前 migration 与清理核验完成后，执行规划器输出的 `targetMigrationReceipt`，记录目标 D1 ID 与当前 migration 摘要；不能沿用源库发布记录。生成新 Ed25519/RS256 key，不保留旧公钥宽限；验证 owner bootstrap、凭证清理与业务数据，最后记录 `database_restore_completed`。
5. **切换**：停止旧生产维护任务并核实，确认没有并发导出/写入后切新 binding；owner 重新登录、注册 Passkey、创建 API Key，Desktop 重新授权。
6. **保留回退信息**：不删除原 D1；切换前可直接放弃新库。切换后如已有新写入，不能无条件切回旧库丢弃数据，需先停止写入并评估差异。

规划器无 `--execute`、默认不访问网络；目标是验证可信自有快照，不提供通用 SQL 管理台。SQLite 禁止 extension loading，authorizer 拒绝 ATTACH/外部文件、危险 PRAGMA、virtual table、trigger/view 与未知结构；schema 与 ledger 逐项校验，不能只用 SQL 文本正则判断。生产 migration 同样禁止 D1 export 不支持的 virtual table。

导入函数只允许 D1 导出文本所需的 `replace` 和 `char`，支持 CR/LF 的嵌套转义；其他函数仍拒绝。恢复测试使用实际导出器产出的字符串 fixture，不能只用手写的普通 SQL 字符串证明兼容。

正常恢复不自动轮换 BETTER_AUTH_SECRETS；怀疑 secret 泄露时另行轮换并重认证。首个生产切换前必须成功做一次隔离恢复验收；之后在备份格式、schema 或凭证清理规则改变时重跑，不增加无需求的周期演练系统。

### 5.1 Secret 轮换

BETTER_AUTH_SECRETS 轮换先加入新主版本并保留仍被 D1 密文引用的旧版本，验证旧私钥/provider token 可解密、新数据使用新版本；再部署并验证真实登录。历史实测显示旧 Cookie 不一定跨主版本切换延续，因此对 owner 明示重新登录，不承诺无感轮换。确认旧密文已迁移且旧版本无引用后才能删除旧 secret；回滚代码不等于回滚 secret。GitHub secret、export token、审计 HMAC 各自独立轮换；审计 HMAC 轮换使旧 cursor 失效并改变新 IP 指纹，不重写旧审计记录。

## 6. 发布与回滚

### 6.1 一次检查构建，一次触发发布

发布统一使用现有 GitHub Actions 平台：扩展 `.github/workflows/check.yml` 负责检查和产物，增加 `.github/workflows/deploy.yml` 负责手动发布。常规候选来自受保护的 main；重设计期间的 refactor/v2 继续用于集成，在首次正式发布前合入 main。main 保留 required check 与禁止 force push，不再创建独立 production 分支发布链，也不接入 Workers Builds。旧平台 trigger 如已存在，在启用新发布入口时一次性停用，避免同一版本被两个系统部署。

流程为：**CI 检查并构建 → owner 选择通过检查的精确 SHA 和环境 → 消费对应产物 → 必要 migration → deploy → 冒烟验证**。

1. **CI**：用 frozen lockfile 安装依赖并缓存 pnpm store，执行一次 `pnpm run check`。有发布能力的环境分别以 `CLOUDFLARE_ENV=staging|production` 构建，单次 CI 中每环境只构建一次；立即保存该环境的实际 flattened config、assets、Worker bundle、migration 和来源摘要，避免后一次构建覆盖前一份。CI 没有 Cloudflare 发布 token。
2. **选择版本**：owner 手动运行 deploy workflow，输入环境和完整 commit SHA。workflow 必须从 main 上受保护的定义执行；生产只接受 owner 的触发及重新运行，不能凭仓库写权限冒充生产授权。GitHub 原生 workflow_dispatch 提供按钮/CLI/API，不增加自建发布后台或依赖额外付费审批功能。
3. **核对产物**：确认 SHA 属于 main 历史、同仓库该 SHA 的指定 CI 成功、环境一致，验证下载产物的来源与摘要。产物保留 7 天；缺失或过期时重跑该 SHA 的 CI，不能换一个 SHA 或本地重建后声称使用原产物。发布阶段不重复全套测试或 Vite 构建。
4. **写入**：使用锁定 Wrangler 和选定环境的部署 token。检查精确 Worker name、account/D1/R2 ID、Origin、assets、必要 binding/secret 名称及已启用功能的 cron。只在存在未应用 migration 时执行迁移，随后显式 `wrangler deploy --config <产物中的实际配置路径>`。不通过 deploy 时的 `--env` 改变已构建环境，不自动创建缺失的 D1/R2；Workflow 依赖 Worker 导出的类，首次发布随代码注册配置中的定义，之后按固定名称更新。每个环境最多一个在执行的发布，不自动取消正在迁移/部署的任务。
5. **验收**：读回版本、binding 和启用的 cron；检查 health、无凭证 Session、受保护入口拒绝、API 404 非 HTML，及本次变更涉及的已启用流程。每个 HTTP 冒烟探针最多 10 秒，整组共用 60 秒预算。仅当 health 返回 200 且版本仍属于读回的已知历史部署时，在剩余预算内每秒复查 health；命中目标版本后才检查其他入口。未知/缺失版本、HTTP 错误、无效正文立即失败，超时报告目标和已知观测版本。该等待只重复只读 health 请求，不重放 migration/deploy；失败明确标记发布未通过，发生远端写入后不自动重试或继续下一版本。

迁移前，发布脚本在 D1 的 `deployment_migrations` 运维表保存唯一一行 `databaseId + migrations`（文件名到 SHA-256 的映射）。DDL 由发布模块单独维护，早于应用 migration，因此不写入 Wrangler migration ledger；备份恢复规划器从同一 DDL 校验它。首次只接受空库；没有记录且非空的库仍拒绝。既有发布补建记录只允许旧 Worker 的 DB binding ID 与目标库一致，并校验其 RELEASE_MIGRATIONS；更换 DB binding 不继承旧库凭据。记录写入或 migration/deploy 失败后不自动重试；下次人工发起必须再次验证目标 D1 ID、已有 ledger 的精确前缀，以及所有已记录 migration 的内容未变。记录涵盖可能已经执行的计划文件，不能通过修改未确认完成的文件绕过恢复检查。验证通过后仅补未应用 migration，再部署；不靠删除数据库恢复发布。

发布记录由 Actions summary 自动生成：SHA、CI run/产物、目标环境、migration 结果、平台 version/deployment ID 和冒烟结果；后续 Desktop 客户端开始交付后，涉及其契约变更时关联配套版本与联调结果。无需手工复制流水线记录或切换 GitHub 账号推动 production 分支。

按 [能力开放表](acceptance.md#52-各切片开放的能力) 核对当前版本：R1 不启用维护 cron，R2 启用每日清理，R3 首次承载真实数据前补齐备份绑定与备份 cron 并验证；R5 才启用 OAuth discovery 与客户端。该范围由发布代码实际注册的能力决定，不增加线上 feature flag 服务，也不能让部署脚本自动修复或开启缺失能力。

`pnpm run deploy:staging <完整 SHA>` 与 `pnpm run deploy:production <完整 SHA>` 只触发受保护 main 上的同一个 Actions 发布流程。流程下载匹配 CI 产物，按产物 lockfile 安装执行工具（禁用安装脚本），核验后发布，不重跑检查或构建。已移除独立远端 migration 快捷命令。首次资源接线及现有环境所需配置见 [实施记录](implementation.md#4-运行与首次发布接线)。

官方机制依据：[Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)、[GitHub 手动运行 workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)、[Actions artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data)。Vite 环境必须在构建时确定，见 [Cloudflare Vite environments](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/)。

### 6.2 时间预算与检查频率

常规变更的执行时间目标：检查和构建 3 分钟，下载产物、必要 migration、部署与冒烟 2 分钟，合计 5 分钟左右。初次运行样本见[实施记录](implementation.md#45-2026-09-10-真实登录与-workflow-边界验收)，尚未积累五次记录；目标不含 runner 排队、owner 操作等待、首次资源接线或重型专项验收。CI/发布任务各设 10 分钟上限，超时结束并报告阶段；若写入已开始，按结果未知处理，不能自动重跑。上限不是达到目标的证据。

| 检查                                                                        | 执行频率                                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| format/lint/typecheck、快速行为与契约测试、空库 migration、构建产物目标校验 | 每个候选 SHA 的 CI；生产只消费其成功产物                                |
| 版本、binding/cron 读回与有限冒烟                                           | 每次部署，覆盖本次启用或修改的能力                                      |
| 真实 GitHub/Passkey、完整 Desktop OAuth、D1 挂起/并发、相关消融             | 首次启用对应能力及认证/协议/依赖/运行时改动；使用同 SHA staging 结果    |
| 冷启动多轮采样、全量 export→隔离恢复                                        | 首次相关验收及影响性能、schema、备份/恢复的变更；普通文案/UI 发布不重复 |

必要专项失败或缺失时阻止受影响能力发布，不能为达到 5 分钟目标跳过。记录最近五次常规流程的分阶段耗时，优先消除重复安装、检查和构建；不追加并行 CI 平台、长轮询或通用 preflight 框架。首次接线集中核对 GitHub environment 的部署 token、现有 GitHub App、空 D1/独立 R2、Workflow 定义与所需 runtime secrets；这些是一次性工作。

5 分钟目标指服务端常规流水线。Desktop 构建、签名/打包和跨端联调属于首次 R5 或相关契约变更的专项准备；普通服务端文案修改不重复整套客户端交付。服务端发布只关联客户端结果，不隐式发布客户端安装包。

### 6.3 授权与回退

owner 对精确 SHA、环境和声明的 migration 触发一次发布即可，不在流程中重复确认同一操作。设计确认不自动触发线上操作；额外数据删除、secret/lifecycle 修改仍需覆盖具体动作的授权。staging 继续遵循 [既有预授权](refactoring.md#7-执行配置owner-已确认)。默认 GITHUB_TOKEN 仅赋予所需的 contents/actions 读取权限；Cloudflare 部署 token 只在目标环境的发布 job 使用，runtime 仍使用 §1.1 的 CF_ACCOUNT_ID，不把 CI 凭证暴露给 PR 测试或浏览器。

首次从空库启用没有旧业务数据迁移和差异合并步骤。旧资源暂时保留，不作为发布依赖，也不在发布失败时自动删除。开始真实使用后，普通发布仍需保证已发布 migration 不改写、新 schema 向后兼容；代码回退优先用上一成功 Worker version，涉及 Desktop 契约变更时同时核对客户端版本匹配。回退不撤销数据库写入、secret 或 lifecycle 修改，存在新数据时不能直接换回旧空库。首次正式使用前验证一次代码回退，以及将实际数据投入使用所需的备份恢复能力。

Desktop 已按 Q7 延后；以下跨端门槛在客户端启动交付后适用，不阻塞当前服务端/Web 的本地验收。后续首次启用实际 Desktop 和跨端破坏性变更，发布记录必须给出“服务端 SHA + Desktop 版本/commit + 联调结果 + 回退目标及能力影响”。先备妥配套客户端，再启用服务端能力；不要求维护旧版兼容层。首次 R5 可以回退到已验收的 R4，恢复浏览器管理并暂停 Desktop 授权，必须明确这不代表 Desktop 可用。后续回退若要求恢复 Desktop，必须有契约匹配的服务端/客户端组合，必要时切换客户端版本并重新授权；该组合未验证则阻止相应发布，不能把单端回退记为跨端已恢复。该要求复用现有发布记录，不建设协议版本协商系统。

## 7. 运行观测与故障判断

保留平台 invocation logs、Workers Logs 和 D1/R2 原生 metrics；不搭独立可观测平台。应用每次失败记录一条结构化事件：requestId、operation、status、outcome、平台 version、等待阶段、可得的 D1 meta；成功仅记录必要的性能样本。禁止完整 URL/query、凭证和原始异常正文。

| 信号                                 | 判断/动作                                                 |
| ------------------------------------ | --------------------------------------------------------- |
| get-session 200 + null               | 可证实未登录，UI 转登录                                   |
| 503/504 且 CPU 低、等待长            | 优先查 D1/外部 I/O 与调用队列；不能归为 CPU 超额          |
| exceededCpu / exceededResources      | 记录平台 outcome，检查实际套餐与当前调用预算              |
| 一个慢请求后健康请求继续快响应       | 请求隔离生效；不代表 D1 平台不会整体故障                  |
| backup failed 或最近成功超过 26 小时 | owner UI 提示；查 Workflow 与对象终态，禁止自动恢复数据库 |
| audit_write_failed                   | 原操作可能成功，调查审计缺口，不重新执行原 mutation       |
| cron 读回缺失                        | 发布未完成，修复调度配置后再记成功                        |

CPU 从平台日志取值，不能用 workerd 内纯 CPU 段的 Date.now 差推断。延迟记录样本量、地区、冷热条件及 p50/p95/max；详细通过阈值由验收规格维护。没有观测数据时标记未验证，不输出“故障已彻底消失”。
