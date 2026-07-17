import type { AppSettings, BootstrapPayload, DeliverySummary, LoopDocument, ProviderId, Run, ToolOutput } from '@loop/contracts';

export class ApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

let sessionToken = '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(sessionToken ? { 'X-Loop-Session': sessionToken } : {}),
      ...init?.headers
    }
  });
  const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
  if (!response.ok) throw new ApiError(payload.error?.code ?? 'REQUEST_FAILED', payload.error?.message ?? `请求失败：${response.status}`);
  return payload as T;
}

export const api = {
  async bootstrap(runId?: string, projectId?: string): Promise<BootstrapPayload> {
    const query = new URLSearchParams();
    if (runId) query.set('runId', runId);
    if (projectId) query.set('projectId', projectId);
    const data = await request<BootstrapPayload>(`/bootstrap${query.size ? `?${query}` : ''}`);
    sessionToken = data.sessionToken;
    return data;
  },
  sendMessage: (runId: string, content: string) => request(`/runs/${runId}/messages`, { method: 'POST', body: JSON.stringify({ content }) }),
  approveAllDocs: (runId: string) => request(`/runs/${runId}/docs/approve-all`, { method: 'POST' }),
  getDocument: (runId: string, docId: string) => request<LoopDocument>(`/runs/${runId}/docs/${docId}`),
  saveDocument: (runId: string, document: LoopDocument, content: string) => request<LoopDocument>(`/runs/${runId}/docs/${document.id}`, { method: 'PATCH', body: JSON.stringify({ content }) }),
  execute: (runId: string) => request(`/runs/${runId}/execute`, { method: 'POST' }),
  runAction: (runId: string, action: 'pause' | 'resume' | 'cancel' | 'retry') => request(`/runs/${runId}`, { method: 'PATCH', body: JSON.stringify({ action }) }),
  getDelivery: (runId: string) => request<DeliverySummary>(`/runs/${runId}/delivery`),
  acceptDelivery: (runId: string, decision: 'accept_keep_branch' | 'accept_merge' | 'request_changes' | 'discard', feedback?: string) =>
    request(`/runs/${runId}/acceptance`, { method: 'POST', body: JSON.stringify({ decision, ...(feedback ? { feedback } : {}) }) }),
  getToolOutput: (runId: string, outputId: string) => request<ToolOutput>(`/runs/${runId}/tool-outputs/${outputId}`),
  resolveApproval: (runId: string, approvalId: string, decision: 'approved' | 'rejected', scope: 'once' | 'rule' = 'once') =>
    request(`/runs/${runId}/approvals/${approvalId}`, { method: 'POST', body: JSON.stringify({ decision, scope }) }),
  async exportRun(runId: string) {
    const result = await request<{ filename: string; content: string }>(`/runs/${runId}/export`);
    const url = URL.createObjectURL(new Blob([result.content], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = result.filename;
    link.click();
    URL.revokeObjectURL(url);
  },
  saveProvider: (providerId: 'openai' | 'deepseek', apiKey: string) => request(`/providers/${providerId}`, { method: 'PATCH', body: JSON.stringify({ apiKey }) }),
  clearProvider: (providerId: 'openai' | 'deepseek') => request(`/providers/${providerId}`, { method: 'PATCH', body: JSON.stringify({ clear: true }) }),
  saveSettings: (settings: Partial<AppSettings>) => request('/settings', { method: 'PATCH', body: JSON.stringify(settings) }),
  createProject: (rootPath: string) => request('/projects', { method: 'POST', body: JSON.stringify({ rootPath }) }),
  createRun: (input: { projectId: string; title: string; question: string; modelMode: 'fixed' | 'auto'; providerId: ProviderId; model: string; allowedProviderIds: ProviderId[] }) =>
    request<Run>('/runs', { method: 'POST', body: JSON.stringify(input) }),
  initializeGit: (projectId: string) => request(`/projects/${projectId}/git/init`, { method: 'POST' })
};
