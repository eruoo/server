# eruoo-server 重构规格 (Refactoring Spec)

> 状态：草案，供 owner 决策
> 依据：`docs/specs/foundation.md`（产品与技术规格，单一事实来源）、近 30 天代码 review、线上实测数据
> 本文件只记录重构目标、现状基线、约束与决策点；不重复 foundation.md 已定义的协议细节。

## 1. 重构背景与目标

### 1.1 动因（按证据排列）

| 动因                                   | 证据（线上实测 / 代码审查）                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| D1 平台查询挂起，线上 504 直接原因     | Workers Logs: `wallTimeMs=30s+, cpuTimeMs=1-6ms`，请求 99.9% 时间等 D1 I/O；多个端点同时挂起后一起恢复             |
| Better Auth 请求链 CPU 开销高          | 线上 `get-session` cpu=46-57ms，接近 Workers Free 10ms 上限的数倍；JWKS/插件链固定开销约 0.5s TTFB                 |
| Better Auth 依赖深、升级风险大         | 3 个 pnpm patch（core/api-key/oauth-provider）、黑盒行为多、每次升级需真实 workerd/D1 验证                         |
| cookieCache 30s 窗口是「新引入」的权衡 | 读路径撤销延迟 ≤30s 是显式安全模型变更，敏感路径需双重机制（query + Hono 预检）维持实时性                          |
| 发布流程未收敛                         | 线上全部为手动 Wrangler 部署；production push 显示 `Bypassed rule violations`；Workers Builds 首次成功部署从未达成 |
| Session 读路径穿透存储是架构性选择     | 曾每次请求查 D1；现用加密 cookie 化解读路径，但写路径/敏感路径仍受 D1 可用性约束                                   |

### 1.2 重构目标

1. 消除「D1 挂起 → 全站 5-30s 阻塞」的单点故障模式（至少把故障面从「所有请求」缩小到「低频管理操作」）。
2. 降低认证链路的固定 CPU 开销与依赖黑盒；在保留安全契约的前提下减少对 Better Auth 内部行为的依赖。
3. 收敛受控发布流程：production 分支 → CI 门禁 → Workers Builds → strict deploy，消除手动部署与 bypass。
4. 保持全部外部契约不变（OAuth/OIDC 协议面、OpenAPI、域名、owner-only 模型），重构不改变客户端可见行为。

## 2. 现状架构基线

```
浏览器 (Vue SPA, auth.eruoo.me)
  │  HTTPS, 同源
  ▼
Cloudflare Worker (eruoo-server, 单 worker 单体)
  ├─ Hono OpenAPIHono : 请求中间件链 (requestId→secureHeaders→CORS→CSRF→bodyLimit→timeout→路由)
  ├─ Better Auth 1.7 : GitHub OAuth / Passkey / Session / API Key / OAuth2.1+OIDC Provider
  ├─ 业务路由 : /api/status, /api/audit-events, /api/security/backup-status,
  │              /api/oauth/authorizations, /api/problems, /api/docs(受保护 Scalar)
  ├─ D1 (DB)      : user/account/session/verification/passkey/apiKey/oauth*/审计/限流计数
  ├─ R2 (BACKUPS) : 每周 D1 导出快照 (租约串行化, 8/9GB 界限)
  ├─ Workflows    : DatabaseBackupWorkflow (D1 export → 流式写入 R2)
  ├─ Rate Limiting bindings : auth 10/60, api-key status 5/60
  └─ Static Assets: Vue SPA 产物 + Scalar 文档 (run_worker_first: /api, /.well-known, /problems)
部署 : main → GitHub Actions check → production 分支 → Workers Builds → deploy:production (preflight→migration→strict deploy)
```

### 2.1 关键运行时事实（2026-09 实测）

| 项                      | 值                                                                    |
| ----------------------- | --------------------------------------------------------------------- |
| `get-session` 正常 TTFB | 300-700ms（网络基线 ~300ms + Better Auth 链 ~0.3-0.5s）               |
| `get-session` 正常 CPU  | 46-57ms（新版本）                                                     |
| D1 挂起时 wall / cpu    | 30s+ / 1-6ms（等待 I/O）                                              |
| 边缘地区                | 东京 NRT（AS55900）                                                   |
| Cookie 名               | `__Secure-eruoo.session_token` / `__Secure-eruoo.session_data`（JWE） |

## 3. 功能点清单（重构必须保留的能力）

### 3.1 身份与会话

- GitHub OAuth 唯一 owner 准入（numeric ID `50254496` allowlist，provider 校验 + `validateUserInfo` 双门禁）。
- Passkey：首选登录与敏感操作重认证；RP ID `auth.eruoo.me`；userVerification required。
- Session：30 天固定、不滑动、HttpOnly/Secure/SameSite=Lax host-only；`reauthenticatedAt` 15 分钟敏感操作门禁（服务端持久化）。
- Session 读路径 30s JWE cookie 缓存（撤销延迟 ≤30s）；敏感路径强制实时（`disableCookieCache` + OAuth 权威预检）。

### 3.2 凭证

