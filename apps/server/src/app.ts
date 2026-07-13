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
import { Orchestrator } from './orchestrator.js';
import { ProviderRegistry } from './providers.js';
import { runProcess } from './security.js';
import { LoopStore } from './store.js';
import { WorktreeManager } from './worktrees.js';

const errorCodes = new Set([
  'INVALID_PATH', 'PATH_ESCAPE', 'SESSION_REQUIRED', 'DOCS_NOT_APPROVED', 'DOC_VERSION_STALE',
  'BUDGET_EXCEEDED', 'APPROVAL_REQUIRED', 'PROVIDER_NOT_CONFIGURED', 'PROVIDER_RATE_LIMITED',
  'WORKTREE_CONFLICT', 'RUN_STATE_CONFLICT', 'PROJECT_NOT_GIT', 'WORKTREE_DIRTY'
]);

function requestId(request: FastifyRequest): string {
  return request.id;
}

function sendError(reply: FastifyReply, request: FastifyRequest, error: unknown): FastifyReply {
  const message = error instanceof Error ? error.message : String(error);
  const token = message.split(/[:\s]/)[0] ?? 'INTERNAL_ERROR';
  const code = errorCodes.has(token) ? token : 'INTERNAL_ERROR';
  const status = code === 'SESSION_REQUIRED' ? 401 : code === 'INTERNAL_ERROR' ? 500 : 409;
  return reply.status(status).send({ error: { code, message, requestId: requestId(request) } });
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
  let project = context.store.listProjects()[0];
  if (!project) {
    const rootPath = await realpath(config.defaultProjectRoot);
    const isGit = (await runProcess('git rev-parse --is-inside-work-tree', rootPath)).code === 0;
    project = context.store.createProject({ name: basename(rootPath), rootPath, isGit });
  }
  await context.documents.syncProject(project.id, project.rootPath);
  context.documents.watchProject(project.id, project.rootPath, (docIds) => {
    for (const run of context.store.listRuns(project!.id)) {
      if (!['completed', 'cancelled', 'failed'].includes(run.state)) {
        for (const docId of docIds) void context.orchestrator.invalidateForDocumentChange(run.id, docId);
      }
    }
  });
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
  const staleDocuments = context.store.listDocuments(project.id).filter((doc) => doc.status === 'stale');
  if (staleDocuments.length > 0) {
    for (const projectRun of context.store.listRuns(project.id).filter((item) => !['completed', 'cancelled', 'failed'].includes(item.state))) {
      for (const doc of staleDocuments) await context.orchestrator.invalidateForDocumentChange(projectRun.id, doc.id);
    }
  }
  for (const activeRun of context.store.listRuns(project.id).filter((item) =>
    ['decomposing', 'executing', 'integrating', 'verifying', 'optimizing'].includes(item.state)
  )) {
    context.store.updateRun(activeRun.id, {
      state: 'paused',
      previousState: activeRun.state,
      pauseReason: '服务器重启后已从事件记录恢复，请确认后继续。'
    });
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

  app.addHook('onRequest', async (request, reply) => {
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

  app.get('/api/session', async () => ({ sessionToken: config.sessionToken }));

  app.get('/api/bootstrap', async (request) => {
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
    const body = z.object({ rootPath: z.string().min(1), name: z.string().optional() }).parse(request.body);
    const rootPath = await realpath(body.rootPath);
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

  app.post('/api/projects/:id/git/init', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = store.listProjects().find((item) => item.id === id);
    if (!project) throw new Error('PROJECT_NOT_FOUND');
    const result = await runProcess('git init', project.rootPath);
    if (result.code !== 0) throw new Error(`GIT_INIT_FAILED: ${result.output}`);
    store.updateProjectGit(id, true);
    return { ok: true, output: result.output };
  });

  app.get('/api/runs', async (request) => {
    const query = z.object({ projectId: z.string().optional() }).parse(request.query);
    return store.listRuns(query.projectId);
  });

  app.post('/api/runs', async (request) => {
    const body = z.object({
      projectId: z.string(), title: z.string().min(1), question: z.string().min(1),
      modelMode: z.enum(['fixed', 'auto']).default('fixed'),
      providerId: z.enum(['openai', 'deepseek', 'local-demo']).default('local-demo'),
      model: z.string().default('local-structured-demo')
    }).parse(request.body);
    const run = store.createRun(body);
    await orchestrator.sendMessage(run.id, body.question);
    return store.getRun(run.id);
  });

  app.get('/api/runs/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return store.getRun(id) ?? (() => { throw new Error('RUN_NOT_FOUND'); })();
  });

  app.patch('/api/runs/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ action: z.enum(['pause', 'resume', 'cancel']) }).parse(request.body);
    const run = store.getRun(id);
    if (!run) throw new Error('RUN_NOT_FOUND');
    if (body.action === 'pause') return store.updateRun(id, { state: 'paused', previousState: run.state, pauseReason: '用户暂停' });
    if (body.action === 'cancel') return store.updateRun(id, { state: 'cancelled', previousState: run.state, pauseReason: '用户取消' });
    const resumed = store.updateRun(id, { state: run.previousState ?? 'clarifying', previousState: 'paused' });
    if (['decomposing', 'executing', 'integrating', 'verifying', 'optimizing'].includes(resumed.state)) {
      await orchestrator.execute(id);
    }
    return resumed;
  });

  app.get('/api/runs/:id/messages', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return store.listMessages(id);
  });

  app.post('/api/runs/:id/messages', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ content: z.string().min(1).max(100_000) }).parse(request.body);
    return orchestrator.sendMessage(id, body.content);
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
    const run = store.getRun(id);
    if (!run) throw new Error('RUN_NOT_FOUND');
    const project = store.listProjects().find((item) => item.id === run.projectId);
    if (!project) throw new Error('PROJECT_NOT_FOUND');
    const document = await documents.save(project.id, project.rootPath, docId, body.content);
    await orchestrator.invalidateForDocumentChange(id, docId);
    return document;
  });

  app.post('/api/runs/:id/docs/approve-all', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return orchestrator.approveAllDocuments(id);
  });

  app.post('/api/runs/:id/docs/:docId/approve', async (request) => {
    const { id, docId } = z.object({ id: z.string(), docId: z.string() }).parse(request.params);
    const run = store.getRun(id);
    if (!run) throw new Error('RUN_NOT_FOUND');
    return store.approveDocument(run.projectId, docId);
  });

  app.post('/api/runs/:id/execute', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await orchestrator.execute(id);
    return reply.status(202).send({ accepted: true });
  });

  app.get('/api/runs/:id/tasks', async (request) => store.listTasks(z.object({ id: z.string() }).parse(request.params).id));
  app.get('/api/runs/:id/agents', async (request) => store.listAgents(z.object({ id: z.string() }).parse(request.params).id));
  app.get('/api/runs/:id/approvals', async (request) => store.listApprovals(z.object({ id: z.string() }).parse(request.params).id));

  app.post('/api/runs/:id/approvals/:approvalId', async (request) => {
    const { id, approvalId } = z.object({ id: z.string(), approvalId: z.string() }).parse(request.params);
    const body = z.object({ decision: z.enum(['approved', 'rejected']) }).parse(request.body);
    const approval = store.listApprovals(id).find((item) => item.id === approvalId);
    if (!approval) throw new Error('APPROVAL_NOT_FOUND');
    store.resolveApproval(approvalId, body.decision);
    if (approval.tool === 'merge_integration' && body.decision === 'approved') await orchestrator.integrate(id);
    return { ok: true };
  });

  app.get('/api/providers', async () => providers.configs());
  app.patch('/api/providers/:providerId', async (request) => {
    const { providerId } = z.object({ providerId: z.enum(['openai', 'deepseek']) }).parse(request.params);
    const body = z.object({ apiKey: z.string().min(8).optional(), clear: z.boolean().optional() }).parse(request.body);
    if (body.clear) await credentials.delete(providerId as ProviderId);
    if (body.apiKey) await credentials.set(providerId as ProviderId, body.apiKey);
    return (await providers.configs()).find((item) => item.id === providerId);
  });

  app.get('/api/settings', async () => store.getSetting<AppSettings>('app'));
  app.patch('/api/settings', async (request) => {
    const current = store.getSetting<AppSettings>('app')!;
    const body = z.object({
      concurrency: z.number().int().min(1).max(16).optional(),
      maxDepth: z.number().int().min(1).max(4).optional(),
      maxAgents: z.number().int().min(1).max(200).optional(),
      autoMode: z.boolean().optional()
    }).parse(request.body);
    const next = { ...current, ...body };
    store.setSetting('app', next);
    return next;
  });

  app.get('/api/runs/:id/events', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const header = Number(request.headers['last-event-id'] ?? 0);
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
    for (const event of store.listEvents(id, header)) writeEvent(event);
    const listener = (event: unknown) => writeEvent(event as { id?: number; type?: string });
    store.events.on(`run:${id}`, listener);
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      store.events.off(`run:${id}`, listener);
    });
  });

  const webDist = resolve(repoRoot, 'apps', 'web', 'dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在', requestId: request.id } });
      return reply.sendFile('index.html');
    });
  }

  await ensureSeed(context);
  return context;
}
