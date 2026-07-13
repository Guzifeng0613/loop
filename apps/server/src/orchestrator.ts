import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type {
  Agent,
  AppSettings,
  ChatMessage,
  Project,
  Run,
  TaskSpec,
  UnderstandingAnalysis
} from '@loop/contracts';
import type { DocumentService } from './documents.js';
import type { ProviderRegistry } from './providers.js';
import type { LoopStore } from './store.js';
import { WorkspaceTools, type WorkspaceToolName } from './workspace-tools.js';
import type { WorktreeManager } from './worktrees.js';

const analysisSchema = z.object({
  summary: z.string().min(1),
  understood: z.array(z.string()).default([]),
  unclear: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  questions: z.array(z.string()).default([]),
  ready: z.boolean().default(false)
});

const taskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  scope: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).min(1),
  providerId: z.enum(['openai', 'deepseek', 'local-demo']).optional(),
  model: z.string().optional()
});

const modelActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('call_tool'), tool: z.enum(['list_files', 'read_file', 'search_text', 'write_file', 'run_command', 'git_status']), arguments: z.record(z.unknown()) }),
  z.object({ type: z.literal('delegate'), tasks: z.array(taskSchema).min(1).max(5) }),
  z.object({ type: z.literal('complete'), summary: z.string(), evidence: z.array(z.string()).default([]) }),
  z.object({ type: z.literal('pause'), reason: z.string() })
]);

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(candidate);
}

