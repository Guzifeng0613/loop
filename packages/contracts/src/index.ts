import { z } from 'zod';

export const RUN_STATES = [
  'intake',
  'clarifying',
  'doc_review',
  'ready',
  'decomposing',
  'executing',
  'integrating',
  'verifying',
  'awaiting_acceptance',
  'optimizing',
  'completed',
  'paused',
  'failed',
  'cancelled'
] as const;

export const runStateSchema = z.enum(RUN_STATES);
export type RunState = z.infer<typeof runStateSchema>;
export const providerIdSchema = z.enum(['openai', 'deepseek', 'local-demo']);
export type ProviderId = z.infer<typeof providerIdSchema>;
export const executionModeSchema = z.enum(['simple', 'multi_agent']);
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export type AgentStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'archived';
export type TaskStatus = 'blocked' | 'queued' | 'running' | 'verifying' | 'completed' | 'failed' | 'stale';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type ViewMode = 'workbench' | 'flow' | 'ide';

export const runBlockerSchema = z.object({
  kind: z.enum(['user_pause', 'approval', 'budget', 'documents', 'conflict', 'provider', 'restart']),
  code: z.string().min(1),
  message: z.string().min(1),
  since: z.string().min(1),
  recoverable: z.boolean(),
  approvalId: z.string().min(1).optional(),
  details: z.record(z.unknown()).optional()
}).strict();
export type RunBlocker = z.infer<typeof runBlockerSchema>;

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

export const understandingAnalysisSchema = z.object({
  summary: z.string().min(1),
  understood: z.array(z.string()),
  unclear: z.array(z.string()),
  assumptions: z.array(z.string()),
  questions: z.array(z.string()),
  ready: z.boolean(),
  source: z.enum(['model', 'local-demo'])
}).strict();

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
  executionMode: ExecutionMode;
  allowedProviderIds: ProviderId[];
  generation: number;
  baseRef: string;
  docsApproved: boolean;
  pauseReason?: string;
  blocker?: RunBlocker;
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
  /** False when an API response intentionally contains metadata only. */
  contentLoaded?: boolean;
  updatedAt: string;
}

export interface TaskSpec {
  id: string;
  runId: string;
  parentId?: string;
  title: string;
  description: string;
  status: TaskStatus;
  /** Defaults to the run's current generation for legacy callers. */
  generation?: number;
  depth: number;
  dependencies: string[];
  scope: string[];
  docRefs: DocReference[];
  acceptanceCriteria: string[];
  providerId?: ProviderId;
  model?: string;
  assignedAgentId?: string;
}

export const planGenerationSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  generation: z.number().int().positive(),
  status: z.enum(['draft', 'approved', 'superseded']),
  docRefs: z.array(z.object({
    docId: z.string().min(1),
    version: z.string().min(1),
    hash: z.string().min(1),
    sections: z.array(z.string())
  }).strict()),
  reason: z.string().optional(),
  createdAt: z.string().min(1),
  approvedAt: z.string().min(1).optional()
}).strict();
export type PlanGeneration = z.infer<typeof planGenerationSchema>;

export interface Agent {
  id: string;
  runId: string;
  generation: number;
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

export const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rootPath: z.string().min(1),
  isGit: z.boolean(),
  createdAt: z.string().min(1)
}).strict();

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  createdAt: z.string().min(1),
  attachments: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum(['image', 'file']),
    name: z.string().min(1),
    mimeType: z.string().min(1)
  }).strict()).optional(),
  analysis: understandingAnalysisSchema.optional()
}).strict();

export const runSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  question: z.string().min(1),
  state: runStateSchema,
  previousState: runStateSchema.optional(),
  modelMode: z.enum(['fixed', 'auto']),
  executionMode: executionModeSchema,
  providerId: providerIdSchema,
  model: z.string().min(1),
  allowedProviderIds: z.array(providerIdSchema),
  generation: z.number().int().positive(),
  baseRef: z.string().min(1),
  docsApproved: z.boolean(),
  pauseReason: z.string().optional(),
  blocker: runBlockerSchema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
}).strict();

export const loopDocumentSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  filename: z.string().min(1),
  title: z.string().min(1),
  version: z.string().min(1),
  status: z.enum(['draft', 'approved', 'stale']),
  hash: z.string().min(1),
  content: z.string(),
  contentLoaded: z.boolean().optional(),
  updatedAt: z.string().min(1)
}).strict();

