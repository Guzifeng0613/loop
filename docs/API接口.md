---
loop_schema: 1
doc_id: api
version: 0.2.0-alpha.1
status: approved
depends_on: [architecture, features]
updated_at: 2026-07-13
---

# Loop API 接口

## 约定

基础路径为 `/api`。响应使用 JSON；错误为 `{ error: { code, message, details?, requestId } }`。写操作接受 `Idempotency-Key`。浏览器首次加载从 `/api/session` 获取仅限本进程的会话令牌，后续写请求通过 `X-Loop-Session` 提交。集合统一接受 `cursor`、`limit` 并返回 `{ items, nextCursor? }`；机器可读契约位于 `/api/openapi.json`。

## REST

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET/POST | `/projects` | 查询或添加本地项目 |
| GET/POST | `/runs` | 查询或创建运行 |
| GET/PATCH | `/runs/:id` | 查询、暂停、继续或取消运行 |
| GET | `/runs/:id/export` | 导出运行对话、任务和事件摘要 |
| GET/POST | `/runs/:id/messages` | 查询或发送对话消息 |
| GET/PATCH | `/runs/:id/docs` | 分页查询文档 metadata，或按 `docId` 保存文档 |
| GET/PATCH | `/runs/:id/docs/:docId` | 按需读取单份完整正文，或保存该文档 |
| POST | `/runs/:id/docs/:docId/approve` | 批准文档版本和哈希 |
| GET | `/runs/:id/tasks` | 查询任务树 |
| POST | `/runs/:id/execute` | 通过门禁后开始拆分和执行 |
| GET | `/runs/:id/agents` | 查询 Agent、上下文和交接 |
| GET | `/runs/:id/checkpoints` | 查询上下文交接检查点 |
| GET/POST | `/runs/:id/approvals` | 查询或处理审批 |
| GET | `/runs/:id/delivery` | 查询当前 generation 的交付摘要 |
| POST | `/runs/:id/acceptance` | 保留、合并、要求修改或放弃交付 |
| GET | `/runs/:id/tool-outputs/:outputId` | 按需读取完整工具输出 |
| GET/PATCH | `/providers` | 查询或配置供应商与模型 |
| GET/PATCH | `/settings` | 查询或修改预算、并发和权限 |

## SSE

`GET /api/runs/:id/events` 返回 `text/event-stream`。事件包含 `id`、`runId`、`type`、`schemaVersion`、`entityRevision`、`snapshotVersion`、`createdAt` 和 `payload`；支持查询参数 `after` 与 `Last-Event-ID`。事件类型包括 `message.delta`、`message.completed`、`run.state`、`agent.state`、`task.state`、`task.result`、`artifact.updated`、`delivery.updated`、`tool.output`、`approval.requested`、`approval.resolved`、`budget.updated`、`doc.invalidated` 和 `error`；业务错误的 SSE transport event 名为 `loop.error`，避免与 EventSource 连接错误冲突。

## 模型适配器

`ProviderAdapter` 提供 `testConnection`、`listModels`、`completeTurn` 和能力描述。OpenAI 适配器使用 Responses API；DeepSeek 使用 `/chat/completions`。二者统一输出文本、结构化动作、工具调用和 token 用量。

用户可选择 `fixed` 或 `auto` 路由。固定模式要求 `providerId` 与 `model`；自动模式要求 Lead 模型和允许供应商列表。

创建运行时可提交 `allowedProviderIds`。固定模式由服务端收敛为 `[providerId]`；自动模式只在允许、已配置且启用的供应商之间为子任务选路由，没有真实密钥时可显式回退到 `local-demo`。

处理审批时提交 `{ decision, scope }`，其中 `scope` 为 `once` 或 `rule`。审批记录公开 `reusable`、`capability`、`resource`；服务端拒绝对强制一次性能力提交 `rule`。`accept_merge` 首次请求会创建锁定来源 branch/commit、目标 branch 和基线的一次性审批，批准后才执行并完成验收。`GET /api/bootstrap` 返回有界集合、最近 200 条事件、`snapshotVersion`、`eventWatermark` 和当前 `usage`；前端按每运行 `snapshotVersion` 发现缺口，业务错误使用 SSE transport 名 `loop.error`，事件体的类型仍为 `error`。

## 核心类型

- `RunState`：状态机枚举和暂停原因。
- `AgentAction`：提问、文档修订、派发、工具调用、完成、暂停、交接的判别联合。
- `TaskSpec`：父任务、依赖、作用域、文档引用、验收条件和模型策略。
- `DocReference`：文档 ID、版本、哈希和章节。
- `Checkpoint`：Agent 血统、文档哈希、任务快照、事件水位和下一步。
- `ApprovalRequest`：风险等级、工具、参数摘要、命中策略和处理结果。
- `RunEvent`：可重放的追加式事件。
- `RunUsage`：调用、输入/输出 token 和经过分钟数。
- `RunBlocker`：用户暂停、审批、预算、文档、冲突、供应商和重启的结构化阻塞原因。
- `PlanGeneration`、`ActionAttempt`：文档代际和可恢复的单步模型动作。
- `TaskResult`、`ToolOutput`、`WorktreeArtifact`：机器可校验结果、按需输出和精确集成证据。
- `DeliverySummary`：用户验收所需的 diff、提交、验证、风险和费用摘要。
- `Page<T>`、`SnapshotEnvelope<T>`：分页集合与一致快照。

## 错误码

`INVALID_PATH`、`PATH_ESCAPE`、`SESSION_REQUIRED`、`DOCS_NOT_APPROVED`、`DOC_VERSION_STALE`、`BUDGET_EXCEEDED`、`APPROVAL_REQUIRED`、`PROVIDER_NOT_CONFIGURED`、`PROVIDER_RATE_LIMITED`、`WORKTREE_CONFLICT`、`RUN_STATE_CONFLICT`。

## API 优化方向

1. P0：继续把仍为类型引用的响应实体补为 Zod schema，并在 CI 校验生成 OpenAPI 与请求示例；请求体、AgentAction、命令、事件和错误已经从共享 Zod 契约生成。
2. P1：文档正文从 bootstrap 完全拆出为按需接口，并为消息/任务等页面补前端翻页控件。
3. P1：SSE 心跳携带服务端水位与显式重连建议；活动流增加输出详情加载。
4. P1：供应商配置增加连接测试、实时模型列表、价格与能力缓存接口。
5. P2：远程客户端需要独立认证、CSRF、细粒度授权和新的威胁模型，不能复用本机会话令牌。
