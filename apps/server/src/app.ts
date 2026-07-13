import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { AppSettings, BootstrapPayload, ProviderId } from '@loop/contracts';
import { config, dataDirectory, repoRoot } from './config.js';
import { CredentialStore } from './credentials.js';
import { DocumentService } from './documents.js';
import { LoopError, normalizeError } from './errors.js';
import { Orchestrator } from './orchestrator.js';
import { ProviderRegistry } from './providers.js';
import { runProcess } from './security.js';
import { LoopStore } from './store.js';
import { WorktreeManager } from './worktrees.js';

function requestId(request: FastifyRequest): string {
  return request.id;
}

function sendError(reply: FastifyReply, request: FastifyRequest, error: unknown): FastifyReply {
  const normalized = normalizeError(error);
  return reply.status(normalized.statusCode).send({
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
      requestId: requestId(request)
    }
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface AppContext {
  app: FastifyInstance;
  store: LoopStore;
  documents: DocumentService;
  orchestrator: Orchestrator;
  credentials: CredentialStore;
  providers: ProviderRegistry;
}

async function ensureSeed(context: AppContext): Promise<void> {
  let projects = context.store.listProjects();
  if (projects.length === 0) {
    const rootPath = await realpath(config.defaultProjectRoot);
    const isGit = (await runProcess('git rev-parse --is-inside-work-tree', rootPath)).code === 0;
    projects = [context.store.createProject({ name: basename(rootPath), rootPath, isGit })];
  }

  for (const project of projects) {
    await context.documents.syncProject(project.id, project.rootPath);
    context.documents.watchProject(project.id, project.rootPath, (docIds) => {
      for (const run of context.store.listRuns(project.id)) {
        if (!['completed', 'cancelled', 'failed'].includes(run.state)) {
          for (const docId of docIds) void context.orchestrator.invalidateForDocumentChange(run.id, docId);
        }
      }
    });

    const staleDocuments = context.store.listDocuments(project.id).filter((doc) => doc.status === 'stale');
    if (staleDocuments.length > 0) {
      for (const projectRun of context.store.listRuns(project.id).filter((item) => !['completed', 'cancelled', 'failed'].includes(item.state))) {
        context.store.releaseRunLeases(projectRun.id);
        for (const agent of context.store.listAgents(projectRun.id).filter((item) => item.status === 'running')) {
          context.store.upsertAgent({ ...agent, status: 'archived' });
        }
        for (const doc of staleDocuments) await context.orchestrator.invalidateForDocumentChange(projectRun.id, doc.id);
      }
    }
    for (const activeRun of context.store.listRuns(project.id).filter((item) =>
      ['decomposing', 'executing', 'integrating', 'verifying', 'optimizing'].includes(item.state)
    )) {
      context.store.releaseRunLeases(activeRun.id);
      for (const agent of context.store.listAgents(activeRun.id).filter((item) => item.status === 'running')) {
        context.store.upsertAgent({ ...agent, status: 'archived' });
      }
      context.store.updateRun(activeRun.id, {
        state: 'paused',
        previousState: activeRun.state,
        pauseReason: '服务器重启后已从事件记录恢复，请确认后继续。'
      });
    }
  }

  const project = projects[0]!;
  let run = context.store.listRuns(project.id)[0];
  if (!run) {
    run = context.store.createRun({
      projectId: project.id,
      title: 'Loop 工作台',
      question: '构建一个严格依赖 Markdown 文档、支持上下文换代的多 Agent 开发工作台。',
      modelMode: 'fixed',
      providerId: 'local-demo',
      model: 'local-structured-demo'
    });
    context.store.addMessage({
      runId: run.id,
      role: 'assistant',
      content: '我已经建立文档驱动的工作上下文。批准规范后才能进入任务拆分。',
      analysis: {
        summary: '构建本机文档驱动的多 Agent 开发工作台。',
        understood: ['模型调用由程序状态机持续编排。', '规范、UI、API 和版本计划保存在 docs。', '主 Agent 支持并行与上下文换代。'],
        unclear: ['开始执行前需要确认当前五份核心文档。'],
        assumptions: ['首版运行在 Windows 本机。', '首版仅开放文本输入。'],
        questions: ['是否批准右侧五份核心规范并进入任务拆分？'],
        ready: true,
        source: 'local-demo'
      }
    });
    context.store.updateRun(run.id, { state: 'doc_review', previousState: 'intake' });
  }
}

export async function createApp(databasePath = config.databasePath): Promise<AppContext> {
  const app = Fastify({ logger: true, trustProxy: false, bodyLimit: 2 * 1024 * 1024 });
  const store = new LoopStore(databasePath);
  const credentials = new CredentialStore();
  const providers = new ProviderRegistry(credentials);
  const documents = new DocumentService(store);
  const worktrees = new WorktreeManager(resolve(dataDirectory, 'worktrees'));
  const orchestrator = new Orchestrator(store, documents, providers, worktrees);
  const context: AppContext = { app, store, documents, orchestrator, credentials, providers };
  const inFlightIdempotency = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();

  async function idempotent<T>(request: FastifyRequest, scope: string, operation: () => Promise<T> | T): Promise<T> {
    const rawKey = request.headers['idempotency-key'];
    if (rawKey === undefined) return operation();
    if (typeof rawKey !== 'string' || rawKey.length < 1 || rawKey.length > 200) {
      throw new LoopError('INVALID_REQUEST', 'Idempotency-Key 必须是 1–200 个字符。');
    }
    const fingerprint = createHash('sha256')
      .update(`${request.method}\n${scope}\n${canonicalJson(request.body)}`)
      .digest('hex');
    const storageKey = `api:${scope}:${rawKey}`;
    const cached = store.getIdempotent<{ fingerprint: string; value: T }>(storageKey);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new LoopError('IDEMPOTENCY_CONFLICT', '同一幂等键已用于不同的请求内容。');
      }
      return cached.value;
    }
    const active = inFlightIdempotency.get(storageKey);
    if (active) {
      if (active.fingerprint !== fingerprint) {
        throw new LoopError('IDEMPOTENCY_CONFLICT', '同一幂等键正在处理另一份请求内容。');
      }
      return active.promise as Promise<T>;
    }
    const promise = Promise.resolve(operation()).then((value) => {
      store.setIdempotent(storageKey, { fingerprint, value });
      return value;
    });
    inFlightIdempotency.set(storageKey, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      if (inFlightIdempotency.get(storageKey)?.promise === promise) inFlightIdempotency.delete(storageKey);
    }
  }

  app.addHook('onRequest', async (request, reply) => {
    if (!['localhost', '127.0.0.1', '::1'].includes(request.hostname)) {
      return reply.status(403).send({ error: { code: 'ORIGIN_DENIED', message: 'Host 未获 localhost 授权。', requestId: request.id } });
    }
    const origin = request.headers.origin;
    if (origin && origin !== config.webOrigin && origin !== `http://${config.host}:${config.port}`) {
      return reply.status(403).send({ error: { code: 'ORIGIN_DENIED', message: '来源未获 localhost 授权。', requestId: request.id } });
    }
    if (request.url.startsWith('/api/') && request.method !== 'GET' && request.url !== '/api/session') {
      if (request.headers['x-loop-session'] !== config.sessionToken) {
        return reply.status(401).send({ error: { code: 'SESSION_REQUIRED', message: '缺少有效本机会话令牌。', requestId: request.id } });
      }
    }
  });

  app.setErrorHandler((error, request, reply) => sendError(reply, request, error));
  app.addHook('onClose', async () => documents.closeWatchers());

  app.get('/api/session', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { sessionToken: config.sessionToken };
  });

  app.get('/api/bootstrap', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = z.object({ runId: z.string().optional(), projectId: z.string().optional() }).parse(request.query);
    const projects = store.listProjects();
    const currentProject = projects.find((item) => item.id === query.projectId) ?? projects[0];
    const runs = store.listRuns(currentProject?.id);
    const currentRun = runs.find((item) => item.id === query.runId) ?? runs[0];
    const payload: BootstrapPayload = {
      sessionToken: config.sessionToken,
      projects,
      runs,
      ...(currentProject ? { currentProject, documents: store.listDocuments(currentProject.id) } : { documents: [] }),
      ...(currentRun ? {
        currentRun,
        messages: store.listMessages(currentRun.id),
        tasks: store.listTasks(currentRun.id),
        agents: store.listAgents(currentRun.id),
        approvals: store.listApprovals(currentRun.id)
      } : { messages: [], tasks: [], agents: [], approvals: [] }),
      providers: await providers.configs(),
      settings: store.getSetting<AppSettings>('app')!
    };
    return payload;
  });

  app.get('/api/projects', async () => store.listProjects());
  app.post('/api/projects', async (request) => {
    return idempotent(request, 'projects:create', async () => {
      const body = z.object({ rootPath: z.string().min(1), name: z.string().optional() }).parse(request.body);
      let rootPath: string;
      try {
        rootPath = await realpath(body.rootPath);
      } catch {
        throw new LoopError('INVALID_PATH', '项目路径不存在或无法访问。');
      }
      if (!(await stat(rootPath)).isDirectory()) throw new Error('INVALID_PATH: 项目路径不是目录');
      const isGit = (await runProcess('git rev-parse --is-inside-work-tree', rootPath)).code === 0;
      const project = store.createProject({ name: body.name ?? basename(rootPath), rootPath, isGit });
      await documents.syncProject(project.id, project.rootPath);
      documents.watchProject(project.id, project.rootPath, (docIds) => {
        for (const run of store.listRuns(project.id).filter((item) => !['completed', 'cancelled', 'failed'].includes(item.state))) {
          for (const docId of docIds) void orchestrator.invalidateForDocumentChange(run.id, docId);
        }
      });
      return project;
    });
  });

  app.post('/api/projects/:id/git/init', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = store.getProject(id);
    if (!project) throw new Error('PROJECT_NOT_FOUND');
    return idempotent(request, `projects:${id}:git:init`, async () => {
      const result = await runProcess('git init', project.rootPath);
      if (result.code !== 0) throw new Error(`GIT_INIT_FAILED: ${result.output}`);
      store.updateProjectGit(id, true);
      return { ok: true, output: result.output };
    });
  });

  app.get('/api/runs', async (request) => {
    const query = z.object({ projectId: z.string().optional() }).parse(request.query);
    return store.listRuns(query.projectId);
  });

  app.post('/api/runs', async (request) => {
    return idempotent(request, 'runs:create', async () => {
      const body = z.object({
        projectId: z.string(), title: z.string().min(1), question: z.string().min(1),
        modelMode: z.enum(['fixed', 'auto']).default('fixed'),
        providerId: z.enum(['openai', 'deepseek', 'local-demo']).default('local-demo'),
        model: z.string().min(1).default('local-structured-demo')
      }).parse(request.body);
      if (!store.getProject(body.projectId)) throw new Error('PROJECT_NOT_FOUND');
      const run = store.createRun(body);
      await orchestrator.sendMessage(run.id, body.question);
      return store.getRun(run.id)!;
    });
  });

  app.get('/api/runs/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return store.getRun(id) ?? (() => { throw new Error('RUN_NOT_FOUND'); })();
  });

  app.patch('/api/runs/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return idempotent(request, `runs:${id}:action`, async () => {
      const body = z.object({ action: z.enum(['pause', 'resume', 'cancel', 'retry']) }).parse(request.body);
      const run = store.getRun(id);
      if (!run) throw new Error('RUN_NOT_FOUND');
      if (body.action === 'pause') {
        if (['paused', 'completed', 'cancelled', 'failed'].includes(run.state)) throw new Error(`RUN_STATE_CONFLICT: ${run.state} 状态不能暂停`);
        orchestrator.interrupt(id);
        return store.updateRun(id, { state: 'paused', previousState: run.state, pauseReason: '用户暂停' });
      }
      if (body.action === 'cancel') {
        if (['completed', 'cancelled'].includes(run.state)) throw new Error(`RUN_STATE_CONFLICT: ${run.state} 状态不能取消`);
        orchestrator.interrupt(id);
        return store.updateRun(id, { state: 'cancelled', previousState: run.state, pauseReason: '用户取消' });
      }
      const expectedState = body.action === 'resume' ? 'paused' : 'failed';
      if (run.state !== expectedState) throw new Error(`RUN_STATE_CONFLICT: 只有 ${expectedState} 运行可以${body.action === 'resume' ? '继续' : '重试'}`);
      const target = run.previousState && !['paused', 'failed', 'cancelled', 'completed'].includes(run.previousState)
        ? run.previousState
        : 'clarifying';
      const resumed = store.updateRun(id, { state: target, previousState: run.state, pauseReason: null });
      if (['decomposing', 'executing'].includes(resumed.state)) await orchestrator.execute(id);
      if (['integrating', 'verifying', 'optimizing'].includes(resumed.state)) await orchestrator.integrate(id);
      return resumed;
    });
  });

  app.get('/api/runs/:id/messages', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return store.listMessages(id);
  });

  app.post('/api/runs/:id/messages', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ content: z.string().min(1).max(100_000) }).parse(request.body);
    return idempotent(request, `runs:${id}:messages:create`, () => orchestrator.sendMessage(id, body.content));
  });

  app.get('/api/runs/:id/docs', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const run = store.getRun(id);
    if (!run) throw new Error('RUN_NOT_FOUND');
    return store.listDocuments(run.projectId);
  });

  app.patch('/api/runs/:id/docs/:docId', async (request) => {
    const { id, docId } = z.object({ id: z.string(), docId: z.string() }).parse(request.params);
    const body = z.object({ content: z.string().min(1).max(1_500_000) }).parse(request.body);
    return idempotent(request, `runs:${id}:docs:${docId}:save`, async () => {
      const run = store.getRun(id);
      if (!run) throw new Error('RUN_NOT_FOUND');
      const project = store.getProject(run.projectId);
      if (!project) throw new Error('PROJECT_NOT_FOUND');
      const before = store.getDocument(project.id, docId);
      const document = await documents.save(project.id, project.rootPath, docId, body.content);
      if (before?.hash !== document.hash) await orchestrator.invalidateForDocumentChange(id, docId);
      return document;
    });
  });

  // Documented collection PATCH; the per-document route above remains for the existing frontend.
  app.patch('/api/runs/:id/docs', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ docId: z.string(), content: z.string().min(1).max(1_500_000) }).parse(request.body);
    return idempotent(request, `runs:${id}:docs:${body.docId}:save`, async () => {
      const run = store.getRun(id);
      if (!run) throw new Error('RUN_NOT_FOUND');
      const project = store.getProject(run.projectId);
      if (!project) throw new Error('PROJECT_NOT_FOUND');
      const before = store.getDocument(project.id, body.docId);
      const document = await documents.save(project.id, project.rootPath, body.docId, body.content);
      if (before?.hash !== document.hash) await orchestrator.invalidateForDocumentChange(id, body.docId);
      return document;
    });
  });

  app.post('/api/runs/:id/docs/approve-all', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return idempotent(request, `runs:${id}:docs:approve-all`, () => orchestrator.approveAllDocuments(id));
  });

  app.post('/api/runs/:id/docs/:docId/approve', async (request) => {
    const { id, docId } = z.object({ id: z.string(), docId: z.string() }).parse(request.params);
    return idempotent(request, `runs:${id}:docs:${docId}:approve`, async () => {
      const result = await orchestrator.approveDocument(id, docId);
      return result.document;
    });
  });

  app.post('/api/runs/:id/execute', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const result = await idempotent(request, `runs:${id}:execute`, async () => {
      await orchestrator.execute(id);
      return { accepted: true };
    });
    return reply.status(202).send(result);
  });

  app.get('/api/runs/:id/tasks', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!store.getRun(id)) throw new Error('RUN_NOT_FOUND');
    return store.listTasks(id);
  });
  app.get('/api/runs/:id/agents', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!store.getRun(id)) throw new Error('RUN_NOT_FOUND');
    return store.listAgents(id);
  });
  app.get('/api/runs/:id/checkpoints', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!store.getRun(id)) throw new Error('RUN_NOT_FOUND');
    return store.listCheckpoints(id);
  });
  app.get('/api/runs/:id/approvals', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!store.getRun(id)) throw new Error('RUN_NOT_FOUND');
    return store.listApprovals(id);
  });

  app.post('/api/runs/:id/approvals/:approvalId', async (request) => {
    const { id, approvalId } = z.object({ id: z.string(), approvalId: z.string() }).parse(request.params);
    const body = z.object({ decision: z.enum(['approved', 'rejected']) }).parse(request.body);
    return idempotent(request, `runs:${id}:approvals:${approvalId}:resolve`, async () => {
      const approval = store.listApprovals(id).find((item) => item.id === approvalId);
      if (!approval) throw new Error('APPROVAL_NOT_FOUND');
      if (approval.status !== 'pending' && approval.status !== body.decision) {
        throw new Error('RUN_STATE_CONFLICT: 审批已经按另一结果处理');
      }
      const wasPending = approval.status === 'pending';
      if (approval.status === 'pending') store.resolveApproval(approvalId, body.decision);
      if (wasPending && approval.tool === 'merge_integration' && body.decision === 'approved') await orchestrator.integrate(id);
      if (body.decision === 'rejected') {
        const run = store.getRun(id);
        if (run && run.state !== 'paused') {
          orchestrator.interrupt(id);
          store.updateRun(id, { state: 'paused', previousState: run.state, pauseReason: `审批 ${approvalId} 已拒绝` });
        }
      }
      return { ok: true };
    });
  });

  // Documented collection POST; the resource route above remains frontend-compatible.
  app.post('/api/runs/:id/approvals', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ approvalId: z.string(), decision: z.enum(['approved', 'rejected']) }).parse(request.body);
    return idempotent(request, `runs:${id}:approvals:${body.approvalId}:resolve`, async () => {
      const approval = store.listApprovals(id).find((item) => item.id === body.approvalId);
      if (!approval) throw new Error('APPROVAL_NOT_FOUND');
      if (approval.status !== 'pending' && approval.status !== body.decision) {
        throw new Error('RUN_STATE_CONFLICT: 审批已经按另一结果处理');
      }
      const wasPending = approval.status === 'pending';
      if (approval.status === 'pending') store.resolveApproval(body.approvalId, body.decision);
      if (wasPending && approval.tool === 'merge_integration' && body.decision === 'approved') await orchestrator.integrate(id);
      if (body.decision === 'rejected') {
        const run = store.getRun(id);
        if (run && run.state !== 'paused') {
          orchestrator.interrupt(id);
          store.updateRun(id, { state: 'paused', previousState: run.state, pauseReason: `审批 ${body.approvalId} 已拒绝` });
        }
      }
      return { ok: true };
    });
  });

  app.get('/api/providers', async () => providers.configs());
  app.patch('/api/providers/:providerId', async (request) => {
    const { providerId } = z.object({ providerId: z.enum(['openai', 'deepseek']) }).parse(request.params);
    const body = z.object({ apiKey: z.string().min(8).optional(), clear: z.boolean().optional() }).parse(request.body);
    return idempotent(request, `providers:${providerId}:configure`, async () => {
      if (body.clear) await credentials.delete(providerId as ProviderId);
      if (body.apiKey) await credentials.set(providerId as ProviderId, body.apiKey);
      return (await providers.configs()).find((item) => item.id === providerId);
    });
  });

  app.patch('/api/providers', async (request) => {
    const body = z.object({
      providerId: z.enum(['openai', 'deepseek']),
      apiKey: z.string().min(8).optional(),
      clear: z.boolean().optional()
    }).parse(request.body);
    return idempotent(request, `providers:${body.providerId}:configure`, async () => {
      if (body.clear) await credentials.delete(body.providerId);
      if (body.apiKey) await credentials.set(body.providerId, body.apiKey);
      return (await providers.configs()).find((item) => item.id === body.providerId);
    });
  });

  app.get('/api/settings', async () => store.getSetting<AppSettings>('app'));
  app.patch('/api/settings', async (request) => {
    const current = store.getSetting<AppSettings>('app')!;
    const body = z.object({
      concurrency: z.number().int().min(1).max(16).optional(),
      maxDepth: z.number().int().min(1).max(4).optional(),
      maxAgents: z.number().int().min(1).max(200).optional(),
      mainDirectLimit: z.number().int().min(1).max(30).optional(),
      autoMode: z.boolean().optional(),
      budget: z.object({
        maxCalls: z.number().int().positive().optional(),
        maxInputTokens: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        maxMinutes: z.number().positive().optional(),
        maxEstimatedCost: z.number().nonnegative().optional()
      }).optional()
    }).parse(request.body);
    return idempotent(request, 'settings:update', () => {
      const { budget: budgetPatch, ...settingsPatch } = body;
      const budget: AppSettings['budget'] = { ...current.budget };
      if (budgetPatch?.maxCalls !== undefined) budget.maxCalls = budgetPatch.maxCalls;
      if (budgetPatch?.maxInputTokens !== undefined) budget.maxInputTokens = budgetPatch.maxInputTokens;
      if (budgetPatch?.maxOutputTokens !== undefined) budget.maxOutputTokens = budgetPatch.maxOutputTokens;
      if (budgetPatch?.maxMinutes !== undefined) budget.maxMinutes = budgetPatch.maxMinutes;
      if (budgetPatch?.maxEstimatedCost !== undefined) budget.maxEstimatedCost = budgetPatch.maxEstimatedCost;
      const next: AppSettings = { ...current, budget };
      if (settingsPatch.concurrency !== undefined) next.concurrency = settingsPatch.concurrency;
      if (settingsPatch.maxDepth !== undefined) next.maxDepth = settingsPatch.maxDepth;
      if (settingsPatch.maxAgents !== undefined) next.maxAgents = settingsPatch.maxAgents;
      if (settingsPatch.mainDirectLimit !== undefined) next.mainDirectLimit = settingsPatch.mainDirectLimit;
      if (settingsPatch.autoMode !== undefined) next.autoMode = settingsPatch.autoMode;
      if (next.mainDirectLimit > next.maxAgents) throw new LoopError('INVALID_REQUEST', 'mainDirectLimit 不能大于 maxAgents。');
      store.setSetting('app', next);
      return next;
    });
  });

  app.get('/api/runs/:id/export', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const run = store.getRun(id);
    if (!run) throw new Error('RUN_NOT_FOUND');
    const project = store.getProject(run.projectId);
    if (!project) throw new Error('PROJECT_NOT_FOUND');
    const messages = store.listMessages(id);
    const tasks = store.listTasks(id);
    const events: ReturnType<LoopStore['listEvents']> = [];
    let eventCursor = 0;
    while (true) {
      const page = store.listEvents(id, eventCursor, 10_000);
      events.push(...page);
      if (page.length < 10_000) break;
      eventCursor = page.at(-1)?.id ?? eventCursor;
    }
    const content = [
      '---',
      'loop_schema: 1',
      `run_id: ${run.id}`,
      `state: ${run.state}`,
      `exported_at: ${new Date().toISOString()}`,
      '---',
      '',
      `# ${run.title}`,
      '',
      `项目：${project.name}`,
      '',
      '## 问题',
      '',
      run.question,
      '',
      '## 对话',
      '',
      ...messages.flatMap((message) => [`### ${message.role} · ${message.createdAt}`, '', message.content, '']),
      '## 任务',
      '',
      ...tasks.map((task) => `- [${task.status === 'completed' ? 'x' : ' '}] ${task.id} ${task.title}（${task.status}）`),
      '',
      '## 事件摘要',
      '',
      ...events.map((event) => `- ${event.id} · ${event.createdAt} · ${event.type}`),
      ''
    ].join('\n');
    return { filename: `loop-run-${run.id}.md`, content };
  });

  app.get('/api/runs/:id/events', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!store.getRun(id)) throw new Error('RUN_NOT_FOUND');
    const header = z.coerce.number().int().nonnegative().parse(request.headers['last-event-id'] ?? 0);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const writeEvent = (event: unknown & { id?: number; type?: string }) => {
      reply.raw.write(`id: ${event.id ?? ''}\nevent: ${event.type ?? 'message'}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    let replaying = true;
    const buffered: { id?: number; type?: string }[] = [];
    const listener = (event: unknown) => {
      const typed = event as { id?: number; type?: string };
      if (replaying) buffered.push(typed);
      else writeEvent(typed);
    };
    store.events.on(`run:${id}`, listener);
    const watermark = store.getEventWatermark(id);
    let cursor = header;
    while (cursor < watermark) {
      const page = store.listEvents(id, cursor, 1000, watermark);
      if (page.length === 0) break;
      for (const event of page) writeEvent(event);
      cursor = page.at(-1)?.id ?? watermark;
    }
    replaying = false;
    for (const event of buffered.filter((item) => (item.id ?? 0) > watermark).sort((left, right) => (left.id ?? 0) - (right.id ?? 0))) {
      writeEvent(event);
    }
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      store.events.off(`run:${id}`, listener);
    });
  });

  const webDist = resolve(repoRoot, 'apps', 'web', 'dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
  }
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || !existsSync(webDist)) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在', requestId: request.id } });
    }
    return reply.sendFile('index.html');
  });

  await ensureSeed(context);
  return context;
}
