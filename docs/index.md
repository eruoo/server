# 文档导航

## AI 服务架构草案

- [ai-service.md](specs/ai-service.md)：面向多个应用的通用 AI 接入、凭证管理与调用架构；首版 Codex OAuth。AI 设计的唯一来源；其存储、清理与恢复、连接器、协议、调用编排与 AI Key 配置档切片已实施（本地合成验证），AI HTTP 路由与管理界面未开放。

## 完整架构规格（2026-09-09，服务端与 Web 已实施，平台验收另列）

- [architecture.md](specs/architecture.md) — 总入口：产品范围、模块、认证、前端和数据；含已收敛需求选择与新旧规则差异
- [protocol-contract.md](specs/protocol-contract.md) — HTTP、OAuth/OIDC、Desktop 登录/刷新/退出状态与撤销语义
- [operations.md](specs/operations.md) — 环境、审计、备份恢复、发布回滚与观测
- [acceptance.md](specs/acceptance.md) — 消融证据、行为验收、实施切片与各阶段开放范围

实现、验证及 Cloudflare 首次接线状态见 [implementation.md](specs/implementation.md)，不代表获得部署授权。2026-09-09 最新需求已纳入：原生滚动续期、数据从新空库开始、GitHub Actions 产物发布、约 5 分钟常规执行时间目标，以及先做 Web、Desktop 延后、不维护旧接口兼容；依据见架构 Q3–Q7。2026-09-10 按 owner 当次授权沿用稳定资源名、准备空存储并同步配置，覆盖关系见 Q8。owner 新指令覆盖冲突的历史条款，其余规则继续有效。平台实测与接口字段快照仍分别维护，本次验收服务端和 Web，实际 Desktop 联调延后。

## v2 历史确认与实测记录

以下保留历史过程；旧文中的状态、待办与阶段顺序不自动成为当前要求。外部执行仍遵循未被最新授权覆盖的 refactoring.md §7；当前目标统一从上面四份规格读取。

- [refactoring.md](specs/refactoring.md) — 历史里程碑路线与仍适用的执行配置（§7 owner 已确认）
- [platform-facts.md](specs/platform-facts.md) — 平台实测数据（M0 产出）
- [m0-summary.md](specs/m0-summary.md) — M0 收尾报告
- [m1-skeleton.md](specs/m1-skeleton.md) — M1 骨架设计与决策记录
- [m2-auth.md](specs/m2-auth.md) — M2 认证核心确认记录（分类与当前规格的差异见 architecture.md）
- [redesign-norms.md](specs/redesign-norms.md) — 旧规格 29 节分级盘点
- [redesign-assets.md](specs/redesign-assets.md) — 旧项目资产清单与版本情报
- [openapi.json](openapi.json) — 自有 API 的生成契约（`pnpm run openapi:generate`，检查时比对漂移）

## 参考档（非权威）

- [foundation.md](specs/foundation.md) — v1 规格全量记录（历史价值与细节查阅）
