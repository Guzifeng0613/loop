# Loop

> 运行在本机的文档驱动多 Agent 开发工作台。

Loop 把每次模型调用当作一次单步推理，由应用负责需求澄清、文档门禁、任务拆分、执行、验证、上下文换代与故障恢复。它不假设模型 API 具备自我迭代能力：模型只产出结构化动作，应用状态机负责保存上下文、执行动作、判断质量门槛并决定下一步。

- **文档驱动**：需求、架构、接口、计划与验收标准先固化为 Markdown，批准后记录内容哈希与版本；文档变更会让相关任务在安全点回到文档评审。
- **多 Agent 编排**：主 Agent 建立带父子关系、依赖、租约与验收条件的任务树，支持并行子 Agent、顺序换代与上下文检查点。
- **隔离执行**：执行阶段在 Git worktree 中进行，集成与最终合并逐次审批，不自动改动当前分支。
- **分级审批**：读取与任务内编辑按策略放行，安装、联网、删除、Git 发布与合并等高风险动作逐次批准，全程写入审计事件。
- **本地优先与安全**：服务仅绑定 `127.0.0.1`，同源 + 会话令牌，不开放 CORS；路径经过真实路径与父目录校验，密钥与 `.env*` 不进入模型上下文。
- **可恢复**：SQLite 追加式事件记录 + SSE 增量推送，重启或断线后从安全点恢复，效果未知的动作暂停等待人工核对。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19、Vite、TypeScript、自定义 design tokens |
| 后端 | Node.js、Fastify、TypeScript（仅绑定 `127.0.0.1`） |
| 数据 | better-sqlite3，追加式事件记录 + 查询投影（事务化单调迁移） |
| 模型 | OpenAI Responses API、DeepSeek Chat Completions，统一适配器归一化 |
| 契约 | Zod，前后端共享 schema 并导出 OpenAPI |
| 测试 / 质量 | Vitest、ESLint、TypeScript |

## 目录结构

```
loop/
├── apps/
│   ├── server/            # Fastify 后端（API、编排器、工具、worktree、安全）
│   └── web/               # React + Vite 前端（三视图工作台）
├── packages/
│   └── contracts/         # 前后端共享的 Zod 契约与类型
├── scripts/
│   └── dev.mjs            # 本地并行启动前后端的开发脚本
├── tests/                 # Vitest 单元 / 接口 / UI 测试
├── docs/                  # 设计文档（产品规范来源）
├── eslint.config.js
├── tsconfig.base.json
└── package.json           # npm workspaces 根配置
```

## 环境要求

- **Node.js ≥ 22**（`engines` 已约束）
- npm 10+
- Windows（API 密钥默认保存到 Windows 凭据管理器，开发脚本针对 Windows 进程树做了处理）

## 快速开始

```powershell
npm install
npm run dev
```

启动后：

- 前端（工作台）：<http://127.0.0.1:5173>
- 后端（API）：<http://127.0.0.1:4317>
- 机器可读契约：<http://127.0.0.1:4317/api/openapi.json>

生产构建与启动：

```powershell
npm run build
npm start
```

## 可用脚本

在仓库根目录执行：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 先构建契约，再并行启动后端（tsx watch）与前端（Vite） |
| `npm run build` | 依次构建契约、前端与后端 |
| `npm start` | 运行已构建的后端（`apps/server`） |
| `npm run typecheck` | 对所有工作区执行 TypeScript 类型检查 |
| `npm run lint` | ESLint 检查，警告为 0 才通过 |
| `npm test` | 运行全部 Vitest 测试（单 worker） |
| `npm run test:watch` | 以监听模式运行测试 |

## 配置

### API 密钥

OpenAI 与 DeepSeek 密钥可在前端「设置」界面保存到 **Windows 凭据管理器**；也可通过环境变量提供（环境变量为回退，日志与接口永不返回原始密钥）：

- `OPENAI_API_KEY`
- `DEEPSEEK_API_KEY`

未配置真实密钥时，可在创建运行时显式选择本地演示模式（不调用模型，也不会伪造业务代码变更）。

### 服务端环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LOOP_PORT` | `4317` | 后端监听端口 |
| `LOOP_WEB_ORIGIN` | `http://127.0.0.1:5173` | 允许的前端同源地址 |
| `LOOP_DATA_DIR` | `%LOCALAPPDATA%\Loop` | 数据目录 |
| `LOOP_DATABASE_PATH` | `<数据目录>/loop.db` | SQLite 数据库路径 |
| `LOOP_DEFAULT_PROJECT` | 仓库根目录 | 默认项目根目录 |

## Agent 工作流

运行状态依次为：

```
intake → clarifying → doc_review → ready → decomposing → executing
      → integrating → verifying → awaiting_acceptance → completed
```

另有可选的 `optimizing`，以及 `paused`、`failed`、`cancelled`。验证通过仅代表具备交付条件，只有用户选择保留分支或合并后才标记为 `completed`。

每个 Agent 单轮只允许返回：向用户提问、提出文档修订、派发任务、调用工具、完成任务、暂停或请求上下文交接。调度器校验权限、预算、文档版本与任务依赖后执行一个原子效果并写入事件记录。

## 文档

[`docs/`](docs/) 下的文档是产品规范来源：

- [总体方案](docs/总体方案.md)
- [功能](docs/功能.md)
- [UI](docs/UI.md)
- [API 接口](docs/API接口.md)
- [基准任务集](docs/基准任务集.md)
- [版本更迭](docs/版本更迭.md)
