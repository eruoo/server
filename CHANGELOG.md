# Changelog

本项目的重要变更记录在此文件中。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.0.1]

首个生产发布候选。只有对应 commit 成功部署并完成 `docs/releasing.md` 中的验收后，才创建 `v0.0.1` tag 与 GitHub Release。

### Added

- 基于 Cloudflare Workers、Hono、D1 和 Vue 的个人身份、鉴权与管理服务。
- GitHub owner OAuth、Passkey、30 天 Session、有限期 API Key，以及面向 Tauri Desktop 的 OAuth 2.1/OIDC Provider。
- 审计日志、授权应用管理、D1 Workflow 备份到私有 R2、180 天保留和隔离恢复规划器。
- OpenAPI、生成式客户端类型、Vitest/workerd/Playwright 测试以及严格的生产发布门禁。

### Security

- owner allowlist、recent-auth、PKCE、refresh token 轮换与撤销、RFC 9068 access token、CORS fail-closed 和 Secret 扫描。
- 受控 `production` 分支、Workers Builds branch/SHA 校验、远端 migration 先于 Worker deploy、禁用自动 provisioning，以及 D1/R2 免费额度保护。

[Unreleased]: https://github.com/eruoo/server/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/eruoo/server/releases/tag/v0.0.1
