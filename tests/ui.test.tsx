import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NewRunPanel } from '../apps/web/src/components/NewRunPanel.js';
import { Inspector } from '../apps/web/src/components/Inspector.js';
import { eventPresentation } from '../apps/web/src/components/ActivityDrawer.js';
import { FlowView } from '../apps/web/src/views/FlowView.js';
import { hasDocumentDraftConflict, IdeView, parseDocumentDrafts } from '../apps/web/src/views/IdeView.js';
import { applyRunEvent, classifyRunEvent, heartbeatNeedsRefresh, isDocumentContentLoaded, mergeLoadedDocuments } from '../apps/web/src/useLoop.js';
import type { BootstrapPayload, LoopDocument, RunEvent } from '@loop/contracts';
import type { LoopController } from '../apps/web/src/useLoop.js';

describe('new run UI', () => {
  it('exposes fixed/auto routing and only configured providers', () => {
    const controller = {
      working: false,
      createRun: vi.fn(),
      data: {
        currentProject: { id: 'project-1', name: 'fixture', rootPath: 'C:\\fixture', isGit: true, createdAt: new Date().toISOString() },
        providers: [
          { id: 'openai', label: 'OpenAI', configured: false, enabled: true, defaultModel: 'gpt-configured-by-user', availableModels: ['gpt-configured-by-user'], supportsTools: true, supportsReasoning: true },
          { id: 'deepseek', label: 'DeepSeek V4', configured: true, enabled: true, defaultModel: 'deepseek-v4-pro', availableModels: ['deepseek-v4-pro'], supportsTools: true, supportsReasoning: true },
          { id: 'local-demo', label: '本地演示', configured: true, enabled: true, defaultModel: 'local-structured-demo', availableModels: ['local-structured-demo'], supportsTools: false, supportsReasoning: false }
        ]
      }
    } as unknown as LoopController;
    const html = renderToStaticMarkup(<NewRunPanel controller={controller} onClose={vi.fn()} />);
    expect(html).toContain('固定模型');
    expect(html).toContain('智能路由');
    expect(html).toContain('DeepSeek V4');
    expect(html).not.toContain('<option value="openai">');
  });

  it('blocks run creation until a project exists', () => {
    const controller = {
      working: false,
      createRun: vi.fn(),
      data: {
        providers: [{ id: 'local-demo', label: '本地演示', configured: true, enabled: true, defaultModel: 'local-structured-demo', availableModels: ['local-structured-demo'], supportsTools: false, supportsReasoning: false }]
      }
    } as unknown as LoopController;
    const html = renderToStaticMarkup(<NewRunPanel controller={controller} onClose={vi.fn()} />);
    expect(html).toContain('请先添加并选择本地项目');
    expect(html).toContain('disabled=""');
  });
});

