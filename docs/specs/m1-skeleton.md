# M1 工程骨架设计（owner 门禁材料）

> 状态：设计稿，待 owner 确认后实施
> 上游依据：refactoring.md §M1 + §7 执行配置 + redesign-assets.md + platform-facts.md
> 原则：M1-M6 最简部署（L2 教训），发布门禁 M7 才收敛

## 1. 决策点（需 owner 确认）

### D1 旧实现代码处置

M1 开工时在 `refactor/v2` 上**删除旧实现的工作树文件**（2026-09-04 按 `git ls-files` 复核的完整清单）：

- 删除：`src/`、`tests/`、`scripts/`、`.generated/`（untracked）、`migrations/`（旧 ledger）、`dist/`、`output/`（untracked）、`playwright.config.ts`、`index.html`、`vite.config.ts`、`wrangler.jsonc`、`worker-configuration.d.ts`、`tsconfig*.json`（6 个）、`vitest.*.config.ts`（3 个）、`vitest.config.ts`、`public/`（M6 SPA 时按需重建 `_headers`）、`CHANGELOG.md`、`CLAUDE.md`、`THIRD_PARTY_NOTICES.md`（依赖变更后重生成）、`.dev.vars.example`、`.github/CODEOWNERS`（单人项目无意义）
- 替换（删旧建新）：`.github/workflows/check.yml`（D3）、`README.md`（内容重写为 v2）
- 保留：`docs/`（specs + openapi 契约资产）、`patches/`（M2 逐项验证后按需引用）、`pnpm-workspace.yaml`（**澄清：非 workspace 分包**，是 pnpm 安全策略 minimumReleaseAge/trustPolicy/blockExoticSubdeps/strictDepBuilds + 3 个 better-auth patch 的挂载点——redesign-norms 待定项 3 的前提由此澄清：旧工程本就是单包）、`pnpm-lock.yaml`（M1 依赖变更后重锁）、`package.json`（重写）、`LICENSE`、`AGENTS.md`、`.gitattributes`、`.node-version`、`.gitignore`（微调）、`.oxlintrc`/`.oxfmtrc`/`.secretlintrc`（按需沿用）、`probes/m0/`、`spikes/m1/`
- 旧代码在 git 历史（`59bbd32`）永久可查（`git show 59bbd32:src/worker/app.ts` 等），不损失任何内容；这是当初「不删库、开新分支从零重建」共识的落实

> 这是不可逆性最低的方案：若 v2 失败，`main` 分支与生产 Worker 不受任何影响。

### D2 staging Worker 复用

M1 骨架的部署目标 = `eruoo-server-staging`（探针 Worker 直接被骨架替换）：

- M0 阶段 2 数据（每小时 cron）在骨架部署前已积累于 Dashboard Workers Logs，不受影响
- M0 阶段 3（6–24h 长闲置）需要时临时重新部署探针补采（probes/m0 代码保留在仓库）
- 好处：验证环境始终单 Worker，M8 切换时目标明确

### D3 CI 最小集

GitHub Actions 单 workflow（`.github/workflows/check.yml` 重写）：

- 触发：push / PR 到 `refactor/v2`
- 步骤：pnpm install --frozen-lockfile → `format:check` + `lint` + `typecheck` + `test`（vitest 冒烟集）
- **不包含**（后续里程碑按需加回）：release-preflight、openapi:check、auth-schema:check、e2e、bundle:check
- 本地 pre-push hook 不再依赖（「Bypassed rule violations」教训：门禁在 CI，不在本地）

### D4 Migration Ledger

