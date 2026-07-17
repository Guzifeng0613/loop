import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import { runEventSchema, runStateSchema } from '@loop/contracts';
import type { AppSettings, BootstrapPayload, DeliverySummary, LoopDocument, RunEvent, ViewMode } from '@loop/contracts';
import { api } from './api';

const emptyPayload: BootstrapPayload = {
  sessionToken: '', projects: [], runs: [], messages: [], documents: [], tasks: [], agents: [], approvals: [], events: [],
  usage: { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, elapsedMinutes: 0 }, providers: [],
  settings: { concurrency: 2, maxDepth: 1, maxAgents: 12, mainDirectLimit: 8, autoMode: false, budget: { maxCalls: 200, maxInputTokens: 5_000_000, maxOutputTokens: 500_000, maxMinutes: 120 } }
};

type DeliveryLoadState = {
  runId?: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  data?: DeliverySummary;
  error?: string;
};

function loadView(): ViewMode {
  if (window.innerWidth < 980) return 'flow';
  try {
    const parsed = JSON.parse(localStorage.getItem('loop.ui.v1') ?? '{}') as { view?: ViewMode };
    return parsed.view ?? 'workbench';
  } catch {
    return 'workbench';
  }
}

export function isDocumentContentLoaded(document: LoopDocument): boolean {
  return document.contentLoaded === true || (document.contentLoaded !== false && document.content.length > 0);
}

export function mergeLoadedDocuments(metadata: LoopDocument[], previous: LoopDocument[]): LoopDocument[] {
  const loadedByKey = new Map(
    previous
      .filter(isDocumentContentLoaded)
      .map((document) => [`${document.projectId}:${document.id}`, document] as const)
  );
  return metadata.map((document) => {
    if (isDocumentContentLoaded(document)) return { ...document, contentLoaded: true };
    const loaded = loadedByKey.get(`${document.projectId}:${document.id}`);
    return loaded?.hash === document.hash
      ? { ...document, content: loaded.content, contentLoaded: true }
      : { ...document, content: '', contentLoaded: false };
  });
}

