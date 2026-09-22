# 通用 AI 服务架构

日期：2026-09-15

状态：设计来源；存储、维护与恢复切片已实施（2026-09-18，见 [实施记录](implementation.md)），Codex 连接器、凭证加密、设备授权编排、凭证刷新与模型发现已实现并完成本地合成验证（2026-09-19，见 [实施记录 §4.15](implementation.md)），AI HTTP 路由已注册（2026-09-19，见 [实施记录 §4.19](implementation.md)），AI Key 配置档已实施（见 §4.18）、管理界面已交付（2026-09-19，见 [实施记录 §4.20](implementation.md)）；部署配置未生效、真实上游未验证，AI 服务尚未对外可用

首版上游：Codex OAuth

修订：2026-09-18。

本文从 eruoo/server 的长期职责出发设计，适用于多个应用、CLI 和自动化。本文中的 Codex OAuth 指：owner 使用 ChatGPT/Codex 账号授权，eruoo 保存和刷新上游令牌，再代受控调用者请求 Codex 模型。它与“客户端通过 eruoo OAuth 登录”是两条独立的授权链。

本文是拟议 AI 能力的唯一设计来源。现行身份、OAuth/OIDC、备份与发布规则仍由 [architecture.md](architecture.md)、[protocol-contract.md](protocol-contract.md)、[operations.md](operations.md) 维护；存储、维护与恢复切片已按本文实施，HTTP 路由、Key 配置档与管理界面已实施（2026-09-19），但真实上游与部署验证仍待完成；均不代表线上能力已经具备。

## 1. 目标与推荐方向

建设 eruoo 的通用 AI 接入服务，统一管理上游连接、凭证生命周期、可用模型和调用权限。各应用保留提示词、业务数据、业务流程和工具执行。

推荐继续使用当前 TypeScript、Hono、Cloudflare Worker、D1 的模块化单体。AI 是独立功能模块，依赖现有认证能力；身份模块不依赖 AI 初始化、配置或上游健康。首版不新增独立 Worker、常驻进程、消息队列或 Durable Object。

最小路径是增加一个固定 Codex 转发 handler。选用本文的分层方案，是因为 OAuth 凭证轮换和多个调用者会立刻产生共享状态，仅有转发 handler 无法正确处理这两个已知需求。

首版完成标准：

1. owner 在 eruoo 管理界面完成一次独立的 Codex 设备授权。
2. 获得一份由上游连接确认的模型目录，并给不同调用凭证授予指定模型的访问权。
3. 调用者通过稳定 HTTP 入口完成文本、图片输入和流式生成。
4. 令牌正常刷新；授权失效、刷新冲突、超时、断流和额度不足均有明确结果。
5. AI 依赖失败不改变 eruoo 登录状态，不阻塞其他已开放能力。

## 2. 三条边界

### 2.1 身份边界

- eruoo owner：管理连接、完成上游授权、创建和撤销调用凭证。
- eruoo 调用者：通过本服务 API Key 获得受限 AI 调用权。
- 上游账号：提供 Codex 模型访问权，其令牌只在服务端使用。

Codex 登录不会创建 eruoo 用户，也不会自动获得 owner 权限。其凭证不写入 Better Auth 用于登录的 account、session 或 OAuth grant 表。

### 2.2 产品边界

AI 模块处理共用接入能力。截图识别、知识库组织、业务提示词、会话持久化、工具执行和 Agent 工作流由应用维护。

函数工具调用作为模型输入输出的一部分传递，执行函数的责任属于调用应用。首版能力不包括服务端运行 shell、托管 MCP、文件管理、向量库、后台生成任务、自动跨账号轮换、自动模型降级或额度购买。

### 2.3 协议边界

通用核心统一身份、策略、凭证和运行状态，不把所有提供方强制转换成同一种消息结构。

每种对外协议有独立入口与校验器；每种上游类型有独立连接器。首版开放 Responses 风格的明确子集；它的支持范围和错误契约由本服务定义，不宣称是完整 OpenAI API 镜像。

## 3. 总体结构

```text
管理浏览器
    |
    v
现有 owner Session（API Key 管理另要求 recent-auth）
    |
    v
AI 管理接口 ---> 连接、设备授权、模型目录、调用凭证
                       |
                       v
                      D1
                       ^
                       |
应用 / CLI / 自动化
    |
    v
AI HTTP 入口
    |
    v
现有 API Key 验证 ---> 模型授权与准入限制
                          |
                          v
                     解析调用目标
                          |
                          v
                 凭证管理：读取、刷新
                          |
                          v
                 提供方连接器
                          |
                          v
                Codex 上游（首版）
                          |
                          v
                 SSE / JSON 响应
```

调用记录与安全审计从相应操作写入，不参与循环调用。管理接口和推理接口共享数据定义，不通过公网 HTTP 互相调用。

## 4. 核心对象

| 对象               | 表达的事实                                            | 首版选择                   |
| ------------------ | ----------------------------------------------------- | -------------------------- |
| ProviderDefinition | 某种上游产品的认证方式、固定目标地址、协议和能力边界  | 代码注册 `openai-codex`    |
| AiConnection       | owner 授权使用的一个上游账号或工作区连接              | Codex OAuth 凭证与账号标识 |
| AiModel            | 连接下可见的上游模型及已确认能力                      | 按连接发现、更新和展示     |
| 调用授权           | 一把 eruoo API Key 允许执行的 AI operation 与模型集合 | 使用现有插件 permissions   |
| AiInvocation       | 一次调用的准入、执行和终态元数据                      | 用于并发限制与排错         |

提供方类型要区分产品渠道。例如，未来 `openai-platform` 与 `openai-codex` 是不同类型：它们可以提供同名模型，但认证、地址、参数支持和额度口径可能不同。

### 4.1 连接

连接具有服务端生成且永不复用的 UUID、不可变 slug、可编辑名称、提供方类型、启用状态、授权状态、上游账号标识和凭证版本。slug 在现存连接中唯一，只允许 1 至 64 个小写 ASCII 字母、数字及分隔用的单个连字符，首尾不能是连字符。

允许建立多个连接，但每次调用必须解析到一个明确连接。首版不进行账号池调度。重新授权默认要求保持原账号及工作区；发现账号改变时拒绝覆盖，owner 应新建连接，避免现有授权悄然转向另一个上游账号。

首版 Codex 地址和 OAuth 客户端标识来自固定版本的连接器定义，不开放任意 URL、Host、代理目标或认证头配置。

### 4.2 模型

对外模型 ID 使用“连接 slug / 上游模型 ID”，例如 `codex-main/gpt-6-astra`。这是命名示例，不代表该账号已验证可使用这个模型。

服务端按完整模型目录记录解析目标，不把调用者提交的字符串直接拼接成上游 URL。上游模型 ID 保留原始大小写；完整对外 ID 按字符串精确匹配，不做大小写折叠、去空白或额外 URL 解码。

对外模型 ID 用于查找和展示，持久权限绑定不可复用的连接 UUID 与上游模型 ID。删除后可以复用 slug，但新连接必须获得新 UUID；旧 Key 中对已删除连接的授权失效，不能随同名模型恢复。模型列表和推理入口均先解析当前连接，再检查这组内部标识。

模型目录在授权成功后、重新授权后和 owner 手动刷新时更新。查询接口只读本地快照，不在每次列表读取时请求上游。更新失败保留上次快照并显示时间与错误；首次没有成功快照时不声明模型可用。

