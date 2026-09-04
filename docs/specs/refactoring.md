# eruoo-server 重设计规格 (Redesign Spec v2)

> 状态：spec 定稿候选，等待 owner 确认后进入 M0
> 前置决策（owner 已确认）：技术栈与现状完全一致（Workers + Hono + Better Auth 1.7 + D1 + R2 + Workflows + Vue 3）；代码从零搭建；分步门禁；规范随里程碑演进。
> 配套文档：`docs/specs/redesign-norms.md`（旧规范 29 节分级清单，每里程碑开工前逐项确认）。

## 0. 历史教训（本 spec 的设计依据）

上一轮实现（2026-08-20 至 09-03，12 个 PR）暴露三个系统性失误，本 spec 的所有设计原则都源于对它们的反转：

| #   | 历史失误                                                                                                                                                                 | 证据                                                                                              | 本 spec 的反转                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| L1  | 规格先行，平台事实后置：1190 行规格在编码前完成，但 Workers Free 不支持 Workflow direct schedule、D1 会 30s 级挂起、Better Auth get-session CPU 46-57ms 均为部署后才发现 | #8 重写备份调度；线上 504 根因 D1 挂起（wall=30s+, cpu=1-6ms）；#9-#12 四轮修 Session             | **M0 先实测平台约束**，一切设计以实测数据为准                            |
| L2  | 发布流程过度设计且从未工作：4 个 PR 修发布基建，最终无一次成功的自动部署，线上全为手动 wrangler + ruleset bypass                                                         | #3/#5/#6/#7；production push 显示 `Bypassed rule violations`；Workers Builds 首次成功部署从未达成 | **发布流程降级为最后一步（M7）**；M1-M6 用最简部署路径，每步记录部署产物 |
| L3  | 认证链路风险后置：Session/D1 耦合问题在首次真实使用时爆发                                                                                                                | #9 导航阻塞 → #10 超时门禁 → #11 成本放大 → #12 cookieCache，四轮递进                             | **认证核心（M2）第一个建**，立即在真实环境验证 CPU/延迟预算              |

## 1. 设计原则

1. **平台实测优先**：任何依赖 Cloudflare 平台行为的设计（D1 延迟、CPU 限制、subrequest 预算、Workflow 约束），先在 M0 用最小探针实测，不引用文档快照作为唯一依据。
2. **每步真实部署**：每个里程碑结束时部署到独立的验证 Worker（非生产），在真实 workerd/边缘环境验证；不依赖"本地测试通过 = 线上可用"。
3. **规范随实现演进**：不预写完整规格；每里程碑开工时从分级清单确认当步规范条目，实现并验证后写入新规范文档作为定稿。
4. **最简可行发布**：M1-M6 用单命令部署 + 手动记录；M7 才引入正式发布门禁，且复杂度与"单人项目"匹配。
5. **性能预算前置**：认证核心完成后立即实测 CPU/延迟，不满足预算不进入下一步。

## 2. 已定决策（owner 确认）

| 决策     | 结论                                                                                      |
| -------- | ----------------------------------------------------------------------------------------- |
| 技术栈   | 完全保留：Workers + Hono + Better Auth 1.7 + D1 + R2 + Workflows + Vue 3 + Vite + Drizzle |
| 存储     | 保留 D1（换存储迁移成本 > 收益；写路径快速失败）                                          |
| 认证     | 保留 Better Auth（重做时逐一验证 3 个 pnpm patch 的必要性）                               |
| 读路径   | cookieCache(JWE) + 窗口参数可配置（默认 30s，实测后调整）                                 |
| 仓库结构 | 单仓库单 Worker 同源部署（不拆仓库、不拆域名、不拆部署）；内部按 packages 分层            |
| 前端     | Vue 3 + Vite + reka-ui，组件结构重新设计                                                  |
| 规范演进 | 旧 foundation.md 逐节按分级清单（硬约束/可探讨/自由）确认，不做整体继承                   |

## 3. 硬约束清单（改动需单独论证）

以下条目因外部依赖（已分发客户端/生产数据/安全模型）默认不可变：

- 域名 `auth.eruoo.me`、Passkey RP ID、`workers.dev` 禁用。
- owner GitHub numeric ID `50254496`、唯一 owner、无开放注册。
- Tauri Desktop 已启用的 OAuth 2.1/OIDC 协议面（端点、PKCE、redirect URI、RFC 9068 token、refresh 轮换/tombstone）。
- 生产 CORS 保持 `[]`（同源安全模型）。
- D1/R2 生产数据不可丢失（owner 身份、凭证、审计、授权）。
- 外部操作需 owner 当次授权（§27 门禁延续）。

其余全部按 `docs/specs/redesign-norms.md` 分级，在对应里程碑开工时逐项确认。

## 4. 里程碑（分步门禁）

