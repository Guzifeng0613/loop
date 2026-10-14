import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import {
  acceptanceRequestSchema,
  createMessageRequestSchema,
  createProjectRequestSchema,
  createRunRequestSchema,
  paginationQuerySchema,
  resolveApprovalRequestSchema,
  runRecoveryRequestSchema,
  runRecoverySummarySchema,
  runActionRequestSchema,
  saveDocumentRequestSchema,
  settingsPatchSchema,
  type AppSettings,
  type BootstrapPayload,
  type Diagnostics,
  type LoopDocument,
  type ProviderId,
  type RecoveryDecisionRecord,
  type RecoveryEvidence,
  type RunRecoveryDecision,
  type RunState
} from '@loop/contracts';
import { config, dataDirectory, repoRoot } from './config.js';
import { CredentialStore } from './credentials.js';
import { DocumentService } from './documents.js';
import { LoopError, normalizeError } from './errors.js';
import { openApiDocument } from './openapi.js';
import { Orchestrator } from './orchestrator.js';
import { ProviderRegistry } from './providers.js';
import { runProcess } from './security.js';
import { LoopStore } from './store.js';
import { WorktreeManager } from './worktrees.js';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function pickLocalDirectory(): Promise<{ path: string | null; cancelled: boolean }> {
  if (process.platform !== 'win32') return { path: null, cancelled: true };
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.Description = "选择 Loop 项目文件夹"',
    '$dialog.ShowNewFolderButton = $false',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }'
  ].join('; ');
  try {
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true, maxBuffer: 32_000 });
    const path = result.stdout.trim();
    return path ? { path, cancelled: false } : { path: null, cancelled: true };
  } catch {
    return { path: null, cancelled: true };
  }
}

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

function pageCollection<T>(items: T[], rawQuery: unknown, defaultLimit = 100): { items: T[]; nextCursor?: string } {
  const query = paginationQuerySchema.parse(rawQuery);
  const limit = query.limit ?? defaultLimit;
  let offset = 0;
  if (query.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as { offset?: unknown };
      if (!Number.isInteger(decoded.offset) || Number(decoded.offset) < 0) throw new Error('invalid');
      offset = Number(decoded.offset);
    } catch {
      throw new LoopError('INVALID_REQUEST', 'cursor 无效或已经过期。');
    }
  }
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    ...(nextOffset < items.length
      ? { nextCursor: Buffer.from(JSON.stringify({ offset: nextOffset })).toString('base64url') }
      : {})
  };
}

function documentMetadata(document: LoopDocument): LoopDocument {
  return { ...document, content: '', contentLoaded: false };
}

function documentWithContent(document: LoopDocument): LoopDocument {
  return { ...document, contentLoaded: true };
}