模型能力取“连接器能支持的能力”与“该模型已确认的能力”的交集。图片、结构化输出、函数工具、推理参数等缺失信息标记为未确认，不能根据模型名称猜测。新出现的模型不会自动加入已签发 Key 的许可集合。

模型目录最终失败的 `ai_model_refresh_failed` 运维事件关联本地 `requestId`、`connectionId`、失败类别、HTTP 状态及 `attemptPhase`（`initial` / `replay`）。仅该目录调用在读取非 2xx 正文前提取 `responseDiagnostics`：`cfMitigated` 为 `challenge` / `absent` / `other`；`contentType` 将 `application/json`、`text/html`（忽略大小写与参数，原值至多 256 字符）归为 `json`、`html`，其余为 `other` 或 `absent`。`cfRay` 仅接受 16 位十六进制加连字符与 3 位大写机房代码；`upstreamRequestId` 仅接受 UUID 形态或 `req_` 加 16–64 位 ASCII 字母数字，最长 68 字符，无效值直接丢弃。错误正文仍最多保留 4096 字节、溢出不保留前缀。仅模型目录错误路径在同一次流式读取中附带 `bodyFeatureDiagnostics`：有界特征扫描至多 16384 字节、特征匹配处理跨数据块边界，到界即取消读取且不读下一数据块确认 EOF。因此达到 16384 字节即记 `limit-exceeded`（正文完整性未确认，即使正文实际到此结束）；不足上限且正常结束才记 `complete`。仅记录 `openAiBlockedSitePageMarkers`（"Unable to load site / If you are using a VPN…" 页特征）与 `cloudflarePageMarkers`（已知 Cloudflare 挑战/拦截页特征）两个布尔值及 `readOutcome`（`complete` / `limit-exceeded` / `failed`）。`readOutcome` 非 `complete` 时，false 仅表示已扫描前缀内未发现，不表示确定不存在；特征一致只说明响应特征相同，不能据此认定拦截层或根因。正文在越过 4096 字节保留界后、尚未达到 16384 字节扫描界时停滞，读取会等待至既有单次调用超时中止，而非在 4096 字节处提前取消；达到扫描界则立即取消。单次调用最坏耗时不变，预算与恢复规则本身不变。其余上游错误路径保持溢出即取消读取。溢出或读取失败不丢失已取得的状态与头诊断。诊断不进入公开响应、审计或数据库，不增加网络请求、重试或改变恢复和预算语义。

按 [Cloudflare 官方说明](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)，`cf-mitigated: challenge` 是 Challenge Page 的直接证据；只有 403、HTML 或 `cf-ray` 不足以判断。确认 challenge 也不能推出出口 IP、TLS 指纹或令牌是否被评估；标记缺失不能证明响应来自应用层。真实来源与根因仍以 staging 取证结果为准。

### 4.3 调用授权

复用现有 API Key 插件，新增 `ai` 配置档；现有默认 Key 继续只拥有原来的权限。

- operation 权限：首版 AI Key 固定授予 `ai:invoke`、`ai:models:read`。
- 模型授权：owner 选择一组明确的对外模型 ID，服务端解析后保存连接 UUID 与上游模型 ID，首版不提供通配符。
- 创建和修改权限必须经过 recent owner Session，并由服务端构造插件权限字段。
- 列表、到期提示、命名和撤销复用现有管理体验。
- 不新增用户、组织、角色、应用注册或重复的凭证表。

插件 `permissions` 的映射如下。`ai` 的 action 表达 operation；`ai-model:<连接 UUID>` 的 action 集合保存精确上游模型 ID，两项检查必须同时通过才可推理。以下 UUID 和模型名仅为格式示例：

```json
{
  "ai": ["invoke", "models:read"],
  "ai-model:550e8400-e29b-41d4-a716-446655440000": ["gpt-6-astra"]
}
```

首版推理认证使用现有 `x-api-key` 约定。Cookie、OAuth Bearer 与 API Key 的单载体规则保持一致；不要把 Codex 上游 OAuth token 当作本服务的调用凭证。跨站浏览器应用通过自己的后端调用，当前同源管理边界和空 CORS allowlist 保持有效。

## 5. 首版 Codex OAuth 接入

### 5.1 选择设备授权

采用 Device Code 流程，适合没有 localhost 回调监听器的 Worker：

1. owner 在连接页面点击授权，服务端按 §6.1 校验当前持久 owner Session。
2. 连接器申请设备码；本地创建限时授权会话，绑定 owner、当前 Session 和连接版本。
3. 前端显示官方验证地址和一次性 user code。设备内部标识、验证码、临时授权码及令牌均不进入日志。
4. 前端按服务端返回的时间调用 poll 接口；每次 poll 最多进行一次上游检查。
5. 获得授权码后，连接器按 Codex 的 PKCE 交换流程取得凭证。
6. 校验身份令牌的签名、issuer、audience 和有效期，提取账号与工作区信息。
7. 在同一个 D1 原子提交中保存凭证并完成授权会话；只有该提交成功，界面才显示已连接。
8. 授权提交后由前端另发一次模型刷新请求；模型发现失败时显示独立状态，不伪装成 OAuth 登录失败。

上游流程不是普通 OAuth/OIDC discovery 即可完整描述的通用设备授权。具体设备码路径、交换方式、客户端标识与返回字段只属于 Codex 连接器，依据固定源码版本验证。

授权会话最长 15 分钟；轮询间隔遵守上游指示，缺失或非法值按 5 秒处理且不短于 1 秒。采用 D1 原子 claim 和 nextPollAt 阻止多标签页重复兑换。取消、过期、退出和连接版本变化都会阻止迟到结果写入。

不在 Worker 请求里持续等待用户完成登录，也不启动新的后台轮询服务。页面关闭后停止轮询，限时内重新进入同一 Session 可以继续。

### 5.2 凭证保存