- API Key：180/365 天期限、`x-api-key`、哈希存储、`status:read` 单一 permission、5/60 ingress + 凭证级 60/min、到期头 `API-Key-Expires-At`。
- Bearer/OIDC：RFC 9068 JWT access token（EdDSA 默认 + RS256 兼容）、本地 JWKS 验证、kid/alg/kty 绑定、60s 时钟容差、`typ=at+jwt`。
- Refresh token：30 天 idle 滑动、每次轮换、30s 重试窗口、family tombstone（`authorizationCodeId` 级隔离）、31 天清理。

### 3.3 OAuth 2.1 / OIDC Provider

- 静态客户端：desktop 启用（loopback 127.0.0.1/[::1] 动态端口）；web/mobile 保持禁用。
- 授权码 + PKCE S256；`request` 参数（RFC 8707）绑定；scope↔audience 静态映射；重复参数拒绝。
- Discovery/JWKS/protected-resource metadata；UserInfo；end-session；revocation（RFC 7009 幂等）。

### 3.4 管理与审计

- 审计：17 类事件、180 天保留、IP HMAC 指纹、分页 cursor 签名、审计写不阻塞主请求（waitUntil）。
- 管理 SPA：登录/Passkey/API Key/已授权应用/审计日志/备份状态提醒/主题（brutal/Neo）。
- 备份：每周 Workflow 全量导出（33/50 subrequest 预算）、R2 8/9GB 界限、租约串行、健康状态持久化与 UI 展示。

### 3.5 工程与发布

- CI（GitHub Actions `check`：lint/format/secret-scan/typecheck/全部测试/E2E/OpenAPI drift/migration history）。
- 受控发布：`release:preflight` → D1 migration → `--strict` deploy；`WORKERS_CI_*` 三重校验；`production` 分支门禁。
- OpenAPI 3.1 唯一契约；生成式客户端类型。

## 4. 重构约束（不可变契约）

1. **外部协议面不变**：OAuth/OIDC 端点路径、错误结构、JWT 格式、metadata、PKCE、redirect URI 规则与 foundation.md §10 完全一致。
2. **域名与安全模型不变**：`auth.eruoo.me`、owner 唯一、CORS 默认 `[]`、`workers.dev` 禁用。
3. **数据可迁移**：D1 schema 如需调整，必须提供 expand/migrate/contract 路径，现有生产数据（owner 身份、凭证、审计、授权）不可丢失。
4. **免费额度目标不变**：个人低流量下保持零平台固定费用（§23 快照）；R2 8/9GB 保护逻辑保留。
5. **错误语义不变**：Problem Details、401/403/429/503/504 分类、`request-timeout`/`service-unavailable` 等 registry 保持兼容。

## 5. 主要重构决策点（待 owner 拍板）

| #    | 决策       | 选项 A                                         | 选项 B                                                | 影响                       |
| ---- | ---------- | ---------------------------------------------- | ----------------------------------------------------- | -------------------------- |
| D1   | 存储策略   | 保留 D1：增加保活查询/接受抖动、写路径快速失败 | 换自托管存储（如 Turso/LibSQL、Postgres+Hyperdrive）  | 故障面、成本、运维复杂度   |
| Auth | 认证框架   | 保留 Better Auth（收敛 patch、锁定版本）       | 自建轻量认证层（GitHub OAuth + 自管 session/passkey） | CPU 开销、开发量、升级风险 |
| 缓存 | 读路径     | 保留 JWE cookie 缓存                           | 无状态 JWT session（撤销延迟变全局，敏感路径仍查库）  | 撤销语义、D1 解耦程度      |
| 发布 | 部署通道   | 修好 Workers Builds + ruleset（消除 bypass）   | 放弃 Builds，回到受控脚本 + 手动授权的严格流程        | 流程复杂度、发布频率       |
| SPA  | 前端技术栈 | 保留 Vue 3 + Vite + reka-ui                    | 简化（SSR？无框架？）                                 | 维护成本、首屏             |

## 6. 建议实施顺序（里程碑）

- **M0 现状固化**：补线上验收记录、固定依赖、收敛发布 bypass（先止血，保留回滚能力）。
- **M1 认证链路重构**：目标 `get-session` CPU <10ms；将敏感路径权威化机制收敛为单一实现；消除 3 个 patch 或验证其必要性。
- **M2 存储解耦**：把「读写路径对 D1 的依赖」与「协议处理」解耦（接口抽象 + 可替换实现），实施决策 D1。
- **M3 备份与管理面重构**：备份链路与 D1 export 解耦；审计写入改队列/批处理（如 Workflow 或 Durable Objects）。
- **M4 发布流程收敛**：ruleset 无 bypass、Workers Builds 首次成功部署、per-release 验收清单。
- **M5 前端现代化**：按决策 D5 执行。

## 7. 验收标准（重构完成后必须满足）

- `pnpm run check` 全绿；迁移后的黑盒测试覆盖：登录、Passkey、API Key、OAuth code flow、refresh 轮换/撤销、审计、备份。
- 线上 `get-session` 中位 TTFB < 500ms、CPU < 10ms、无 30s 级 I/O 挂起（或挂起时可快速降级）。
- 发布流程：production push 不再出现 `Bypassed rule violations`；Workers Builds 自动部署成功并可回滚。
- 全部客户端（Tauri Web/Desktop/Mobile 契约）无需改动即通过既有 OpenAPI 契约测试。