export function useLoop() {
  const [data, setData] = useState<BootstrapPayload>(emptyPayload);
  const [view, setViewState] = useState<ViewMode>(loadView);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [connectionState, setConnectionState] = useState<'connecting' | 'live' | 'reconnecting' | 'offline'>('offline');
  const [deliveryState, setDeliveryState] = useState<DeliveryLoadState>({ status: 'idle' });
  const [deliveryRefreshVersion, setDeliveryRefreshVersion] = useState(0);
  const refreshTimer = useRef<number | undefined>(undefined);
  const resyncingRunId = useRef<string | undefined>(undefined);
  const lastEventId = useRef(0);
  const lastSnapshotVersion = useRef(0);
  const activeRunId = useRef<string | undefined>(undefined);
  const refreshSequence = useRef(0);
  const refreshInFlight = useRef(0);
  const selection = useRef<{ runId?: string; projectId?: string }>({});
  const dataRef = useRef(data);
  const documentRequests = useRef(new Map<string, Promise<LoopDocument>>());
  dataRef.current = data;

  const refresh = useCallback(async (target?: { runId?: string; projectId?: string }) => {
    const requestTarget = target ?? selection.current;
    const sequence = ++refreshSequence.current;
    refreshInFlight.current += 1;
    try {
      const next = await api.bootstrap(requestTarget.runId, requestTarget.projectId);
      if (sequence !== refreshSequence.current) return false;
      selection.current = {
        ...(next.currentRun ? { runId: next.currentRun.id } : {}),
        ...(next.currentProject ? { projectId: next.currentProject.id } : {})
      };
      activeRunId.current = next.currentRun?.id;
      lastEventId.current = next.eventWatermark ?? next.events.at(-1)?.id ?? 0;
      lastSnapshotVersion.current = next.snapshotVersion ?? next.events.at(-1)?.snapshotVersion ?? 0;
      startTransition(() => setData((current) => ({
        ...next,
        documents: mergeLoadedDocuments(next.documents, current.documents)
      })));
      setError(undefined);
      return true;
    } catch (reason) {
      if (sequence === refreshSequence.current) setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      refreshInFlight.current = Math.max(0, refreshInFlight.current - 1);
      if (sequence === refreshSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (data.currentRun?.state !== 'awaiting_acceptance') {
      setDeliveryState({ status: 'idle' });
      return;
    }
    const runId = data.currentRun.id;
    let active = true;
    setDeliveryState({ runId, status: 'loading' });
    void api.getDelivery(runId)
      .then((result) => {
        if (!active) return;
        if (result.runId !== runId) throw new Error('交付摘要与当前运行不匹配');
        setDeliveryState({ runId, status: 'ready', data: result });
      })
      .catch((reason) => {
        if (!active) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setDeliveryState({ runId, status: 'error', error: message });
        setError(message);
      });
    return () => { active = false; };
  }, [data.currentRun?.id, data.currentRun?.state, deliveryRefreshVersion]);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 980) setViewState('flow');
    };
    window.addEventListener('resize', handleResize, { passive: true });
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!data.currentRun) {
      setConnectionState('offline');
      return;
    }
    const subscribedRunId = data.currentRun.id;
    const subscribedProjectId = data.currentProject?.id;
    setConnectionState('connecting');
    const source = new EventSource(`/api/runs/${subscribedRunId}/events?after=${lastEventId.current}`);

    const requestRefresh = () => {
      if (activeRunId.current !== subscribedRunId || resyncingRunId.current === subscribedRunId) return;
      resyncingRunId.current = subscribedRunId;
      const retry = () => {
        if (activeRunId.current !== subscribedRunId) {
          refreshTimer.current = undefined;
          if (resyncingRunId.current === subscribedRunId) resyncingRunId.current = undefined;
          return;
        }
        if (refreshInFlight.current > 0) {
          refreshTimer.current = window.setTimeout(retry, 50);
          return;
        }
        refreshTimer.current = undefined;
        void refresh({ runId: subscribedRunId, ...(subscribedProjectId ? { projectId: subscribedProjectId } : {}) })
          .finally(() => {
            if (resyncingRunId.current === subscribedRunId) resyncingRunId.current = undefined;
          });
      };
      refreshTimer.current = window.setTimeout(retry, 50);
    };

    const receive = (message: MessageEvent<string>) => {
      let raw: unknown;
      try {
        raw = JSON.parse(message.data);
      } catch {
        requestRefresh();
        return;
      }
      const parsed = runEventSchema.safeParse(raw);
      if (!parsed.success) {
        requestRefresh();
        return;
      }
      const event = parsed.data as RunEvent;
      const decision = classifyRunEvent(event, subscribedRunId, lastSnapshotVersion.current);
      if (decision === 'ignore') {
        if (event.runId === subscribedRunId) lastEventId.current = Math.max(lastEventId.current, event.id);
        return;
      }
      if (decision === 'refresh') {
        requestRefresh();
        return;
      }
      lastEventId.current = event.id;
      lastSnapshotVersion.current = event.snapshotVersion;
      startTransition(() => setData((current) => applyRunEvent(current, event)));
      if (event.type === 'doc.invalidated') requestRefresh();
      if (event.type === 'delivery.updated') setDeliveryRefreshVersion((current) => current + 1);
      if (event.type === 'error') {
        const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
        setError(String(payload.message ?? '运行发生错误'));
      }
    };

    const receiveHeartbeat = (message: MessageEvent<string>) => {
      if (activeRunId.current !== subscribedRunId) return;
      setConnectionState('live');
      try {
        const payload = JSON.parse(message.data) as { eventWatermark?: unknown; snapshotVersion?: unknown };
        if (heartbeatNeedsRefresh(
          Number(payload.snapshotVersion),
          Number(payload.eventWatermark),
          lastSnapshotVersion.current,
          lastEventId.current
        )) requestRefresh();
      } catch {
        requestRefresh();
      }
    };

    source.onopen = () => {
      if (activeRunId.current === subscribedRunId) setConnectionState('live');
    };
    source.onerror = () => {
      if (activeRunId.current === subscribedRunId) setConnectionState(navigator.onLine ? 'reconnecting' : 'offline');
    };
    source.addEventListener('loop.heartbeat', receiveHeartbeat as EventListener);
    const eventNames = ['message.delta', 'message.completed', 'run.state', 'agent.state', 'task.state', 'task.result', 'artifact.updated', 'delivery.updated', 'tool.output', 'approval.requested', 'approval.resolved', 'budget.updated', 'doc.invalidated', 'loop.error'];
    for (const eventName of eventNames) source.addEventListener(eventName, receive as EventListener);

    return () => {
      if (resyncingRunId.current === subscribedRunId) {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = undefined;
        resyncingRunId.current = undefined;
      }
      source.close();
      setConnectionState('offline');
    };
  }, [data.currentProject?.id, data.currentRun?.id, refresh]);

  const cacheLoadedDocument = useCallback((document: LoopDocument) => {
    const loaded: LoopDocument = { ...document, contentLoaded: true };
    startTransition(() => setData((current) => {
      if (current.currentProject?.id !== loaded.projectId) return current;
      let found = false;
      const documents = current.documents.map((item) => {
        if (item.projectId !== loaded.projectId || item.id !== loaded.id) return item;
        found = true;
        return loaded;
      });
      return found ? { ...current, documents } : current;
    }));
    return loaded;
  }, []);

  const loadDocument = useCallback((docId: string): Promise<LoopDocument> => {
    const current = dataRef.current;
    const run = current.currentRun;
    if (!run) return Promise.reject(new Error('尚未选择运行，无法读取文档正文'));
    const metadata = current.documents.find((document) => document.id === docId && document.projectId === run.projectId);
    if (!metadata) return Promise.reject(new Error('文档不存在或不属于当前运行'));
    if (isDocumentContentLoaded(metadata)) return Promise.resolve(metadata);
    const key = `${run.id}:${metadata.projectId}:${metadata.id}:${metadata.hash}`;
    const existing = documentRequests.current.get(key);
    if (existing) return existing;
    const request = api.getDocument(run.id, metadata.id).then((document) => {
      if (document.id !== metadata.id || document.projectId !== metadata.projectId) {
        throw new Error('文档正文响应与当前元数据不匹配');
      }
      return cacheLoadedDocument(document);
    });
    const tracked = request.finally(() => { documentRequests.current.delete(key); });
    documentRequests.current.set(key, tracked);
    return tracked;
  }, [cacheLoadedDocument]);

  const perform = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    setWorking(true);
    setError(undefined);
    try {
      const result = await action();
      await refresh();
      return result;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setWorking(false);
    }
  }, [refresh]);

  const saveDocument = useCallback((doc: LoopDocument, content: string) => {
    const run = dataRef.current.currentRun;
    if (!run) return undefined;
    return perform(async () => {
      const saved = await api.saveDocument(run.id, doc, content);
      return cacheLoadedDocument(saved);
    }).then((saved) => cacheLoadedDocument(saved));
  }, [cacheLoadedDocument, perform]);

  const setView = (next: ViewMode) => {
    setViewState(next);
    try {
      localStorage.setItem('loop.ui.v1', JSON.stringify({ view: next }));
    } catch {
      // View selection remains usable when storage is disabled or full.
    }
  };

  const currentRunId = data.currentRun?.id;
  const delivery = deliveryState.status === 'ready' && deliveryState.runId === currentRunId ? deliveryState.data : undefined;
  const deliveryStatus = data.currentRun?.state !== 'awaiting_acceptance'
    ? 'idle'
    : deliveryState.runId === currentRunId ? deliveryState.status : 'loading';
  const deliveryError = deliveryState.runId === currentRunId ? deliveryState.error : undefined;

  return {
    data, delivery, deliveryStatus, deliveryError, view, loading, working, error, connectionState, setView,
    selectRun: (runId: string) => refresh({ runId, ...(data.currentProject?.id ? { projectId: data.currentProject.id } : {}) }),
    selectProject: (projectId: string) => refresh({ projectId }),
    sendMessage: (content: string) => data.currentRun && perform(() => api.sendMessage(data.currentRun!.id, content)),
    approveDocs: () => data.currentRun && perform(() => api.approveAllDocs(data.currentRun!.id)),
    loadDocument,
    saveDocument,
    execute: () => data.currentRun && perform(() => api.execute(data.currentRun!.id)),
    runAction: (action: 'pause' | 'resume' | 'cancel' | 'retry') => data.currentRun && perform(() => api.runAction(data.currentRun!.id, action)),
    acceptDelivery: (decision: 'accept_keep_branch' | 'accept_merge' | 'request_changes' | 'discard', feedback?: string) => {
      const run = data.currentRun;
      if (!run) return undefined;
      if (deliveryStatus !== 'ready' || delivery?.runId !== run.id) {
        setError('交付摘要尚未就绪，请确认摘要后再提交验收决定。');
        return Promise.resolve();
      }
      return perform(() => api.acceptDelivery(run.id, decision, feedback));
    },
    exportRun: () => data.currentRun && api.exportRun(data.currentRun.id),
    getToolOutput: (outputId: string) => data.currentRun ? api.getToolOutput(data.currentRun.id, outputId) : Promise.reject(new Error('尚未选择运行')),
    resolveApproval: (approvalId: string, decision: 'approved' | 'rejected', scope: 'once' | 'rule' = 'once') =>
      data.currentRun && perform(() => api.resolveApproval(data.currentRun!.id, approvalId, decision, scope)),
    saveProvider: (providerId: 'openai' | 'deepseek', key: string) => perform(() => api.saveProvider(providerId, key)),
    clearProvider: (providerId: 'openai' | 'deepseek') => perform(() => api.clearProvider(providerId)),
    saveSettings: (settings: Partial<AppSettings>) => perform(() => api.saveSettings(settings)),
    createProject: (rootPath: string) => perform(() => api.createProject(rootPath)),
    createRun: async (input: Parameters<typeof api.createRun>[0]) => {
      setWorking(true);
      setError(undefined);
      try {
        const run = await api.createRun(input);
        await refresh({ runId: run.id, projectId: input.projectId });
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        throw reason;
      } finally {
        setWorking(false);
      }
    },
    initializeGit: () => data.currentProject && perform(() => api.initializeGit(data.currentProject!.id)),
    dismissError: () => setError(undefined)
  };
}

