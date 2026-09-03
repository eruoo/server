# Changelog

本项目的重要变更记录在此文件中。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed

- Session 读路径开启 30 秒短期缓存（JWE 加密 cookie），`get-session` 的 Session 行查找不再每次穿透 D1；敏感操作（API Key/Passkey 变更、OAuth 授权码签发）绕过缓存强制实时验证，撤销立即生效。OAuth 授权码签发路径在 Hono 层做权威 Session 预检，对表单 POST 同样生效；预检对 cookie 名的 OWS 空白处理与框架解析一致，并在权威失效时把清理 cookie 随响应回传浏览器，避免 SPA 误判已登录。
- 依赖 D1 的应用超时从 15 秒收紧到 5 秒，依赖故障更快以 504/503 呈现，前端可立即重试。

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
