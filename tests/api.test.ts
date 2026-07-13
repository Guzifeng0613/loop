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
});
