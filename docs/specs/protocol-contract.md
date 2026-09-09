# 协议与 HTTP 契约

> 属于 [完整架构规格](architecture.md)，状态与其一致。本文维护外部行为；应用架构、安全窗口和运维策略分别由配套规格维护。
> 设计参考来源：当前 `docs/openapi.json` 与历史实现的 auth/app/oauth 模块。owner 已明确允许数据从零、Desktop 同步改版并放弃旧版本接口兼容。本文定义服务端与新版 Desktop 的共同目标，旧客户端、schema、数据和备份格式不构成兼容约束。

## 1. 请求边界

Worker 先识别精确 path/method，再执行该 operation 的认证、限流和 handler。未登记的 Auth 路径在调用 Better Auth 前拒绝；不得为攻击者自选的任意路径写入 `rateLimit`。路径大小写、尾斜杠和百分号别名不自动成为另一个有效 operation。

| 路由类别                          | 认证输入                                                 | 校验顺序                                                            |
| --------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| 自有 API、私有文档                | 唯一 Session/Bearer/API Key 载体，且该路由允许           | 路径/方法 → 载体形状 → 入口限流 → 验证身份 → 路由权限 → schema/业务 |
| GitHub、Passkey 登录              | 库规定的 state/challenge/assertion；现有 Cookie 按库语义 | 路径/方法 → body 大小 → Origin/CSRF → 库 ceremony → owner           |
| OAuth 授权/consent/continue       | owner Session + 协议参数/签名 continuation               | 协议语法 → 验证 redirect/client → 持久 Session → 签发               |
| OAuth token/revoke/introspect     | 协议表单中的 client 与 token                             | 原始重复参数检查 → 库协议验证 → family 规则                         |
| UserInfo                          | Bearer access token                                      | 载体语法 → JWT/协议校验 → scope                                     |
| `/health`、metadata、公开问题说明 | 无需身份；不把环境 Cookie 当授权                         | 固定路由 → 静态输出；不查询 D1                                      |

三载体规则只应用于通用 API/私有管理入口，不能把 OAuth 表单 refresh token 当作第二种通用凭证。协议端点允许浏览器自然附带的 Session Cookie，但不把它用于替代 token/client 校验；UserInfo 的 API 凭证仍为 Bearer。

### 1.1 通用凭证规则

- Session Cookie、`Authorization: Bearer ...`、`x-api-key` 三选一；空值、重复、混合载体、多个认证方案在访问 D1 前返回 400。重复同一 Session cookie 也拒绝。
- 不从 URL/query/body 接受通用 access token/API Key。未知认证方案不触发其他凭证回退。
- 缺失凭证 401；无效/过期凭证 401；已识别但该路由不支持的载体 403；scope/permission 不足 403。依赖无法响应为 503，等待预算耗尽为 504。
- 浏览器 Cookie mutation 必须通过精确 Origin/CSRF 校验，SameSite 不能替代 CSRF。生产无跨源允许项；Native 无 Origin 的协议请求按 OAuth 验证，不套浏览器 Cookie mutation 规则。
- 通用 body 最大 1 MiB，流式计数，不能只信 Content-Length。需要 body 的 operation 检查媒体类型；不接收无需求的上传。

## 2. 路由清单

### 2.1 自有 API

当前目标的字段、必需项、枚举和响应形状采用 [OpenAPI 字段快照](../openapi.json)，不在本文重复定义字段类型。实施时按 §5 由路由 schema 生成接管；契约变更同步更新调用方与测试，旧版响应比对不作为验收门槛。

| Method / path                                 | 允许身份                 | 额外策略                                | 成功结果                            |
| --------------------------------------------- | ------------------------ | --------------------------------------- | ----------------------------------- |
| GET `/api/status`                             | owner Session 或 API Key | key 必须 `status:read`；Bearer 禁止     | 200，`Status`                       |
| GET `/api/security/audit-events`              | owner Session            | 有界 cursor 分页                        | 200，`SecurityAuditEventPage`       |
| GET `/api/security/backup-status`             | owner Session            | 只读备份终态，不做 export 探测          | 200，`DatabaseBackupStatus`         |
| GET `/api/oauth/authorizations`               | owner Session            | 聚合静态客户端与授权状态                | 200，`OAuthAuthorization[]`         |
| DELETE `/api/oauth/authorizations/{clientId}` | recent owner Session     | 仅启用且支持离线授权的 client；原子撤销 | 200，`OAuthAuthorizationRevocation` |

