# 验收、消融与实施顺序

> 属于 [完整架构规格](architecture.md)，状态与其一致。本文区分已经观察到的事实与目标实现仍需通过的验收。

## 1. 历史基线与本轮证据

基线为 `e58f75866a9649d6ab40f39f99029f3b1c948c18` 的四个运行时文件及两个测试文件。最初的消融实验使用隔离的源码/依赖副本，补充复核环境见 §1.1；未修改业务工作树，未部署。D1 故障由代理控制，仅 GitHub OAuth 行为测试使用固定的外部 HTTP stub。

| 实验                | 已观察结果                                                                                                                                             | 可以得出的结论                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 原检查集            | `pnpm run check` 成功；10 个测试通过                                                                                                                   | 工具链正常，不能据此证明完整认证策略有效                                  |
| 11 个单项消融       | 10 个仍通过原测试；只有清空 disabledPaths 被原集检测                                                                                                   | 原集对策略接线和运行语义的检测力不足；这不是生产漏洞数量                  |
| 移除整个 owner hook | 原 10 测试仍通过；真实 OAuth handler 探针显示非 owner 可获 Session                                                                                     | 必须测试实际登录准入，不能只测 helper                                     |
| Cookie cache        | 合成有效 Session 首次 1 次 D1 读，JWE 命中 0 次，成功复核见 §1.1；关闭缓存的历史变体 warm 仍读 D1                                                      | 原生短缓存有明确 I/O 收益；不以失败的 cache-observed.log 支持缓存命中结论 |
| 缓存撤销窗口        | 删除持久 Session；模拟 31 秒后，30 秒配置拒绝，300 秒配置仍返回用户                                                                                    | 必须测过期后的权威读取，不能只检查配置值                                  |
| 固定 Session        | 两天前创建的 Session 在固定策略下不延长，开启 sliding 后延长                                                                                           | 可用持久 expiresAt 行为验证生命周期                                       |
| 读超时              | D1 all 延迟 6.2 秒，基线约 5,003ms 返回 504；放大 timeout 后迟到 200                                                                                   | timeout 保证有限等待，不证明取消 D1                                       |
| 请求间放大          | 只延迟首个 D1 all 11.2 秒：共享 Auth 首次和随后请求都 504，第二次约 5,002ms，首个未结束时仅 1 次 D1 调用；每请求 Auth 后第二次 200/52ms，出现 2 次调用 | 已复现应用侧连接队列放大；52ms 含探针固定 50ms 观察等待，不是线上 TTFB    |
| 未知 Auth path      | 同一路径 105 次为 100×404 + 5×429；105 个不同路径全 404 且新增 105 个 rateLimit 行                                                                     | 先调用库再判 404 会产生可由路径变化绕过的 D1 写放大                       |
| 错误落地页          | 阻塞 D1 时 get-session 已 504，`/api/auth/error` 在 5.25 秒仍等；释放后返回                                                                            | 按路径前缀猜“安全读”遗漏了错误页                                          |
| 默认 dev            | 默认本地环境缺少 DB/Origin；合成 secret 下 signin 生成 `undefined/api/auth/callback/github`；指定 staging 环境后绑定正常                               | `/health` 或无 Cookie get-session 200 不能证明开发配置正确                |

没有证明“永久死锁”、D1 云服务具体根因或线上故障频率；共享队列结论限于相同 adapter 的 D1 路径，不影响当时的有效 JWE 命中路径。生产 schema 本轮只对照保存的基线，未读取当日生产数据库。

原始实验目录在本机临时空间，可能被清理：`/var/folders/4s/gltp69rs7tzgs6lp0mb4kbtc0000gn/T/eruoo-ablation-6bul8g9t-evidence`（matrix、sensors、connection 日志）；安全探针 `/tmp/eruoo-security-review.UQ3107`。其中 `cache-observed.log` 是未下发缓存 Cookie 的失败运行，记录 `coldQueries: 1, warmQueries: 1`，不能支持上表的缓存命中结论；该项以如下独立复核为准。错误落地页原先漏引的证据也在下节补齐。后续实现须把相关行为测试接入仓库；这些临时路径不是长期构建依赖。

### 1.1 证据校正与复核（2026-09-09）

