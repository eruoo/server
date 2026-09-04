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

### 版本情报（2026-09-04 复核，M2 决策依据）

- **上游 v1.7.2（2026-08-26）`@better-auth/core` 已修复 "async context loss in Cloudflare Workers bundles with multiple runtime conditions"（[#10855](https://github.com/better-auth/better-auth/pull/10855)）**——与旧 core patch 针对的 ALS 问题同源。M2 首选 1.7.2 无 patch 验证 workerd 行为，通过则 core patch 退役。
- v1.7.2 其他相关修复：cookieCache 无效签名数据增加警告（关联 v2 的 JWE cookieCache 设计）；Cloudflare D1 程序化迁移修复（关联 M1/M2 schema 生成）；oauth-provider 的 MCP scope 403 语义。
- `@better-auth/api-key` 与 `@better-auth/oauth-provider` 的旧 patch 问题在 1.7.2 changelog 中未见对应修复——**这两个 patch 预计仍需保留，M4/M5 时逐项实测**。

## 7. 基础设施现状（2026-09-04 实测）

| 资源                             | 现状                        | 说明                                                                                                             |
| -------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 生产 D1 `eruoo-server`           | APAC，20 表，ledger 仅 0001 | 数据量极小（全库 export 18KB）                                                                                   |
| R2 `eruoo-server-backups`        | APAC，**object_count = 0**  | **生产备份从未成功执行过**（与 L2「发布流程从未工作」同款问题）——M7 备份设计必须把「真实产出过备份」作为验收条件 |
| Workflow `eruoo-database-backup` | 已绑定（BACKUPS + D1）      | 从未写入任何对象                                                                                                 |

**应急措施（2026-09-04 14:55 UTC）**：已手动 `wrangler d1 export` 生产 D1 至本地 `output/backups/prod-emergency-2026-09-04.sql`（gitignored，含 20 表 schema + 19 行数据，完整性已核）。M7 之前此文件是生产数据的唯一备份——owner 可自行复制到第二位置保管。
