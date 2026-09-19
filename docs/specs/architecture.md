# eruoo-server 完整架构规格

> 2026-09-09 · 当前架构规格；本次实施范围为服务端与 Web。
> 原设计审查基线：`e58f75866a9649d6ab40f39f99029f3b1c948c18`，`refactor/v2`。
> 代码、测试和本地验证记录见 [implementation.md](implementation.md)。Desktop 客户端暂缓；Cloudflare 准备进度与未完成的平台验收由实施记录维护。

## 1. 决策与文档边界

采用**单包、同源、模块化单体**：一个 Worker 提供认证、OAuth Provider、管理 API 和 SPA；D1 保存持久状态，R2 保存独立备份，Workflow 执行备份。通过减少跨请求可变状态、重复身份读取和重复刷新解决复杂度，不重写认证协议。

最小可行路径是修复现有 M2 的请求隔离和入口，再按完整流程增加功能。继续使用已确认的 Workers、Hono、Better Auth、D1、R2、Workflows、Vue、Vite；Drizzle 仅用于应用拥有的表，不再包裹 Better Auth 的原生 D1 adapter。当前锁定的 Better Auth 是 1.7.2；新增插件是独立的 `@better-auth/*` 包，包名、目标版本和验证状态由 [协议规格 §5](protocol-contract.md#5-契约维护与依赖依据) 维护，不顺带升级核心。

### 1.1 唯一维护位置

| 文档                                         | 负责的事实                                                 |
| -------------------------------------------- | ---------------------------------------------------------- |
| 本文                                         | 产品范围、模块职责、Session、API Key、管理界面、数据所有权 |
| [protocol-contract.md](protocol-contract.md) | OAuth/OIDC、HTTP 路由、凭证载体和错误语义                  |
| [operations.md](operations.md)               | 配置、审计、备份恢复、发布与运行观测                       |
| [acceptance.md](acceptance.md)               | 已有实验证据、行为验收、消融门槛、实施顺序                 |
| [platform-facts.md](platform-facts.md)       | 历史平台实测；不能把采样结论扩展成平台保证                 |
| [../openapi.json](../openapi.json)           | 由路由 schema 生成的五个自有 API 契约                      |

这四份规格共同维护目标设计；具体实现及验证状态由 implementation.md 维护，不从要求文字推断验收通过。owner 的最新需求优先于历史确认；尚未被新指令替代的条款继续有效。下表和 §1.2 明确记录覆盖关系，不允许实施者自行拼接新旧要求。旧规格保留历史价值，当前目标只在这四份规格维护；外部执行仍遵循适用授权。

| 与旧记录的差异                                                    | 处理                                                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `refactoring.md` §1 原要求“不预写完整规格”                        | 用户本轮明确要求完整架构和 spec，故改为先写完整目标；仍逐步实现、实测                                                                      |
| `m2-auth.md` 把 Passkey 断言列为通用 API 凭证                     | 纠正分类：Passkey 是登录/重认证方式；API 载体为 Session、Bearer、API Key，按凭证的实际用途区分                                             |
| M2 的 30 天固定 Session 与到期必须 GitHub 登录                    | 按 Q3 改为原生滚动续期；持久会话到期后可用 Passkey 或 GitHub 登录，敏感操作仍独立要求最近强认证                                            |
| 旧 roadmap 仍有 CPU < 10ms 硬门槛                                 | 依 M2 确认及平台实测，改为记录 CPU 分布与资源终止；不依赖 Free 弹性作为预算                                                                |
| 旧运行时 resource seed 与 migration 同时维护数据                  | 静态定义经 migration 生效，取消请求初始化时的 seed；缺失配置在部署验证中暴露                                                               |
| 旧按插件自动刷新再加 barrier/fallback                             | 每个列表只有一个刷新责任方，不保留自动与手工竞争的两条链                                                                                   |
| 旧备份和运行预算以免费额度为硬约束                                | 按 Q1 改为免费优先；确有需求时评估付费，实际支出仍需具体授权，见 [运维规格 §2](operations.md#2-限流与成本边界)                             |
| 旧每周备份、快照保留 180 天与新旧快照过渡                         | 按 Q2/Q4 使用全新备份空间、每日备份保留 30 天；不导入旧快照或维护旧格式读取分支，见 [运维规格 §4.1](operations.md#41-目标与保留)           |
| 旧 Better Auth 持久限流沿用库默认时间窗口                         | 目标显式收紧窗口，约束持续请求；认证粗入口保留既有阈值。目标配置、与当前默认值的区别及理由见 [运维规格 §2](operations.md#2-限流与成本边界) |
| 旧要求保留生产数据、凭证与 migration ledger                       | owner 明确生产尚未有效使用、允许从零开始；首次启用用新空 D1 和当前所需 schema，不做旧数据迁移                                              |
| 旧 production 分支 + Workers Builds，且全套能力齐备后才能替换生产 | 按 Q5 收敛为 GitHub Actions 检查产物与一次手动触发发布；按已验收能力启用，不再维持双平台发布链或历史功能兼容切换阶段                       |
| 旧要求已分发 Desktop 无需改动即可使用新服务端                     | 按 Q6 允许服务端与 Desktop 同步改版，取消旧客户端兼容门槛；以当前契约和配套新版客户端验收，协议安全要求继续保留                            |

外部操作的权限仍来自 [refactoring.md §7](refactoring.md#7-执行配置owner-已确认) 与 [redesign-norms.md §27 条目](redesign-norms.md#逐节盘点foundationmd-29-节)。本规格本身不授予外部写入权限；每次实际执行的范围和结果由实施记录维护。

### 1.2 已收敛的需求选择（更新至 2026-09-10）

| ID  | owner 输入                                               | 设计结论                                                                                                                                                       |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | 不坚持免费硬约束；免费额度能满足需求时优先免费           | 免费优先，以功能、稳定性和维护成本选择；不为省少量费用增加复杂架构。实际需要付费时提供实测缺口、方案与月费估算，不把本次回答视为任意金额的支出授权             |
| Q2  | 备份交由 Agent 推荐                                      | 采用每日全量备份、保留 30 天；具体时间、恢复目标和预算由 operations.md §4 维护                                                                                 |
| Q3  | 希望登录后能够无感刷新有效时间                           | 推荐并纳入目标：30 天滚动有效期、24 小时持久续期间隔；15 分钟敏感操作重认证窗口不随续期延长                                                                    |
| Q4  | 生产没有有效使用，历史数据不用担心，可以完全从零开始     | 使用新空 D1 和独立新 R2 bucket，不迁移旧数据、Session、凭证或备份；正式使用前可以重建 schema 基线，开始真实使用后恢复增量迁移纪律                              |
| Q5  | 发布简单、用时短，同时保留必要检查                       | 一个 CI 检查与构建流程、一个手动发布流程，消费已通过检查的产物；常规检查构建与发布执行时间合计目标 5 分钟，重型验证按变更触发                                  |
| Q6  | 允许 Desktop 同步改版、放弃旧版本接口兼容                | 服务端与新版 Desktop 使用同一份当前契约；不维护旧版兼容路由、双响应格式或旧凭证迁移，具体变更与客户端在 R5 同步验收                                            |
| Q7  | desktop 端暂时不做，先做 web                             | 本次交付服务端与 Web 管理；OAuth 服务端用真实插件的协议测试验收。Desktop 客户端、Rust 安全存储和跨端联调留待后续，不阻塞本次本地实现。                         |
| Q8  | 沿用原名，检查并处理 Cloudflare 现有资源，再更新项目配置 | 资源名称与代码版本分离；可按当次从零授权重建同名空 D1，沿用已确认空且专用的 R2，环境之间保持隔离。覆盖 Q4 对 R2 必须新建的要求；新版代码仍经正式发布流程上线。 |

单一 owner、同源边界和 15 分钟敏感操作门禁保持不变。Q1–Q8 已收敛，没有阻塞当前设计的需求待确认项；Desktop 暂缓，旧版本兼容不再是验收条件；Q7 覆盖 Q6 的本次跨端交付要求。当前协议规格仍是明确的实现目标，不因允许破坏兼容而随意改名或放宽安全校验。完整插件组合、D1 故障隔离、备份恢复和发布耗时由工程验收验证。新空库是启动方案；旧资源清理按具体对象与当次执行授权处理。Q8 的资源准备不构成正式发布授权，也不允许今后再次清空已投入使用的数据。

## 2. 产品范围与完成标准

架构覆盖三个用途（本次不实现 Desktop 客户端）：owner 通过浏览器管理身份和长期凭证；Tauri Desktop 经系统浏览器完成 OAuth/OIDC；CLI/自动化通过 API Key 调用明确开放的业务 operation。

- 唯一 owner：GitHub numeric ID `50254496`。用户名、邮箱和前端声称的身份均不能授予权限。
- 生产 Origin 与 issuer：`https://auth.eruoo.me`；Passkey RP ID：`auth.eruoo.me`。生产 `workers.dev` 禁用，同源 CORS allowlist 为空。
- 首期管理能力：登录/退出、Passkey 创建/命名/删除、API Key 创建/查看/命名/撤销、已授权应用查看/撤销、审计查询、备份状态、私有 API 文档。
- 首期业务 operation 只有 `GET /api/status`。预留的 `api:write` scope 不意味着新增一个无需求的写接口。
- 不做多用户、公开注册、组织/角色后台、密码/邮箱/OTP 登录、动态 OAuth client 管理、每设备授权管理、通用任务系统、微服务或新缓存服务。
- 首次启用从新空库开始，保留既有生产域名与 owner 身份；服务端与配套新版 Desktop 使用当前契约。无需导入旧数据、沿用旧凭证或兼容旧客户端/备份；开始真实使用后的数据保护与灾难恢复仍须完整执行。

完成意味着：正常流程可用，依赖故障能结束等待并说明状态，删除关键保障会让对应行为测试失败；模块数或代码行数本身不作为质量指标。

## 3. 部署与模块

```text
浏览器管理 SPA ── 同源 Cookie ──────────┐
Desktop 系统浏览器 ── OAuth 授权 ───────┤
Desktop Rust ── token / refresh ────────┤
CLI ── x-api-key ──────────────────────┤
                                      ▼
                     Worker：路由 → 认证/授权 → 业务处理
                       │          │              │
                       │          └─ Better Auth ┼── D1
                       └─ Static Assets          └── 审计

                     Cron ── 清理（直接调用）
                       └── Backup Workflow ── D1 export API ── 私有 R2
```

采用单 package；目录是职责边界，不是独立发布单元。目标实现会涉及超过 8 个文件，但不增加独立服务、运行账号或第二套构建系统。

| 目标目录/文件                                      | 唯一职责                                                     | 不承担                       |
| -------------------------------------------------- | ------------------------------------------------------------ | ---------------------------- |
| `src/worker/index.ts`                              | 导出 fetch、scheduled 与 Workflow entrypoint                 | 业务规则                     |
| `src/worker/index.ts`                              | 同入口装配路由、安全响应头和错误出口                         | Session 状态机               |
| `src/worker/auth/`                                 | Better Auth 配置、请求实例、owner Session 解析、API Key 验证 | 手写 OAuth 签发、前端状态    |
| `src/worker/oauth/`                                | 静态 client/resource 定义、协议约束、JWT 验证、family 撤销   | 通用用户/角色系统            |
| `src/worker/routes/`                               | 五个自有 operation 的 schema、权限声明和 handler             | 到处重复读取 Session         |
| `src/worker/audit.ts`、`modules/audit/`            | 安全事件写入、查询、脱敏                                     | 通用事件总线                 |
| `src/worker/schedules.ts`、`backup/`、`workflows/` | 清理、备份 Workflow、备份终态                                | 通过公网 API 回调本 Worker   |
| `src/worker/db/`                                   | 应用表与参数化领域查询                                       | 复制认证库 schema 和 CRUD    |
| `src/shared/`                                      | 自有 API 的输入/输出 schema 与推导类型                       | 环境绑定、secret、数据库模块 |
| `src/client/`                                      | Vue 路由、一个 Session 控制器、按功能组织的页面              | 服务端权限判定               |
| `scripts/`                                         | 本地契约生成、构建产物核验、发布和恢复入口                   | 运行时自修复、通用部署平台   |

依赖只能从入口流向功能模块，再流向认证/数据边界。共享目录不导入 worker/client。Cron 直接调用清理函数；Workflow 不模拟 HTTP 用户，不使用 API Key。只在真实复用时提取函数，不为每个查询机械增加 repository/service/controller 三层。

## 4. 认证与授权

### 4.1 一个事实源，两种读取强度

Better Auth 是 Session Cookie、JWE、登录 ceremony 和持久 Session 的唯一实现。应用只添加 owner 与 recent-auth 策略，不生成第二套 Session token，不自行解密 cookie 来绕过库。

| 策略              | 固定值或行为                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Session 有效期    | 30 天滚动有效期；成功续期后从该时刻计算，到期仍须重新登录                                                              |
| 持久续期          | Better Auth 原生 `expiresIn=2592000`、`updateAge=86400`、`disableSessionRefresh=false`；正常请求按 24 小时间隔节流更新 |
| Cookie cache      | 原生 JWE，30 秒，`refreshCache` 关闭；不能超过持久 Session 到期时间                                                    |
| Cookie 属性       | 生产 Secure、HttpOnly、SameSite=Lax、host-only；前缀沿用 `eruoo`；本地 HTTP 使用库的开发策略                           |
| 敏感操作          | 当前持久 Session 中 `0 ≤ now - reauthenticatedAt ≤ 15 分钟`                                                            |
| 普通身份展示      | 允许原生缓存；缓存到期后必须查 D1                                                                                      |
| 管理读取          | 允许缓存承担 Session 查找；请求内完成一次 owner account 关联验证                                                       |
| 长期凭证 mutation | 绕过 Cookie cache 读取持久 Session，验证 owner 与 recent-auth                                                          |
| OAuth 授权码签发  | 绕过缓存验证持久 owner Session；不额外要求每次授权都重认证                                                             |

撤销在 D1 提交后，**新开始的强校验**必须拒绝；已通过检查的在途操作不能被追溯取消。普通缓存读取存在最多 30 秒的旧状态窗口。长期 token 的撤销窗口另见协议规格，不混为一种“即时注销”。

续期只在仍有效的 Session 经过库的持久读取并达到 updateAge 时发生，更新 expiresAt/updatedAt 并透传新的 Cookie；不更新 createdAt 或 reauthenticatedAt。JWE 命中仍保持零 D1 I/O，`cookieCache.refreshCache=false`，不靠不断刷新缓存延长信任，也不增加续期 endpoint、定时心跳或 GET→POST 续期链（`deferSessionRefresh=false`）。顺序请求通常每天才需要一次续期写入；并发到达阈值可发生等价重复更新，不增加全局锁追求严格一次。

这意味着持续正常使用可以长期保持登录，无额外绝对到期上限；停止使用后按最后一次持久续期计算到期时间，24 小时节流使它并非从最后一个请求精确计时 30 天。被窃取的有效 Cookie 也可能被持续续期，直到撤销或失效；因此敏感操作的 recent-auth 始终查持久状态并验证独立强认证时间。不能用普通请求或后台轮询重置该时间。[Better Auth Session 机制](https://better-auth.com/docs/concepts/session-management)。

### 4.2 请求级 Auth 生命周期

每个 HTTP 请求惰性创建一个完整 Better Auth 实例，绑定本请求的 D1 adapter；同一请求内复用。删除当前跨请求 `getInitializedAuth` 与 `initialized-instance-cache.ts`。不缓存进行中的初始化 Promise、Kysely 连接、事务或请求结果。

允许跨请求保存的只有纯静态 schema/策略及已完成、限量、有到期时间的公钥缓存。每次实例构造不执行 migration、resource seed、深度健康检查或预热请求。OAuth resource/client 在部署前由 migration 登记；Provider 不配置用于初始化写入的 `resources` seed，显式开启 client-resource 关联校验，从 D1 读取已登记 policy。

选择原因：本轮真实 workerd 探针证明，共享原生 D1 adapter 的客户端连接互斥会把一次挂起传给后续请求；请求隔离能消除这条放大链。它不能消除 D1 服务端排队，也不保证所有库模块都天然无共享状态。新增插件必须继续通过隔离、无初始化 D1 I/O 和缓存命中测试，失败时修正具体适配点，不能恢复共享 pending 对象。

官方 Provider 的初始化会调用 resource seed；种子输入为空时跳过该操作。这是将 seed 移至 migration 的具体依据，不以“幂等”推断“无 I/O”。[Better Auth 1.7.2 Provider](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.2/packages/oauth-provider/src/oauth.ts)、[resource 实现](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.2/packages/oauth-provider/src/resources.ts)。

签名密钥通过 JWT 插件公开的 `createJwk` adapter 持久化：库先完成私钥加密，D1 在同一 batch 中按算法执行条件插入并读取赢家；已有未到期 key 时复用，过期轮换保留旧公钥宽限。仅插入成功者记录轮换审计。该机制覆盖跨实例竞争，不共享请求 Promise，也不提高公钥缓存数量上限。[D1 batch 事务语义](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)。

### 4.3 owner 与凭证边界

- GitHub 回调在真实 provider profile 上验证 numeric ID，覆盖首次创建与已有账户再次登录。不能只测试一个独立 helper。
- Passkey 只能为已通过 owner 校验的账户注册；登录使用库验证的 credential→user 关系，再验证其 owner account 关联。不可把注册准入放到客户端。
- 通用 API 先检查凭证载体是否唯一，再验证该载体，最后执行路由权限。禁止 Session 失败后试 API Key、Bearer 失败后试 Cookie。
- 验证结果采用按载体区分的主体：Session 带 userId/sessionId；OAuth 带 subject/clientId/scopes/resource；API Key 带 ownerId/keyId/permissions。仅在请求内使用，不持久化一个重复的 Principal 表。
- `requireOwnerSession` 与 `requireRecentOwnerSession` 是两个具体操作，共用一个读取实现。路由提前选择读取强度；强结果可满足同请求的普通读取，弱结果不可冒充强结果。
- 库读取产生的多条 Set-Cookie 必须完整透传；更新/清理缓存不能只发生在服务端内存。复用应用守卫的结果不允许跳过库内部维持事务一致性所需的验证，也不修改库的私有上下文来强行减少查询。
- 权限通过同一份路由声明维护；handler 仍在查询中限定资源 owner。业务层不接收原始 Cookie/token。
- D1/加密/网络异常表示无法判定身份，不能转成“未登录”。只有已证实缺失、过期、失效的凭证才进入相应 401/null 分支。

### 4.4 登录、重认证和退出

| 流程            | 顺序                                                                                    | 失败与恢复                                                                |
| --------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 首次登录        | GitHub → 校验 owner → 库创建 user/account/Session → 管理首页 → 注册 Passkey             | 非 owner 不创建有效 Session；不需要临时开放注册或第二次部署               |
| 日常登录        | Passkey challenge → 用户验证 → 服务端校验 → Session → 原目的页                          | 用户取消保留登录页；GitHub 可恢复                                         |
| 重认证          | 暂存操作意图 → Passkey/GitHub → 确认当前新 Cookie 对应的持久 Session → 重新显示确认操作 | 不自动重放创建/删除；失败保留表单和稳定提示                               |
| 退出            | 库撤销当前 Session → 清 Cookie → 清客户端内存 → 登录页                                  | 网络结果不明显示“未确认退出”，允许重试；不宣称其他设备或 Desktop 全部退出 |
| GitHub 失败回跳 | 固定同源 `/login`，仅映射已知错误码                                                     | 不展示原始 error_description；错误页不依赖 D1 或 get-session 成功         |

`reauthenticatedAt` 仅由成功的强认证 ceremony 写入，客户端输入无效。库可能创建新 Session；后续检查必须使用新 Cookie，不能固定更新旧 Session ID。通过的普通页面读取不延长重认证窗口。

允许 owner 在重认证后删除最后一把 Passkey，确认界面说明后续需用 GitHub 恢复。Passkey 命名只改变显示资料；API Key 更新只开放名称，不接受 owner、权限、哈希、计数或无限期限等字段。

### 4.5 API Key

使用独立的 `@better-auth/api-key` 插件，`enableSessionForAPIKeys=false`，只有 `x-api-key` 入口。哈希存 D1，原始值仅在创建响应返回一次。

| 项       | 规则                                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用途     | 一把 key 对应一个脚本/调用方；不用于登录、内部 Cron 或凭证管理                                                                                                                                                                        |
| 期限     | 默认 180 天，最长 365 天，禁止永久 key；SPA 默认创建 180 天                                                                                                                                                                           |
| 权限     | 首期服务端固定 `status:read`（default 档）与 `ai: [invoke, models:read]`（ai 档，2026-09-19 开放）；HTTP 不接受 permissions，禁止 wildcard；ai 档的模型许可由服务端按 `modelIds` 构造，default 档不开放权限更新                       |
| 限流     | 每把 key 60/60 秒，同步凭证计数；入口粗限流见运维规格                                                                                                                                                                                 |
| 到期提示 | 剩余有效期在 (0, 14 天] 且最终为 2xx 时，返回 UTC RFC3339 `API-Key-Expires-At`                                                                                                                                                        |
| mutation | 创建、命名更新、撤销均要求 recent owner Session；不能通过 key 管理另一把 key                                                                                                                                                          |
| 网关     | 应用网关校验 owner/recent-auth、Origin、凭证载体、字段与配置档后调用插件服务端 API；`create`/`update` 不携带浏览器 headers/request，`userId` 只取已验证 owner；`list`/`get`/`delete` 保留插件 Session 校验                            |
| 配置档   | 开放 default（`purpose` 省略或 `status`）与 ai（`purpose: ai` + 必填 `modelIds`，2026-09-19 开放）；`configId` 缺省显式补 `default`，未知值拒绝；`create` 不接受 `configId`；`get` 的 `keyId` 映射插件 query `id`；key 不能切换配置档 |
| 删除重试 | 以资源归属校验后的不存在作为幂等完成；跨 owner 或跨档现存资源拒绝；归属预查后发生并发撤销且确认资源确实不存在时同样幂等完成，不能借此忽略身份失败或依赖异常                                                                           |
| 网关限流 | 五个管理 operation 由网关按已登记 operation 与可信 IP 消费 100/60 秒持久桶，与原生 handler 共享桶键；429 带 Retry-After，不写拒绝审计，计数依赖异常返回 503                                                                           |
| 歧义输入 | mutation 原始 JSON 的顶层重复字段（含转义后同名）与重复 query 参数按 400 拒绝，不执行 Key 变更                                                                                                                                        |

依赖失败必须抛出可区分的服务错误，不允许插件把数据库异常吞成 invalid key。旧 patch 只在目标版本的对应行为测试仍失败时移植；不把整个旧补丁集默认带回。

## 5. HTTP 等待与失败

按 operation 是否可能写入分类，不用“GET 都安全”或宽泛 path prefix 推断。

| operation                                                           | 应用侧规则                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Session 探测、管理列表、自有业务读、JWKS 读                         | 服务端等待预算 5 秒，预算包括身份读取；到期返回 504                         |
| `/health`、静态登录错误页、未知路径拒绝、静态 metadata              | 不进入 Auth/D1；直接完成                                                    |
| GitHub callback、授权、Passkey challenge/验证、token、凭证 mutation | 不用 Promise.race 包住整个 handler；不能声称超时已取消持久变更              |
| 可取消出站 GitHub HTTP                                              | 每次请求 10 秒，合并库 signal 与 deadline，覆盖响应体读取；超时回稳定错误页 |
| SPA Session/普通 API 请求                                           | 10 秒客户端 deadline；不进行隐式自动重试                                    |
| SPA 凭证 mutation 请求                                              | 30 秒客户端 deadline；超时结果未知，先读取列表或重新登录核实                |
| WebAuthn 用户交互                                                   | 120 秒 ceremony 建议超时；用户可主动取消；不套普通 HTTP 10 秒时限           |

5 秒表示停止向用户等待，不表示底层 D1 请求已取消。get-session 可能包含库的节流续期和过期清理；续期超时可以出现 D1 到期时间已经延长、浏览器尚未收到新 Cookie 的结果，不把它解释为新登录或强认证。迟到响应不得写回已经返回的 HTTP 请求，且不能持有跨请求锁；后续按库的持久状态处理，不补发后台续期请求。读失败不用 stale-cache 无限续命；用户可以显式重试。

客户端 fetch 必须合并调用方 AbortSignal 与 deadline，并覆盖读取/解析响应体。旧库“已有 signal 时 timeout 不生效”的回归必须有测试。一次 mutation 不自动重试：API Key 创建丢失响应时只能看到记录，无法找回原始 key，应撤销后重新创建。

## 6. 管理 SPA

Vue 3 + `<script setup lang="ts">` + Vue Router。一个 Session 控制器管理 Better Auth 客户端结果；页面不各自维护 isLoggedIn，不引入 Pinia 或第二套查询缓存。使用现有 theme token、Reka UI 可访问原语和同源字体；仅保留实际使用的组件。

管理界面采用 `@ayingott/theme` 的 brutal 风格：默认主题后导入 `brutal.css`，`<html>` 始终保留 `.brutal`，深色时在同一根元素追加 `.dark`，分别对应 Neo Light / Neo Dark。组件的颜色、边框宽度、圆角、阴影与焦点使用主题公共角色；危险操作的 hover/active 和弹窗遮罩由应用映射。按钮与顶部导航统一使用包内 `pressable` 交互，当前页导航通过强调色持续标识；保留禁用、减少动态效果和强制颜色模式支持。Scalar API 文档使用同一主题状态，通过应用样式映射其变量，不显示独立主题开关。

账号信息与退出登录位于右上角账号菜单，不占用一级导航；相邻的单个外观按钮按浅色 → 深色 → 跟随系统循环切换，图标表示当前偏好，悬停提示与可访问名称同时说明当前偏好和下一次切换目标。页脚提供备份状态入口，打开弹窗时读取状态，支持刷新，关闭时取消未完成的读取。账号与备份入口仅在有 Session 数据时显示，受现有 Session 状态约束；外观按钮无需登录即可使用。旧 `/account` 链接重定向到 Passkey 管理页。

### 6.1 页面与职责

| 页面/组件               | 负责                                               | 数据交互                                      |
| ----------------------- | -------------------------------------------------- | --------------------------------------------- |
| `/login` / LoginView    | Passkey、GitHub、失败提示、签名 OAuth continuation | 调用 Session 控制器；登录成功续接原流程       |
| ManagementLayout        | Session 门禁、导航、备份状态入口                   | 向下提供身份和重认证操作，不读取功能列表      |
| `/security/passkeys`    | Passkey 列表与创建/命名/删除                       | 一个功能控制器 owns list + mutation + refresh |
| `/security/api-keys`    | key 列表、创建后一次性展示、撤销                   | 原始 key 只存在页面内存                       |
| `/oauth/authorizations` | 客户端授权状态及撤销                               | 显示 access token 撤销延迟                    |
| `/security/audit-log`   | 条件筛选与 cursor 分页                             | 条件变化丢弃旧 cursor/旧请求结果              |
| `/oauth/consent`        | 库要求的授权续接                                   | 只处理服务端签名 continuation                 |
| `/api/docs`             | 私有 Scalar 文档                                   | owner Session；不存 token、不启用在线试请求   |

页面按 [验收规格 §5.2](acceptance.md#52-各切片开放的能力) 随功能开放。R1 的根路由 `/` 提供最小账号状态与退出操作；R2 起重定向 Passkey 管理，不能在 R1 跳向尚不存在的页面。未登录访问受保护页面时进入登录流程，未启用页面返回明确的未开放/404 状态，不能靠隐藏导航代替关闭路由。Web/Mobile 在授权状态中保留“未启用”说明，不呈现可启用/可撤销按钮。页面容器负责请求，表单/列表接受 typed props 并 emit 操作意图；不在多层组件重复请求。

### 6.2 Session 状态

| 状态                  | UI 与请求行为                                                               |
| --------------------- | --------------------------------------------------------------------------- |
| 初次 checking         | 登录状态尚未确认；不挂载受保护面板、不发 owner API                          |
| authenticated         | 挂载面板；每个功能只加载一次自己的数据                                      |
| anonymous             | 清敏感内存并显示登录入口；来自明确的 Session 空结果或可信的凭证失效响应     |
| unavailable           | 显示服务暂不可用与重试；不跳转 GitHub、不清掉表单来伪装注销                 |
| 已登录后的 refreshing | 保留已挂载表单和一次性 key，冻结操作；结果成功后恢复，明确 anonymous 才清理 |

管理请求收到明确的 `authentication-required` / `invalid-credential` Problem 401 时，交由唯一 Session 控制器进入 anonymous；列表读取、mutation 及成功后的刷新遵循同一规则，不再额外请求 get-session。请求开始时绑定身份 generation 和 Session ID，旧登录周期或其他窗口登录前的拒绝，以及已卸载页面的结果不能清掉新身份。未知 401、权限 403、recent-auth 403 与依赖故障不冒充注销。

关闭 Better Auth 客户端默认自动跳转插件；GitHub、Passkey continuation 和 OAuth consent 的响应由所属流程检查 generation/页面生命周期后，才通过统一的 HTTP(S) 跳转函数执行。不能让库的 onSuccess 提前导航绕过这条检查。

路由路径或查询变化时，使该页尚未完成的登录流程失效并恢复可操作状态；其迟到成功、错误和 fallback 均不作用于新页面。OAuth consent 还在退出开始或 Session 身份变化时失效，不能让全局退出后的迟到响应继续跳转或修改地址。取消登录保留已确认的身份，不中断全局 Session 检查或退出请求。

只由 Session 控制器负责初始化、可见性恢复、登录/退出后的刷新；只允许一条在途刷新，使用 generation 丢弃过时结果。关闭库重复的自动触发选项。恢复可见性时距上次成功检查不足 30 秒则不重复请求；长时间不可用可由用户离开页面清理内存。

### 6.3 mutation 与异步状态

每个功能控制器只走：提交 → 显示结果 → 一次显式列表刷新 → 解锁。使用插件动作 API，不同时订阅会自动刷新同一列表的 reactive list。刷新失败显示“操作已成功，列表未刷新”，不能把它改写成操作失败。重认证完成后由用户再次确认 mutation。

组件卸载取消读请求、失效 generation；迟到结果不得恢复旧 key、修改新页面或发起 fallback。剪贴板写入无法取消，因此只保留一个应用级在途标记防止旧复制覆盖新 key；它不保存原始凭证。复制失败保留值及手动复制提示，成功撤销立即清理显示值。Passkey 删除后可 best-effort 调用浏览器 credential signal；失败只提示本地凭据清理，不回滚服务端删除。

键盘可完成所有操作；modal 打开/关闭恢复焦点；错误与 loading 有可访问说明；危险操作明确显示对象。主题 `system/light/dark`，仅主题偏好进入 localStorage，认证数据不落浏览器持久存储。

## 7. 数据与迁移

| 数据                                                                                           | 所有者                                                  | 变更边界                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| user/account/session/verification、Passkey、API Key、OAuth token/consent/client/resource、JWKS | Better Auth 与固定版本插件                              | 原生 adapter；库 schema 生成结果做 drift 校验，应用不复制模型实现                                                                                                                                                   |
| OAuth family tombstone                                                                         | OAuth 撤销模块                                          | 与插件 token 状态通过 D1 原子 batch 和前后检查协作                                                                                                                                                                  |
| security_audit_events                                                                          | 审计模块                                                | 应用 schema；append + 有界清理                                                                                                                                                                                      |
| maintenance_lease、database_backup_health                                                      | 维护模块                                                | 只供备份协调与终态，不建设通用任务表                                                                                                                                                                                |
| rateLimit                                                                                      | Better Auth 限流                                        | 只允许命中已登记 operation；不作为业务使用台账                                                                                                                                                                      |
| ai_connections、ai_authorization_sessions、ai_models、ai_invocations                           | AI 存储模块（[AI 规格 §8](ai-service.md#8-存储与恢复)） | 应用 schema（0002 追加迁移）；凭证版本条件写、原子授权完成、有界刷新 claim、并发 reservation 与每日有界清理；表存在不代表 AI 服务已开放，AI HTTP 路由尚未注册；Key 配置档与上游连接器已实施（本地合成验证，未部署） |

应用字段用 epoch milliseconds；库表保留 adapter 日期表示，只在边界转换。API 时间单位不得混用；OAuth NumericDate 按协议。所有查询参数化，资源查询限定 owner，分页有上限，已有索引优先复用。

首次启用前可以替换当前 `0001_foundation.sql` 的历史 schema 基线，生成只包含当前已实现能力所需表的初始 migration，在全新本地/验证/生产 D1 上应用；不把新基线写进已应用旧 ledger 的数据库，不为省迁移工作直接在旧库删表。无需旧数据迁移、双 schema 读写、旧凭证保留或历史 ledger 对比。可用的新代码和测试继续保留，不因允许数据从零而再次清空仓库。

首个真实使用版本确定后，该 migration 基线固定，后续只追加 migration；CI 直接检查上一已发布版本的 migration 文件未被改写，再在空库应用全部 migration。普通 schema 变更保持可回滚兼容，数据删除与不可逆结构变更单独审核。对应用表使用 Drizzle；静态客户端清单经 migration 登记，禁止请求时建表、修 schema 或 seed。新增表与插件按实际启用切片加入，不预先恢复全部旧表。

## 8. 简化决策与剩余风险

| 删除/收敛                            | 仍然保证什么                   | 对应验收 |
| ------------------------------------ | ------------------------------ | -------- |
| 跨请求 Auth/连接缓存                 | 故障隔离；JWE 继续降低 D1 读取 | A2、A3   |
| 初始化 resource seed                 | migration 是数据定义入口       | A4、A10  |
| catch-all 先初始化 Auth 再 404       | 未知路径无 D1 读写             | A5       |
| 两套 Session 状态、列表自动+手动刷新 | 一次动作一个结果、无乱序覆盖   | A8       |
| 通用鉴权降级/重复 owner preflight    | 一次强校验结果在请求内复用     | A6       |
| 多环境自动猜测与部署自修复           | 发布目标和产物可核对           | A11      |
| 旧补丁整包继承、照实现写的测试       | 只维护仍有行为证据的补丁       | A1、A7   |

不选完整替换 Better Auth：现有风险集中在适配生命周期、失败语义和测试接线，尚无证据说明重写 OAuth/Passkey 比保留库更可靠。Auth.js 的 Session 实现提供“集中读取与输出”的参考，但不能照搬把异常转换为空 Session 的策略。[Auth.js 源码](https://raw.githubusercontent.com/nextauthjs/next-auth/main/packages/core/src/lib/actions/session.ts)。

最脆弱的假设是：完整插件组合能够在请求级初始化下满足性能与无初始化 I/O 的约束。每个插件合入都重跑同一组验收；不能用核心 M2 的结果声称完整系统已验证。若该假设失败，暂停该功能合入，针对具体 adapter/plugin 改变接法并更新规格；不添加跨请求队列、预热 Cron 或自动重试掩盖它。

D1 全局故障仍会阻止强授权和写入；GitHub 故障时已有 Passkey 可以登录；两者都不可用时只能等待依赖恢复。数据量增至十倍，最先受影响的是全量备份容量与恢复耗时，其次是缺失索引的列表查询；不会因此自动引入第二个数据库或后台服务。