export const taskSpecSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  parentId: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string(),
  status: z.enum(['blocked', 'queued', 'running', 'verifying', 'completed', 'failed', 'stale']),
  generation: z.number().int().positive(),
  depth: z.number().int().nonnegative(),
  dependencies: z.array(z.string()),
  scope: z.array(z.string()),
  docRefs: planGenerationSchema.shape.docRefs,
  acceptanceCriteria: z.array(z.string()).min(1),
  providerId: providerIdSchema.optional(),
  model: z.string().min(1).optional(),
  assignedAgentId: z.string().min(1).optional()
}).strict();

export const agentSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  generation: z.number().int().positive(),
  parentId: z.string().min(1).optional(),
  name: z.string().min(1),
  role: z.enum(['lead-main', 'module-main', 'subagent']),
  status: z.enum(['queued', 'running', 'waiting', 'completed', 'failed', 'archived']),
  depth: z.number().int().nonnegative(),
  providerId: providerIdSchema,
  model: z.string().min(1),
  taskId: z.string().min(1).optional(),
  contextUsage: z.number().nonnegative(),
  lineage: z.number().int().positive()
}).strict();

export interface Checkpoint {
  id: string;
  runId: string;
  generation: number;
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

export const checkpointSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  generation: z.number().int().positive(),
  agentId: z.string().min(1),
  lineage: z.number().int().positive(),
  docRefs: planGenerationSchema.shape.docRefs,
  taskIds: z.array(z.string()),
  eventWatermark: z.number().int().nonnegative(),
  decisions: z.array(z.string()),
  unresolved: z.array(z.string()),
  nextAction: z.string(),
  createdAt: z.string().min(1)
}).strict();

export const approvalScopeSchema = z.enum(['once', 'rule']);
export type ApprovalScope = z.infer<typeof approvalScopeSchema>;

export const paginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
}).strict();

export const createProjectRequestSchema = z.object({
  rootPath: z.string().min(1),
  name: z.string().min(1).optional()
}).strict();

export const createRunRequestSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  question: z.string().min(1),
  modelMode: z.enum(['fixed', 'auto']).default('fixed'),
  executionMode: executionModeSchema.default('simple'),
  providerId: providerIdSchema,
  model: z.string().min(1),
  allowedProviderIds: z.array(providerIdSchema).min(1).max(3).optional()
}).strict().superRefine((value, context) => {
  if (value.allowedProviderIds && !value.allowedProviderIds.includes(value.providerId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['allowedProviderIds'],
      message: 'allowedProviderIds 必须包含当前 providerId'
    });
  }
});

export const runActionRequestSchema = z.object({
  action: z.enum(['pause', 'resume', 'cancel', 'retry'])
}).strict();

export const runRecoveryDecisionSchema = z.enum(['confirm_completed', 'fail_and_retry', 'abandon_generation', 'resume']);
export type RunRecoveryDecision = z.infer<typeof runRecoveryDecisionSchema>;
export const recoveryRiskSchema = z.enum(['low', 'medium', 'high']);
export type RecoveryRisk = z.infer<typeof recoveryRiskSchema>;
export const recoveryCheckSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(['passed', 'warning', 'unknown']),
  detail: z.string().min(1)
}).strict();
export type RecoveryCheck = z.infer<typeof recoveryCheckSchema>;
export const recoveryEvidenceSchema = z.object({
  knownFacts: z.array(z.string()),
  unknownFacts: z.array(z.string()),
  checks: z.array(recoveryCheckSchema),
  affectedResources: z.array(z.string()),
  actionSummaries: z.array(z.string()),
  currentHead: z.string().min(1).optional()
}).strict();
export type RecoveryEvidence = z.infer<typeof recoveryEvidenceSchema>;
export const recoveryActionSchema = z.object({
  decision: runRecoveryDecisionSchema,
  label: z.string().min(1),
  available: z.boolean(),
  disabledReason: z.string().min(1).optional(),
  risk: recoveryRiskSchema
}).strict();
export type RecoveryAction = z.infer<typeof recoveryActionSchema>;
export const recoveryDecisionRecordSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  generation: z.number().int().positive(),
  decision: runRecoveryDecisionSchema,
  actor: z.literal('local-user'),
  note: z.string(),
  fromState: runStateSchema,
  toState: runStateSchema,
  blockerCode: z.string().min(1),
  evidence: recoveryEvidenceSchema,
  result: z.enum(['applied', 'rejected']),
  createdAt: z.string().min(1)
}).strict();
export type RecoveryDecisionRecord = z.infer<typeof recoveryDecisionRecordSchema>;
export const runRecoveryRequestSchema = z.object({
  decision: runRecoveryDecisionSchema,
  note: z.string().max(20_000).optional()
}).strict();

