# eruoo-server

个人身份与授权服务（Workers + Hono + Better Auth + D1 + R2 + Vue），v2 重设计进行中。

## 当前状态

`refactor/v2` 已有 M0 平台实测、M1 骨架与 M2 GitHub/Session 核心代码。完整重设计方案见 [架构规格](docs/specs/architecture.md)，配套覆盖协议、运维与消融验收；需求选择已收敛，允许 Desktop 同步改版并放弃旧接口兼容，新架构尚未实施。

历史 M0-M8 路线与执行授权保留于 [refactoring.md](docs/specs/refactoring.md)；平台事实见 [platform-facts.md](docs/specs/platform-facts.md)。当前分支尚未恢复完整 Passkey、OAuth Provider、API Key、SPA 和备份流程。

## 开发

```bash
pnpm install
pnpm run check        # format + lint + typecheck + test
pnpm run dev          # 本地开发
pnpm run deploy:staging   # 部署验证环境（eruoo-server-staging）
```

当前默认本地配置存在 bindings/Origin 缺失问题，已纳入新规格 R1；`/health` 成功不能代替真实登录验证。上面的命令是现有脚本入口，不代表完整新架构已验收。

## 文档入口

- [docs/index.md](docs/index.md) — 导航
- 旧实现保留在 git 历史（`59bbd32`），旧规格 [foundation.md](docs/specs/foundation.md) 为参考档
