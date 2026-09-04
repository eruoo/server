# M2 认证核心规范（owner 确认记录）

> 确认时间：2026-09-04 16:0x UTC（owner 逐项确认）
> 范围：refactoring.md M2 + redesign-norms §6/§7/§8

## 硬约束（直接沿用，§6）

- GitHub numeric ID `50254496` 为唯一 owner，无开放注册
- 唯一 owner 模型，任何端点不得暴露多用户语义

## §7 Session（owner 确认）

| 项                 | 决策                                         | 说明                                                          |
| ------------------ | -------------------------------------------- | ------------------------------------------------------------- |
| 有效期             | **30 天固定**（旧设计沿用）                  | 不滑动；到期必须重新 GitHub OAuth 登录                        |
| 敏感操作重认证窗口 | **15 分钟**（旧设计沿用）                    | reauthenticatedAt 门禁；敏感操作清单 M3 定稿                  |
| cookieCache        | **JWE 加密 + 30 秒**（旧设计 + M0 实测收益） | 命中路径 cpu 1–2ms 免 D1；撤销延迟上限 30s                    |
| cookie 属性        | HttpOnly + Secure + SameSite（硬基线）       | 具体前缀/策略实现时按 Better Auth 1.7.2 默认 + 旧设计校验等价 |

## §8 身份载体（owner 确认）

- 三载体单选：Session cookie / Passkey 断言 / API Key
- **多载体并存 → 400 + 明确错误码**（防载体混滑；M5 API Key 上线时直接受益）

## 实现要点（来自 M0 实测与资产清单）

- Better Auth **1.7.2**（上游已修复 workerd ALS context loss，先验证 patch 退役）
- `api-key` 与 `oauth-provider` 的 patch 预计保留（M4/M5 实测后定稿）
- D1 挂起防御：**5 秒 safeReadTimeout 快速失败**（M0 结论：挂起为平台间歇现象，防御必须保留）
- 性能门禁：热路径 get-session TTFB < 100ms（cookieCache 命中）；冷场景 < 600ms（M0 冷启动地板 ~470ms）；cpuTime 纳入 Workers Logs 持续监控
- GitHub OAuth App：验证用（callback 指向 staging workers.dev），owner 创建，与生产 App 分离
