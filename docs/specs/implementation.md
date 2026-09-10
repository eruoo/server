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

沿用完整 `0001_foundation.sql`，安装版本的全部认证字段已经过实际 schema 检查；新库应用同一份基线。无需为了“从零”再次重写可用 schema。旧生产/验证资源保持原状，当前配置明确要求新数据库 ID。

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

第一次远端接线在获得当次授权后完成：

1. 为 staging/production 各创建新的空 D1 和私有 R2 Standard bucket，在 `wrangler.jsonc` 填入 account/database ID，确认 vars 与 binding 对应。原数据库不作为新基线执行目标。
2. 在新 bucket 读取现有 lifecycle，再设置唯一 `d1/daily/` 前缀 Age 2592000 秒删除规则，确认没有重叠删除或存储类别迁移。部署脚本只读验证，不自动修改规则。字段依据 [Cloudflare Lifecycle API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/get/)。
3. 为精确 Worker 名预置五项 required secrets（runtime 备份 token 与部署 token 独立）。首次 bootstrap Worker 与域名绑定是一次性平台接线，常规发布不隐式创建、猜测或修复缺项。
4. GitHub 的受保护 main、两个 Environment、最小权限 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` 准备好。production 仅 owner 发起，并阻止其他账号重跑借用其授权。
5. 通过 CI 后选择完整 SHA 手动发布；流水线检查同仓库/指定成功 CI/环境/7 天有效期/文件摘要，必要时迁移，再部署。之后读回绑定、cron、source SHA 和 version，并执行最多 60 秒的基础冒烟。

默认本地构建也生成摘要，但来源记录为 local，不能冒充通过 GitHub CI 的正式发布产物。真实 CI/部署耗时尚未采样，约 5 分钟仍是目标；10 分钟 job 截止与 60 秒 smoke 是已配置的上限。

## 5. 尚未执行的外部验收

没有创建、修改或删除真实 Cloudflare 资源，也没有触发 Actions 发布或迁移远端数据库。以下结果必须在实际授权环境取得，不能由本地测试替代：

- 新 D1/R2、secret 有效性、域名、cron、lifecycle、Workflows 平台接线及正式 CI 运行。
- 真实 owner GitHub/真实认证器登录；远端端到端 code→refresh→revoke；地区/冷启动/CPU/尾延迟与常规发布耗时。
- 一次真实备份导出/上传、停止/超时行为、恢复到隔离新 D1、凭证清理、代码回退演练。
- Desktop App、Rust 安全存储、客户端打包与跨端联调：按 owner 最新决定延期，不属于本次 Web 交付。

恢复规划器只输出可审核计划；恢复、secret 轮换、资源删除及正式部署仍需当次具体授权。Git 提交和 PR 合并与这些平台操作分别记录，不代表远端发布或验收已经完成。