export const createMessageRequestSchema = z.object({ content: z.string().min(1).max(100_000) }).strict();
export const saveDocumentRequestSchema = z.object({
  docId: z.string().min(1).optional(),
  expectedHash: z.string().min(1),
  content: z.string().min(1).max(1_500_000)
}).strict();

export const resolveApprovalRequestSchema = z.object({
  approvalId: z.string().min(1).optional(),
  decision: z.enum(['approved', 'rejected']),
  scope: approvalScopeSchema.default('once')
}).strict();

export const acceptanceDecisionSchema = z.enum(['accept_keep_branch', 'accept_merge', 'request_changes', 'discard']);
export type AcceptanceDecision = z.infer<typeof acceptanceDecisionSchema>;
export const acceptanceRequestSchema = z.object({
  decision: acceptanceDecisionSchema,
  feedback: z.string().max(100_000).optional()
}).strict();

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().min(1)
  }).strict()
}).strict();

export const approvalRequestSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  generation: z.number().int().positive().optional(),
  taskId: z.string().min(1).optional(),
  tool: z.string().min(1),
  ruleKey: z.string().min(1),
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  reusable: z.boolean(),
  capability: z.string().min(1),
  resource: z.string().min(1),
  scope: approvalScopeSchema,
  summary: z.string(),
  policyReason: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
  createdAt: z.string().min(1),
  resolvedAt: z.string().min(1).optional(),
  consumedAt: z.string().min(1).optional(),
  actionAttemptId: z.string().min(1).optional()
}).strict();
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const structuredCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('git_status') }).strict(),
  z.object({
    kind: z.literal('git_diff'),
    staged: z.boolean().optional(),
    path: z.string().min(1).optional()
  }).strict(),
  z.object({
    kind: z.literal('npm_script'),
    script: z.enum(['test', 'typecheck', 'lint', 'build']),
    args: z.array(z.string()).max(32).optional()
  }).strict(),
  z.object({
    kind: z.literal('search'),
    query: z.string().min(1),
    path: z.string().min(1).optional(),
    maxResults: z.number().int().min(1).max(500).optional()
  }).strict()
]);
export type StructuredCommand = z.infer<typeof structuredCommandSchema>;

export const delegatedTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  scope: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()).min(1),
  providerId: providerIdSchema.optional(),
  model: z.string().min(1).optional()
}).strict();
export type DelegatedTask = z.infer<typeof delegatedTaskSchema>;

const callToolActionSchemas = [
  z.object({
    type: z.literal('call_tool'),
    tool: z.literal('list_files'),
    arguments: z.object({ path: z.string().optional() }).strict()
  }).strict(),
  z.object({
    type: z.literal('call_tool'),
    tool: z.literal('read_file'),
    arguments: z.object({ path: z.string().min(1), maxChars: z.number().int().min(1).max(160_000).optional() }).strict()
  }).strict(),
  z.object({
    type: z.literal('call_tool'),
    tool: z.literal('search_text'),
    arguments: z.object({
      query: z.string().min(1),
      path: z.string().min(1).optional(),
      maxResults: z.number().int().min(1).max(500).optional()
    }).strict()
  }).strict(),
  z.object({
    type: z.literal('call_tool'),
    tool: z.literal('write_file'),
    arguments: z.object({ path: z.string().min(1), content: z.string() }).strict()
  }).strict(),
  z.object({
    type: z.literal('call_tool'),
    tool: z.literal('run_command'),
    arguments: z.object({ command: structuredCommandSchema }).strict()
  }).strict(),
  z.object({
    type: z.literal('call_tool'),
    tool: z.literal('git_status'),
    arguments: z.object({}).strict()
  }).strict()
] as const;

/** Exact JSON wire accepted from a model. Idempotency is deliberately server-owned. */
export const agentActionSchema = z.union([
  ...callToolActionSchemas,
  z.object({ type: z.literal('ask_user'), analysis: understandingAnalysisSchema }).strict(),
  z.object({ type: z.literal('revise_docs'), documentIds: z.array(z.string().min(1)), rationale: z.string().min(1) }).strict(),
  z.object({ type: z.literal('delegate'), tasks: z.array(delegatedTaskSchema).min(1).max(30) }).strict(),
  z.object({
    type: z.literal('complete'),
    summary: z.string().min(1),
    evidence: z.array(z.string()).default([]),
    verificationCommands: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
    unresolved: z.array(z.string()).default([])
  }).strict(),
  z.object({ type: z.literal('pause'), reason: z.string().min(1) }).strict(),
  z.object({ type: z.literal('handoff'), checkpoint: checkpointSchema }).strict()
]);
export type AgentAction = z.infer<typeof agentActionSchema>;

