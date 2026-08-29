# 生产发布

本文档是 `eruoo-server` 的生产发布操作指南。安全边界和授权规则仍以[产品与技术规格第 22.3、24、27 节](./specs/foundation.md#223-builds-和-secret)为准；本文只规定实际操作顺序，不扩大任何外部操作授权。

## 发布角色和边界

- `eruoos` 只在功能分支创建 commit 和 PR。
- `LoTwT` review、approve、squash merge 到 `main`，并且是唯一允许更新 `production` 的 release actor。
- `production` 只能 fast-forward 到已经审查的 `main` commit；禁止 merge commit、force push 和删除分支。
- 普通 `main` merge、通过本地门禁、PR check 或 GitHub CI 成功都不构成生产部署授权。
- 更新 `production`、连接 Workers Builds、部署 Worker、创建 Custom Domain、写入真实 Secret、创建 tag 或 GitHub Release 前，都需要 owner 对当次精确对象明确授权。

## 稳定生产标识

以下值是部署标识，不是 Secret，并由 `wrangler.jsonc#env.production` 维护：

| 项目                  | 值或权威来源                                                       |
| --------------------- | ------------------------------------------------------------------ |
| Cloudflare account ID | `wrangler.jsonc#env.production.vars.CF_ACCOUNT_ID`                 |
| D1 database           | `eruoo-server`                                                     |
| D1 database ID        | `wrangler.jsonc#env.production.d1_databases` 中 binding `DB` 的 ID |
| R2 bucket             | `eruoo-server-backups`                                             |
| Worker                | `eruoo-server-production`                                          |
| Custom Domain         | `auth.eruoo.me`                                                    |

生产 Secret 的来源、格式和写入命令由[本地开发的生产变量与 Secret](./development.md#生产变量与-secret)维护。Secret 值不得进入仓库、PR、issue、聊天、命令参数或构建日志。

## GitHub CI 与 production status gate

`.github/workflows/check.yml` 使用稳定 job 名 `check`，只监听指向 `main` 的 pull request 和 `main` push。它以只读仓库权限固定 Node.js 24.18.0，并从 `package.json#packageManager` 读取带完整性声明的 pnpm 版本，依次执行 frozen install、`pnpm exec playwright install --with-deps chromium` 和完整 `pnpm run check`；不得使用 `pull_request_target`、读取生产 Secret 或 Cloudflare token、执行远端 migration/deploy、监听 `production` 或使用 path filter 跳过 required check。

PR run 只提供合入前反馈。squash merge 会产生新的 commit，所以发布候选必须等待 `main` push 对最终完整 SHA 产生 conclusion 为 `success` 的 `check`。`production` 的 required status check 固定为 `check`，期望来源限定为 GitHub Actions，并位于没有 bypass actor 的 ruleset；LoTwT 的 release actor 权限不得绕过这一门禁。GitHub 的 required status 名称使用 job name，不能改用 workflow 文件名或近似名称。

只有上述 workflow 首次成功运行后，GitHub 才能在 ruleset 中选择其真实 status source。配置或修改该 ruleset 是外部操作，必须取得 owner 当次授权；配置完成后通过 GitHub 页面或 API 只读复核 Active 状态、目标 `production`、精确 status 名、expected source 和空 bypass 列表。

## Workers Builds 配置

按照 [Cloudflare 的现有 Worker 接线流程](https://developers.cloudflare.com/workers/ci-cd/builds/#connect-an-existing-worker)，从 Worker `eruoo-server-production` 的 `Settings > Builds > Connect` 连接 `eruoo/server`，不要通过“创建应用程序”导入成另一个 Worker。如果 Cloudflare 提议修改 `wrangler.jsonc` 或重命名 Worker，停止接线并先审查差异。

| 设置                          | 值                               |
| ----------------------------- | -------------------------------- |
| Production branch             | `production`                     |
| Root directory                | `/`                              |
| Build command                 | `pnpm install --frozen-lockfile` |
| Production deploy command     | `pnpm run deploy:production`     |
| Non-production deploy command | `pnpm run bundle:check`          |

设置以下非 Secret build variables：

```text
NODE_VERSION=24.18.0
PNPM_VERSION=11.22.0
SKIP_DEPENDENCY_INSTALL=1
```

`NODE_VERSION` 与 `.node-version` 对齐，`PNPM_VERSION` 与 `package.json#packageManager` 对齐。`SKIP_DEPENDENCY_INSTALL=1` 禁用平台自动 dependency install，依赖只由 build command 的 frozen install 安装一次。Workers Builds 不安装 Playwright 系统依赖，也不重复完整 CI；production artifact、binding 和启动门禁仍由 `deploy:production` 的首个 `release:preflight` 执行，成功后才允许 migration。

production trigger 使用独立的 user API token：Account Settings Read、Workers Scripts Edit、Workers R2 Storage Edit、D1 Edit，以及只限定 `eruoo.me` 的 Workers Routes Edit；保留 Wrangler 认证需要的 User Details Read 和 Memberships Read。不要加入未使用的 KV 权限，不得复用运行时 `D1_EXPORT_API_TOKEN`。当前锁定的 Wrangler 4.124.0 会在包含 Custom Domain 的部署前读取目标 zone 的现有 Workers Routes 以检查冲突，因此该 zone 权限仍然必要，但不得扩大到其他 zone。Cloudflare 权限名称或 Wrangler 行为可能变化，首次接线和重要平台升级前必须以 [Workers Routes API](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/list/) 和当前版本实现复核。

当前首次接线存在一项 owner 已明确接受的临时例外：production trigger 选中的 `eruoo-server-production-build` 是由 Cloudflare “Create new token” 自动创建的 token，暂时保留平台自动加入的额外权限；未被 trigger 选中的 `eruoo-server-production-deploy` 暂留，等待后续单独决定。该状态不代表最小权限已经完成。在首次成功部署和验收前，non-production branch builds 必须保持关闭，build token 只能用于这个 production trigger，不得复制到 GitHub 或其他项目；首次部署完成后必须重新取得 owner 授权，收敛 build token 权限并决定旧 token 的保留或删除，不能自动删除任何 token。

GitHub Actions 不需要也不得取得该 token。生产部署凭证继续只保存在 Workers Builds trigger 中，不能以 GitHub CI 已通过为由复制到 GitHub Secrets。

默认关闭 non-production branch builds。普通分支中的仓库脚本不能接触上面的生产级 token；只有另建不含 production D1、Worker、Secret、route 或其他生产写权限的 preview trigger/token 后，才能启用非生产构建，并把 non-production deploy command 固定为 `pnpm run bundle:check`。如果 Cloudflare 无法为 preview trigger 隔离 token，就继续关闭该功能。

不要在自定义 Build variables 中定义或覆盖 `WORKERS_CI`、`WORKERS_CI_BRANCH`、`WORKERS_CI_COMMIT_SHA`。这些变量只提供执行上下文，不是平台身份证明；实际授权边界是受保护的远端 `production` 分支与只交给 production trigger 的部署 token。`deploy:production` 会在执行任何命令前确认平台注入的 branch 为 `production`，并校验注入的完整 commit SHA、checkout 的 `HEAD` 和 GitHub 上 `eruoo/server` 的 `refs/heads/production` 三者一致，同时要求源码工作区干净；不匹配时停止，不执行 migration 或 deploy。

完成现有 Worker 的 Connect 流程并保存 Build settings；按照 [Cloudflare 的配置语义](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)，保存后的设置从下一次 build 起生效，本身不应部署 Worker。保存后确认 Build history 没有新增 build，Active Deployment 没有变化。在此流程中如果页面出现 “Save and Deploy”、“Deploy now” 或其他会立即触发 build/deploy 的操作，停止且不要点击，先记录页面状态并重新核对当前平台流程。

一次只允许一个 production build 进入部署流程。上一个 build 完成或明确失败前，不得再次推进 `production`。deploy 入口会在 preflight、migration 和 Worker deploy 每一步前重新读取并校验远端 `production` ref，并在 Worker deploy 返回后再校验一次；分支在流程中变化时，下一步或最终构建结果会停止。最终校验失败时不得打 tag，必须按本文故障流程核对 Active Deployment。

## 准备发布候选

1. 从最新 `main` 创建功能分支。
2. 更新 `package.json#version` 与 `src/worker/openapi.ts` 中的 OpenAPI document version，运行 `pnpm run openapi:generate`，并把 `CHANGELOG.md` 的变更归入同一稳定 `MAJOR.MINOR.PATCH` SemVer。应用为私有包，不发布到 npm，但 package version、OpenAPI artifact、changelog、tag 和 GitHub Release 必须一致。
3. 所有 schema 变更只允许向后兼容的 expand/migrate；contract migration 必须在后续独立 PR 中执行。
4. 运行：

   ```sh
   pnpm run release:preflight
   pnpm run check
   ```

5. 检查 staged diff 和 Secret 扫描结果，创建 PR，由 `LoTwT` approve 并 squash merge 到 `main`。PR run 通过不能替代下一步。
6. 记录合并后的完整 `main` SHA。squash merge 会创建新 SHA，不能继续使用功能分支 commit；等待该 SHA 的 GitHub Actions `check` conclusion 精确为 `success`，缺失、排队、进行中、跳过、取消或失败都不得推进 `production`。

`release:preflight` 只验证 source/generated production 配置和 required-secret 名称清单，不读取远端 Secret，也不证明 Worker、OAuth App、DNS、GitHub status gate 或 Builds trigger 已正确接线。GitHub Actions 的完整 `check` 证明仓库门禁在该 commit 上成功，但不构成 owner 的生产部署授权。

## 首次生产接线门禁

首次部署前逐项确认：

- production GitHub OAuth App 使用 Homepage `https://auth.eruoo.me` 和精确 callback `https://auth.eruoo.me/api/auth/callback/github`。
- Worker `eruoo-server-production` 已存在，且五个 required runtime Secrets 已写入。
- `.github/workflows/check.yml` 已在最终 `main` commit 上产生成功的 `check`，`production` 的 required status ruleset 为 Active、expected source 是 GitHub Actions 且没有 bypass actor。
- 现有 Worker 已完成 Workers Builds 接线并保存配置；production branch、命令和 variables 均与本文一致，保存时没有触发 build 或改变 Active Deployment。
- Workers Builds 的 production token 与运行时 D1 export token 分离；当前 broad-token 临时例外已按上文记录，non-production branch builds 必须保持关闭，且未选中的旧 token 不得被误用。
- `eruoo.me` zone 为 Active，`auth.eruoo.me` 没有冲突的 A、AAAA 或 CNAME；不要预先手工创建 Custom Domain DNS 记录。
- R2 bucket 保持私有，未启用 `r2.dev`、公开 Custom Domain 或浏览器 CORS；180 天 lifecycle 已启用。
- 当前 `production` 尚未被未授权推进，准备发布的完整 `main` SHA 已取得 owner 当次授权。

## 触发生产部署

Workers Builds 必须已经按上文连接到现有 Worker 并保存配置。再次确认 Build history 和 Active Deployment 没有因接线而变化，确认最终 `main` SHA 的 GitHub Actions `check` 为 `success` 且 production ruleset 会强制该结果，然后取得 owner 对同一精确 commit 的当次部署授权。不要先推进 `production` 再完成 CI/status gate 接线，也不要通过 Dashboard 手动触发其他 branch/SHA 的 build 或直接 deploy；下面这一次获准的 `production` fast-forward push 是该候选 SHA 初始 production build 的唯一触发器。只有本文故障流程明确允许、精确 SHA 和代码均未变化并重新取得 owner 授权时，才可重试同一个失败 build。

只有 `LoTwT` 执行：

```sh
git fetch --prune origin
git switch production
git merge --ff-only origin/production
git merge-base --is-ancestor <AUTHORIZED_MAIN_SHA> origin/main
git merge --ff-only <AUTHORIZED_MAIN_SHA>
test "$(git rev-parse HEAD)" = "<AUTHORIZED_MAIN_SHA>"
git push origin HEAD:production
git switch main
```

执行前把 `<AUTHORIZED_MAIN_SHA>` 替换为 GitHub Actions `check` 已成功且 owner 已授权的完整 `main` SHA。不要直接合并当时的 `origin/main`，因为它可能在授权后继续前进并包含尚未获准部署的 commit。ruleset 是服务端强制边界，人工复核 status 是发布操作门禁；两者都必须存在。

push 成功后应自动出现且只出现一个 production build。若没有触发、触发了多个 build，或 build 对应的 branch/SHA 与授权值不一致，停止后续操作并按故障流程检查；不得选择其他 branch/SHA 或点击直接部署按钮补偿，同一失败 build 的受控重试只能遵守下文例外。

`pnpm run deploy:production` 固定执行：

```text
release:preflight
→ production D1 migration
→ 从生成配置 strict deploy Worker
```

任一步失败都会阻止后续步骤。Cloudflare Custom Domain 配置随成功 deploy 创建 `auth.eruoo.me` 的 DNS 和证书；不得另行创建一套平行 DNS。

## 上线验收

GitHub Actions 中最终 `main` SHA 对应的 `check` 必须为 `success`，日志显示 frozen install、`playwright install --with-deps chromium` 和完整 `pnpm run check` 均成功，且没有读取生产 Secret、Cloudflare token 或执行 deploy。Cloudflare build 详情中的 branch 必须是 `production`，commit SHA 必须等于同一获准 SHA，deploy 入口必须通过远端 `production` ref 校验；Cloudflare 日志显示 frozen install、release preflight、D1 migration 和 strict Worker deploy 均成功。两边日志都不得包含 Secret。

随后确认：

- `https://auth.eruoo.me/.well-known/openid-configuration` 返回 `200` JSON，SPA HTTPS 证书有效。
- 未登录访问 `/api/status` 返回 `401`；owner Session 或带 `status:read` 的有效 `x-api-key` 返回 `200` 和 `{"status":"ok"}`。
- owner GitHub OAuth 登录、Passkey 注册/登录、API Key 创建/复制/撤销正常；非 owner GitHub 账号被明确拒绝。
- 已授权应用、审计记录和备份状态管理页可用。
- production D1 migration ledger 包含当前全部 migration。
- Worker bindings 包含 `DB`、`BACKUPS`、`DATABASE_BACKUP_WORKFLOW` 和 `CF_VERSION_METADATA`；`workers.dev` 与 Preview URL 保持关闭。
- 每日清理 cron 为 `0 20 * * *`，每周备份 Workflow schedule 为 `0 19 * * 6`。

D1 export 可能让数据库短暂不可用。首次人工备份或 export-token 权限验证必须另行取得授权，并在无业务流量的受控窗口执行；普通上线验收不主动触发备份。

## Tag 和 GitHub Release

只有生产部署及上述验收全部成功后，才在实际部署的完整 commit 上创建 annotated tag `v<package.json version>`。tag 必须指向 production 当前 commit，不能指向功能分支或部署后的补充提交。推送 tag 并创建同名 GitHub Release，release notes 使用 `CHANGELOG.md` 对应版本内容。

tag、GitHub Release 和 package version 不一致时停止发布；不得通过移动或强制覆盖已公开 tag 修复。需要更正时使用新的 patch 版本。

## 失败处理

- GitHub Actions `check` 缺失、跳过、取消或失败：required status gate 必须阻止 `production` 更新；修复 `main` 后重新走 PR，不能通过 Dashboard 手动部署补偿。
- Workers Builds frozen install 或 release preflight 失败：没有执行 migration 或 deploy。若根因在仓库，修复 `main` 后重新走 PR；若根因是 Cloudflare Build setting，取得 owner 授权后修改并只读回查，无须制造无意义的代码 PR。仅外部瞬时故障或已获准的 Build setting 修正、代码与精确 SHA 均未变化时，才可在重新核对 SHA、ruleset、Active Deployment 并取得 owner 对本次重试的明确授权后重试同一失败 build。
- Migration 失败：deploy 自动停止；检查远端 migration ledger，不修改已应用 migration，不删除或重建 production D1。
- Migration 成功但 Worker deploy 失败：D1 可能已升级而 Worker 仍是旧版本；保持向后兼容，修复配置后重试同一已审查 commit，代码变化则走新 PR。
- Worker deploy 成功但最终远端 ref 校验失败：不得打 tag；核对 Active Deployment 与当前 `production` 的完整 SHA。等待当前 `production` 的获准 build 成功，或对该精确 commit 重新取得部署授权后再恢复一致，不能用强推或移动公开 tag 掩盖漂移。
- Custom Domain 或证书 pending：检查 DNS 冲突并等待签发，不反复部署或手工创建平行记录。
- OAuth 登录失败：核对精确 callback、五个 Secret 名称和值及 owner numeric ID，不开放注册或放宽 allowlist。
- 需要停止后续自动部署时暂停 Builds trigger；不要删除 D1、R2、Worker、Workflow 或重写 Git 历史。
