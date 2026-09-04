# eruoo-server

个人身份与授权服务（Workers + Hono + Better Auth + D1 + R2 + Vue），v2 重设计进行中。

## 当前状态

`refactor/v2` 分支按 [docs/specs/refactoring.md](docs/specs/refactoring.md) 的 M0-M8 里程碑重建：

- **M0 平台实测** ✅（[platform-facts.md](docs/specs/platform-facts.md)）
- **M1 工程骨架** 🔨（当前）
- M2-M8：认证核心 → Passkey → OAuth Provider → API Key → SPA → 审计备份发布 → 生产切换

## 开发

```bash
pnpm install
pnpm run check        # format + lint + typecheck + test
pnpm run dev          # 本地开发
pnpm run deploy:staging   # 部署验证环境（eruoo-server-staging）
```

## 文档入口

- [docs/index.md](docs/index.md) — 导航
- 旧实现保留在 git 历史（`59bbd32`），旧规格 [foundation.md](docs/specs/foundation.md) 为参考档
