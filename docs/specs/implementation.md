# 服务端与 Web 实施记录

2026-09-10 收尾验证，审查起点为 `c56d0a6` 工作树。owner 最新范围为“desktop 端暂时不做，先做 web”。本文件记录首次实现提交前的能力与验证，架构策略仍由四份规格维护；基线 SHA 仅用于定位审查起点，正式发布版本以合入 main 后的 CI SHA 为准。

## 1. 已实现能力

| 范围                      | 实现                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 认证                      | 请求级 Better Auth；GitHub owner 准入；原生 Session 滚动续期与 JWE；独立 recent-auth；精确入口、粗限流、依赖故障响应；GitHub 每个 HTTP 请求及正文可取消时限                                                                                                                                                                                                                                                                                                                                                      |
| Web                       | 唯一 Session 控制器；Passkey 注册/登录/重认证/命名/删除；API Key 创建/一次性查看/命名/撤销；已授权应用；审计筛选/游标分页；备份状态；私有 Scalar/OpenAPI；系统/浅色/深色外观                                                                                                                                                                                                                                                                                                                                     |
| API Key                   | 独立插件、哈希存储、有限有效期、owner 与权限检查、两级限流；数据库故障返回 503；不产生 Session                                                                                                                                                                                                                                                                                                                                                                                                                   |
| OAuth 服务端              | 静态 client/resource、PKCE、Code/refresh/revoke、OIDC/JWKS、严格 UserInfo 验签；family tombstone、幂等重试、并发撤销；浏览器登录 continuation；管理端整应用撤销                                                                                                                                                                                                                                                                                                                                                  |
| 数据保护                  | 每日 full SQL export Workflow、租约与有限重试、R2 容量预算及对象校验、单调备份状态；有界清理保留 Session；离线恢复规划器和凭证清理计划                                                                                                                                                                                                                                                                                                                                                                           |
| AI 状态存储与凭证生命周期 | 0002 迁移的四张 AI 应用表；连接生命周期、设备授权会话与原子完成、有界刷新 claim 与不确定状态处理、版本约束模型快照、并发 reservation 与 unknown 语义、每日有界清理；恢复规划器按原始表集生成 AI 清理并统一“先清理后迁移”顺序。PR 3（2026-09-19）补齐固定 Codex 连接器、AES-256-GCM 版本化凭证加密（AAD 绑定环境/连接/用途）、设备授权与凭证刷新编排（recent-auth 提交前复核、刷新失败窗口分类）、模型发现与重新授权门槛。AI HTTP 路由与管理界面已交付（§4.19–§4.20）；真实推理链路因上游 403 阻断未验收（§4.21） |
| 交付                      | 生成五个自有 API 的 OpenAPI；同 SHA 两环境独立构建与摘要清单；Actions 手动消费产物、迁移前检查、部署后读回与冒烟                                                                                                                                                                                                                                                                                                                                                                                                 |

沿用完整 `0001_foundation.sql`，安装版本的全部认证字段已经过实际 schema 检查；新库应用同一份基线。无需为了“从零”再次重写可用 schema。首次实现阶段未修改远端资源；随后按 owner 当次授权完成了 §4.1 的空库准备，当前配置使用新的数据库 ID。

## 2. 验证与证据范围

消融修复前的本地执行记录（后续修复结果见 §2.1–§2.2）：

| 检查                                 | 结果                                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run check`                     | 通过：格式、lint、Worker/Vue/脚本类型、自有 OpenAPI 无漂移；Worker 19 文件 162 测试、前端 4 文件 8 测试、脚本 4 文件 29 测试、Chromium 2 测试，共 201 项 |
| 两个环境 `build:release`             | staging / production 分别通过，各 139 个清单文件；精确 Worker 名、Origin、migration 摘要与环境一致                                                       |
| 发布产物核验                         | 逐文件 SHA-256 比对通过；扫描确认没有本地 `.dev.vars` 值；来源标记为 local，不能用作 CI 正式发布记录                                                     |
| 两个环境 Wrangler `deploy --dry-run` | 均通过，只验证本地打包与 binding 配置形状，未部署、未确认资源或 secrets 存在                                                                             |
| Markdown 本地链接、Git whitespace    | 15 份文档没有缺失的本地目标；`git diff --check` 通过                                                                                                     |

Chromium 还完成了匿名 OAuth authorize → 带签名的登录页 → Passkey → loopback 回调，核对 code 和原 state；loopback 接收页是合成 fixture，未启动实际 Desktop App。截图在忽略的 `test-results/web-management.png`，完整检查/构建日志保留于本次本地 `.output/verification/`，不作为长期外部验收记录。

构建仍有 Scalar 文档模块的大 chunk 提示（文档页按需加载），没有用提高阈值隐藏告警。真实网络页面性能和 CI 耗时尚未测量。

核心行为测试使用 workerd、本地 D1、安装的真实 Better Auth 插件，仅替换外部服务或故障点。覆盖 JWE 命中/读取量、原生续期、请求隔离、unknown path 无 D1、真实 GitHub callback owner 准入、Passkey UV、recent-auth、API Key 故障分类、OAuth token/撤销竞争、JWKS 冷却、清理外键边界、备份与恢复。浏览器测试使用 Chromium 虚拟认证器完成 Passkey 注册→退出→再次登录，以及管理 UI 操作；不是纯 helper 测试。

前端另验证会话检查合并、503 保留身份、退出后迟到结果隔离、mutation 成功但列表刷新失败、组件卸载、正文超时和全局剪贴板互斥。发布脚本验证产物篡改/来源/过期/环境错误、恢复 SQL 安全边界、备份生命周期冲突。

本轮未进行新的全矩阵 mutation 自动重跑；原消融矩阵保留为历史证据，当前以行为回归覆盖其关键保障，不能将旧矩阵计为新版全量消融通过。

### 2.1 消融审查修复

修复后 `pnpm run check` 完整通过：格式、lint、Worker/Vue/脚本类型、自有 OpenAPI 无漂移，Worker 22 文件 175 测试、前端 6 文件 13 测试、脚本 6 文件 37 测试、Chromium 2 测试，共 227 项。完整日志见本地忽略目录 `.output/verification/fix-check.log`；上述 §2 表格保留修复前记录，不混用两轮计数。staging / production 的 `build:release` 随后均通过，各 139 个文件的摘要逐项一致，精确 Worker 名核对通过；产物来源仍为 local。本轮未重新执行 Wrangler dry-run，未作远端发布。构建日志为同目录 `fix-build-staging.log` / `fix-build-production.log`。

本轮修复了二次确认的八项问题：并发初始化/轮换 JWKS、迁移成功而部署失败后的恢复、JWKS 读期限、API Key limiter 迟到继续认证、备份盘点分页无界、API Key update 超出名称契约、撤销后残留新密钥、离开 OAuth 授权页后迟到响应仍导航。同时将备份容量盘点合并为上传前一次，并把已授权应用撤销的粗限流移到 D1 身份读取之前。

四项消融盲点已成为正式行为回归：JWE 线格式、Session 撤销后 31 秒停止接受缓存、API Key 缺失权限、owner 关联失效。补充 EdDSA/RS256 并发轮换及共存验签、限流成功耗时扣除、离开授权页后的成功/错误隔离。浏览器还检出了 Better Auth 默认重定向插件先于组件检查执行的问题；已关闭该插件，登录/授权流程显式检查后统一导航，并以真实客户端 GitHub 请求对照及完整 Passkey continuation 验证。浏览器在独立 5183 端口运行，保留原开发服务 5173。

发布在应用迁移前写入绑定目标 D1 与 migration 摘要的 `deployment_migrations` 运维记录，支持人工重跑未完成的发布；旧 Worker 的发布凭据只有在 DB binding ID 相同时才能补建记录。恢复规划器严格校验并清除源记录，再生成绑定目标库的新记录 SQL。DDL 由发布模块维护，不进入应用 migration ledger，恢复规则引用同一来源。实现细节及执行顺序见 [operations.md](./operations.md#6-发布与回滚)。

新增行为测试曾在修复前检出服务端与界面问题；发布测试导入实际部署脚本并用 SQLite 保留迁移状态，外部 Cloudflare/CLI I/O 为模拟。本轮没有重新执行完整 mutation 矩阵，也不以本地模拟代表真实平台发布/恢复成功。

### 2.2 再审确认后的修复

修复了再审二次确认的三项问题：OAuth `grant_type` 首尾空白绕过 refresh family 捕获；恢复器拒绝 D1 导出器生成的 CR/LF 字符串表达式；离开登录页后迟到的 GitHub/Passkey 结果仍导航或修改新页面状态。同类检查还检出了 native revoke 接受 token 前缀、family 捕获却直接哈希原值的差异，现复用原生 `stripAccessTokenAuthorizationScheme`，使裸 token 及库接受的 Bearer/DPoP 前缀形式都执行相同的 family 撤销与审计。

`pnpm run check` 完整通过：格式、lint、Worker/Vue/脚本类型、自有 OpenAPI 无漂移，Worker 22 文件 185 测试、前端 7 文件 19 测试、脚本 6 文件 40 测试、Chromium 4 测试，共 **248 项**。新增回归先在旧实现上检出失败，再验证修复；保留了正常登录、OAuth continuation、跨页面 Session 检查、refresh 重试及恢复器拒绝危险 SQL 的正反向覆盖。本轮没有重跑完整 mutation 矩阵。

恢复 fixture 由锁定版本 Miniflare 的实际 D1 导出器生成，覆盖 CR、LF、嵌套 CRLF、引号和 Unicode；仅放行导出需要的 `replace` / `char` 函数。实际恢复 CLI 对普通文本、LF、CR 三份导出均返回 `validated-local-plan-only`，没有执行外部操作。浏览器使用实际 App/router、原生认证客户端与虚拟 Passkey 认证器；GitHub 外部响应为模拟，Passkey continuation 使用本地真实验证接口。

staging / production 的 `build:release` 均通过，各 139 个清单文件的 SHA-256、migration 摘要与精确 Worker 名核对通过；来源仍为 local，构建保留 Scalar 大 chunk 提示。完整检查、修复前对照、构建及恢复 CLI 结果保存在本地忽略目录 `.output/verification/review-followup-fixes-2026-09-10/`。所有验证在隔离副本执行，浏览器使用 5183；原 5173 开发服务和既有暂存内容保持原状。本轮未提交、推送或部署，未重新执行 Wrangler dry-run，外部验收仍按 §5 单列。

### 2.3 提交前审查补充修复

关闭了两项跨流程问题：可信的凭证失效 401 未更新 Web 的唯一 Session 状态；staging/production 复用限流 namespace，相同 operation/IP 会跨 Worker 消耗额度。管理列表、mutation、成功后的列表刷新，以及审计/备份状态/文档/授权读取中的已知凭证失效，统一交由 Session 控制器处理，不追加 get-session 请求。处理器同时绑定请求开始时的 generation 和 Session ID，避免迟到拒绝清除其他窗口新建立且已确认的身份；未知 401、权限或重认证 403、503 均不伪装注销。

新增回归在旧代码上复现四个管理入口的失败；另一个窗口建立新 Session 后的迟到拒绝也先检出失败再修复。最终 `pnpm run check` 通过：Worker 22 文件 185 项、前端 8 文件 30 项、脚本 6 文件 40 项、Chromium 4 项，共 **259 项**。新增测试覆盖原生 API Key 客户端、实际 SessionBoundary 与面板卸载后的敏感内存清理，以及同 Session 的迟到缓存与新 Session 的旧错误隔离。

生产 limiter 沿用既有 namespace，staging 使用独立值；构建在启动 Vite 前拒绝两个环境间重复的 namespace，已用故意重复配置验证拒绝。两环境发布构建均通过，各 139 文件的摘要、精确 Worker 名和四个独立 namespace 核对通过；生成类型无漂移。完整检查、修复前对照和构建日志保存在本地忽略目录 `.output/pr-readiness-2026-09-10/`。产物来源仍为 local，没有执行 Cloudflare 写入；这次定点对照不代表新版完整消融矩阵重跑。

### 2.4 消融实验式全项目审查与修复（2026-09-21）

按 acceptance.md §3 的消融定义对全项目复审：8 项安全保障消融（owner 准入、recent-auth 窗口、`/api/status` 每钥限流、载体唯一性、AI 凭证加密、审计写入、撤销缓存窗口、OAuth 授权绕缓存强校验）在隔离副本全部被行为测试检出，历史 4 项盲点的修复回归仍有效。路由消融实测发现两个行为盲点：移除 `/api/oauth/authorizations` 或 `/api/security/backup-status` 的注册并同步 operation 计数哨兵后测试集全绿，二者此前仅由计数哨兵与 openapi:check 守护。静态引用图另发现死补丁、死导出、重复定义与文档漂移。

修复内容：① 行为测试补齐——新增 `oauth-authorizations-route`（匿名/混合载体、owner 列表聚合、跨 Origin、未知 client、stale recent-auth、撤销+审计+幂等）、`backup-status-route`（401/400、never-run、坏行 internal-error、D1 故障 503）与 `oauth-panel`（渲染与撤销调用）；e2e 增加已登录深链用例，对已授权应用与备份状态发起真实路由请求（原 e2e 对备份状态为 mock）。实测确认 code 授权不写 `oauthConsent` 表，撤销计数以 active refresh token 为准。② 单一事实源——Better Auth 插件配置改为引用 `shared/api-key.ts` 的权限与每钥限流常量（原为平行硬编码），入口 5/min 限流孤儿常量删除（wrangler.jsonc 与发布脚本为事实源）；`db/schema.ts` 删除 5 张无消费者的 AI/维护 drizzle 表定义，architecture.md §7 如实描述 Drizzle（审计/备份健康）与参数化手写 SQL（AI/维护）的分工、migration SQL 为全部应用表结构的唯一权威；`shared/ai.ts` 下移为 `src/worker/ai/policy.ts`、`principal.ts` 并入 `oauth/access-token.ts`，shared 目录只保留四个双端引用文件。③ 死代码与配置——删除 3 个未声明的 `@1.7.0` 补丁（此前随发布产物分发）、零消费者的 `.secretlintrc.json`、27 个仅内部使用的值导出与 problem registry 中零使用的 `conflict`/`insufficient-scope`；wrangler.jsonc 显式声明 `migrations_dir`，playwright 与两个 vitest 客户端/脚本配置纳入 typecheck。④ 依赖——pnpm overrides 将 jose 统一为 6.2.12，消除 oauth-provider 自带 6.2.10 的双版本共存。⑤ 文档——implementation.md §1 与 architecture.md §7 中“AI HTTP 路由未注册/未开放”的过时表述对齐 §4.19–§4.21；§4.3 改为 `readOwnerSession` 参数化表述。⑥ 测试稳定性——显式 `migrations_dir` 暴露 ai-management-routes 审计对比断言包含非确定的 D1 `meta.duration`，改为只比较结果行。core@1.7.0 的 AsyncLocalStorage 补丁未移植：wrangler 已启用 `nodejs_compat`，1.7.2 动态 import 路径正常，无缺失证据。

验证：`pnpm run check` 全链通过——Worker 36 文件 465 项、前端 17 文件 77 项、脚本 6 文件 69 项、Chromium 8 项、自有 OpenAPI 无漂移。审查实验在隔离副本执行（含 rsync 物理拷贝依赖），原仓库工作树前后核验干净。本轮未部署、未执行远端操作。

## 3. 依赖补丁与最小接法

核心、Passkey、API Key、OAuth Provider 均精确锁定 `1.7.2`。两个 pnpm 补丁有实际回归证据：

| 补丁                          | 上游缺口与改动                                                                                                                                                                          | 可删除条件                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `@better-auth/api-key`        | `verifyKey` 将非业务数据库异常吞成 invalid key；保留已定义 APIError，其他异常向上传递以返回 503                                                                                         | 移除补丁后 `tests/worker/api-key.test.ts` 的 native verify 数据库故障测试仍通过               |
| `@better-auth/oauth-provider` | 重放失效范围必须限定 authorizationCodeId；错误 token hint 仍尝试真实 token 类型；空撤销返回显式响应；signed continuation 只作用于允许的登录/授权路径，普通退出不受无关 oauth_query 影响 | 移除补丁后 oauth-flow、oauth-races 和浏览器 continuation 测试全部通过，并检查锁定版本原生接法 |

不继承整包旧补丁。GitHub 的 10 秒传输边界通过公开 plugin init/socialProviders 接口设置，不修改全局 fetch。JWT 通过公开 `adapter.createJwk` 接入 D1 原子 batch 的条件创建和胜出 key 读取，避免跨请求并发生成多个有效 key；只有创建者安排脱敏审计；加密仍由原生 JWT 插件执行。JWKS 缓存只存已完成的公钥结果，不共享在途 Promise。

## 4. 运行与首次发布接线

`pnpm run dev` 先检查本地 `.dev.vars`，缺项只报告名称，再应用本地 migration 启动 Vite。真实 GitHub 登录需要本地独立应用凭证；测试不需要。不会为方便开发生成生产凭证或覆盖已有 `.dev.vars`。本次实际验证了缺项停止：原本地文件缺少 `AUDIT_IP_HASH_SECRET`，启动准确报告该名称。随后仅追加了独立随机本地审计密钥及未启用本地备份用的 export token 占位值，文件权限设为 0600，原有凭证未覆盖。再次执行 `pnpm run dev` 成功，本地 migration 应用后，首页/health 为 200、匿名 get-session 为 200/null、受保护 status 为 401。真实 GitHub 回调仍需实际第三方验收。Vite 忽略 `.wrangler`、测试和构建产物，避免本地数据库写入打断表单。

首次接线与发布按以下顺序执行，已完成状态见本节末的记录：

1. 为 staging/production 各准备新空 D1 和独立私有 R2 Standard bucket，在 `wrangler.jsonc` 填入 account/database ID，确认 vars 与 binding 对应。按运维规格可重建同名 D1、沿用已确认空的专用 R2；原数据库不作为新基线执行目标。
2. 读取目标 bucket 的现有 lifecycle，再设置唯一 `d1/daily/` 前缀 Age 2592000 秒删除规则，确认没有重叠删除或存储类别迁移。部署脚本只读验证，不自动修改规则。字段依据 [Cloudflare Lifecycle API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/get/)。
3. 为精确 Worker 名预置五项 required secrets（runtime 备份 token 与部署 token 独立）。首次 bootstrap Worker 与域名绑定是一次性平台接线，常规发布不隐式创建、猜测或修复缺项。
4. GitHub 的受保护 main、两个 Environment、最小权限 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` 准备好。production 仅 owner 发起，并阻止其他账号重跑借用其授权。
5. 通过 CI 后选择完整 SHA 手动发布；流水线检查同仓库/指定成功 CI/环境/7 天有效期/文件摘要，必要时迁移，再部署。之后读回绑定、cron、source SHA 和 version，并执行最多 60 秒的基础冒烟。

