export const RUN_STATES = [
  'intake',
  'clarifying',
  'doc_review',
  'ready',
  'decomposing',
  'executing',
  'integrating',
  'verifying',
  'optimizing',
  'completed',
  'paused',
  'failed',
  'cancelled'
] as const;

export type RunState = (typeof RUN_STATES)[number];
export type ProviderId = 'openai' | 'deepseek' | 'local-demo';
export type AgentStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'archived';
export type TaskStatus = 'blocked' | 'queued' | 'running' | 'verifying' | 'completed' | 'failed' | 'stale';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type ViewMode = 'workbench' | 'flow' | 'ide';

export interface AttachmentRef {
  id: string;
  kind: 'image' | 'file';
  name: string;
  mimeType: string;
}

export interface ChatMessage {
  id: string;
  runId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: string;
  attachments?: AttachmentRef[];
  analysis?: UnderstandingAnalysis;
}

export interface UnderstandingAnalysis {
  summary: string;
  understood: string[];
  unclear: string[];
  assumptions: string[];
  questions: string[];
  ready: boolean;
  source: 'model' | 'local-demo';
}

export interface DocReference {
  docId: string;
  version: string;
  hash: string;
  sections: string[];
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  isGit: boolean;
  createdAt: string;
}

export interface Run {
  id: string;
  projectId: string;
  title: string;
  question: string;
  state: RunState;
  previousState?: RunState;
  modelMode: 'fixed' | 'auto';
  providerId: ProviderId;
  model: string;
  docsApproved: boolean;
  pauseReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoopDocument {
  id: string;
  projectId: string;
  filename: string;
  title: string;
  version: string;
  status: 'draft' | 'approved' | 'stale';
  hash: string;
  content: string;
  updatedAt: string;
}

export interface TaskSpec {
  id: string;
  runId: string;
  parentId?: string;
  title: string;
  description: string;
  status: TaskStatus;
  depth: number;
  dependencies: string[];
  scope: string[];
  docRefs: DocReference[];
  acceptanceCriteria: string[];
  providerId?: ProviderId;
  model?: string;
  assignedAgentId?: string;
}

export interface Agent {
  id: string;
  runId: string;
  parentId?: string;
  name: string;
  role: 'lead-main' | 'module-main' | 'subagent';
  status: AgentStatus;
  depth: number;
  providerId: ProviderId;
  model: string;
  taskId?: string;
  contextUsage: number;
  lineage: number;
}

export interface Checkpoint {
  id: string;
  runId: string;
  agentId: string;
  lineage: number;
  docRefs: DocReference[];
  taskIds: string[];
  eventWatermark: number;
  decisions: string[];
  unresolved: string[];
  nextAction: string;
  createdAt: string;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  taskId?: string;
  tool: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  policyReason: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
}

export type AgentAction =
  | { type: 'ask_user'; analysis: UnderstandingAnalysis }
  | { type: 'revise_docs'; documentIds: string[]; rationale: string }
  | { type: 'delegate'; tasks: TaskSpec[] }
  | { type: 'call_tool'; tool: string; arguments: Record<string, unknown>; idempotencyKey: string }
  | { type: 'complete'; summary: string; evidence: string[] }
  | { type: 'pause'; reason: string }
  | { type: 'handoff'; checkpoint: Checkpoint };

export interface RunEvent<T = unknown> {
  id: number;
  runId: string;
  type:
    | 'message.delta'
    | 'message.completed'
    | 'run.state'
    | 'agent.state'
    | 'task.state'
    | 'tool.output'
    | 'approval.requested'
    | 'budget.updated'
    | 'doc.invalidated'
    | 'error';
  payload: T;
  createdAt: string;
}

export interface BudgetSettings {
  maxCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxMinutes: number;
  maxEstimatedCost?: number;
}

export interface AppSettings {
  concurrency: number;
  maxDepth: number;
  maxAgents: number;
  mainDirectLimit: number;
  autoMode: boolean;
  budget: BudgetSettings;
}

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  configured: boolean;
  enabled: boolean;
  defaultModel: string;
  availableModels: string[];
  supportsTools: boolean;
  supportsReasoning: boolean;
}

export interface BootstrapPayload {
  sessionToken: string;
  projects: Project[];
  runs: Run[];
  currentProject?: Project;
  currentRun?: Run;
  messages: ChatMessage[];
  documents: LoopDocument[];
  tasks: TaskSpec[];
  agents: Agent[];
  approvals: ApprovalRequest[];
  providers: ProviderConfig[];
  settings: AppSettings;
}

export interface ProviderTurnInput {
  model: string;
  systemPrompt: string;
  messages: Pick<ChatMessage, 'role' | 'content'>[];
  jsonMode?: boolean;
}

export interface ProviderTurnResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  testConnection(): Promise<boolean>;
  listModels(): Promise<string[]>;
  completeTurn(input: ProviderTurnInput, signal?: AbortSignal): Promise<ProviderTurnResult>;
}