以上只开放所列方法；包括 Hono 隐式 HEAD 在内的其他方法返回 404，不能执行 handler。GET 列表和 API 文档使用 `Cache-Control: private, no-store`，status 使用 `no-store`。不增加通用成功包装或 `/api/v1`。

`GET /api/docs` 与 `GET /api/openapi.json` 仅 owner Session 可读，分别提供同源 Scalar 和生成契约；私有文档不支持 key/Bearer。Scalar 禁止凭证持久化、遥测、外部 CDN 与在线试请求。

### 2.2 身份端点（base path `/api/auth`）

| 相对路径                                                | 方法 | 应用策略                                          |
| ------------------------------------------------------- | ---- | ------------------------------------------------- |
| `/sign-in/social`                                       | POST | 仅 GitHub，固定同源 callback                      |
| `/callback/github`                                      | GET  | 库 state/PKCE 与 owner 准入；可能写入，不套读超时 |
| `/get-session`                                          | GET  | 原生 Session 响应与节流续期；不写数据库限流计数   |
| `/sign-out`                                             | POST | 当前 Session 退出；原生 CSRF                      |
| `/passkey/generate-authenticate-options`                | GET  | 库 challenge；可能写 verification，不视为纯读     |
| `/passkey/verify-authentication`                        | POST | 库验证 + owner 关联，签发 Session                 |
| `/passkey/list-user-passkeys`                           | GET  | owner Session                                     |
| `/passkey/generate-register-options`                    | GET  | recent owner Session，Origin/CSRF 与 challenge    |
| `/passkey/verify-registration`                          | POST | 再次 recent owner Session；challenge 一次性消费   |
| `/passkey/update-passkey`、`/passkey/delete-passkey`    | POST | recent owner Session 与 credential 归属           |
| `/api-key/list`、`/api-key/get`                         | GET  | owner Session；不返回原始 key                     |
| `/api-key/create`、`/api-key/update`、`/api-key/delete` | POST | recent owner Session；允许字段按架构规格收窄      |

