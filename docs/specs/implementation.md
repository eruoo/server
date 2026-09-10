# 服务端与 Web 实施记录

2026-09-10 收尾验证，审查起点为 `c56d0a6` 工作树。owner 最新范围为“desktop 端暂时不做，先做 web”。本文件记录首次实现提交前的能力与验证，架构策略仍由四份规格维护；基线 SHA 仅用于定位审查起点，正式发布版本以合入 main 后的 CI SHA 为准。

## 1. 已实现能力

| 范围         | 实现                                                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 认证         | 请求级 Better Auth；GitHub owner 准入；原生 Session 滚动续期与 JWE；独立 recent-auth；精确入口、粗限流、依赖故障响应；GitHub 每个 HTTP 请求及正文可取消时限                  |
| Web          | 唯一 Session 控制器；Passkey 注册/登录/重认证/命名/删除；API Key 创建/一次性查看/命名/撤销；已授权应用；审计筛选/游标分页；备份状态；私有 Scalar/OpenAPI；系统/浅色/深色外观 |
| API Key      | 独立插件、哈希存储、有限有效期、owner 与权限检查、两级限流；数据库故障返回 503；不产生 Session                                                                               |
| OAuth 服务端 | 静态 client/resource、PKCE、Code/refresh/revoke、OIDC/JWKS、严格 UserInfo 验签；family tombstone、幂等重试、并发撤销；浏览器登录 continuation；管理端整应用撤销              |
| 数据保护     | 每日 full SQL export Workflow、租约与有限重试、R2 容量预算及对象校验、单调备份状态；有界清理保留 Session；离线恢复规划器和凭证清理计划                                       |
| 交付         | 生成五个自有 API 的 OpenAPI；同 SHA 两环境独立构建与摘要清单；Actions 手动消费产物、迁移前检查、部署后读回与冒烟                                                             |

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

## 5. 尚未执行的外部验收

Cloudflare 与 GitHub 接线、首次 staging migration/应用上传/Workflow 注册和 cron 已按 §4.1–§4.3 执行。以下结果仍需在实际授权环境取得，不能由本地测试替代：

- D1 export 轮询修正后的真实备份验证、production 首次发布及其 token 实际有效性；任何进一步导出权限调整仍按 §4.6 的实际凭证身份授权。
- 远端端到端 code→refresh→revoke；地区/冷启动/CPU/尾延迟与后续常规发布耗时样本。真实 owner GitHub 与 Passkey 登录已通过。
- 一次成功的真实备份导出/上传、停止/超时行为、向已建隔离 D1 导入恢复、凭证清理、新信任验证、代码回退演练。
- Desktop App、Rust 安全存储、客户端打包与跨端联调：按 owner 最新决定延期，不属于本次 Web 交付。

恢复规划器只输出可审核计划；恢复、secret 轮换、资源删除及正式部署仍需当次具体授权。Git 提交和 PR 合并与这些平台操作分别记录，不代表远端发布或验收已经完成。