Cookie cache 在 `/tmp/cache-probe-review` 复核。执行前逐字比较了四个运行时文件、`vitest.config.ts`、migration 与测试 migration setup，均与当前仓库基线一致；依赖通过指向本仓库 node_modules 的符号链接解析，未重新安装。环境为 Better Auth 1.7.2、Vitest 4.1.11、workerd + 本地 D1。采用配置中的合成凭证与既有 JWE 30 秒策略，没有真实 provider 请求，也没有安装新插件。

探针为该目录的 `tests/worker/behavior-probe.test.ts`，SHA-256 为 `038d253ce80eaf0fd4bb5607bb047eada1e7a834518b57fd22b5f6e48c57e6b6`。只选择缓存命中测试；在该目录执行：

```sh
node /Users/caoyujie/codes/eruoo-server/node_modules/vitest/vitest.mjs run \
  --config vitest.config.ts tests/worker/behavior-probe.test.ts \
  -t 'returns authenticated data with one D1 read, then JWE cache avoids D1' \
  --reporter=verbose --silent=false --disableConsoleIntercept \
  > cache-recheck-20260909.log 2>&1
```

成功记录为 `/tmp/cache-probe-review/cache-recheck-20260909.log`，18:30 Asia/Shanghai 的执行退出码为 0。关键原始输出摘录：

```text
SENSOR cache {"coldQueries":1,"warmQueries":0}
 Test Files  1 passed (1)
      Tests  1 passed | 4 skipped (5)
```

探针同时断言两次响应属于同一合成用户、下发 `eruoo.session_data`、Max-Age 为 30、JWE 有五段，且第二次查询计数不增加。计数不包含准备夹具的 D1 写入。四个未选中的测试保持跳过；本次结果不证明完整插件组合、撤销窗口或全套消融重新通过。

错误落地页证据来自 `/var/folders/4s/gltp69rs7tzgs6lp0mb4kbtc0000gn/T/eruoo-assumption-review-0q65yhm0/tests/worker/` 下的 `adversarial-assumptions.test.ts` 及 `__snapshots__/adversarial-assumptions.test.ts.snap`。本轮核对的是已保存的测试与快照，没有重跑该探针；不能把漏引目录记作没有留证。快照记录：

| 路径                                        | 5,250ms 时                                                | 释放 D1 后 |
| ------------------------------------------- | --------------------------------------------------------- | ---------- |
| GET `/api/auth/get-session`                 | 504                                                       | 504        |
| GET `/api/auth/error?error=state_not_found` | 探针状态 0，表示尚未返回 HTTP 响应；等待 rateLimit SELECT | 200        |

以上成功摘要和快照含义保留在本文；临时原件被清理后，后续验证须重建行为探针并留存新的执行记录，不能把本文摘要当成新版本已经复测的证据。

### 1.2 滑动续期验证（2026-09-09）

上述固定 Session 与消融结果描述的是旧代码基线，不再用“禁用续期”作为目标保障。新推荐在隔离副本 `/var/folders/4s/gltp69rs7tzgs6lp0mb4kbtc0000gn/T/eruoo-sliding-spec-w6vp6cwe` 中验证：仅将认证配置改为 `disableSessionRefresh=false`、`updateAge=86400`，保留 `expiresIn=2592000`、JWE 30 秒及真实 workerd/本地 D1。未修改仓库运行时代码，也没有加入新插件。

该目录的 `tests/worker/sliding-spec.test.ts` 经 Vitest 执行，输出保留为 `sliding-spec.log`；2026-09-09 19:20 Asia/Shanghai 运行退出码 0，3 个测试通过：

```text
SLIDING_RENEWAL {"extended":true,"reauthUnchanged":true,"coldQueries":2,"warmQueries":0}
SLIDING_THROTTLE {"unchanged":true,"queries":1}
SLIDING_EXPIRED {"renewed":false,"anonymous":true}
Test Files  1 passed (1)
Tests  3 passed (3)
```

达到续期间隔时，持久 expiresAt 延长至当前时间后 30 天，reauthenticatedAt 不变，Session Cookie 与 JWE 正常下发；续期请求观测到读取和更新共 2 次 D1 调用，紧随的 JWE 命中为 0。24 小时间隔内的权威读取仅 1 次查询、到期时间不变；过期会话返回 null。这些结果验证核心库机制，完整插件、并发撤销与续期超时仍由 A2/A3/A4/A6 验收。

