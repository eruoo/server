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

## 本地变量与 Secret

### 为什么使用 `.dev.vars`

本项目明确使用 Wrangler 的 `.dev.vars`，不使用通用的 `.env`。Cloudflare 的[本地 Secret 文档](https://developers.cloudflare.com/workers/configuration/environment-variables/#local-development-with-secrets)同时支持两种文件，但要求二选一；只要 `.dev.vars` 存在，`.env` 中的值就不会进入本地 Worker。`wrangler.jsonc` 还通过 `secrets.required` 声明了允许加载的名称，未列出的额外键会被排除，缺少的键会产生警告。不要同时维护两份配置。

复制示例文件：

```sh
cp .dev.vars.example .dev.vars
```

`.dev.vars` 只保存在本机并已被 `.gitignore` 排除。不得把真实 GitHub OAuth secret、Better Auth secret、Cloudflare token、Cookie、API Key 或数据库导出写入仓库、测试 fixture、日志或 issue。

生成一个 32-byte 的 base64url 随机值时使用：

```sh
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64url'))"
```

命令输出本身就是 Secret，不要粘贴到对话、issue 或日志。为 `BETTER_AUTH_SECRETS` 与 `AUDIT_IP_HASH_SECRET` 分别运行一次，不要复用同一个值。

`.dev.vars` 中各项的来源如下：

| 名称                   | 本地值或获取方式                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`           | 固定为 `http://localhost:5173`。这是本地配置，不是凭证。                                                                                                   |
| `BETTER_AUTH_SECRETS`  | 使用上面的命令生成，写成 `1:<随机值>`。轮换时才使用 `2:<新值>,1:<旧值>`，并始终把最新版本放在最前面。                                                      |
| `GITHUB_CLIENT_ID`     | 从独立的本地 GitHub OAuth App 复制 Client ID。                                                                                                             |
| `GITHUB_CLIENT_SECRET` | 在同一个本地 GitHub OAuth App 中生成 Client secret，只写入 `.dev.vars`。                                                                                   |
| `AUDIT_IP_HASH_SECRET` | 使用上面的命令另行生成，不得与 Better Auth secret 复用。                                                                                                   |
| `D1_EXPORT_API_TOKEN`  | 日常本地开发不会调用远端 D1 export，保留示例中的明显合成值即可。不得把生产 export token 放到本地文件；只有经授权的隔离远端备份验证才使用单独的受限 token。 |

在 GitHub 的 `Settings > Developer settings > OAuth Apps` 中创建本地 App，具体入口见 [GitHub 官方指南](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)。Homepage URL 填 `http://localhost:5173`，Authorization callback URL 精确填写 `http://localhost:5173/api/auth/callback/github`。本地 App 与生产 App 必须分离，不复用 client ID 或 secret。创建或修改 OAuth App、写入真实凭证仍需 owner 明确授权。

`APP_ENV=development`、已确认的公开 `OWNER_GITHUB_ID`、`ALLOWED_CORS_ORIGINS=[]` 等非敏感配置已经提交在 `wrangler.jsonc`。本地 `CF_ACCOUNT_ID` 与 `D1_DATABASE_ID` 刻意留空，D1、R2 和 Workflow 都使用本地模拟资源，不需要生产 ID。

当前浏览器测试使用公开且明显为合成值的独立环境变量，不读取 `.dev.vars`。没有真实 GitHub OAuth App 时，其他本地功能和自动化测试仍可运行，只有真实 GitHub 登录无法完成。

## 生产变量与 Secret

生产配置与本地配置完全分开，不能把 `.dev.vars` 上传到 Cloudflare，也不能创建包含生产 Secret 的 `.dev.vars.production`。远端资源建立获得授权后，按以下来源补齐：

| 配置                                                               | 生产来源与存放位置                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`、`APP_ORIGIN`、`OWNER_GITHUB_ID`、`ALLOWED_CORS_ORIGINS` | 非敏感值已提交在 `wrangler.jsonc#env.production.vars`。`APP_ORIGIN` 固定为 `https://auth.eruoo.me`。                                                                                                                   |
| `CF_ACCOUNT_ID`                                                    | 已从当前生产 Cloudflare account 确认；权威值只维护在 `wrangler.jsonc#env.production.vars`，默认本地环境仍保持为空。                                                                                                    |
| D1 binding `database_id` 与 `D1_DATABASE_ID`                       | 已从 production D1 `eruoo-server` 确认；权威 UUID 只维护在 `wrangler.jsonc#env.production`，发布门禁确保两处一致，默认本地 binding 仍不连接远端。                                                                      |
| R2 bucket                                                          | 创建获准的私有 bucket `eruoo-server-backups` 后保持 `wrangler.jsonc` 中的 binding 名称一致；bucket 名不是 Secret。                                                                                                     |
| `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`                         | 来自独立的生产 GitHub OAuth App，Homepage URL 使用 `https://auth.eruoo.me`，callback 精确使用 `https://auth.eruoo.me/api/auth/callback/github`。                                                                       |
| `BETTER_AUTH_SECRETS`、`AUDIT_IP_HASH_SECRET`                      | 为生产重新生成，不能复用本地值。Better Auth 继续使用版本化格式，审计 Secret 单独生成。                                                                                                                                 |
| `D1_EXPORT_API_TOKEN`                                              | 创建仅限定目标 Cloudflare account、仅供 [D1 export API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/) 使用的独立最小权限 API token。不要复用 Workers Builds 的部署 token。 |

五个生产运行时 Secret 必须写入 Worker `eruoo-server-production` 的 `Settings > Variables & Secrets` 并选择 Secret 类型，或者在明确获准进行远端配置后逐项使用交互式命令：

```sh
pnpm exec wrangler secret put BETTER_AUTH_SECRETS --env production --config wrangler.jsonc
pnpm exec wrangler secret put GITHUB_CLIENT_ID --env production --config wrangler.jsonc
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --env production --config wrangler.jsonc
pnpm exec wrangler secret put AUDIT_IP_HASH_SECRET --env production --config wrangler.jsonc
pnpm exec wrangler secret put D1_EXPORT_API_TOKEN --env production --config wrangler.jsonc
```

这些命令会修改远端 Worker，不属于本地启动步骤。Wrangler 会交互式读取值，不要把 Secret 直接写进命令行参数或 shell 历史。

Workers Builds 的 API token 和 `Settings > Environment variables` 中的 build variables/secrets 只在构建及部署阶段可用，运行时不可见。生产运行时的五个 Secret 仍必须放在 Worker 的 `Settings > Variables & Secrets` 或通过 `wrangler secret put` 写入。production trigger 的自定义部署 token 还要具备严格部署所需权限和 production D1 的 `D1 Edit`，因为发布流程会先应用远端 migration；它不得提供给普通分支 build，并与只供运行时导出的 `D1_EXPORT_API_TOKEN` 分离。详见 [Cloudflare Workers Builds 配置文档](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#build-variables-and-secrets)。

GitHub Actions 只运行仓库完整门禁，不配置生产 Secret 或 Cloudflare token，也不执行远端 migration/deploy。完整 CI 和生产部署分别位于独立信任域；不能为了复用同一 workflow 把 Workers Builds token 复制到 GitHub Secrets。

Workers Builds 必须设置非 Secret build variables `NODE_VERSION=24.18.0`、`PNPM_VERSION=11.22.0` 和 `SKIP_DEPENDENCY_INSTALL=1`。前两项分别与 `.node-version` 和 `package.json#packageManager` 对齐；最后一项避免平台自动安装依赖后，固定 build command `pnpm install --frozen-lockfile` 又执行一次安装。生产构建产物由 deploy 阶段首个 `release:preflight` 生成并验证；完整的外部接线、production 分支和验收顺序见[生产发布](./releasing.md)。

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

已经应用的 migration 应视为不可变。当前实现阶段曾在本地应用 `0001_foundation.sql` 后继续补写该文件；这种旧本地 D1 的 migration ledger 会认为 `0001` 已完成，`pnpm run db:migrate:local` 因而显示没有待应用项，但数据库 schema 仍可能缺表或缺列。若出现登录成功但某个管理接口持续 500、或代码引用的表在本地不存在，先检查是否属于这种 schema drift。

如果本地数据需要保留，必须新增后续 migration，不能覆盖已经应用的 migration。只有确认本地账号、Session、Passkey、API Key 与审计数据都可以丢弃时，才停止开发服务，将仓库内精确路径 `.wrangler/state/v3/d1/` 移入废纸篓，再重新运行 `pnpm run db:migrate:local`。这个操作只重建本地 D1，但会删除其中全部本地数据；不要删除整个 `.wrangler/`，也不要对远端 D1 执行类似操作。

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

用以下请求验收 Worker discovery endpoint：

```sh
curl --noproxy localhost,127.0.0.1 -i \
  http://localhost:5173/.well-known/openid-configuration
```

预期返回 `200`、JSON `Content-Type` 和 OpenID 配置对象。如果浏览器可以访问同一地址，而不带 `--noproxy` 的 curl 返回 `502 Bad Gateway`，通常是 curl 继承了 shell 的代理变量，代理又无法访问本机服务，并不是 Worker endpoint 失败。继续使用上面的显式绕过参数，或在代理工具中把 `localhost`、`127.0.0.1` 和 `::1` 加入本地绕过列表；排障时不要打印或记录代理变量的值。

## 测试和门禁

```sh
pnpm run check
```

`check` 依次覆盖格式、lint、secret scan、生产依赖安全公告、Wrangler binding 类型、TypeScript、Vue SFC、Better Auth schema drift、组件测试、真实 workerd/D1 集成测试、Playwright、OpenAPI drift、生产构建、Wrangler dry-run 和本地 startup profile。本机执行前使用 `pnpm exec playwright install chromium` 安装浏览器；GitHub Actions 的 Ubuntu runner 使用 `pnpm exec playwright install --with-deps chromium` 安装浏览器和系统依赖，然后运行同一个 `pnpm run check`。

`.github/workflows/check.yml` 只监听指向 `main` 的 PR 和 `main` push。PR run 提供合入前反馈，最终 squash commit 必须由 `main` push 再次运行并以稳定 job 名 `check` 成功，才能进入 `production`。该 workflow 固定 Node.js 版本、从 `package.json#packageManager` 读取 pnpm，并使用只读仓库权限；它没有生产凭证、远端 migration 或 deploy，Cloudflare Workers Builds 也不重复 Playwright 和完整 `check`。

这些命令不得创建或修改远端 D1、R2、Worker、Workflow 或 Secret。生产资源建立、migration 与 deployment 使用 foundation 第 22.3 节定义的独立命令，并遵守第 27 节的 owner 授权门禁。

`pnpm run release:preflight` 也是只读检查，会严格要求已提交的 production D1 ID、Cloudflare account ID、正式域名、required-secret manifest 和生成后的 production 配置全部一致。它只验证 Secret 名称清单，不读取远端 Secret 值；任何本地成功都不构成生产部署授权。

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

`pnpm run deploy:production` 只能在最终 `main` commit 的 GitHub Actions `check` 已成功、无 bypass status gate 允许同一 SHA 进入 `production`，且 owner 对该 SHA 给出当次生产部署授权后执行。它会在每个步骤前确认 Workers Builds branch 为 `production`，且平台注入的完整 commit SHA、checkout 的 `HEAD` 与 GitHub 上受保护的远端 `production` ref 三者一致，同时要求源码工作区干净，然后固定按以下顺序执行并在任一步失败时停止：`release:preflight`、production D1 migration、从已生成 production 配置执行严格 Wrangler deploy。Worker deploy 返回后还会再次校验同一上下文，末次校验失败时整个 build 失败且不得打 tag。`WORKERS_CI_*` 只提供执行上下文，不能替代远端分支保护和隔离的部署 token；上一个 production build 结束前不得再次推进分支。该命令不是本地验收命令；Workers Builds 必须使用目标账号范围内、同时具备严格部署所需权限和 D1 Edit 的自定义最小权限 token。具体流程见[生产发布](./releasing.md)。