每步完成标准：**规范条目确认 → 实现 → 契约测试绿 → 部署到验证 Worker 实测 → owner 确认后才进入下一步**。产出物随步定稿，旧实现只作参考。

### M0 平台事实核查（纯探针，不建业务）

- 在验证 Worker 上实测：D1 查询延迟分布（含闲置后首次查询）、get-session 等价路径的 CPU 基线、Workers Free 当前 CPU 限制的真实值、subrequest/Workflow 约束。
- 产出：`docs/specs/platform-facts.md`（实测数据表），作为后续所有性能/调度设计的依据。
- **门禁**：owner 确认实测数据可信。

### M1 工程骨架 + 最简部署

- 同栈脚手架：wrangler.jsonc、vite、hono、vue、drizzle、CI（lint/typecheck/test 最小集）。
- 单命令部署到验证 Worker（`wrangler deploy --env staging`，无 preflight/bootstrap 门禁）。
- D1 migration ledger 就位（0001 起，与生产 schema 兼容）。
- **门禁**：空 Worker 在验证域名可访问 + CI 绿。

### M2 认证核心（最高风险区第一个建）

- GitHub OAuth owner 准入 + Session（30 天固定、reauthenticatedAt 门禁）+ cookieCache(JWE, 参数化) + get-session。
- **性能门禁（真实环境实测）**：get-session 缓存命中 TTFB < 100ms、CPU < 10ms；D1 挂起时 5s 内快速失败。
- 规范确认范围：redesign-norms §6/§7/§8。
- **门禁**：性能达标 + owner 在验证环境完成一次真实 GitHub 登录。

### M3 Passkey + 敏感操作

- Passkey 注册/认证/重认证；敏感操作清单与 15 分钟门禁（规范确认后实现）。
- 规范确认范围：§6.4、§7 敏感清单。
- **门禁**：验证环境真实 Passkey 全流程（注册→登出→Passkey 登录→敏感操作重认证）。

### M4 OAuth 2.1/OIDC Provider

- 静态客户端（desktop 启用）、PKCE、authorize/consent/token/refresh/revocation/JWKS/discovery/userinfo/end-session、RFC 9068、tombstone。
- 规范确认范围：§10（已启用部分为硬约束，Web/Mobile 相关条目探讨后决定）。
- **门禁**：用测试客户端完成完整 code flow + refresh 轮换 + 撤销，协议响应与旧 OpenAPI 契约兼容。

### M5 API Key + 业务 API

- API Key（期限/权限/限流/到期头）、/api/status、Problem Details registry（规范确认后实现）。
- 规范确认范围：§9/§11/§12/§15。
- **门禁**：API Key 创建→使用→过期全流程 + 错误语义契约测试绿。

### M6 管理 SPA

- Vue 3 重做：登录、Passkey、API Key、授权应用、审计、备份状态（交互按 §16 确认后设计）。
- **门禁**：E2E（Playwright）在验证环境全流程绿。

### M7 审计 + 备份 + 发布收敛

- 审计（事件/保留期/IP 指纹，§18 确认）、周备份（§19 确认，基于 M0 实测的 Free 约束）。
- 发布流程收敛：production 分支 + ruleset（无 bypass）+ Workers Builds；复杂度匹配单人项目，只保留"CI 必须绿 + 分支受保护 + 部署脚本可回滚"。
- **门禁**：一次完整的受控发布演练（staging→production 切换 + 回滚验证）。

### M8 生产切换

- 数据迁移方案（如 schema 有变更）+ 流量切换到新 Worker + 旧版本保留可回滚。
- **门禁**：owner 按验收标准逐项确认。

## 5. 验收标准

- 全部既有外部契约兼容：Tauri Desktop 客户端无需改动即可完成 OAuth 流程。
- get-session 缓存命中 TTFB < 100ms、CPU < 10ms（真实环境）；D1 挂起时所有读路径 5s 内快速失败。
- 发布流程：production push 无 bypass；一次成功的受控自动部署 + 可回滚。
- `pnpm run check` 全绿（按新工程的最小 CI 集定义）。
- 新规范文档定稿（各里程碑确认条目的汇总，替代旧 foundation.md 的权威地位）。

## 6. 与上一轮的关键差异对照

| 维度     | 上一轮                                  | 本 spec                          |
| -------- | --------------------------------------- | -------------------------------- |
| 规格时机 | 编码前写完 1190 行                      | 每里程碑确认当步条目，随实现定稿 |
| 平台事实 | 文档快照，部署后才发现                  | M0 实测探针先行                  |
| 发布流程 | 第 3 个 PR 就开始建门禁，4 个 PR 未收敛 | M7 最后收敛，M1-M6 最简部署      |
| 认证链路 | 排在中期，问题在首次使用爆发            | M2 第一个建，立即实测性能门禁    |
| 验证方式 | 本地测试 → 部署 → 修复循环              | 每步部署验证 Worker 实测         |
