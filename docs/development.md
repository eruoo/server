# 本地开发

本项目使用单个 `package.json` 管理 Worker、Vue SPA、配置脚本和测试。日常本地开发使用 Cloudflare Vite plugin、workerd 与持久化本地 D1，不需要 Docker，也不会连接生产 D1 或 R2。

## 环境准备

- Node.js 24；仓库根目录的 `.node-version` 固定已验证的 patch 版本。
- pnpm 11；具体版本及完整性摘要由 `package.json#packageManager` 固定。

安装依赖时保持 lockfile 不变：

```sh
pnpm install --frozen-lockfile
```

安装过程会按 `pnpm-workspace.yaml` 应用仓库内固定的 `@better-auth/core` Workers 兼容补丁、`@better-auth/api-key` 依赖故障传播补丁与 `@better-auth/oauth-provider` family-scope 安全补丁；不要直接修改 `node_modules`。升级 Better Auth 时必须同时审查这三份补丁、lockfile、依赖补丁测试、`pnpm run dependencies:audit` 和 production bundle 门禁，具体兼容边界以 foundation 第 3.1、4.1 节为准。

## 本地 Secret

复制示例文件并替换所有占位值：

```sh
cp .dev.vars.example .dev.vars
```

`.dev.vars` 只保存在本机并已被 `.gitignore` 排除。不得把真实 GitHub OAuth secret、Better Auth secret、Cloudflare token、Cookie、API Key 或数据库导出写入仓库、测试 fixture、日志或 issue。

当前浏览器测试使用公开且明显为合成值的独立环境变量，不读取 `.dev.vars`。本地开发 Origin 固定为 `http://localhost:5173`，GitHub OAuth callback 固定为 `http://localhost:5173/api/auth/callback/github`。本地使用独立 GitHub OAuth App；创建或修改该 App 以及写入真实 client ID/secret 前必须取得 owner 明确授权。没有真实 App 时，其他本地功能和自动化测试继续使用合成值，不依赖真实 GitHub 登录。

## 本地 D1

应用仓库中的全部 migration：

```sh
pnpm run db:migrate:local
```

Wrangler 把本地状态写入 `.wrangler/`。该目录和数据库文件均被 Git 忽略。migration 脚本只针对本地 binding；不要给日常开发命令增加 `--remote` 或 `--env production`。

Better Auth schema 由与运行时相同的选项生成并与已提交 migration 比对：

```sh
pnpm run auth-schema:check
```

## OpenAPI 与客户端类型

`docs/openapi.json` 是提交到仓库的 OpenAPI artifact；Vue 客户端类型由它生成到被 Git 忽略的 `.generated/openapi.ts`：

```sh
pnpm run openapi:generate
pnpm run api-types:generate
```

修改路由契约后先重新生成 artifact，再运行 `pnpm run openapi:check`。`dev`、`build` 和客户端 typecheck 会自动刷新生成类型，业务代码不得手写一份平行的 API schema。

## 启动

```sh
pnpm run dev
```

Vite 同时启动 Vue client 与 Worker runtime。`/api`、`/api/*`、`/.well-known/*` 和 `/problems/*` 先进入 Worker，其余导航由 SPA fallback 处理。

## 测试和门禁

```sh
pnpm run check
```

`check` 依次覆盖格式、lint、secret scan、生产依赖安全公告、Wrangler binding 类型、TypeScript、Vue SFC、Better Auth schema drift、组件测试、真实 workerd/D1 集成测试、Playwright、OpenAPI drift、生产构建、Wrangler dry-run 和本地 startup profile。执行前需要先安装 Playwright Chromium：`pnpm exec playwright install chromium`。

这些命令不得创建或修改远端 D1、R2、Worker、Workflow 或 Secret。生产资源建立、migration 与 deployment 使用 foundation 第 22.3 节定义的独立命令，并遵守第 27 节的 owner 授权门禁。

`pnpm run release:preflight` 也是只读检查，但会严格要求生产 D1 ID、Cloudflare account ID、正式域名、required-secret manifest 和生成后的 production 配置全部一致。当前远端资源尚未建立，所以该命令预期失败；它用于阻止 Wrangler 自动创建空数据库后误发布未迁移的 Worker。

## 本地备份与恢复验证

本地 Wrangler 配置会注册 `DATABASE_BACKUP_WORKFLOW` binding，但不配置 schedule；每周六 `19:00 UTC` 的 schedule 只存在于生成的 production 配置。日常 `dev` 和 `check` 不会导出 D1、写入远端 R2 或启动生产备份。

恢复规划器只读取已经下载到本地的原始 `.sql` 快照与 R2 HEAD 描述文件；描述文件必须保留未加引号的单次 put `etag`，供本地 MD5 比对。规划器会在启用 defensive mode、关闭 extension loading 且配置 fail-closed authorizer 的 `:memory:` SQLite 中真实执行快照，验证实际 schema、`d1_migrations` 与仓库 migration 清单的 schema 精确一致，并拒绝附着到 migration ledger 的用户定义 index，再在本地事务中执行凭证/旧审计 scrub 并验证结果；最后只输出凭证清理 SQL 和人工后续步骤：

```sh
pnpm run db:restore:plan -- \
  --descriptor ./backups/snapshot.metadata.json \
  --snapshot ./backups/snapshot.sql \
  --target-database eruoo-server-restore-example \
  --target-database-id 22222222-2222-4222-8222-222222222222 \
  --production-database-id 11111111-1111-4111-8111-111111111111
```

快照包含 D1 中的凭证状态与旧审计数据，必须只从私有 R2 通过受控方式取得，禁止提交到 Git。该命令拒绝 `--execute`，并会拒绝 `ATTACH`/`DETACH`、危险 PRAGMA、virtual table、trigger、view、非法 ledger 和超过本地安全执行能力的输入。下载 R2 对象、创建或导入 D1、执行清理、生成新 JWKS、写入恢复审计及切换 binding 都是独立的外部操作，不能由本地规划命令代办。

## 生产发布门禁

`pnpm run deploy:production` 固定按以下顺序执行并在任一步失败时停止：`release:preflight`、production D1 migration、从已生成 production 配置执行严格 Wrangler deploy。它是为受控 Workers Builds production branch 准备的编排入口，不是本地验收命令；Workers Builds 必须使用目标账号范围内、同时具备严格部署所需权限和 D1 Edit 的自定义最小权限 token。只有 owner 对精确 commit 给出当次生产部署授权后才能真实执行。
