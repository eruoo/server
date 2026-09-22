# AI 接入服务

更新：2026-09-22。本文是 AI 服务的唯一设计来源；当前实现改为 DeepSeek 官方 API。DeepSeek staging 人工验收及历史 Codex 记录见 [实施记录](implementation.md#423-2026-09-22deepseek-staging-人工验收与后续简化)；本文新增的原生模型名与单连接路由仍待部署。身份、OAuth/OIDC、备份与发布规则继续由 [architecture.md](architecture.md)、[protocol-contract.md](protocol-contract.md)、[operations.md](operations.md) 维护。

## 1. 目标

让 owner 配置上游 API Key，再向受控应用签发本站调用 Key。Worker 直接访问 `https://api.deepseek.com/models` 和 `/responses`，保持 Cloudflare Workers/D1 部署形态。没有 Chat Completions 转换、网关、任意目标 URL 或上游自动重试。

## 2. 身份与产品边界

上游 DeepSeek Key、本站调用 Key、owner 登录 Session 是三类独立凭证。DeepSeek Key 不创建本站用户，不进入 Better Auth account/session 表。调用者使用本站 `x-api-key`，不能用 owner Cookie、OAuth Bearer 或上游 Key 代替。

AI 连接管理要求有效 owner Session，写操作强读持久会话，不要求 recent authentication。写入上游 Key 的同一 D1 事务中再次检查 Session 存在、尚未到期、user 与 GitHub owner 绑定正确。本站调用 Key 的签发与变更、Passkey 管理仍要求 recent authentication。

界面提供连接、模型目录、调用 Key 授权和调用记录，不提供聊天工作台。管理写操作保留同源 Origin/Fetch Metadata、JSON 类型与入口限流检查。

## 3. 调用路径

1. owner 创建连接，输入 DeepSeek Key 并保存。
2. 服务端加密保存；前端另发模型发现请求。发现失败单独展示，可重试发现。
3. owner 为应用创建 `ai` 配置档调用 Key，选择一条连接，再勾选该连接当前可用的模型。
4. 应用通过 `/api/ai/models` 查看获准模型，通过 `/api/ai/responses` 调用。
5. 服务端校验调用 Key、全局与单 Key 名额、模型授权和能力，再发送一次上游请求。

## 4. 对象与权限

### 4.1 连接

连接包含服务端 UUID、名称、启用状态、`providerType=deepseek`、凭证状态和版本。名称最多 100 字，仅供管理界面识别；创建只填写名称，不再配置 slug。名称可修改，路由与权限始终绑定 UUID。

`credentialVersion` 在保存、明确失效或断开时递增，控制模型快照和迟到结果。`permissionVersion` 只在断开或恢复清理时递增，控制本站调用 Key 的授权。静态 Key 没有虚构的到期时间、刷新令牌或设备授权会话。

### 4.2 模型 ID 与能力

DeepSeek `/models` 返回的 `data[].id` 就是请求中使用的调用名，不承诺另有一个“实际版本 ID”字段。目录按原样保存 ID；不根据别名猜测版本，不在显示名中伪造版本。官方当前将调用名 `deepseek-flash` 对应到 DeepSeek-V4.1-Flash，这是文档说明，不是目录接口返回的版本标识。

目前确认的调用名为 `deepseek-flash` 与 `deepseek-v4-pro`。两者支持文本、function tools、结构化输出与 effort；`deepseek-flash` 支持图片输入。能力映射来自官方文档，不来自 `/models`。未知 ID 可以出现在管理目录，但默认不可授权或调用；确认能力后再加入映射。

本站模型名直接使用上游 ID，例如 `deepseek-flash`，不添加连接前缀，区分大小写且保留 ID 本身的斜杠。`/api/ai/models` 返回的 `id` 可直接填入 Responses 的 `model`。调用 Key 绑定的连接决定使用哪个上游 Key；相同模型名不会跨连接回退。模型发现成功后原子替换快照，仅当前凭证版本可提交。响应体最多 256 KiB、最多 200 个唯一模型。保存新 Key 时清空旧快照，必须重新发现后才能调用。

### 4.3 本站调用 Key

`ai` 配置档包含固定 `ai: [models:read, invoke]` 操作，绑定一条连接及其精确模型列表。创建时必须提供 `connectionId` 与非空 `modelIds`；编辑授权时两者一起提供并整体替换，省略两者仅改名，空模型数组撤销全部模型但保留连接绑定。

持久权限恰有一个 `ai-model:<connection-uuid>:<permission-version>` 键，值为原生模型 ID 数组。旧单连接 Key 可直接继续使用；旧多连接或无连接权限不会自动选择上游，owner 必须明确重选连接和模型。删除后重建同名连接、断开后重配都不能让旧授权复活；不支持通配符或自动授权新模型。

普通换 Key 保留 permissionVersion。因此，原本获准的模型在新 Key 成功发现同名模型后恢复可用；未授权模型仍不可用。连接停用会暂停调用，重新启用恢复既有授权。

## 5. 上游 Key 生命周期

### 5.1 保存与替换

`PUT /api/ai/connections/{id}/credential` 接受 `{apiKey, expectedVersion}`。只接受 1–2048 位非空白可打印 ASCII Key。服务端 AES-256-GCM 加密后，在单个 D1 batch 中清除旧模型快照并按 expectedVersion 条件保存；并发替换只有一个成功，落库失败整体回滚。Session 不再有效返回本站 401，版本冲突返回 409。

保存本身不调用 DeepSeek，成功只说明 Key 已保存。界面提交时立即清空密码框，切换登录 Session 或卸载时也清空，不回显、不写浏览器持久存储。模型发现决定目录是否可用，真实推理仍可能因余额或上游状态失败。

### 5.2 加密

`AI_CREDENTIAL_KEYS` 为逗号分隔的 `<version>:<base64url 32-byte key>`。新写入使用最高版本，读取使用密文封套的版本；轮换期间保留仍在使用的旧版本。封套格式包含格式版本、密钥版本、随机 IV 和密文，最多 4096 字符。AAD 绑定部署环境、连接 UUID、provider 和用途。

密钥只按需解析，不在模块初始化时阻断身份系统。缺少加密配置属于本站运维错误，不据此清除上游 Key。任何管理响应、审计、调用记录均不返回 Key 或密文。

### 5.3 断开与上游拒绝

- **替换 Key**：保留本站调用 Key 的模型授权，清空目录并重新发现。适用于同一用途的正常轮换。
- **断开连接**：清除上游 Key，同时递增 permissionVersion，撤销该连接的全部模型授权。以后重新保存 Key，也必须在调用 Key 管理中重新勾选授权。
- **换账号**：建议新建连接。服务无法根据 Key 自动可靠判断是否还是原账号；主动替换表示让原应用改用新 Key。
- **上游 HTTP 401**：仅使实际被拒绝的 credentialVersion 失效；旧请求的迟到 401 不能清除后来保存的新 Key。不刷新、不重放推理。

断开阻止后续调用，不等同于在 DeepSeek 平台撤销 Key，也不保证已经开始的上游请求停止。

## 6. HTTP 与 Responses 子集

### 6.1 管理接口

`GET /api/ai/providers`、`GET/POST /api/ai/connections`、`PATCH/DELETE /api/ai/connections/{id}`、`PUT /api/ai/connections/{id}/credential`、`POST /api/ai/connections/{id}/disconnect`、`POST /api/ai/connections/{id}/models/refresh`、`GET /api/ai/invocations`。设备授权 start/poll/cancel 接口已移除。

契约由 [OpenAPI](../openapi.json) 生成。公开连接包含版本号与状态，不含任何上游凭证。

### 6.2 调用接口

`GET /api/ai/models` 仅列出调用 Key 所绑定连接有效、当前凭证快照存在、能力已确认且该调用 Key 明确获准的模型。`POST /api/ai/responses` 支持下列严格子集；不支持字段直接 422，不静默降级。

- `input`：字符串，或明确 `type` 的消息、function_call、function_call_output、reasoning 项列表。消息角色为 system/user/assistant；文本为 input_text/output_text。reasoning 使用 `content: [{type: reasoning_text, text: ...}]`。
- 图片：仅 user 消息中的内联 PNG/JPEG/WebP base64 data URL，且模型必须具备 vision 能力。远程 URL、Files API、视频、GIF 和工具结果中的图片不在本站子集内。
- `instructions`；`reasoning.effort` 为 `none/low/high/max`，**省略时本站明确发送 max**。none 关闭推理，显式选择其他值原样发送。
- `max_output_tokens` 为 1–393216 整数，包含推理与可见输出；其上限仍受上游模型实际限制。
- `text.format` 支持带 name/schema 的 json_schema。function tools 支持 description/parameters；名称唯一、最长 128 位，仅字母数字下划线及短横线。tool_choice 支持 auto/none/required/已声明 function。历史 function_call 必须与后续 function_call_output 逐一配对。
- `stream` 默认 true；false 时仍消费原生上游 SSE 并返回最终 Response 对象。`store` 只接受 false，`parallel_tool_calls` 只接受 true，二者在上游是固定行为；本站验证后不发送这两个兼容字段。

DeepSeek 将 developer 当 user 处理，本站拒绝 developer，避免指令优先级被降级。encrypted_content、reasoning.summary、include、previous_response_id、持久会话、strict、内置/custom tools、temperature/top_p 等均不在本站子集内。客户端发送完整历史，并按上述字段重建历史项，不能把包含额外字段的原始输出对象直接回填。

### 6.3 终态与错误

透传原生 reasoning、文本、function call 等语义 SSE；以 response.completed/incomplete/failed 为终态，不添加 `[DONE]`。收集 output_item.done，在最终 output 缺少项目时补齐；JSON 与 SSE 使用同一套终态解析。失败以本站受控 Problem 返回，不返回原始上游错误体。

HTTP 401 对外为 `ai-reauthorization-required`（503，需更新上游 Key），402 为 `ai-upstream-quota-exceeded`（429，余额不足），429 为 `ai-upstream-rate-limited`（429），403/5xx 为 `ai-upstream-unavailable`（503）。这些都不是 owner Session 失效；只有本站会话认证的 401 会触发管理页退出。

首次响应前超时返回 request-timeout（504）；流已建立后失败发送一次受控 error 终态。客户端取消记为 unknown，不声称上游停止。推理请求不自动重放。usage 按上游终态实际提供的对象记录，缺失即未知；包括失败终态中提供的部分 usage，不推算费用。

## 7. 准入与运行限制

| 范围                      | 限制                                           |
| ------------------------- | ---------------------------------------------- |
| 推理请求体                | 精确推理路由最多 8 MiB；其他接口继续通用 1 MiB |
| 推理名额                  | 服务共 2 个，每个调用 Key 1 个；无排队         |
| 凭证读取                  | 最多 15 秒，受总 deadline 约束                 |
| 推理总 deadline           | 从请求到达起 300 秒                            |
| 上游首次响应 / 无数据间隔 | 各 90 秒，受总 deadline 约束                   |
| 模型发现网络              | 一次最多 10 秒，受管理阶段 30 秒约束           |
| SSE 单事件 / JSON 终态    | 4 MiB                                          |
| SSE 累计读取 / 传输       | 各 8 MiB，含协议帧与心跳                       |
| SSE 心跳                  | 静默时每 15 秒                                 |
| reservation               | deadline 后另保留 30 秒供终态写入              |
| 调用元数据                | 查询与每日清理均使用 30 天保留边界             |

认证后通过 D1 单条条件写入获取名额，再完整读取大请求体。限额不满足立即拒绝；超时的迟到准入结果不能继续读取 body 或开始上游调用。名额约束本站生命周期，不代表提供方取消语义。

只保存 requestId、keyId、连接/模型 ID、时间、终态、受控错误代码、上游 requestId 与实际 usage。默认不保存输入、输出、图片或完整上游错误。固定地址使用手动重定向模式，3xx 作为失败处理，不携带 Key 跳转。

## 8. 数据与恢复

追加 `0004_deepseek_api.sql`：删除旧 AI 配置档调用 Key、旧调用记录、旧连接、模型快照和设备授权会话；重建 connections/models 表，删除设备授权表。无需搬运或兼容旧 Codex 凭证、权限或会话。身份、Passkey、OAuth、普通调用 Key 等非 AI 数据保留；既有 0001–0003 迁移不改写。

本次不新增迁移，既有 0001–0004 不改写。数据库保留内部 slug 列以兼容发布切换与旧 Worker 回退；旧值不变，新连接自动使用自身 UUID 填充，界面与 API 不再接受或返回 slug。现有 DeepSeek 连接 UUID、加密 Key、版本、模型快照、调用记录和本站 Key 权限全部保留。客户端需将旧的 `连接前缀/模型名` 改为原生模型名。

每日清理只处理过期调用元数据，每批最多 500 行，每次最多 10 批，剩余留至下次。恢复工具可识别历史表结构与新结构：历史备份按原表结构清理后再应用后续迁移；新备份清除上游 Key、推进 credentialVersion/permissionVersion、结束在途调用为 unknown。恢复流程原本要求清除本站凭证的规则继续适用，不会借备份恢复重启授权。

## 9. 管理界面

连接页显示 Key 是否已配置、启停状态、模型 ID、明确的能力与 effort 列表（默认 max）。保存 Key 后另发模型发现；失败保留可重试入口。断开确认明确说明会撤销该连接模型授权。Key 输入框始终为空开始，无设备码、轮询、虚构到期或刷新入口。

本站 AI Key 创建和编辑统一使用“选择连接 → 勾选该连接模型”；切换连接会清空已选模型，必须重新勾选，不因模型同名自动转移授权。全部取消后可保存以撤销模型许可。

## 10. 扩展边界

新模型需先确认官方调用名和能力，再调整能力映射。协议扩展必须同时更新严格校验、能力判断、契约与验证；不能因为上游会忽略未知参数就接受它。多提供方、任意代理、自动重试、聊天存储、计费估算不在本次范围。

## 11. 验证与上线边界

本地使用合成 Key 与 fetch mock，验证静态凭证、Session 原子检查、并发替换、版本防回写、换 Key/断开权限规则、默认 max、图片、SSE/JSON、超时取消、迁移和恢复。原登录会话修复保留在提交历史中。

上线、远程 D1 迁移、Secret 写入和真实 DeepSeek 请求需要 owner 当时授权。本次本地实现不意味着已经部署或实际模型调用成功；真实验证应覆盖目录、文本、图片、effort 与完整工具往返。

## 12. 官方资料

能力核对日期：2026-09-22。

- [模型列表 API](https://api-docs.deepseek.com/api/list-models/)
- [模型与价格说明](https://api-docs.deepseek.com/quick_start/pricing/)
- [Responses API](https://api-docs.deepseek.com/api/create-response/)
- [Responses 使用指南](https://api-docs.deepseek.com/guides/responses_api/)
- [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [错误代码](https://api-docs.deepseek.com/quick_start/error_codes/)
