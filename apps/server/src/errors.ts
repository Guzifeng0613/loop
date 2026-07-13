import { ZodError } from 'zod';

const statusByCode: Record<string, number> = {
  INVALID_REQUEST: 400,
  INVALID_PATH: 400,
  SESSION_REQUIRED: 401,
  ORIGIN_DENIED: 403,
  PATH_ESCAPE: 403,
  PROJECT_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  DOCUMENT_NOT_FOUND: 404,
  APPROVAL_NOT_FOUND: 404,
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
  PROVIDER_NOT_CONFIGURED: 412,
  BUDGET_EXCEEDED: 429,
  PROVIDER_RATE_LIMITED: 429,
  TOOL_SCOPE_VIOLATION: 403,
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
