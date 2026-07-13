import { afterEach, describe, expect, it } from 'vitest';
import { LoopStore } from '../apps/server/src/store.js';

const stores: LoopStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

describe('LoopStore', () => {
  it('persists state transitions and replayable events', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const project = store.createProject({ name: 'fixture', rootPath: 'C:\\fixture', isGit: true });
    const run = store.createRun({
      projectId: project.id,
      title: 'test',
      question: 'build',
      modelMode: 'fixed',
      providerId: 'local-demo',
      model: 'local-structured-demo'
    });
    store.updateRun(run.id, { state: 'clarifying', previousState: 'intake' });
    expect(store.getRun(run.id)?.state).toBe('clarifying');
    expect(store.listEvents(run.id).map((event) => event.type)).toEqual(['run.state', 'run.state']);
  });

  it('deduplicates tool effects by idempotency key', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    store.setIdempotent('tool:1', { ok: true, output: 'done' });
    expect(store.getIdempotent('tool:1')).toEqual({ ok: true, output: 'done' });
  });

  it('persists context handoff checkpoints for restart recovery', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const project = store.createProject({ name: 'fixture', rootPath: 'C:\\fixture-checkpoint', isGit: true });
    const run = store.createRun({
      projectId: project.id, title: 'checkpoint', question: 'recover', modelMode: 'fixed',
      providerId: 'local-demo', model: 'local-structured-demo'
    });
    store.upsertTask({
      id: 'task-1', runId: run.id, title: 'Lease', description: 'test lease', status: 'queued', depth: 1,
      dependencies: [], scope: ['apps/server/'], docRefs: [], acceptanceCriteria: ['exclusive']
    });
    store.upsertAgent({
      id: 'agent-1', runId: run.id, name: 'Lead', role: 'lead-main', status: 'running', depth: 0,
      providerId: 'local-demo', model: 'local-structured-demo', contextUsage: 0.75, lineage: 1
    });
    store.upsertAgent({
      id: 'agent-2', runId: run.id, name: 'Other', role: 'module-main', status: 'queued', depth: 1,
      providerId: 'local-demo', model: 'local-structured-demo', contextUsage: 0, lineage: 1
    });
    expect(store.acquireTaskLease('task-1', 'agent-1')).toBe(true);
    expect(store.acquireTaskLease('task-1', 'agent-2')).toBe(false);
    store.releaseTaskLease('task-1', 'agent-1');
    expect(store.acquireTaskLease('task-1', 'agent-2')).toBe(true);
    store.upsertCheckpoint({
      id: 'checkpoint-1', runId: run.id, agentId: 'agent-1', lineage: 1,
      docRefs: [], taskIds: [], eventWatermark: store.getEventWatermark(run.id),
      decisions: ['keep API stable'], unresolved: [], nextAction: 'continue', createdAt: new Date().toISOString()
    });

    expect(store.listCheckpoints(run.id)).toMatchObject([
      { id: 'checkpoint-1', agentId: 'agent-1', decisions: ['keep API stable'], nextAction: 'continue' }
    ]);
  });
});