function localAnalysis(input: string): UnderstandingAnalysis {
  const cleaned = input.trim();
  const details = cleaned.split(/[。！？\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 6);
  const unclear: string[] = [];
  if (!/(验收|成功|完成标准|测试)/.test(cleaned)) unclear.push('尚未给出可验证的完成标准。');
  if (!/(用户|团队|开发者|管理员|面向)/.test(cleaned)) unclear.push('目标使用者和典型使用场景还不明确。');
  if (!/(不包含|首版|范围|暂不)/.test(cleaned)) unclear.push('首版范围和明确排除项需要确认。');
  return {
    summary: details[0] ?? '需要进一步描述目标。',
    understood: details.length > 0 ? details : ['你希望通过持续对话澄清需求。'],
    unclear,
    assumptions: ['默认以当前项目为工作区。', '默认先形成并批准 Markdown 规范，再允许执行。'],
    questions: unclear.map((item) => item.replace(/。$/, '？')),
    ready: unclear.length === 0,
    source: 'local-demo'
  };
}

function analysisPrompt(): string {
  return `你是 Loop 的需求深究主 Agent。只输出 JSON，不要 Markdown。字段必须是：
{"summary":"一句话总结","understood":["已确认事实"],"unclear":["缺失或冲突"],"assumptions":["当前假设"],"questions":["必须向用户确认的问题"],"ready":false}
区分事实与假设；问题只保留会改变方案的重要事项；不要声称已经执行工具。`;
}

function taskPrompt(): string {
  return `你是 Loop 的 Lead Main。根据批准文档把工作拆成 3 到 8 个可独立验证的任务。只输出 JSON：
{"tasks":[{"title":"任务名","description":"具体交付","scope":["允许修改的路径"],"acceptanceCriteria":["可执行的验收条件"],"providerId":"openai或deepseek","model":"可选模型ID"}]}
任务需要覆盖共享契约、后端、前端和验证；只有自动路由模式才填写 providerId；不要添加文档之外的需求。`;
}

export class Orchestrator {
  private readonly tools = new WorkspaceTools();
  private readonly activeRuns = new Set<string>();

  constructor(
    private readonly store: LoopStore,
    private readonly documents: DocumentService,
    private readonly providers: ProviderRegistry,
    private readonly worktrees: WorktreeManager
  ) {}

  private assertBudget(run: Run): void {
    const settings = this.store.getSetting<AppSettings>('app');
    if (!settings) throw new Error('SETTINGS_MISSING');
    const usage = this.store.getUsage(run.id);
    const elapsedMinutes = (Date.now() - new Date(run.createdAt).getTime()) / 60_000;
    if (
      usage.calls >= settings.budget.maxCalls ||
      usage.inputTokens >= settings.budget.maxInputTokens ||
      usage.outputTokens >= settings.budget.maxOutputTokens ||
      elapsedMinutes >= settings.budget.maxMinutes
    ) {
      this.store.updateRun(run.id, {
        state: 'paused',
        previousState: run.state,
        pauseReason: 'BUDGET_EXCEEDED: 运行预算已达到上限'
      });
      throw new Error('BUDGET_EXCEEDED');
    }
  }

  private async selectRoute(run: Run, requestedProvider?: 'openai' | 'deepseek' | 'local-demo', requestedModel?: string): Promise<{ providerId: Run['providerId']; model: string }> {
    if (run.modelMode === 'fixed') return { providerId: run.providerId, model: run.model };
    const configured = (await this.providers.configs()).filter((provider) => provider.configured && provider.enabled);
    const preferred = configured.find((provider) => provider.id === requestedProvider && provider.id !== 'local-demo');
    const selected = preferred ?? configured.find((provider) => provider.id === run.providerId) ?? configured[0];
    if (!selected) return { providerId: 'local-demo', model: 'local-structured-demo' };
    const model = requestedModel && selected.availableModels.includes(requestedModel) ? requestedModel : selected.defaultModel;
    return { providerId: selected.id, model };
  }

  async sendMessage(runId: string, content: string): Promise<ChatMessage> {
    const run = this.requireRun(runId);
    this.store.addMessage({ runId, role: 'user', content });
    this.store.updateRun(runId, { state: 'clarifying', previousState: run.state, docsApproved: false });

    let analysis: UnderstandingAnalysis;
    const provider = await this.providers.get(run.providerId);
    if (!provider) {
      analysis = localAnalysis(content);
    } else {
      this.assertBudget(run);
      const history = this.store.listMessages(runId).slice(-16).map(({ role, content: messageContent }) => ({ role, content: messageContent }));
      const result = await provider.completeTurn({ model: run.model, systemPrompt: analysisPrompt(), messages: history, jsonMode: true });
      this.store.addUsage(runId, result.inputTokens, result.outputTokens);
      const parsed = analysisSchema.parse(extractJson(result.text));
      analysis = { ...parsed, source: 'model' };
    }
    const assistant = this.store.addMessage({
      runId,
      role: 'assistant',
      content: analysis.summary,
      analysis
    });
    if (analysis.ready) this.store.updateRun(runId, { state: 'doc_review', previousState: 'clarifying' });
    return assistant;
  }

  async approveAllDocuments(runId: string): Promise<Run> {
    const run = this.requireRun(runId);
    const project = this.requireProject(run.projectId);
    await this.documents.syncProject(project.id, project.rootPath);
    const docs = this.store.listDocuments(project.id);
    if (docs.length === 0) throw new Error('DOCS_NOT_FOUND');
    for (const doc of docs) this.store.approveDocument(project.id, doc.id);
    return this.store.updateRun(runId, { docsApproved: true, state: 'ready', previousState: run.state });
  }

  async invalidateForDocumentChange(runId: string, docId: string): Promise<void> {
    const run = this.requireRun(runId);
    this.store.updateRun(runId, { docsApproved: false, state: 'doc_review', previousState: run.state, pauseReason: `文档 ${docId} 已改变` });
    for (const task of this.store.listTasks(runId)) {
      if (task.status !== 'completed') this.store.upsertTask({ ...task, status: 'stale' });
    }
    this.store.appendEvent(runId, 'doc.invalidated', { docId });
  }

  async execute(runId: string): Promise<void> {
    if (this.activeRuns.has(runId)) return;
    const run = this.requireRun(runId);
    const project = this.requireProject(run.projectId);
    if (!run.docsApproved) throw new Error('DOCS_NOT_APPROVED');
    if (!project.isGit) throw new Error('PROJECT_NOT_GIT');
    if (!(await this.worktrees.isClean(project.rootPath))) throw new Error('WORKTREE_DIRTY');
    this.activeRuns.add(runId);
    void this.runExecution(run, project).finally(() => this.activeRuns.delete(runId));
  }

  async integrate(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    const project = this.requireProject(run.projectId);
    this.store.updateRun(runId, { state: 'integrating', previousState: run.state });
    try {
      const result = await this.worktrees.integrate(runId, project.rootPath);
      for (const output of result.verification) this.store.appendEvent(runId, 'tool.output', { tool: 'integration_verification', output });
      this.store.updateRun(runId, { state: 'optimizing', previousState: 'verifying' });
      this.store.appendEvent(runId, 'tool.output', { output: `集成分支 ${result.branch} 已完成验证，位置：${result.path}` });
      this.store.updateRun(runId, { state: 'completed', previousState: 'optimizing' });
    } catch (error) {
      this.store.appendEvent(runId, 'error', { message: error instanceof Error ? error.message : String(error) });
      this.store.updateRun(runId, { state: 'paused', previousState: 'integrating', pauseReason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async runExecution(initialRun: Run, project: Project): Promise<void> {
    try {
      this.store.updateRun(initialRun.id, { state: 'decomposing', previousState: initialRun.state });
      let tasks = this.store.listTasks(initialRun.id);
      if (tasks.length === 0) tasks = await this.decompose(initialRun, project);
      this.store.updateRun(initialRun.id, { state: 'executing', previousState: 'decomposing' });
      const settings = this.store.getSetting<AppSettings>('app');
      if (!settings) throw new Error('SETTINGS_MISSING');
      let remaining = tasks.filter((task) => task.status !== 'completed');
      while (remaining.length > 0) {
        const latest = this.store.listTasks(initialRun.id);
        const completed = new Set(latest.filter((task) => task.status === 'completed').map((task) => task.id));
        const ready = remaining.filter((task) => task.dependencies.every((dependency) => completed.has(dependency)));
        if (ready.length === 0) {
          this.store.updateRun(initialRun.id, { state: 'paused', previousState: 'executing', pauseReason: '任务依赖阻塞或等待审批' });
          return;
        }
        await this.runPool(ready, settings.concurrency, (task) => this.executeTask(initialRun, project, task, settings));
        remaining = this.store.listTasks(initialRun.id).filter((task) => task.status !== 'completed');
        if (remaining.some((task) => task.status === 'blocked')) {
          this.store.updateRun(initialRun.id, { state: 'paused', previousState: 'executing', pauseReason: '子 Agent 等待审批或人工输入' });
          return;
        }
      }
      if (this.store.listTasks(initialRun.id).some((task) => task.status !== 'completed')) return;
      this.store.updateRun(initialRun.id, { state: 'integrating', previousState: 'executing' });
      this.store.appendEvent(initialRun.id, 'tool.output', { output: '所有任务分支已完成，等待 Lead Main 集成。' });
      this.store.updateRun(initialRun.id, { state: 'verifying', previousState: 'integrating' });
      this.store.createApproval({
        runId: initialRun.id,
        tool: 'merge_integration',
        risk: 'high',
        summary: '任务分支已完成，需要在专用集成分支合并并运行全局验证。',
        policyReason: '最终合并始终需要用户确认。'
      });
      this.store.updateRun(initialRun.id, { state: 'paused', previousState: 'verifying', pauseReason: '等待最终集成批准' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.appendEvent(initialRun.id, 'error', { message });
      if (message.startsWith('BUDGET_EXCEEDED')) {
        const current = this.requireRun(initialRun.id);
        if (current.state !== 'paused') this.store.updateRun(initialRun.id, { state: 'paused', previousState: current.state, pauseReason: message });
      } else {
        this.store.updateRun(initialRun.id, { state: 'failed', previousState: this.requireRun(initialRun.id).state, pauseReason: message });
      }
    }
  }

  private async decompose(run: Run, project: Project): Promise<TaskSpec[]> {
    const docs = this.store.listDocuments(project.id);
    const docRefs = docs.map((doc) => ({ docId: doc.id, version: doc.version, hash: doc.hash, sections: [] }));
    let taskInputs: z.infer<typeof taskSchema>[];
    const provider = await this.providers.get(run.providerId);
    if (provider) {
      this.assertBudget(run);
      const result = await provider.completeTurn({
        model: run.model,
        systemPrompt: taskPrompt(),
        messages: [{ role: 'user', content: docs.map((doc) => doc.content).join('\n\n').slice(0, 120_000) }],
        jsonMode: true
      });
      this.store.addUsage(run.id, result.inputTokens, result.outputTokens);
      taskInputs = z.object({ tasks: z.array(taskSchema).min(1).max(30) }).parse(extractJson(result.text)).tasks;
    } else {
      taskInputs = [
        { title: '校验文档契约', description: '确认核心文档 front matter、哈希和引用完整。', scope: ['docs/'], acceptanceCriteria: ['所有核心文档可解析且哈希稳定'] },
        { title: '校验共享契约', description: '检查前后端共享类型和状态机边界。', scope: ['packages/contracts/'], acceptanceCriteria: ['TypeScript 类型检查通过'] },
        { title: '校验后端接口', description: '验证 REST、SSE、持久化和安全策略。', scope: ['apps/server/'], acceptanceCriteria: ['服务端测试通过'] },
        { title: '校验三视图 UI', description: '验证工作台、流程、IDE 共享同一状态。', scope: ['apps/web/'], acceptanceCriteria: ['前端构建和交互测试通过'] },
        { title: '运行全局验收', description: '执行 lint、类型检查、测试与构建。', scope: ['.'], acceptanceCriteria: ['所有验收命令成功'] }
      ];
    }
    const leadId = randomUUID();
    const lead: Agent = {
      id: leadId, runId: run.id, name: 'Lead Main', role: 'lead-main', status: 'running', depth: 0,
      providerId: run.providerId, model: run.model, contextUsage: 0.08, lineage: 1
    };
    this.store.upsertAgent(lead);
    const tasks = await Promise.all(taskInputs.map(async (input, index): Promise<TaskSpec> => {
      const route = await this.selectRoute(run, input.providerId, input.model);
      return {
        id: `TASK-${String(index + 1).padStart(3, '0')}-${run.id.slice(0, 6)}`,
        runId: run.id,
        title: input.title,
        description: input.description,
        status: 'queued',
        depth: 1,
        dependencies: index === taskInputs.length - 1 ? taskInputs.slice(0, -1).map((_, itemIndex) => `TASK-${String(itemIndex + 1).padStart(3, '0')}-${run.id.slice(0, 6)}`) : [],
        scope: input.scope,
        docRefs,
        acceptanceCriteria: input.acceptanceCriteria,
        providerId: route.providerId,
        model: route.model
      };
    }));
    for (const task of tasks) this.store.upsertTask(task);
    return tasks;
  }

  private async executeTask(
    run: Run,
    project: Project,
    task: TaskSpec,
    settings: AppSettings,
    baseRef = 'HEAD',
    parentAgentId?: string
  ): Promise<void> {
    const blocked = task.dependencies.some((dependency) => this.store.listTasks(run.id).find((item) => item.id === dependency)?.status !== 'completed');
    if (blocked) return;
    const fallbackParentId = this.store.listAgents(run.id).find((item) => item.role === 'lead-main')?.id;
    let agent: Agent = {
      id: randomUUID(), runId: run.id,
      ...((parentAgentId ?? fallbackParentId) ? { parentId: parentAgentId ?? fallbackParentId! } : {}),
      name: task.title, role: task.depth === 1 ? 'module-main' : 'subagent', status: 'running', depth: task.depth,
      providerId: task.providerId ?? run.providerId, model: task.model ?? run.model, taskId: task.id,
      contextUsage: 0.05, lineage: 1
    };
    this.store.upsertAgent(agent);
    this.store.upsertTask({ ...task, status: 'running', assignedAgentId: agent.id });

    const worktree = await this.worktrees.create(run.id, task.id, project.rootPath, baseRef);
    const provider = await this.providers.get(agent.providerId);
    if (!provider) {
      await this.writeResult(worktree.path, run.id, agent, task, '本地演示模式完成了任务状态与结果文档验证；未调用模型或修改业务代码。', ['状态机已记录完成事件']);
      await this.worktrees.commit(worktree.path, task.id);
      this.store.upsertTask({ ...task, status: 'completed', assignedAgentId: agent.id });
      this.store.upsertAgent({ ...agent, status: 'completed', contextUsage: 0.12 });
      return;
    }

    const conversation: Pick<ChatMessage, 'role' | 'content'>[] = [{
      role: 'user',
      content: `任务：${task.title}\n${task.description}\n允许作用域：${task.scope.join(', ')}\n验收：${task.acceptanceCriteria.join('; ')}`
    }];
    let summary = '';
    const evidence: string[] = [];
    for (let step = 0; step < 8; step += 1) {
      if (agent.contextUsage >= 0.75) {
        const previous = agent;
        await this.writeCheckpoint(worktree.path, run, previous, task, '继续当前任务的下一轮结构化动作');
        this.store.upsertAgent({ ...previous, status: 'archived' });
        agent = {
          ...previous,
          id: randomUUID(),
          name: `${task.title} · 接力 ${previous.lineage + 1}`,
          status: 'running',
          contextUsage: 0.08,
          lineage: previous.lineage + 1,
          parentId: previous.id
        };
        this.store.upsertAgent(agent);
        this.store.upsertTask({ ...task, status: 'running', assignedAgentId: agent.id });
        conversation.push({ role: 'system', content: `已通过 Markdown 检查点完成上下文接力，新实例 lineage=${agent.lineage}。` });
      }
      this.assertBudget(this.requireRun(run.id));
      const result = await provider.completeTurn({
        model: agent.model,
        systemPrompt: `你是文档驱动的编码子 Agent。每次只输出一个 JSON 动作。可用工具 list_files/read_file/search_text/write_file/run_command/git_status。
工具动作：{"type":"call_tool","tool":"read_file","arguments":{"path":"..."}}
委派动作：{"type":"delegate","tasks":[{"title":"...","description":"...","scope":["..."],"acceptanceCriteria":["..."]}]}
完成动作：{"type":"complete","summary":"...","evidence":["..."]}
暂停动作：{"type":"pause","reason":"..."}
不得修改任务 scope 外文件；最多向下委派 ${Math.max(0, settings.maxDepth - task.depth)} 层；先检查再修改；完成前运行验收命令。`,
        messages: conversation,
        jsonMode: true
      });
      this.store.addUsage(run.id, result.inputTokens, result.outputTokens);
      const action = modelActionSchema.parse(extractJson(result.text));
      if (action.type === 'complete') {
        summary = action.summary;
        evidence.push(...action.evidence);
        break;
      }
      if (action.type === 'pause') {
        this.store.upsertTask({ ...task, status: 'blocked', assignedAgentId: agent.id });
        this.store.upsertAgent({ ...agent, status: 'waiting', contextUsage: Math.min(0.7, (step + 1) / 10) });
        return;
      }
      if (action.type === 'delegate') {
        const currentTaskCount = this.store.listTasks(run.id).length;
        if (task.depth >= settings.maxDepth || currentTaskCount + action.tasks.length > settings.maxAgents) {
          conversation.push({ role: 'assistant', content: JSON.stringify(action) }, {
            role: 'tool',
            content: '委派被调度器拒绝：已达到最大深度或 Agent 总量上限。请在当前 Agent 内继续。'
          });
          continue;
        }
        await this.worktrees.commit(worktree.path, `${task.id}-before-delegate`);
        const childTasks = await Promise.all(action.tasks.map(async (input) => {
          const route = await this.selectRoute(run, input.providerId, input.model);
          const child: TaskSpec = {
            id: `TASK-${task.depth + 1}-${randomUUID().slice(0, 8)}`,
            runId: run.id,
            parentId: task.id,
            title: input.title,
            description: input.description,
            status: 'queued',
            depth: task.depth + 1,
            dependencies: [],
            scope: input.scope,
            docRefs: task.docRefs,
            acceptanceCriteria: input.acceptanceCriteria,
            providerId: route.providerId,
            model: route.model
          };
          this.store.upsertTask(child);
          return child;
        }));
        await this.runPool(childTasks, Math.min(settings.concurrency, 5), (child) =>
          this.executeTask(run, project, child, settings, worktree.branch, agent.id)
        );
        const incomplete = childTasks.filter((child) => this.store.listTasks(run.id).find((item) => item.id === child.id)?.status !== 'completed');
        if (incomplete.length > 0) {
          this.store.upsertTask({ ...task, status: 'blocked', assignedAgentId: agent.id });
          this.store.upsertAgent({ ...agent, status: 'waiting' });
          return;
        }
        for (const child of childTasks) await this.worktrees.mergeInto(worktree.path, this.worktrees.branchName(run.id, child.id));
        conversation.push({ role: 'assistant', content: JSON.stringify(action) }, {
          role: 'tool',
          content: `已完成并合并 ${childTasks.length} 个下级任务：${childTasks.map((child) => child.id).join(', ')}`
        });
        agent.contextUsage = Math.min(0.9, agent.contextUsage + 0.16);
        this.store.upsertAgent(agent);
        continue;
      }
      const policy = this.tools.evaluate(action.tool as WorkspaceToolName, action.arguments, settings);
      const approvalGranted = this.store.consumeApprovedTool(run.id, task.id, action.tool);
      if (policy.decision === 'deny') {
        this.store.upsertTask({ ...task, status: 'failed', assignedAgentId: agent.id });
        this.store.upsertAgent({ ...agent, status: 'failed' });
        throw new Error(`TOOL_DENIED: ${policy.reason}`);
      }
      if (policy.decision === 'approval' && !approvalGranted) {
        this.store.createApproval({
          runId: run.id, taskId: task.id, tool: action.tool, risk: policy.risk,
          summary: JSON.stringify(action.arguments).slice(0, 500), policyReason: policy.reason
        });
        this.store.upsertTask({ ...task, status: 'blocked', assignedAgentId: agent.id });
        this.store.upsertAgent({ ...agent, status: 'waiting', contextUsage: Math.min(0.7, (step + 1) / 10) });
        return;
      }
      const idempotencyKey = `${run.id}:${task.id}:${step}:${action.tool}:${JSON.stringify(action.arguments)}`;
      let outcome = this.store.getIdempotent<Awaited<ReturnType<WorkspaceTools['execute']>>>(idempotencyKey);
      if (!outcome) {
        outcome = await this.tools.execute(action.tool as WorkspaceToolName, action.arguments, { project, workspaceRoot: worktree.path, settings }, undefined, approvalGranted);
        this.store.setIdempotent(idempotencyKey, outcome);
      }
      this.store.appendEvent(run.id, 'tool.output', { taskId: task.id, tool: action.tool, output: outcome.output.slice(0, 8_000) });
      conversation.push({ role: 'assistant', content: JSON.stringify(action) }, { role: 'tool', content: outcome.output });
      agent.contextUsage = Math.min(0.9, agent.contextUsage + 0.14);
      this.store.upsertAgent(agent);
    }
    if (!summary) throw new Error(`AGENT_STEP_LIMIT: ${task.id}`);
    await this.writeResult(worktree.path, run.id, agent, task, summary, evidence);
    const revision = await this.worktrees.commit(worktree.path, task.id);
    if (revision) evidence.push(`commit ${revision}`);
    this.store.upsertTask({ ...task, status: 'completed', assignedAgentId: agent.id });
    this.store.upsertAgent({ ...agent, status: 'completed', contextUsage: Math.min(0.75, agent.contextUsage) });
  }

  private async writeCheckpoint(root: string, run: Run, agent: Agent, task: TaskSpec, nextAction: string): Promise<void> {
    const directory = resolve(root, 'docs', 'runs', run.id, 'handoffs');
    await mkdir(directory, { recursive: true });
    const events = this.store.listEvents(run.id);
    const eventWatermark = events.at(-1)?.id ?? 0;
    const content = `---\nloop_schema: 1\nrun_id: ${run.id}\nagent_id: ${agent.id}\nlineage: ${agent.lineage}\nevent_watermark: ${eventWatermark}\nupdated_at: ${new Date().toISOString()}\n---\n\n# Agent 上下文交接\n\n## 当前任务\n\n- ${task.id}: ${task.title}\n- 状态：${task.status}\n- 文档版本：${task.docRefs.map((ref) => `${ref.docId}@${ref.version}`).join(', ')}\n\n## 模块状态与内容\n\n${task.description}\n\n## 验收与规划\n\n${task.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}\n\n## 下一步\n\n${nextAction}\n`;
    await writeFile(resolve(directory, `${agent.id}-lineage-${agent.lineage}.md`), content, 'utf8');
  }

  private async writeResult(root: string, runId: string, agent: Agent, task: TaskSpec, summary: string, evidence: string[]): Promise<void> {
    const directory = resolve(root, 'docs', 'runs', runId, 'agents');
    await mkdir(directory, { recursive: true });
    const content = `---\nloop_schema: 1\nrun_id: ${runId}\nagent_id: ${agent.id}\ntask_id: ${task.id}\nstatus: completed\nupdated_at: ${new Date().toISOString()}\n---\n\n# ${task.title}\n\n## 摘要\n\n${summary}\n\n## 文档引用\n\n${task.docRefs.map((ref) => `- ${ref.docId}@${ref.version} \`${ref.hash}\``).join('\n')}\n\n## 验证证据\n\n${evidence.map((item) => `- ${item}`).join('\n') || '- 无额外证据'}\n\n## 风险与后续\n\n- 由父 Agent 独立复核后才能进入集成。\n`;
    await writeFile(resolve(directory, `${agent.id}.md`), content, 'utf8');
  }

  private async runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item !== undefined) await worker(item);
      }
    });
    await Promise.all(runners);
  }

  private requireRun(id: string): Run {
    const run = this.store.getRun(id);
    if (!run) throw new Error('RUN_NOT_FOUND');
    return run;
  }

  private requireProject(id: string): Project {
    const project = this.store.listProjects().find((item) => item.id === id);
    if (!project) throw new Error('PROJECT_NOT_FOUND');
    return project;
  }
}
