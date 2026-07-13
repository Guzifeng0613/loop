import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  Agent,
  AppSettings,
  ApprovalRequest,
  ChatMessage,
  Checkpoint,
  LoopDocument,
  Project,
  Run,
  RunEvent,
  TaskSpec
} from '@loop/contracts';

type SqlValue = string | number | null;
type RunPatch = Partial<Pick<Run, 'state' | 'previousState' | 'docsApproved' | 'providerId' | 'model' | 'modelMode'>> & {
  pauseReason?: string | null;
};

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function optional<T extends object, K extends string, V>(key: K, value: V | null | undefined): T & Partial<Record<K, V>> {
  return (value == null ? {} : { [key]: value }) as T & Partial<Record<K, V>>;
}

export class LoopStore {
  readonly db: Database.Database;
  readonly events = new EventEmitter();

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
    `);
    const schemaRow = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    const schemaVersion = Number(schemaRow?.value ?? 1);
    if (schemaVersion > 4) throw new Error(`SCHEMA_VERSION_UNSUPPORTED: 数据库版本 ${schemaVersion} 高于当前服务支持的版本 4`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
        is_git INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, question TEXT NOT NULL,
        state TEXT NOT NULL, previous_state TEXT, model_mode TEXT NOT NULL, provider_id TEXT NOT NULL,
        model TEXT NOT NULL, docs_approved INTEGER NOT NULL DEFAULT 0, pause_reason TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        analysis_json TEXT, attachments_json TEXT, created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT NOT NULL, project_id TEXT NOT NULL, filename TEXT NOT NULL, title TEXT NOT NULL,
        version TEXT NOT NULL, status TEXT NOT NULL, hash TEXT NOT NULL, approved_hash TEXT,
        content TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(id, project_id), FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL,
        description TEXT NOT NULL, status TEXT NOT NULL, depth INTEGER NOT NULL,
        dependencies_json TEXT NOT NULL, scope_json TEXT NOT NULL, doc_refs_json TEXT NOT NULL,
        acceptance_json TEXT NOT NULL, provider_id TEXT, model TEXT, assigned_agent_id TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, role TEXT NOT NULL,
        status TEXT NOT NULL, depth INTEGER NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL,
        task_id TEXT, context_usage REAL NOT NULL DEFAULT 0, lineage INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, tool TEXT NOT NULL, risk TEXT NOT NULL,
        summary TEXT NOT NULL, policy_reason TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, resolved_at TEXT, consumed_at TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, type TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (
        run_id TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT NOT NULL, lineage INTEGER NOT NULL,
        doc_refs_json TEXT NOT NULL, task_ids_json TEXT NOT NULL, event_watermark INTEGER NOT NULL,
        decisions_json TEXT NOT NULL, unresolved_json TEXT NOT NULL, next_action TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id), FOREIGN KEY(agent_id) REFERENCES agents(id)
      );
      CREATE TABLE IF NOT EXISTS task_leases (
        task_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, expires_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id), FOREIGN KEY(agent_id) REFERENCES agents(id)
      );
    `);
    const approvalColumns = this.db.prepare("PRAGMA table_info('approvals')").all() as { name?: string }[];
    if (!approvalColumns.some((column) => column.name === 'consumed_at')) {
      this.db.exec('ALTER TABLE approvals ADD COLUMN consumed_at TEXT');
    }
    if (schemaVersion < 4) this.db.prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version'").run();
    if (!this.getSetting<AppSettings>('app')) {
      this.setSetting<AppSettings>('app', {
        concurrency: 8,
        maxDepth: 2,
        maxAgents: 60,
        mainDirectLimit: 30,
        autoMode: false,
        budget: {
          maxCalls: 200,
          maxInputTokens: 5_000_000,
          maxOutputTokens: 500_000,
          maxMinutes: 120
        }
      });
    }
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json?: string } | undefined;
    return row?.value_json ? parseJson<T>(row.value_json, undefined as T) : undefined;
  }

  setSetting<T>(key: string, value: T): void {
    this.db.prepare(`INSERT INTO settings(key, value_json) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(key, JSON.stringify(value));
  }

  listProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), name: String(row.name), rootPath: String(row.root_path),
      isGit: Number(row.is_git) === 1, createdAt: String(row.created_at)
    }));
  }

  getProject(id: string): Project | undefined {
    return this.listProjects().find((project) => project.id === id);
  }

  createProject(input: { name: string; rootPath: string; isGit: boolean }): Project {
    const project: Project = { id: randomUUID(), ...input, createdAt: now() };
    this.db.prepare('INSERT INTO projects(id, name, root_path, is_git, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(project.id, project.name, project.rootPath, project.isGit ? 1 : 0, project.createdAt);
    return project;
  }

  updateProjectGit(id: string, isGit: boolean): void {
    this.db.prepare('UPDATE projects SET is_git = ? WHERE id = ?').run(isGit ? 1 : 0, id);
  }

  listRuns(projectId?: string): Run[] {
    const rows = (projectId
      ? this.db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY updated_at DESC').all(projectId)
      : this.db.prepare('SELECT * FROM runs ORDER BY updated_at DESC').all()) as Record<string, unknown>[];
    return rows.map((row) => this.mapRun(row));
  }

  getRun(id: string): Run | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRun(row) : undefined;
  }

  createRun(input: Pick<Run, 'projectId' | 'title' | 'question' | 'modelMode' | 'providerId' | 'model'>): Run {
    const timestamp = now();
    const run: Run = { id: randomUUID(), ...input, state: 'intake', docsApproved: false, createdAt: timestamp, updatedAt: timestamp };
    const event = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO runs(id, project_id, title, question, state, model_mode, provider_id, model, docs_approved, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(
        run.id, run.projectId, run.title, run.question, run.state, run.modelMode, run.providerId, run.model, timestamp, timestamp
      );
      this.db.prepare('INSERT OR IGNORE INTO usage(run_id) VALUES (?)').run(run.id);
      return this.insertEvent(run.id, 'run.state', { state: run.state });
    })();
    this.publishEvent(event);
    return run;
  }

  updateRun(id: string, patch: RunPatch): Run {
    const current = this.getRun(id);
    if (!current) throw new Error('RUN_NOT_FOUND');
    const { pauseReason, ...rest } = patch;
    const next: Run = { ...current, ...rest, updatedAt: now() };
    if (pauseReason === null) delete next.pauseReason;
    else if (pauseReason !== undefined) next.pauseReason = pauseReason;
    let event: RunEvent | undefined;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE runs SET state = ?, previous_state = ?, model_mode = ?, provider_id = ?, model = ?,
        docs_approved = ?, pause_reason = ?, updated_at = ? WHERE id = ?`).run(
        next.state, next.previousState ?? null, next.modelMode, next.providerId, next.model,
        next.docsApproved ? 1 : 0, next.pauseReason ?? null, next.updatedAt, id
      );
      if (patch.state) event = this.insertEvent(id, 'run.state', { state: next.state, reason: next.pauseReason });
    })();
    if (event) this.publishEvent(event);
    return next;
  }

  private mapRun(row: Record<string, unknown>): Run {
    return {
      id: String(row.id), projectId: String(row.project_id), title: String(row.title), question: String(row.question),
      state: String(row.state) as Run['state'],
      ...optional<Record<never, never>, 'previousState', Run['state']>('previousState', row.previous_state as Run['state'] | null),
      modelMode: String(row.model_mode) as Run['modelMode'], providerId: String(row.provider_id) as Run['providerId'],
      model: String(row.model), docsApproved: Number(row.docs_approved) === 1,
      ...optional<Record<never, never>, 'pauseReason', string>('pauseReason', row.pause_reason as string | null),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
  }

  listMessages(runId: string): ChatMessage[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE run_id = ? ORDER BY created_at').all(runId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), runId: String(row.run_id), role: String(row.role) as ChatMessage['role'],
      content: String(row.content), createdAt: String(row.created_at),
      ...(row.analysis_json ? { analysis: JSON.parse(String(row.analysis_json)) as NonNullable<ChatMessage['analysis']> } : {}),
      ...(row.attachments_json ? { attachments: JSON.parse(String(row.attachments_json)) as NonNullable<ChatMessage['attachments']> } : {})
    }));
  }

  addMessage(message: Omit<ChatMessage, 'id' | 'createdAt'>): ChatMessage {
    const full: ChatMessage = { ...message, id: randomUUID(), createdAt: now() };
    const event = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO messages(id, run_id, role, content, analysis_json, attachments_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        full.id, full.runId, full.role, full.content, full.analysis ? JSON.stringify(full.analysis) : null,
        full.attachments ? JSON.stringify(full.attachments) : null, full.createdAt
      );
      return this.insertEvent(full.runId, 'message.completed', full);
    })();
    this.publishEvent(event);
    return full;
  }

  listDocuments(projectId: string): LoopDocument[] {
    const rows = this.db.prepare('SELECT * FROM documents WHERE project_id = ? ORDER BY filename').all(projectId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), projectId: String(row.project_id), filename: String(row.filename), title: String(row.title),
      version: String(row.version), status: String(row.status) as LoopDocument['status'], hash: String(row.hash),
      content: String(row.content), updatedAt: String(row.updated_at)
    }));
  }

  getDocument(projectId: string, docId: string): LoopDocument | undefined {
    return this.listDocuments(projectId).find((document) => document.id === docId);
  }

  upsertDocument(document: LoopDocument, approvedHash?: string): void {
    this.db.prepare(`INSERT INTO documents(id, project_id, filename, title, version, status, hash, approved_hash, content, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, project_id) DO UPDATE SET filename=excluded.filename, title=excluded.title,
      version=excluded.version, status=excluded.status, hash=excluded.hash,
      approved_hash=COALESCE(excluded.approved_hash, documents.approved_hash), content=excluded.content, updated_at=excluded.updated_at`).run(
      document.id, document.projectId, document.filename, document.title, document.version, document.status,
      document.hash, approvedHash ?? null, document.content, document.updatedAt
    );
  }

  approveDocument(projectId: string, docId: string): LoopDocument {
    const result = this.db.prepare(`UPDATE documents SET status='approved', approved_hash=hash, updated_at=? WHERE project_id=? AND id=?`)
      .run(now(), projectId, docId);
    if (result.changes === 0) throw new Error('DOCUMENT_NOT_FOUND');
    const doc = this.getDocument(projectId, docId);
    if (!doc) throw new Error('DOCUMENT_NOT_FOUND');
    return doc;
  }

  approveDocuments(projectId: string, docIds: string[]): LoopDocument[] {
    const approve = this.db.transaction(() => {
      for (const docId of docIds) {
        const result = this.db.prepare(`UPDATE documents SET status='approved', approved_hash=hash, updated_at=? WHERE project_id=? AND id=?`)
          .run(now(), projectId, docId);
        if (result.changes === 0) throw new Error('DOCUMENT_NOT_FOUND');
      }
    });
    approve();
    return this.listDocuments(projectId);
  }

  documentsApproved(projectId: string, expectedCount = 5): boolean {
    const documents = this.listDocuments(projectId);
    return documents.length === expectedCount && documents.every((document) => document.status === 'approved');
  }

  listTasks(runId: string): TaskSpec[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY depth, id').all(runId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), runId: String(row.run_id),
      ...optional<Record<never, never>, 'parentId', string>('parentId', row.parent_id as string | null),
      title: String(row.title), description: String(row.description), status: String(row.status) as TaskSpec['status'],
      depth: Number(row.depth), dependencies: parseJson(row.dependencies_json, []), scope: parseJson(row.scope_json, []),
      docRefs: parseJson(row.doc_refs_json, []), acceptanceCriteria: parseJson(row.acceptance_json, []),
      ...(row.provider_id ? { providerId: String(row.provider_id) as NonNullable<TaskSpec['providerId']> } : {}),
      ...(row.model ? { model: String(row.model) } : {}),
      ...(row.assigned_agent_id ? { assignedAgentId: String(row.assigned_agent_id) } : {})
    }));
  }

  upsertTask(task: TaskSpec): void {
    const event = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO tasks(id, run_id, parent_id, title, description, status, depth, dependencies_json,
        scope_json, doc_refs_json, acceptance_json, provider_id, model, assigned_agent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, description=excluded.description,
        assigned_agent_id=excluded.assigned_agent_id, provider_id=excluded.provider_id, model=excluded.model`).run(
        task.id, task.runId, task.parentId ?? null, task.title, task.description, task.status, task.depth,
        JSON.stringify(task.dependencies), JSON.stringify(task.scope), JSON.stringify(task.docRefs),
        JSON.stringify(task.acceptanceCriteria), task.providerId ?? null, task.model ?? null, task.assignedAgentId ?? null
      );
      return this.insertEvent(task.runId, 'task.state', { taskId: task.id, status: task.status });
    })();
    this.publishEvent(event);
  }

  listAgents(runId: string): Agent[] {
    const rows = this.db.prepare('SELECT * FROM agents WHERE run_id = ? ORDER BY depth, id').all(runId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), runId: String(row.run_id),
      ...optional<Record<never, never>, 'parentId', string>('parentId', row.parent_id as string | null),
      name: String(row.name), role: String(row.role) as Agent['role'], status: String(row.status) as Agent['status'],
      depth: Number(row.depth), providerId: String(row.provider_id) as Agent['providerId'], model: String(row.model),
      ...optional<Record<never, never>, 'taskId', string>('taskId', row.task_id as string | null),
      contextUsage: Number(row.context_usage), lineage: Number(row.lineage)
    }));
  }

  acquireTaskLease(taskId: string, agentId: string, ttlMs = 300_000): boolean {
    const timestamp = Date.now();
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT agent_id, expires_at FROM task_leases WHERE task_id = ?').get(taskId) as
        { agent_id?: string; expires_at?: number } | undefined;
      if (existing && Number(existing.expires_at) > timestamp && existing.agent_id !== agentId) return false;
      this.db.prepare(`INSERT INTO task_leases(task_id, agent_id, expires_at, heartbeat_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET agent_id=excluded.agent_id, expires_at=excluded.expires_at,
        heartbeat_at=excluded.heartbeat_at`).run(taskId, agentId, timestamp + ttlMs, timestamp);
      return true;
    })();
  }

  renewTaskLease(taskId: string, agentId: string, ttlMs = 300_000): boolean {
    const timestamp = Date.now();
    const result = this.db.prepare(`UPDATE task_leases SET expires_at = ?, heartbeat_at = ?
      WHERE task_id = ? AND agent_id = ?`).run(timestamp + ttlMs, timestamp, taskId, agentId);
    return result.changes === 1;
  }

  releaseTaskLease(taskId: string, agentId: string): void {
    this.db.prepare('DELETE FROM task_leases WHERE task_id = ? AND agent_id = ?').run(taskId, agentId);
  }

  releaseRunLeases(runId: string): void {
    this.db.prepare('DELETE FROM task_leases WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?)').run(runId);
  }

  upsertAgent(agent: Agent): void {
    const event = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO agents(id, run_id, parent_id, name, role, status, depth, provider_id, model, task_id, context_usage, lineage)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, context_usage=excluded.context_usage, lineage=excluded.lineage`).run(
        agent.id, agent.runId, agent.parentId ?? null, agent.name, agent.role, agent.status, agent.depth,
        agent.providerId, agent.model, agent.taskId ?? null, agent.contextUsage, agent.lineage
      );
      return this.insertEvent(agent.runId, 'agent.state', { agentId: agent.id, status: agent.status, contextUsage: agent.contextUsage });
    })();
    this.publishEvent(event);
  }

  listApprovals(runId: string): ApprovalRequest[] {
    const rows = this.db.prepare('SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at DESC').all(runId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), runId: String(row.run_id),
      ...optional<Record<never, never>, 'taskId', string>('taskId', row.task_id as string | null),
      tool: String(row.tool), risk: String(row.risk) as ApprovalRequest['risk'], summary: String(row.summary),
      policyReason: String(row.policy_reason), status: String(row.status) as ApprovalRequest['status'],
      createdAt: String(row.created_at),
      ...optional<Record<never, never>, 'resolvedAt', string>('resolvedAt', row.resolved_at as string | null)
    }));
  }

  createApproval(input: Omit<ApprovalRequest, 'id' | 'createdAt' | 'status'>): ApprovalRequest {
    const approval: ApprovalRequest = { ...input, id: randomUUID(), status: 'pending', createdAt: now() };
    const event = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO approvals(id, run_id, task_id, tool, risk, summary, policy_reason, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        approval.id, approval.runId, approval.taskId ?? null, approval.tool, approval.risk,
        approval.summary, approval.policyReason, approval.status, approval.createdAt
      );
      return this.insertEvent(approval.runId, 'approval.requested', approval);
    })();
    this.publishEvent(event);
    return approval;
  }

  resolveApproval(id: string, status: 'approved' | 'rejected'): void {
    this.db.prepare('UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?').run(status, now(), id);
  }

  consumeApprovedTool(runId: string, taskId: string, tool: string, summary: string): boolean {
    const row = this.db.prepare(`SELECT id FROM approvals
      WHERE run_id = ? AND task_id = ? AND tool = ? AND summary = ? AND status = 'approved' AND consumed_at IS NULL
      ORDER BY resolved_at LIMIT 1`).get(runId, taskId, tool, summary) as { id?: string } | undefined;
    if (!row?.id) return false;
    this.db.prepare('UPDATE approvals SET consumed_at = ? WHERE id = ?').run(now(), row.id);
    return true;
  }

  private insertEvent<T>(runId: string, type: RunEvent<T>['type'], payload: T): RunEvent<T> {
    const createdAt = now();
    const result = this.db.prepare('INSERT INTO events(run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
      .run(runId, type, JSON.stringify(payload), createdAt);
    return { id: Number(result.lastInsertRowid), runId, type, payload, createdAt };
  }

  private publishEvent<T>(event: RunEvent<T>): void {
    this.events.emit(`run:${event.runId}`, event);
  }

  appendEvent<T>(runId: string, type: RunEvent<T>['type'], payload: T): RunEvent<T> {
    const event = this.insertEvent(runId, type, payload);
    this.publishEvent(event);
    return event;
  }

  listEvents(runId: string, after = 0, limit = 1000, through = Number.MAX_SAFE_INTEGER): RunEvent[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 10_000));
    const rows = this.db.prepare('SELECT * FROM events WHERE run_id = ? AND id > ? AND id <= ? ORDER BY id LIMIT ?')
      .all(runId, after, through, safeLimit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id), runId: String(row.run_id), type: String(row.type) as RunEvent['type'],
      payload: parseJson(row.payload_json, {}), createdAt: String(row.created_at)
    }));
  }

  getEventWatermark(runId: string): number {
    const row = this.db.prepare('SELECT MAX(id) AS watermark FROM events WHERE run_id = ?').get(runId) as { watermark?: number | null };
    return Number(row.watermark ?? 0);
  }

  upsertCheckpoint(checkpoint: Checkpoint): void {
    this.db.prepare(`INSERT INTO checkpoints(id, run_id, agent_id, lineage, doc_refs_json, task_ids_json,
      event_watermark, decisions_json, unresolved_json, next_action, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET doc_refs_json=excluded.doc_refs_json, task_ids_json=excluded.task_ids_json,
      event_watermark=excluded.event_watermark, decisions_json=excluded.decisions_json,
      unresolved_json=excluded.unresolved_json, next_action=excluded.next_action`).run(
      checkpoint.id, checkpoint.runId, checkpoint.agentId, checkpoint.lineage,
      JSON.stringify(checkpoint.docRefs), JSON.stringify(checkpoint.taskIds), checkpoint.eventWatermark,
      JSON.stringify(checkpoint.decisions), JSON.stringify(checkpoint.unresolved), checkpoint.nextAction,
      checkpoint.createdAt
    );
  }

  listCheckpoints(runId: string): Checkpoint[] {
    const rows = this.db.prepare('SELECT * FROM checkpoints WHERE run_id = ? ORDER BY created_at').all(runId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), runId: String(row.run_id), agentId: String(row.agent_id), lineage: Number(row.lineage),
      docRefs: parseJson(row.doc_refs_json, []), taskIds: parseJson(row.task_ids_json, []),
      eventWatermark: Number(row.event_watermark), decisions: parseJson(row.decisions_json, []),
      unresolved: parseJson(row.unresolved_json, []), nextAction: String(row.next_action), createdAt: String(row.created_at)
    }));
  }

  getIdempotent<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT result_json FROM idempotency WHERE key = ?').get(key) as { result_json?: string } | undefined;
    return row?.result_json ? parseJson<T>(row.result_json, undefined as T) : undefined;
  }

  setIdempotent<T>(key: string, result: T): void {
    this.db.prepare('INSERT OR REPLACE INTO idempotency(key, result_json, created_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(result), now());
  }

  addUsage(runId: string, inputTokens: number, outputTokens: number): void {
    const event = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO usage(run_id, calls, input_tokens, output_tokens) VALUES (?, 1, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET calls=calls+1, input_tokens=input_tokens+excluded.input_tokens,
        output_tokens=output_tokens+excluded.output_tokens`).run(runId, inputTokens, outputTokens);
      const usage = this.db.prepare('SELECT * FROM usage WHERE run_id = ?').get(runId) as Record<string, SqlValue>;
      return this.insertEvent(runId, 'budget.updated', usage);
    })();
    this.publishEvent(event);
  }

  getUsage(runId: string): { calls: number; inputTokens: number; outputTokens: number } {
    const row = this.db.prepare('SELECT calls, input_tokens, output_tokens FROM usage WHERE run_id = ?').get(runId) as
      { calls?: number; input_tokens?: number; output_tokens?: number } | undefined;
    return {
      calls: Number(row?.calls ?? 0),
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0)
    };
  }
}
