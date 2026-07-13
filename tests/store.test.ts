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
});