export interface AppContext {
  app: FastifyInstance;
  store: LoopStore;
  documents: DocumentService;
  orchestrator: Orchestrator;
  credentials: CredentialStore;
  providers: ProviderRegistry;
  worktrees: WorktreeManager;
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
      for (const reservation of context.store.listBudgetReservations(activeRun.id).filter((item) => item.status === 'reserved')) {
        context.store.markBudgetReservationUnknown(reservation.id);
      }
      for (const agent of context.store.listAgents(activeRun.id).filter((item) => item.status === 'running')) {
        context.store.upsertAgent({ ...agent, status: 'archived' });
      }
      const message = '服务器重启后已从事件记录恢复，请确认后继续。';
      context.store.updateRun(activeRun.id, {
        state: 'paused',
        previousState: activeRun.state,
        pauseReason: message,
        blocker: {
          kind: 'restart', code: 'SERVER_RESTARTED', message, since: new Date().toISOString(), recoverable: true,
          details: {
            actionAttemptIds: context.store.listRecoverableActionAttempts(activeRun.id).map((item) => item.id),
            unknownBudgetReservationIds: context.store.listBudgetReservations(activeRun.id)
              .filter((item) => item.status === 'unknown').map((item) => item.id)
          }
        }
      });
    }
    const projectRunIds = new Set(context.store.listRuns(project.id).map((item) => item.id));
    for (const artifact of context.store.listWorktreeArtifacts().filter((item) => projectRunIds.has(item.runId) && !existsSync(item.path))) {
      context.store.upsertWorktreeArtifact({ ...artifact, status: 'orphaned' });
    }
    for (const artifact of context.store.listExpiredWorktreeArtifacts().filter((item) => projectRunIds.has(item.runId))) {
      try {
        await context.worktrees.cleanupArtifact(project.rootPath, artifact.path, artifact.commitSha);
        context.store.markWorktreeArtifactCleaned(artifact.id);
      } catch (error) {
        context.store.appendEvent(artifact.runId, 'error', {
          code: 'WORKTREE_CLEANUP_FAILED',
          message: error instanceof Error ? error.message : String(error),
          artifactId: artifact.id
        });
      }
    }
    const knownBranches = new Set(context.store.listWorktreeArtifacts().filter((item) => projectRunIds.has(item.runId)).map((item) => item.branch));
    const knownPaths = new Set(context.store.listWorktreeArtifacts().filter((item) => projectRunIds.has(item.runId)).map((item) => resolve(item.path).toLowerCase()));
    for (const projectRun of context.store.listRuns(project.id)) {
      const orphanPaths = (await context.worktrees.listRegisteredPaths(projectRun.id))
        .filter((path) => !knownPaths.has(resolve(path).toLowerCase()));
      if (orphanPaths.length > 0) {
        context.store.appendEvent(projectRun.id, 'error', { code: 'ORPHAN_WORKTREE_DETECTED', paths: orphanPaths });
      }
    }
    const orphanBranches = (await context.worktrees.listLoopBranches(project.rootPath)).filter((branch) => !knownBranches.has(branch));
    const projectRuns = context.store.listRuns(project.id);
    if (orphanBranches.length > 0 && projectRuns[0]) {
      context.store.appendEvent(projectRuns[0].id, 'error', { code: 'ORPHAN_BRANCH_DETECTED', branches: orphanBranches });
    }
    const storage = await context.worktrees.storageUsage();
    if (storage.ratio >= 0.8 && projectRuns[0]) {
      context.store.appendEvent(projectRuns[0].id, 'error', { code: 'WORKTREE_QUOTA_WARNING', ...storage });
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
      executionMode: 'simple',
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
  const context: AppContext = { app, store, documents, orchestrator, credentials, providers, worktrees };
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

  async function resolveRunApproval(
    runId: string,
    approvalId: string,
    decision: 'approved' | 'rejected',
    scope: 'once' | 'rule'
  ): Promise<{ ok: true; approval: ReturnType<LoopStore['resolveApproval']> }> {
    const before = store.getApproval(approvalId);
    if (!before || before.runId !== runId) throw new Error('APPROVAL_NOT_FOUND');
    const blockedRun = store.getRun(runId);
    const approval = store.resolveApproval(approvalId, decision, scope);
    if (decision === 'rejected') {
      if (approval.actionAttemptId) {
        const attempt = store.getActionAttempt(approval.actionAttemptId);
        if (attempt && !['completed', 'failed', 'cancelled'].includes(attempt.status)) store.failActionAttempt(attempt.id, 'APPROVAL_REJECTED');
        if (attempt?.taskId) {
          const task = store.listTasks(runId).find((item) => item.id === attempt.taskId);
          if (task) store.upsertTask({ ...task, status: 'blocked' });
        }
      }
      const run = store.getRun(runId);
      if (run) {
        const message = `审批 ${approvalId} 已拒绝`;
        orchestrator.interrupt(runId);
        store.updateRun(runId, {
          state: 'paused', previousState: run.state === 'paused' ? (run.previousState ?? 'executing') : run.state, pauseReason: message,
          blocker: { kind: 'user_pause', code: 'APPROVAL_REJECTED', message, since: new Date().toISOString(), recoverable: true }
        });
      }
      return { ok: true, approval };
    }

    const run = store.getRun(runId);
    const nextPending = store.listApprovals(runId).find((item) => item.status === 'pending');
    if (approval.tool === 'merge_integration' && blockedRun?.state === 'paused' && blockedRun.blocker?.kind === 'approval' && !nextPending) {
      store.updateRun(runId, { state: 'awaiting_acceptance', previousState: 'paused', blocker: null, pauseReason: null });
      await orchestrator.acceptDelivery(runId, 'accept_merge');
      return { ok: true, approval };
    }
    if (blockedRun?.state === 'paused' && blockedRun.blocker?.kind === 'approval' && !nextPending) {
      const target = blockedRun.previousState && !['paused', 'failed', 'cancelled', 'completed'].includes(blockedRun.previousState)
        ? blockedRun.previousState
        : 'executing';
      const resumed = store.updateRun(runId, { state: target, previousState: 'paused', blocker: null, pauseReason: null });
      if (['decomposing', 'executing'].includes(resumed.state)) await orchestrator.execute(runId);
      if (['integrating', 'verifying'].includes(resumed.state)) await orchestrator.integrate(runId);
    } else if ((blockedRun?.blocker?.kind === 'approval' || run?.blocker?.kind === 'approval') && nextPending) {
      store.updateRun(runId, {
        blocker: {
          kind: 'approval', code: 'APPROVAL_REQUIRED', message: nextPending.policyReason,
          since: nextPending.createdAt, recoverable: true, approvalId: nextPending.id
        }
      });
    }
    return { ok: true, approval };
  }

  function recoveryActionIds(details: Record<string, unknown> | undefined): string[] {
    const ids = new Set<string>();
    const single = details?.actionAttemptId;
    if (typeof single === 'string') ids.add(single);
    const many = details?.actionAttemptIds;
    if (Array.isArray(many)) {
      for (const item of many) if (typeof item === 'string') ids.add(item);
    }
    return [...ids];
  }

  function buildRecoverySummary(runId: string) {
    const run = store.getRun(runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    const actionIds = recoveryActionIds(run.blocker?.details);
    const allRecoverable = store.listRecoverableActionAttempts(runId);
    const actionAttempts = actionIds.length
      ? actionIds.map((id) => store.getActionAttempt(id)).filter((item): item is NonNullable<typeof item> => Boolean(item))
      : allRecoverable;
    const unknownBudgetReservations = store.listBudgetReservations(runId).filter((item) => item.status === 'unknown');
    const worktreeArtifacts = store.listWorktreeArtifacts(runId);
    const recentEvents = store.listRecentEvents(runId, 50);
    const unknownOutcome = run.blocker?.code === 'ACTION_OUTCOME_UNKNOWN';
    const interrupted = ['paused', 'failed'].includes(run.state);
    const evidence = buildRecoveryEvidence(run, actionAttempts, unknownBudgetReservations, worktreeArtifacts, recentEvents);
    const canAct = interrupted && Boolean(run.blocker?.recoverable);
    const supportsOutcomeDecision = unknownOutcome || run.blocker?.kind === 'restart';
    const recoveryActions = [
      { decision: 'confirm_completed', label: '核对后确认完成', available: canAct && supportsOutcomeDecision, disabledReason: supportsOutcomeDecision ? undefined : '当前阻塞没有结果未知的动作', risk: 'high' },
      { decision: 'fail_and_retry', label: '标记失败并重试', available: canAct && supportsOutcomeDecision, disabledReason: supportsOutcomeDecision ? undefined : '当前阻塞没有可安全重试的未知动作', risk: 'high' },
      { decision: 'resume', label: '解决原因后继续', available: canAct && !unknownOutcome, disabledReason: unknownOutcome ? '必须先核对未知动作结果' : undefined, risk: 'medium' },
      { decision: 'abandon_generation', label: '放弃当前 generation', available: canAct, disabledReason: canAct ? undefined : '当前运行不可恢复', risk: 'high' }
    ] as const;
    const decisionHistory = recentEvents.flatMap((event) => {
      if (event.type !== 'recovery.decided' || !event.payload || typeof event.payload !== 'object') return [];
      const recovery = (event.payload as { recovery?: unknown }).recovery;
      return recovery ? [recovery] : [];
    });
    return runRecoverySummarySchema.parse({
      run,
      ...(run.blocker ? { blocker: run.blocker } : {}),
      recoverable: recoveryActions.some((action) => action.available),
      actionAttempts,
      unknownBudgetReservations,
      worktreeArtifacts,
      recentEvents,
      evidence,
      recoveryActions,
      decisionHistory,
      createdAt: new Date().toISOString()
    });
  }

  function buildRecoveryEvidence(run: NonNullable<ReturnType<LoopStore['getRun']>>, actionAttempts: ReturnType<LoopStore['listRecoverableActionAttempts']>, unknownBudgets: ReturnType<LoopStore['listBudgetReservations']>, artifacts: ReturnType<LoopStore['listWorktreeArtifacts']>, recentEvents: ReturnType<LoopStore['listRecentEvents']>): RecoveryEvidence {
    const blockerCode = run.blocker?.code ?? 'UNKNOWN_BLOCKER';
    const affectedResources = [
      ...artifacts.map((artifact) => `${artifact.branch} @ ${artifact.commitSha ?? artifact.baseRef}`),
      ...actionAttempts.map((attempt) => attempt.taskId ? `task:${attempt.taskId}` : `action:${attempt.id}`)
    ];
    const checks: RecoveryEvidence['checks'] = [
      { id: 'blocker', label: '阻塞记录', status: run.blocker ? 'passed' : 'unknown', detail: run.blocker?.message ?? '没有结构化阻塞记录' },
      { id: 'actions', label: '动作结果', status: actionAttempts.length ? 'warning' : 'passed', detail: actionAttempts.length ? `${actionAttempts.length} 个动作需要人工核对` : '没有待核对动作' },
      { id: 'budget', label: '预算预留', status: unknownBudgets.length ? 'warning' : 'passed', detail: unknownBudgets.length ? `${unknownBudgets.length} 笔预留结果未知` : '预算记录一致' },
      { id: 'worktree', label: 'Worktree 产物', status: artifacts.length ? 'passed' : 'unknown', detail: artifacts.length ? `${artifacts.length} 个登记产物可供核对` : '没有可核对的登记产物' },
      { id: 'events', label: '事件线索', status: recentEvents.length ? 'passed' : 'unknown', detail: recentEvents.length ? `已加载最近 ${recentEvents.length} 条事件` : '没有事件线索' }
    ];
    if (['WORKTREE_BASE_DRIFT', 'INTEGRATION_CONFLICT', 'ACCEPTANCE_FAILED', 'ACTION_OUTCOME_UNKNOWN'].includes(blockerCode)) {
      checks.push({ id: 'git-head', label: 'Git HEAD 与基线', status: 'warning', detail: `需要在 IDE 中核对运行基线 ${run.baseRef} 与当前项目 HEAD` });
    }
    return {
      knownFacts: [
        `运行在 ${run.previousState ?? run.state} 阶段中断`,
        `阻塞代码 ${blockerCode}`,
        `${actionAttempts.length} 个相关动作，${artifacts.length} 个 worktree 产物`
      ],
      unknownFacts: [
        ...(actionAttempts.length ? ['中断前动作是否已产生完整副作用'] : []),
        ...(unknownBudgets.length ? ['模型调用实际 token 与费用'] : []),
        ...(['WORKTREE_BASE_DRIFT', 'INTEGRATION_CONFLICT', 'ACCEPTANCE_FAILED'].includes(blockerCode) ? ['当前 HEAD 与运行基线之间的人工变更归属'] : [])
      ],
      checks,
      affectedResources,
      actionSummaries: actionAttempts.map((attempt) => `${attempt.sequence}. ${attempt.action.type} · ${attempt.status}`),
      ...(typeof run.blocker?.details?.currentHead === 'string' ? { currentHead: run.blocker.details.currentHead } : {})
    };
  }

  function recordRecoveryDecision(runId: string, decision: RunRecoveryDecision, note: string | undefined, fromState: RunState, toState: RunState, blockerCode: string, evidence: RecoveryEvidence): RecoveryDecisionRecord {
    const run = store.getRun(runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    const record: RecoveryDecisionRecord = {
      id: randomUUID(), runId, generation: run.generation, decision, actor: 'local-user', note: note?.trim() ?? '',
      fromState, toState, blockerCode, evidence, result: 'applied', createdAt: new Date().toISOString()
    };
    store.appendEvent(runId, 'recovery.decided', { recovery: record });
    return record;
  }

  async function recoverRun(runId: string, decision: RunRecoveryDecision, note?: string) {
    const run = store.getRun(runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    if (!['paused', 'failed'].includes(run.state)) throw new Error('RUN_STATE_CONFLICT: 只有已中断运行可以执行恢复操作');
    if (!run.blocker?.recoverable) throw new Error('RUN_STATE_CONFLICT: 当前阻塞不可自动恢复');
    const actionIds = recoveryActionIds(run.blocker.details);
    const attempts = actionIds.length
      ? actionIds.map((id) => store.getActionAttempt(id)).filter((item): item is NonNullable<typeof item> => Boolean(item))
      : store.listRecoverableActionAttempts(runId);
    const settleUnknownBudgets = () => {
      for (const reservation of store.listBudgetReservations(runId).filter((item) => item.status === 'unknown')) {
        store.settleBudgetReservation(reservation.id, {
          calls: reservation.reservedCalls,
          inputTokens: reservation.reservedInputTokens,
          outputTokens: reservation.reservedOutputTokens,
          actualCost: reservation.reservedCost
        });
      }
    };
    const target = run.previousState && !['paused', 'failed', 'cancelled', 'completed'].includes(run.previousState)
      ? run.previousState
      : 'executing';
    const evidence = buildRecoveryEvidence(run, attempts, store.listBudgetReservations(runId).filter((item) => item.status === 'unknown'), store.listWorktreeArtifacts(runId), store.listRecentEvents(runId, 50));

    if (decision === 'abandon_generation') {
      orchestrator.interrupt(runId);
      settleUnknownBudgets();
      const project = store.getProject(run.projectId);
      if (!project) throw new Error('PROJECT_NOT_FOUND');
      const docRefs = store.listDocuments(project.id).map((document) => ({
        docId: document.id,
        version: document.version,
        hash: document.hash,
        sections: []
      }));
      store.createPlanGeneration(runId, docRefs, note?.trim() || '用户放弃结果未知的计划代次，回到规范评审');
      store.appendEvent(runId, 'error', { code: 'RUN_GENERATION_ABANDONED', message: note?.trim() || '已放弃当前 generation，等待重新批准规范。' });
      recordRecoveryDecision(runId, decision, note, run.state, 'doc_review', run.blocker.code, evidence);
      return buildRecoverySummary(runId);
    }

    if (decision === 'confirm_completed') {
      settleUnknownBudgets();
      for (const attempt of attempts) {
        if (['completed', 'failed', 'cancelled'].includes(attempt.status)) continue;
        let current = attempt;
        if (current.status === 'pending') current = store.claimActionAttempt(current.id);
        if (current.status === 'waiting_approval') throw new Error('APPROVAL_REQUIRED: 等待审批的动作不能直接确认为完成');
        if (current.action.type === 'call_tool') {
          const tool = current.action.tool;
          const output = store.createToolOutput({
            runId,
            ...(current.taskId ? { taskId: current.taskId } : {}),
            actionAttemptId: current.id,
            tool,
            content: `人工核对确认动作已完成。${note?.trim() ? `\n\n${note.trim()}` : ''}`
          });
          store.completeActionAttempt(current.id, output.id);
        } else {
          store.completeActionAttempt(current.id);
        }
        if (current.taskId) {
          const task = store.listTasks(runId).find((item) => item.id === current.taskId);
          if (task && task.status === 'blocked') store.upsertTask({ ...task, status: 'running' });
        }
      }
      const resumed = store.updateRun(runId, { state: target, previousState: run.state, blocker: null, pauseReason: null });
      recordRecoveryDecision(runId, decision, note, run.state, resumed.state, run.blocker.code, evidence);
      if (['decomposing', 'executing'].includes(resumed.state)) await orchestrator.execute(runId);
      if (['integrating', 'verifying', 'optimizing'].includes(resumed.state)) await orchestrator.integrate(runId);
      return buildRecoverySummary(runId);
    }

    if (decision === 'fail_and_retry') {
      settleUnknownBudgets();
      for (const attempt of attempts) {
        if (!['completed', 'failed', 'cancelled'].includes(attempt.status)) {
          store.failActionAttempt(attempt.id, note?.trim() || 'USER_MARKED_OUTCOME_FAILED');
        }
        if (attempt.taskId) {
          const task = store.listTasks(runId).find((item) => item.id === attempt.taskId);
          if (task && task.status === 'blocked') store.upsertTask({ ...task, status: 'running' });
        }
      }
      const resumed = store.updateRun(runId, { state: target, previousState: run.state, blocker: null, pauseReason: null });
      recordRecoveryDecision(runId, decision, note, run.state, resumed.state, run.blocker.code, evidence);
      if (['decomposing', 'executing'].includes(resumed.state)) await orchestrator.execute(runId);
      if (['integrating', 'verifying', 'optimizing'].includes(resumed.state)) await orchestrator.integrate(runId);
      return buildRecoverySummary(runId);
    }

    if (run.blocker.code === 'ACTION_OUTCOME_UNKNOWN') {
      throw new Error('RUN_STATE_CONFLICT: 结果未知的动作必须先确认完成、标记失败或放弃 generation');
    }
    const resumed = store.updateRun(runId, { state: target, previousState: run.state, blocker: null, pauseReason: null });
    recordRecoveryDecision(runId, decision, note, run.state, resumed.state, run.blocker.code, evidence);
    if (['decomposing', 'executing'].includes(resumed.state)) await orchestrator.execute(runId);
    if (['integrating', 'verifying', 'optimizing'].includes(resumed.state)) await orchestrator.integrate(runId);
    return buildRecoverySummary(runId);
  }

  async function buildDiagnostics(): Promise<Diagnostics> {
    const maintenance = store.maintainDatabase('PASSIVE');
    const schemaRow = store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    let walBytes = 0;
    if (databasePath !== ':memory:' && !databasePath.startsWith('file:')) {
      try {
        walBytes = (await stat(`${databasePath}-wal`)).size;
      } catch {
        walBytes = 0;
      }
    }
    const operations = store.db.prepare(`SELECT
      SUM(CASE WHEN status IN ('prepared', 'waiting_approval', 'dispatched', 'effect_observed', 'committed') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) AS unknown
      FROM operation_attempts`).get() as { pending?: number | null; unknown?: number | null };
    const budgets = store.db.prepare(`SELECT
      SUM(CASE WHEN status IN ('queued', 'reserved') THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'dispatched' THEN 1 ELSE 0 END) AS dispatched,
      SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) AS unknown
      FROM budget_reservations`).get() as { queued?: number | null; dispatched?: number | null; unknown?: number | null };
    const storage = await worktrees.storageUsage();
    const orphaned = store.listWorktreeArtifacts(undefined, 'orphaned').length;
    const providerConfigs = await providers.configs();
    return {
      schemaVersion: 2,
      database: {
        schemaVersion: Number(schemaRow?.value ?? 1),
        integrity: maintenance.integrity.every((item) => item === 'ok') ? 'ok' : 'error',
        walBytes
      },
      operations: { pending: Number(operations.pending ?? 0), unknown: Number(operations.unknown ?? 0) },
      budgets: { queued: Number(budgets.queued ?? 0), dispatched: Number(budgets.dispatched ?? 0), unknown: Number(budgets.unknown ?? 0) },
      worktrees: { usedBytes: storage.usedBytes, quotaBytes: storage.quotaBytes, orphaned },
      providers: providerConfigs.map((provider) => ({ id: provider.id, configured: provider.configured, ready: provider.enabled && provider.configured })),
      eventWatermark: Number((store.db.prepare('SELECT MAX(id) AS watermark FROM events').get() as { watermark?: number | null }).watermark ?? 0),
      createdAt: new Date().toISOString()
    };
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
    const allProjects = store.listProjects();
    const currentProject = allProjects.find((item) => item.id === query.projectId) ?? allProjects[0];
    const projects = currentProject
      ? [currentProject, ...allProjects.filter((item) => item.id !== currentProject.id)].slice(0, 100)
      : [];
    const allRuns = store.listRuns(currentProject?.id);
    const currentRun = allRuns.find((item) => item.id === query.runId) ?? allRuns[0];
    const runs = currentRun
      ? [currentRun, ...allRuns.filter((item) => item.id !== currentRun.id)].slice(0, 100)
      : [];
    const snapshot = currentRun ? store.readSnapshot(currentRun.id, () => ({
      messages: store.listMessages(currentRun.id).slice(-100),
      tasks: store.listTasks(currentRun.id).slice(0, 200),
      agents: store.listAgents(currentRun.id).slice(0, 200),
      approvals: store.listApprovals(currentRun.id).slice(0, 100),
      events: store.listRecentEvents(currentRun.id, 200),
      usage: {
        ...store.getUsage(currentRun.id),
        elapsedMinutes: Math.max(0, (Date.now() - new Date(currentRun.createdAt).getTime()) / 60_000)
      }
    })) : undefined;
    const payload: BootstrapPayload = {
      schemaVersion: 2,
      sessionToken: config.sessionToken,
      projects,
      runs,
      ...(currentProject ? { currentProject, documents: store.listDocuments(currentProject.id).map(documentMetadata) } : { documents: [] }),
      ...(currentRun ? {
        currentRun,
        messages: snapshot!.data.messages,
        tasks: snapshot!.data.tasks,
        agents: snapshot!.data.agents,
        approvals: snapshot!.data.approvals,
        events: snapshot!.data.events,
        usage: snapshot!.data.usage,
        snapshotVersion: snapshot!.snapshotVersion,
        eventWatermark: snapshot!.eventWatermark
      } : {
        messages: [], tasks: [], agents: [], approvals: [], events: [],
        usage: { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, elapsedMinutes: 0 },
        snapshotVersion: 0,
        eventWatermark: 0
      }),
      providers: await providers.configs(),
      settings: store.getSetting<AppSettings>('app')!
    };
    return payload;
  });

  app.get('/api/projects', async (request) => pageCollection(store.listProjects(), request.query));
  app.get('/api/projects/pick-directory', async () => pickLocalDirectory());
  app.post('/api/projects', async (request) => {
    return idempotent(request, 'projects:create', async () => {
      const body = createProjectRequestSchema.parse(request.body);
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
    const query = z.object({ projectId: z.string().optional(), cursor: z.string().optional(), limit: z.coerce.number().optional() }).parse(request.query);
    return pageCollection(store.listRuns(query.projectId), {
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.limit === undefined ? {} : { limit: query.limit })
    });
  });

  app.get('/api/projects/:id/check', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = store.getProject(id);
    if (!project) throw new Error('PROJECT_NOT_FOUND');
    const git = await runProcess('git rev-parse --is-inside-work-tree', project.rootPath);
    if (git.code !== 0) return { projectId: id, isGit: false, clean: false, branch: null, changedFiles: [] };
    const [status, branch] = await Promise.all([
      runProcess('git status --porcelain', project.rootPath),
      runProcess('git branch --show-current', project.rootPath)
    ]);
    const changedFiles = status.output.split(/\r?\n/).map((line) => line.slice(3).trim()).filter(Boolean);
    return { projectId: id, isGit: true, clean: status.code === 0 && changedFiles.length === 0, branch: branch.output.trim() || null, changedFiles };
  });

  app.post('/api/runs', async (request) => {
    return idempotent(request, 'runs:create', async () => {
      const body = createRunRequestSchema.parse(request.body);
      const project = store.getProject(body.projectId);
      if (!project) throw new Error('PROJECT_NOT_FOUND');
      const run = store.createRun({
        ...body,
        baseRef: project.isGit ? await worktrees.head(project.rootPath) : 'HEAD',
        allowedProviderIds: body.modelMode === 'fixed' ? [body.providerId] : (body.allowedProviderIds ?? [body.providerId])
      });
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
      const body = runActionRequestSchema.parse(request.body);
      const run = store.getRun(id);
      if (!run) throw new Error('RUN_NOT_FOUND');
      if (body.action === 'pause') {
        if (['paused', 'completed', 'cancelled', 'failed'].includes(run.state)) throw new Error(`RUN_STATE_CONFLICT: ${run.state} 状态不能暂停`);
        orchestrator.interrupt(id);
        const message = '用户暂停';
        return store.updateRun(id, {
          state: 'paused', previousState: run.state, pauseReason: message,
          blocker: { kind: 'user_pause', code: 'USER_PAUSED', message, since: new Date().toISOString(), recoverable: true }
        });
      }
      if (body.action === 'cancel') {
        if (['completed', 'cancelled'].includes(run.state)) throw new Error(`RUN_STATE_CONFLICT: ${run.state} 状态不能取消`);
        orchestrator.interrupt(id);
        return store.updateRun(id, { state: 'cancelled', previousState: run.state, pauseReason: '用户取消' });
      }
      const expectedState = body.action === 'resume' ? 'paused' : 'failed';
      if (run.state !== expectedState) throw new Error(`RUN_STATE_CONFLICT: 只有 ${expectedState} 运行可以${body.action === 'resume' ? '继续' : '重试'}`);
      const pendingApproval = store.listApprovals(id).find((approval) => approval.status === 'pending');
      if (pendingApproval) throw new Error(`APPROVAL_REQUIRED: 审批 ${pendingApproval.id} 尚未处理`);
      if (run.blocker?.kind === 'approval') {
        const approval = run.blocker.approvalId ? store.getApproval(run.blocker.approvalId) : undefined;
        if (!approval || approval.status !== 'approved') throw new Error('APPROVAL_REQUIRED: 待审批操作尚未批准');
      }
      if (run.blocker?.kind === 'documents') throw new Error('DOCS_NOT_APPROVED: 文档变更后必须重新批准规范');
      if (run.blocker?.code === 'ACTION_OUTCOME_UNKNOWN') {
        throw new Error('RUN_STATE_CONFLICT: 中断动作结果未知，不能自动重放；请检查 worktree 后重试任务');
      }
      if (run.blocker?.kind === 'restart') {
        for (const reservation of store.listBudgetReservations(id).filter((item) => item.status === 'unknown')) {
          store.settleBudgetReservation(reservation.id, {
            calls: reservation.reservedCalls,
            inputTokens: reservation.reservedInputTokens,
            outputTokens: reservation.reservedOutputTokens,
            actualCost: reservation.reservedCost
          });
        }
      }
      const target = run.previousState && !['paused', 'failed', 'cancelled', 'completed'].includes(run.previousState)
        ? run.previousState
        : 'clarifying';
      const resumed = store.updateRun(id, { state: target, previousState: run.state, blocker: null, pauseReason: null });
      if (['decomposing', 'executing'].includes(resumed.state)) await orchestrator.execute(id);
      if (['integrating', 'verifying', 'optimizing'].includes(resumed.state)) await orchestrator.integrate(id);
      return resumed;
    });
  });

  app.get('/api/runs/:id/recovery', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return buildRecoverySummary(id);
  });

  app.post('/api/runs/:id/recovery', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = runRecoveryRequestSchema.parse(request.body);
    return idempotent(request, `runs:${id}:recovery:${body.decision}`, () => recoverRun(id, body.decision, body.note));
  });

  app.get('/api/runs/:id/messages', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return pageCollection(store.listMessages(id), request.query);
  });

  app.post('/api/runs/:id/messages', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = createMessageRequestSchema.parse(request.body);
    return idempotent(request, `runs:${id}:messages:create`, () => orchestrator.sendMessage(id, body.content));
  });

  app.get('/api/runs/:id/docs', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const run = store.getRun(id);
    if (!run) throw new Error('RUN_NOT_FOUND');
    return pageCollection(store.listDocuments(run.projectId).map(documentMetadata), request.query, 20);
  });

  app.get('/api/runs/:id/docs/:docId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id, docId } = z.object({ id: z.string(), docId: z.string() }).parse(request.params);
    const run = store.getRun(id);
    if (!run) throw new Error('RUN_NOT_FOUND');
    const document = store.getDocument(run.projectId, docId);
    if (!document) throw new Error('DOCUMENT_NOT_FOUND');
    return documentWithContent(document);
  });

  app.patch('/api/runs/:id/docs/:docId', async (request) => {
    const { id, docId } = z.object({ id: z.string(), docId: z.string() }).parse(request.params);
    const body = saveDocumentRequestSchema.parse(request.body);
    return idempotent(request, `runs:${id}:docs:${docId}:save`, async () => {
      const run = store.getRun(id);
      if (!run) throw new Error('RUN_NOT_FOUND');
      const project = store.getProject(run.projectId);
      if (!project) throw new Error('PROJECT_NOT_FOUND');
      const before = store.getDocument(project.id, docId);
      const document = await documents.save(project.id, project.rootPath, docId, body.content, body.expectedHash);
      if (before?.hash !== document.hash) await orchestrator.invalidateForDocumentChange(id, docId);
      return documentWithContent(document);
    });
  });

  // Documented collection PATCH; the per-document route above remains for the existing frontend.
  app.patch('/api/runs/:id/docs', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = saveDocumentRequestSchema.extend({ docId: z.string().min(1) }).parse(request.body);
    return idempotent(request, `runs:${id}:docs:${body.docId}:save`, async () => {
      const run = store.getRun(id);
      if (!run) throw new Error('RUN_NOT_FOUND');
      const project = store.getProject(run.projectId);
      if (!project) throw new Error('PROJECT_NOT_FOUND');
      const before = store.getDocument(project.id, body.docId);
      const document = await documents.save(project.id, project.rootPath, body.docId, body.content, body.expectedHash);
      if (before?.hash !== document.hash) await orchestrator.invalidateForDocumentChange(id, body.docId);
      return documentWithContent(document);
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
    return pageCollection(store.listTasks(id), request.query);
  });
  app.get('/api/runs/:id/agents', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!store.getRun(id)) throw new Error('RUN_NOT_FOUND');
    return pageCollection(store.listAgents(id), request.query);
  });
  app.get('/api/runs/:id/checkpoints', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!store.getRun(id)) throw new Error('RUN_NOT_FOUND');
    return pageCollection(store.listCheckpoints(id), request.query);
  });
  app.get('/api/runs/:id/approvals', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!store.getRun(id)) throw new Error('RUN_NOT_FOUND');
    return pageCollection(store.listApprovals(id), request.query);
  });

  app.post('/api/runs/:id/approvals/:approvalId', async (request) => {
    const { id, approvalId } = z.object({ id: z.string(), approvalId: z.string() }).parse(request.params);
    const body = resolveApprovalRequestSchema.parse(request.body);
    return idempotent(request, `runs:${id}:approvals:${approvalId}:resolve`, async () => {
      return resolveRunApproval(id, approvalId, body.decision, body.scope);
    });
  });

  // Documented collection POST; the resource route above remains frontend-compatible.
  app.post('/api/runs/:id/approvals', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = resolveApprovalRequestSchema.extend({ approvalId: z.string().min(1) }).parse(request.body);
    return idempotent(request, `runs:${id}:approvals:${body.approvalId}:resolve`, async () => {
      return resolveRunApproval(id, body.approvalId, body.decision, body.scope);
    });
  });

  app.get('/api/providers', async (request) => pageCollection(await providers.configs(), request.query, 20));
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
    const body = settingsPatchSchema.parse(request.body);
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
    const generations = store.listPlanGenerations(id);
    const attempts = store.listActionAttempts(id, undefined, 'all');
    const checkpoints = store.listCheckpoints(id);
    const taskResults = store.listTaskResults(id, 'all');
    const delivery = store.getDeliverySummary(id);
    const toolOutputs = store.listToolOutputs(id, undefined, 'all');
    const artifacts = store.listWorktreeArtifacts(id);
    const reservations = store.listBudgetReservations(id);
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
      '## 计划代次',
      '',
      ...generations.map((generation) => `- generation ${generation.generation} · ${generation.status} · ${generation.reason ?? '初始规范'} · ${generation.createdAt}`),
      '',
      '## 动作尝试',
      '',
      ...attempts.map((attempt) => {
        const serialized = JSON.stringify(attempt.action);
        const action = serialized.length > 2_000 ? `${serialized.slice(0, 2_000)}…（已截断）` : serialized;
        return `- ${attempt.id} · generation ${attempt.generation} · #${attempt.sequence} · ${attempt.status} · key=${attempt.idempotencyKey} · action=${action}${attempt.toolOutputId ? ` · output=${attempt.toolOutputId}` : ''}${attempt.error ? ` · error=${attempt.error}` : ''}`;
      }),
      '',
      '## 检点',
      '',
      ...checkpoints.map((checkpoint) => `- ${checkpoint.id} · agent ${checkpoint.agentId} · lineage ${checkpoint.lineage} · watermark ${checkpoint.eventWatermark} · next=${checkpoint.nextAction}`),
      '',
      '## 结构化任务结果',
      '',
      ...taskResults.map((result) => `- ${result.taskId} · generation ${result.generation} · verified=${result.verified} · commit=${result.commitSha ?? 'none'} · ${result.summary}`),
      '',
      '## 交付摘要',
      '',
      ...(delivery ? [
        `- generation: ${delivery.generation}`,
        `- base: ${delivery.baseRef}`,
        `- integration branch: ${delivery.integrationBranch ?? 'none'}`,
        `- files: ${delivery.filesChanged.join(', ') || 'none'}`,
        `- commits: ${delivery.commits.join(', ') || 'none'}`,
        `- verification: ${delivery.verificationCommands.join(', ') || 'none'}`,
        `- risks: ${delivery.risks.join('；') || 'none'}`,
        `- unresolved: ${delivery.unresolved.join('；') || 'none'}`,
        `- actual cost: ${delivery.actualCost}`
      ] : ['- 尚未生成']),
      '',
      '## 工具输出索引',
      '',
      ...toolOutputs.map((output) => `- ${output.id} · ${output.tool} · ${output.byteLength} bytes · truncated=${output.truncated} · ${output.createdAt}`),
      '',
      '## Worktree artifacts',
      '',
      ...artifacts.map((artifact) => `- ${artifact.id} · generation ${artifact.generation} · ${artifact.kind}/${artifact.status} · ${artifact.branch} · ${artifact.commitSha ?? 'no commit'} · ${artifact.path}`),
      '',
      '## 预算预留',
      '',
      ...reservations.map((reservation) => `- ${reservation.id} · ${reservation.providerId}/${reservation.model ?? 'default'} · ${reservation.status} · reserved ${reservation.reservedInputTokens}+${reservation.reservedOutputTokens} tokens · cost ${reservation.actualCost ?? reservation.reservedCost}`),
      '',
      '## 事件摘要',
      '',
      ...events.map((event) => `- ${event.id} · ${event.createdAt} · ${event.type}`),
      ''
    ].join('\n');
    return { filename: `loop-run-${run.id}.md`, content };
  });

  app.get('/api/openapi.json', async () => openApiDocument);

  app.get('/api/diagnostics', async () => buildDiagnostics());

  app.get('/api/runs/:id/delivery', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!store.getRun(id)) throw new Error('RUN_NOT_FOUND');
    const delivery = store.getDeliverySummary(id);
    if (!delivery) throw new Error('DELIVERY_NOT_FOUND');
    return delivery;
  });

  app.post('/api/runs/:id/acceptance', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = acceptanceRequestSchema.parse(request.body);
    return idempotent(request, `runs:${id}:acceptance`, () => orchestrator.acceptDelivery(id, body.decision, body.feedback));
  });

  app.get('/api/runs/:id/tool-outputs/:outputId', async (request) => {
    const { id, outputId } = z.object({ id: z.string(), outputId: z.string() }).parse(request.params);
    if (!store.getRun(id)) throw new Error('RUN_NOT_FOUND');
    const output = store.getToolOutput(outputId);
    if (!output || output.runId !== id) throw new Error('TOOL_OUTPUT_NOT_FOUND');
    return output;
  });

  app.get('/api/runs/:id/events', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (!store.getRun(id)) throw new Error('RUN_NOT_FOUND');
    const query = z.object({ after: z.coerce.number().int().nonnegative().optional() }).parse(request.query);
    const header = z.coerce.number().int().nonnegative().parse(request.headers['last-event-id'] ?? 0);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    reply.raw.write('retry: 2000\n\n');
    const writeEvent = (event: unknown & { id?: number; type?: string }) => {
      const transportType = event.type === 'error' ? 'loop.error' : (event.type ?? 'message');
      reply.raw.write(`id: ${event.id ?? ''}\nevent: ${transportType}\ndata: ${JSON.stringify(event)}\n\n`);
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
    let cursor = Math.max(header, query.after ?? 0);
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
    const writeHeartbeat = () => reply.raw.write(`event: loop.heartbeat\ndata: ${JSON.stringify({
      eventWatermark: store.getEventWatermark(id),
      snapshotVersion: store.getSnapshotVersion(id),
      reconnectAfterMs: 2_000
    })}\n\n`);
    writeHeartbeat();
    const heartbeat = setInterval(writeHeartbeat, 15_000);
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