export const actionAttemptSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  generation: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  action: agentActionSchema,
  status: z.enum(['pending', 'waiting_approval', 'executing', 'completed', 'failed', 'cancelled']),
  idempotencyKey: z.string().min(1),
  approvalId: z.string().min(1).optional(),
  toolOutputId: z.string().min(1).optional(),
  error: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  startedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional()
}).strict().superRefine((value, context) => {
  if (value.status === 'waiting_approval' && !value.approvalId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['approvalId'], message: '等待审批的动作必须关联 approvalId' });
  }
  if (value.status === 'executing' && !value.startedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['startedAt'], message: '执行中的动作必须记录 startedAt' });
  }
  if (['completed', 'failed', 'cancelled'].includes(value.status) && !value.completedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['completedAt'], message: '终态动作必须记录 completedAt' });
  }
  if (value.status === 'failed' && !value.error) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['error'], message: '失败动作必须记录 error' });
  }
  if (value.status === 'completed' && value.action.type === 'call_tool' && !value.toolOutputId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['toolOutputId'], message: '已完成工具动作必须关联 toolOutputId' });
  }
});
export type ActionAttempt = z.infer<typeof actionAttemptSchema>;

export const operationKindSchema = z.enum([
  'api_mutation',
  'model_call',
  'tool_effect',
  'task_finalize',
  'integration',
  'acceptance'
]);
export type OperationKind = z.infer<typeof operationKindSchema>;
export const operationStatusSchema = z.enum([
  'prepared',
  'waiting_approval',
  'dispatched',
  'effect_observed',
  'committed',
  'unknown',
  'failed',
  'cancelled'
]);
export type OperationStatus = z.infer<typeof operationStatusSchema>;
export const operationRecoveryActionSchema = z.enum(['reconcile', 'retry', 'abandon']);
export type OperationRecoveryAction = z.infer<typeof operationRecoveryActionSchema>;

export const operationAttemptSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  generation: z.number().int().positive(),
  kind: operationKindSchema,
  status: operationStatusSchema,
  idempotencyKey: z.string().min(1),
  inputHash: z.string().min(1),
  taskId: z.string().min(1).optional(),
  actionAttemptId: z.string().min(1).optional(),
  approvalId: z.string().min(1).optional(),
  providerId: providerIdSchema.optional(),
  model: z.string().min(1).optional(),
  resultRef: z.string().min(1).optional(),
  effectFingerprint: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
  recoveryActions: z.array(operationRecoveryActionSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  dispatchedAt: z.string().min(1).optional(),
  observedAt: z.string().min(1).optional(),
  committedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional()
}).strict().superRefine((value, context) => {
  if (value.status === 'waiting_approval' && !value.approvalId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['approvalId'], message: '等待审批的 operation 必须关联 approvalId' });
  }
  if (['dispatched', 'effect_observed', 'committed'].includes(value.status) && !value.dispatchedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['dispatchedAt'], message: '已派发 operation 必须记录 dispatchedAt' });
  }
  if (['effect_observed', 'committed'].includes(value.status) && !value.observedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['observedAt'], message: '已观察效果的 operation 必须记录 observedAt' });
  }
  if (value.status === 'committed' && !value.committedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['committedAt'], message: '已提交 operation 必须记录 committedAt' });
  }
});
export type OperationAttempt = z.infer<typeof operationAttemptSchema>;

export interface OperationReceipt<T = unknown> {
  operationId: string;
  status: OperationStatus;
  result?: T;
}

export function operationReceiptSchema<T extends z.ZodTypeAny>(resultSchema: T) {
  return z.object({
    operationId: z.string().min(1),
    status: operationStatusSchema,
    result: resultSchema.optional()
  }).strict();
}

export const operationRecoveryRequestSchema = z.object({
  action: operationRecoveryActionSchema
}).strict();

export interface RunEvent<T = unknown> {
  id: number;
  runId: string;
  type:
    | 'message.delta'
    | 'message.completed'
    | 'run.state'
    | 'agent.state'
    | 'task.state'
    | 'task.result'
    | 'artifact.updated'
    | 'delivery.updated'
    | 'tool.output'
    | 'approval.requested'
    | 'approval.resolved'
    | 'budget.updated'
    | 'recovery.decided'
    | 'doc.invalidated'
    | 'error';
  payload: T;
  schemaVersion: 1;
  entityRevision: number;
  snapshotVersion: number;
  createdAt: string;
}