## 2. 行为验收矩阵

以下是**目标实现的必过测试**，并非本轮已经通过。默认在 workerd + 本地 D1 执行，真实第三方交互另列。测试保留实际被验证的库与路由，只替换外部依赖/故障点。

| ID           | 场景与输入                                                                                                                          | 必须观察到的结果                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A1 准入      | 真实 GitHub callback：owner/非 owner，首次/已有 account，错误 provider/缺失 profile ID                                              | 仅 owner 获 Session；拒绝方不创建可用 Session；移除实际 hook 后此测试失败                                                        |
| A2 隔离      | 同 env，仅首个 D1 请求阻塞超过两倍读预算，同时发另一个 cache-miss 读；再测真实 HTTP 请求结束                                        | 首个有限等待失败，后续健康请求独立到 D1 并完成；失败不能留下跨请求 pending lock                                                  |
| A3 Session   | 无 Cookie、有效/损坏 Cookie、持久撤销、JWE 过期、24 小时续期间隔、持久到期、secret 轮换                                             | 命中零 D1；达到间隔才续期并透传 Cookie；reauthenticatedAt 不变；已过期/撤销不续活；故障不是 null；续期超时不误称已取消写入       |
| A4 插件组合  | 按协议规格 §5 的独立包与锁定版本逐个加入 Passkey、API Key、OAuth；每组创建实例及 warm cache-hit                                     | 安装包端点/类型与路由表一致；初始化无 D1 I/O；没有 resource seed 写入；缓存/故障隔离仍成立；完整组合单独验证                     |
| A5 入口      | 105 个随机未知 Auth path、禁用路径、尾斜杠/编码别名、错误方法、错误页                                                               | 拒绝在 Auth/D1 前；D1 读写计数 0；错误页在 D1 挂起时仍可用                                                                       |
| A6 授权      | 混合/重复/空载体；过期 key；缺 permission；非 owner 资源；recent 时间边界、未来值、撤销 Session                                     | 按协议返回 400/401/403/503/504；强操作不可使用缓存；同请求不重复解析同强度身份；无法伪造 reauthenticatedAt                       |
| A7 OAuth     | PKCE/state/nonce、redirect 别名、singleton 重复、scope/resource 缩减、JWT type/alg/aud/kid/claims、refresh 并发与 revoke/reuse 竞争 | 满足协议规格；无 open redirect、扩大授权、分叉 successor 或撤销后复活；错误 hint、已轮换/已到期旧记录均覆盖                      |
| A8 UI        | 首次深链、Session 超时/503、过时请求、组件卸载、登录后刷新、mutation 成功但列表失败、取消 WebAuthn、剪贴板竞态                      | 未确认身份不发 owner 请求；503 不跳登录；旧结果不覆盖新状态；一次 mutation 一次刷新；原始 key 无持久化、撤销后不复活             |
| A9 审计/限流 | 各限流层分别测试阈值、窗口重置与插件专用规则；成功/失败事件、429、未知路径、审计写故障、HMAC 缺失、分页边界                         | 阈值与窗口符合运维规格，不能依赖库默认；安全事件脱敏；429 不写审计；操作成功不因审计失败变失败；错误页仍可用；cursor 无重复/漏页 |
| A10 数据     | 新空库应用当前 migration；启用后对比上次发布的文件；重复清理；过期 Session 与活动 OAuth token 夹具                                  | 初始 schema 仅含已启用能力；正式使用后 migration 不改写；Cron 不删除 Session，不级联误删活动凭证                                 |
| A11 发布     | 默认 dev；错误/过期/非绿色 SHA 产物、环境和 binding/name/cron 漂移、缺生产显式 name；重复派发发布                                   | 错版本/错目标在写入前停止；发布阶段不重复完整检查和构建；单环境发布不重叠；API 404 非 HTML；版本与启用的 cron 读回               |
| A12 备份恢复 | 全新备份空间；export 故障、无 Content-Length、容量边界、相同 scheduledTime 重投、迟到 put、对象冲突、SQL/schema 篡改                | 同一实例 ID 去重；调用与等待有界；只接受当前快照格式；不提前删除有效快照；恢复至隔离新 D1，不复活已撤销凭证                      |

## 3. 消融门槛

