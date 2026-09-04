# v2 重设计资产清单（从旧项目提取，M1+ 的输入）

> 来源：旧实现（main@59bbd32）。仅作为新工程的输入与对照，不直接复用代码。

## 1. 依赖版本清单（锁定基线）

| 依赖                                                                                    | 版本                    | 用途                                      |
| --------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------- |
| better-auth / @better-auth/api-key / @better-auth/oauth-provider / @better-auth/passkey | 1.7.0                   | 认证 / API Key / OAuth Provider / Passkey |
| hono                                                                                    | 4.13.3                  | HTTP 框架                                 |
| @hono/zod-openapi                                                                       | 1.6.0                   | OpenAPI 集成                              |
| drizzle-orm                                                                             | 0.45.2                  | D1 查询                                   |
| jose                                                                                    | 6.2.9                   | JWT/JWKS                                  |
| zod                                                                                     | 4.4.3                   | 校验                                      |
| vue / vue-router                                                                        | 3.5.41 / 5.2.0          | SPA                                       |
| reka-ui / @lucide/vue / @ayingott/theme                                                 | 2.10.3 / 1.31.0 / 0.2.0 | UI 组件 / 图标 / 主题                     |
| @scalar/api-reference / @scalar/hono-api-reference                                      | 1.65.1 / 0.11.14        | API 文档                                  |
| openapi-fetch / openapi-typescript                                                      | 0.17.0 / 7.13.0         | 契约客户端 / 类型生成                     |

工具链：pnpm 11.22.0、Node 24、oxfmt 0.64、oxlint 1.79、secretlint 13、vitest 4.1、@cloudflare/vitest-pool-workers 0.22、@playwright/test 1.62、wrangler 4.124、@cloudflare/vite-plugin 1.53。

## 2. Better Auth 补丁（M2 时逐一验证必要性）

| patch                             | 修复内容                                                                                          | 验证要点                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| @better-auth/core@1.7.0           | workerd 下 AsyncLocalStorage 解析（ALS 优先取 globalThis）                                        | 无此补丁时 workerd 警告与行为                      |
| @better-auth/api-key@1.7.0        | API key 验证失败改为抛错（依赖故障不误报 invalid key）                                            | D1 故障时 /api/status 语义                         |
| @better-auth/oauth-provider@1.7.0 | refresh family 按 authorizationCodeId 隔离 + revocation hint 回退搜索 + continuation 限定内部路径 | tombstone 误删/revocation 幂等/continuation 注入面 |

## 3. D1 Schema（生产兼容基线）

- migrations/0001_foundation.sql：全量 schema（Better Auth 官方表 + 应用表 + OAuth 表 + 审计）。
- 新工程 migration ledger 从 0001 重新编号，但最终 schema 必须能承接生产数据（M8 迁移方案时对齐）。

## 4. OpenAPI 契约

- docs/openapi.json：作为新实现协议兼容性的对照（Tauri Desktop 依赖的端点为硬约束）。

## 5. 测试基准映射（新实现的验收标准来源）

| 旧测试域                       | 文件数 | 新工程对应里程碑 | 用法                                               |
| ------------------------------ | ------ | ---------------- | -------------------------------------------------- |
| worker 集成（真实 workerd+D1） | 36     | M2-M5            | 协议行为基准：登录/Passkey/API Key/OAuth flow/备份 |
| client 单元                    | 20     | M6               | 交互逻辑基准（组件结构重设计后按行为等价重写）     |
| E2E（Playwright）              | 3      | M6               | 全流程验收基准                                     |
| scripts/config 契约            | 12     | M7               | 发布与配置门禁基准（按新流程裁剪）                 |

## 6. 生产运行时事实（线上实测，M0 将复核）

| 项                          | 值                                                  |
| --------------------------- | --------------------------------------------------- |
| get-session CPU（缓存命中） | ~1-6ms；未命中（Better Auth 全链）46-57ms           |
| D1 挂起形态                 | wall 30s+ / cpu 1-6ms（I/O 等待，多端点同挂同恢复） |
| 网络 TTFB 基线（东京边缘）  | ~300ms                                              |
| Free CPU 限制名义值         | 10ms（文档快照；M0 实测校准）                       |