export const runEventSchema = z.object({
  id: z.number().int().nonnegative(),
  runId: z.string().min(1),
  type: z.enum(['message.delta', 'message.completed', 'run.state', 'agent.state', 'task.state', 'task.result', 'artifact.updated', 'delivery.updated', 'tool.output', 'approval.requested', 'approval.resolved', 'budget.updated', 'recovery.decided', 'doc.invalidated', 'error']),
  payload: z.unknown(),
  schemaVersion: z.literal(1),
  entityRevision: z.number().int().nonnegative(),
  snapshotVersion: z.number().int().nonnegative(),
  createdAt: z.string().min(1)
}).strict();

export interface BudgetSettings {
  maxCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxMinutes: number;
  maxEstimatedCost?: number;
}

export interface RunUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost?: number;
  elapsedMinutes: number;
  activeSeconds?: number;
}

export const runUsageSchema = z.object({
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCost: z.number().nonnegative().optional(),
  elapsedMinutes: z.number().nonnegative(),
  activeSeconds: z.number().int().nonnegative().optional()
}).strict();

export const budgetReservationSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  providerId: providerIdSchema,
  model: z.string().min(1).optional(),
  status: z.enum(['queued', 'dispatched', 'unknown', 'settled', 'released', 'reserved']),
  reservedCalls: z.number().int().nonnegative(),
  reservedInputTokens: z.number().int().nonnegative(),
  reservedOutputTokens: z.number().int().nonnegative(),
  reservedCost: z.number().nonnegative(),
  actualCalls: z.number().int().nonnegative().optional(),
  actualInputTokens: z.number().int().nonnegative().optional(),
  actualOutputTokens: z.number().int().nonnegative().optional(),
  actualCost: z.number().nonnegative().optional(),
  createdAt: z.string().min(1),
  unknownAt: z.string().min(1).optional(),
  settledAt: z.string().min(1).optional()
}).strict().superRefine((value, context) => {
  const actualFields = [value.actualCalls, value.actualInputTokens, value.actualOutputTokens, value.actualCost];
  if (value.status === 'settled' && (actualFields.some((field) => field === undefined) || !value.settledAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '已结算预算必须记录全部实际用量与 settledAt' });
  }
  if (value.status === 'released' && !value.settledAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['settledAt'], message: '已释放预算必须记录 settledAt' });
  }
  if (value.status === 'unknown' && (!value.unknownAt || actualFields.some((field) => field !== undefined) || value.settledAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '结果未知的预算必须记录 unknownAt，且尚不能包含结算字段' });
  }
  if (['queued', 'dispatched', 'reserved'].includes(value.status) && (actualFields.some((field) => field !== undefined) || value.unknownAt || value.settledAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '预留中的预算不能包含结算字段' });
  }
});
export type BudgetReservation = z.infer<typeof budgetReservationSchema>;

export const taskResultSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  generation: z.number().int().positive(),
  summary: z.string(),
  evidence: z.array(z.string()),
  verificationCommands: z.array(z.string()),
  verified: z.boolean(),
  commitSha: z.string().min(1).optional(),
  risks: z.array(z.string()),
  unresolved: z.array(z.string()),
  createdAt: z.string().min(1),
  verifiedAt: z.string().min(1).optional()
}).strict().superRefine((value, context) => {
  if (value.verified && !value.commitSha) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['commitSha'], message: '已验证任务结果必须关联 commitSha' });
  }
  if (value.verified && !value.verifiedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['verifiedAt'], message: '已验证任务结果必须记录 verifiedAt' });
  }
  if (!value.verified && value.verifiedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['verifiedAt'], message: '未验证任务结果不能记录 verifiedAt' });
  }
});
export type TaskResult = z.infer<typeof taskResultSchema>;

export const toolOutputSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  actionAttemptId: z.string().min(1).optional(),
  generation: z.number().int().positive(),
  tool: z.string().min(1),
  content: z.string(),
  truncated: z.boolean(),
  byteLength: z.number().int().nonnegative(),
  createdAt: z.string().min(1)
}).strict();
export type ToolOutput = z.infer<typeof toolOutputSchema>;

