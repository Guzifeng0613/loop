import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, BootstrapPayload, LoopDocument, ViewMode } from '@loop/contracts';
import { api } from './api';

const emptyPayload: BootstrapPayload = {
  sessionToken: '', projects: [], runs: [], messages: [], documents: [], tasks: [], agents: [], approvals: [], providers: [],
  settings: { concurrency: 8, maxDepth: 2, maxAgents: 60, mainDirectLimit: 30, autoMode: false, budget: { maxCalls: 200, maxInputTokens: 5_000_000, maxOutputTokens: 500_000, maxMinutes: 120 } }
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

export function useLoop() {
  const [data, setData] = useState<BootstrapPayload>(emptyPayload);
  const [view, setViewState] = useState<ViewMode>(loadView);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const refreshTimer = useRef<number | undefined>(undefined);
  const selection = useRef<{ runId?: string; projectId?: string }>({});

  const refresh = useCallback(async (runId = selection.current.runId, projectId = selection.current.projectId) => {
    try {
      const next = await api.bootstrap(runId, projectId);
      selection.current = {
        ...(next.currentRun ? { runId: next.currentRun.id } : {}),
        ...(next.currentProject ? { projectId: next.currentProject.id } : {})
      };
      startTransition(() => setData(next));
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 980) setViewState('flow');
    };
    window.addEventListener('resize', handleResize, { passive: true });
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!data.currentRun) return;
    const source = new EventSource(`/api/runs/${data.currentRun.id}/events`);
    source.onmessage = () => {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => void refresh(), 120);
    };
    const eventNames = ['message.completed', 'run.state', 'agent.state', 'task.state', 'approval.requested', 'budget.updated', 'doc.invalidated', 'error'];
    for (const eventName of eventNames) source.addEventListener(eventName, source.onmessage);
    return () => {
      window.clearTimeout(refreshTimer.current);
      source.close();
    };
  }, [data.currentRun?.id, refresh]);

  const perform = useCallback(async (action: () => Promise<unknown>) => {
    setWorking(true);
    setError(undefined);
    try {
      await action();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setWorking(false);
    }
  }, [refresh]);

  const setView = (next: ViewMode) => {
    setViewState(next);
    localStorage.setItem('loop.ui.v1', JSON.stringify({ view: next }));
  };

  return {
    data, view, loading, working, error, setView,
    selectRun: (runId: string) => refresh(runId, data.currentProject?.id),
    selectProject: (projectId: string) => refresh(undefined, projectId),
    sendMessage: (content: string) => data.currentRun && perform(() => api.sendMessage(data.currentRun!.id, content)),
    approveDocs: () => data.currentRun && perform(() => api.approveAllDocs(data.currentRun!.id)),
    saveDocument: (doc: LoopDocument, content: string) => data.currentRun && perform(() => api.saveDocument(data.currentRun!.id, doc, content)),
    execute: () => data.currentRun && perform(() => api.execute(data.currentRun!.id)),
    runAction: (action: 'pause' | 'resume' | 'cancel') => data.currentRun && perform(() => api.runAction(data.currentRun!.id, action)),
    resolveApproval: (approvalId: string, decision: 'approved' | 'rejected') => data.currentRun && perform(() => api.resolveApproval(data.currentRun!.id, approvalId, decision)),
    saveProvider: (providerId: 'openai' | 'deepseek', key: string) => perform(() => api.saveProvider(providerId, key)),
    clearProvider: (providerId: 'openai' | 'deepseek') => perform(() => api.clearProvider(providerId)),
    saveSettings: (settings: Partial<AppSettings>) => perform(() => api.saveSettings(settings)),
    createProject: (rootPath: string) => perform(() => api.createProject(rootPath)),
    createRun: async (input: Parameters<typeof api.createRun>[0]) => {
      setWorking(true);
      setError(undefined);
      try {
        const run = await api.createRun(input);
        await refresh(run.id, input.projectId);
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

export type LoopController = ReturnType<typeof useLoop>;
