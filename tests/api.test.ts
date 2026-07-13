import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../apps/server/src/app.js';
import { createApp } from '../apps/server/src/app.js';

let context: AppContext | undefined;
afterEach(async () => {
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
    expect(payload.currentRun.state).toBe('doc_review');

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
        model: 'local-structured-demo'
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().title).toBe('new run');
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

    const saved = await context.app.inject({
      method: 'PATCH', url: `/api/runs/${runId}/docs`, headers: auth,
      payload: { docId: document.id, content: document.content }
    });
    expect(saved.statusCode).toBe(200);

    for (const item of payload.documents) {
      const approved = await context.app.inject({
        method: 'POST', url: `/api/runs/${runId}/docs/${item.id}/approve`, headers: auth
      });
      expect(approved.statusCode).toBe(200);
    }
    expect(context.store.getRun(runId)?.state).toBe('ready');
    expect(context.store.getRun(runId)?.docsApproved).toBe(true);

    const approval = context.store.createApproval({
      runId, tool: 'run_command', risk: 'high', summary: 'test', policyReason: 'test'
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
});
