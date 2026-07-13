---
loop_schema: 1
doc_id: api
version: 0.1.0
status: approved
depends_on: [architecture, features]
updated_at: 2026-07-13
---

# Loop API 接口

## 约定

基础路径为 `/api`。响应使用 JSON；错误为 `{ error: { code, message, details?, requestId } }`。写操作接受 `Idempotency-Key`。浏览器首次加载从 `/api/session` 获取仅限本进程的会话令牌，后续写请求通过 `X-Loop-Session` 提交。

## REST

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET/POST | `/projects` | 查询或添加本地项目 |
| GET/POST | `/runs` | 查询或创建运行 |
| GET/PATCH | `/runs/:id` | 查询、暂停、继续或取消运行 |
| GET/POST | `/runs/:id/messages` | 查询或发送对话消息 |
| GET/PATCH | `/runs/:id/docs` | 查询或保存文档 |
| POST | `/runs/:id/docs/:docId/approve` | 批准文档版本和哈希 |
| GET | `/runs/:id/tasks` | 查询任务树 |
| POST | `/runs/:id/execute` | 通过门禁后开始拆分和执行 |
| GET | `/runs/:id/agents` | 查询 Agent、上下文和交接 |
| GET/POST | `/runs/:id/approvals` | 查询或处理审批 |
| GET/PATCH | `/providers` | 查询或配置供应商与模型 |
| GET/PATCH | `/settings` | 查询或修改预算、并发和权限 |

## SSE

`GET /api/runs/:id/events` 返回 `text/event-stream`。事件包含 `id`、`runId`、`type`、`createdAt`、`payload`；支持 `Last-Event-ID`。事件类型包括 `message.delta`、`message.completed`、`run.state`、`agent.state`、`task.state`、`tool.output`、`approval.requested`、`budget.updated`、`doc.invalidated` 和 `error`。

## 模型适配器

`ProviderAdapter` 提供 `testConnection`、`listModels`、`completeTurn` 和能力描述。OpenAI 适配器使用 Responses API；DeepSeek 使用 `/chat/completions`。二者统一输出文本、结构化动作、工具调用和 token 用量。

用户可选择 `fixed` 或 `auto` 路由。固定模式要求 `providerId` 与 `model`；自动模式要求 Lead 模型和允许供应商列表。

## 核心类型

- `RunState`：状态机枚举和暂停原因。
- `AgentAction`：提问、文档修订、派发、工具调用、完成、暂停、交接的判别联合。
- `TaskSpec`：父任务、依赖、作用域、文档引用、验收条件和模型策略。
- `DocReference`：文档 ID、版本、哈希和章节。
- `Checkpoint`：Agent 血统、文档哈希、任务快照、事件水位和下一步。
- `ApprovalRequest`：风险等级、工具、参数摘要、命中策略和处理结果。
- `RunEvent`：可重放的追加式事件。

## 错误码

`INVALID_PATH`、`PATH_ESCAPE`、`SESSION_REQUIRED`、`DOCS_NOT_APPROVED`、`DOC_VERSION_STALE`、`BUDGET_EXCEEDED`、`APPROVAL_REQUIRED`、`PROVIDER_NOT_CONFIGURED`、`PROVIDER_RATE_LIMITED`、`WORKTREE_CONFLICT`、`RUN_STATE_CONFLICT`。

