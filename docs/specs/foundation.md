# eruoo-server 产品与技术规格

> 状态：设计基线，待实现
> 最后更新：2026-08-20
> 代码仓库：`eruoo/server`
> 生产 Origin：`https://auth.eruoo.me`

本文档是 eruoo-server 产品范围、架构、安全模型和交付约束的单一事实来源。第 1 至 25 节是设计基线，其中明确标注为尚未确认或链接到待确认事项的内容仍未拍板；第 23 节中的额度是外部事实快照，第 26 节是推荐顺序，第 27 节是待确认事项，第 28 节是由前述内容派生的风险。实现不得自行补全待确认事项。

## 1. 产品定位

eruoo-server 是供 owner 本人使用的统一服务端，承担以下职责：

- 为管理 SPA，以及 Tauri Web、Desktop、Mobile 客户端提供身份认证与业务 API。
- 为本机 CLI、脚本和外部自动化提供受控的 API Key 调用能力。
- 提供同源的个人管理 SPA，用于管理 Passkey、API Key、已授权应用和安全审计事件。
- 作为 OAuth 2.1 与 OpenID Connect 发行者，为自己的 Tauri 多端应用签发 access token 和 refresh token。
- 以 OpenAPI 3.1 作为 HTTP API 的唯一长期契约。

首期只有一个 owner，不建设开放注册、多用户协作、B2B Organization 或公共身份平台。架构应允许未来增加自己的客户端，但不为尚不存在的公众用户提前引入多租户复杂度。

### 1.1 明确不做

初期不引入以下能力：

- 用户名密码、邮件验证码、短信验证码和公开注册。
- Cloudflare Access 作为应用身份系统。
- 微服务、Kafka、Kubernetes、GraphQL、Redis、service mesh。
- Hono RPC 作为公共客户端契约。
- 永久预发布环境。
- Sentry、OpenTelemetry、Logpush、Tail Worker、Analytics Engine、Workers Traces。
- 面向外部用户的 OAuth 动态客户端注册和 OAuth 客户端管理界面。
- 每台设备独立的授权记录模型。
- 定期季度恢复演练。

## 2. 系统全景

```mermaid
flowchart LR
  Owner[Owner]
  Admin[管理 Vue SPA]
  TauriWeb[Tauri Web]
  TauriNative[Tauri Desktop / Mobile]
  Automation[CLI / 脚本 / 外部自动化]
  GitHub[GitHub OAuth]

  subgraph Worker[auth.eruoo.me / Cloudflare Worker]
    Assets[Static Assets]
    Hono[Hono API]
    Auth[Better Auth]
    Issuer[OAuth 2.1 / OIDC Provider]
  end

  D1[(D1)]
  Schedule[Scheduled Trigger]
  Backup[备份 Workflow]
  Cleanup[审计清理任务]
  R2[(私有 R2 备份)]

  Owner --> Admin
  Admin -->|Session Cookie| Hono
  TauriWeb -->|Authorization Code + PKCE| Issuer
  TauriNative -->|Authorization Code + PKCE| Issuer
  Automation -->|x-api-key| Hono
  Auth --> GitHub
  Auth --> D1
  Hono --> Auth
  Hono --> D1
  Issuer --> D1
  Schedule -->|每周| Backup
  Backup -->|导出| D1
  Backup -->|写入| R2
  Schedule -->|每月| Cleanup
  Cleanup --> D1
  Assets --> Admin
```

### 2.1 核心边界

- 一个 GitHub 仓库、一个根 `package.json`、一个 Worker 项目和一次生产部署。
- Hono API 与 Vue SPA 静态资源使用同一 Worker 和同一域名。
- GitHub OAuth 只负责上游 owner 身份确认。
- Better Auth 负责应用 Session、Passkey、API Key 和相关身份数据。
- 本服务的 OAuth 2.1/OIDC Provider 为 Tauri 客户端签发本服务自己的 token。
- Hono 负责请求入口、协议适配、验证和粗粒度授权。
- 业务层只接收统一的 `Principal`，不得依赖 GitHub、Better Auth 或某一种 token 的原始结构。
- D1 存储关系型身份、授权、业务和审计数据。
- R2 只存储长期数据库导出文件，不替代 D1。

D1 面向表、索引和关系查询，所有在线认证与业务状态都从 D1 读取。R2 面向不可变对象和大文件，本项目只把它用于保存 SQL 备份对象。认证请求不得以 R2 作为在线数据源。

## 3. 技术选型

| 层级 | 采用方案 | 约束 |
| --- | --- | --- |
| 语言 | TypeScript 6.x stable | 开启严格类型检查；精确版本由 `package.json` 和 lockfile 固定 |
| 本地与 CI 工具链 | Node.js 24.x | 精确版本由仓库工具链和 CI 固定 |
| 生产运行时 | Cloudflare Workers Runtime | 实际运行时是 workerd，不是 Node.js 服务器 |
| 包管理 | pnpm 11 stable | 精确版本和完整性摘要由 `packageManager` 固定；提交 lockfile |
| 代码质量 | Oxlint、Oxfmt | 不引入 ESLint 或 Prettier；不启用 Oxlint type-aware |
| HTTP 框架 | Hono | 面向 Web Standards 与 Workers |
| Schema | Zod | 请求验证、领域边界和 OpenAPI schema |
| API 契约 | `@hono/zod-openapi`、OpenAPI 3.1 | OpenAPI 是唯一公共契约 |
| 身份系统 | Better Auth 1.7.x stable | GitHub OAuth、Passkey、Session、API Key、OAuth/OIDC Provider |
| 数据库 | Cloudflare D1 | 本地通过 Wrangler 使用本地 D1 |
| 业务 ORM | Drizzle ORM | 使用稳定版本，不追 RC 或实验性 joins |
| 前端 | Vue 3、Vite、Vue Router、Cloudflare Vite plugin | Composition API、`<script setup lang="ts">` |
| UI | `@ayingott/theme`、Tailwind CSS 4、Reka UI、Lucide | theme 提供 token，Reka 提供无样式可访问原语 |
| API 文档 | Scalar | 私有、只读、同源自托管固定版本资源 |
| 单元与集成测试 | Vitest、Cloudflare Workers 测试生态 | 不引入 Jest |
| E2E | Playwright | 覆盖关键浏览器流程 |
| 部署 | Cloudflare Workers Builds | GitHub 集成触发构建与部署 |

### 3.1 选型理由和被替代方案

- Fastify 是 Node.js 生态的 JavaScript/TypeScript 框架，但本项目最终运行在 Workers，因此采用原生适配 workerd 的 Hono。
- Bun、Elysia 和 Bun 上的 Fastify/Nest 不再作为本项目基线。Node.js 只承担工具链，生产依赖 Workers Runtime。
- OpenAPI 适合跨 Web、Rust/Tauri、CLI 和未来其他语言客户端的长期契约，因此不采用只适合同一 TypeScript 仓库同步发布的 Hono RPC。
- Better Auth 与 Cloudflare Access 不是同一类能力。Better Auth 是应用身份与授权层，Cloudflare Access 是外围零信任访问控制。初期使用 Better Auth，不要求 Cloudflare Access。
- Drizzle 是当前 Workers 与 D1 业务数据层的默认选择。Prisma 的 D1 支持和迁移路径不作为当前基线。
- Better Auth 自身直接使用原生 D1 binding，业务查询才使用 Drizzle，所以不是所有数据库操作都经过 Drizzle。
- `@ayingott/theme` 加 Reka UI 已足以构建设计系统和管理台。暂不引入 shadcn-vue、Nuxt UI、PrimeVue 或第二套视觉组件库。

本规格使用的 protected resource、resource-bound JWT 和 refresh retry/reuse 语义依赖 Better Auth 1.7。核心包及全部 `@better-auth/*` 插件必须使用同一稳定版本，不得降级到 1.6 或改用 RC。精确版本只在 `package.json` 和 lockfile 中维护。

