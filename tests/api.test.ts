import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../apps/server/src/app.js';
import { createApp } from '../apps/server/src/app.js';

let context: AppContext | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (context) {
    await context.app.close();
    context.store.close();
    context = undefined;
  }
});

describe('local REST API', () => {
  it('returns a complete bootstrap payload and protects mutations', async () => {
    context = await createApp(':memory:');
    const bootstrap = await context.app.inject({ method: 'GET', url: '/api/bootstrap' });
    expect(bootstrap.statusCode).toBe(200);
    const payload = bootstrap.json();
    expect(payload.projects).toHaveLength(1);
    expect(payload.documents).toHaveLength(5);
    expect(payload.documents.every((document: { content: string; contentLoaded?: boolean }) => document.content === '' && document.contentLoaded === false)).toBe(true);
    expect(payload.currentRun.state).toBe('doc_review');
    expect(payload.events.length).toBeGreaterThan(0);
    expect(payload.usage).toMatchObject({ calls: 0, inputTokens: 0, outputTokens: 0 });

    const fullDocument = await context.app.inject({
      method: 'GET',
      url: `/api/runs/${payload.currentRun.id}/docs/${payload.documents[0].id}`
    });
    expect(fullDocument.statusCode).toBe(200);
    expect(fullDocument.json().contentLoaded).toBe(true);
    expect(fullDocument.json().content.length).toBeGreaterThan(0);

    const denied = await context.app.inject({
      method: 'POST',
      url: `/api/runs/${payload.currentRun.id}/docs/approve-all`
    });
    expect(denied.statusCode).toBe(401);

    const approved = await context.app.inject({
      method: 'POST',
      url: `/api/runs/${payload.currentRun.id}/docs/approve-all`,
      headers: { 'x-loop-session': payload.sessionToken }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().state).toBe('ready');
  });

  it('runs a structured local clarification loop without a provider key', async () => {
    context = await createApp(':memory:');
    const payload = (await context.app.inject({ method: 'GET', url: '/api/bootstrap' })).json();
    const response = await context.app.inject({
      method: 'POST',
      url: `/api/runs/${payload.currentRun.id}/messages`,
      headers: { 'x-loop-session': payload.sessionToken },
      payload: { content: '我要做一个工具，但还没有给出验收标准。' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().analysis.source).toBe('local-demo');
    expect(response.json().analysis.unclear.length).toBeGreaterThan(0);
  });

  it('creates a selectable local run and immediately enters clarification', async () => {
    context = await createApp(':memory:');
    const payload = (await context.app.inject({ method: 'GET', url: '/api/bootstrap' })).json();
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { 'x-loop-session': payload.sessionToken },
      payload: {
        projectId: payload.currentProject.id,
        title: 'new run',
        question: '实现一个有验收标准的本地工具。',
        modelMode: 'fixed',
        providerId: 'local-demo',
        model: 'local-structured-demo',
        allowedProviderIds: ['local-demo']
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().title).toBe('new run');
    expect(response.json().allowedProviderIds).toEqual(['local-demo']);
    expect(context.store.listMessages(response.json().id)).toHaveLength(2);
  });

  it('deduplicates writes and rejects reuse of an idempotency key with another payload', async () => {
    context = await createApp(':memory:');
    const payload = (await context.app.inject({ method: 'GET', url: '/api/bootstrap' })).json();
    const body = {
      projectId: payload.currentProject.id,
      title: 'idempotent run',
      question: '实现一个面向开发者、范围明确并带验收测试的本地工具。',
      modelMode: 'fixed',
      providerId: 'local-demo',
      model: 'local-structured-demo'
    };
    const headers = { 'x-loop-session': payload.sessionToken, 'idempotency-key': 'create-run-1' };
    const first = await context.app.inject({ method: 'POST', url: '/api/runs', headers, payload: body });
    const replay = await context.app.inject({ method: 'POST', url: '/api/runs', headers, payload: body });

    expect(first.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);
    expect(context.store.listRuns(payload.currentProject.id)).toHaveLength(2);

    const conflict = await context.app.inject({
      method: 'POST', url: '/api/runs', headers, payload: { ...body, title: 'different run' }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('supports the documented collection routes while preserving precise errors', async () => {
    context = await createApp(':memory:');
    const payload = (await context.app.inject({ method: 'GET', url: '/api/bootstrap' })).json();
    const auth = { 'x-loop-session': payload.sessionToken };
    const runId = payload.currentRun.id as string;
    const document = payload.documents[0];

    const listed = await context.app.inject({ method: 'GET', url: `/api/runs/${runId}/docs` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.every((item: { content: string; contentLoaded?: boolean }) => item.content === '' && item.contentLoaded === false)).toBe(true);
    const fetchedDocument = await context.app.inject({ method: 'GET', url: `/api/runs/${runId}/docs/${document.id}` });
    expect(fetchedDocument.statusCode).toBe(200);
    expect(fetchedDocument.json()).toMatchObject({ id: document.id, contentLoaded: true });
    expect(fetchedDocument.json().content.length).toBeGreaterThan(0);

    const saved = await context.app.inject({
      method: 'PATCH', url: `/api/runs/${runId}/docs`, headers: auth,
      payload: { docId: document.id, expectedHash: fetchedDocument.json().hash, content: fetchedDocument.json().content }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().contentLoaded).toBe(true);

    for (const item of payload.documents) {
      const approved = await context.app.inject({
        method: 'POST', url: `/api/runs/${runId}/docs/${item.id}/approve`, headers: auth
      });
      expect(approved.statusCode).toBe(200);
    }
    expect(context.store.getRun(runId)?.state).toBe('ready');
    expect(context.store.getRun(runId)?.docsApproved).toBe(true);

    const approval = context.store.createApproval({
      runId, tool: 'run_command', ruleKey: 'command:unknown', risk: 'high', summary: 'test', policyReason: 'test'
    });
    const resolved = await context.app.inject({
      method: 'POST', url: `/api/runs/${runId}/approvals`, headers: auth,
      payload: { approvalId: approval.id, decision: 'approved' }
    });
    expect(resolved.statusCode).toBe(200);
    expect(context.store.listApprovals(runId).find((item) => item.id === approval.id)?.status).toBe('approved');

    const settings = await context.app.inject({
      method: 'PATCH', url: '/api/settings', headers: auth,
      payload: { concurrency: 4, budget: { maxCalls: 12, maxMinutes: 30 } }
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().budget.maxCalls).toBe(12);
    expect(settings.json().budget.maxInputTokens).toBe(5_000_000);

    const invalid = await context.app.inject({
      method: 'PATCH', url: '/api/settings', headers: auth, payload: { concurrency: 99 }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('INVALID_REQUEST');
    expect(invalid.json().error.requestId).toBeTruthy();
  });

  it('publishes OpenAPI, cursor pages and versioned bootstrap watermarks', async () => {
    context = await createApp(':memory:');
    const openapi = await context.app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json()).toMatchObject({ openapi: '3.1.0', info: { version: '0.2.0-alpha.1' } });
    expect(openapi.json().paths['/runs/{id}/docs/{docId}'].get.operationId).toBe('getDocument');

    const projects = await context.app.inject({ method: 'GET', url: '/api/projects?limit=1' });
    expect(projects.statusCode).toBe(200);
    expect(projects.json().items).toHaveLength(1);

    const bootstrap = (await context.app.inject({ method: 'GET', url: '/api/bootstrap' })).json();
    expect(bootstrap.snapshotVersion).toBeGreaterThan(0);
    expect(bootstrap.eventWatermark).toBeGreaterThan(0);
    expect(bootstrap.events.at(-1).id).toBeLessThanOrEqual(bootstrap.eventWatermark);
  });

  it('does not let resume bypass a pending approval', async () => {
    context = await createApp(':memory:');
    const bootstrap = (await context.app.inject({ method: 'GET', url: '/api/bootstrap' })).json();
    const approval = context.store.createApproval({
      runId: bootstrap.currentRun.id,
      tool: 'merge_to_project',
      ruleKey: 'integration:merge',
      risk: 'high',
      reusable: false,
      summary: 'merge',
      policyReason: '必须明确验收'
    });
    context.store.updateRun(bootstrap.currentRun.id, {
      state: 'paused', previousState: 'verifying', pauseReason: '等待审批'
    });
    const response = await context.app.inject({
      method: 'PATCH',
      url: `/api/runs/${bootstrap.currentRun.id}`,
      headers: { 'x-loop-session': bootstrap.sessionToken },
      payload: { action: 'resume' }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('APPROVAL_REQUIRED');
    expect(context.store.getApproval(approval.id)?.status).toBe('pending');
  });

  it('exposes delivery/tool output and completes only after explicit acceptance', async () => {
    context = await createApp(':memory:');
    const bootstrap = (await context.app.inject({ method: 'GET', url: '/api/bootstrap' })).json();
    const runId = bootstrap.currentRun.id as string;
    const integrationBranch = `loop/${runId}/integration-g1`;
    const integrationCommit = 'a'.repeat(40);
    const output = context.store.createToolOutput({ runId, tool: 'verification', content: 'all passed' });
    context.store.upsertWorktreeArtifact({
      runId,
      kind: 'integration',
      path: 'C:\\loop-test-integration',
      branch: integrationBranch,
      baseRef: context.store.getRun(runId)!.baseRef,
      commitSha: integrationCommit,
      status: 'completed'
    });
    vi.spyOn(context.worktrees, 'assertIntegrationReference').mockResolvedValue();
    context.store.upsertDeliverySummary({
      runId,
      integrationBranch,
      filesChanged: ['src/index.ts'],
      commits: ['abc123'],
      verificationCommands: ['npm.cmd test'],
      taskResults: [],
      risks: [],
      unresolved: [],
      actualCost: 0
    });
    context.store.updateRun(runId, { state: 'awaiting_acceptance', previousState: 'verifying' });

    const fetchedOutput = await context.app.inject({ method: 'GET', url: `/api/runs/${runId}/tool-outputs/${output.id}` });
    expect(fetchedOutput.json().content).toBe('all passed');
    const delivery = await context.app.inject({ method: 'GET', url: `/api/runs/${runId}/delivery` });
    expect(delivery.json().filesChanged).toEqual(['src/index.ts']);

    const accepted = await context.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/acceptance`,
      headers: { 'x-loop-session': bootstrap.sessionToken, 'idempotency-key': 'accept-keep' },
      payload: { decision: 'accept_keep_branch' }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().run.state).toBe('completed');
  });

  it('requires and consumes a branch-bound one-time approval before the final merge', async () => {
    context = await createApp(':memory:');
    const bootstrap = (await context.app.inject({ method: 'GET', url: '/api/bootstrap' })).json();
    const runId = bootstrap.currentRun.id as string;
    const run = context.store.getRun(runId)!;
    const project = context.store.getProject(run.projectId)!;
    const integrationBranch = `loop/${runId}/integration-g${run.generation}`;
    const integrationCommit = 'c'.repeat(40);
    const mergeCommit = 'd'.repeat(40);
    context.store.upsertWorktreeArtifact({
      runId,
      kind: 'integration',
      path: 'C:\\loop-test-merge-integration',
      branch: integrationBranch,
      baseRef: run.baseRef,
      commitSha: integrationCommit,
      status: 'completed'
    });
    context.store.upsertDeliverySummary({
      runId,
      integrationBranch,
      filesChanged: ['src/accepted.ts'],
      commits: [integrationCommit],
      verificationCommands: ['npm.cmd test'],
      taskResults: [],
      risks: [],
      unresolved: [],
      actualCost: 0
    });
    context.store.updateRun(runId, { state: 'awaiting_acceptance', previousState: 'verifying' });
    vi.spyOn(context.worktrees, 'assertIntegrationReference').mockResolvedValue();
    vi.spyOn(context.worktrees, 'currentBranch').mockResolvedValue('main');
    vi.spyOn(context.worktrees, 'reconcileAcceptedMerge').mockResolvedValue({ status: 'pending' });
    const merge = vi.spyOn(context.worktrees, 'mergeAccepted').mockResolvedValue(mergeCommit);
    const auth = { 'x-loop-session': bootstrap.sessionToken };

    const requested = await context.app.inject({
      method: 'POST', url: `/api/runs/${runId}/acceptance`, headers: auth,
      payload: { decision: 'accept_merge' }
    });
    expect(requested.statusCode).toBe(200);
    expect(requested.json().run.state).toBe('paused');
    const approval = context.store.listApprovals(runId).find((item) => item.tool === 'merge_integration');
    expect(approval).toMatchObject({ status: 'pending', reusable: false, scope: 'once' });
    expect(approval?.resource).toContain('target:main');

    const approved = await context.app.inject({
      method: 'POST', url: `/api/runs/${runId}/approvals/${approval!.id}`, headers: auth,
      payload: { decision: 'approved', scope: 'once' }
    });
    expect(approved.statusCode).toBe(200);
    expect(context.store.getRun(runId)?.state).toBe('completed');
    expect(context.store.getApproval(approval!.id)?.consumedAt).toBeTruthy();
    expect(merge).toHaveBeenCalledWith(
      project.rootPath, integrationBranch, integrationCommit, run.baseRef, 'main', runId, expect.any(AbortSignal)
    );
  });
});