默认本地构建也生成摘要，但来源记录为 local，不能冒充通过 GitHub CI 的正式发布产物。[PR #13 合并版本的 main CI](https://github.com/eruoo/server/actions/runs/34438914568) 已成功，耗时 217 秒；本次配置变更仍须重新通过 CI，正式发布耗时尚未采样，约 5 分钟仍是合计目标；10 分钟 job 截止与 60 秒 smoke 是已配置的上限。

### 4.1 2026-09-10 Cloudflare 资源准备

owner 当次要求检查并处理现有 Cloudflare 资源，再同步项目配置；本次按架构 Q8 执行。资源名称与实际 ID 由 `wrangler.jsonc` 维护。

- 盘点账号全部六个 Worker，确认本项目的两个 D1 和生产备份桶没有其他项目引用。旧库只有少量测试数据，先分别导出到本机私有文件，验证可导入本地 SQLite 且完整性检查通过，再删除并按原名重建为新空 D1。远端检查确认无应用表、无旧 migration ledger；未执行新版 migration。
- 生产 R2 桶完整盘点为空，继续沿用；新增独立 staging 桶。两桶均为私有 Standard，无自定义公开域名，`r2.dev` 关闭。读取旧 lifecycle 后，将生产原全桶 180 天规则替换为唯一 `d1/daily/` 前缀 30 天删除规则；两桶保留平台默认的 7 天未完成 multipart 清理规则，并读回验证。
- 两个 Worker 名称及生产域名保持不变。已更新云端 DB/BACKUPS、公开 runtime vars 与四个独立限流 namespace，并读回验证；其余绑定和 Secret 被保留。两环境旧 cron 均已暂停，生产 Cloudflare Builds 已断开，staging 原本未关联 Builds。正式发布才启用配置中的新 cron。
- 两环境分别生成并写入新的 `BETTER_AUTH_SECRETS`、`AUDIT_IP_HASH_SECRET`。staging 新增账号内独立的 D1 Read token 并写入 `D1_EXPORT_API_TOKEN`；生产保留已有 export token。两个 Worker 的五项 required Secret 名称均已读回确认；GitHub 凭证未改动。Secret 名称齐全不代表真实 GitHub 登录或备份导出已验收。
- 生产沿用原 Workflow 定义，已确认无保留实例；staging Workflow 将随首次正式发布的 `DatabaseBackupWorkflow` 导出类注册，不另行发布临时 Worker。此次仅修改资源与运行配置，尚未发布新版应用；空库期间旧版认证暂时不可用。
- 项目已填入真实 account/database ID，R2/Workflow 使用稳定名称；发布校验仍拒绝串用其他环境资源。新增八项发布行为测试，覆盖两环境正常发布及错误目标在任何远端请求前被拒绝。完整 `pnpm run check` 通过：Worker 185 项、前端 30 项、脚本 48 项、Chromium 4 项，共 **267 项**；Wrangler types 已重新生成且无漂移。两环境发布构建均通过，各 139 个文件的摘要、migration 与实际资源配置核对一致；产物来源为 local，仍须配置提交后重新取得 CI 产物。

数据库导出、脱敏执行回执和本机密钥备份保存在忽略目录 `.output/cloudflare-setup-2026-09-10/`，含凭证的文件权限为 0600，不进入 Git。它们是本次操作留档，不是系统恢复流程或 CI 的长期依赖。GitHub 接线结果见 §4.2；配置变更取得新 SHA 的 CI 产物后，按当次授权发布 staging、验收后发布 production。

### 4.2 2026-09-10 GitHub 发布接线

owner 要求继续完成可自动处理的上线准备，以下配置均已执行并读回核验：

- main 必须经 PR 合入，并通过 GitHub Actions 应用提供的 `check`；分支必须与基线同步，管理员同样受约束，禁止强推和删除。不额外要求人工审批数量。
- 新建 `staging`、`production` 两个 Environment，只允许 `main` 分支，均已设置 `CLOUDFLARE_ACCOUNT_ID` 和加密的 `CLOUDFLARE_API_TOKEN`。没有给 PR 检查流程提供部署凭证，也没有配置重复等待或审批步骤。
- 两环境各使用一枚独立的账号级部署 token：Workers Scripts Write、D1 Write、Workers R2 Storage Read、Account Settings Read；无到期时间。凭证与 runtime 的 D1 export token 分离。上述权限由平台按账号授予，环境目标另由发布脚本核对，不能把两枚 token 描述为只能访问各自 Worker 的权限隔离。
- 组织中的两套 GitHub OAuth App 已存在，Homepage 与 callback 分别对应环境的 `APP_ORIGIN` 和 `/api/auth/callback/github`，无需修改；这只证明应用侧地址正确，runtime 中的 client ID/secret 仍须实际登录验证。

本轮重新运行发布脚本测试，48 项通过；脱敏接线回执在本地忽略目录 `.output/staging-release-2026-09-10/`。本节记录接线完成时的状态；随后首次 staging 发布见 §4.3。

### 4.3 2026-09-10 首次 staging 发布与验收修正

[PR #14](https://github.com/eruoo/server/pull/14) 已合入 `fd64cf743862228bbcc53504347e372af39b386b`，[对应 main CI](https://github.com/eruoo/server/actions/runs/34463041355) 通过检查并生成两环境产物。[首次 staging 发布](https://github.com/eruoo/server/actions/runs/34463425284) 已应用 `0001_foundation.sql`，上传新版应用并注册 staging Workflow，读回绑定和两项 cron 通过。此次未部署 production。

该 Actions run 因 health 版本比较失败而结束，不能标为验收通过。Cloudflare 日志确认：09:57:35 UTC 创建新部署，约 3 秒后的 CI health 返回 200，但仍由旧版本 `fe6bca4e-987b-4814-92a1-12d7fa73d284` 处理；期望的新版本为 `3282f7cd-18a8-4d6e-a4b4-68c79393e89a`。稍后五个匿名探针均通过。发布脚本现按 operations §6.1 在原预算内等待已知旧版本切换，并保留立即拒绝其他错误的边界；真实 Actions 重跑结果仍需补录。

真实 GitHub 登录两次返回 `invalid_code`，远端 user/account/session 均为零，失败位于 token 兑换阶段，尚未到 owner 准入。当前改动补充 `github_code_exchange_failed` 脱敏事件，仅记录固定错误类别及 HTTP 状态；不记录 code、token、secret、响应正文或任意异常文本。GitHub 原因代码按[官方兑换错误文档](https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-oauth-app-access-token-request-errors)限定为凭证、授权码或回调地址错误，其他内容只归为通用类别。保持通用登录错误响应；不以诊断改动宣称真实登录已修复，也不盲目轮换 GitHub 凭证。

本地完整 `pnpm run check` 通过：Worker 190 项、前端 30 项、脚本 54 项、Chromium 4 项，共 **278 项**。六项发布回归与五项 GitHub 诊断回归均先在原实现上检出失败，再验证修正。检查同类入口后，版本比较和 GitHub token 兑换各只有这一处实现；GitHub 正常 owner 登录、拒绝非 owner、凭证/PKCE 参数及正文超时测试继续通过。

### 4.4 2026-09-10 发布通过与原生网络兼容性修正

[PR #15](https://github.com/eruoo/server/pull/15) 合入 `87e44c6200b6b629efb9d7dcfcaffc9aeb675f5c`；[main CI](https://github.com/eruoo/server/actions/runs/34466187065) 和 [staging 发布](https://github.com/eruoo/server/actions/runs/34466475698) 均成功。发布没有新 migration，五个冒烟全部通过；Worker 版本 `2ebfa525-c1b1-478a-b889-5d35271de9bf`、deployment `78e3c064-e191-4bba-8d75-3d961895cbac` 已读回。production 版本与空 cron 保持不变。

真实 GitHub 回跳仍失败，新诊断为 `request_failed`。随后用合成凭证执行锁定 workerd 的原生 fetch，确认 `redirect: "error"` 在网络请求发出前抛出 TypeError。原测试替换了 fetch，掩盖了这个参数不兼容；GitHub 错误不能据此归因于密码或 client secret。修正覆盖全部三处同类调用：GitHub JSON 传输、D1 export 的 start/poll、SQL 下载。均改为 `manual`，复用既有非 2xx 拒绝逻辑；备份 3xx 不重试，任何调用都不跟随 Location。

回归现在经过 workerd 原生 Request 构造校验，再模拟外部响应；保留正常 owner/非 owner 与 export/poll/download 正向测试，补充 GitHub 五类重定向和备份三种操作的重定向拒绝。原生网络探针只使用合成凭证，未更换 GitHub secret；该修正的真实登录和备份验收仍需使用新 main 产物完成。

旧实现运行这些回归时 13 项失败；修复后完整 `pnpm run check` 通过：Worker 198 项、前端 30 项、脚本 54 项、Chromium 4 项，共 **286 项**。测试为每次登录分配独立合成 IP，并在发起与回调中保持一致，避免新增案例互相消耗粗限流额度；未放宽实际限流策略。

### 4.5 2026-09-10 真实登录与 Workflow 边界验收

[PR #16](https://github.com/eruoo/server/pull/16) 合入 `1f4612ba51da696393c0a932cc2bf9f817eebaf7`；[main CI](https://github.com/eruoo/server/actions/runs/34468037883) 和 [staging 发布](https://github.com/eruoo/server/actions/runs/34468448251) 均成功，无新 migration，五个冒烟通过。Worker 版本 `8608ebf2-8aa5-4739-aab1-5e90745590c9`、deployment `a12a5d66-ab0a-4cad-b8fd-68f61df6559b` 与 RELEASE_SHA 已读回。真实 GitHub 登录进入管理台，远端确认 owner / account / Session 各一行；原有 GitHub client ID/secret 有效，无需轮换。

最近两次成功 main CI + staging 发布的 Actions run 起止耗时分别约 175 + 43 = 218 秒、201 + 47 = 248 秒。这是两组样本，包含各 run 自身排队与收尾，不包含 CI 与手动发布之间的 owner 等待；尚未积累五次常规发布，也不是首次完整平台验收耗时。

首次真实备份实例 `database-backup-v1-20260910-acceptance-1f4612b` 在 export 启动阶段被 Cloudflare 拒绝，未进入上传。实例记录显示 `limit: 1` 实际尝试两次；错误跨步骤后变为 `Error("DatabaseBackupError: backup_export_authentication_failed")`，导致健康状态误归类为配置错误。Dashboard 中独立 staging 导出 token 为账号范围 D1 Read、Active、无 IP 限制；这些元数据不能证明 Worker 中保存的值有效，凭证仍需修复并重验，不改用部署 token 或放宽权限。

代码按 operations §4.3 修正重试计数、保留 `NonRetryableError` 默认名称并恢复 RPC 包装中的固定错误码。新增测试实际创建本地 Workflow 实例，仅替换外部 HTTP 响应、关闭等待时间，不替换步骤执行、重试或错误传输；覆盖 start/poll/download 的永久与暂时失败，以及重试后成功上传。修复前六项失败、一项成功对照通过，修复后七项通过。完整 `pnpm run check` 通过：Worker 205 项、前端 30 项、脚本 54 项、Chromium 4 项，共 **293 项**。

隔离恢复目标 `eruoo-server-restore-20260910-1f4612b` 已创建并验证为空，尚未导入快照、生成新信任或记录恢复完成。正式存储绑定未切换；production 应用仍未发布。脱敏执行证据继续保存在 `.output/staging-release-2026-09-10/`。

### 4.6 2026-09-10 实际导出凭证与轮询契约修正

[PR #17](https://github.com/eruoo/server/pull/17) 合入 `8c10c5422be2bdd73d9df51d1ca8911898b44b58`；[main CI](https://github.com/eruoo/server/actions/runs/34470704808) 和 [staging 发布](https://github.com/eruoo/server/actions/runs/34471096668) 均成功，发布耗时 49 秒，无新 migration，五个冒烟通过。owner 随后完成真实 Passkey 验证；远端注册和登录审计均已核对。GitHub 与 Passkey 的真实登录已通过，仍不代表全部专项验收完成。

owner 更新导出 Secret 后，个人 Token verify 返回 Active，并确认该凭证为 staging 实际使用的 `eruoo-server-d1-export`。它不同于最初创建的账号 Token `eruoo-server-staging-d1-export`；先前针对后者的 Write 试验不能证明实际运行凭证的结果。两个身份的区别以 owner 提供的 verify 结果及其确认建立，Dashboard 名称本身不提供完整的 ID/Secret 对应证明。

经 owner 对实际个人 Token 的账号范围明确授权，将 D1 Read 临时改为 Edit，保持 Secret 值和应用代码不变，启动唯一实例 `database-backup-v1-20260910-user-token-write-8c10c54`。实例于 14:49:41–14:49:47 UTC 失败：一次 export 请求从原认证错误进入 2xx 响应解析，报 `backup_export_response_invalid`，没有轮询、下载或上传。已按约定恢复 D1 Read 并读回保存后的权限摘要；先前的账号 Token 也保持 Read。此次没有更换为部署 Token，没有成功备份，未保留原始响应正文，因此不能断言该次实际响应的具体 status 字段。

按[运维规格的导出契约](operations.md#42-六步流程)，官方 Wrangler 的 202/active fixture 在旧解析器上复现同一错误；另确认每次 poll 缺少必需的 `output_format`。两项回归在修改前均失败，修正后导出客户端与原生 Workflow 的 21 项测试通过。原生 Workflow 正向测试实际经过 active → active → complete → 下载暂时失败后重试 → R2 保存与健康状态更新，仅模拟外部 HTTP 并关闭等待时间；真实平台仍需用修正后的 staging 版本重新验收。

完整 `pnpm run check` 通过：Worker 205 项、前端 30 项、脚本 54 项、Chromium 4 项，共 **293 项**；本轮增强既有案例，没有增加测试项数，也没有重跑完整消融矩阵。

本轮脱敏执行回执及回归日志保存在本地忽略目录 `.output/staging-release-2026-09-10/`，不记录凭证、SQL 或签名下载地址。生产 v2 仍未部署；真实备份成功前不开展快照导入。

### 4.7 2026-09-11 导出状态保留与轮询间隔

[PR #18](https://github.com/eruoo/server/pull/18) 合入 `201bb185cdf5a4b7f66708ad35c181842c4e1144`；[main CI](https://github.com/eruoo/server/actions/runs/34493760569) 与 [staging 发布](https://github.com/eruoo/server/actions/runs/34494225399) 成功。owner 保留导出 Token 名称、修改权限并 Roll 新值，随后在 staging Deploy；读回 Worker 版本 `bd9190b7-897c-4c43-adb7-55807ae36ada`，RELEASE_SHA 仍为该提交。该 owner 操作覆盖 §4.6 临时试验结束时的旧权限状态。

真实实例 `database-backup-v1-20260911-rolled-token-201bb18` 于 17:04:54–17:05:54 UTC 失败：启动 full export 一次成功，55 秒后首次 poll 报 `backup_export_response_invalid`，未下载或写入 R2。当前线上源代码已核对包含 PR #18 的请求与 active 解析修复。

随后使用独立的 Wrangler OAuth 凭证，在同一 staging D1 顺序执行有界对照；这些探针不验证 Worker Secret 本身，不下载 SQL、不写 R2。完整导出 55 秒后返回 HTTP 200、外层 success=true、内部 success=false；schema-only 55 秒对照取得相同失败，错误为“Not currently exporting anything.”。schema-only 3 秒与完整导出 5 秒对照均正常完成，完整导出 bookmark 保持一致，现有解析器直接通过。证据支持缩短轮询间隔，不能据此声称测得精确平台 TTL。

按 [operations §4.3](operations.md#43-有限预算与并发) 将 sleep 改为 5 秒，保留 15 次观察与 33 次外部 HTTP 上限。解析器先识别内部导出失败，再校验成功响应的 bookmark/type，避免任务状态丢失被误报为格式错误。失败仍不重试启动，不接受异常成功响应，不延长 lease 或上传预算。

新增两项无 bookmark 失败响应测试、一项短暂结果保留测试和一项原生 Workflow 失败终态测试；四项在旧实现上实跑均失败，26 项对照通过，修复后全部 30 项通过。保留测试的 30 秒窗口为合成模型，不是平台 TTL。原生 Workflow 确认这种失败只启动一次、轮询一次，并保留 `backup_export_failed`。真实完整备份仍需用修正后的 staging 版本重验。

完整 `pnpm run check` 通过：Worker 209 项、前端 30 项、脚本 54 项、Chromium 4 项，共 **297 项**。仅导出客户端和调度间隔需要修正；编排中的 bookmark 一致性、下载与 R2 上传校验保持有效。本轮未重跑全量消融矩阵。

脱敏对照与部署读回保存在本地忽略目录 `.output/staging-release-2026-09-11/`；对照日志未记录 Token、SQL 或签名下载地址。该轮修正后的真实备份与隔离恢复结果见 §4.8。

### 4.8 2026-09-11 完整备份与隔离恢复通过

[PR #19](https://github.com/eruoo/server/pull/19) 合入 `640b8da00958a36ebdcff9a804e9ec5a2454144b`；[main CI](https://github.com/eruoo/server/actions/runs/34508285701) 与 [staging 发布](https://github.com/eruoo/server/actions/runs/34508722531) 成功，无新增 migration。发布 job 约 65 秒，Worker 版本 `255bf6b2-cbed-4f33-895c-379fa0852967`、deployment `4f9c4638-5002-4828-9b9b-a2031e7f2f66` 与 RELEASE_SHA 已读回；保留 owner 新写入的导出 Secret。

§4.7 的失败实例留下未到期 lease。重新确认实例已 errored、没有活动实例、从未进入下载/上传、R2 仍为空且 health 对应该次失败后，以原 ownerId、expiresAt 与失败终态条件删除唯一 lease 行；没有强占上传中的任务或改变租约时长。

真实实例 `database-backup-v1-20260911-acceptance-640b8da` 于 17:34:16–17:34:26 UTC 完成：full export 启动一次、5 秒后 poll 一次、容量盘点一次、流式上传一次，所有步骤均只尝试一次。R2 保存 **22,025 bytes** SQL，`database_backup_health` 为 `ok` 并写入 lastSuccessAt。新 Token 已通过实际完整导出→下载→R2 保存链路验证，无需再次更换。

通过原生 R2 HEAD 核对对象大小、ETag、11 个 metadata 字段及源 Worker 版本；下载文件的 MD5 与 ETag 一致。本地恢复规划器接受真实导出，确认 schema、外键和唯一 `0001_foundation.sql` migration；没有待补 migration。随后将快照导入既有空库 `eruoo-server-restore-20260910-1f4612b`（`e74c0ef8-1f2a-4d51-8866-baf35c03ae9d`），未切换 staging 或 production binding。

隔离库验收于 17:48:37 UTC 完成：

- 清除快照内 3 个 Session、1 个 Passkey、provider 凭证和 9 条审计记录；其余安全状态表均核验为空。user 与 GitHub account 各一行，内容及关联保持一致，外键违规为 0。
- 按当前清单恢复静态 OAuth client/resource；源 `deployment_migrations` 记录已清除，核验后写入隔离目标 ID 与当前 migration 内容摘要。
- 使用当前 Better Auth 和原生远端 D1 生成新 Ed25519、RS256/2048 密钥，私钥加密存储，两个算法的签名验证通过。源快照 JWKS 为 0 行，因此该快照不覆盖已有 JWKS 行的清理验收。演练使用独立本地测试 Secret，没有轮换任何线上认证 Secret，也未部署对外恢复应用。
- 原生会话 hook 允许保留的 owner 创建会话，拒绝无 owner 关联的用户；新会话读取通过，撤销后拒绝，3 个源 Session 均不能在恢复库查回。测试会话已删除，未重演 GitHub 网络登录、未签发 OAuth grant。
- 全部校验完成后才写入唯一 `database_restore_completed` 审计。终态保留 user/account 各一行、新 JWKS 两行和该审计一行，无 Session、Passkey、API Key 或 OAuth token。

脱敏执行回执保存在上述本地忽略目录；完整 SQL 与隔离演练 Secret 单独以私有文件权限保存，不进入 Git、执行日志或报告。最后读回确认原 staging/production D1 binding 未变，owner 在 production Dashboard 更新 Secret 所产生的 deployment `9c2d02eb-ba62-4eba-975b-7adb5b4a055d` 保持不变；production v2 尚未发布。

### 4.9 2026-09-11 staging 可靠性专项

本轮按 owner 的继续指令验收 staging 性能、Workflow 中断边界与代码回退；未签发 OAuth grant，未发布 production。性能采样固定使用 §4.8 的 Worker 版本，Git 中的文档更新不作为新运行时代码。

**Workflow 中断。** 使用独立私有 Worker/Workflow/R2 `eruoo-reliability-staging`，无公网入口、无 Secret、无 D1 或业务备份绑定。探针调用当前 `uploadD1ExportToR2`，通过原生 HTTP Service Binding 提供 64 KiB 合成 SQL 流，实际交给原生 R2.put；使用真实 Cloudflare Workflow 引擎。只缩短实验时限并关闭额外重试，未修改 staging 的运行预算。

| 对照                                 | 实际终态及外部对象                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 正常上传                             | complete；步骤约 1.21 秒，保存 65,536 bytes SQL                                                             |
| 应用 3 秒截止、慢速流                | errored / `backup_upload_timed_out`；步骤约 3.41 秒，流随后停止，无 SQL 对象                                |
| 平台 step timeout 2 秒               | errored / `WorkflowTimeoutError`；平台在 2 秒结束步骤，流随后停止，无 SQL 对象；应用 catch 没有完成错误记录 |
| 首块已被消费、上传仍进行时 terminate | terminated；流随后停止，无 SQL 对象；应用 catch 没有完成错误记录                                            |
| 上传已完成、步骤尚未返回时 terminate | terminated；已写入的 SQL 对象仍保留                                                                         |

每组从派发起持续观察至少 42 秒，超过合成流正常完成时间与应用截止时间；截至最终读回，没有迟到的第三个 SQL 对象。两个成功写入对象的原生 R2 读取、大小、11 个 metadata 字段及 MD5/ETag 一致性均通过。结果仅证明此次小流与指定中断时点的行为，不证明大对象提交的所有竞争窗口、15 分钟运行或强制取消后应用健康状态必定落库；因此不放宽 lease，也不自动清理被终止任务的租约。25 个合成对象及三个临时资源已清理，并读回确认不存在。

随后直接调用真实 staging D1 export：首次为 active，在 10 秒内不发任何 poll，下一次以原 bookmark 查询即为 complete，返回下载地址；总计约 12.94 秒，未下载行数据或记录签名 URL。这证明该次导出无需持续轮询也会继续完成，不证明停止轮询会取消服务端导出，也不建立平台状态保留时间保证。

**Session 与性能。** 同一代理网络经 LAX，连续发送 30 次有效 JWE 请求、10 次仅 Session Cookie 的权威读取和匿名/health 对照；均返回 200。采样独立使用一个最长一小时的 owner 测试 Session，不改变真实登录会话。HTTP TTFB 包括客户端网络与连接成本；Cloudflare 的 CPU/wall time 单独报告。

| 样本               | 数量 | TTFB p50 / p95 / max（ms）  |
| ------------------ | ---- | --------------------------- |
| warm JWE           | 30   | 220.812 / 233.524 / 292.878 |
| warm D1            | 10   | 401.465 / 518.709 / 518.709 |
| 匿名               | 3    | 220.310 / 623.107 / 623.107 |
| health，含首次连接 | 6    | 202.134 / 786.973 / 786.973 |

再执行五轮各 310 秒的无探针请求间隔，关闭 staging 浏览器页，并在整段采样期间保持同一 Worker 版本；不假定平台一定回收 isolate。每轮仅携带 Session Cookie，首次请求后紧随一次 health 对照。五轮均为 200，TTFB p50/p95/max 为 1260.457/1701.332/1701.332ms：

| 闲置轮次 | TTFB（ms） | 平台 CPU / wall time（ms） |
| -------- | ---------- | -------------------------- |
| 1        | 1108.199   | 51 / 270                   |
| 2        | 1701.332   | 76 / 786                   |
| 3        | 1322.968   | 96 / 322                   |
| 4        | 1260.457   | 84 / 308                   |
| 5        | 1063.752   | 52 / 268                   |

对应 health TTFB 为 199.800–221.269ms、平台 wall time 为 1–2ms。合计 60 次采样请求成功，性能探针 Session 已按自己的 id/token/userAgent 条件删除并确认剩余为 0。采样进程的远端开发连接曾输出 internal error；测量 HTTP 请求及最终 D1 清理均成功，未把该开发连接日志记为 staging 应用失败。

后五次 warm health 为 200.706–206.244ms。Dashboard 可见的同一采样时段中，29 条 JWE 对应调用的 CPU p50/p95/max 为 11/19/92ms、wall time 为 14/33/93ms；10 条 D1 对应调用为 CPU 12/118/118ms、wall time 201/318/318ms。按时间与顺序对应，未逐条以 request ID 关联；精确一分钟窗口取得 48 条调用，一条 JWE 和一条匿名调用未取得平台记录，不补造数据。客户端 50 个响应的 request ID 均不同。官方遥测 API 在当前 Wrangler OAuth 权限下返回 403，以上读数来自已登录 Dashboard，未修改 Token 权限。

30 个 JWE 请求均携带缓存 Cookie，且没有重新下发缓存；远端响应不直接暴露逐请求 D1 次数，不能仅据此写成远端零 I/O。当前代码的本地原生 workerd/D1 回归另行通过 2 文件、10 项测试，覆盖 JWE 零 I/O、滑动续期、过期会话、数据库故障 503，以及首请求阻塞时约 5 秒返回 504、相邻请求独立完成。没有将本地故障注入写成真实 D1 服务故障。

warm TTFB 未达到当时 acceptance §4 的 100ms 门槛，五轮闲置首次请求也都超过当时 600ms 目标。网络已有约 200ms 基线，D1 调用另外存在等待及 CPU 峰值，第二次闲置请求的平台 wall time 本身也达到 786ms；不能只归因于其中一项，也不以减去 health 的数值冒充应用 TTFB。本轮按原门槛未通过；后续 owner 确认的新目标与地区复测另见 §4.11，不改写本轮判定。

**发布与回退。** 从受保护 main 的 `7f9713ab8593fe54a90c76d72b3ad6190d758f4c` 发布 staging；相对原 staging 的 `640b8da00958a36ebdcff9a804e9ec5a2454144b` 仅修改实施记录，应用代码、配置及 migration 相同。[CI 34511372587](https://github.com/eruoo/server/actions/runs/34511372587) 与 [staging 发布 34598345340](https://github.com/eruoo/server/actions/runs/34598345340) 均成功。CI job 为 218 秒，部署 job 为 36 秒，合计执行 254 秒（4 分 14 秒）；不含排队或 owner 等待，也不是连续实时时长。总执行时间在约 5 分钟目标内，但 CI 单阶段超过 3 分钟参考，单次样本不足以证明最近五次发布达标。

新 Worker version 为 `92cc84f2-4e4b-464c-a6a3-8538c09ca09f`，deployment 为 `d6ba9aa5-369f-492b-8c84-bc3562be1f2a`。使用另一个最长一小时的测试 Session，依次验证原版本、发布后版本和回退版本均能读取同一会话；最后只删除该测试 Session，并核对剩余为 0，真实 owner 会话未变。

回退选择凭证轮换之后的已验收版本 `255bf6b2-cbed-4f33-895c-379fa0852967`。首次请求因不支持的可选 annotation 被平台拒绝，health 确认版本未改变；移除该字段并重新核对后，以 `force=false` 保留平台的 Secret 变更保护，2026-09-11 12:23:34 UTC 回退成功。deployment 为 `bae13839-4716-4ca2-9505-3b6162c17e40`，100% 流量指向目标版本，成功提交及控制面读回约 2.75 秒。未轮换 Secret、回退数据库或修改 lifecycle。

回退后再运行真实备份 `database-backup-v1-20260911-post-rollback-255bf6b`：约 9.04 秒 complete，非 sleep 步骤均一次成功，导出仅需一次 poll，SQL 为 21,511 bytes，`sourceRevision` 等于回退版本。原生 R2 HEAD 通过当前恢复描述符校验，包括 11 个 metadata 字段、大小和实例身份；backup health 为 ok。该次未下载完整 SQL，不重复记为隔离恢复验收。真实备份对象按现有 30 天策略保留，46 分钟 lease 按设计自然到期。

最终确认活动版本的全部 binding 描述与演练前一致，UTC 19:00/20:00 两个 cron 未变、D1 外键检查为 0 个异常，production deployment 保持 `9c2d02eb-ba62-4eba-975b-7adb5b4a055d`。staging 当前实际运行 `640b8da` 对应版本；Worker `settings` 仍显示最新上传的 `7f9713a` 配置，不能据此判断当前运行 SHA。该差异触发了下节的发布脚本修复。

本地脱敏观察、复现脚本和中断探针保存在 `.output/staging-reliability-2026-09-11/`；该目录不是长期产物仓库，临时平台资源不是后续运行依赖。

### 4.10 活动版本配置校验修复

上述回退实测表明，Worker `settings` 与当前 deployment 的版本配置可以不同。原发布脚本以最新上传的 binding 判断既有 D1 归属及发布成功，却用另一份 deployment 记录判断 health 版本；两者不一致时可能接纳错误数据库，或把旧版本误记为发布成功。

现在迁移前与发布后都读取当前 deployment，要求单一版本承载 100% 流量，再从该版本的 `resources.bindings` 核对数据库归属、RELEASE_SHA 和其余必要 binding。HTTP health 必须命中同一个已核对版本。最新上传的 `settings` 只用于部署所需 Secret 名称及已声明 migration 摘要的保守检查，不能提供活动数据库的归属证明；目标库中的迁移记录仍独立校验。

四项回归分别覆盖“最新上传配置指向目标非空库、活动版本却指向其他库”、“上传 SHA 正确但活动 SHA 过旧”、“上传 DB 正确但活动 DB 错误”及“活动版本混合分流”。实际先在原实现运行：四项均错误地执行到部署成功，18 项既有对照通过；修复后 22 项发布脚本测试全部通过，脚本测试合计 6 文件、58 项通过。该修复不改变应用运行时、认证或 migration；§4.9 的真实发布使用修复前脚本，新脚本的远端发布结果见 §4.11。

### 4.11 2026-09-12 三地代理与 staging 收尾

owner 确认 [acceptance §4](acceptance.md#4-性能与真实环境验收) 的新性能目标，并授权最新 main 的 staging 发布、临时 OAuth grant 验收及文档提交；本次没有生产发布授权。测试来自江苏无锡，经现有订阅的 SG、JP、US 节点，由隔离的 loopback 代理发出 HTTP/1.1 请求；原代理配置不变，不代表大陆直连、全部代理节点或浏览器页面交互 SLO。

**部署选择。** 前一轮在同应用 SHA `640b8da` 下完成 Default 与 Smart 两组，各 195 个请求全部 200；每地区含 30 次 JWE、10 次 D1、5 次独立闲置首次请求。以下为客户端 TTFB，单位 ms；n=10 的 p95 等于 max：

| 节点 | Default / Smart JWE p95 | Default / Smart D1 p95 | Default / Smart 闲置首次 max |
| ---- | ----------------------- | ---------------------- | ---------------------------- |
| SG   | 148.263 / 253.648       | 275.205 / 402.420      | 1243.308 / 1209.562          |
| JP   | 298.990 / 279.937       | 1207.011 / 319.767     | 962.180 / 1102.278           |
| US   | 326.375 / 305.861       | 809.856 / 2529.488     | 1772.453 / 1491.759          |

该顺序对照没有控制全部连接和路由波动，不能证明 Smart 普遍更慢。固定连接的补测没有完成有效的双侧配对；其中 Smart 的 SG 缓存请求一次等待响应头 10,011ms 超时，无 CF-Ray，根因未定位。最终恢复 Default，保留 SIN 主库、读副本关闭；没有迁移数据或新增运行开关。Default 的 JP 1207ms 尾延迟继续保留，未用新门槛改写为通过。原两组平台记录分别取得 183/195 与 195/195，已取得记录均 outcome=ok；缺失的 12 条不能补记为已核验。

**最新发布。** 受保护 main 的 `a0a47366bbb93487d34a239f198584cebc9376b8` 使用 [CI 34600875945](https://github.com/eruoo/server/actions/runs/34600875945) 的原 staging 产物，由 [发布 34660336481](https://github.com/eruoo/server/actions/runs/34660336481) 成功部署。CI 的 301 项测试及两个环境构建通过，check job 178 秒、deploy job 37 秒，合计执行 215 秒；不含两次任务之间的等待，不代表已积累五次常规样本。发布阶段没有重复测试或构建，没有新增 migration。

活动 version 为 `51e28d2e-8da6-416d-addf-366944b45867`，deployment 为 `11f8c29f-74c5-458d-99dc-950b9da68668`；100% 流量、活动 binding 的 SHA、health 与 Default Placement 均读回一致。这次实际执行了 §4.10 修复后的发布脚本。相对 `640b8da`，变更仅为文档及发布脚本/测试，应用、依赖、配置和 migration 未变。

**OAuth。** 使用最长一小时的独立 owner 测试 Session，通过现有静态 client 完成真实 staging PKCE code→token→UserInfo→refresh→窗口内等价重放→旧 refresh 撤销 family→successor 返回 `400 invalid_grant`。实际 access token 配错误 hint 仍返回 `unsupported_token_type`；撤销 refresh 后既有 JWT 的 UserInfo 仍为 200，符合协议声明的最长一小时有效窗口。正式闭环 10 个 HTTP 请求均符合预期；这不是 Desktop App 联调，也不替代已完成的真实 GitHub/Passkey 登录。

探针的前两次 authorize 把库支持的 `200 {redirect,url}` 错当成必须 302 而中止，尚未兑换 grant；原生库按 fetch 请求头选择 JSON 跳转。探针改为接受并严格核验两种合法跳转形式后通过，未修改应用代码。两次未消费 code、正式 grant 的 refresh/access 行及 tombstone、四个临时 Session 均按精确关联清理并读回无残留，保留真实 owner 数据及审计。

**新版本性能。** 每地区预先固定 30 次 JWE 和 30 次 D1，不重试失败请求、不混入首连；JWE 组在缓存寿命内完成，逐条核验缓存发送且未被更换。TTFB p50 / p95 / max，单位 ms：

| 节点 | warm JWE（n=30）            | warm D1（n=30）             |
| ---- | --------------------------- | --------------------------- |
| SG   | 123.446 / 177.493 / 186.788 | 139.537 / 165.748 / 224.007 |
| JP   | 117.917 / 148.188 / 216.322 | 201.019 / 315.098 / 389.934 |
| US   | 216.179 / 242.785 / 306.997 | 398.034 / 479.798 / 506.604 |

SG 另做 10 对新连接请求：首次 D1 的 p50/p95/max 为 571.717/844.603/844.603ms，随后 JWE 为 138.569/162.035/162.035ms，20/20 成功。正式性能采样及 health 共 224 个请求全部 200、无超时；含 OAuth 的 234 个请求逐个按 CF-Ray 核心 ID、探针标记和精确 version 关联平台日志，234/234 outcome=ok、无异常及 exceededCpu/exceededResources。全体 CPU p50/p95/max 为 13/73/206ms，wall time 为 28/210/446ms；高 CPU 样本保留，不声称低于免费 10ms。远端未直接测得 D1 I/O 次数，零 I/O 依据仍为当前代码原生 workerd/D1 测试及对应 CI。

本轮三地 warm 达到已确认目标；JP 原有尾延迟及 SG 旧 Smart 超时本次未复现，不能称根因已修复。闲置专项引用同运行时代码的 Default 五轮：SG/JP/US 的 p50/p95/max 分别为 1059.906/1243.308/1243.308、927.007/962.180/962.180、1192.278/1772.453/1772.453ms，15 次均在新目标内；本次没有重新执行五轮闲置，历史原门槛失败仍有效。

**生产准备。** 同 SHA 的 production 原产物已下载，139 个文件摘要验证通过；只有 `0001_foundation.sql` 一项应用 migration，SHA-256 为 `e59e58d06fab0ae9f5c4bdbcfe01402e5b523e162fa7b2b4e9d2ed8d39c2b0ae`。只读检查确认目标库尚无应用表、生产 cron 为空、五个必要 runtime Secret 名称存在；R2 仍私有，保留现有 30 天删除规则。没有验证生产 Secret 值实际可用，也没有写入生产数据库。精确资源 ID 仍以 `wrangler.jsonc` 为唯一配置来源。

生产首次执行会初始化 schema/发布记录、更新既有 Worker 与 Workflow，并启用规格中的两个 cron。当前旧生产 version `d41e2778-cff7-43bd-a0e5-6d0008813a3d` 未验证与新 schema 兼容，不能作为已验收的 v2 代码回退目标。首次发布失败后先读回实际版本与迁移状态、保留数据库，再决定修复或重发；不自动回退数据库或旧 Secret。生产 deployment 始终为 `9c2d02eb-ba62-4eba-975b-7adb5b4a055d`，本次未改变。

脱敏观察与方法保存在本地忽略目录 `.output/region-placement-2026-09-11/`、`.output/staging-closeout-2026-09-12/`；临时代理与日志订阅已停止。这些不是日常运行依赖，原始凭证与日志不进入 Git。

### 4.12 2026-09-12 首次 production 发布与验收

owner 在查看精确候选与首次发布影响后回复 `go`，授权发布 `a0a47366bbb93487d34a239f198584cebc9376b8`、初始化生产空库、更新既有 Worker/Workflow、启用两项 cron，并验证真实登录和备份。本节覆盖 §4.11 当时尚未授权、尚未发布生产的状态；不扩大为其他版本发布、凭证轮换或资源删除授权。

**发布完成。** [production Actions 34664734368](https://github.com/eruoo/server/actions/runs/34664734368) 成功使用 [CI 34600875945](https://github.com/eruoo/server/actions/runs/34600875945) 的原 production 产物。发布前确认执行者为 owner、main 仍为目标 SHA，且目标 D1 无应用表。只有 `0001_foundation.sql` 被初始化，migration ledger、发布记录的目标库与摘要均读回通过，外键错误为 0。发布阶段没有重复构建或测试；CI check 178 秒 + production deploy 41 秒，合计执行 219 秒（3 分 39 秒），不含排队或两次任务之间的等待，也不代表最近五次常规样本全部达标。

生产入口为 `https://auth.eruoo.me`，Worker version `b15d69a3-9cd0-478d-9513-57d5e73ced88`、deployment `d06a31b6-e391-4ca8-8090-99f14069469d` 已读回，单一版本承载 100% 流量。活动版本的 SHA、全部 binding 描述和两项 cron 与已验证发布配置一致；Default Placement 与关闭读副本均已确认，本次 D1 查询实际由 APAC/HKG 处理。精确资源名与 ID 仍引用 `wrangler.jsonc`，没有删除 Worker、重命名资源或再次轮换 Secret。staging 仍为 §4.11 版本。

**生产备份通过。** 首次原生 Workflow 实例 `database-backup-v1-20260912-first-production-a0a4736` 于 01:27:02.814–01:27:12.740 UTC 完成，耗时约 9.93 秒；各执行步骤一次成功，终态 `complete`、健康状态 `ok`、失败码为空。原生 R2 HEAD 确认 SQL 对象 13,669 bytes、11 个 metadata 字段及源 Worker version 匹配，账号页可读取最近成功时间。此次实际验证了生产 export Secret 与导出到 R2 的完整路径；没有下载 SQL 或重复隔离恢复，恢复依据仍为 §4.8。该快照生成在首次成功登录之前，不能用它证明新注册身份已进入备份；后续由每日调度生成新快照。

**GitHub 登录通过，首个失败仍保留。** 首次浏览器 `POST /api/auth/sign-in/social` 在 01:27:06.564 UTC 返回 503，平台 wall time 285ms、无 Cookie、无原始异常或应用日志。它处于开始导出与首次轮询完成之间；[operations §4.1](operations.md#41-目标与保留) 所述 D1 导出阻塞是最可能原因，但缺少该请求的底层错误，不能记为根因已确认或代码已修复。导出完成后的受控登录入口探针为 200；浏览器一次重试的入口为 200、GitHub 回调为 302，随后正常进入管理台。只读数据库核验为唯一 owner GitHub 账号、一条有效身份关联，`github_login/success` 审计已落库；账号页与备份状态读取通过。Secret 实际可用不再仅依据名称推断。

**生产 Passkey 通过。** owner 按日常本机浏览器验收步骤确认完成注册、退出并用 Passkey 重新登录。02:11 UTC 只读复核确认生产 owner 名下有 1 个 Passkey，`passkey_created/success` 与后续 `passkey_login/success` 审计分别为 02:08:16.885 和 02:08:41.018 UTC；两次 HTTP 状态均为 200，均关联到正确 owner。已有有效 owner Session，外键错误为 0，当前 production deployment、版本和全部 binding 描述保持不变。此项依据本人设备验证反馈与持久审计、凭证及会话读回完成，没有使用 staging 凭证、重放设备操作或读取凭证值。脱敏回执为下述证据目录的 `passkey-verification.json`。

生产首次发布、GitHub/Passkey 登录与备份验收已完成。生产多地区性能未重新采样，§4.11 的 staging 结果不转记为生产实测；下节保留其余验证限制。

首次发布的实时日志订阅结束前，采集到 15 条目标版本 invocation，均 outcome=ok、无平台异常，其中仍包含上述 HTTP 503，不能将平台 outcome 等同于业务成功。日志订阅已停止，这 15 条不包含随后 owner 的本机浏览器 Passkey 验证。执行回执及脱敏请求证据保存在本地忽略目录 `.output/production-release-2026-09-12/`；原始 tail 日志仅在本机以 0600 权限保存，不进入 Git。这些文件不是运行依赖。

### 4.13 2026-09-12 staging 导出与登录对照

owner 授权收尾文档、核验首次自动调度并定点排查 §4.12 的登录 503。在已验收的 staging 版本上连续执行两轮“导出前 → full SQL export active → 导出完成”对照，直接调用与备份 Workflow 相同的 D1 export API；没有下载 SQL、写入 R2、创建新 Workflow 实例或修改应用代码、配置、Secret。开始前确认没有活动备份实例及未到期 lease，使用固定 5 秒轮询并等待既有 export 完成。

每个阶段并发请求同一个登录入口、D1 REST 的 `SELECT 1`、无 Cookie 的 `get-session` 与 `health`。两轮导出前四项均为 200；导出期间两轮登录均为 503，D1 直接查询均为 500 / API code 7500，同时两个不依赖凭证数据库读取的对照仍为 200，匿名 Session 均为 null。第一轮导出结束后四项恢复 200。第二轮结束后数据库与两个只读对照恢复 200，但登录因连续探针触发原生 429；保留该失败，不能将两轮都写成完整通过。118 秒后独立核对登录入口为 200 且合法 GitHub 跳转已生成，没有再次启动 export。锁定库的核心 `/sign-in*` 规则为 3/10 秒，区别于通用 100/60 秒配置，详见 [operations §2](operations.md#2-限流与成本边界)。

18 个 Worker 请求均按 CF-Ray、探针标记和精确版本关联到原生 tail，全部平台 outcome=ok、无异常；两条 HTTP 503 的平台 wall time 分别为 254/212ms，均无应用错误日志。118 秒后的恢复请求未采集到这组实时 tail，单独保留 HTTP 与清理回执，不补计为平台已关联。最初探针在启动 export 前被平台以 403 / code 1010 拒绝；同一 health 使用明确的诊断 User-Agent 和 curl 均为 200，改用诊断标识后才开始正式对照。该探针入口问题不归为应用 503。

这次控制变量实测确认：D1 完整导出会使依赖数据库的登录入口短暂失败，登录入口在导出结束、限流窗口结束后恢复，应用版本和配置保持不变。生产首次失败的发生阶段、响应和耗时与此一致，但原请求缺少底层错误，不能补造逐请求异常证据。继续采用已确定的凌晨备份与有界轮询，不增加自动登录重试或更换认证架构；本次没有修复应用代码，也不声称导出期间零中断。

三条正式对照及一条补充恢复请求生成的临时 OAuth state 均按返回的精确 identifier 清理，四条删除后读回零残留；未兑换 GitHub code、创建 Session 或 grant。外键检查为 0，staging/production 的 deployment 均未变。脱敏结果、方法和平台关联记录保存在本地忽略目录 `.output/production-closeout-2026-09-12/staging-export-login/`；实时 tail 已停止，私有选择器与原始日志不进入 Git。首次自动调度的核验已安排在北京时间 2026-09-13 04:10，届时分别核对 03:00 备份和 04:00 清理的实际执行证据；安排完成不等于任务已经执行。

### 4.14 2026-09-18 AI 状态存储切片（本地实现）

按 owner 指定的切分，先合入 AI 状态存储、有界清理与安全恢复，AI HTTP、AI Key 配置档、管理页面与上游连接器不随本切片开放（范围调整记录见 [acceptance §5.2](acceptance.md#52-各切片开放的能力)）。本次为本地代码与验证交付：未提交、未推送、未创建 PR、未迁移任何远端数据库、未部署。

- 迁移：新增 `migrations/0002_ai_service.sql`（`ai_connections`、`ai_authorization_sessions`、`ai_models`、`ai_invocations` 四张应用表及索引），`0001_foundation.sql` 未改动；`src/worker/db/schema.ts` 同步 Drizzle 声明。API Key 与权限继续使用原生插件表。
- 存储操作（`src/worker/ai/`、`src/shared/ai.ts`）：连接创建/更新/断开/删除（slug 唯一且不可变、删除后重建新 UUID）；授权会话绑定 owner/Session/连接版本，poll claim 单赢家；授权完成与连接凭证更新在同一 D1 batch 内以互补 guard 实现全有或全无提交，并断言 `meta.changes` 一致；刷新 claim 获得后过期即转入需重新授权（不重用可能已轮换的凭证）；模型快照按凭证版本条件整体替换；reservation 用单条条件 INSERT 同时检查全局 2 /单 Key 1 在途名额，满额零写入、不等待，lease 为 deadline+30 秒；无终态记录在 lease 过期后读作 unknown，缺失 usage 不补零。D1 是唯一跨请求事实来源，不使用模块级 Promise，不复用 maintenance_lease。
- 清理：`cleanupExpiredAiState` 接入既有 `0 20 * * *` 调度，删除到期授权会话（含加密设备授权数据）与超过 30 天保留边界的调用元数据；边界 `createAiInvocationRetentionCutoff` 集中于 `src/shared/ai.ts` 供读取与清理共用；每类最多 10 批 × 500 行，超额记录脱敏 backlog。未新增 Cron、未改备份调度。
- 恢复：`inspectBackupSql` 按已验证原始表集生成清理 SQL、authorizer 与断言——仅 0001 的快照不执行 AI 表语句；含 AI 表的快照删除授权会话、清空凭证与刷新 claim、推进连接版本进入需重新授权、把在途调用记为 unknown（endedAt=leaseExpiresAt），保留连接配置、终态历史与模型快照。恢复顺序统一为“隔离导入 → 原始 schema 上清理验证 → 向前迁移 → 完整核验 → receipt → 重建信任”，CLI `nextAuthorizedSteps` 与本地语义校验同步修正（此前 CLI 指示先迁移）。导入 authorizer 的函数白名单因 `ai_connections` slug CHECK 增加纯函数 `length`/`glob`，其余拒绝不变。

复审修复（2026-09-18 同日）：授权完成移除独立 connectionId 入参，目标连接只能由会话绑定派生，条件失配时两张表零写入（不再依赖 batch 后断言兜底）；刷新 claim 与 poll claim 改为 `UPDATE ... RETURNING` 单语句原子快照，消除“写后另读”窗口（授权会话创建同样改为 `INSERT ... SELECT ... RETURNING`）；刷新提交增加 claim 有效期条件，恰好到期即拒绝并归类为 `refresh-claim-expired`，过期结果不再写入新凭证；单条调用读取接入共享 30 天保留边界。以上修复不新增表或迁移。

验证（本地，workerd + 本地 D1、合成数据）：`tests/worker/ai-state.test.ts` 23 项——迁移与 schema 约束、slug 规则、并发唯一 slug、poll/刷新 claim 单赢家、取消/断开/删除/owner Session 撤销后的迟到提交拒绝、完成 batch 故障回滚（合成 trigger）、并发 reservation 不超限、满额零插入、lease 过期 unknown、30 天读取/清理共用边界、500/10 批上限与 backlog、调度失败传播、索引使用计划，以及复审回归：同版本邻近连接不被越权完成、版本推进后无部分提交、claim 交错（首个语句后注入重授权/取消）仍返回本次认领快照、claim 到期前/恰好到期/到期后提交、单条读取保留边界；`scripts/restore-database.test.ts` 29 项——0001 与 0001+AI 两类快照 × 有无 deployment receipt、部分表集与旧 ledger 拒绝、AI 清理保留终态历史与模型参考、CLI 实际生成 SQL 可在原始 schema 执行且步骤顺序与本地校验一致。既有 worker 与脚本测试全部通过；`pnpm run check`、两环境 `build:release` 本地产物验证通过（来源标记 local，不作为 CI 正式发布记录）。未验证：真实上游授权/刷新/模型发现、staging 迁移与恢复演练、远端部署。

### 4.15 2026-09-19 PR 3：Codex 连接、设备授权、刷新与模型发现（本地实现）

按本轮 owner 授权的 PR 3 切片交付上游凭证生命周期与管理编排，AI HTTP 正式路由仍未注册（`/api/ai/*` 在实际根装配继续 404，OpenAPI 仅随新增授权审计事件扩展事件枚举，不新增 AI 接口）。本次为本地代码与验证交付：未迁移远端数据库、未部署、未执行真实上游授权。

- 连接器（`src/worker/ai/codex-connector.ts`）：固定 `openai-codex` 定义——issuer `https://auth.openai.com`、client `app_EMoamEEZ73f0CkXaXp7hrann`、设备验证页、usercode/设备令牌/交换/刷新/模型目录端点与 JWKS 地址全部为代码常量，不开放任何上游 URL/Host/认证头配置；逐字段校验固定参考契约（详见 ai-service §14 连接器固定契约），未确认的上游行为（非第一方 originator 待遇、FedRAMP、audience 形态、默认有效期）已在该表标注“待实测”，不宣称兼容。ID token 验签（RS256+issuer+audience+exp、按次获取 JWKS）通过后才提取 `chatgpt_account_id`/`chatgpt_user_id`；上游错误正文一律不透出。
- 凭证加密（`src/worker/ai/credential-cipher.ts`）：AES-256-GCM、随机 96-bit IV、版本化 keyring（`AI_CREDENTIAL_KEYS` 为 `<version>:<base64url 32B>` 逗号列表）；密文信封含格式版本与 key ID；AAD 绑定环境、连接 UUID、提供方与用途（credential-package/device-grant）；旧 key 只读、新写用当前 key；篡改、AAD 错配、key 缺失与非法 keyring 均显式失败。Secret 按操作按需解析，不缓存、不进入模块初始化路径。
- 授权编排（`src/worker/ai/authorization-flow.ts`）：复用 PR 2 的会话绑定/claim/版本/原子完成；每次 poll 一次上游检查并遵守 nextPollAt 与上游间隔（interval 字符串解析、默认 5s、≥1s）；设备授权临时数据加密存储；授权码交换与验签后、提交凭证前重新读取持久 Session 复核近期认证（15 分钟）与未撤销，不复用先前检查；重授权保持原账号与工作区（工作区由原子完成 guard、用户 ID 由存储包比对）；取消、退出、过期、断开、删除与版本变化均由 guard 阻止迟到写入。审计新增 `ai_authorization_started/completed/cancelled`（allowlist：connectionId、providerType），pending poll 不写审计。
- 刷新编排（`src/worker/ai/credential-lifecycle.ts`）：提前 60 秒刷新；D1 claim/版本/有效期协调；刷新网络 10 秒含 body 且受阶段剩余预算截断（`stage-budget.ts` 维护单次 10s/合计 20s/阶段 30s，不随阶段切换重置）；预算耗尽于发出前→释放 claim、保留凭证、可重试；400 invalid_grant（含 legacy 码）与 401→确定终局；已发出的其余失败（5xx/429/超时/传输/不可解析 200）与 claim 过期、落库失败→结果不明，转入需重新授权（`markAiConnectionReauthenticationRequired`，不清 pending 授权会话）；并发提交竞争→重读后采用胜者凭证或报告断开态；解密失败的存储包按不可读终局处理。
- 模型发现（`src/worker/ai/model-discovery.ts` + `authorizations.ts`）：发现由独立请求触发（授权完成后前端另发刷新）；首次失败即未发现、不宣称可用，后续失败保留旧快照并单独报错；普通刷新不动模型目录；重新授权在同一原子完成 batch 中删除旧快照（guard 比对推进后版本），重新发现成功前目录读作未发现——重发现门槛由此成立；模型 ID 精确保存，能力只记录上游确认字段（reasoningEfforts/supportedInApi/visibility），>200 条目录按协议失败拒绝。
- 管理预算与状态（`src/shared/ai.ts`）：新增管理阶段 30s、上游合计 20s、单次 10s、刷新网络 10s、轮询默认/下限间隔、密文长度与 recent-auth 窗口常量，集中维护。

验证（本地，workerd + 本地 D1、合成 JWKS/令牌与受控 fetch 夹具）：`tests/worker/ai-codex-authorization.test.ts` 27 项与 `tests/worker/ai-credential-refresh.test.ts` 28 项（共 55 项，含复审新增的刷新分类器两项）——正常授权（含固定 client/端点/重定向断言）、拒绝、取消、过期、多标签单检查、退出/旧 Session、错误账号/工作区、迟到交换（断开/版本竞争）、密文篡改、AAD 错配、keyring 轮换（旧读新写）、并发刷新 busy（Retry-After）、刷新各类失败窗口（未发出/invalid_grant/401/5xx/传输/超时/claim 过期/落库竞争/断开竞争）、合并语义、模型发现全部状态与重新授权门槛、阶段预算耗尽零外呼、正式入口 404。既有测试全部通过，`pnpm run check` 全量通过。未验证：真实上游授权/刷新/模型发现、`AI_CREDENTIAL_KEYS` 真实轮换、staging 联调。

### 4.16 2026-09-19 PR 4：Responses 子集与有界 SSE/JSON 协议（本地实现）

按本轮 owner 授权的 PR 4 切片交付 Responses 调用协议的请求子集与共用响应解析，网络调用编排（transport 接线）留给 PR 5；AI 正式路由仍不注册，`/api/ai/*` 继续在实际根装配 404。

- 请求校验（`src/worker/ai/responses-request.ts`）：严格子集 schema（§6.2 精确边界见 ai-service.md PR 4 落定记录）——支持文本、内联 PNG/JPEG/WebP data URL 图片、多轮消息、函数工具定义与结果、reasoning 回放项、结构化输出（json_schema）与推理 effort；未知或不支持字段（含 temperature/max_output_tokens/metadata/top_p、远程图片 URL、`detail`、reasoning.summary、json_object、tool_choice "required" 等）一律 422（未知顶层字段由 zod 4 合并为单条 root 条目并列出全部键名，已知字段的非法值带精确路径），不静默删除；schema 为 zod 声明，PR 7 直接复用于 OpenAPI。
- 共用协议（`src/worker/ai/responses-protocol.ts`）：增量 SSE 解析（TextDecoder 流式跨 UTF-8/跨行/跨事件分块重组、CRLF、多 data 行、注释与 id/retry 忽略、单事件 4 MiB 上限）；JSON 与 SSE 共用同一终态解析——按 output_index 有界收集 `response.output_item.done`，终态 output 为空时按序替换、非空时按 item id/call id/output index 补缺项并为同索引终态项补齐缺失 id，同索引不同项即冲突报协议错误，delta 永不参与补全，补全后重查 4 MiB；completed/incomplete/failed/error/EOF 无终态分别处理；流内失败按固定参考分类（额度不足+校验后重试提示 / 需重新授权 / 上游不可用 / 协议错误），上游错误正文不透出；累计上游读取 8 MiB；AbortSignal 中止返回 aborted。
- 下游写出（`src/worker/ai/responses-sse.ts`）：单写者顺序写出的有界缓冲 ReadableStream（高水位 64 KiB，背压传播到上游读取循环，慢消费者不产生无界缓冲）；15 秒注释心跳仅在缓冲清空时发送、背压时跳过、终态后停止并计入 8 MiB 传输预算；超预算帧不写出并以单一脱敏 `event: error` Problem 收尾（允许小额度超限携带终态错误）；消费者取消后写出为无操作；Problem 注册表新增 §6.3 六个 AI 类型。
- 复审修复（独立 review 两轮）：第一轮——背压下到期待心跳不再自旋（心跳等待缓冲排空的 drain 通知，至多一个挂起；预算不再容纳心跳时永久停发）；预算近耗尽时终态错误事件仍以有界小额度超限送达（此前会被静默丢弃）；单事件与终态上限改为按 UTF-8 字节计（含未闭合事件的增量计数）；心跳写入计入预算；终态 output 非数组按协议失败；终态早于 EOF 时释放上游读取；测试补充真实多字节切分点。第二轮（复审复核第一轮修复后）——修正增量字节计数对跨块拆分行的重复计数（此前一个 3 MiB 合法事件分 8 块送达会被误判超限，已补回归测试）；近耗尽回归测试改为精确帧长填充至剩余额度小于终态错误帧（此前留有 58 KiB 余量，旧缺陷形态下也能通过）；校验器文档纠正 zod 4 对未知顶层字段合并为单一条目的描述；移除无引用的 responsesSupportedImageMediaTypes 导出。复审同时确认：自旋修复的所有路径（含预算拒绝与 drain 竞争）均阻塞于真实状态变更、pendingRead 不丢失不重复消费；终态错误有界超限仅限单个错误帧、数据帧仍严格受预算约束。
- 验证：`tests/worker/ai-responses-protocol.test.ts` 39 项——字段接受/拒绝矩阵、任意分块（逐字节推送、真实多字节切分）、多 data 行/CRLF/注释、4 MiB 单事件与 8 MiB 累计边界、补全/缺项/id 补齐/冲突/孤儿项/非数组拒绝、delta 忽略、completed/incomplete/usage、额度（resets_at/resets_in_seconds/非法值）、认证/限流/容量/未知分类与正文不泄露、EOF/不可解析/中止、背压传播、心跳（含管道集成、背压等待不自旋、终态后停止）、慢消费者取消、传输预算收尾错误与近耗尽送达（精确帧长填充）、跨块拆分行计数一次、JSON/SSE 等价终态。`pnpm run check` 全链通过。未验证：真实上游事件流（分类码集合按固定参考实现，标注待实测）；transport 接线与路由在 PR 5/7。

### 4.17 2026-09-19 PR 5：Responses 网络调用编排（transport，本地实现）

按本轮 owner 授权的 PR 5 切片交付 Responses 调用的网络编排：从已准入调用（路由层预留的名额、已验证的 Key 与模型许可、已读取并校验的请求体）到下游响应与终态落库的全部阶段。AI 正式路由仍不注册，`/api/ai/*` 继续在实际根装配 404；路由接线、AI Key 配置档与 OpenAPI 注册留给 PR 7。

- 连接器上游请求（`src/worker/ai/codex-connector.ts`）：`buildCodexResponsesRequest` 固定 Responses 端点 `https://chatgpt.com/backend-api/codex/responses` 与请求头（`content-type: application/json`、`accept` 随模式、`authorization: Bearer`、`chatgpt-account-id`（有则带）、`originator: eruoo`、`user-agent: eruoo/1`），与固定参考 CLIProxyAPI 7bbfeaf（`codex_executor_stream.go` 的 `baseURL + "/responses"` 与 `codex_executor_request.go` 的 `applyCodexHeadersFromSources`）逐项核对后记入 ai-service.md §14 契约表；调用者不能覆盖目标地址或认证。
- 调用编排（`src/worker/ai/responses-transport.ts`）：凭证阶段（每次进入上限 15 秒、含刷新网络 10 秒，受总 deadline 截断；到期前 60 秒内或 401 后强制走单写者刷新；窗口按进入阶段起算、时钟用真实时间，避免准入耗时吞掉必需刷新）→ 上游调用（首次响应上限 90 秒，每次尝试独立超时控制器）→ 上游静默上限 90 秒与总 deadline（取调用方值与共享 300 秒策略的较小者）；上游恒以 SSE 请求（JSON 模式读取同一事件流后返回终态对象，与 §6.2 一致）。上游 200 前的一次 HTTP 401 允许强制刷新一次并重发一次，重发仍 401 则标记连接需重新授权并返回 `ai-reauthorization-required`；裸 429 与 5xx 判为 `ai-upstream-unavailable`，其余非 2xx 判为 `ai-upstream-protocol-error`（不把裸 429 当额度耗尽）。
- 预算与超时语义：握手前超时用既有 `request-timeout`（504）；流内静默超时与总 deadline 判为 `ai-upstream-unavailable`（503），SSE 模式仍向可写连接送达 `event: error` 终态，只有客户端自身取消才抑制投递。总 deadline 计时器随流存活，流结束才释放。
- 协议消费者扩展（`src/worker/ai/responses-protocol.ts`）：`consumeResponsesUpstream` 新增 `noDataIntervalMs`（每次等待读取时起算、仅数据重置、心跳不重置）与 `deadlineSignal`（绝对 deadline，与客户端取消区分；既是循环边界检查也是竞速参与者，即使运行时在 abort 时不使 body 流出错也能及时收束），两者都判为 `failed: unavailable` 而非 aborted，保持“可写连接必须收到终态”的契约；原有中止/背压/心跳语义不变。
- 终态落库：每个终态（含失败，含非 2xx 与 200 无 body 等上游失败路径）提交调用结果——completed→succeeded、incomplete→incomplete、failed/protocol-failure→failed（errorCode 为受控 Problem slug）、客户端取消→unknown（不宣称上游已停止计量）；记录上游 `x-request-id`（≤128）与实际 usage（≤4096 字符，超限记 null）。落库无法落地（invocation 不存在或已终态）视为不变量破坏并拒绝结算，不谎报成功。SSE 模式返回 `{response, settled}`，`settled` 在流关闭并完成落库后结算，调用方须用执行上下文保活并处理其拒绝。流内“需重新授权”分类不标记连接（仅 200 前的确定 401 重发失败或凭证服务自身的刷新裁决会标记），避免瞬时上游鉴权抖动清空可用凭证。
- 复审修复（独立 review 两轮）：第一轮 approve-with-fixes——凭证阶段窗口改为按进入阶段起算（此前从调用起始时刻冻结，准入耗时 >15 秒时静默跳过必需刷新，并可能在短预算刷新超时后误判“结果不明”而清空凭证；已补“晚进入仍刷新”回归测试）；凭证服务时钟改用真实时间（此前写死调用起始时刻，会把 claim/updatedAt 与凭证到期写早，且当起始时刻早于连接创建时刻会触发 D1 CHECK 失败）；总 deadline 收敛为与共享 300 秒策略取小；首次响应超时控制器改为每次尝试独立（此前复用已 abort 的控制器会误杀同回合到达的响应体）；非 2xx 等失败路径也记录上游 `x-request-id`；落库未成功时拒绝结算而非静默成功。第二轮复核确认六项修复全部正确、无新缺陷（并实证 F1 回归测试在旧形态下失败、新形态下通过；计时器无泄漏；落库不变量仅在真实未落库时抛出）。复审确认：deadline 计时器随流存活并在所有路径释放、401 恰好一次强制刷新与一次重发、deadline/静默超时不被误分类为 missing-terminal、无忙自旋与读取丢失。已知限制（复审标注）：静默与 deadline 预算在读取/事件之间求值，下游写入被背压阻塞期间暂停计时，客户端断开即自愈；凭证阶段 15 秒约束刷新网络调用而不含其中的 D1 读写，故为近似上限。
- 验证：`tests/worker/ai-responses-transport.test.ts` 19 项——SSE 成功（地址/头/归一化请求体/终态/usage/上游 requestId 落库）、JSON 模式终态对象、incomplete 终态、401→强制刷新→重发成功（凭据版本推进、重发用新令牌）、重发仍 401（标记重新授权）、裸 429（含上游 requestId 落库）与 400 分类、首次响应超时（504）、握手前总 deadline 到期（504）、静默超时（SSE 内 `event: error` + 503）、无终态 EOF（502）、客户端取消（unknown）、凭证忙（503 + Retry-After）、晚进入凭证阶段仍刷新、总 deadline 中途到期（静默读取被收束为 503）、超限 usage 记 null、上游 200 无 body（502）、超长 deadline 收敛到共享 300 秒策略、落库无法落地时结算被拒绝。`pnpm run check` 全链通过（worker 378、client 36、scripts 66、e2e 6）。未验证：真实上游事件流与真实 401/额度行为（分类码集合按固定参考实现，标注待实测）；路由接线与 OpenAPI 在 PR 7。

### 4.18 2026-09-19 PR 6：AI Key 配置档与模型授权（本地实现）

按本轮 owner 授权的 PR 6 切片开放 AI Key 配置档：`purpose=ai` 创建 AI 档 Key、`modelIds` 选择模型许可、网关与插件两档并存。AI HTTP 路由（§6.1/§6.2）、管理界面与部署配置（`AI_CREDENTIAL_KEYS`、`AI_RATE_LIMITER`、`enable_request_signal`）仍留给 PR 7；`/api/ai/*` 继续 404。

- 共享契约（`src/shared/api-key.ts`）：新增 `API_KEY_AI_PURPOSE`/`API_KEY_AI_CONFIG_ID`、固定 operation（`ai: ["invoke","models:read"]`）、`ai-model:<连接 UUID>` 权限键构造，以及对外模型 ID 的格式化与解析（按第一个斜杠切分，上游部分保留原始大小写与内容，不做折叠/去空白/解码）。
- 模型授权（`src/worker/ai/model-authorization.ts`）：存储的权限 JSON 一律按不可信输入读取（非数组或非字符串项视为无授权，非法连接 ID 跳过而不是抛错）；owner 选择的对外模型 ID 按“连接 slug → 连接行 → 目录中的精确上游模型 ID”解析（未知/重复/未连接/已禁用一律拒绝，非法 slug 视为未知而不是抛错）；权限按连接 UUID 分组构造并排序；调用授权同时校验 `ai:invoke` 与精确模型许可；目录列举只返回当前目录中仍存在的许可，已删除连接的授权自然失效（连接重建复用 slug 也不会复活旧 UUID 的授权）。
- 网关（`src/worker/auth/api-key-management.ts`）：`configId` 扩展为 default/ai；创建时 `purpose=ai` 必须携带非空 `modelIds`（default 档拒绝该字段），服务端解析后构造 `permissions` 并调用插件服务端 API（不传浏览器 headers）；更新时 ai 档可改 name 与 `modelIds`（省略保留、空数组撤销全部模型许可、非法选择拒绝），default 档拒绝 `modelIds`；列表/读取/删除显式携带档位。审计沿用既有 api_key_created/updated/revoked 路径事件（§7 要求的 `configId` 与权限变更数量尚未加入事件 metadata，登记为待办，不声称已满足）。
- 插件配置（`src/worker/auth.ts`）：插件改为显式声明两个配置档（default 与 ai）。插件对未声明的 configId 会回退到 default 配置：ai 档创建会静默落成 default 档（配置档降级），其他跨档操作则因档位不匹配判为 KEY_NOT_FOUND。因此网关接受的每个档位都必须在插件侧声明（本轮实测发现并修正）。
- 生成文档：五个 `/api/auth/api-key/*` 契约随档位扩展更新（`docs/openapi.json` 重新生成）；AI 接口契约仍不注册。
- 验证：`tests/worker/ai-model-authorization.test.ts` 7 项（精确解析、重复/非法/未知拒绝、UUID 绑定与排序、双条件授权、目录过滤、slug 复用后旧授权失效、对外 ID 解析与格式化）；`tests/worker/api-key-management.test.ts` 30 项（原 28 项按新契约更新：ai 档已开放、未知档仍拒绝、跨档隔离保留；新增 AI 档创建权限构造与更新替换/保留/撤销）。`pnpm run check` 全链通过（worker 387、client 36、scripts 66、e2e 6）。未验证：真实上游（不变）；AI 路由与部署配置在 PR 7。

### 4.19 2026-09-19 PR 7（进行中）：AI 调用端点与部署配置（本地实现）

按本轮 owner 授权的 PR 7 切片注册 AI 调用端点并落地部署配置声明。本记录随切片推进更新：§6.1 管理端点与 §6.2 调用端点均已交付；管理界面与发布读回验证仍在进行中。

- 调用端点（`src/worker/ai/invocation-routes.ts`）：`GET /api/ai/models` 只列当前 Key 被授予且仍在目录中的模型；`POST /api/ai/responses` 走单载体规则（仅 `x-api-key`，Cookie/Bearer 一律 401）、`AI_RATE_LIMITER` 粗入口限流（60 次/60 秒）、Key 校验与 owner 绑定、8 MiB/15 秒有界读体（超限 413、超时 504）、严格子集校验（422）、按目录解析模型 ID 并同时校验 `ai:invoke` 与精确模型许可（未知模型与未授权模型同样返回 403，不做目录探测）、D1 条件写入准入（满员 429 + Retry-After: 1）、随后调用 PR 5 的编排并把 `settled` 交给执行上下文。准入预算 5 秒、总 deadline 300 秒。
- 部署配置声明：`wrangler.jsonc` 三处环境新增 `AI_RATE_LIMITER`（staging 1005 / production 1006 / local 1007，三类 limiter、两环境共 6 个互不重复 namespace），staging/production/local 的必需 Secret 增加 `AI_CREDENTIAL_KEYS`，新增 `enable_request_signal` 兼容标记；`pnpm run types:generate` 已重跑。发布脚本（`scripts/deploy-release.ts`）同步校验三类 limiter、限额与 6 个必需 Secret，测试夹具更新。`.dev.vars` 与 `.dev.vars.example` 增加本地合成 keyring（格式 `1:<base64url-32 字节>`）。
- 生成文档：`docs/openapi.json` 随两个新契约重新生成（调用端点契约进入生成文档；管理端点契约随 §6.1 交付时加入）。
- 管理端点（`src/worker/ai/management-routes.ts`）：§6.1 全部 12 个契约——providers、connections（GET/POST/PATCH/DELETE）、disconnect、authorizations（start/read/poll/cancel）、models/refresh、invocations 历史。读取要求 owner Session、变更要求 recent owner Session；授权会话的读取/poll/取消绑定创建它的 Session；连接视图只含身份、状态与模型快照（不含凭证与授权内部字段）；管理上游阶段预算 30 秒；连接创建/更新/断开/删除写入新增的 `ai_connection_created/updated/disconnected/deleted` 审计事件（metadata 仅 connectionId 与 providerType），授权事件经 flow 的 sink 复用既有枚举。
- 复审修复（独立 review 一轮，approve-with-fixes）：管理变更补齐精确 Origin 与 JSON content-type 校验（SameSite 不能替代 CSRF 防护）并按 `AI_RATE_LIMITER` 计入粗入口限流；管理请求体改为 1 MiB 有界读取（413）；调用路由增加便宜的满员预检（在读取请求体之前拒绝），并把模块注释改为与真实顺序一致——模型 ID 来自请求体，因此权威 reservation 必然在读取之后，§7 的“取得名额后读体”由预检加原子写入共同满足（§7 的字面顺序在模型来自请求体的约束下不可直接实现，登记为设计澄清项）；非法模型 ID 从 503 改为不可解析（403）；`settled` 拒绝改为记录受控事件而不是逃逸为未处理拒绝；PATCH/创建的名称长度上限与存储层一致；poll 的 session-mismatch 统一为 403；生成契约中 AI 操作的请求/响应 schema 仍为骨架，登记为待办。
- 验证：`tests/worker/ai-management-routes.test.ts` 4 项（管理路由无凭据一律 401（覆盖 7 个操作）、连接生命周期含审计集合与模型快照、精确 Origin 与 1 MiB 有界读体、输入校验与调用历史分页/游标拒绝）；`tests/worker/ai-invocation-routes.test.ts` 6 项——目录只列被授予模型、会话/Bearer/缺失载体一律 401、未知 Key 401、未授权模型 403（与未知模型同答）、非法请求体 422、流式成功（上游 mock）并提交 `succeeded` 调用记录、满员 429 + Retry-After 且既有 reservation 不被改写。`pnpm run check` 全链通过（worker 397、client 36、scripts 66、e2e 6）。未覆盖：PATCH/DELETE 连接、授权 start/read/poll/cancel 与 models/refresh 的 401 边界（已登记为待补测试）。边界测试同步：`ai-codex-authorization` 改为断言全部 /api/ai 路由无凭据时返回受控 401（不再是 404），`contract-boundaries` 的生成文档 operation 计数更新为 24（含 14 个 AI 契约）。未验证：真实上游（不变）；管理界面未交付。

### 4.20 2026-09-19 PR 8/PR 9：AI 管理界面（本地实现）

按设计 §9/§12 交付 AI 管理界面的第一部分：AI 连接管理面板。本记录随切片推进更新。

- 客户端 API（`src/client/features/ai/ai-connections.ts`）：复用 `deadlineFetch` 与既有 Problem 解析，覆盖连接列表/创建/改名/启停/断开/删除、设备授权启动与轮询/取消、模型目录刷新；服务端规则不在客户端复制。
- 面板（`src/client/features/ai/AiConnectionsPanel.vue`）：连接快照（状态、启停、凭证到期、模型摘要）、创建（slug 不可变并做前端格式提示）、逐连接改名/启停/刷新模型、设备授权两步流程（展示官方验证页与一次性 user code、手动检查状态、取消）、断开与删除均走既有确认组件；复用 `useManagedList` 的忙碌态、recent-auth 重验证与错误提示。路由 `/security/ai-connections` 与导航入口随面板加入。
- 验证：`tests/client/ai-connections.test.ts` 2 项（连接快照渲染 + 授权流程展示代码并在完成后清除并重载、确认断开调用服务端）；`pnpm run check` 全链通过（worker 397、client 40、scripts 66、e2e 6）。
- AI Key 档位界面（同一记录内续交付）：`api-keys.ts` 增加按档位读取/创建/改名/删除与 AI 档模型许可更新（客户端始终显式携带档位，不跨档汇总）；`ApiKeyPanel.vue` 增加档位切换（状态密钥 / AI 密钥）、创建时的模型许可多选（候选来自各连接的目录快照，对外 ID 为 `slug/上游模型 ID`）、以及每个 AI 密钥的许可编辑器（展示时把存储的连接 UUID 许可映射回对外 ID，保存即整体替换）。验证：`tests/client/api-key-ai-profile.test.ts` 2 项（AI 档创建携带所选 modelIds、既有密钥的许可展示与整体替换），原 `api-key-panel` 测试按新函数名更新。
- 调用记录视图（同一记录内续交付）：`ai-invocations.ts` 按 `(startedAt, requestId)` 游标分页读取 `GET /api/ai/invocations`（默认 50 条），`AiInvocationsPanel.vue` 展示终态、受控错误码、起止时间、上游请求号与用量（仅从良构 usage JSON 读取 total_tokens，缺失显示未知），提供加载更多与刷新；路由 `/security/ai-invocations` 与导航入口随面板加入。验证：`tests/client/ai-invocations.test.ts` 2 项（元数据渲染 + 游标翻页追加且末页隐藏按钮、usage 读取的良构边界）；e2e 深链覆盖扩展到两个 AI 页面（匿名访问只挂载登录边界、不出现 AI 控件）。`pnpm run check` 全链通过（worker 397、client 42、scripts 66、e2e 6）。
- 已登记差距的收尾（同一分支）：① §7 审计 metadata 补齐——`api_key_created/updated` 事件现在携带 `configId` 与 `modelGrantCount`（`revoked` 携带 `configId`），由网关把档位与许可变更数量交给审计调度器，allowlist 同步扩展，并有断言覆盖；② §6.1 全部 12 个操作的“无凭据一律 401”边界测试补齐（此前覆盖 7 个）。
- 复审与修复（独立 review 一轮，reject）：两个 blocker 均为线协议不匹配——① 六个无请求体的管理变更（断开/删除/刷新模型/授权启动/轮询/取消）未携带 `content-type: application/json`，被服务端的精确 content-type 校验以 415 拒绝；② AI 档许可更新未携带 `name`，被网关以 422 拒绝。修复：六处补齐 JSON content-type；`updateAiKeyModelGrants` 增加 `name` 参数并由面板传入。三个 major：启用/停用未走列表控制器（无忙碌态、错误不可见、不刷新）→ 改走 `list.mutate`；授权完成后未按 §5.1 第 8 步单独刷新模型目录且状态文案被清除 → 完成后先 `refreshAiModels` 再重载并保留文案；模型目录加载失败时许可编辑器会把未知连接映射为空列表，一键保存即静默撤销全部许可 → 目录未加载成功时禁用保存并提示。新增线协议测试（`tests/client/ai-wire-contract.test.ts` 2 项，mock fetch 断言方法/路径/content-type/请求体），这类缺陷此前被模块级 mock 完全遮蔽。
- 生成契约：14 个 AI 操作全部补齐 200 响应 schema（连接视图/授权启动/轮询/删除/断开/模型刷新/调用记录等）。请求体 schema 不注册，已定案而非待办：`@hono/zod-openapi` 的请求体校验在 handler 之前执行，注册后 ① 校验失败返回框架自带 400，与既有 422 `validation-failed` 契约冲突；② 更关键的是它会在身份检查之前读并校验 body，与 §7“认证后读 body 顺序”和 §6.1“无凭据一律 401”的已验证边界相冲突（PR 8 的边界测试对每个管理操作断言 401，注册请求体后无凭据的畸形请求会先得到校验错误）。因此 AI 请求体继续由 handler 自身校验，生成契约只描述响应；这是安全顺序优先于文档完备性的取舍，不通过 defaultHook 绕开。
- §9 缺口收尾（PR 9，同一分支）：① 四态展示——连接视图按持久状态与启停渲染“连接已授权/尚未授权/需要重新授权/已停用”（`readAiConnectionState`），模型视图在刷新失败时显示“模型发现失败”并保留上一次成功快照（§5.3），调用视图把受控错误映射为“额度暂不可用（ai-upstream-quota-exceeded）/需要重新授权”等可操作标签（`describeAiInvocationError`）；② 模型目录视图——逐模型展示上游模型 ID、可用协议（取自提供方定义的 `responsesStyle`，首版为 Responses 子集）、已确认能力（推理强度/API 可用性/可见性，防御性解析不透明 JSON）与最近发现时间；连接快照同时展示提供方类型与脱敏账号（`maskAiAccount`，不再直接显示上游账号 ID）；③ 自动轮询——按服务端 `nextPollAt`/启动响应的 `intervalMs` 定时轮询，缺失或非法回落 5 秒且不短于 1 秒（`readAiPollDelayMs`），终态、取消与卸载都停止定时器；④ 会话恢复——进行中的授权 ID 记入本标签页 `sessionStorage`，重新进入时用 `GET /api/ai/authorizations/{id}` 读回持久状态并继续轮询（§5.1“限时内重新进入同一 Session 可以继续”），非 pending 则清除记录；⑤ 超时读取——poll 抛错（含 SPA 超时）时改为读回持久状态，不重放授权兑换（§6.1 末句）；⑥ 授权启动/poll/模型刷新使用 §6.1 的 35 秒 SPA 预算（`deadlineMs`），不再沿用通用 30 秒 mutation 预算。
- 验证（PR 9）：`tests/client/ai-connections-view.test.ts` 5 项（四态映射与标签、脱敏账号边界、能力解析与描述、协议标签、轮询间隔钳制）；`tests/client/ai-connections-states.test.ts` 6 项（模型目录渲染、三态区分与账号脱敏不泄漏原值、发现失败保留快照、按服务端节奏自动轮询并在完成后停止、重开页面恢复 pending 会话并继续轮询、服务端已非 pending 时不恢复且清除记录）；`tests/client/ai-invocations.test.ts` 增加受控错误标签断言。
- 复审与修复（独立 review 一轮，approve-with-fixes）：① 高危——轮询定时器在列表忙碌期间触发时，`list.mutate` 的忙碌闸门会丢弃该次 poll 且不再重新排程，轮询静默死亡（上游 interval 为 1–3 秒时可达；模块级 mock 立即 resolve，原测试看不见）→ poll 改用独立在途标志，不再与列表控制器共享忙碌闸门，并补一条“列表仍在刷新时轮询照常发生并继续重排”的回归测试；② 授权完成后的目录刷新走失败感知路径：刷新失败记入“模型发现失败”并保留快照，不再把成功授权呈现为上游错误（§5.3）；③ 更正：`refreshAiModels` 此前并未使用 §6.1 的 35 秒预算（提交说明与本节此前的 ⑥ 说法不实），现已补上，并新增以中止时刻为证据的预算测试（把预算改回 30 秒该测试即失败，已做变异验证）；④ 终态轮询状态分类——`cancelled`/`connection-changed` 清除会话记录，`poll-claim-held` 按服务端节奏自动重试；⑤ 重试有界——poll 与读回都失败时最多重试 5 次，读回返回 403/404 视为终局并清除记录；⑥ 表述更正——`sessionStorage` 按标签页隔离，恢复能力覆盖刷新/标签页恢复，不覆盖关闭标签页后重开；⑦ 加固——短账号 ID 不再整串显示，删除只写不读的 `catalogEmpty`，空目录文案不再声称“尚未成功发现”（服务端未区分空快照与无快照），提供方定义缺失时协议显示“协议未确认”而非硬编码 Responses。
- §5.2 修正（同一分支）：管理 API 此前直接返回原始上游账号 ID（`upstreamAccountId`），与设计 §176“管理 API 返回连接状态和脱敏账号信息”不符。现由服务端在连接视图统一脱敏为 `upstreamAccount`，原始 ID 不再离开服务端；客户端不再自行脱敏（单一事实来源），生成契约同步。新增 worker 断言：列表响应包含 `ac…efgh` 且整体响应不含原始 ID。
- 验证（复审后）：`pnpm run check` 全链通过（worker 398、client 62、scripts 66、e2e 6）；新增/更新测试：`ai-connections-states.test.ts` 12 项（含轮询存活、完成刷新与失败呈现、读回、终局停止、终态状态、停用标签与空目录文案）、`ai-connections-view.test.ts` 4 项、`ai-wire-contract.test.ts` 3 项（含 35 秒预算的中止时刻断言）。
- 测试稳定性修正：`tests/worker/ai-responses-transport.test.ts` 的 credential-busy 用例在 CI 上偶发 `ai_connections_time_check` 失败——它在夹具写入连接行之前取 `now`，而夹具用自己的时钟写 `createdAt`；相隔一毫秒时 claim 写入的 `updatedAt` 会早于 `createdAt`，触发迁移约束（生产路径要求调用方传入的 now 不早于建行时间，属测试时序假象）。已改为在夹具之后读取 claim 时钟；约束本身保持不变。
- staging 部署与实测（2026-09-19，owner 当次授权）：owner 将 `AI_CREDENTIAL_KEYS` 写入 staging（只读核对 6 个必填 Secret 齐备）；以 `27733ee85f5ae3d815d934a66180cab821938cc1` 触发 staging 发布（run 35428287875，success），脚本自动应用迁移 0002（`Migrations: 1 applied`）并通过 5 项冒烟探测。只读实测：staging D1 存在 `ai_connections`、`ai_models`、`ai_authorization_sessions`、`ai_invocations` 四表；`GET /api/ai/{connections,providers,invocations}` 返回 401 authentication-required，`GET /api/ai/models` 返回 401 invalid-credential——路由已开放、身份载体正确，不再是 404。仍未验证：真实设备授权、令牌刷新、模型发现与真实上游事件流（需在 staging 完成一次真实 owner 授权）。production 未部署、其 `AI_CREDENTIAL_KEYS` 未配置。
- 未交付：真实上游行为验证（见上条）；production 部署与配置。界面按 §9 无已知未交付项；E2E 覆盖两个 AI 深链的匿名边界（登录边界挂载、不出现 AI 控件）与已登录挂载：已登录用例复用 e2e 服务器预置的会话 Cookie、对真实 worker 读取渲染两个面板，并置于 Passkey 用例之前——后者会登出并删除该预置会话行，此前把它放在其后导致受保护路由落到登录边界（曾误判为会话守卫问题）。

### 4.21 2026-09-19 最新 staging 发布、真实设备授权与上游阻断记录

本轮按 owner 指令完成最新 staging 发布、0003 迁移、真实 AI 链路验收与含 AI 数据的恢复演练；production 仅整理准备项。本轮计划内的操作已收尾，但这不等于 AI 全部验收通过：真实推理链路因上游 403 未验收（见下），AI 上线门槛仍未通过。此前本机请求 staging `/health` 曾返回一次 403；本轮经代理与直连复测均返回 200，响应体为应用 JSON、版本号与部署记录一致，Actions 冒烟同过。该历史 403 未复现，原因未确认：复测返回 200 只说明当时未能复现，不足以认定它属于本机代理瞬时现象或排除 Worker 侧因素；复测中的“直连”仍经过 TUN，不是完全独立的网络路径。

**发布与迁移（run 35451178221，success）**：以 `5ed76adb774991abec90cb94d8dd22ae9f2b7f83`（已 review、Check run 35449946255 成功）触发 staging 发布。发布脚本按 ledger 自动应用 `0003_invocation_admission.sql`（`Migrations: 1 applied`），部署版本 `2d99eca2-a898-41ef-98ea-f57abeb90a36`、deployment `a6083b43-dffd-4bc7-8091-f5d61cb57ce0`、冒烟 5 项通过；`d1_migrations` 三条齐备，`deployment_migrations` 记录三份哈希与本地文件逐字节一致，`ai_invocations` 三个索引重建（迁移前该表 0 行，历史保留为平凡成立）。迁移前数据保护：当日 03:01 Asia/Shanghai 备份成功。回退边界：0003 为前向迁移；应用回退可重部署上一版本 `ac3171d8`（对应 `27733ee`），旧代码插入时始终提供两身份列、与新 schema 兼容；数据库不做回退，重部署应用版本不等于数据库已回退。

**真实设备授权（通过）**：owner 经 GitHub 登录管理台（含两次 recent-auth 重验证），创建连接 `staging-acceptance-20260919`，启动设备授权并在官方验证页人工输入代码完成授权。持久状态确认：连接 `connected`、账号脱敏 `ea…d9d8`、**凭证有效期至 2026-09-29 23:31:17（首次设备流凭证约 10 天，此前“默认有效期待实测”项的实测值）**、版本 1。授权会话恢复（关闭面板重进后 sessionStorage 续接轮询）与自动轮询均工作正常；随后再次启动的重新授权（pending 会话）与取消路径亦实测通过。

**模型发现被上游阻断（本轮主要发现）**：授权完成后首次模型发现失败，归类 `ai-upstream-protocol-error`（该分类同时覆盖 4xx 与载荷不符，当时无状态可见）。按固定参考 codex-rs 目录会话与本服务 `/responses` 编排的既有 401 语义，先修复目录路径缺失的“401 → 强制刷新一次 → 重发一次”（[PR #45](https://github.com/eruoo/server/pull/45)，合并为 `7bf5b8255c1a5b3c9fec406026cbf71b6df2592c`；独立 review approve-with-fixes，三项 minor——事件补 `connectionId`、修正注释覆盖范围、补恢复期预算耗尽与重发失败的组合测试——已全部修复；本地全链 check 通过，worker 431/431、目标文件 36/36）。随后发布 `7bf5b82`（run 35454862688，success，0 迁移，冒烟 5 项，版本 `452ff1f7-b579-4e87-9aec-d33f4e1ceb23`）并重验：**受控事件给出该次请求的直接证据 `{"failureKind":"http","httpStatus":403,"reason":"protocol"}`——该次上游响应为 403 而非 401，修复正确地未触发恢复。**该事件按既有脱敏规则只记录 connectionId、event、failureKind、httpStatus 与分类 reason；本次目录请求的响应头未读取，错误正文虽在进程内被有界读取，但目录分类只依据 HTTP 状态与故障类别、不检查正文，正文也不落日志，因此没有可用于判定 403 来源层的证据。**

**403 归因：原因尚未确认（出口或边缘防护是待验证假说）**。已确认的事实：授权完成后该次模型目录请求返回 403，模型目录未建立，依赖目录的真实推理链路验收受阻。同一头型（`originator: eruoo`、`user-agent: eruoo/1`）自本机、无有效凭证请求同一端点返回 401 JSON：该对照说明这一请求形态自本机网络路径到达了应用层，但它不带有效凭证，不能证明 Worker 请求的第三方请求头待遇正常，也不能排除凭证或请求本身被拒。owner 本机 Codex app 与 CLI 正常，说明账号与凭证链路本身可用，但不说明 Worker 侧持有的凭证在本次请求中被接受。社区案例（codex CLI Linux/rustls 指纹被同款 403 的 openai/codex#17860、OpenAI 对 Cloudflare Worker 出口 403 封锁的持续报告）来自其他环境，在缺少本次 Worker 响应直接证据的情况下只能作为待验证线索，不能当作本次根因证明。Cloudflare 挑战页的识别方式（响应体特征、`cf-mitigated` 响应头等）见 [Detect response](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)；本轮未保留可判定来源层的响应证据（响应头未读取，错误正文在进程内被有界读取但目录分类不检查它、也不落日志），因此“Worker 请求收到 Cloudflare 边缘挑战”“令牌未被评估”“唯一根因是出口 IP 与 workerd TLS 指纹”“第三方请求头待遇已验证正常”“production 必然出现相同 403”均未确认。auth.openai.com（设备码/交换/JWKS）自 Worker 正常，只说明其他上游路径可用，不解释该 403。

按 ai-service §13，该连接器当前不可用、AI 上线门槛未通过；owner 决策为维持现状并记录（不伪造第一方身份、不自动改用付费 API、不新建中继组件）。AI Key 无法获得目录内模型许可（目录恒为空、创建必带非空 `modelIds`），因此调用链（JSON/SSE 真实调用、在途限制 429、取消收尾、SSE error 分类、断开后拒绝推理、usage 与调用记录）**全部受阻，标为上游阻断未验证**；真实令牌刷新（凭证约 10 天有效，60 秒提前窗口未自然到期）同样未触发。后续验证方法：先确认阻断原因，再按 §4.21 重跑最小闭环；处理方案（含任何出口通道变更）需 owner 另行决策与授权，本轮不预设方案。

**边界与审计（已验证部分）**：调用端点认证拒绝路径实测——无效 `x-api-key`、仅 Cookie、仅 Bearer、无载体对 `POST /api/ai/responses` 一律 401 invalid-credential（单载体规则生效），`GET /api/ai/models` 无效 Key 401；无效 Key 的两次探测产生 `api_key_rejected` 审计各一条（requestId 与响应逐一对应），无 `x-api-key` 的载体拒绝不产生该审计，符合 §3 规则。管理审计：`ai_connection_created`、`ai_authorization_started`（两次）、`ai_authorization_completed`、`ai_authorization_cancelled` 全部记录且带 requestId；调用记录面板以 owner Session 读取 `GET /api/ai/invocations` 正常渲染空态。管理端点无凭据 401 边界已在 §4.19/§4.20 测试覆盖，本轮部署后冒烟复验。

**含 AI 数据的恢复演练（通过）**：为使快照包含真实待处理授权，先在已连接连接上启动一次重新授权（不完成），随即以 `wrangler workflows trigger` 创建真实备份实例 `cf_b8e8302944606be3c570e8a7e24ae2cc13e24c784cb9ebcacf62365d298d8cc7`（16:42 完成，快照 39,745 bytes；上传步骤内建 R2 校验通过后记 `database_backup_health=ok`）。带外复核：对象键与上传步骤输出一致，内部 R2 API 读回 content-length 39,745、ETag `cac729f7ac33d285fd9e4d381c3cf8f8` 等于下载文件 MD5、storage class Standard。恢复规划器以库路径对真实 SQL 校验（descriptor 输入以工作流内建对象校验 + 带外 key/size/ETag/storage-class 复核替代——`exportBookmark` 等字段本轮无法从 R2 外部读取，该替代如实记录）：schema、外键与 `0001–0003` 精确前缀通过，SQL SHA-256 与本地文件一致。快照导入隔离空库 `eruoo-server-restore-20260919-7bf5b82`（`6237f569-31dd-4051-aaca-2de30320205a`，25 表 344 行），在原始 schema 上执行生成的清理 SQL 后断言全部通过：连接转 `reauthentication_required`、`credentialCiphertext`/`refreshClaimId` 清空、`credentialVersion` 1→2（旧刷新结果不能复活凭证）、`ai_authorization_sessions` 2 行（含加密设备授权数据）清零、在途调用转换语句执行成功但本轮快照无 reserved 行（行级效果仍仅合成验证覆盖）、源库 `deployment_migrations` 记录清除、Session/Passkey/API Key/审计清零、GitHub provider 令牌清空而 owner 关联保留、静态 OAuth client/resource 按当前清单恢复。前向迁移 0 项（ledger 已含 0003），随后写入隔离目标专属 migration receipt（目标 ID ≠ staging/production）。演练后删除隔离 D1 与本地快照副本（保留仅含哈希与生成 SQL 的演练回执于本地私有目录）；R2 快照按既有 30 天生命周期保留。JWKS 重建与认证冒烟未在本轮重复（§4.8 已验证，本轮任务核对项不要求）。

### 4.22 2026-09-22：DeepSeek 官方 API 接入（本地实现）

当前 AI 设计由 [ai-service.md](ai-service.md) 维护。§4.14–§4.21 及上方初版交付表中的 Codex 设备授权、刷新与 403 阻断均为历史记录，不作为 DeepSeek 链路的验收结论。

- 删除 Codex 设备授权、OAuth 刷新与推理重放，使用 DeepSeek 官方静态 API Key、原生 `/models` 与 `/responses`。默认 effort 明确发送 `max`；已确认模型支持可选 effort，`deepseek-flash` 支持图片。
- 保存 Key 在 D1 原子写中复核持久 owner Session 与观察到的凭证版本。普通替换保留精确模型授权，重新发现模型后恢复调用；断开推进独立授权版本，使旧调用 Key 授权失效。输入不回显、不进入浏览器存储。
- 追加 0004 一次性清理旧 AI 状态与 AI 配置档调用 Key，保留非 AI 数据。恢复工具区分新旧表结构，不再对新结构访问设备授权表。现有登录会话修复仍是本次提交的前置祖先。
- 验证使用本地合成凭证与 mock 上游，覆盖并发保存、失效 Session、迟到 401、授权版本、默认 max、图片、工具与推理 SSE、失败 usage、超时取消、重置迁移及恢复。浏览器检查确认保存后密码框清空、上游 503 不退出本站登录、本站会话 401 返回登录页。
- `pnpm run check` 通过：格式、lint、三组类型检查、OpenAPI 一致性；Worker 36 文件 395 项、前端 16 文件 67 项、脚本 6 文件 71 项、Chromium 8 项，共 541 项。另完成上述浏览器 mock 操作检查。所有上游凭证均为合成值。
- 未推送、未部署、未操作远端数据库或 Secret，未发送真实 DeepSeek 请求。真实目录、图片/工具推理与上游计量仍待单独授权验收。

### 4.23 2026-09-22：DeepSeek staging 人工验收与后续简化

PR #51 合入 `3ff5ef8c966f42238bbb792cd01b87a1ee68c6ef` 后已发布 staging（CI run 35707129879、部署 run 35707688874；0004 迁移与发布冒烟通过）。此条记录与 §4.22 的本地实现阶段分别保留。

owner 在本任务提供的实际响应确认：`deepseek-flash` 目录、默认 max 文本、none 文本/图片识别、none 工具调用与工具结果回传、low/high 成功、medium 422；权限测试显示拒绝与恢复调用，调用记录中的 requestId 和 12 tokens 与响应一致。图片结果正确识别测试图标题、编号、形状及算式。结构化输出、带推理的完整工具往返仍未获得真实上游验收证据。

本轮后续简化尚未部署：短暂窗口切换跳过 Session 检查，连续离开五分钟后后台检查且保留表单；本站 AI Key 明确绑定一条连接，模型名改用原生 ID，去掉连接 slug 配置。无需新增迁移，保留内部 slug 列兼容发布切换与 Worker 回退，新连接自动填 UUID；现有 DeepSeek 数据保留，旧单连接授权继续有效；旧多连接授权必须明确重选。实现规则见 [AI 服务设计](ai-service.md) 与 [Session 状态](architecture.md#62-session-状态)。本地验证覆盖五分钟边界、后台失败/失效/更换 Session、同名模型连接隔离、空授权、结构化输出与推理工具历史传递、旧 schema 上的新连接创建与既有连接调用；本地 mock 不代替真实上游验收。

本轮检查通过：格式、lint、三组类型检查、OpenAPI 一致性，Worker 398、前端 72、脚本 73、Chromium 8 项，共 551 项。首次完整检查在新增前端测试的空 DOM 断言处失败；修正测试并补上类型约束后重跑前端及后续所有检查，Worker 通过结果复用（后端未再改动）。本轮未提交、推送或部署。

owner 随后要求三项一起完成，本地补充 3 条完整路由验收：结构化输出的鉴权/默认 max/返回 JSON/调用记录；读取第一轮返回的 reasoning 与 function_call，执行工具并将结果连同历史回传的两轮调用；20 分钟旧但有效 Session 可发现模型，而调用 Key 的创建与授权修改仍要求 recent authentication。相关两个测试文件 21 项通过，lint、类型和格式检查通过；其余检查复用上述 551 项结果，本轮未改动运行时代码。真实上游补测已准备交互式脚本，但尚未取得本站调用 Key，未将 mock 结果记为线上验收成功。

发布前复审修正：保留内部 slug 列，避免先迁移后部署及 Worker 回退时旧版本访问缺失列；连接列表与模型授权选择器显示相同的短 UUID，便于区分同名连接。修正后完整 `pnpm run check` 通过：Worker 402、前端 72、脚本 71、Chromium 8 项，共 553 项。最终提交、CI 与部署结果以关联 PR 和 Actions 记录为准。

### 4.24 2026-09-22：原生模型路由发布与工具选择组合修复

PR #52 已合入 `4e4ccff5ac77df834997fe04ac3ba8c2ff92f78e`；主分支 CI run 35742874686、staging 部署 run 35743499305 成功。0 项迁移、5 项在线冒烟通过，Worker 版本为 `418afde8-df0e-4e23-8805-0b441d822371`。

owner 补测确认结构化 JSON 与默认 max 成功。工具 A/B 对照仅切换 tool_choice：max + 指定 test_echo 返回 502（requestId `971f9e35-d49e-45eb-9f6c-79f19f3cd4b8`）；max + auto 返回 reasoning/function_call；保持 tools、回传推理历史与工具结果后，第二轮 completed/max 且正确返回工具生成的随机值。该证据确认 max + auto 的完整推理工具往返；不代表所有 effort/工具选择组合都已线上通过，也未取得失败请求的原始上游响应。

根因：能力校验分别允许 effort 与 function tools，却未校验思考模式下的强制工具选择组合。原验收脚本和路由 mock 测试同样使用了不兼容的组合，导致本地成功未能代表实际请求可用。修复规则统一见 [AI 服务设计 §6.2](ai-service.md#62-调用接口)；工具往返验收改用 auto，两轮保留工具定义及完整推理历史，第二轮直接消费工具结果，不插入新的 user 回合。本节修复尚未提交或发布。

回归先在未修复代码上执行：16 个非法组合被错误放行、17 个合法组合通过；修复后相关路由、DeepSeek 能力与 Responses 协议测试共 119 项通过。覆盖省略 effort/low/high/max、required/指定工具、JSON/SSE 两种响应方式的 422、零上游请求和名额释放；合法组合保持 effort/tool_choice 原样转发。完整 `pnpm run check` 通过：Worker 435、前端 72、脚本 71、Chromium 8，共 586 项；更新后的临时验收脚本通过合成完整流程验证。未将这些 mock 结果记为新的线上验收。

## 5. 后续验证与已知限制

Cloudflare 与 GitHub 接线、staging 验收及 production 首次发布、真实登录和备份已按上述记录完成。以下限制与后续范围仍保留，不能由本地测试替代：

- §4.13 已通过对照确认 D1 导出期间登录会短暂返回 503；生产原始请求缺少底层错误的追溯限制仍保留，不将其写成代码已修复。首次自动备份与清理已配置并安排核验，实际调度结果仍待取得。
- §4.11 的 Default 三地 warm 达到新目标，同代码闲置样本满足新目标；旧 JP 尾延迟和 Smart SG 超时未定位，后续若再次出现须按请求与平台证据排查，不能报告为已修复。常规发布阶段耗时尚未积累五次样本，不代表所有代理节点或生产性能已验证。
- Workflow 中断与代码回退已在 §4.9 完成所列场景；大对象提交竞争与长时限的所有窗口未穷尽。成功导出/上传、隔离库导入、凭证清理及新信任验证已在 §4.8 通过。
- Desktop App、Rust 安全存储、客户端打包与跨端联调：按 owner 最新决定延期，不属于本次 Web 交付。
- AI 历史 Codex 链路的 403 阻断与恢复演练见 §4.21，不再作为现有 DeepSeek 链路的状态。DeepSeek staging 已完成 §4.23 与 §4.24 所列 owner 人工测试；真实加密密钥轮换与其他异常上游行为仍不能由本地 mock 代替。原生模型名与 Session 切换优化已发布 staging，工具选择校验修复尚未发布；production 未发布本轮 AI 改动。

恢复规划器只输出可审核计划；恢复、secret 轮换、资源删除及正式部署仍需当次具体授权。Git 提交和 PR 合并与这些平台操作分别记录，不代表远端发布或验收已经完成。