Oxlint 是唯一 linter，只使用其非 type-aware 能力；未来启用 type-aware 必须另行确认。Oxlint 暂不支持的 Vue template lint 等能力不通过 ESLint 补齐，由 TypeScript、`vue-tsc`、Vue 编译器和测试覆盖可验证边界。Oxfmt 是唯一 formatter，不混用 Prettier。Oxfmt 仍处于 0.x 时必须固定精确版本，格式变化作为独立升级审查，不与功能改动混在同一提交中。

## 4. 仓库与模块结构

项目目标结构采用单 package、模块化单体。具体文件名允许在不改变边界的情况下调整：

```text
eruoo-server/
├── docs/
│   ├── index.md
│   └── specs/
│       └── foundation.md
├── migrations/
├── src/
│   ├── client/
│   │   ├── features/
│   │   ├── lib/
│   │   ├── views/
│   │   ├── main.ts
│   │   └── router.ts
│   ├── worker/
│   │   ├── auth/
│   │   ├── http/
│   │   ├── modules/
│   │   └── index.ts
│   └── shared/
├── tests/
├── .gitignore
├── .oxfmtrc.json
├── .oxlintrc.json
├── LICENSE
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.json
├── vite.config.ts
└── wrangler.jsonc
```

边界规则：

- `src/client` 只能使用浏览器可用代码。
- `src/worker` 只能使用 Workers 可用代码和已验证的 `nodejs_compat` 能力。
- `src/shared` 只放不依赖 DOM、Worker binding 或服务端 secret 的类型与纯逻辑。
- 页面和路由组件只做组合，功能逻辑下沉到对应 feature。
- Web 请求不得直接承载可靠的后台任务。需要可靠执行的备份使用 Workflow，定时清理使用平台定时触发器。
- Wrangler 启用 `nodejs_compat`，并在每次 Better Auth 升级时通过真实 workerd 测试重新验证兼容性。

### 4.1 工程基线

- 根 `package.json` 标记为 private ESM package，不发布到 npm。
- Node.js 24.x、pnpm 11 stable、TypeScript 6.x 和主要构建工具都固定到经过验证的精确版本。Node.js 的精确版本由仓库工具链文件和 CI 共用，pnpm 的精确版本和完整性摘要只由 `packageManager` 维护。
- 即使仓库只有一个 package，也提交 `pnpm-workspace.yaml` 作为 pnpm 项目级设置的单一事实来源；不配置 workspace package glob、catalog、`workspace:` protocol 或 monorepo runner。
- 提交 `pnpm-lock.yaml`。本地受控检查和 Workers Builds 均使用 frozen lockfile，构建过程中不得改写依赖解析结果。
- 保持 pnpm 默认 isolated linker，不启用 hoist 或 `shamefullyHoist`。依赖 lifecycle script 默认拒绝，只对经过审查且确实需要构建的包建立最小 allowlist，不允许全局放开。
- pnpm 供应链基线启用新版本 24 小时等待期、trust policy downgrade 防护和 exotic transitive dependency 阻断。紧急安全升级只能在单次审查中显式豁免，不设置永久宽松例外。
- 浏览器与 Vue SFC 使用独立的 TypeScript 配置并通过 `vue-tsc --noEmit`；Worker、共享代码和配置脚本通过对应的 `tsc --noEmit` 检查。Oxlint 不代替 TypeScript 类型门禁。
- 仓库提供稳定的 `format`、`format:check`、`lint`、`lint:fix`、`typecheck`、`test`、`test:integration`、`test:e2e`、`openapi:check`、`build` 和聚合 `check` 脚本。具体命令只在 `package.json` 维护，Workers Builds 只调用这些稳定入口。
- `format:check` 使用 Oxfmt，`lint` 使用非 type-aware Oxlint 并将 warning 视为失败。自动修复不得默认启用 suggestion 或 dangerous fix。
- `check`、`build` 和测试脚本不得修改远端 D1、R2、Secret 或 Worker。数据库 migration、生产 deploy 和其他外部状态变更必须使用独立且显式的脚本。

## 5. 域名和 Origin

### 5.1 生产配置

