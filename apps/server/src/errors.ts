import { ZodError } from 'zod';

const statusByCode: Record<string, number> = {
  INVALID_REQUEST: 400,
  INVALID_PATH: 400,
  INVALID_BUDGET_RESERVATION: 400,
  SESSION_REQUIRED: 401,
  ORIGIN_DENIED: 403,
  PATH_ESCAPE: 403,
  SENSITIVE_PATH: 403,
  SENSITIVE_CONTENT: 403,
  IGNORED_PATH: 403,
  PROJECT_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  DOCUMENT_NOT_FOUND: 404,
  APPROVAL_NOT_FOUND: 404,
  BUDGET_RESERVATION_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  WORKTREE_ARTIFACT_NOT_FOUND: 404,
  TOOL_OUTPUT_NOT_FOUND: 404,
  DELIVERY_NOT_FOUND: 404,
  NOT_FOUND: 404,
  DOCS_NOT_FOUND: 409,
  DOCS_NOT_APPROVED: 409,
  DOC_VERSION_STALE: 409,
  IDEMPOTENCY_CONFLICT: 409,
  RUN_STATE_CONFLICT: 409,
  RESOURCE_CONFLICT: 409,
  WORKTREE_CONFLICT: 409,
  WORKTREE_DIRTY: 409,
  PROJECT_NOT_GIT: 409,
  APPROVAL_REQUIRED: 409,
  APPROVAL_NOT_REUSABLE: 409,
  APPROVAL_REJECTED: 409,
  RUN_BLOCKED_APPROVAL: 409,
  PLAN_GENERATION_STALE: 409,
  ACTION_ATTEMPT_STATE_CONFLICT: 409,
  ACTION_ATTEMPT_OWNERSHIP_CONFLICT: 409,
  ACTION_ATTEMPT_TOOL_CONFLICT: 409,
  ACTION_SEQUENCE_CONFLICT: 409,
  ACTION_WAITING_APPROVAL: 409,
  ACTION_OUTCOME_UNKNOWN: 409,
  WORKTREE_BASE_DRIFT: 409,
  WORKTREE_ARTIFACT_DRIFT: 409,
  WORKTREE_TARGET_DRIFT: 409,
  WORKTREE_DETACHED_HEAD: 409,
  WORKTREE_RECOVERY_REQUIRED: 409,
  WORKTREE_QUOTA_EXCEEDED: 409,
  WORKTREE_CLEANUP_FAILED: 409,
  WORKTREE_NOT_GIT: 409,
  INTEGRATION_EVIDENCE_MISSING: 409,
  INTEGRATION_EVIDENCE_MISMATCH: 409,
  INTEGRATION_VERIFY_UNAVAILABLE: 409,
  INTEGRATION_VERIFY_FAILED: 409,
  INTEGRATION_VERIFY_MUTATED: 409,
  AGENT_LIMIT_EXCEEDED: 409,
  TASK_VERIFICATION_REQUIRED: 409,
  APPROVAL_STALE: 409,
  APPROVAL_ALREADY_RESOLVED: 409,
  BUDGET_RESERVATION_OUTCOME_UNKNOWN: 409,
  BUDGET_RESERVATION_RELEASED: 409,
  BUDGET_RESERVATION_SETTLED: 409,
  BUDGET_RESERVATION_STATE_CONFLICT: 409,
  DELIVERY_TASK_RESULT_CONFLICT: 409,
  DELIVERY_TASK_RESULT_OWNERSHIP_CONFLICT: 409,
  TASK_GENERATION_CONFLICT: 409,
  TASK_RESULT_ID_CONFLICT: 409,
  TASK_RESULT_OWNERSHIP_CONFLICT: 409,
  TASK_RUN_CONFLICT: 409,
  TOOL_OUTPUT_CONFLICT: 409,
  WORKTREE_ARTIFACT_ID_CONFLICT: 409,
  WORKTREE_ARTIFACT_OWNERSHIP_CONFLICT: 409,
  PROVIDER_NOT_CONFIGURED: 412,
  BUDGET_EXCEEDED: 429,
  PROVIDER_RATE_LIMITED: 429,
  TOOL_SCOPE_VIOLATION: 403,
  TOOL_DENIED: 403,
  TASK_LEASE_CONFLICT: 409
};

export class LoopError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
    statusCode = statusByCode[code] ?? 500
  ) {
    super(message);
    this.name = 'LoopError';
    this.statusCode = statusCode;
  }
}

function sqliteConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: string };
  return candidate.code?.startsWith('SQLITE_CONSTRAINT') === true;
}

export function normalizeError(error: unknown): LoopError {
  if (error instanceof LoopError) return error;
  if (error instanceof ZodError) {
    return new LoopError('INVALID_REQUEST', '请求参数不符合接口约定。', error.flatten());
  }
  if (sqliteConflict(error)) return new LoopError('RESOURCE_CONFLICT', '资源已存在或违反唯一性约束。');
  const propertyCode = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof propertyCode === 'string' && statusByCode[propertyCode]) {
    return new LoopError(propertyCode, error instanceof Error ? error.message : propertyCode);
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const match = /^([A-Z][A-Z0-9_]+)(?::\s*|\s+)?(.*)$/s.exec(rawMessage);
  const code = match?.[1];
  if (code && statusByCode[code]) {
    return new LoopError(code, match[2]?.trim() || rawMessage);
  }
  return new LoopError('INTERNAL_ERROR', '服务器处理请求时发生内部错误。');
}