新增专用于 AI 的版本化加密 Secret：`AI_CREDENTIAL_KEYS`，由 AI 模块实际消费。[协议规格 §4.3](protocol-contract.md#43-token-与公钥) 中禁止独立加密 Secret 的条款约束 Better Auth 管理的 OIDC 签名私钥；该私钥继续使用 `BETTER_AUTH_SECRETS`，AI 上游凭证按本节独立加密。

- 使用平台 Web Crypto AES-256-GCM，随机 96-bit IV。
- 密文包含格式版本与 key ID；附加认证数据绑定环境、连接 ID、提供方类型和用途。
- access token 与 refresh token 作为一个凭证包原子保存。
- 身份令牌校验后只保留必要的账号信息；不为展示而长期保存完整 ID token。
- 管理 API 返回连接状态和脱敏账号信息，不返回凭证明文。
- 加密密钥与数据库备份分别保管；轮换支持读取旧版本，新写入使用当前版本。

AI Secret 缺失或无效只阻止依赖凭证的 AI 功能，不能使 owner 无法登录和修复配置。

### 5.3 刷新与撤销

D1 是凭证状态的唯一事实来源。每次调用读取当前凭证版本，访问令牌即将到期时提前刷新，提前窗口设为 60 秒。

刷新使用连接行上的原子 claim、lease ID 和凭证版本条件，协调不同 Worker 实例。不能使用跨请求的模块级 Promise 充当全局刷新锁，也不复用仅用于备份的 maintenance_lease。

- 同一版本的刷新只有一个执行者；其他请求在令牌仍足够有效时可继续，否则返回可稍后重试的凭证忙状态。
- 刷新网络预算 10 秒，包含响应体读取，claim 保留 30 秒；所属请求的剩余预算更少时取较小值。
- 新令牌必须完成持久化后才能用于推理。
- 确定的 refresh token 过期、撤销或 invalid_grant 进入 reauthentication_required；access token 到期本身仍走刷新流程。
- 可以证明刷新请求尚未发出，或固定版本的上游契约明确保证该失败未消费 refresh token 时，保留原凭证、释放 claim，返回上游不可用，允许后续显式重试。不能仅凭通用 fetch 异常推断请求未送达。
- 刷新已经发出但结果不明，或 Worker 退出导致 claim 过期，进入凭证状态不确定并要求重新授权；不盲目重放可能已轮换的 refresh token。HTTP 5xx 本身不能证明上游没有轮换，缺少上述保证时也按结果不明处理。
- owner 断开连接时清空凭证、推进版本并取消待处理授权；旧刷新结果不能覆盖断开状态。

授权交换和令牌刷新存在“上游成功、D1 未提交”的窗口，无法靠数据库事务获得跨系统原子性。首版明确以重新授权恢复这种情况，不承诺永不丢失登录状态。

本地断开只保证 eruoo 不再使用该连接，不等同于撤销其他 Codex 客户端的会话。若需要在上游注销其他会话，由上游账号管理完成。

## 6. HTTP 契约

### 6.1 管理接口

AI 连接管理只要求有效的 owner Session，不要求最近 15 分钟内重新通过 Passkey 或 GitHub 认证。读取沿用普通 owner Session 检查；连接创建、变更、断开、删除、授权启动、poll、取消与主动模型刷新必须绕过 Cookie cache 校验持久 Session。API Key 的创建、修改和撤销仍要求 recent owner Session。

授权会话的读取、poll 与取消还必须匹配创建它的 Session。令牌落库前从持久状态重新确认 Session 归属、未过期、未撤销和连接版本，不能复用同一请求先前的身份检查结果。若 Session 在授权过程中失效，拒绝保存凭证并返回 `invalid-credential`（401）；前端按正常登录失效处理。

| 方法与路径                                   | 作用                                   |
| -------------------------------------------- | -------------------------------------- |
| GET /api/ai/providers                        | 已实现的提供方类型、认证方式与协议能力 |
| GET、POST /api/ai/connections                | 查询、新建连接                         |
| PATCH、DELETE /api/ai/connections/{id}       | 修改名称或启用状态、删除连接           |
| POST /api/ai/connections/{id}/disconnect     | 清空凭证并断开                         |
| POST /api/ai/connections/{id}/authorizations | 启动上游设备授权                       |
| GET /api/ai/authorizations/{id}              | 查询授权状态，不触发上游请求           |
| POST /api/ai/authorizations/{id}/poll        | 执行一次受限轮询及必要兑换             |
| DELETE /api/ai/authorizations/{id}           | 取消本地授权会话                       |
| POST /api/ai/connections/{id}/models/refresh | 主动更新模型目录                       |
| GET /api/ai/invocations                      | 分页查询调用元数据                     |

连接查询包含模型快照及其更新时间，凭证与授权内部字段不进入该接口。

API Key 沿用 `/api/auth/api-key/*` 路径，由应用网关完成 owner/recent-auth、Origin、字段及资源归属校验，再调用插件服务端 API。新增字段的契约由本服务维护，不把含 `purpose`、`modelIds` 或客户端 `permissions` 的原始 body 转交插件原生 HTTP handler。

创建及权限更新使用不携带浏览器 headers/request 的服务端调用，`userId` 只能取已验证的 owner，不能来自 HTTP body；当前插件即使通过服务端 API 调用，只要传入 headers 仍会拒绝 server-only permissions。其他读取和删除按插件要求保留 Session 校验，应用守卫产生的 Cookie 继续完整透传。

| 方法与路径                                        | 应用侧契约                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| POST /api/auth/api-key/create                     | 保留 name、expiresIn，增加 purpose、modelIds；purpose 省略或为 status 时选 default 档，为 ai 时选 ai 档 |
| GET /api/auth/api-key/list、/api/auth/api-key/get | query 中接受 configId；get 同时携带 keyId，只返回指定档内的 owner 凭证                                  |
| POST /api/auth/api-key/update                     | body 携带 keyId、configId；default 档仍只允许改 name，ai 档可改 name、modelIds                          |
| POST /api/auth/api-key/delete                     | body 携带 keyId、configId，只删除指定档内的 owner 凭证                                                  |

`purpose` 只是创建请求的用途选择器，映射到插件已有的 `configId`，不新增数据库列或 metadata 副本。创建请求不另接受 `configId`；其他入口仅接受 `default`、`ai`，缺省由网关显式补成 `default`，未知值拒绝，不依赖插件回退。Key 创建后不能切换配置档。原有调用省略新增字段时保持原行为，原始 `permissions` 等服务端字段仍禁止通过 HTTP 提交。

AI 创建必须携带非空、无重复的 `modelIds`，服务端只接受当前目录中的有效选择，并构造 §4.3 的权限映射。更新省略 `modelIds` 时保留原权限，提供时整体替换模型许可，空数组表示撤销全部模型许可；default 档拒绝该字段。前端按用途分档查询，所有读取、改名、权限更新和删除都显式携带该档 `configId`，不跨档汇总后再使用默认档操作。

`GET /api/ai/invocations` 使用排他的 `(startedAt DESC, requestId DESC)` cursor，默认 50 条、上限 100 条，cursor 绑定查询条件；读取侧始终过滤到最近 30 天，不受物理清理积压影响。

管理等待预算与推理预算分别执行：只读 GET 沿用服务端 5 秒、SPA 10 秒；不访问上游的管理 mutation 沿用现行持久操作规则和 SPA 30 秒。授权启动、poll、模型刷新采用从请求到达起 30 秒的阶段调度预算，SPA 使用 35 秒；其中所有上游 HTTP 合计最多 20 秒，单次最多 10 秒，包含响应体、授权兑换、JWKS 获取及必要的凭证刷新。开始下一阶段前检查剩余预算，到期取消可取消的出站工作。已发出的 D1 mutation 仍同步等候结果，不用整个 handler 的 Promise.race 声称写入已取消；客户端超时后先读取持久状态，不自动重放授权兑换、创建或刷新。

### 6.2 调用接口

| 方法与路径             | 权限                     | 结果                                |
| ---------------------- | ------------------------ | ----------------------------------- |
| GET /api/ai/models     | ai:models:read           | 当前 Key 有权访问的模型、协议与能力 |
| POST /api/ai/responses | ai:invoke + 指定模型许可 | Responses 子集的 SSE 或 JSON        |

请求字段首版允许：model、input、instructions、stream、store、reasoning、text、tools、tool_choice、parallel_tool_calls、include。每个字段继续按模型能力与连接器支持范围校验，未知或不支持字段返回 422，不静默删除。

PR 4（2026-09-19）实现时落定的精确子集边界（校验器 `src/worker/ai/responses-request.ts`，OpenAPI 随 PR 7 注册）：instructions 仅接受字符串；input_image 仅接受 data URL（PNG/JPEG/WebP、base64 须良构）且不接受 `detail`；消息角色为 system/developer/user/assistant；input 项为 message、function_call、function_call_output 与 reasoning 回放项（id/summary/encrypted_content 透传）；reasoning 仅接受 effort；text.format 仅接受 json_schema（name/schema/strict）；tool_choice 仅接受 auto、none 与指定函数对象；include 仅接受 reasoning.encrypted_content；SDK 常见附带字段（temperature、max_output_tokens、metadata、top_p 等）与其他未知字段一律 422。

- input 支持文本、多轮消息、内联 PNG/JPEG/WebP 图片，以及已声明函数工具的输入输出；图片计入总请求大小。
- 图片不由 eruoo 落盘，首版不增加远程图片抓取或文件上传 API。
- stream 默认为 true；false 时由服务端有界读取上游事件并返回终态 response 对象。
- store 只接受 false；调用者每次携带需要的上下文。
- store=false 表达本接口的会话保存方式，不代表上游所有日志或处理过程都采用零保留。
- reasoning.effort 只接受模型目录声明的值，不设置跨模型的统一默认推理强度。
- text 的结构化输出设置只在该模型完成对应验证后开放。
- tools 首版只接受函数工具定义，不开启上游托管工具。
- include 首版只接受连接器确认支持的 reasoning.encrypted_content，用于调用者携带不透明的多轮状态；服务不解密、不持久化其内容。
- conversation、previous_response_id、background、文件引用和托管工具不在首版契约内。
- Codex 连接器不能承诺执行 max_output_tokens：现有参考实现移除了相关输出上限设置。因此首版拒绝该参数，并在模型能力中明确输出 token 上限不可用。

上游请求地址、认证头、账号头和协议版本由连接器生成。调用者只能选择公开模型 ID 和受支持输入，不能覆盖目标地址或授权。

JSON 完成以明确的 `response.completed` 终态为准。`response.incomplete` 返回 HTTP 200 的 response 对象，但保留 `status=incomplete` 与原因，调用记录也记为 incomplete；`response.failed`、缺少终态或断流属于失败，不能把已有部分文本包装成完整结果。

两种响应模式都按输出索引有界收集 `response.output_item.done`。上游终态的 output 缺失或为空时，用这些已完成项补全；终态已有输出时保留其值，只按明确对应的 item ID、call ID 或输出索引补齐缺项，无法唯一关联则报协议错误。文本、函数调用及不透明 reasoning 项都适用，不用尚未完成的 delta 伪造输出项。JSON 返回及 SSE 终态使用同一补全结果，并对补全后的大小再次执行 §7 上限。

### 6.3 错误、取消和重试

握手前的错误沿用本项目 Problem + x-request-id。调用凭证无效、模型未授权、请求不支持、本地速率限制和超时使用既有 Problem；AI 新增类型在同一个 problem 注册表维护，`type` 沿用 `https://auth.eruoo.me/problems/` 前缀：

| Status | slug                        | 语义与重试提示                                                                               |
| ------ | --------------------------- | -------------------------------------------------------------------------------------------- |
| 429    | ai-concurrency-exceeded     | 全局或单 Key 名额已满，立即拒绝，不排队；Retry-After 为 1 秒，仅提示再次检查时机             |
| 503    | ai-credential-busy          | 其他请求持有刷新 claim，且当前令牌不够有效；Retry-After 为 claim 剩余秒数向上取整，最少 1 秒 |
| 503    | ai-reauthorization-required | 上游授权已失效或结果不明，需要 owner 重新授权，不提示自动重试                                |
| 429    | ai-upstream-quota-exceeded  | 上游受控错误明确表示额度不足；仅转发已校验的 Retry-After                                     |
| 503    | ai-upstream-unavailable     | 上游暂时不可用，或明确未消费 refresh token 的刷新失败                                        |
| 502    | ai-upstream-protocol-error  | 无法解析的事件、输出冲突、缺少终态或非正常断流                                               |

单纯的上游 429 不能证明额度已耗尽；缺少明确错误分类时返回上游不可用。凭证忙记入已准入调用的元数据；未取得名额的 429 不写入 ai_invocations 或拒绝审计，以免放大 D1 写入，可输出仅含 requestId 与受控类型的运维事件，两类结果分别统计。

上游 401 不能被转换成“eruoo owner 已退出登录”。上游错误正文不直接输出，错误内容和头字段经 allowlist 处理。

SSE 使用 `text/event-stream`，事件以空行分隔。正常事件的 `event` 与 JSON `data.type` 使用受支持的 Responses 事件名；完整终态为 `response.completed`，不完整终态为 `response.incomplete`。上游 `response.failed`、`error` 和本地失败统一转换为本接口的 `event: error`，`data` 直接承载脱敏 Problem，不增加另一层 error 包装。例如：

```text
event: error
data: {"type":"https://auth.eruoo.me/problems/ai-upstream-unavailable","title":"AI upstream unavailable","status":503,"detail":"The upstream service is unavailable.","requestId":"550e8400-e29b-41d4-a716-446655440000"}

```

连接可写时恰好发送一个终态并关闭流，已经传出的片段不能撤回。客户端连接已断开时无法保证送达 error；调用者必须将没有终态的结束视为失败。Problem 的 status 表达错误分类，不改变已经发送的 HTTP 200。

下游 SSE 建立后，距最近一次下游写入满 15 秒且流可写时，发送注释心跳 `: keepalive\n\n`，两次心跳至少间隔 15 秒；遇到背压不积攒心跳，终态后停止。心跳计入传输字节上限，不重置上游无数据超时，也不延长总 deadline。JSON 模式不向下游发送心跳。

整个调用共享绝对 deadline，覆盖请求体、认证、准入、凭证读取、上游连接和响应读取。调用上游前再次检查取消与剩余预算，避免本地已超时后启动新推理。

推理 fetch 与流读取连接到 AbortSignal；启用 Worker 的 enable_request_signal。取消推理不等于上游已经停止计量。

仅在收到明确的上游 HTTP 401、且尚未进入事件流时，允许刷新一次并最多重发一次。超时、断流、429 和 5xx 不自动重放生成请求，也不自动更换账号或模型。

刷新和授权兑换属于凭证状态变更，必须同步完成落库；不能交给 waitUntil。客户端离开期间若仍能完成持久化则提交，若执行被终止则由不确定状态处理，不据此继续推理。

## 7. 准入和运行限制

以下是首版拟定的保守运行初值，不是平台额度或实测容量；在目标 Worker 验收时验证。集中维护于 AI 模块策略，不拆成多组环境变量。

| 项目                      | 首版初值                                                             |
| ------------------------- | -------------------------------------------------------------------- |
| AI 粗入口限流             | 独立 AI_RATE_LIMITER，按 operation 与来源 IP，60 次 / 60 秒          |
| AI Key 凭证限流           | 60 次 / 60 秒，与 status 配置档独立                                  |
| 同时在途推理              | 全服务最多 2 个；单 Key 最多 1 个                                    |
| 请求体读取                | 仅 POST /api/ai/responses 最多 8 MiB、最多 15 秒；其他入口仍为 1 MiB |
| 调用者认证和准入          | 最多 5 秒，包含入口限流、Key 验证和 reservation，不含上游凭证阶段    |
| 上游凭证读取与必要刷新    | 每次进入该阶段最多 15 秒，其中刷新网络最多 10 秒；含在总 deadline 内 |
| 推理总 deadline           | 从请求到达起最多 300 秒                                              |
| 上游首次响应 / 无数据间隔 | 各最多 90 秒，始终受总 deadline 约束                                 |
| JSON 终态或单个 SSE 事件  | 最多 4 MiB                                                           |
| SSE 累计读取与传输        | 两种模式读取的上游 SSE、对外 SSE 各最多 8 MiB，包括协议帧和心跳      |
| 在途 reservation          | 请求 deadline 后额外保留 30 秒，以处理终态写入                       |
| 调用元数据查询 / 清理     | 查询保留 30 天，复用每日有界清理                                     |

准入通过 D1 单条条件写入同时检查在途总量和 Key 限制，不能先查询计数再无条件插入；条件不满足时按 §6.3 立即返回，不在 Worker 内等待名额。取得名额后才完整读取大请求体。未经有效凭证验证的请求不能占用长期推理名额；原始请求流在认证完成前只等待，不提前解析大 JSON。8 MiB 是精确推理路由对现行 1 MiB 通用规则的例外，不能全局调高 body 上限。

各阶段预算受从请求到达起的总 deadline 截断，不在切换阶段、401 恢复或重试时重置总时钟。认证和准入等待超时不表示底层 D1 写入已取消；迟到结果不能继续读取 body、刷新凭证或启动推理，迟到的 reservation 由终态处理或 lease 过期释放。已开始的上游凭证变更仍按 §6.3 同步处理落库与不确定状态，不能因阶段超时转入后台，也不据此继续推理。

这里的在途名额约束 eruoo 管理的请求生命周期。上游接受后是否继续运行取决于提供方，不能将本地取消或 lease 过期宣称为上游执行终止。

Cloudflare Rate Limiting binding 用于粗入口保护；D1 用于需要全局协调的凭证与在途状态。令牌用量按上游实际返回记录，缺失就是未知。Codex 订阅额度不换算成虚构的零成本或精确单次费用，也不把字节上限当成 token 预算。

速率阈值不代表可接受同样数量的并发请求。若每次推理都持续 300 秒，两个名额在理想稳态下约每 5 分钟完成 2 次调用；实际吞吐还取决于上传、刷新、终态写入及失败恢复，在 staging 记录占满时的拒绝与恢复行为。

元数据记录：requestId、keyId、连接 ID、模型 ID、起止时间、终态、受控错误代码、上游 requestId 和实际返回的 usage。默认不保存输入、输出、图片、令牌或完整上游错误。

安全审计沿用 operations.md §3 的先提交后记录、字段 allowlist 和失败处理。新增连接创建、更新、断开、删除及设备授权启动、完成、取消事件；Key 创建、权限更新和撤销复用既有事件。metadata 只包含连接 ID、提供方类型、configId、权限变更数量及受控结果，不记录设备码、账号令牌或输入输出；poll 未完成和普通列表读取不逐次写审计，429 不写拒绝审计。

## 8. 存储与恢复

增加四张应用表：

| 表                        | 数据与一致性边界                                     |
| ------------------------- | ---------------------------------------------------- |
| ai_connections            | 连接、加密凭证、版本、刷新 claim、授权状态           |
| ai_authorization_sessions | 限时设备授权、加密临时数据、Session 绑定、poll claim |
| ai_models                 | 连接下模型快照、能力和发现时间                       |
| ai_invocations            | 调用准入、deadline、终态与元数据                     |

API Key 和权限继续由现有插件表维护。模型记录按连接关联；调用历史保存标识快照，删除连接或 Key 不应连带删除历史。授权成功、刷新保存、断开和删除均通过版本条件防止迟到写入。

开始调用前，准入写入必须成功。调用终态写入失败不触发模型重放，输出脱敏运维事件；lease 到期后将仍无终态的记录解释为 unknown，不能算成功或推断实际 token 为零。

沿用现有 D1 全量备份和私有 R2。加密后的上游凭证随数据库进入备份，AI_CREDENTIAL_KEYS 不进入备份。

恢复规划器继续要求快照 schema 与其已应用的仓库 migration 前缀精确匹配，不通过放宽 schema 校验接纳 AI 表。需要扩展的是清理 SQL 的表级 DELETE、列级 UPDATE 授权和清理后断言：保留连接名称等配置，清空上游凭证、刷新 claim 和待处理授权，推进连接版本并进入重新授权状态；清除在途 reservation，将未完成调用标为 unknown，保留可识别的历史元数据。模型快照仅作旧配置参考，重新授权后须成功发现模型才恢复可用状态。不能让旧快照复活已经断开的上游登录。

清理发生在原始快照 schema 上，AI 清理语句及对应断言必须按已验证的 migration 前缀和实际表集生成。只有 0001 的旧快照不执行不存在的 AI 表语句，按现行恢复顺序清理后再补 migration；包含 AI 表的快照须通过上述清理断言。

30 天调用保留期集中维护于 AI 策略，供查询过滤与清理任务共用；在现有每日 Cron 增加 AI 清理 job，处理到期授权会话及过期调用元数据。沿用每类最多 10 批、每批最多 500 行的边界，积压记录 backlog 并留待后续调度，物理保留可能超过 30 天，不靠提高 Cron 频率隐性补偿。

## 9. 管理界面

新增一个 AI 管理入口，包含三个视图：

1. 连接：连接类型、名称、脱敏账号、状态、连接/重新授权、停用/断开。
2. 模型：上游模型 ID、可用协议、已确认能力、最近发现时间。
3. 调用：近期请求、终态、耗时、实际返回的用量与受控错误。

API Key 仍在现有凭证管理入口创建和撤销，按 status、AI 用途分档，增加模型许可选择与更新。配置档映射和请求参数只在 §6.1 定义；切换用途后重新读取对应列表，不能沿用另一档的旧结果。界面能明确区分“连接已授权”“模型发现失败”“额度暂不可用”和“需要重新授权”。

不在产品界面暴露内部 lease、密文格式、OAuth client ID、上游认证头等实现细节。

## 10. 以后如何扩展

- 新增同协议模型：更新模型目录与能力描述，按需给现有 Key 增加模型许可。
- 新增 API Key 上游：增加对应 ProviderDefinition 和凭证接入方式，复用权限、准入、调用记录和管理界面。
- 新增厂商协议：增加该协议的 HTTP 校验器和提供方连接器，共用核心链路。
- 新增 embedding、音频或图片生成：作为独立 operation 和协议能力接入，不塞进首版 responses 的输入输出结构。
- 需要给客户端统一消息结构时，在明确的能力子集上采用成熟 SDK 适配；不要求核心预先实现所有协议的双向转换。
- 需要拆分部署时，保留公开接口与身份边界，迁移 AI 运行模块及相应状态访问；无需改变业务应用的提示词或存储。

上述是扩展规则，不是在首版创建空实现、预置所有提供方或发布尚不可用的接口。

## 11. 与现有规则的关系

本稿仍是待实施草案，现行规格继续描述已开放能力。采纳并实施本稿时，在同一切片同步下列差异；未列出的身份、凭证和发布规则继续有效。

| 现行规则与权威位置                                                                            | 本稿拟议的局部扩展                                                                               | 实施时同步                                                                    |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| architecture.md §2 只有 GET /api/status 业务 operation                                        | 增加 §6 的 AI 调用及管理路由                                                                     | architecture、protocol-contract 路由清单、acceptance 能力开放表及生成 OpenAPI |
| protocol-contract.md §1.1 通用 body 最大 1 MiB                                                | 仅 POST /api/ai/responses 使用 §7 的 8 MiB 上限及认证后读 body 顺序，其他路由不变                | 协议规格、精确路由的 body 处理与边界测试                                      |
| architecture.md §4.4、§4.5 仅 status:read、Key 更新只开放名称；acceptance.md 保留对应回归断言 | default 档保留原规则；新增 ai 档的固定 operation 与可更新模型许可，HTTP 仍不接受原始 permissions | 架构和协议规格、网关、Key 面板及按 configId 区分的回归断言                    |
| architecture.md §5 的读预算和 SPA 10/30 秒 deadline                                           | AI 上游管理操作使用 §6.1 的独立预算，推理使用 §7；持久变更仍同步提交                             | architecture、前端请求适配器及超时验收                                        |
| protocol-contract.md §4.3 的 OIDC 私钥加密规则                                                | 该规则继续约束 OIDC 私钥；AI 上游凭证按 §5.2 由 AI 模块消费独立 Secret                           | operations 配置清单与凭证轮换说明                                             |
| operations.md 的审计、清理、恢复和发布配置                                                    | 增加 §7、§8 的 AI 数据规则及 §12 的部署配置                                                      | operations、恢复规划器、发布校验与 acceptance 专项                            |

保持现有单一 owner、单凭证载体、同源管理、请求级 Auth 生命周期和增量迁移纪律。AI 连接管理的 Session 策略以 §6.1 为准，API Key 和身份凭证管理继续遵循现有 recent-auth 规则。AI 不使用 Better Auth 登录 account 表存放业务上游账号，不使用模块级在途 Promise，不将身份模块改成 AI 模块的依赖方。

## 12. 实施范围与验收

这是一个涉及后端、管理界面、迁移、发布恢复和验证的完整功能切片。首版一次交付连接管理、设备授权、凭证刷新、模型目录、调用入口、权限、恢复规则与验证，不以半成品授权模块作为已完成服务。下表描述变更落点，不作为文件数量或工期估算。

主要文件范围：

| 范围                                                                 | 变更                                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| src/worker/ai/                                                       | 新增连接器注册、Codex 连接器、授权、凭证、模型和调用处理                                    |
| src/shared/ai.ts                                                     | 自有管理与调用契约、受控状态和能力描述                                                      |
| src/worker/routes/、http/、auth.ts                                   | 路由注册、认证复用、AI Key 档、Problem 类型                                                 |
| src/worker/index.ts、auth/routes.ts、audit.ts、src/shared/api-key.ts | Key 管理网关字段白名单、服务端插件调用、配置档及审计映射                                    |
| src/worker/db/schema.ts                                              | 四张 AI 应用表                                                                              |
| migrations/0002_ai_service.sql                                       | 当前 0001 基线后的增量迁移，不改写既有迁移                                                  |
| src/client/features/ai/、security/                                   | AI 管理视图和现有 Key 管理扩展                                                              |
| src/worker/schedules.ts、scripts/lib/restore-database.ts             | 有界清理和恢复时清除上游授权                                                                |
| wrangler.jsonc、worker-configuration.d.ts                            | Secret、AI_RATE_LIMITER、enable_request_signal；重跑 pnpm run types:generate 并检查生成差异 |
| scripts/build-release.ts、scripts/deploy-release.ts 及其测试         | 限流器枚举、跨环境 namespace 隔离、Secret 清单、发布读回与测试夹具                          |
| docs/openapi.json、OpenAPI 生成与检查                                | 由新增及扩展契约生成快照，不能手写不存在的接口或仅修改生成文件                              |
| docs/specs/ 与相关测试                                               | 契约、运维、恢复和行为验收                                                                  |

新增部署配置为 `AI_CREDENTIAL_KEYS` Secret、`AI_RATE_LIMITER` binding 和 `enable_request_signal` compatibility flag；新增独立部署单元、Cron、队列、运行时语言和第三方 SDK 均为 0。固定提供方定义与限制采用代码常量；纯 HTTP、Web Crypto 和现有 jose 足以承载首版协议与签名校验。

发布工具当前固定检查 staging/production 共 4 个独立 limiter namespace、两类 limiter 和 5 个必需 Secret。增加 AI 后须同步为三类 limiter、两个环境共 6 个互不重复的 namespace，并扩展 Secret 清单及本地/远端配置核对；不能只改 Wrangler 而保留旧数量断言。AI Secret 的发布校验与运行时故障隔离分别验证，缺失 Secret 不能让已部署服务的身份入口依赖 AI 初始化。

### 必须通过的行为验证

- 正常设备授权、拒绝、取消、过期、多标签页、旧 Session、错误账号和迟到兑换。
- 令牌到期、并发刷新、可证明未发出的刷新失败、明确未消费令牌的失败、5xx/超时结果不明、刷新成功但落库失败、claim 过期、invalid_grant、断开与刷新竞争。
- Key 无 AI 权限、模型不在许可集合、跨连接访问、连接删除后同 slug 重建、凭证过期、撤销、混合认证载体。
- default/ai 档分别创建、读取、改名、权限更新和删除；缺省档保持原行为，未知 configId、跨档 keyId、原始 permissions 与 default 档的权限更新均拒绝。
- 文本、图片、多轮函数工具结果、已开放的结构化输出；模型与字段不支持时拒绝。
- JSON 与 SSE 共用输出补全；终态 output 缺失/为空、已完成函数调用/文本/reasoning 项的保留、已有终态字段优先和补全后大小上限。
- SSE 终态完成、不完整终态、HTTP 200 内的失败事件、统一 error/Problem 结构、缺少终态、分块跨字符、超大帧、15 秒心跳与慢消费者；心跳不延长上游或总超时。
- 上传、调用者认证、上游凭证、首响应、流读取各阶段超时，以及管理授权启动/poll/模型刷新的独立预算；客户端断开后不启动新的推理，不把写入等待超时宣称为已取消。
- AI 推理路由的 8 MiB 边界与认证后读 body；管理和其他既有入口继续拒绝超过 1 MiB 的请求。
- 401 的最多一次恢复；429、5xx、断流不会重复调用或切换账号。
- 多 Worker 实例的全局准入、名额占满立即拒绝、凭证忙与各自 Retry-After；旧 reservation 到期、D1 异常和调用终态写入失败；读取过滤与每日清理积压边界。
- 日志与响应不泄露令牌、截图、提示词和原始上游错误。
- AI 管理动作及 Key 权限变更产生对应审计，失败审计不重放 mutation，poll 未完成和 429 不放大审计写入，字段符合 allowlist。
- AI Secret 缺失、上游挂起和并发占满时，现有登录、Passkey、status、OAuth 与备份仍符合既有验收。
- 仅含 0001 及已含 AI migration 两类快照的 schema 前缀校验、隔离恢复和凭证清理；恢复后重新授权与模型发现前不可用，代码回退不复活已断开的连接。
- 新增 binding/Secret 的构建和发布校验、六个远端 limiter namespace 隔离、生成环境类型与 OpenAPI 漂移；现有发布失败和人工重跑规则继续成立。

实现完成后执行仓库现有 pnpm run check；只有涉及真实 Worker 的部分才增加对应 staging 专项。实际授权、刷新、模型发现与生成必须在目标 staging 环境验收，不能用本机访问或合成测试替代。容量专项记录代表性请求大小、调用时长、完成数、并发拒绝数、CPU/内存与恢复时间，按实际需求判断 §7 初值是否足够。

发布使用现有受审产物与手动发布流程，增量应用 migration。代码回退保留新增表和当前有效加密密钥；若需停止 AI，停用连接即可。回退代码不回退上游已轮换的凭证或已发生的调用。

所需账号与凭证：

- 当前 eruoo owner 身份：管理连接和签发调用权限。
- 有 Codex 权限且允许设备登录的 ChatGPT 账号/工作区：完成上游授权。
- AI_CREDENTIAL_KEYS：独立的服务端加密密钥。
- 现有 Cloudflare 发布权限：仅在实施和发布时使用。
- 各调用者的 eruoo AI Key：由 owner 创建，实际调用时使用。

不需要为本次设计读取现有 Codex auth.json 或提取当前桌面登录令牌。

## 13. 脆弱前提与取舍

本方案最脆弱的前提是：目标 ChatGPT 账号和目标 Cloudflare Worker 可以使用当前 Codex 设备登录及推理协议。

2026-09-19 实测（staging，实施记录 §4.21）：设备登录一侧成立（真实设备授权完成，账号链路经 owner 本机 codex 复核正常）；Worker 侧推理协议当前不成立——模型目录请求返回 403，具体原因尚未确认（出口或边缘防护是待验证假说），模型目录无法建立，真实推理链路未验收。该连接器当前不可用、上线门槛未通过：不伪造第一方身份、不自动改用付费 API、不新建中继组件（owner 决策维持现状并记录）；先确认阻断原因再决定处理方案，任何出口通道或其他方案的变更都需 owner 另行决策与授权后重新验收。

官方文档提供 Codex 登录与 app-server 集成流程，但不能据此推导 Codex 后端是为第三方通用网关承诺稳定的 OpenAI Platform API。首版连接器属于依赖上游版本的兼容接入，必须固定参考版本并维护契约测试。

严格字段子集要求调用方按本服务契约构造请求。使用通用 SDK 时，需关闭默认附带的未支持字段，例如 `temperature`、`max_output_tokens`、`metadata`，并适配本服务的认证头与 SSE error/Problem；不能承诺只替换 base URL 就完整兼容。服务端通过 422 显式拒绝不支持的字段，保留调用语义的可见性。

若目标环境拒绝授权、要求当前集成不具备的客户端资格，或模型接口发生不兼容变化，连接器返回不可用并要求处理；不自动改用付费 API、不伪造其他调用者身份，也不影响其他提供方或 eruoo 登录。这是该连接器的上线门槛，不是新增“先上线再调查”的阶段。

已比较的接入方式：

- 推荐 Worker 原生 HTTP 连接器，适合当前运行环境和纯模型调用，代价是自行维护 Codex 凭证状态及兼容测试。
- 官方 app-server 适合把 Codex Agent 深度嵌入产品，可接管 OAuth；但本仓库不运行常驻 Codex 进程，其线程、工具执行及进程模型也超出这次 AI 接入职责，因此首版不引入它。
- Cloudflare AI Gateway 可作为未来提供方通道的一部分，但已核实的公开原生提供方文档不能证明它代管本次 Codex OAuth 刷新，首版不以它为必要依赖。

## 14. 核查依据

初稿核查日期：2026-09-15；2026-09-18 补充评审与仓库静态核对。以下区分公开依据、参考实现和实际验证，不能互相替代。

### 官方说明

- [Codex Authentication](https://learn.chatgpt.com/docs/auth)：ChatGPT 订阅登录、令牌刷新与设备授权流程。
- [Codex App Server](https://learn.chatgpt.com/docs/app-server#authentication-modes)：managed ChatGPT、设备登录、外部 token 模式和 app-server 的集成定位。
- [Cloudflare AI Gateway 原生提供方](https://developers.cloudflare.com/ai-gateway/usage/providers/)：托管上游通道的现有范围。
- [Workers Request](https://developers.cloudflare.com/workers/runtime-apis/request/)：客户端断开与 request signal。
- [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)：粗入口限流不等于全局精确记账。
- [Cloudflare 挑战页识别](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)：识别边缘挑战响应的方式（响应体特征、`cf-mitigated` 响应头）；2026-09-19 的 Worker 403 未保留可判定来源层的响应证据（响应头未读取，错误正文不落日志），归因仍待确认。

### 参考实现与采用的机制

- [Codex 设备登录源码，a8964cb](https://github.com/openai/codex/blob/a8964cb1bad67bc26a826fb07d1bef99c6a3f008/codex-rs/login/src/device_code_auth.rs)：采用设备码、限时轮询和 PKCE 交换的流程边界。
- [OpenCode Codex 连接器，e03db9b](https://github.com/anomalyco/opencode/blob/e03db9bc6908f75c9334d8aa997deeaac81c0298/packages/opencode/src/plugin/openai/codex.ts)：参考账号头、刷新落库和独立连接器的组织方式；其进程内刷新 Promise 不能直接搬到多实例 Worker。
- [CLIProxyAPI Codex 流处理，7bbfeaf](https://github.com/router-for-me/CLIProxyAPI/blob/7bbfeaf8a7acf2cd5a834dcb0842539fe6aabc2b/internal/runtime/executor/codex_executor_stream.go)：参考协议转换与运行处理的分离，以及失败/缺失终态的显式识别。
- [CLIProxyAPI 输出补全测试，同一版本](https://github.com/router-for-me/CLIProxyAPI/blob/7bbfeaf8a7acf2cd5a834dcb0842539fe6aabc2b/internal/runtime/executor/codex_executor_stream_output_test.go)：参考已完成输出项与终态 output 缺失的兼容处理；合成测试不替代目标 Codex 环境实测。

### 连接器固定契约（PR 3 实施时逐项核对，2026-09-19）

以下来自固定参考源码的逐项核对，已按此实现 `src/worker/ai/codex-connector.ts`；标注"待实测"的项仍需真实设备授权/刷新验证，不能宣称已兼容：

| 项              | 固定值/行为                                                                                                                                                                                                                                                                                                                                                                                                              | 来源                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| issuer          | `https://auth.openai.com`                                                                                                                                                                                                                                                                                                                                                                                                | codex-rs `DEFAULT_ISSUER`                                                                                                                                                                                      |
| client id       | `app_EMoamEEZ73f0CkXaXp7hrann`                                                                                                                                                                                                                                                                                                                                                                                           | codex-rs `CLIENT_ID`                                                                                                                                                                                           |
| 设备验证页      | `{issuer}/codex/device`                                                                                                                                                                                                                                                                                                                                                                                                  | codex-rs                                                                                                                                                                                                       |
| usercode 请求   | POST `{issuer}/api/accounts/deviceauth/usercode`，JSON `{client_id}`；响应 `{device_auth_id, user_code, interval(字符串)}`                                                                                                                                                                                                                                                                                               | codex-rs / OpenCode                                                                                                                                                                                            |
| 轮询间隔        | interval 按字符串解析；无法解析默认 5 秒；可解析数值钳制到 ≥1 秒                                                                                                                                                                                                                                                                                                                                                         | 设计 §5.1                                                                                                                                                                                                      |
| 设备令牌轮询    | POST `{issuer}/api/accounts/deviceauth/token`，JSON `{device_auth_id, user_code}`；2xx 返回 `{authorization_code, code_challenge, code_verifier}`（code_verifier 由上游下发）；403/404=未决；其他 HTTP=终局拒绝                                                                                                                                                                                                          | codex-rs                                                                                                                                                                                                       |
| 授权码交换      | POST `{issuer}/oauth/token`，form-urlencoded `grant_type=authorization_code`，`redirect_uri={issuer}/deviceauth/callback`；响应三令牌必填                                                                                                                                                                                                                                                                                | codex-rs                                                                                                                                                                                                       |
| 刷新            | POST `{issuer}/oauth/token`，JSON `{client_id, grant_type:"refresh_token", refresh_token}`；响应三字段均可选，按合并语义处理；400 `invalid_grant`（含 legacy `refresh_token_expired/reused/invalidated` 码与嵌套形态）与 401 为确定终局；其余 400 码参考实现按 Transient 重试，本服务不重放、按结果不明处理                                                                                                              | codex-rs manager.rs                                                                                                                                                                                            |
| 模型目录        | GET `https://chatgpt.com/backend-api/codex/models?client_version=…`，Bearer + `chatgpt-account-id`；响应 `{models:[{slug, display_name, supported_reasoning_levels, supported_in_api, visibility, …}]}`；目录请求 401 按 codex-rs 会话语义做一次强制刷新与一次重发（PR #45，2026-09-19）                                                                                                                                 | codex-rs models 端点；**2026-09-19 实测**：Worker 侧该目录请求返回 403，原因尚未确认（见 §13）；同头型无凭证请求自本机得到 401 鉴权应答，该对照不构成请求头待遇或凭证有效的证据                                |
| Responses 调用  | POST `https://chatgpt.com/backend-api/codex/responses`，JSON 请求体；请求头 `content-type: application/json`、`accept: text/event-stream`（本服务恒以 SSE 请求上游，JSON 模式读取同一事件流）、`authorization: Bearer`、`chatgpt-account-id`（有则带）、`originator: eruoo`、`user-agent: eruoo/1`；本服务发送的请求体为调用者子集加 `model`（上游模型 ID）、`store: false`、`stream: true`、`instructions` 缺失时置空串 | CLIProxyAPI 7bbfeaf `codex_executor_stream.go`（`baseURL + "/responses"`）与 `codex_executor_request.go`（`applyCodexHeadersFromSources`：content-type/bearer/account/originator/user-agent/accept 按 stream） |
| JWKS            | `https://auth.openai.com/.well-known/jwks.json`（2026-09-19 实测返回 RS256 密钥；按次获取，不跨请求缓存）                                                                                                                                                                                                                                                                                                                | OIDC discovery 实测                                                                                                                                                                                            |
| ID token claims | `https://api.openai.com/auth.{chatgpt_user_id, chatgpt_account_id, chatgpt_plan_type}`、`email`、`exp`                                                                                                                                                                                                                                                                                                                   | codex-rs token_data.rs                                                                                                                                                                                         |
| 上游标识头      | `originator: eruoo`、`user-agent: eruoo/1`（第三方 originator 为参考模式：OpenCode 发送 `opencode`）                                                                                                                                                                                                                                                                                                                     | OpenCode；**2026-09-19 实测**：本机同头型无凭证请求得到 401 鉴权应答，仅说明该形态自本机可达；非第一方 originator 是否被区别对待、Worker 侧 403 的归因均未确认（见 §13），不能由该对照推出头型已被正常对待     |
| 访问令牌有效期  | 优先 `expires_in`，其次 access token `exp` claim（JWT），缺失时默认 3600 秒                                                                                                                                                                                                                                                                                                                                              | OpenCode `expires_in ?? 3600`；**2026-09-19 实测**：设备流首次凭证有效期约 10 天（授权完成 2026-09-19 23:31:17，凭证至 2026-09-29 23:31:17），默认 3600 秒兜底未被依赖                                         |

实施取舍（已实现、待真实授权复核）：

- ID token 验签按 RS256 + issuer + audience=固定 client id + exp 严格执行；audience 断言值为 OAuth 标准语义，**真实 id_token 的 aud 形态待实测**。
- 刷新不重验 id_token（codex-rs 同样只解析不验签）；账号绑定以授权时验签结果为准。
- 参考 classifier 将 legacy 刷新码视为任何状态下的终局；本实现仅在 400 上解析错误码，非 400 响应携带 legacy 码按结果不明处理（终局行为一致，仅 reason 标签更保守）。
- 认证交换后的响应若既无 access 也无 refresh token，按协议失败（结果不明）处理。
- 凭证包长度上限（access token ≤2048、refresh token ≤512 字符）为应用侧约束；真实令牌长度**待实测**，超限会在首次使用时报不可读并要求重新授权。
- 流内终局失败分类按 CLIProxyAPI 7bbfeaf 固定参考实现：`error` 事件的错误体位于 `error`（或顶层），`response.failed` 位于 `response.error`；`error.type=usage_limit_reached` 携带 `resets_at`/`resets_in_seconds` 判为额度不足并仅在验证通过时转发重试提示；`invalid_api_key`/`unauthorized`/`authentication_error` 判为需重新授权；限流、容量、上下文超限与其余受控错误判为上游不可用；真实错误正文一律不透出。分类码集合**待实测**确认。
- 上游对非第一方 originator/User-Agent、FedRAMP 工作区（`x-openai-internal-codex-residency`、FedRAMP 边缘）的行为未实现、未验证；首版目标账号非 FedRAMP。
- discovery 文档的 token_endpoint 为 `{issuer}/api/accounts/oauth/token`，与 codex-rs 固定使用的 `{issuer}/oauth/token` 不同；连接器按固定参考实现，不使用通用 discovery 端点。
- PR 5（2026-09-19）网络编排落定的取舍：上游恒以 SSE 请求（`stream: true`），JSON 模式由服务端读取事件流后返回终态对象；上游 200 之前的一次 HTTP 401 允许强制刷新一次并重发一次，重发仍 401 视为授权已失效并标记连接需重新授权；裸 429 与 5xx 判为上游不可用、其余非 2xx 判为协议错误（裸 429 不当作额度耗尽）；握手前超时用既有 `request-timeout`，流内静默超时（90 秒无数据）与总 deadline（300 秒）判为上游不可用并在可写连接上送达 `event: error`。真实上游 401/额度/静默行为**待实测**。

### 已有验证记录与证据边界

- 当前仓库为单 Worker、D1 和已有 API Key 管理；尚无 AI 接口和上游连接存储。
- 初稿记录本地 Codex CLI 版本为 0.154.0；未读取其凭证。本次修订不把历史版本观察当作重新实测。
- 初稿记录本机读取 OpenAI OAuth discovery 返回 200、未携带凭证请求 Codex 模型路径返回 401，但未留存完整命令及模型请求参数，仅作历史观察，不作为可复现验收或模型接口契约证据。
- 已阅读三个项目的固定源码快照。
- 截至 2026-09-18 本次修订，尚未执行真实设备授权、令牌刷新、模型发现、模型调用、Worker staging 联调或容量测试；后续进展见本节末条。
- 本次修订核对了 API Key 插件服务端字段、configId 行为、请求体默认上限、恢复清理授权和发布数量断言；只更新设计文档，不修改应用代码，不执行部署。
- PR 3（2026-09-19）按上表逐项核对固定源码并完成本地合成验证（见实施记录 §4.15）；真实授权、刷新与模型发现仍未执行。
- 2026-09-19 staging 实测（实施记录 §4.21）：真实设备授权、授权会话恢复、重新授权与取消通过；首次凭证有效期约 10 天；目录请求 401 恢复语义已实现并经独立 review 合入（PR #45；本次真实失败为 403，未触发该路径）；**模型发现与推理调用受阻——模型目录请求返回 403，具体原因尚未确认（出口或边缘防护为待验证假说）**，owner 本机 codex 正常只说明账号与凭证链路可用；该连接器当前不可用、AI 上线门槛未通过，owner 决策维持现状并记录；含 AI 数据的隔离恢复演练通过。真实推理链路（JSON/SSE 调用、在途限制、取消收尾、usage 等）、真实令牌刷新、真实流内错误分类与 `AI_CREDENTIAL_KEYS` 轮换仍未验收。

实施验收另记录连接器源码版本、Worker 发布版本与环境、脱敏后的请求方法/URL/非敏感参数、执行时间及受控结果。复现命令从环境读取测试 Key，不保存真实凭证、设备码或完整生成内容；探测路径可达与真实授权、刷新、模型能力验证分别记账。