- 品牌主域名采用 `eruoo.me`。
- 服务唯一生产 Origin 为 `https://auth.eruoo.me`。
- Better Auth base URL：`https://auth.eruoo.me`。
- OAuth/OIDC issuer：`https://auth.eruoo.me`。
- Better Auth OAuth Provider 必须显式配置上述根 issuer，不得依赖默认 base path 推断。
- 根路径的 discovery 和 protected-resource metadata 必须由 Worker 返回，不能落入 SPA fallback。唯一的路由配置定义见 [Worker 和 Assets](#222-worker-和-assets)。
- Passkey RP ID：`auth.eruoo.me`。
- Passkey origin：`https://auth.eruoo.me`。
- GitHub OAuth callback：`https://auth.eruoo.me/api/auth/callback/github`。
- Session Cookie 只作用于 `auth.eruoo.me`，完整属性见 [Session 和敏感操作](#7-session-和敏感操作)。
- 生产 trusted origins 只包含精确 HTTPS Origin，不使用通配符，也不保留 localhost。
- 禁用可被用作生产身份入口的 `workers.dev` 和公开 Preview URL，防止绕过正式域名的 Cookie、Passkey 和访问策略。

### 5.2 其他域名

- `eruoo.dev` 暂不用于本服务，未来更适合作为开发者文档、SDK 或技术内容域名。
- `ayingott.me` 不作为本服务的生产域名，现有 `@ayingott/*` 包名不因此变更。
- 是否将 `eruoo.dev` 或 `ayingott.me` 重定向到 `eruoo.me` 尚未确认。

## 6. Owner 身份和初始注册

### 6.1 唯一 owner

- 唯一 owner 由 GitHub 不可变 numeric ID 标识，当前允许值为 `50254496`。
- 该 numeric ID 是经过确认并刻意提交的公开身份标识，不是认证凭证。知道该值本身不能通过 GitHub OAuth 身份校验。
- 用户名和邮箱只作为显示资料或告警信息，不作为准入锚点。
- 不开放通用注册入口。
- Better Auth 的 `user.validateUserInfo` 是统一准入门。它必须要求 OAuth provider 为 GitHub，并在 `create-user`、`link-account` 和后续 `sign-in` 时校验 raw provider profile 中的 numeric ID 等于 `50254496`。
- provider `getUserInfo` 只负责资料规范化，不承担唯一安全门禁。
- 如增加数据库 hook 作为补充防线，该 hook 必须允许合法 owner 的首次 bootstrap，只拒绝其他身份。不得用静态关闭所有 sign-up 的配置阻断首次 owner 创建。

### 6.2 首次部署流程

首次部署后的第一次合法 GitHub OAuth 登录就是受控 bootstrap：

1. 部署带有 owner GitHub numeric ID allowlist 的版本。
2. owner 通过 GitHub OAuth 登录。
3. 服务校验 numeric ID 后创建唯一用户和 Session。
4. owner 在已登录状态下注册 Passkey。

无需“先开放注册、注册后关闭注册、再部署一次”。任何非 allowlist GitHub 身份从第一次请求开始就应被拒绝。

### 6.3 GitHub OAuth

- GitHub OAuth 是初始登录与恢复通道。
- GitHub OAuth App 使用[域名和 Origin](#5-域名和-origin)定义的唯一生产 callback。
- OAuth state 和 PKCE 由 Better Auth 处理。
- OAuth token 在 D1 中的加密必须显式启用。
- GitHub client secret 只存储在 Cloudflare Secret 中。
- Better Auth 使用版本化 `BETTER_AUTH_SECRETS`。当前 secret 排在首位用于新数据加密，旧 secret 只在迁移窗口内用于解密已有数据，确认不再需要后再移除。
- Session Cookie、OAuth state 和其他签名路径能否跨 secret 轮换延续，不从加密轮换能力推断，必须通过部署前黑盒测试确认。

### 6.4 Passkey

- 启用 Passkey。
- Passkey 是首选的日常登录和敏感操作重新认证方式。
- GitHub OAuth 保留为恢复和回退方式。
- Passkey 凭据绑定 `auth.eruoo.me`。未来迁移到不同 RP ID 时，既有 Passkey 不能直接沿用。

## 7. Session 和敏感操作

- Session 固定有效期 30 天。
- 不采用滑动续期。
- Better Auth Session cookie cache 保持关闭，以便撤销持久化 Session 后立即生效。
- Cookie 使用 Secure、HttpOnly、SameSite=Lax 和 host-only 属性。
- `crossSubDomainCookies` 保持关闭。
- 固定 production base URL，不依赖请求头推断。
- 不关闭 CSRF 和 Origin 校验。
- 固定 base URL 后不启用不必要的 trusted proxy header 推断。

以下敏感操作要求在最近 15 分钟内重新认证：

- 创建、撤销或修改 API Key。
- 创建或删除 Passkey。
- 撤销已授权应用。
- 其他会改变长期凭证、安全策略或密钥状态的操作。

重新认证优先使用 Passkey，GitHub OAuth 作为回退。

服务端在 D1 Session 记录中维护 `reauthenticatedAt`，初次完成强认证时写入登录时间，之后只有成功完成 Passkey 或 GitHub 重新认证 ceremony 才更新。敏感操作 middleware 从当前持久化 Session 读取该值，并要求 `now - reauthenticatedAt <= 15 minutes`。不得使用前端时间、普通页面活动或 cookie 刷新更新时间替代该字段。

## 8. 统一身份主体与授权

业务层使用统一主体：

```ts
interface Principal {
  subject: string
  authMethod: 'session' | 'oauth' | 'apiKey'
  clientId?: string
  scopes: string[]
  permissions: string[]
  credentialId?: string
  reauthenticatedAt?: number
}
```

不同认证方式必须满足以下不变量：

| `authMethod` | 必需字段 | 不得从客户端直接信任的内容 |
| --- | --- | --- |
| `session` | `subject`、服务端派生的 `reauthenticatedAt` | 用户 ID、权限和最近重新认证时间 |
| `oauth` | `subject`、`clientId`、`scopes` | 未验证 token 中的任何 claim |
| `apiKey` | `subject`、`credentialId`、`permissions` | 请求自行声明的权限或 key owner |

授权规则：

- 每个路由必须显式声明允许的认证方式。
- 管理路由只允许 owner Session。
- 业务路由按需要允许 Session、OAuth access token 或 API Key。
- 自有业务和管理 API 只识别三种凭证载体：配置的 Better Auth Session Cookie、`Authorization: Bearer` 和 `x-api-key`。该规则不适用于 OAuth/OIDC 协议端点。
- access token 只能通过 `Authorization: Bearer` 传输，不支持 form body 或 query 中的 `access_token`。
- 同一个请求携带多个载体、重复同一种认证 header、重复 Session Cookie，或认证载体语法畸形时，在验证任何凭证前返回 400 Problem Details，其 `type` 表示 `invalid-request`。
- 上述 400 如果涉及 Bearer 载体且路由接受 Bearer，还必须按[错误响应](#113-错误响应)返回 `invalid_request` challenge。
- 请求只携带一种语法有效但内容无效或过期的凭证时返回 401。
- 同源浏览器会自动携带 Session Cookie。需要发送 Bearer token 的客户端必须使用 `credentials: omit` 或独立 Origin，避免形成多凭证请求。
- OAuth scope 或 API Key permission 只做粗粒度准入。
- 资源所有权和业务状态必须在领域层及数据库查询中再次检查。
- 不得只相信 path、query 或 header 中的 resource ID。
- 默认拒绝。没有明确允许规则的认证方式和权限均不得访问。

## 9. API Key

### 9.1 用途

API Key 是第二条认证通道，供以下调用者通过公网 HTTP 调用业务 API：

- 本机 CLI。
- 脚本。
- GitHub Actions 或其他外部自动化。
- 不具备交互式浏览器登录流程的个人客户端。

API Key 不用于浏览器登录，不替代 OAuth/OIDC，也不用于同一 Worker 内部的 Cron Trigger。内部定时任务直接调用领域服务函数。

### 9.2 凭证规则

- 使用 Better Auth API Key plugin。
- 请求头为 `x-api-key`。
- 原始 key 只在创建响应中返回一次，数据库只存储哈希。
- 每个脚本或客户端使用独立 key，禁止多个用途共享一把 key。
- 默认有效期 180 天，最大允许 365 天，不允许永久 key。
- 到期前 14 天在管理 SPA 提醒，并在相关 API 响应中提供提醒 header。
- 每把 key 显式配置最小权限。
- 权限命名采用 `resource:action`，不启用 wildcard。
- 默认每把 key 每分钟 60 次请求。
- 限流计数同步写入 D1，不使用延迟更新。
- `enableSessionForAPIKeys` 保持 `false`，API Key 不得模拟浏览器 Session。
- 服务端验证 key 后仍必须按路由检查 permission，插件验证成功不等于业务授权成功。
- key 不得出现在 URL、日志、错误详情或客户端遥测中。

### 9.3 禁止访问范围

API Key 不得访问：

- 登录、Session 和账号管理。
- Passkey 管理。
- API Key 管理。
- 安全审计和安全配置。
- OAuth/OIDC 授权管理。
- Scalar 文档和 OpenAPI spec。

## 10. Tauri 应用的 OAuth 2.1/OIDC 设计

### 10.1 服务端职责

Tauri 登录与 token 生命周期的协议设计属于本服务端。服务端同时作为：

- 上游依赖 GitHub OAuth/Passkey 的身份系统。
- 面向 Tauri 客户端的 OAuth 2.1/OIDC Authorization Server。
- 验证自己签发的 access token 的 Resource Server。

Tauri 客户端不得直接把 GitHub token 当作业务 API token。

### 10.2 静态客户端

预置三个 public client：

- Web。
- Desktop。
- Mobile。

共同规则：

- 不使用 client secret。
- 使用 Authorization Code Flow 和 PKCE S256。
- 每次授权请求生成高熵随机 `state`，并安全地临时保存 PKCE verifier。
- 回调必须精确比较 `state`。
- 使用 OIDC ID token 时生成 `nonce`。客户端必须验证 JWKS 签名、算法 allowlist、`iss`、`aud`、存在时的 `azp`、`exp`、`iat`、`nonce`，以及存在时的 `at_hash`。
- 禁用动态客户端注册。
- redirect URI 按登记字符串进行简单字符串比较，不做 URI 规范化。只有 RFC 8252 的 loopback IP 端口可以变化。
- 服务端先完成 redirect URI 匹配，再向已验证的 URI 附加 `code`、`state` 或 `error`。
- 跳过 consent 只适用于静态登记、预授权且归 owner 所有的客户端。
- 客户端定义通过 D1 migration 创建或幂等 upsert，不建设管理 UI，也不对外开放 Better Auth 的客户端创建、更新、删除或 secret rotate 端点。
- 一份静态客户端清单是唯一编辑来源，D1 migration 和 Better Auth `cachedTrustedClients` 均由它派生。
- 测试必须保证生成的 migration 数据与运行时 trusted client 配置一致。

### 10.3 Protected Resource

- 业务 API 作为一个 OAuth protected resource 登记。
- 三个客户端都必须与该 resource 建立 `oauthClientResource` 关联。
- authorization request 和授权码 token exchange 都必须携带并校验同一个已登记 `resource` 参数，授权码自身也必须绑定该 resource。
- refresh request 省略 `resource` 时沿用 token family 原有绑定；携带时只能请求原绑定集合的子集，否则返回协议错误 `invalid_target`。
- 当前只有一个 resource，因此 refresh request 携带的值只能与原绑定完全相同。
- refresh 轮换不得扩大 resource 集合，新 access token 的 `aud` 必须反映本次有效 resource，新 refresh token 继续绑定原获批集合。
- Resource Server 验证的 `aud` 必须与该 resource identifier 完全一致。
- resource identifier 的最终值尚未确认，见[待确认事项](#27-待确认事项)。在该值确认前，不得宣称 Tauri OAuth 流程已完成。

### 10.4 Scope

首期 scope：

- `openid`
- `profile`
- `api:read`
- `api:write`
- `offline_access`

`offline_access` 只允许 Desktop 和 Mobile 客户端申请。Web 客户端申请时返回协议错误 `invalid_scope`。

### 10.5 Web 客户端

- Web 是 public client，首版不引入 BFF。
- access token 只保存在内存中。
- 不写入 localStorage、sessionStorage、IndexedDB 或 Cookie。
- 不向 Web 客户端签发 refresh token。
- 页面刷新、浏览器重启或 access token 到期后，通过顶层导航重新执行授权流程。

### 10.6 Desktop 和 Mobile

- 必须使用系统浏览器登录，不在 Tauri WebView 内收集 GitHub 或 Passkey 凭证。
- Desktop 使用 `127.0.0.1` 或 `[::1]` loopback redirect，不使用 `localhost`，并只允许端口按 RFC 8252 动态变化。
- Mobile 使用已验证的 claimed HTTPS deep link。
- refresh token 的存储、轮换、注销和业务 API 调用由 Tauri Rust 侧负责。
- refresh token 存入 Stronghold，不暴露给前端 JavaScript。

### 10.7 Access token

- JWT 签名算法采用 EdDSA/Ed25519。
- access token 有效期为 1 小时。
- access token header 必须使用能明确区分 access token 的 `typ`，不得把 ID token 当作 access token。是否完整采用 RFC 9068 profile 尚未确认。
- 必需 claims 至少包括 `iss`、`sub`、`aud`、`exp`、`iat`、`jti`、`client_id` 和 `scope`。`nbf` 存在时也必须验证。
- `iss` 必须精确等于 `https://auth.eruoo.me`，`aud` 必须精确包含已登记的 protected resource identifier。
- Resource Server 通过本地 JWKS 验证签名、算法 allowlist、issuer、audience、有效期、token 类型和全部必需 claims。
- 不使用未加额外约束的 Hono 内置 `jwk({ jwks_uri })` 作为生产验证器。采用 Better Auth 官方验证能力或 `jose`。
- 未知 `kid` 可以触发受限刷新，但必须设置冷却或负缓存，防止刷新放大。每次密钥轮换产生全局唯一的 `kid`。
- 已接受以下撤销延迟：用户注销或授权撤销后，已签发 access token 最长继续有效 1 小时。
- 加密后的私钥存储在 D1，密钥加密材料只存储在 Cloudflare Secret 中，不进入 D1 或代码。
- 私钥加密和 secret 轮换的实际路径必须通过部署前黑盒测试确认，不假定 `BETTER_AUTH_SECRETS` 自动覆盖所有签名或加密用途。
- 签名密钥每 30 天轮换。
- 正常轮换后旧公钥保留 7 天验证宽限期。

### 10.8 Native refresh token

- 30 天 idle sliding 有效期。
- 每次 refresh 都轮换 token。
- 为网络重试提供 30 秒 retry/reuse window。它在窗口内放宽严格重放检测，以可用性换取有界安全风险：取得旧 refresh token 的攻击者也可能拿到已缓存的 successor credentials，且不会立即触发告警。
- 窗口内同一 client、scope、resource 和 token family 的等价重试复用相同的 access token 与 successor refresh token 值。响应中的剩余时长等元数据可以按缓存状态更新。
- 并发 refresh 最多产生一条 successor token 链。竞争请求可以得到同一组缓存凭证或 `invalid_grant`，不得产生分叉。
- 超出容忍窗口再次使用旧 refresh token 时，写入审计并撤销整个 token family。
- Native logout 必须服务端撤销 refresh token，并清除 Stronghold 中的本地凭证。

### 10.9 已授权应用

管理 SPA 提供“已授权应用”界面：

- 展示 Web、Desktop、Mobile 的客户端授权状态。
- 只为 Desktop 和 Mobile 展示离线授权，并允许按 client 撤销其全部 refresh token。
- 撤销前要求 15 分钟内的敏感操作重新认证和明确确认。
- 首版不细分到每台具体设备。

## 11. HTTP API 契约

### 11.1 路径和版本

- 自有业务 API 放在 `/api/*`，但 Better Auth、OAuth 和 OIDC 协议端点不属于“自有业务 API”。
- 首版不增加 `/api/v1`。
- 只有出现独立发布的第三方客户端，或需要并行维持不兼容版本时，才引入 path version。
- Better Auth、OAuth 和 OIDC 协议端点保留各自协议要求的原生路径与响应，不强行套用业务 API 包装。

### 11.2 成功响应

成功响应直接返回资源 JSON，不使用 `{ "success": true, "data": ... }` 包装。

`GET /api/status` 的确认行为：

- 仅允许 owner Session。
- 成功状态为 `200`。
- 响应体为：

```json
{
  "status": "ok"
}
```

- API Key 和 OAuth access token 均不得访问。
- 响应包含 `Cache-Control: no-store`。
- 没有有效 Session 时返回 401。Session/D1 依赖调用失败而无法判定身份时返回 503，不得把依赖故障伪装成无权限。
- 成功的 Session 验证本身就是最小 D1 可用性检查，端点不执行无关的深度依赖探测。503 响应不公开依赖细节。

### 11.3 错误响应

自有业务 API 的 4xx 和 5xx 使用 RFC 9457 Problem Details，Content-Type 为 `application/problem+json`。Better Auth、OAuth 和 OIDC 协议端点排除在该规则之外：

```json
{
  "type": "<canonical-problem-uri>",
  "title": "<short-summary>",
  "status": 401,
  "detail": "<human-readable-detail>",
  "requestId": "<request-id>"
}
```

请求验证错误额外包含：

```json
{
  "type": "<canonical-problem-uri>",
  "title": "<short-summary>",
  "status": 422,
  "detail": "<human-readable-detail>",
  "requestId": "<request-id>",
  "errors": [
    {
      "location": "body",
      "pointer": "/field",
      "detail": "<validation-detail>"
    }
  ]
}
```

约束：

- 不增加顶层 `code`。
- `type` 必须是稳定的 URI reference，优先采用绝对 URI，客户端可据此分支处理。
- `title` 是短摘要，`detail` 是本次错误的可读说明。
- `requestId` 用于关联服务端日志，不泄露内部堆栈。
- Better Auth、OAuth/OIDC 协议错误继续使用协议原生结构。
- 请求语法或 JSON 解析错误返回 400；必需 body 使用不支持或缺失的媒体类型时返回 415；语法正确但不满足 schema 或业务输入约束时返回 422。
- 所有 Bearer challenge 都至少包含稳定的 `realm="eruoo-api"`。
- Bearer 路由完全缺少认证信息时返回 401，challenge 不带 `error`。
- Bearer 载体重复、语法畸形、与其他载体并存，或通过不支持的 body/query 传输时返回 400，challenge 使用 `invalid_request`。
- Bearer token 内容无效或过期时返回 401，challenge 使用 `invalid_token`。
- Bearer token 缺少 scope 时返回 403，challenge 使用 `insufficient_scope`，并可以带所需 `scope`。
- 已认证后的资源归属或领域授权失败返回普通 403，不添加 Bearer `error`。
- Problem Details 不替代 RFC 6750 要求的 `WWW-Authenticate` header。

### 11.4 时间

- D1 中的持久化时间统一存为 Unix epoch milliseconds 的 INTEGER。
- 不存储带 `UTC+8` 语义的本地时间字符串。
- API 最终序列化形式和管理 SPA 显示 UTC 还是 Asia/Shanghai，留到前端实现阶段确认。

## 12. OpenAPI 和请求验证

- OpenAPI 3.1 是唯一长期 API 契约。
- 所有参与生成 spec 的 API router 使用 `OpenAPIHono` 并直接挂载，避免 plain Hono 深层子树漏入 registry。
- 业务必需的 JSON/form body 必须显式标记 `required: true`。
- 使用统一 `defaultHook` 输出稳定的 Problem Details 验证错误。
- handler 显式返回 status code。
- 每个实际可能返回的状态均写入 response schema，至少覆盖相关的 400、401、403、404、409、415、422、429 和 500。
- 每个 operation 使用稳定且唯一的 `operationId`。
- OpenAPI `security` 只生成文档，不会自动安装认证中间件。运行时必须使用受保护 router 和真实 middleware。
- response schema 当前主要提供类型和文档，不等同于运行时 response validation。高风险或由外部数据拼装的响应应显式执行 Zod parse，其他响应通过契约测试保障。
- `servers` 使用配置中的固定公网 Origin，不从未清洗的 Host 或 forwarded header 动态拼接。
- Hono 保持 strict routing，统一无尾斜杠，并覆盖 `/x` 与 `/x/` 行为测试。
- 生成的 OpenAPI JSON artifact 提交到 Git。CI 和本地 `openapi:check` 必须重新生成并在存在未提交 diff 时失败，避免实现与契约漂移。
- 前端 API 类型从已提交的 OpenAPI artifact 派生，避免另行手写重复 DTO。生成的 TypeScript 类型不提交到 Git，由构建和类型检查按需生成。生成器和请求客户端的具体包尚未确认。
- 仓库公开意味着已提交的 OpenAPI artifact 也是公开资料。artifact 不得包含 secret、真实 token、个人数据或内部管理凭证；运行中的 Scalar HTML 和 OpenAPI JSON 端点仍按第 13 节要求进行 owner Session 保护。

## 13. Scalar API 文档

- 使用 Scalar 展示 OpenAPI 3.1。
- 运行中的 Scalar UI 和 OpenAPI JSON endpoint 是 owner 私有、只读管理能力；Git 仓库中的 OpenAPI artifact 公开。
- Scalar HTML 和 OpenAPI JSON 均必须经过 owner Session middleware。
- API Key 和 OAuth access token 不得访问。
- 只有固定版本的 Scalar JS、CSS 和字体资源由 Workers Static Assets 直接提供，不在生产运行时依赖未锁定的 CDN。具体路由配置以 [Worker 和 Assets](#222-worker-和-assets)为准。
- Scalar HTML 和 OpenAPI JSON 必须先进入 Worker，完成 Session 验证后动态返回，不得作为可绕过认证的普通静态文件发布。
- `hideTestRequestButton: true`。
- `persistAuth: false`。
- `agent.disabled: true`。
- `withDefaultFonts: false`。
- 不配置外部 proxy URL。
- 文档响应使用 `Cache-Control: private, no-store`。
- 不把静态 token 写入 Scalar 配置或页面源码。
- CSP 使用 nonce 保护 script。构建后根据实际 CSP 违规报告收敛到最小策略；如果固定版本的 Scalar 确实需要内联 style，只对文档页面放宽 `style-src`，不得放宽 `script-src` 或其他页面。

## 14. CORS 和不同客户端

首版直接启用 Hono CORS middleware，因为近期会有其他 Web 服务和 Tauri Web 客户端调用。

规则：

- 使用配置化的精确 Origin allowlist，不允许 `*`。实际跨 Origin Web 客户端 Origin 尚未确认。
- OAuth authorization endpoint 通过顶层浏览器导航访问，不得返回 CORS header。
- Tauri Web 所需的 discovery metadata、JWKS、token、userinfo、revocation 和 protected-resource metadata 端点，对已登记 Web Origin 返回精确 CORS header。
- 允许跨 Origin 的业务 API 只对已登记 Web Origin 返回 CORS header。
- 上述 OAuth/OIDC 与 Bearer API 请求不使用 Cookie credentials，不返回 `Access-Control-Allow-Credentials: true`。
- 管理 SPA、Better Auth Session 和安全管理端点保持同源，不向其他 Origin 开放 credentialed CORS。
- preflight 处理必须位于认证 middleware 之前。
- Better Auth trusted origins 与 CORS allowlist 是两个独立安全边界，必须分别配置和测试。
- CORS 只约束浏览器读取响应，不是认证、授权或数据访问控制。
- Native Tauri 由 Rust 侧发起 API 请求，不依赖浏览器 CORS；其 Web 版本依赖该策略。

## 15. HTTP 安全中间件

中间件从外到内保持以下顺序：

1. Request ID。只接受长度和字符集均合规的上游 ID，否则由服务生成。
2. 结构化日志与安全响应头。
3. CORS。先处理合法 preflight。
4. CSRF。只用于 Cookie 或其他 ambient credential 的浏览器 unsafe 请求。
5. Body limit。普通 JSON 默认上限 1 MiB，上传另设专用策略。
6. 请求与下游调用 timeout。对支持取消的下游 `fetch` 传播 AbortSignal；不得假设 D1 支持取消已发出的 statement。
7. Authentication。
8. OpenAPI request validation。
9. 粗粒度 permission/scope 检查和领域资源授权。

其他安全要求：

- 只使用 Cloudflare 清洗后的 `CF-Connecting-IP` 做限流或 IP 指纹，不信任客户端任意提供的 `X-Forwarded-For`。
- 生产日志必须清除 Authorization、Cookie、API Key、token、请求正文和 PII。
- 登录、refresh、API Key 等入口的限流使用 D1 或可信平台能力，不使用单进程内存状态。
- 不在 HTTP handler 内执行 fire-and-forget 的可靠任务。
- OpenAPI 中声明为 protected 的每个 operation 都必须通过无凭证请求返回 401 的自动化测试。

## 16. 前端管理 SPA

### 16.1 技术与部署

- Vue 3、TypeScript、Vite、Vue Router。
- 使用 Composition API 和 `<script setup lang="ts">`。
- 不引入 Nuxt。
- 首版不引入 Pinia。Session 使用 Better Auth Vue reactive client，页面状态优先使用局部状态或 composable。
- SPA 通过 Workers Static Assets 发布，完整路由配置以 [Worker 和 Assets](#222-worker-和-assets)为准。
- 其他普通静态资源直接由 Assets 提供，不消耗不必要的 Worker 动态请求。
- 前端 route guard 只改善 UX，不是安全边界。所有数据和操作仍由后端验证。
- `VITE_*` 变量会进入客户端 bundle，禁止放 secret。

### 16.2 设计系统

- `@ayingott/theme` 是 token 和主题契约的唯一来源。
- `@ayingott/theme` 来源于 `LoTwT/theme`，Tailwind CSS 4 是其样式构建依赖，不是第二套设计系统。
- 使用 theme 包的 `brutal` 设计风格。
- 必须支持 Neo Light 和 Neo Dark，它们是 brutal 风格对应的浅色与深色主题。
- Reka UI 提供无样式的可访问交互原语，包括键盘导航、焦点管理和 ARIA 基础。
- Lucide 提供图标。
- theme 包内置字体以 Static Assets 同源提供，不在运行时请求 Google Fonts 或其他字体 CDN。
- 在应用内建立 theme token 到组件状态的 bridge，不把 shadcn 默认变量或应用组件适配器发布回 theme 包。
- theme 包继续保持 token-only。
- 应用必须补齐 destructive hover/active、modal backdrop、highlighted、open 和 invalid 等交互状态的 token 映射。
- 首版只实现实际需要的组件，不引入复杂 Data Table。

### 16.3 必需界面

管理 SPA 至少提供：

- GitHub OAuth 登录和 Passkey 登录。
- Passkey 管理。
- API Key 创建、显示一次、列表、撤销、权限与到期提醒。
- 已授权应用查看与撤销。
- 安全审计页 `/security/audit-log`。

没有确认独立的 `/status` SPA 页面。当前只确认后端 `/api/status`。

## 17. D1、Drizzle 和迁移

- D1 是主要关系型数据库。
- Better Auth 直接接收 `env.DB` 原生 D1 binding，并使用其 D1 支持完成内部操作。
- Drizzle 只负责业务 schema 和业务查询。
- 不使用 Better Auth Drizzle adapter 作为统一入口，避免削弱其原生 D1 batch 语义并减少版本耦合。
- 所有结构变更最终形成可审查、可提交的 Wrangler D1 migration。
- migration 在依赖新 schema 的 Worker 版本生效前执行，不在每个 replica 启动或请求期间自动执行。
- 本地 D1 使用 Wrangler/Miniflare 本地持久化，无需 Docker。
- 同一套 migrations 同时用于本地和生产。
- 初期关闭 D1 read replication。
- 不设计依赖 interactive transaction 的自定义关键流程。需要原子性的受支持操作使用 D1 batch。
- Drizzle 使用与 Better Auth 和 D1 兼容的稳定版本，不采用 RC、relations v2 或 experimental joins。

## 18. 安全审计

### 18.1 数据范围

D1 中维护 `security_audit_events`，只记录安全事件，不记录每次成功的普通业务 API 调用。

事件至少覆盖：

- 登录成功与失败。
- Passkey 创建、删除和使用异常。
- API Key 创建、撤销、过期和拒绝。
- OAuth grant、撤销和 refresh token 异常 reuse。
- 敏感操作授权拒绝。
- JWT 签名密钥轮换。
- 重要安全配置变更。
- 数据库恢复完成事件 `database_restore_completed`。

### 18.2 保存与隐私

- 查询和产品语义上的保留期为 180 天，API 不返回更早的事件。
- 每月由定时任务物理清理过期记录，因此旧记录在数据库中最多可能额外停留约 31 天。
- `occurredAt` 使用 Unix epoch milliseconds。
- 不保存原始 IP。
- 使用 Cloudflare Secret `AUDIT_IP_HASH_SECRET` 生成 keyed HMAC IP 指纹。
- 不记录 Cookie、token、API Key、Passkey 数据或敏感请求正文。
- 审计写入失败不得使原本的登录、授权或业务操作失败。
- 写入失败时向 Workers Logs 输出结构化 `audit_write_failed` 警告和 `requestId`。

### 18.3 查询

- API：`GET /api/security/audit-events`。
- SPA：`/security/audit-log`。
- 只允许 owner Session，API Key 和 OAuth access token 均拒绝。
- 默认按 `(occurredAt DESC, id DESC)` 排序，并使用排他的 opaque cursor。
- 默认每页 50 条，最大 100 条。
- 支持 `type`、`outcome`、`from`、`to` 过滤。
- cursor 必须绑定当前过滤条件；过滤条件变化后旧 cursor 无效。
- 建立匹配排序和过滤使用方式的复合索引。
- 审计表排除在长期 R2 数据库快照之外。

## 19. D1 备份和恢复

### 19.1 备份

- D1 Time Travel 保留为 Cloudflare 提供的短期平台能力。
- 长期备份使用 Cloudflare Workflow。
- 每周日 03:00 Asia/Shanghai 执行，对应每周六 19:00 UTC。
- 通过 D1 REST API 导出 SQL，并写入私有 R2 Standard bucket。每份快照记录源代码 revision 和已应用的 migration 状态。
- 导出时动态枚举 D1 应用普通表，并过滤 `sqlite_*` 和 `_cf_KV` 等平台内部表。
- 当前备份方案禁止 D1 virtual table，包括 FTS5。任何引入 virtual table 的 migration 必须被 schema 门禁拒绝，除非先替换并验证新的备份方案。
- `security_audit_events` 只导出 schema，不导出事件数据。migration 记账表的 schema 和数据必须纳入，其余应用表默认全部纳入，避免静态白名单遗漏新表。
- Workflow 必须持续轮询 export 任务直至完成，避免任务因无人轮询而取消。
- export 成功后必须在 signed URL 有效期内下载并写入 R2。任何失败都保留上一份完整有效备份，不以部分对象覆盖它。
- R2 lifecycle 在对象满 180 天后删除。
- R2 bucket 不启用 `r2.dev`、自定义域名、浏览器 CORS 或下载 API。
- 使用 R2 平台默认的静态加密。
- GitHub client secret、Better Auth secrets、D1 API token 和审计 HMAC secret 不属于数据库快照，必须在 Cloudflare Secrets 中独立管理。
- 该方案不是跨 Cloudflare 账号灾难恢复。

### 19.2 恢复

- R2 SQL 快照只能导入新建且隔离的空 D1，禁止直接覆盖生产 D1。
- 先导入自包含的 SQL 快照，恢复备份时的 schema、migration 状态和业务数据；此时审计表已存在但为空。
- 再从快照记录的 migration 状态向前应用仓库中剩余 migration，直到目标版本。
- 验证新数据库后再切换 Worker binding。
- 切换前必须清除快照中可能复活的旧凭证状态：
  - Session。
  - verification。
  - API Key。
  - OAuth access token、refresh token、consent 和限流状态。
  - Passkey。
- 删除快照中的全部旧 JWKS 和签名私钥状态。
- 保留 GitHub 账号关联，但清除 provider access token、refresh token 和 ID token。
- 删除快照中的 OAuth client 和 client-resource 关联，再依据当前静态 migration 重新创建。
- 重新生成 Ed25519 JWKS，不保留旧 key 的 7 天宽限期。
- 审计表保持为空，并在新环境写入 `database_restore_completed`。
- owner 必须重新登录、重新注册 Passkey，并让客户端重新授权。
- 普通数据损坏恢复不自动轮换 Better Auth secrets。只有怀疑 secret 泄露时才轮换。
- 不要求季度恢复演练。

Time Travel 当前是原地恢复能力，与“禁止覆盖生产 D1”的恢复原则不兼容。因此在该原则不变时，Time Travel 只作为已知平台能力，不纳入标准恢复操作；标准恢复以隔离新 D1 加 R2 SQL 快照为准。

## 20. 可观测性

- 初期只启用 Cloudflare Workers Logs。
- Workers Logs 使用 100% head sampling。
- 100% sampling 会保留平台 invocation log，但应用不得为每个成功请求额外写一条自定义日志。
- 自定义日志只覆盖错误、警告、备份失败、签名密钥事件和审计基础设施故障。
- 日志使用结构化对象并包含 `requestId`。
- 日志必须对 Cookie、Authorization、API Key、access token、refresh token、Passkey、secret、请求正文和 PII 脱敏。
- Workers Logs 只承担短期诊断，长期安全查询由 D1 审计表承担。

## 21. 测试和验收门槛

### 21.1 测试工具

- Vitest 用于纯逻辑、Worker、D1 集成和 Vue 组件测试。
- Cloudflare 官方 Workers 测试生态用于 workerd binding 与本地 D1。
- Playwright 用于浏览器 E2E。
- 测试使用真实本地 D1 migrations，不只依赖 mock。
- 所有门禁从 frozen lockfile 安装开始，并依次覆盖 Oxfmt check、Oxlint、`tsc`、`vue-tsc`、测试、OpenAPI drift 和生产构建。
- Oxlint 不启用 type-aware，也不检查 Vue template。该限制是已接受的工具边界，未来改变必须另行确认，不得通过同时引入 ESLint 形成两套 lint 规则。

### 21.2 必须覆盖的矩阵

认证与授权：

- 无 token、格式错误、错误签名、错误算法、未知 `kid`。
- 过期、超出允许时钟偏差的未来 `nbf/iat`、错误 issuer/audience。
- ID token 冒充 access token。
- 缺 scope/permission、错误资源归属、合法凭证。
- JWKS rotation、缓存和上游故障。
- 同时携带多种凭证时拒绝。
- Session Cookie、Bearer 和 API Key 两两组合、重复载体和畸形载体均返回预期错误。
- 管理端点拒绝 API Key 和 OAuth token。

API Key：

- 创建时原始 key 只显示一次。
- 哈希存储、权限最小化、180 天默认有效期和 365 天上限。
- 过期、撤销、60 次每分钟限流和 14 天提醒。
- `enableSessionForAPIKeys=false`。

OAuth/OIDC：

- PKCE S256。
- redirect URI 精确匹配和非法 redirect 拒绝。
- client 与 scope 限制。
- Web 不获得 refresh token。
- Web 申请 `offline_access` 返回 `invalid_scope`。
- Native refresh rotation、30 秒 retry window、异常 reuse 撤销。
- 顺序重试复用相同 access/refresh token 值；真实 D1 并发 refresh 最多生成一条 successor 链。
- refresh 请求省略、保留和改变 `resource` 的行为，以及轮换后 `aud` 不扩大。
- 远程撤销和 logout。
- redirect URI 的大小写、百分号编码、query、loopback IP 与动态端口边界。

HTTP 和契约：

- 缺失或错误 Content-Type、空 body、畸形 JSON、超限 body、额外字段。
- 400、415 与 422 的分工。
- Bearer challenge 的稳定 `realm`，以及无凭证、`invalid_request`、`invalid_token`、`insufficient_scope` 和领域授权失败分支。
- OpenAPI artifact snapshot/diff。
- `operationId` 唯一、security 声明完整、实际响应状态被记录。
- OpenAPI 中每个 protected operation 在无凭证时返回 401。
- 所有 public operation 都在显式 allowlist 中。
- 真实 Cloudflare adapter smoke test，而不只使用 `app.request()`。
- CORS exact allowlist、preflight 和无 credential Bearer 请求。
- OAuth authorization endpoint 不返回 CORS header。
- `/api/status` 的 200、401、503、no-store 和认证方式限制。

前端和 E2E：

- GitHub OAuth bootstrap 的允许与拒绝路径。
- Session 恢复和注销。
- Passkey 注册、登录、删除与重新认证。
- API Key 显示一次、撤销和到期提醒。
- 已授权应用撤销。
- 审计列表权限与分页。
- Neo Light 和 Neo Dark 基本可用性、键盘导航和焦点管理。

### 21.3 部署前验证

- 使用 Wrangler dry-run 检查 Worker bundle；使用 `wrangler check startup` 和真实 upload/deploy 返回值检查启动时间。
- Scalar JS/CSS/font、主题字体和 SPA 资源必须作为 Static Assets，不打入 Worker 动态 bundle。Scalar HTML 与 OpenAPI JSON 仍须经过 Worker 认证。
- 在远端临时环境或生产前验证 OAuth callback、Passkey、Session、API Key、最重 Zod 请求和 OpenAPI 生成的 CPU 使用。
- 特别关注 Workers Free 的单请求 CPU 上限。低流量不能抵消单次请求超限。
- 通过 D1 `meta.rows_read` 和 `meta.rows_written` 评估真实额度消耗，尤其关注 API Key 同步计数的写放大。
- 黑盒验证 `BETTER_AUTH_SECRETS` 轮换对 Session Cookie、OAuth state、加密 OAuth token 和 JWKS 私钥的实际影响，不从文档未承诺的路径推断兼容性。
- 验证 JWT 私钥的静态加密路径，并记录 Better Auth 实际签发的 access-token `typ`。
- 验证未知 `kid` 刷新受到冷却或负缓存限制，并验证轮换期 `kid` 唯一。
- 通过 D1 REST API 确认生产数据库的 `read_replication.mode` 为 `disabled`。
- 用 schema 门禁和真实 export 测试确认数据库不含 virtual table，备份 Workflow 会持续轮询并保留上一份有效备份。
- 导入备份到空 D1，验证审计表仅恢复 schema、migration 状态可继续向前执行，且无表或数据重复。

## 22. Cloudflare 环境和部署

### 22.1 环境

- 常态只维护本地开发与生产环境。
- 本地使用 Wrangler 提供的本地 Worker、Static Assets 和持久化 D1，不需要 Docker。
- 重大身份、迁移或部署变更可以临时创建隔离测试环境，验证后移除。
- 不维护长期 staging。

### 22.2 Worker 和 Assets

- API 与 SPA 一起部署到同一个 Worker 项目。
- Static Assets 配置 `not_found_handling: "single-page-application"`。
- `run_worker_first` 至少包含 `/api/*`、`/.well-known/*`，以及未来确认后的 Scalar HTML 与 OpenAPI JSON 路径。
- OAuth callback 位于 `/api/auth/*`，必须先进入 Worker，不能被 SPA fallback 返回 `index.html`。
- 根 issuer 的 discovery、JWKS 和 protected-resource metadata 必须转交 Better Auth 对应 handler，不能返回 `index.html`。
- 不把 `run_worker_first` 全局设为 `true`，避免普通静态资源消耗动态请求额度。
- 生产对外只使用 `https://auth.eruoo.me`。

### 22.3 Builds 和 Secret

- GitHub 仓库为 `eruoo/server`。
- 使用 Cloudflare Workers Builds 的 GitHub 集成。
- 只有生产分支触发生产 Worker 更新，功能分支不得直接更新生产。
- Workers Builds 从 `pnpm install --frozen-lockfile` 开始，并只调用根 `package.json` 中的稳定脚本。普通分支不得执行远端 migration 或 deploy。
- D1、R2、Workflow、Static Assets 和 Secrets 通过 Wrangler/Cloudflare bindings 配置。
- GitHub OAuth secret、版本化 `BETTER_AUTH_SECRETS`、D1 REST API token、`AUDIT_IP_HASH_SECRET` 等不得提交到 Git。
- schema 演进采用向后兼容的 expand、migrate、deploy、contract 顺序。先增加兼容结构和迁移数据，再发布使用新结构的 Worker，最后在后续发布删除旧结构。
- Cloudflare Builds 不提供数据库与 Worker 的原子发布保证。任何 migration 失败都必须阻止依赖该 schema 的 Worker 发布。

## 23. 免费额度边界（外部事实快照）

本项目以个人低流量下维持零平台固定费用为目标，但不承诺任何数据量下永久免费。

截至 2026-08-19 的部署校验基线：

| 产品 | Free 基线 | 主要风险 |
| --- | --- | --- |
| Workers | 100,000 requests/day、每请求 10 ms CPU | Better Auth、Passkey 和复杂验证可能单次超限 |
| D1 | 5,000,000 rows read/day、100,000 rows written/day、5 GB/account | API Key 每次验证同步计数可能放大写入 |
| R2 Standard | 10 GB-month、每月 1,000,000 Class A 和 10,000,000 Class B | 约 26 份周快照的累计体积可能超过免费存储 |
| Workers Logs | 200,000 events/day、保留 3 天 | 只适合短期诊断 |
| Workflows | 3,000 steps/day、1 GB workflow state | 每周备份预计远低于额度 |
| D1 Time Travel | Free 下当前 7 天 | 只能原地恢复，不符合标准隔离恢复原则 |

这些数字会变化，不得写入业务逻辑。每次正式上线和依赖平台能力的重要升级前，应以 Cloudflare 官方文档重新核对。

免费结论成立的条件：

- 个人低流量。
- Static Assets 直接提供 SPA、Scalar 浏览器资源和字体；受保护的 Scalar HTML 与 spec 仍经过 Worker。
- 不启用付费可观测性、短信、邮件、外部 Redis 或托管 Scalar。
- R2 备份总体积持续受控。
- 所有关键认证路由实测未超过 Workers Free 单请求 CPU 上限。

域名注册与续费不属于 Workers Free 额度，但 `eruoo.me` 已确定为本服务域名。

## 24. Git 和协作流程

- 继续使用既有公开仓库 `eruoo/server`，不新建仓库。
- 项目采用 MIT License，根目录提交 `LICENSE`，分发源码时保留适用的第三方 license notice。
- 保留 Git 历史，重建只删除旧工作树内容，不删除 `.git`。
- Agent 使用 `eruoos <github@eruoo.me>` 创建提交并推送功能分支。
- LoTwT 负责 review、approve，并以 squash merge 合入生产分支。
- 未经明确要求，不直接向生产分支提交或发布。
- GitHub 仓库启用 secret scanning 和 push protection；任何提交和 push 前都必须检查 staged diff，并执行自动化 secret scan。具体扫描工具在工程初始化时确定。

## 25. 实施原则

- 优先完成模块化单体，不提前拆服务。
- 每项安全能力必须同时包含运行时检查、契约声明和自动化测试。
- 客户端可见的安全声明不能代替服务端授权。
- 配置默认拒绝，公开路由使用短小的显式 allowlist。
- 升级 Better Auth、Cloudflare Runtime、Hono 或 Drizzle 时，视为身份和数据兼容性变更，必须先在真实 workerd 与 D1 上验证。
- Bun 或 Node.js 的本地成功不等于 Workers 兼容性成立。
- 业务数据和协议数据的结构变更通过 migration 审查。
- 生产运行时 secret 只进入 Cloudflare Secret，构建期 secret 只进入 GitHub 或 Workers Builds 的受保护 secret 配置；两者不得复用高权限凭证。
- 除明确的示例模板外，`.env`、`.env.*`、`.dev.vars`、含认证信息的 `.npmrc`、Cloudflare API token、GitHub OAuth client secret、Better Auth secrets、审计 HMAC secret、Cookie、API Key、access token、refresh token、D1/R2 导出、数据库副本和生产日志不得提交到 Git。需要提交的示例文件只保留变量名和明显虚假的值。
- `.gitignore` 必须覆盖本地 secret、Wrangler 状态、本地 D1、数据库导出、Playwright trace、测试结果和其他可能携带凭证的临时产物。确需上传诊断产物时，先进行人工脱敏并使用受控的短期渠道。
- OpenAPI artifact、snapshot、fixture、日志样例和错误样例只使用合成数据，不包含 owner 的真实标识、凭证或请求内容。架构文档只允许出现经过确认、刻意公开且确有设计价值的非敏感标识，例如 owner GitHub numeric ID；不得出现认证凭证或私密个人资料。
- 前端只允许读取明确公开的构建变量。任何会进入浏览器 bundle 的变量都不得包含 secret，也不得把“名称不含 SECRET”当作安全依据。
- 一旦发现 secret 进入 Git 历史，不以删除文件作为修复完成；必须立即撤销或轮换凭证，并按 GitHub 的敏感数据移除流程处理历史。

## 26. 推荐但尚未确认的首个实施切片

当前建议的第一阶段是建立一条最小但完整的纵向链路：

1. Node 24、pnpm 11、TypeScript 6、Oxlint、Oxfmt、Vite、Wrangler、Vitest 的项目基线。
2. Hono Worker 与本地 D1 migrations。
3. Better Auth 原生 D1、owner GitHub OAuth 和 30 天 Session。
4. Vue SPA 登录页与已登录壳。
5. Session-only 的 `GET /api/status`。
6. OpenAPI artifact、Problem Details 和最小测试矩阵。
7. Workers Builds 的非生产验证，再接入正式域名。

这只是推荐的实施顺序，用户尚未明确确认该阶段边界。Passkey、API Key、OAuth/OIDC Provider、Scalar、审计和 R2 备份应在哪个阶段加入，仍需在编码前逐项确认。

## 27. 待确认事项

以下问题尚未拍板，实施者不得自行假定：

1. Scalar HTML 和 OpenAPI JSON 的最终路由路径。
2. Problem Details `type` 的正式命名空间和完整错误类型表。
3. API Key 到期提醒的响应 header 名称。
4. OAuth protected resource identifier 的精确 URI，以及由此确定的 `aud` 和 protected-resource metadata URL。
5. Web、Desktop、Mobile 的最终 `client_id` 和精确 redirect URI。
6. 本地 GitHub OAuth App 的 callback Origin 和开发端口。
7. Tauri Web 与未来其他 Web 应用的精确 CORS Origin allowlist。
8. API Key 的首批实际 permission 清单。
9. OpenAPI 前端类型生成器和请求客户端是否采用 `openapi-typescript` 与 `openapi-fetch`。
10. Neo Light/Neo Dark 的默认值、是否跟随系统、手动覆盖优先级和持久化方式。
11. API 时间字段最终返回 epoch millisecond 还是 ISO 8601，以及 SPA 默认显示 UTC 还是 Asia/Shanghai。
12. 除已确认的 `/security/audit-log` 外，“已授权应用”等其他管理界面的最终前端 route。
13. 生产分支名称、Workers Builds 的准确命令，以及 expand、migrate、deploy、contract 各步骤如何接入构建门禁。
14. 临时远端测试环境使用临时自定义域名、隔离 Worker URL，还是仅进行本地验证。
15. D1 export 会在导出期间暂时阻塞数据库请求。每周备份可接受的维护窗口尚未确认。
16. R2 SQL 导出的压缩格式、容量告警阈值，以及超过 Free 10 GB-month 后缩短保留期还是转付费。
17. 是否对 `eruoo.dev` 或 `ayingott.me` 配置重定向。
18. 第一个实施切片及后续功能的阶段划分。
19. 活跃 refresh token family 是否允许无限期按 idle window 滑动，还是设置绝对最长寿命。
20. JWT/OIDC 的允许时钟偏差，以及未来 `iat`、`nbf` 的具体容忍窗口。
21. 是否完整采用 RFC 9068 access token profile，包括 `typ`、算法兼容性和对应验证要求。
22. 是否接受每月清理导致审计事件物理保存最多约 211 天，还是提高清理频率以接近严格的 180 天物理保留。

## 28. 主要风险

| 风险 | 影响 | 当前缓解措施 |
| --- | --- | --- |
| Workers Free 单请求 10 ms CPU | 登录、Passkey 或复杂 schema 可能返回 CPU exceeded | 远端逐路由实测，必要时升级 Workers Paid |
| D1 export 阻塞请求 | 每周备份可能短暂影响登录和 API | 安排低峰时段，待确认可接受窗口 |
| API Key 计数写放大 | 接近 D1 日写入额度 | 个人低流量、指标实测、每请求只验证一次 |
| R2 180 天周快照累积 | 可能超过 10 GB-month 免费存储 | 监控对象总量，待确认压缩和阈值策略 |
| Web access token 仅存内存 | 刷新页面后需要重新授权 | 接受首版 UX，避免持久化 token 风险 |
| 1 小时 access token 无状态验证 | 撤销后最多仍可使用 1 小时 | 已接受撤销延迟，敏感管理端点只用 Session |
| 30 秒 refresh retry window | 窗口内旧 token 重放可获得缓存的 successor credentials | 限定等价请求、保持窗口短、超窗撤销 family、记录并发行为测试 |
| Passkey 绑定 RP ID | 更换域名后需要重新注册 | 首次上线即使用 `auth.eruoo.me` |
| OpenAPI security 只做文档 | 漏挂 middleware 会暴露端点 | protected router 加运行时认证和全量 401 审计测试 |
| Better Auth/Workers 兼容性变化 | 升级后认证或加密路径异常 | 固定精确版本，在 workerd 和真实 D1 上验证升级 |
| OAuth resource 或 discovery 配置错误 | Web/Tauri 获得 opaque token、`aud` 不匹配或 discovery 返回 SPA | 确认 resource URI，测试全部 metadata 与 Worker-first 路由 |
| D1 引入 virtual table | REST export 失效，长期备份链路中断 | schema 门禁禁止，变更前先替换备份方案 |

## 29. 参考标准与官方资料

- [OpenAPI Specification 3.1](https://spec.openapis.org/oas/v3.1.2.html)
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
- [RFC 6750: OAuth 2.0 Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750)
- [RFC 8252: OAuth 2.0 for Native Apps](https://www.rfc-editor.org/rfc/rfc8252)
- [RFC 8707: Resource Indicators for OAuth 2.0](https://www.rfc-editor.org/rfc/rfc8707)
- [RFC 9700: OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700)
- [RFC 8725: JSON Web Token Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725)
- [RFC 9068: JWT Profile for OAuth 2.0 Access Tokens](https://www.rfc-editor.org/rfc/rfc9068)
- [Better Auth Documentation](https://better-auth.com/docs)
- [Better Auth 1.7 Upgrade Guide](https://better-auth.com/docs/guides/1-7-upgrade-guide)
- [Better Auth OAuth Provider](https://better-auth.com/docs/plugins/oauth-provider)
- [Better Auth on npm](https://www.npmjs.com/package/better-auth)
- [Hono Documentation](https://hono.dev/docs)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Cloudflare D1 Documentation](https://developers.cloudflare.com/d1/)
- [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Cloudflare D1 Import and Export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [Cloudflare Workflow D1 Backup Example](https://developers.cloudflare.com/workflows/examples/backup-d1/)
- [Cloudflare R2 Pricing](https://developers.cloudflare.com/r2/pricing/)
- [pnpm Settings](https://pnpm.io/settings)
- [pnpm Continuous Integration](https://pnpm.io/continuous-integration)
- [Oxlint Documentation](https://oxc.rs/docs/guide/usage/linter)
- [Oxfmt Documentation](https://oxc.rs/docs/guide/usage/formatter)
- [GitHub Push Protection](https://docs.github.com/en/code-security/secret-scanning/protecting-pushes-with-secret-scanning)
- [GitHub Removing Sensitive Data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
- [Vue Documentation](https://vuejs.org/guide/)
- [Reka UI Accessibility](https://reka-ui.com/docs/overview/accessibility)
