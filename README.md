# Loop

Loop 是一个运行在本机的文档驱动多 Agent 开发工作台。它把模型调用当作单步推理，由应用负责澄清、文档门禁、任务拆分、执行、验证、上下文换代和恢复。

## 本地运行

```powershell
npm.cmd install
npm.cmd run dev
```

默认前端地址为 `http://127.0.0.1:5173`，后端地址为 `http://127.0.0.1:4317`。生产构建使用：

```powershell
npm.cmd run build
npm.cmd start
```

OpenAI 和 DeepSeek 密钥可在设置界面保存到 Windows 凭据管理器，也可分别通过 `OPENAI_API_KEY` 与 `DEEPSEEK_API_KEY` 提供。

## 文档

- [总体方案](docs/总体方案.md)
- [功能](docs/功能.md)
- [UI](docs/UI.md)
- [API 接口](docs/API接口.md)
- [版本更迭](docs/版本更迭.md)

