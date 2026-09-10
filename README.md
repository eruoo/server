# eruoo-server

个人身份与授权服务：一个 Cloudflare Worker 提供认证、OAuth、管理 API 和同源 Vue Web 界面，D1 保存状态，R2 + Workflow 保存独立备份。

当前已实现服务端与 Web。Desktop 客户端暂缓；本地验证与尚未执行的平台验收见 [实施记录](docs/specs/implementation.md)。架构和契约从 [文档导航](docs/index.md) 进入。

## 本地开发

使用 Node.js 24、pnpm 11。首次复制 `.dev.vars.example` 为 `.dev.vars`，填写独立的本地 GitHub OAuth 凭证和随机密钥。已有 `.dev.vars` 时补齐缺少项，不覆盖原值。

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm run dev                 # 校验本地配置，应用本地 migration，启动 localhost:5173
pnpm run check               # 格式、lint、类型、Worker/Web/脚本测试、OpenAPI、浏览器 E2E
pnpm run build:release staging
pnpm run build:release production
```

测试只使用合成凭证、GitHub stub 和本地 D1/R2，不需要真实登录。真实 GitHub 回调地址配置为 `http://localhost:5173/api/auth/callback/github`。

## 发布

CI 对同一 SHA 检查一次，分别构建 staging/production 产物，保留 7 天。手动发布消费该产物并执行必要 migration、部署、读回与冒烟，不重复测试/构建。

```bash
pnpm run deploy:staging <完整的已通过 CI 的 SHA>
pnpm run deploy:production <完整的已通过 CI 的 SHA>
```

这些命令会触发远端操作，须在获得对应环境、版本的授权后执行。远端资源已按原名准备并写入配置；已完成接线与首次发布剩余步骤见 [接线记录](docs/specs/implementation.md#4-运行与首次发布接线)。资源准备不代表新版已发布。