每条关键保障都要有“删除后哪个行为测试失败”的映射；失败原因必须是错误行为，不能仅因测试 import 了已删除函数。正常成功路径仍需通过，避免把全部拒绝当作安全。

| 删除/改变的保障                                                                      | 检测项                                               |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| 去掉实际 owner hook                                                                  | A1 非 owner 首次与再次登录                           |
| 恢复跨请求 Kysely/Auth 缓存                                                          | A2 独立健康请求                                      |
| 关闭 JWE cache / 改 compact / 30 秒改 300 秒 / 禁用续期 / 续期重置 reauthenticatedAt | A3 缓存 I/O、载荷、撤销窗口与滚动到期；A6 重认证门禁 |
| 去掉读 deadline 或漏掉已登记读路径                                                   | A2/A3/A5 有界响应                                    |
| OAuth 初始化恢复 runtime seed                                                        | A4 cache-hit 与构造 I/O                              |
| unknown path 重新进入库                                                              | A5 数据库行数与 query 计数                           |
| 强操作使用缓存或只相信客户端 reauth                                                  | A6 持久撤销与未来时间拒绝                            |
| 去掉 API Key 依赖故障区分、期限或 permission                                         | A6 503/过期/越权                                     |
| 去掉 singleton、resource 绑定或 family tombstone                                     | A7 重复参数/扩大授权/撤销竞争                        |
| 去掉 fetch 合并 signal/响应体 deadline 或 generation                                 | A8 已有 signal、停滞 body、旧响应覆盖                |
| 去掉备份预算、完整性或恢复清理                                                       | A12 边界、篡改、凭证复活                             |

不要求每次 CI 运行所有昂贵故障消融。普通 CI 跑行为原例；认证/协议/运维变更时在隔离副本跑相关 mutants，产出“基线通过、变体失败、原因”的简短报告。纯文档改动不为凑门槛新增运行时测试。

## 4. 性能与真实环境验收