describe('workflow UI', () => {
  const baseData = {
    projects: [], runs: [], messages: [], documents: [], tasks: [], agents: [], events: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, elapsedMinutes: 0 },
    providers: [],
    settings: { concurrency: 2, maxDepth: 1, maxAgents: 12, mainDirectLimit: 8, autoMode: false, budget: { maxCalls: 200, maxInputTokens: 5_000_000, maxOutputTokens: 500_000, maxMinutes: 120 } }
  };

  it('keeps a paused run on its previous workflow phase', () => {
    const run = {
      id: 'run-1', projectId: 'project-1', title: 'paused', question: 'test', state: 'paused', previousState: 'executing',
      modelMode: 'fixed', providerId: 'local-demo', model: 'local-structured-demo', allowedProviderIds: ['local-demo'],
      generation: 1, baseRef: 'abc', docsApproved: true, pauseReason: 'waiting', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    const controller = { data: { ...baseData, currentRun: run, runs: [run], approvals: [] }, working: false } as unknown as LoopController;
    const html = renderToStaticMarkup(<FlowView controller={controller} />);
    expect(html).toContain('当前阶段 4 / 5');
    expect(html).toContain('paused · executing');
  });

  it('shows onboarding instead of a fake first phase without a run', () => {
    const controller = { data: { ...baseData, approvals: [] }, working: false } as unknown as LoopController;
    const html = renderToStaticMarkup(<FlowView controller={controller} />);
    expect(html).toContain('先建立一个运行');
    expect(html).not.toContain('当前阶段 1 / 5');
  });

  it('shows approval impact and disables reusable scope for single-use approvals', () => {
    const approval = {
      id: 'approval-1', runId: 'run-1', tool: 'merge_to_project', ruleKey: 'integration:merge', risk: 'high', reusable: false,
      capability: 'git.merge', resource: 'project:fixture', scope: 'once', summary: 'merge', policyReason: 'explicit acceptance',
      status: 'pending', createdAt: new Date().toISOString()
    };
    const controller = {
      data: { ...baseData, approvals: [approval] }, working: false,
      resolveApproval: vi.fn(), approveDocs: vi.fn(), execute: vi.fn(), initializeGit: vi.fn()
    } as unknown as LoopController;
    const html = renderToStaticMarkup(<Inspector controller={controller} onEditDocument={vi.fn()} />);
    expect(html).toContain('role="tab"');
    expect(html).toContain('integration:merge');
    expect(html).toContain('project:fixture');
    expect(html).toContain('disabled=""');
  });

  it('locks acceptance until the matching delivery is ready and renders complete evidence', () => {
    const run = {
      id: 'run-delivery', projectId: 'project-1', title: 'delivery', question: 'test', state: 'awaiting_acceptance', previousState: 'verifying',
      modelMode: 'fixed', providerId: 'local-demo', model: 'local-structured-demo', allowedProviderIds: ['local-demo'],
      generation: 2, baseRef: 'base-1', docsApproved: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    const delivery = {
      runId: run.id, generation: 2, baseRef: 'base-1', integrationBranch: 'loop/integration/run-delivery',
      filesChanged: ['src/index.ts'], commits: ['abc123'], verificationCommands: ['npm.cmd test'],
      taskResults: [{
        id: 'result-1', runId: run.id, taskId: 'task-1', generation: 2, summary: '核心路径已完成', evidence: ['test'],
        verificationCommands: ['npm.cmd test'], verified: true, commitSha: 'abc123', risks: [], unresolved: [],
        createdAt: new Date().toISOString(), verifiedAt: new Date().toISOString()
      }],
      risks: ['需要人工观察'], unresolved: ['尚未覆盖离线恢复'], actualCost: 0.25,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    const readyController = {
      data: { ...baseData, currentRun: run, runs: [run], approvals: [] }, delivery, deliveryStatus: 'ready', working: false,
      acceptDelivery: vi.fn(), approveDocs: vi.fn(), execute: vi.fn(), initializeGit: vi.fn()
    } as unknown as LoopController;
    const readyHtml = renderToStaticMarkup(<FlowView controller={readyController} />);
    expect(readyHtml).toContain('abc123');
    expect(readyHtml).toContain('核心路径已完成');
    expect(readyHtml).toContain('尚未覆盖离线恢复');

    const loadingController = { ...readyController, delivery: undefined, deliveryStatus: 'loading' } as unknown as LoopController;
    const loadingHtml = renderToStaticMarkup(<FlowView controller={loadingController} />);
    expect(loadingHtml).toContain('正在核对交付摘要');
    expect((loadingHtml.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it('locks the IDE editor while document metadata is waiting for its body', () => {
    const createdAt = new Date().toISOString();
    const project = { id: 'project-1', name: 'fixture', rootPath: 'C:\\fixture', isGit: true, createdAt };
    const run = {
      id: 'run-1', projectId: project.id, title: 'run', question: 'test', state: 'doc_review',
      modelMode: 'fixed', providerId: 'local-demo', model: 'local-structured-demo', allowedProviderIds: ['local-demo'],
      generation: 1, baseRef: 'base', docsApproved: false, createdAt, updatedAt: createdAt
    };
    const metadata = {
      id: 'architecture', projectId: project.id, filename: 'docs/总体方案.md', title: '方案', version: '0.2.0',
      status: 'draft', hash: 'hash-1', content: '', contentLoaded: false, updatedAt: createdAt
    };
    const controller = {
      data: { ...baseData, currentProject: project, currentRun: run, runs: [run], documents: [metadata], approvals: [] },
      working: false, connectionState: 'live', loadDocument: vi.fn(), saveDocument: vi.fn()
    } as unknown as LoopController;
    const html = renderToStaticMarkup(<IdeView controller={controller} />);
    expect(html).toContain('正在加载文档正文');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
  });
});

describe('incremental run synchronization', () => {
  const createdAt = new Date().toISOString();
  const run = {
    id: 'run-1', projectId: 'project-1', title: 'run', question: 'test', state: 'executing', previousState: 'decomposing',
    modelMode: 'fixed', providerId: 'local-demo', model: 'local-structured-demo', allowedProviderIds: ['local-demo'],
    generation: 1, baseRef: 'base', docsApproved: true, createdAt, updatedAt: createdAt
  } as const;
  const basePayload = {
    sessionToken: '', projects: [], runs: [run], currentRun: run, messages: [],
    documents: [{ id: 'architecture', projectId: 'project-1', filename: 'docs/总体方案.md', title: '方案', version: '0.2.0', status: 'approved', hash: 'hash-1', content: '# old', updatedAt: createdAt }],
    tasks: [{ id: 'task-1', runId: run.id, title: 'old', description: 'old generation', status: 'running', generation: 1, depth: 1, dependencies: [], scope: ['src'], docRefs: [], acceptanceCriteria: ['done'] }],
    agents: [{ id: 'agent-1', runId: run.id, name: 'Agent', role: 'subagent', status: 'running', depth: 1, providerId: 'local-demo', model: 'local-structured-demo', contextUsage: 0.2, lineage: 1 }],
    approvals: [], events: [], usage: { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, elapsedMinutes: 0 },
    snapshotVersion: 1, eventWatermark: 10, providers: [],
    settings: { concurrency: 2, maxDepth: 1, maxAgents: 12, mainDirectLimit: 8, autoMode: false, budget: { maxCalls: 200, maxInputTokens: 5_000_000, maxOutputTokens: 500_000, maxMinutes: 120 } }
  } as unknown as BootstrapPayload;

  const event = (overrides: Partial<RunEvent> = {}): RunEvent => ({
    id: 12, runId: run.id, type: 'task.state', payload: { taskId: 'task-1', status: 'completed', generation: 1 },
    schemaVersion: 1, entityRevision: 2, snapshotVersion: 2, createdAt, ...overrides
  });

  it('uses per-run snapshot versions rather than globally sparse event ids', () => {
    expect(classifyRunEvent(event(), run.id, 1)).toBe('apply');
    expect(classifyRunEvent(event({ runId: 'run-other' }), run.id, 1)).toBe('ignore');
    expect(classifyRunEvent(event({ snapshotVersion: 4 }), run.id, 1)).toBe('refresh');
    expect(heartbeatNeedsRefresh(3, 20, 2, 19)).toBe(true);
    expect(heartbeatNeedsRefresh(2, 19, 2, 19)).toBe(false);
  });

  it('clears stale generation entities and preserves document truth until bootstrap refresh', () => {
    const invalidated = event({
      type: 'doc.invalidated',
      payload: { generation: 2, reason: '文档 architecture 已改变' }
    });
    const next = applyRunEvent(basePayload, invalidated);
    expect(next.currentRun?.generation).toBe(2);
    expect(next.currentRun?.docsApproved).toBe(false);
    expect(next.tasks).toEqual([]);
    expect(next.agents).toEqual([]);
    expect(next.documents[0]?.status).toBe('approved');
    expect(next.snapshotVersion).toBe(2);
    expect(next.eventWatermark).toBe(12);
  });

  it('never applies an event from another run', () => {
    expect(applyRunEvent(basePayload, event({ runId: 'run-other' }))).toBe(basePayload);
  });

  it('does not erase the real previous phase on a same-state blocker update', () => {
    const pausedRun = { ...run, state: 'paused' as const, previousState: 'executing' as const };
    const pausedPayload = { ...basePayload, currentRun: pausedRun, runs: [pausedRun] } as BootstrapPayload;
    const next = applyRunEvent(pausedPayload, event({ type: 'run.state', payload: { state: 'paused', blocker: { kind: 'approval' } } }));
    expect(next.currentRun?.previousState).toBe('executing');
  });
});

describe('local draft safety', () => {
  const document = {
    id: 'architecture', projectId: 'project-1', filename: 'docs/总体方案.md', title: '方案', version: '0.2.0',
    status: 'approved', hash: 'new-hash', content: '# server', updatedAt: new Date().toISOString()
  } as LoopDocument;

  it('rejects malformed storage records and detects a stale base hash', () => {
    expect(parseDocumentDrafts('{not-json')).toEqual({});
    expect(parseDocumentDrafts(JSON.stringify({ broken: { content: 1 }, valid: { content: '# draft', baseHash: 'old-hash', updatedAt: 'now' } }))).toEqual({
      valid: { content: '# draft', baseHash: 'old-hash', updatedAt: 'now' }
    });
    expect(hasDocumentDraftConflict({ content: '# draft', baseHash: 'old-hash', updatedAt: 'now' }, document)).toBe(true);
    expect(hasDocumentDraftConflict({ content: '# server', baseHash: 'old-hash', updatedAt: 'now' }, document)).toBe(false);
  });

  it('preserves a loaded body only while metadata identity and hash still match', () => {
    const loaded = { ...document, contentLoaded: true };
    const metadata = { ...document, content: '', contentLoaded: false };
    expect(isDocumentContentLoaded(metadata)).toBe(false);
    expect(mergeLoadedDocuments([metadata], [loaded])[0]).toMatchObject({ content: '# server', contentLoaded: true });
    expect(mergeLoadedDocuments([{ ...metadata, hash: 'changed' }], [loaded])[0]).toMatchObject({ content: '', contentLoaded: false });
  });
});

describe('activity event presentation', () => {
  const createdAt = new Date().toISOString();
  const makeEvent = (type: RunEvent['type'], payload: unknown): RunEvent => ({
    id: 1, runId: 'run-1', type, payload, schemaVersion: 1, entityRevision: 1, snapshotVersion: 1, createdAt
  });

  it('reads nested usage and does not label resolved approvals as errors', () => {
    expect(eventPresentation(makeEvent('budget.updated', { usage: { calls: 3, inputTokens: 1234 } })).detail).toContain('3 次调用');
    expect(eventPresentation(makeEvent('approval.resolved', { status: 'approved', summary: 'npm test' })).title).toBe('审批已批准');
    expect(eventPresentation(makeEvent('doc.invalidated', { reason: '规范已更新' })).detail).toBe('规范已更新');
  });
});