export type RunEventDecision = 'ignore' | 'apply' | 'refresh';

export function classifyRunEvent(event: RunEvent, subscribedRunId: string, currentSnapshotVersion: number): RunEventDecision {
  if (event.runId !== subscribedRunId) return 'ignore';
  if (event.snapshotVersion <= currentSnapshotVersion) return 'ignore';
  return event.snapshotVersion === currentSnapshotVersion + 1 ? 'apply' : 'refresh';
}

export function heartbeatNeedsRefresh(
  remoteSnapshotVersion: number,
  remoteEventWatermark: number,
  currentSnapshotVersion: number,
  currentEventWatermark: number
): boolean {
  if (!Number.isInteger(remoteSnapshotVersion) || !Number.isInteger(remoteEventWatermark)) return true;
  if (remoteSnapshotVersion > currentSnapshotVersion) return true;
  return remoteSnapshotVersion === currentSnapshotVersion && remoteEventWatermark > currentEventWatermark;
}

export function applyRunEvent(current: BootstrapPayload, event: RunEvent): BootstrapPayload {
  if (current.currentRun?.id !== event.runId) return current;
  if ((current.snapshotVersion ?? 0) >= event.snapshotVersion) return current;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  const events = [...current.events.filter((item) => item.id !== event.id), event].slice(-500);
  const synchronized: BootstrapPayload = {
    ...current,
    events,
    snapshotVersion: event.snapshotVersion,
    eventWatermark: Math.max(current.eventWatermark ?? 0, event.id)
  };

  if (event.type === 'message.completed') {
    const message = payload as unknown as BootstrapPayload['messages'][number];
    if (typeof message.id !== 'string') return synchronized;
    return { ...synchronized, messages: current.messages.some((item) => item.id === message.id) ? current.messages : [...current.messages, message] };
  }

  if (event.type === 'run.state') {
    const parsedState = runStateSchema.safeParse(payload.state);
    if (!parsedState.success) return synchronized;
    const state = parsedState.data;
    const candidateGeneration = Number(payload.generation);
    const generation = Number.isInteger(candidateGeneration) && candidateGeneration > 0
      ? candidateGeneration
      : current.currentRun.generation;
    const generationChanged = generation !== current.currentRun.generation;
    const nextRun: NonNullable<BootstrapPayload['currentRun']> = {
      ...current.currentRun,
      ...(state !== current.currentRun.state ? { previousState: current.currentRun.state } : {}),
      state,
      generation,
      ...(typeof payload.docsApproved === 'boolean' ? { docsApproved: payload.docsApproved } : {}),
      ...(typeof payload.baseRef === 'string' ? { baseRef: payload.baseRef } : {}),
      ...(payload.blocker ? { blocker: payload.blocker as NonNullable<NonNullable<BootstrapPayload['currentRun']>['blocker']> } : {}),
      ...(payload.reason ? { pauseReason: String(payload.reason) } : {})
    };
    if (payload.blocker === null) delete nextRun.blocker;
    if (payload.reason === null) delete nextRun.pauseReason;
    return {
      ...synchronized,
      currentRun: nextRun,
      runs: current.runs.map((run) => run.id === event.runId ? { ...run, ...nextRun } : run),
      ...(generationChanged ? { tasks: [], agents: [] } : {})
    };
  }

  if (event.type === 'task.state') {
    const candidateGeneration = payload.generation === undefined ? current.currentRun.generation : Number(payload.generation);
    if (candidateGeneration !== current.currentRun.generation) return synchronized;
    return payload.status
      ? { ...synchronized, tasks: current.tasks.map((task) => task.id === payload.taskId ? { ...task, status: payload.status as typeof task.status } : task) }
      : synchronized;
  }

  if (event.type === 'agent.state') {
    return {
      ...synchronized,
      agents: current.agents.map((agent) => agent.id === payload.agentId ? {
        ...agent,
        ...(typeof payload.status === 'string' ? { status: payload.status as typeof agent.status } : {}),
        contextUsage: Number.isFinite(Number(payload.contextUsage)) ? Number(payload.contextUsage) : agent.contextUsage
      } : agent)
    };
  }

  if (event.type === 'approval.requested') {
    const approval = payload as unknown as BootstrapPayload['approvals'][number];
    if (typeof approval.id !== 'string') return synchronized;
    return { ...synchronized, approvals: current.approvals.some((item) => item.id === approval.id) ? current.approvals : [approval, ...current.approvals] };
  }

  if (event.type === 'approval.resolved') {
    const approval = payload as unknown as BootstrapPayload['approvals'][number];
    if (typeof approval.id !== 'string') return synchronized;
    return {
      ...synchronized,
      approvals: current.approvals.some((item) => item.id === approval.id)
        ? current.approvals.map((item) => item.id === approval.id ? approval : item)
        : [approval, ...current.approvals]
    };
  }

  if (event.type === 'budget.updated') {
    const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : payload;
    return {
      ...synchronized,
      usage: {
        ...current.usage,
        calls: Number(usage.calls ?? current.usage.calls),
        inputTokens: Number(usage.input_tokens ?? usage.inputTokens ?? current.usage.inputTokens),
        outputTokens: Number(usage.output_tokens ?? usage.outputTokens ?? current.usage.outputTokens),
        estimatedCost: Number(usage.estimated_cost ?? usage.estimatedCost ?? current.usage.estimatedCost)
      }
    };
  }

  if (event.type === 'doc.invalidated') {
    const candidateGeneration = Number(payload.generation);
    const generation = Number.isInteger(candidateGeneration) && candidateGeneration > 0
      ? candidateGeneration
      : current.currentRun.generation + 1;
    const reason = String(payload.reason ?? '规范文档已变更');
    const nextRun: NonNullable<BootstrapPayload['currentRun']> = {
      ...current.currentRun,
      generation,
      docsApproved: false,
      blocker: {
        kind: 'documents',
        code: 'DOC_VERSION_STALE',
        message: reason,
        since: event.createdAt,
        recoverable: true
      }
    };
    return {
      ...synchronized,
      currentRun: nextRun,
      runs: current.runs.map((run) => run.id === event.runId ? { ...run, ...nextRun } : run),
      tasks: [],
      agents: []
    };
  }

  return synchronized;
}

export type LoopController = ReturnType<typeof useLoop>;