- 同一版本、固定测试地区与网络条件，分别记录 warm JWE hit、warm D1 miss、闲置至少 5 分钟的首次请求；报告样本数与 p50/p95/max，不把几次低延迟写成全球 SLO。
- warm JWE hit 至少 30 个请求：D1 I/O 为 0，TTFB p95 < 100ms。cold 场景至少 5 次独立闲置：TTFB 目标 < 600ms；逐个报告，超标时分析网络/D1/初始化，不能用平均值藏掉尾延迟。
- 合成 D1 挂起时，服务端读预算为 5,000ms；测试容许调度误差到 5,500ms。相邻健康请求必须在首个仍挂起时实际到 D1，不能只测最后都成功。
- 记录平台 cpuTime 与 outcome；任何 exceededCpu/exceededResources 为失败。CPU 本身按基线比较，不把曾经弹性通过的高 CPU 消耗当作长期预算。
- 测量每个真实用户流程的 HTTP/D1 次数。SPA 登录后不因多面板重复 get-session；一次列表 mutation 后只请求一次该列表。不要为了减少“请求数”合并本应独立失败的接口。
- Browser E2E：Chromium 虚拟 WebAuthn、GitHub stub 与 workerd/D1；staging 另做真实 owner GitHub/Passkey 与配套新版 Desktop 的 code→refresh→revoke，记录双方精确版本。验收按当前协议，旧 Desktop 无需改动即可工作不再是门槛。真实凭证只用于授权环境，不写测试夹具或日志。
- Backup staging 验收包含完整 export→R2→新隔离 D1 恢复，记录外部请求数、CPU、导出期间读写可用性、停止 polling/上传超时行为、SQL 大小及恢复耗时。
- 首次备份接线核对新空库、独立新 bucket、单一生命周期与 cron；验证 26 小时过旧提醒、30 天保留和当前格式的恢复。旧数据/旧快照不迁移，旧资源清理不阻塞上线。真实数据启用后继续执行有界备份和恢复验收。
- 常规发布按 [运维规格 §6.2](operations.md#62-时间预算与检查频率) 分配检查，记录检查/构建和部署/冒烟各阶段耗时。约 5 分钟为待验证目标；冷启动多轮采样、真实第三方交互和全量恢复不塞进每次无关发布，但受影响变更必须取得对应专项结果。

当前没有新架构的完整插件、真实 staging、浏览器或灾难恢复通过记录。此文定义门槛，不替代执行证据。

## 5. 实施顺序与交付

沿用已完成的 M0/M1 和可用 M2 代码；数据从空库开始，不重做已有有效工作。R 编号描述新目标的功能切片，替代旧“全部功能完成后才能替换生产”的约束。

| 切片                  | 范围                                                                                 | 独立可用结果与验收                                                                 |
| --------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| R1 稳定身份与发布入口 | 请求隔离、滑动 Session、精确路由、默认 dev、最小登录/退出界面、CI 产物和手动发布入口 | GitHub 登录与 Session 可在 staging 使用，等待有界；A1–A5、A8/A11 相关项            |
| R2 日常管理           | Passkey、recent guard、审计写入/查询与管理界面                                       | owner 可日常登录与管理 Passkey；A3/A4/A6/A8/A9/A10                                 |
| R3 数据保护与首次使用 | 新生产 D1/R2、每日备份、备份状态、恢复规划器和恢复演练                               | 最小身份服务可正式使用，完成相关 A11/A12 与一次代码回退；不等待 API Key 或 Desktop |
| R4 自动化凭证         | API Key、status、key UI、私有 OpenAPI/Scalar                                         | 创建、使用、到期和撤销闭环；A4/A6/A8/A9                                            |
| R5 Desktop 授权       | OAuth Provider/JWT、family 撤销、授权管理、新版客户端同步改造及联调                  | 配套 Desktop code→refresh→revoke 闭环与版本记录；A4/A7/A9/A10                      |

每片可独立合入并在 staging 验证；生产按已通过验收的能力启用，未实现功能不显示入口，也不注册可执行端点。首次承载需保留的真实数据前完成 R3；后续功能不再要求把所有历史能力同时补齐。生产操作仍使用一次精确版本授权。

每片交付包含代码、对应行为测试、契约变更和实际结果，不能以空目录/interface 或“后续补测试”计作完成。删除旧资源不是功能切片或发布前置；若部署后已有新数据，回退按运维规格处理，不能用从零授权丢弃它们。

### 5.1 命令与新增表面

| 入口                         | 状态/目标                                                       |
| ---------------------------- | --------------------------------------------------------------- |
| `pnpm run check`             | 已存在；随能力加入行为与契约验证，不重复建设 release-check 系统 |
| `pnpm run dev`               | 已存在；补齐本地 bindings/migration/固定端口                    |
| `pnpm run build`             | 已存在；发布脚本显式选择环境再调用                              |
| `pnpm run deploy:staging`    | 已存在；发布接线后消费已通过 CI 的 staging 产物                 |
| `pnpm run deploy:production` | 目标新增；同一实现消费生产产物，一次精确版本授权                |
| `pnpm run db:restore:plan`   | 目标新增；只读本地 SQL 与对象描述，输出恢复计划，不执行远端操作 |
| `pnpm run types:generate`    | 已存在；从实际配置生成 Env，禁止手改 generated 文件             |

保留现有 frozen lockfile、lint、format、typecheck、Vitest/workerd 工具链；引入 Vue/路由、[协议规格 §5 的独立认证插件](protocol-contract.md#5-契约维护与依赖依据)、Drizzle 应用查询、契约生成、Scalar 与浏览器 E2E 是目标功能所需依赖，按切片加入并锁版本。不得提前把它们全部安装以冒充交付。

第三方前置项全部集中在 [运维配置表](operations.md#11-配置输入)：每环境 GitHub App、Cloudflare 部署身份、D1 export token、R2/Workflow 绑定及既有域名。文档本轮核验了本地 CLI/源码与官方公开资料；未探测真实 secret 的有效性、修改账户权限或部署。环境接线缺失只阻止对应真实环境验收，不影响合成凭证的本地开发。

## 6. 设计验收与本轮范围

设计可审核的条件：目标流程有明确成功/失败路径，每种策略有唯一维护位置，关键保障能指向行为测试。Q1–Q6 已收敛为免费优先、每日备份、原生滚动续期、空库启用、简化发布和 Desktop 同步改版；不再有待 owner 决定的旧客户端兼容项。规格描述目标方案，不能把需求澄清、核心探针通过或时间预算写成完整实现与真实部署验收通过。

本轮只交付 Markdown 规格及导航更新。没有执行目标实现、运行新的生产流程或改变现有迁移与依赖；后续不能把“规格已写完”记成“重构已完成”。