export const worktreeArtifactSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  generation: z.number().int().positive(),
  kind: z.enum(['task', 'integration']),
  path: z.string().min(1),
  branch: z.string().min(1),
  baseRef: z.string().min(1),
  commitSha: z.string().min(1).optional(),
  status: z.enum(['active', 'completed', 'discarded', 'orphaned']),
  sizeBytes: z.number().int().nonnegative(),
  retainedUntil: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
}).strict().superRefine((value, context) => {
  if (value.kind === 'task' && !value.taskId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['taskId'], message: '任务 worktree 必须关联 taskId' });
  }
  if (value.kind === 'integration' && value.taskId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['taskId'], message: '集成 worktree 不能关联 taskId' });
  }
  if (value.status === 'completed' && !value.commitSha) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['commitSha'], message: '已完成 worktree 必须关联 commitSha' });
  }
});
export type WorktreeArtifact = z.infer<typeof worktreeArtifactSchema>;

export const runRecoverySummarySchema = z.object({
  run: runSchema,
  blocker: runBlockerSchema.optional(),
  recoverable: z.boolean(),
  actionAttempts: z.array(actionAttemptSchema),
  unknownBudgetReservations: z.array(budgetReservationSchema),
  worktreeArtifacts: z.array(worktreeArtifactSchema),
  recentEvents: z.array(runEventSchema),
  evidence: recoveryEvidenceSchema,
  recoveryActions: z.array(recoveryActionSchema),
  decisionHistory: z.array(recoveryDecisionRecordSchema),
  createdAt: z.string().min(1)
}).strict();
export type RunRecoverySummary = z.infer<typeof runRecoverySummarySchema>;

export const deliverySummarySchema = z.object({
  runId: z.string().min(1),
  generation: z.number().int().positive(),
  baseRef: z.string().min(1),
  integrationBranch: z.string().min(1).optional(),
  filesChanged: z.array(z.string()),
  commits: z.array(z.string()),
  verificationCommands: z.array(z.string()),
  taskResults: z.array(taskResultSchema),
  risks: z.array(z.string()),
  unresolved: z.array(z.string()),
  actualCost: z.number().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
}).strict().superRefine((value, context) => {
  value.taskResults.forEach((result, index) => {
    if (result.runId !== value.runId || result.generation !== value.generation || !result.verified) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['taskResults', index],
        message: '交付中的任务结果必须属于同一运行与 generation，且已经验证'
      });
    }
  });
});
export type DeliverySummary = z.infer<typeof deliverySummarySchema>;

export const fileChangeSchema = z.object({
  path: z.string().min(1),
  oldPath: z.string().min(1).optional(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'binary']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
  diffOutputId: z.string().min(1).optional()
}).strict();
export type FileChange = z.infer<typeof fileChangeSchema>;

export const verificationResultSchema = z.object({
  command: z.string().min(1),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  outputId: z.string().min(1).optional(),
  startedAt: z.string().min(1),
  completedAt: z.string().min(1)
}).strict();
export type VerificationResult = z.infer<typeof verificationResultSchema>;

export const deliveryManifestSchema = z.object({
  runId: z.string().min(1),
  generation: z.number().int().positive(),
  revision: z.string().min(1),
  baseRef: z.string().min(1),
  integrationBranch: z.string().min(1),
  integrationCommit: z.string().min(1),
  treeSha: z.string().min(1),
  diffHash: z.string().min(1),
  files: z.array(fileChangeSchema),
  verificationResults: z.array(verificationResultSchema),
  taskResults: z.array(taskResultSchema),
  risks: z.array(z.string()),
  unresolved: z.array(z.string()),
  actualCost: z.number().nonnegative(),
  priceSnapshot: z.record(z.number().nonnegative()),
  createdAt: z.string().min(1),
  sealedAt: z.string().min(1)
}).strict();
export type DeliveryManifest = z.infer<typeof deliveryManifestSchema>;

export const acceptanceRecordSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  generation: z.number().int().positive(),
  deliveryRevision: z.string().min(1),
  decision: acceptanceDecisionSchema,
  status: z.enum(['pending', 'completed', 'failed']),
  feedback: z.string().optional(),
  targetBranch: z.string().min(1).optional(),
  mergeCommit: z.string().min(1).optional(),
  failureCode: z.string().min(1).optional(),
  acceptedAdditions: z.number().int().nonnegative(),
  acceptedDeletions: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  completedAt: z.string().min(1).optional()
}).strict();
export type AcceptanceRecord = z.infer<typeof acceptanceRecordSchema>;

export const settingSourceSchema = z.enum(['default', 'user', 'project', 'run']);
export type SettingSource = z.infer<typeof settingSourceSchema>;
export interface ResolvedSetting<T> { value: T; source: SettingSource }
export function resolvedSettingSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.object({ value: valueSchema, source: settingSourceSchema }).strict();
}

