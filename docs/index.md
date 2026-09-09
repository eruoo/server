# 文档导航

## 完整架构规格（2026-09-09，需求已收敛，待实施）

- [architecture.md](specs/architecture.md) — 总入口：产品范围、模块、认证、前端和数据；含已收敛需求选择与新旧规则差异
- [protocol-contract.md](specs/protocol-contract.md) — HTTP、OAuth/OIDC、Desktop 协同契约与撤销语义
- [operations.md](specs/operations.md) — 环境、审计、备份恢复、发布回滚与观测
- [acceptance.md](specs/acceptance.md) — 消融证据、行为验收和按流程实施的切片

以上描述目标设计，不表示已实现或获得部署授权。2026-09-09 最新需求已纳入：原生滚动续期、数据从新空库开始、GitHub Actions 产物发布、约 5 分钟常规执行时间目标，以及 Desktop 同步改版并放弃旧接口兼容；依据见架构 Q3–Q6。owner 新指令覆盖冲突的历史条款，其余规则继续有效。平台实测与接口字段快照仍分别维护，服务端与新版 Desktop 按当前契约共同验收。

## v2 既有确认与事实

- [refactoring.md](specs/refactoring.md) — 里程碑路线与执行配置（§7 owner 已确认）
- [platform-facts.md](specs/platform-facts.md) — 平台实测数据（M0 产出）
- [m0-summary.md](specs/m0-summary.md) — M0 收尾报告
- [m1-skeleton.md](specs/m1-skeleton.md) — M1 骨架设计与决策记录
- [m2-auth.md](specs/m2-auth.md) — M2 认证核心确认记录（分类与新提案的差异见 architecture.md）
- [redesign-norms.md](specs/redesign-norms.md) — 旧规格 29 节分级盘点
- [redesign-assets.md](specs/redesign-assets.md) — 旧项目资产清单与版本情报
- [openapi.json](openapi.json) — 自有 API 的现存字段快照（实施时由路由 schema 生成接管）

## 参考档（非权威）

- [foundation.md](specs/foundation.md) — v1 规格全量记录（历史价值与细节查阅）