- 新 `migrations/0001_foundation.sql`：内容沿用旧 0001 的最终 schema（表定义逐字或语义等价重组），保证 M8 生产数据兼容
- **生产 ledger 已核（2026-09-04 实测）**：生产 D1 的 `d1_migrations` 仅 1 条 `0001_foundation.sql`（applied 2026-08-29 15:13:14 UTC）——新工程 0001 同名同义时，M8 切换 `wrangler d1 migrations apply` 将跳过重放，生产 schema 无需任何迁移动作；D4 的 diff 验证是「同名即等价」的前提证明
- M1 门禁含 schema 等价性验证：在新验证 D1 应用 0001 后 `wrangler d1 export`（或 PRAGMA table_list + 每表 schema diff）与生产 schema 结构比对
- 验证 D1：`eruoo-server-staging`（已创建，APAC，id `a43a01e6-e011-4cbf-9a9c-50642f79b61d`）；当前仅含探针的 `probe_session` 表、无 `d1_migrations`（2026-09-04 实测）——M1 应用 0001 时自动建 ledger 表；schema diff 时排除 `probe_session`（探针自有表，M1 实施时可一并 DROP 或保留至阶段 3 结束）

## 2. 工程结构（M1 交付形态）

```text
├── src/
│   └── worker/
│       └── index.ts        # Hono 入口，M1 仅 /health 端点（含构建版本信息）
├── tests/
│   └── worker/
│       └── health.test.ts  # @cloudflare/vitest-pool-workers 冒烟
├── migrations/
│   └── 0001_foundation.sql # 与生产 schema 兼容（D4）
├── probes/m0/              # 保留（阶段 3 补采用）
├── docs/                   # 保留
├── wrangler.jsonc          # env.staging → eruoo-server-staging + 验证 D1
├── vite.config.ts          # @cloudflare/vite-plugin + client 插件占位
├── package.json            # scripts: dev / build / check / deploy:staging / db:migrate:staging
└── （工具链沿用：oxfmt / oxlint / secretlint / vitest / wrangler，版本见 redesign-assets）
```

## 3. 关键命令（M1 门禁执行项）

| 命令                                                              | 作用                                                |
| ----------------------------------------------------------------- | --------------------------------------------------- |
| `pnpm run check`                                                  | format:check + lint + typecheck + test（本地同 CI） |
| `pnpm run db:migrate:staging`                                     | 新 0001 应用到验证 D1                               |
| `pnpm run deploy:staging`                                         | `wrangler deploy --env staging`，单命令无门禁       |
| `curl https://eruoo-server-staging.l709937065.workers.dev/health` | 门禁验收                                            |

## 4. M1 完成定义（门禁）

- [ ] 旧实现工作树文件已删除（D1），git 历史保留
- [ ] CI 绿（refactor/v2 push 触发，Actions 全绿）
- [ ] 0001 应用到验证 D1，schema 与生产结构一致（diff 证据）
- [ ] `/health` 在验证域名可访问（返回版本/构建信息）
- [ ] 探针退场记录在 platform-facts.md（阶段 2 数据封存说明）

## 5. 技术预验（2026-09-04，dry-run 证据）

- `wrangler deploy --config wrangler.jsonc --env staging --dry-run`（spike 见 `spikes/m1/`）：env.staging 的 name 覆盖、D1 binding（`env.DB → eruoo-server-staging`）、顶层 compatibility 继承全部正确解析。部署路径无未知风险。
- vite + client assets 部分沿用旧工程已验证的 `@cloudflare/vite-plugin` 模式，M1 实施时按最简形态重建（不迁移旧 sanitize 脚本，M7 按需收敛）。

### D3 附：CI workflow 具体形态（实施时落地）

```yaml
name: Check
on:
  push:
    branches: [refactor/v2]
  pull_request:
    branches: [refactor/v2]
permissions:
  contents: read
concurrency:
  group: check-${{ github.ref }}
  cancel-in-progress: true
jobs:
  check:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/setup@v2
        with:
          runtime: node@24
      - run: pnpm install --frozen-lockfile
      - run: pnpm run check
```

与旧 workflow 的差异：无 production 分支 fetch（M8 才有生产基线校验）、无 Playwright 安装（M6 引入 E2E 时加回）、`check` 仅四项（format/lint/typecheck/test）。旧 workflow 在 M1 实施时整体替换。