export const runConfigSnapshotSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  generation: z.number().int().positive(),
  executionMode: executionModeSchema,
  providerId: providerIdSchema,
  model: z.string().min(1),
  concurrency: resolvedSettingSchema(z.number().int().min(1).max(16)),
  budget: z.object({
    maxCalls: resolvedSettingSchema(z.number().int().positive()),
    maxInputTokens: resolvedSettingSchema(z.number().int().positive()),
    maxOutputTokens: resolvedSettingSchema(z.number().int().positive()),
    maxMinutes: resolvedSettingSchema(z.number().int().positive()),
    maxEstimatedCost: resolvedSettingSchema(z.number().nonnegative()).optional()
  }).strict(),
  policyVersion: z.string().min(1),
  toolVersion: z.string().min(1),
  priceVersion: z.string().min(1),
  createdAt: z.string().min(1)
}).strict();
export type RunConfigSnapshot = z.infer<typeof runConfigSnapshotSchema>;

const runEventV2Base = {
  id: z.number().int().nonnegative(),
  runId: z.string().min(1),
  schemaVersion: z.literal(2),
  entityRevision: z.number().int().nonnegative(),
  snapshotVersion: z.number().int().nonnegative(),
  createdAt: z.string().min(1)
} as const;

export const toolOutputReferenceSchema = toolOutputSchema.omit({ content: true }).extend({
  preview: z.string()
}).strict();

export const runEventV2Schema = z.discriminatedUnion('type', [
  z.object({ ...runEventV2Base, type: z.literal('message.completed'), payload: z.object({ message: chatMessageSchema }).strict() }).strict(),
  z.object({ ...runEventV2Base, type: z.literal('run.state'), payload: z.object({ run: runSchema }).strict() }).strict(),
  z.object({ ...runEventV2Base, type: z.literal('task.state'), payload: z.object({ task: taskSpecSchema }).strict() }).strict(),
  z.object({ ...runEventV2Base, type: z.literal('agent.state'), payload: z.object({ agent: agentSchema }).strict() }).strict(),
  z.object({ ...runEventV2Base, type: z.literal('task.result'), payload: z.object({ result: taskResultSchema }).strict() }).strict(),
  z.object({ ...runEventV2Base, type: z.literal('artifact.updated'), payload: z.object({ artifact: worktreeArtifactSchema }).strict() }).strict(),
  z.object({ ...runEventV2Base, type: z.literal('delivery.updated'), payload: z.object({ manifest: deliveryManifestSchema }).strict() }).strict(),
  z.object({ ...runEventV2Base, type: z.literal('tool.output'), payload: z.object({ output: toolOutputReferenceSchema }).strict() }).strict(),
  z.object({ ...runEventV2Base, type: z.literal('approval.requested'), payload: z.object({ approval: approvalRequestSchema }).strict() }).strict(),
  z.object({ ...runEventV2Base, type: z.literal('approval.resolved'), payload: z.object({ approval: approvalRequestSchema }).strict() }).strict(),
  z.object({ ...runEventV2Base, type: z.literal('budget.updated'), payload: z.object({ usage: runUsageSchema, reservation: budgetReservationSchema.optional() }).strict() }).strict(),
  z.object({ ...runEventV2Base, type: z.literal('operation.updated'), payload: z.object({ operation: operationAttemptSchema }).strict() }).strict(),
  z.object({ ...runEventV2Base, type: z.literal('acceptance.updated'), payload: z.object({ acceptance: acceptanceRecordSchema }).strict() }).strict(),
  z.object({ ...runEventV2Base, type: z.literal('recovery.decided'), payload: z.object({ recovery: recoveryDecisionRecordSchema }).strict() }).strict(),
  z.object({ ...runEventV2Base, type: z.literal('doc.invalidated'), payload: z.object({ generation: z.number().int().positive(), documentId: z.string().min(1).optional(), reason: z.string().min(1) }).strict() }).strict(),
  z.object({ ...runEventV2Base, type: z.literal('error'), payload: z.object({ code: z.string().min(1), message: z.string(), details: z.record(z.unknown()).optional() }).strict() }).strict()
]);
export type RunEventV2 = z.infer<typeof runEventV2Schema>;
export const anyRunEventSchema = z.union([runEventSchema, runEventV2Schema]);
export type AnyRunEvent = z.infer<typeof anyRunEventSchema>;

export interface Page<T> {
  items: T[];
  nextCursor?: string;
  asOf?: string;
  total?: number;
}

export function pageSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().optional(),
    asOf: z.string().min(1).optional(),
    total: z.number().int().nonnegative().optional()
  }).strict();
}