这些路径使用固定版本库的原生请求/响应 schema，不自建同义 REST 路由。Passkey 与 API Key 来自独立插件包，包名和版本见 [§5](#5-契约维护与依赖依据)；下节 OAuth Provider 也由独立包提供。应用附加的 owner/recent-auth 拒绝可返回下节 Problem，库自身错误保持原生结构；前端适配器必须分别识别，不以任意 401/403 猜测会话或重认证状态。

不开放密码、邮箱、账号关联变更、多用户、用户更新/删除、动态 client/resource 管理等其他库端点。`GET /api/auth/error` 由 Worker 在 Auth 前处理为固定 `/login` 跳转，仅携带白名单错误码；不执行数据库限流，不回显 error_description。未知路径直接 404。

### 2.3 OAuth、OIDC 和发现

| 相对路径或绝对 path                                     | 方法      | 行为                                                          |
| ------------------------------------------------------- | --------- | ------------------------------------------------------------- |
| `/api/auth/oauth2/authorize`                            | GET、POST | Authorization Code + PKCE                                     |
| `/api/auth/oauth2/consent`、`/api/auth/oauth2/continue` | POST      | 库签名 continuation + 持久 owner Session                      |
| `/api/auth/oauth2/token`                                | POST      | authorization_code / refresh_token；不开放 client_credentials |
| `/api/auth/oauth2/revoke`                               | POST      | RFC 7009，精确 family 撤销                                    |
| `/api/auth/oauth2/introspect`                           | POST      | 保留库原生 client/token 权限；不是匿名 token 调试接口         |
| `/api/auth/oauth2/userinfo`                             | GET、POST | OIDC UserInfo，Bearer                                         |
| `/api/auth/oauth2/end-session`                          | GET、POST | 保留库 RP logout 策略与已登记 client 限制                     |
| `/api/auth/oauth2/end-session/confirm`                  | POST      | 库原生确认与 CSRF；不接受任意登出 redirect                    |
| `/api/auth/jwks`                                        | GET       | 仅可公开的公钥，无私钥                                        |
| `/.well-known/oauth-authorization-server`               | GET、HEAD | issuer 与 endpoint metadata                                   |
| `/.well-known/openid-configuration`                     | GET、HEAD | OIDC discovery，与前者 issuer/jwks_uri 一致                   |
| `/.well-known/oauth-protected-resource/api`             | GET、HEAD | resource 与唯一 authorization server                          |

发现文档从静态配置生成，HEAD 空 body；JWT 公钥读取单独处理。方法不支持时保持协议原生语义，不能落入 SPA fallback。所列原生端点受当前 client 权限和 logout redirect 策略约束，不额外增加旧版路由别名。启用客户端、发布的 discovery 与路由清单必须相互匹配。

## 3. 自有错误契约

采用 RFC 9457 `application/problem+json`；`type/title/status/detail/requestId` 必需，校验错误可有 `errors[{location,pointer,detail}]`。不新增顶层 code，不输出堆栈/SQL/原始依赖错误。`type` 前缀固定 `https://auth.eruoo.me/problems/`。

| Status          | 稳定 slug                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| 400             | `invalid-request`                                                                                      |
| 401             | `authentication-required`、`invalid-credential`                                                        |
| 403             | `permission-denied`、`insufficient-scope`、`insufficient-permission`、`recent-authentication-required` |
| 404 / 409       | `not-found` / `conflict`                                                                               |
| 413 / 415       | `payload-too-large` / `unsupported-media-type`                                                         |
| 422             | `validation-failed`、`api-key-expiration-required`                                                     |
| 429             | `rate-limit-exceeded`                                                                                  |
| 500 / 503 / 504 | `internal-error` / `service-unavailable` / `request-timeout`                                           |

标题使用历史稳定 title，单个注册表同时生成响应与 `/problems/:slug` 说明页，不分别维护三份字典。未知 slug 404。语法错误 400，媒体类型错误 415，合法 JSON 的字段/业务约束失败 422。

Bearer challenge 固定 `realm="eruoo-api"`：缺少凭证不带 error；传输畸形 400 `invalid_request`；token 无效 401 `invalid_token`；缺 scope 403 `insufficient_scope`。资源归属失败只返回领域 403。UserInfo 禁止 query/body access_token，传输错误保持 OAuth JSON。

OAuth/Better Auth 不套自有成功/错误包装。token body 超 1 MiB 返回 OAuth 400 `invalid_request`。token 在任何持久变更前发生明确、可取消的依赖超时，返回 HTTP 503/no-store 与稳定 transport code `OAUTH_TOKEN_SERVICE_UNAVAILABLE`，不伪造标准 OAuth error。持久操作开始后不使用无法取消工作的 handler timeout。

## 4. Desktop 授权契约

以配套新版 Desktop 为验收对象。首次切换可要求升级客户端并重新登录授权，不迁移旧凭证。端点、参数、响应或错误行为需要变化时，在同一功能切片同步修改本规格、服务端与客户端；不维护两套协议或以旧版无修改可用作为门槛。下列安全规则继续作为目标测试依据。

### 4.1 client、redirect 与 continuation

- 唯一启用 client 为 `eruoo-desktop`，public client、无 secret、系统浏览器登录；保留 `eruoo-web` / `eruoo-mobile` ID 但不创建启用记录。
- Desktop 精确登记 `http://127.0.0.1/oauth/callback` 与 `http://[::1]/oauth/callback`，只允许 loopback 端口按 RFC 8252 变化；端口为 1–65535 的 canonical 十进制。拒绝 localhost、host 别名、dot segment、百分号变体、额外 query/fragment。
- 先验证 redirect，再附加 code/state/error；无效 redirect 绝不回跳该地址。不通过 URL 规范化扩大 allowlist。
- Authorization Code 使用 PKCE S256、一次性 code，code 生命周期 600 秒，绑定 client、redirect、resource、owner 和 PKCE challenge。客户端严格比较 state，OIDC 另验证 nonce。
- 登录中断时仅由库签名 `oauth_query` 保存授权上下文；GitHub/Passkey 登录、consent、continue 是明确的恢复路径。不信任前端拼装 callback。
- continuation 过期或 `invalid_signature` 后清除该上下文，提示回调用应用重新发起；不循环自动登录。普通管理登录仍可用。
- 静态 owner 自有 client 可以预授权跳过 consent；不因此跳过 Session、redirect、PKCE、scope/resource 校验。

### 4.2 resource 与 scope

业务 resource 为 `https://auth.eruoo.me/api`。启用 client 必须有 D1 client-resource 关联。不存在或禁用 policy 不能由请求临时创建。

| Scope                   | audience                           | 授予业务操作                                            |
| ----------------------- | ---------------------------------- | ------------------------------------------------------- |
| `openid`、`profile`     | discovery 发布的 UserInfo endpoint | 否                                                      |
| `api:read`、`api:write` | 业务 resource                      | 由具体 Bearer operation 声明；当前 status 不开放 Bearer |
| `offline_access`        | 业务 resource                      | 仅控制离线授权生命周期                                  |

authorization 与 code exchange 必须携带相同 resource；refresh 省略时继承，提供时不得扩大原集合。当前只有一个外部 resource，因此多个相同值视作同一目标，空值/未知值/不同值为 `invalid_target`。客户端不得请求 UserInfo 作为额外 resource。

scope 按集合处理，但输入重复值拒绝为 `invalid_scope`。所有已知 singleton 参数在原始 query/form 层检查重复，包括 response_type、client_id、redirect_uri、state、nonce、prompt、code_challenge/method、grant_type、code、code_verifier、refresh_token、token、token_type_hint；即使值相同也拒绝。`resource` 按上段多值语义处理。

业务 resource 的 allowedScopes 包含表中五个 scope，保持 OIDC 签发能力。无 openid 时 aud 仅含业务 resource；有 openid 时仅含业务 resource 与 discovery 的 UserInfo URL 两项，不允许重复和额外 audience。Web/Mobile 未启用，不能因为 ID 已保留而获得任何授权。

### 4.3 token 与公钥

| 项           | 规则                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| Access token | RFC 9068 JWT，TTL 1 小时；客户端当 opaque credential 使用                                                |
| 签名         | 生产 resource 固定 EdDSA/Ed25519；同时保留 RS256 conformance 支持，禁止客户端协商算法                    |
| Header       | kid 为 1–128 字符且无首尾空白；发行 typ=`at+jwt`，验证只接受其媒体类型等价值；alg 与 key 用途/kty 一致   |
| Claims       | iss/sub/aud/exp/iat/jti/client_id/scope 均验证存在、类型和语义；若有 nbf 则校验且 nbf < exp              |
| 时钟         | 生产容差 60 秒，拒绝超过容差的未来 iat/nbf；过期不能无限宽限                                             |
| ID token     | 与 access token 分开验证，检查 nonce/aud/azp/at_hash 等适用字段；不可当业务 token                        |
| Key 轮换     | 两种算法每 30 天轮换，旧公钥正常保留 7 天；kid 全局唯一                                                  |
| 私钥         | D1 保存加密私钥，使用 BETTER_AUTH_SECRETS；禁止独立维护未被库消费的加密 secret                           |
| 公钥缓存     | 已完成值最多 32 个、最长 5 分钟，且不越过 key 宽限到期；未知 kid 触发刷新最多每 30 秒一次/issuer/isolate |

验签使用固定 allowlist 的库/jose，禁止从 token 自带 URL 获取公钥；本 Worker 验证自己的 token 不经 HTTP 调用自身 JWKS。未知 kid 的刷新冷却是抗放大手段，不是全球精确速率承诺。依赖失败时不使用过期公钥无限延长信任。

### 4.4 refresh、撤销与并发

Refresh token 30 天 idle sliding，无额外绝对寿命，每次成功轮换；token hash 持久化。30 秒重试窗口内，同 client/family/scope/resource 的等价重试复用相同 access token 与 successor refresh token；不同参数不得获得更大授权。窗口内旧 token 被盗仍可能取得 successor，是已接受的有界风险。

所有撤销由 `oauth/` 内一个 family 服务维护，family 键为 `(authorizationCodeId, clientId, userId)`：

1. 并发 refresh 最多一条 successor 链；竞争方返回同一组凭证或 `invalid_grant`，不能分叉。
2. 超窗 reuse 先持久化 family tombstone，再撤销该 family；同 owner/client 的独立授权不受影响。
3. owner 按 client 撤销，在同一 D1 batch 为已知 family 写 tombstone、撤销 refresh、删除 consent；commit 是撤销的持久起点。
4. refresh 在库操作前后检查 tombstone。撤销跨过签发时，即使 successor 晚插入，也必须被清理且该响应为 `invalid_grant`。
5. 超窗请求在执行中跨过窗口，且库精确返回 reuse 相关 `invalid_grant` 时，后置检查补齐 tombstone；合法窗口内成功的等价重放不能仅因响应迟到而误撤销。
6. RFC 7009 的 hint 仅作提示；错误 hint 不能放过真实 refresh token。已轮换甚至已到期的可识别旧记录，若仍能关联活动 successor，也必须撤销 family。未知/已经撤销的 refresh 保持幂等成功。
7. self-contained access token 无即时逐 token 撤销能力，真实 access token 返回既有 `unsupported_token_type`，不能受错误 hint 影响而假装成功。已签发 access token 最长继续有效 1 小时，UI 明示。
8. 审计以持久撤销赢家及其不可变 family 信息驱动；完成后才记 success，重试不重复。安全状态必须在同步路径提交，只有审计通知可延后。

Tauri Rust 负责 refresh 存取、轮换和注销，存入 Stronghold，不向 WebView JavaScript 暴露。注销必须服务端撤销 refresh，再清本地凭证；失败时保留“服务端撤销未确认”状态。

### 4.5 OAuth 清理边界

每日清理以该次 `scheduledTime` 为固定边界，所有删除条件使用严格小于，等于边界保留：

- replay 窗口已过：置空含 successor credentials 的 replay response；保留旧 hash/rotatedAt/窗口记录用于 reuse 识别。
- access token 到期：删除其持久记录；refresh 到期且无未到期关联 access token 时才物理删除，避免级联误删。
- tombstone：revokedAt 早于 31 天边界且 family 无未到期 refresh 才删除。
- 查询由现有 replay、expiry、family 组合索引支撑；按有界批次清理，不把历史 token 全部读入 JS。

## 5. 契约维护与依赖依据

实施时用 `@hono/zod-openapi` 的路由 schema 同时驱动输入验证、类型和 OpenAPI；响应做行为测试，尤其备份 union 和 OAuth 权限边界。`docs/openapi.json` 由生成器接管，原快照仅用于记录设计差异；契约的通过标准是本文与配套客户端测试，不是旧快照逐字段兼容。库原生端点使用插件类型与协议测试，不手写另一套兼容 SDK。

R5 记录服务端 SHA、联调 Desktop 的精确版本/commit 与 code→refresh→revoke 结果；涉及跨端契约变更时，先完成配套新版客户端验收再启用对应能力。发布和回退选择契约匹配的版本组合，不依赖旧版兼容层。

认证依赖的版本策略由下表统一维护；三个插件不是 `better-auth/plugins` 的内置导出，必须按切片加入独立 npm 包并锁定精确版本。

| npm 包                        | 目标版本 | 归属与当前验证状态                                                                                                           |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `better-auth`                 | `1.7.2`  | 已安装的核心基线；现有 GitHub/Session 测试不代表完整插件组合                                                                 |
| `@better-auth/passkey`        | `1.7.2`  | R2 引入；[官方包定义](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.2/packages/passkey/package.json)        |
| `@better-auth/api-key`        | `1.7.2`  | R4 引入；[官方包定义](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.2/packages/api-key/package.json)        |
| `@better-auth/oauth-provider` | `1.7.2`  | R5 引入；[官方包定义](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.2/packages/oauth-provider/package.json) |

2026-09-09 已核对三个插件的 npm 1.7.2 发布记录及 `better-auth`、`@better-auth/core` peer 范围 `^1.7.2`。这些事实只证明依赖来源和版本可用；插件尚未加入当前依赖树，完整组合的 workerd/D1、初始化 I/O、请求隔离及协议行为仍须通过 A4/A7。旧资产清单的 1.7.0 仅作历史对照，不能与上述目标版本混装，也不顺带升级核心。

引入每个插件时，以实际安装包的端点声明、请求/响应类型核对 §2 路由表，并通过正常与拒绝路径的协议测试。例如两个 Passkey options 路由在 [1.7.2 路由源码](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.2/packages/passkey/src/routes.ts) 中均为 GET；产生 challenge 的 GET 仍可能写入 verification。源码核对不代替完整登录流程验收。

旧 OAuth/API Key 补丁按单项测试移植或退役；移植文件需列明上游缺口、最小改动及可删除条件，不以 changelog 未提及当作仍有缺陷的证明。

协议校验依据：[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)、[RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)、[RFC 9068](https://www.rfc-editor.org/rfc/rfc9068)、[RFC 7009](https://www.rfc-editor.org/rfc/rfc7009)、[RFC 6750](https://www.rfc-editor.org/rfc/rfc6750)。这些标准规定互操作边界，本文中更窄的 client/scope/redirect 选择是项目策略。
