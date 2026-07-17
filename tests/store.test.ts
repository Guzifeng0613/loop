import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  actionAttemptSchema,
  budgetReservationSchema,
  createRunRequestSchema,
  taskResultSchema,
  worktreeArtifactSchema
} from '@loop/contracts';
import { LoopStore } from '../apps/server/src/store.js';

const stores: LoopStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

describe('LoopStore', () => {
  it('migrates a v6 database to v7 atomically and seeds its current generation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'loop-store-v6-'));
    const path = join(directory, 'loop.sqlite');
    let legacy: Database.Database | undefined;
    let store: LoopStore | undefined;
    try {
      legacy = new Database(path);
      legacy.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta(key, value) VALUES ('schema_version', '6');
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
          is_git INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
        );
        CREATE TABLE runs (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, question TEXT NOT NULL,
          state TEXT NOT NULL, previous_state TEXT, model_mode TEXT NOT NULL, provider_id TEXT NOT NULL,
          model TEXT NOT NULL, allowed_provider_ids_json TEXT NOT NULL DEFAULT '[]',
          docs_approved INTEGER NOT NULL DEFAULT 0, pause_reason TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id)
        );
        CREATE TABLE documents (
          id TEXT NOT NULL, project_id TEXT NOT NULL, filename TEXT NOT NULL, title TEXT NOT NULL,
          version TEXT NOT NULL, status TEXT NOT NULL, hash TEXT NOT NULL, approved_hash TEXT,
          content TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(id, project_id), FOREIGN KEY(project_id) REFERENCES projects(id)
        );
        CREATE TABLE approval_rules (
          run_id TEXT NOT NULL, rule_key TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(run_id, rule_key), FOREIGN KEY(run_id) REFERENCES runs(id)
        );
        INSERT INTO projects VALUES ('project-v6', 'legacy', 'C:\\legacy', 1, '2026-01-01T00:00:00.000Z');
        INSERT INTO projects VALUES ('project-v6-invalid', 'legacy invalid', 'C:\\legacy-invalid', 1, '2026-01-01T00:00:00.000Z');
        INSERT INTO runs VALUES (
          'run-v6', 'project-v6', 'legacy run', 'upgrade', 'ready', NULL, 'fixed', 'openai', 'gpt-test',
          '["openai"]', 1, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO runs VALUES (
          'run-v6-invalid', 'project-v6-invalid', 'legacy invalid run', 'upgrade', 'ready', NULL, 'fixed', 'openai', 'gpt-test',
          '["openai"]', 1, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO documents VALUES (
          'overall', 'project-v6', '总体方案.md', '总体方案', '0.2.0', 'approved',
          'hash-overall', 'hash-overall', '# overall', '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO documents VALUES (
          'ui', 'project-v6', 'UI.md', 'UI', '0.2.0', 'approved',
          'hash-ui', 'hash-ui', '# ui', '2026-01-01T00:00:00.000Z'
        );
      `);
      legacy.close();
      legacy = undefined;

      store = new LoopStore(path);
      expect((store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe('7');
      expect(store.getRun('run-v6')).toMatchObject({ generation: 1, baseRef: 'HEAD' });
      expect(store.getCurrentPlanGeneration('run-v6')).toMatchObject({
        generation: 1,
        status: 'approved',
        docRefs: [
          { docId: 'overall', version: '0.2.0', hash: 'hash-overall', sections: [] },
          { docId: 'ui', version: '0.2.0', hash: 'hash-ui', sections: [] }
        ]
      });
      expect(store.getRun('run-v6-invalid')).toMatchObject({ generation: 1, docsApproved: false });
      expect(store.getCurrentPlanGeneration('run-v6-invalid')).toMatchObject({
        generation: 1,
        status: 'draft',
        docRefs: []
      });
      expect((store.db.prepare("PRAGMA table_info('action_attempts')").all() as unknown[]).length).toBeGreaterThan(0);
    } finally {
      store?.close();
      legacy?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects incomplete run creation and internally inconsistent persisted contracts', () => {
    expect(createRunRequestSchema.safeParse({
      projectId: 'project', title: 'run', question: 'build'
    }).success).toBe(false);
    expect(createRunRequestSchema.safeParse({
      projectId: 'project', title: 'run', question: 'build',
      providerId: 'openai', model: 'gpt-test', allowedProviderIds: ['deepseek']
    }).success).toBe(false);
    expect(createRunRequestSchema.safeParse({
      projectId: 'project', title: 'run', question: 'build',
      providerId: 'openai', model: 'gpt-test', allowedProviderIds: ['openai']
    }).success).toBe(true);

    const timestamp = '2026-01-01T00:00:00.000Z';
    const attempt = {
      id: 'attempt', runId: 'run', generation: 1, sequence: 0,
      action: { type: 'pause', reason: 'wait' }, idempotencyKey: 'action:key',
      createdAt: timestamp, updatedAt: timestamp
    };
    expect(actionAttemptSchema.safeParse({ ...attempt, status: 'executing' }).success).toBe(false);
    expect(actionAttemptSchema.safeParse({ ...attempt, status: 'failed', error: 'boom' }).success).toBe(false);
    expect(actionAttemptSchema.safeParse({
      ...attempt,
      action: { type: 'call_tool', tool: 'git_status', arguments: {} },
      status: 'completed', completedAt: timestamp
    }).success).toBe(false);

    const reservation = {
      id: 'reservation', runId: 'run', providerId: 'openai',
      reservedCalls: 1, reservedInputTokens: 10, reservedOutputTokens: 5,
      reservedCost: 0.1, createdAt: timestamp
    };
    expect(budgetReservationSchema.safeParse({ ...reservation, status: 'unknown' }).success).toBe(false);
    expect(budgetReservationSchema.safeParse({
      ...reservation, status: 'unknown', unknownAt: timestamp
    }).success).toBe(true);

    expect(taskResultSchema.safeParse({
      id: 'result', runId: 'run', taskId: 'task', generation: 1,
      summary: 'done', evidence: [], verificationCommands: [], verified: true,
      risks: [], unresolved: [], createdAt: timestamp, verifiedAt: timestamp
    }).success).toBe(false);
    expect(worktreeArtifactSchema.safeParse({
      id: 'artifact', runId: 'run', taskId: 'task', generation: 1, kind: 'integration',
      path: 'C:\\worktree', branch: 'loop/integration', baseRef: 'HEAD', status: 'active',
      sizeBytes: 0, createdAt: timestamp, updatedAt: timestamp
    }).success).toBe(false);
  });

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

  it('persists automatic routing constraints and enforces reusable approval policy', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const project = store.createProject({ name: 'fixture', rootPath: 'C:\\fixture-routing', isGit: true });
    const run = store.createRun({
      projectId: project.id, title: 'routing', question: 'route safely', modelMode: 'auto',
      providerId: 'openai', model: 'gpt-user-selected', allowedProviderIds: ['openai', 'deepseek']
    });
    expect(store.getRun(run.id)?.allowedProviderIds).toEqual(['openai', 'deepseek']);

    const singleUse = store.createApproval({
      runId: run.id, taskId: 'task', tool: 'run_command', ruleKey: 'command:dependencies', risk: 'high', reusable: true,
      summary: 'npm.cmd install', policyReason: '安装需要审批'
    });
    expect(singleUse.reusable).toBe(false);
    expect(() => store.resolveApproval(singleUse.id, 'approved', 'rule')).toThrow('APPROVAL_NOT_REUSABLE');
    store.resolveApproval(singleUse.id, 'approved', 'once');
    expect(store.consumeApprovedTool(run.id, 'task', 'run_command', 'command:dependencies', 'npm.cmd install')).toBe(true);
    expect(store.consumeApprovedTool(run.id, 'task', 'run_command', 'command:dependencies', 'npm.cmd install')).toBe(false);

    const reusable = store.createApproval({
      runId: run.id, tool: 'write_file', ruleKey: 'write:task-scope', risk: 'medium', reusable: true,
      capability: 'workspace.tool.write_file', resource: `run:${run.id}`,
      summary: 'write generated file', policyReason: '作用域内写入'
    });
    store.resolveApproval(reusable.id, 'approved', 'rule');
    expect(store.consumeApprovedTool(
      run.id, 'another-task', 'write_file', 'write:task-scope', 'different payload',
      'workspace.tool.write_file', `run:${run.id}`
    )).toBe(true);
    expect(store.consumeApprovedTool(run.id, 'another-task', 'run_command', 'command:delete', 'Remove-Item file.txt')).toBe(false);
  });

  it('persists one server-owned action attempt across approval and tool completion', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const project = store.createProject({ name: 'fixture', rootPath: 'C:\\fixture-actions', isGit: true });
    const run = store.createRun({
      projectId: project.id, title: 'actions', question: 'recover', modelMode: 'fixed',
      providerId: 'openai', model: 'gpt-test'
    });
    store.upsertTask({
      id: 'task-action', runId: run.id, generation: run.generation, title: 'Action', description: 'persist action',
      status: 'running', depth: 1, dependencies: [], scope: ['.'], docRefs: [], acceptanceCriteria: ['done']
    });
    const action = { type: 'call_tool', tool: 'git_status', arguments: {} } as const;
    const first = store.createActionAttempt({ runId: run.id, taskId: 'task-action', sequence: 0, action });
    const replay = store.createActionAttempt({ runId: run.id, taskId: 'task-action', sequence: 0, action });
    expect(replay.id).toBe(first.id);
    expect(replay.idempotencyKey).toBe(first.idempotencyKey);

    const approval = store.createApproval({
      runId: run.id, taskId: 'task-action', actionAttemptId: first.id,
      tool: 'git_status', ruleKey: 'test:approval', risk: 'medium',
      summary: '{}', policyReason: 'test gate'
    });
    expect(store.getActionAttempt(first.id)?.status).toBe('waiting_approval');
    store.resolveApproval(approval.id, 'approved');
    expect(store.claimActionAttempt(first.id).status).toBe('executing');
    const output = store.createToolOutput({
      runId: run.id, taskId: 'task-action', actionAttemptId: first.id,
      tool: 'git_status', content: 'clean'
    });
    const completed = store.completeActionAttempt(first.id, output.id);
    expect(completed).toMatchObject({ status: 'completed', toolOutputId: output.id });
    expect(store.getToolOutput(output.id)?.content).toBe('clean');
  });

  it('atomically consumes an approved capability while claiming the original action attempt', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const project = store.createProject({ name: 'fixture', rootPath: 'C:\\fixture-atomic-approval', isGit: true });
    const run = store.createRun({
      projectId: project.id, title: 'approval', question: 'claim once', modelMode: 'fixed',
      providerId: 'openai', model: 'gpt-test'
    });
    const attempt = store.createActionAttempt({
      runId: run.id, sequence: 0, action: { type: 'call_tool', tool: 'git_status', arguments: {} }
    });
    const approval = store.createApproval({
      runId: run.id, actionAttemptId: attempt.id, tool: 'git_status', ruleKey: 'git:status', risk: 'low',
      summary: '{}', policyReason: 'verify approval recovery'
    });
    store.resolveApproval(approval.id, 'approved');

    expect(store.claimActionAttemptWithApproval(attempt.id, {
      tool: 'git_status', ruleKey: 'git:status', summary: 'different'
    })).toMatchObject({ granted: false, claimed: false, attempt: { status: 'pending' } });
    expect(store.getApproval(approval.id)?.consumedAt).toBeUndefined();

    const claimed = store.claimActionAttemptWithApproval(attempt.id, {
      tool: 'git_status', ruleKey: 'git:status', summary: '{}'
    });
    expect(claimed).toMatchObject({ granted: true, claimed: true, attempt: { id: attempt.id, status: 'executing' } });
    expect(store.getApproval(approval.id)?.consumedAt).toBeTruthy();
    expect(store.claimActionAttemptWithApproval(attempt.id, {
      tool: 'git_status', ruleKey: 'git:status', summary: '{}'
    })).toMatchObject({ granted: true, claimed: true, attempt: { status: 'executing' } });
  });

  it('refuses to approve an action that became terminal while approval was pending', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const project = store.createProject({ name: 'fixture', rootPath: 'C:\\fixture-stale-approval', isGit: true });
    const run = store.createRun({
      projectId: project.id, title: 'stale approval', question: 'do not revive', modelMode: 'fixed',
      providerId: 'openai', model: 'gpt-test'
    });
    const attempt = store.createActionAttempt({
      runId: run.id, sequence: 0, action: { type: 'call_tool', tool: 'git_status', arguments: {} }
    });
    const approval = store.createApproval({
      runId: run.id, actionAttemptId: attempt.id, tool: 'git_status', ruleKey: 'git:status', risk: 'low',
      summary: '{}', policyReason: 'terminal actions cannot resume'
    });
    store.failActionAttempt(attempt.id, 'PROCESS_TERMINATED');

    expect(() => store.resolveApproval(approval.id, 'approved')).toThrow('APPROVAL_STALE');
    expect(store.getApproval(approval.id)?.status).toBe('pending');
    expect(store.getActionAttempt(attempt.id)).toMatchObject({ status: 'failed', error: 'PROCESS_TERMINATED' });
  });

  it('replays an action tool output without duplicating its effect or event', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const project = store.createProject({ name: 'fixture', rootPath: 'C:\\fixture-tool-replay', isGit: true });
    const run = store.createRun({
      projectId: project.id, title: 'tool replay', question: 'write once', modelMode: 'fixed',
      providerId: 'openai', model: 'gpt-test'
    });
    store.upsertTask({
      id: 'task-tool', runId: run.id, title: 'Tool', description: 'persist output', status: 'running', depth: 1,
      dependencies: [], scope: ['.'], docRefs: [], acceptanceCriteria: ['one output']
    });
    const attempt = store.createActionAttempt({
      runId: run.id, taskId: 'task-tool', sequence: 0,
      action: { type: 'call_tool', tool: 'git_status', arguments: {} }
    });
    store.claimActionAttempt(attempt.id);
    const beforeVersion = store.getSnapshotWatermark(run.id).snapshotVersion;
    const first = store.createToolOutput({
      runId: run.id, taskId: 'task-tool', actionAttemptId: attempt.id,
      tool: 'git_status', content: 'clean'
    });
    const replay = store.createToolOutput({
      runId: run.id, taskId: 'task-tool', actionAttemptId: attempt.id,
      tool: 'git_status', content: 'clean'
    });

    expect(replay.id).toBe(first.id);
    expect(store.listToolOutputs(run.id)).toHaveLength(1);
    expect(store.listEvents(run.id).filter((event) => event.type === 'tool.output')).toHaveLength(1);
    expect(store.getSnapshotWatermark(run.id).snapshotVersion).toBe(beforeVersion + 1);
    expect(() => store.createToolOutput({
      runId: run.id, taskId: 'task-tool', actionAttemptId: attempt.id,
      tool: 'git_status', content: 'changed'
    })).toThrow('TOOL_OUTPUT_CONFLICT');
    expect(() => store.createToolOutput({
      runId: run.id, taskId: 'another-task', actionAttemptId: attempt.id,
      tool: 'git_status', content: 'clean'
    })).toThrow('ACTION_ATTEMPT_OWNERSHIP_CONFLICT');
    expect(() => store.createToolOutput({
      runId: run.id, taskId: 'task-tool', actionAttemptId: attempt.id, generation: 2,
      tool: 'git_status', content: 'clean'
    })).toThrow('ACTION_ATTEMPT_OWNERSHIP_CONFLICT');

    const otherProject = store.createProject({ name: 'other', rootPath: 'C:\\fixture-tool-replay-other', isGit: true });
    const otherRun = store.createRun({
      projectId: otherProject.id, title: 'other', question: 'other', modelMode: 'fixed',
      providerId: 'openai', model: 'gpt-test'
    });
    expect(() => store.createToolOutput({
      runId: otherRun.id, actionAttemptId: attempt.id, tool: 'git_status', content: 'clean'
    })).toThrow('ACTION_ATTEMPT_OWNERSHIP_CONFLICT');
  });

  it('supersedes old generations and only exposes verified current task results for integration', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const project = store.createProject({ name: 'fixture', rootPath: 'C:\\fixture-generation', isGit: true });
    const run = store.createRun({
      projectId: project.id, title: 'generation', question: 'invalidate', modelMode: 'fixed',
      providerId: 'openai', model: 'gpt-test', baseRef: 'abc123'
    });
    store.upsertTask({
      id: 'task-old', runId: run.id, generation: 1, title: 'Old', description: 'old task', status: 'completed',
      depth: 1, dependencies: [], scope: ['.'], docRefs: [], acceptanceCriteria: ['done']
    });
    store.upsertTaskResult({
      runId: run.id, taskId: 'task-old', generation: 1, summary: 'done', evidence: ['test'],
      verificationCommands: ['npm.cmd test'], verified: true, commitSha: 'deadbeef', risks: [], unresolved: []
    });
    const pending = store.createActionAttempt({
      runId: run.id, taskId: 'task-old', sequence: 0,
      action: { type: 'pause', reason: 'wait' }
    });
    const approval = store.createApproval({
      runId: run.id, taskId: 'task-old', actionAttemptId: pending.id,
      tool: 'write_file', ruleKey: 'write:task-scope', risk: 'medium',
      summary: 'old generation write', policyReason: 'generation-bound approval'
    });
    const next = store.createPlanGeneration(run.id, [{ docId: 'overall', version: '0.2.0', hash: 'hash-2', sections: [] }]);
    expect(next.generation).toBe(2);
    expect(store.listTasks(run.id)).toEqual([]);
    expect(store.listAllTasks(run.id)[0]).toMatchObject({ generation: 1, status: 'stale' });
    expect(store.getActionAttempt(pending.id)?.status).toBe('cancelled');
    expect(store.getApproval(approval.id)?.status).toBe('rejected');
    expect(() => store.resolveApproval(approval.id, 'approved')).toThrow('APPROVAL_ALREADY_RESOLVED');
    expect(store.listIntegrableTaskResults(run.id)).toEqual([]);
    expect(store.listPlanGenerations(run.id).map((item) => item.status)).toEqual(['superseded', 'draft']);
    expect(store.approvePlanGeneration(run.id).status).toBe('approved');
  });

  it('completes the document revision action in the same transaction that rolls generations', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const project = store.createProject({ name: 'fixture', rootPath: 'C:\\fixture-revise-docs', isGit: true });
    const run = store.createRun({
      projectId: project.id, title: 'revise docs', question: 'new generation', modelMode: 'fixed',
      providerId: 'openai', model: 'gpt-test'
    });
    const revision = store.createActionAttempt({
      runId: run.id, sequence: 0,
      action: { type: 'revise_docs', documentIds: ['overall'], rationale: 'requirements changed' }
    });
    const obsolete = store.createActionAttempt({
      runId: run.id, sequence: 1, action: { type: 'pause', reason: 'old work' }
    });

    const generation = store.createPlanGeneration(
      run.id,
      [{ docId: 'overall', version: '0.2.1', hash: 'hash-new', sections: [] }],
      'requirements changed',
      revision.id
    );

    expect(generation).toMatchObject({ generation: 2, status: 'draft' });
    expect(store.getActionAttempt(revision.id)).toMatchObject({ status: 'completed' });
    expect(store.getActionAttempt(revision.id)?.completedAt).toBeTruthy();
    expect(store.getActionAttempt(obsolete.id)).toMatchObject({
      status: 'cancelled', error: 'PLAN_GENERATION_SUPERSEDED'
    });
  });

  it('enforces run and generation ownership while still allowing historical artifact cleanup', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const project = store.createProject({ name: 'fixture', rootPath: 'C:\\fixture-ownership', isGit: true });
    const run = store.createRun({
      projectId: project.id, title: 'ownership', question: 'isolate records', modelMode: 'fixed',
      providerId: 'openai', model: 'gpt-test'
    });
    const otherProject = store.createProject({ name: 'other', rootPath: 'C:\\fixture-ownership-other', isGit: true });
    const otherRun = store.createRun({
      projectId: otherProject.id, title: 'other', question: 'other', modelMode: 'fixed',
      providerId: 'openai', model: 'gpt-test'
    });
    store.upsertTask({
      id: 'task-owned', runId: run.id, title: 'Owned', description: 'belongs to first run',
      status: 'completed', depth: 1, dependencies: [], scope: ['.'], docRefs: [], acceptanceCriteria: ['done']
    });
    const taskResultInput = {
      taskId: 'task-owned', summary: 'done', evidence: ['test'], verificationCommands: ['npm.cmd test'],
      verified: true, commitSha: 'commit-owned', risks: [], unresolved: []
    };
    expect(() => store.upsertTaskResult({ runId: otherRun.id, ...taskResultInput })).toThrow('TASK_RUN_CONFLICT');
    expect(() => store.upsertWorktreeArtifact({
      runId: otherRun.id, taskId: 'task-owned', kind: 'task', path: 'C:\\other\\task-owned',
      branch: 'loop/other/task-owned', baseRef: 'HEAD', status: 'active'
    })).toThrow('TASK_RUN_CONFLICT');

    store.upsertTaskResult({ runId: run.id, ...taskResultInput });
    const artifact = store.upsertWorktreeArtifact({
      runId: run.id, taskId: 'task-owned', kind: 'task', path: 'C:\\fixture-ownership\\task-owned',
      branch: 'loop/task-owned', baseRef: 'HEAD', status: 'active'
    });
    store.createPlanGeneration(run.id, [{
      docId: 'overall', version: '0.2.1', hash: 'next-hash', sections: []
    }]);

    expect(() => store.upsertTaskResult({
      runId: run.id, generation: 1, ...taskResultInput
    })).toThrow('PLAN_GENERATION_STALE');
    expect(() => store.upsertWorktreeArtifact({
      id: artifact.id, runId: run.id, taskId: 'task-owned', generation: 1, kind: 'task',
      path: artifact.path, branch: artifact.branch, baseRef: artifact.baseRef, status: 'active'
    })).toThrow('PLAN_GENERATION_STALE');

    const discarded = store.upsertWorktreeArtifact({
      id: artifact.id, runId: run.id, taskId: 'task-owned', generation: 1, kind: 'task',
      path: artifact.path, branch: artifact.branch, baseRef: artifact.baseRef, status: 'discarded'
    });
    expect(discarded).toMatchObject({ id: artifact.id, generation: 1, status: 'discarded' });
  });

  it('reserves and settles budget exactly once', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const project = store.createProject({ name: 'fixture', rootPath: 'C:\\fixture-budget', isGit: true });
    const run = store.createRun({
      projectId: project.id, title: 'budget', question: 'account', modelMode: 'fixed',
      providerId: 'openai', model: 'gpt-test'
    });
    const settings = store.getSetting<import('@loop/contracts').AppSettings>('app')!;
    store.setSetting('app', { ...settings, budget: { ...settings.budget, maxCalls: 2, maxEstimatedCost: 1 } });
    const reservation = store.reserveBudget({
      runId: run.id, providerId: 'openai', model: 'gpt-test', inputTokens: 100, outputTokens: 50, estimatedCost: 0.25
    });
    store.settleBudgetReservation(reservation.id, { inputTokens: 80, outputTokens: 40, actualCost: 0.2 });
    store.settleBudgetReservation(reservation.id, { inputTokens: 80, outputTokens: 40, actualCost: 0.2 });
    expect(store.getUsage(run.id)).toEqual({ calls: 1, inputTokens: 80, outputTokens: 40, estimatedCost: 0.2 });
    store.reserveBudget({ runId: run.id, providerId: 'openai', inputTokens: 1, outputTokens: 1, estimatedCost: 0.1 });
    expect(() => store.reserveBudget({
      runId: run.id, providerId: 'openai', inputTokens: 1, outputTokens: 1, estimatedCost: 0.1
    })).toThrow('BUDGET_EXCEEDED');
    expect(store.getRun(run.id)?.blocker?.kind).toBe('budget');
  });

  it('keeps unknown model outcomes reserved until they can be settled', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const project = store.createProject({ name: 'fixture', rootPath: 'C:\\fixture-budget-unknown', isGit: true });
    const run = store.createRun({
      projectId: project.id, title: 'unknown budget', question: 'recover accounting', modelMode: 'fixed',
      providerId: 'openai', model: 'gpt-test'
    });
    const settings = store.getSetting<import('@loop/contracts').AppSettings>('app')!;
    store.setSetting('app', { ...settings, budget: { ...settings.budget, maxCalls: 2 } });
    const reservation = store.reserveBudget({
      runId: run.id, providerId: 'openai', model: 'gpt-test', calls: 2,
      inputTokens: 100, outputTokens: 50, estimatedCost: 0.25
    });

    const unknown = store.markBudgetReservationUnknown(reservation.id);
    expect(unknown).toMatchObject({ status: 'unknown', reservedCalls: 2 });
    expect(unknown.unknownAt).toBeTruthy();
    expect(() => store.releaseBudgetReservation(reservation.id)).toThrow('BUDGET_RESERVATION_OUTCOME_UNKNOWN');
    expect(() => store.reserveBudget({
      runId: run.id, providerId: 'openai', calls: 1, inputTokens: 1, outputTokens: 1
    })).toThrow('BUDGET_EXCEEDED');

    const settled = store.settleBudgetReservation(reservation.id, {
      calls: 1, inputTokens: 80, outputTokens: 40, actualCost: 0.2
    });
    expect(settled).toMatchObject({
      status: 'settled', actualCalls: 1, actualInputTokens: 80, actualOutputTokens: 40, actualCost: 0.2
    });
    expect(store.getUsage(run.id)).toEqual({ calls: 1, inputTokens: 80, outputTokens: 40, estimatedCost: 0.2 });
    expect(store.reserveBudget({
      runId: run.id, providerId: 'openai', calls: 1, inputTokens: 1, outputTokens: 1
    }).status).toBe('reserved');
  });

  it('stores delivery and retained worktree artifacts with a consistent snapshot watermark', () => {
    const store = new LoopStore(':memory:');
    stores.push(store);
    const project = store.createProject({ name: 'fixture', rootPath: 'C:\\fixture-delivery', isGit: true });
    const run = store.createRun({
      projectId: project.id, title: 'delivery', question: 'ship', modelMode: 'fixed',
      providerId: 'openai', model: 'gpt-test', baseRef: 'base-sha'
    });
    store.upsertTask({
      id: 'task-delivery', runId: run.id, title: 'Delivery', description: 'verified task',
      status: 'completed', depth: 1, dependencies: [], scope: ['src/'], docRefs: [], acceptanceCriteria: ['tests pass']
    });
    const beforeResult = store.getSnapshotWatermark(run.id).snapshotVersion;
    const taskResult = store.upsertTaskResult({
      runId: run.id, taskId: 'task-delivery', summary: 'done', evidence: ['tests pass'],
      verificationCommands: ['npm.cmd test'], verified: true, commitSha: 'commit-sha', risks: [], unresolved: []
    });
    expect(store.getSnapshotWatermark(run.id).snapshotVersion).toBe(beforeResult + 1);
    const artifact = store.upsertWorktreeArtifact({
      runId: run.id, kind: 'integration', path: 'C:\\fixture-delivery\\.loop\\integration',
      branch: 'loop/integration', baseRef: run.baseRef, commitSha: 'commit-sha', status: 'completed',
      retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
    });
    expect(store.getSnapshotWatermark(run.id).snapshotVersion).toBe(beforeResult + 2);
    const delivery = store.upsertDeliverySummary({
      runId: run.id, integrationBranch: artifact.branch, filesChanged: ['src/a.ts'], commits: ['commit-sha'],
      verificationCommands: ['npm.cmd test'], taskResults: [taskResult], risks: [], unresolved: [], actualCost: 0.4
    });
    expect(store.getSnapshotWatermark(run.id).snapshotVersion).toBe(beforeResult + 3);
    expect(store.getDeliverySummary(run.id)).toEqual(delivery);
    expect(store.listWorktreeArtifacts(run.id)).toMatchObject([{ id: artifact.id, status: 'completed' }]);
    expect(store.listEvents(run.id).slice(-3).map((event) => event.type)).toEqual([
      'task.result', 'artifact.updated', 'delivery.updated'
    ]);
    const snapshot = store.readSnapshot(run.id, () => ({ delivery: store.getDeliverySummary(run.id) }));
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.snapshotVersion).toBe(snapshot.eventWatermark);
    expect(store.listEvents(run.id).every((event) => event.schemaVersion === 1 && event.snapshotVersion > 0)).toBe(true);
  });
});