export const pageInfoSchema = z.object({
  nextCursor: z.string().optional(),
  total: z.number().int().nonnegative(),
  asOf: z.string().min(1)
}).strict();
export type PageInfo = z.infer<typeof pageInfoSchema>;

export interface SnapshotEnvelope<T> {
  schemaVersion: 2;
  snapshotVersion: number;
  eventWatermark: number;
  data: T;
}

export function snapshotEnvelopeSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    schemaVersion: z.literal(2),
    snapshotVersion: z.number().int().nonnegative(),
    eventWatermark: z.number().int().nonnegative(),
    data: dataSchema
  }).strict();
}

export interface AppSettings {
  concurrency: number;
  maxDepth: number;
  maxAgents: number;
  mainDirectLimit: number;
  autoMode: boolean;
  budget: BudgetSettings;
}

export const budgetSettingsSchema = z.object({
  maxCalls: z.number().int().positive(),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxMinutes: z.number().int().positive(),
  maxEstimatedCost: z.number().nonnegative().optional()
}).strict();

export const appSettingsSchema = z.object({
  concurrency: z.number().int().min(1).max(16),
  maxDepth: z.number().int().min(1).max(4),
  maxAgents: z.number().int().min(1).max(200),
  mainDirectLimit: z.number().int().min(1).max(30),
  autoMode: z.boolean(),
  budget: budgetSettingsSchema
}).strict();

export const settingsPatchSchema = z.object({
  concurrency: z.number().int().min(1).max(16).optional(),
  maxDepth: z.number().int().min(1).max(4).optional(),
  maxAgents: z.number().int().min(1).max(200).optional(),
  mainDirectLimit: z.number().int().min(1).max(30).optional(),
  autoMode: z.boolean().optional(),
  budget: z.object({
    maxCalls: z.number().int().min(1).optional(),
    maxInputTokens: z.number().int().min(1).optional(),
    maxOutputTokens: z.number().int().min(1).optional(),
    maxMinutes: z.number().int().min(1).optional(),
    maxEstimatedCost: z.number().nonnegative().optional()
  }).strict().optional()
}).strict();

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

export const providerConfigSchema = z.object({
  id: providerIdSchema,
  label: z.string().min(1),
  configured: z.boolean(),
  enabled: z.boolean(),
  defaultModel: z.string().min(1),
  availableModels: z.array(z.string()),
  supportsTools: z.boolean(),
  supportsReasoning: z.boolean()
}).strict();

export const diagnosticsSchema = z.object({
  schemaVersion: z.literal(2),
  database: z.object({ schemaVersion: z.number().int().positive(), integrity: z.enum(['ok', 'error']), walBytes: z.number().int().nonnegative() }).strict(),
  operations: z.object({ pending: z.number().int().nonnegative(), unknown: z.number().int().nonnegative() }).strict(),
  budgets: z.object({ queued: z.number().int().nonnegative(), dispatched: z.number().int().nonnegative(), unknown: z.number().int().nonnegative() }).strict(),
  worktrees: z.object({ usedBytes: z.number().int().nonnegative(), quotaBytes: z.number().int().nonnegative(), orphaned: z.number().int().nonnegative() }).strict(),
  providers: z.array(z.object({ id: providerIdSchema, configured: z.boolean(), ready: z.boolean().optional(), error: z.string().optional() }).strict()),
  eventWatermark: z.number().int().nonnegative(),
  createdAt: z.string().min(1)
}).strict();
export type Diagnostics = z.infer<typeof diagnosticsSchema>;

export interface BootstrapPayload {
  schemaVersion: 2;
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
  events: Array<RunEvent | RunEventV2>;
  operations?: OperationAttempt[];
  acceptances?: AcceptanceRecord[];
  deliveryManifests?: DeliveryManifest[];
  pages?: Partial<Record<'projects' | 'runs' | 'messages' | 'tasks' | 'agents' | 'approvals' | 'events', PageInfo>>;
  usage: RunUsage;
  snapshotVersion?: number;
  eventWatermark?: number;
  providers: ProviderConfig[];
  settings: AppSettings;
}

export interface ProviderTurnInput {
  model: string;
  systemPrompt: string;
  messages: Pick<ChatMessage, 'role' | 'content'>[];
  jsonMode?: boolean;
  idempotencyKey?: string;
}

export interface ProviderTurnResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  providerRequestId?: string;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  testConnection(): Promise<boolean>;
  listModels(): Promise<string[]>;
  completeTurn(input: ProviderTurnInput, signal?: AbortSignal): Promise<ProviderTurnResult>;
}
