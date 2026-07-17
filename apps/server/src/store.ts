import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, copyFileSync, existsSync } from 'node:fs';
import type {
  ActionAttempt,
  Agent,
  AgentAction,
  AppSettings,
  ApprovalRequest,
  ApprovalScope,
  BudgetReservation,
  ChatMessage,
  Checkpoint,
  DeliverySummary,
  LoopDocument,
  PlanGeneration,
  Project,
  Run,
  RunBlocker,
  RunEvent,
  ProviderId,
  SnapshotEnvelope,
  SettingSource,
  TaskResult,
  TaskSpec,
  ToolOutput,
  WorktreeArtifact
} from '@loop/contracts';
import {
  agentActionSchema,
  deliverySummarySchema,
  taskResultSchema,
  toolOutputSchema,
  worktreeArtifactSchema
} from '@loop/contracts';

type SqlValue = string | number | null;
type RunPatch = Partial<Pick<Run, 'state' | 'previousState' | 'docsApproved' | 'providerId' | 'model' | 'modelMode' | 'executionMode' | 'generation' | 'baseRef'>> & {
  pauseReason?: string | null;
  blocker?: RunBlocker | null;
};

type CreateApprovalInput = Omit<ApprovalRequest,
  'id' | 'createdAt' | 'status' | 'resolvedAt' | 'consumedAt' | 'reusable' | 'capability' | 'resource' | 'scope'> &
  Partial<Pick<ApprovalRequest, 'reusable' | 'capability' | 'resource' | 'scope'>> & { generation?: number };

export interface SettingProvenance {
  source: SettingSource;
  detail?: string;
  locked?: boolean;
}

export type StoredBudgetReservation = BudgetReservation & {
  generation: number;
  dispatchState: 'queued' | 'dispatched' | 'finished';
  queuedAt: string;
  dispatchedAt?: string;
  executionStartedAt?: string;
  activeExecutionSeconds: number;
};

export interface DatabaseMaintenanceResult {
  integrity: string[];
  checkpoint?: { busy: number; log: number; checkpointed: number };
}

const forcedSingleUseRuleKeys = new Set([
  'command:network',
  'command:dependencies',
  'command:delete',
  'command:git-history-or-publish',
  'command:unknown',
  'command:npm-verification',
  'integration:verification',
  'integration:merge',
  'merge:integration'
]);

function mustBeSingleUse(input: Pick<ApprovalRequest, 'tool' | 'ruleKey' | 'risk'>): boolean {
  return input.risk === 'critical' || input.tool === 'merge_integration' || forcedSingleUseRuleKeys.has(input.ruleKey);
}

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

function isMemoryDatabase(path: string): boolean {
  return path === ':memory:' || /^file:.*(?:mode=memory|memory:)/i.test(path);
}

export class LoopStore {
  readonly db: Database.Database;
  readonly events = new EventEmitter();
  private readonly databasePath: string;

  constructor(path: string) {
    this.databasePath = path;
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
    const maintenance = this.maintainDatabase('PASSIVE');
    if (maintenance.integrity.some((result) => result !== 'ok')) {
      this.db.close();
      throw new Error(`DATABASE_INTEGRITY_CHECK_FAILED: ${maintenance.integrity.join('; ')}`);
    }
  }

  close(): void {
    this.db.close();
  }

  maintainDatabase(mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'PASSIVE'): DatabaseMaintenanceResult {
    const integrityRows = this.db.pragma('integrity_check') as Array<Record<string, unknown>>;
    const integrity = integrityRows.map((row) => String(row.integrity_check ?? Object.values(row)[0] ?? 'unknown'));
    let checkpoint: DatabaseMaintenanceResult['checkpoint'];
    try {
      const rows = this.db.pragma(`wal_checkpoint(${mode})`) as Array<Record<string, unknown>>;
      const row = rows[0];
      if (row) {
        checkpoint = {
          busy: Number(row.busy ?? 0),
          log: Number(row.log ?? 0),
          checkpointed: Number(row.checkpointed ?? 0)
        };
      }
    } catch (error) {
      if (!(error instanceof Error) || !/WAL|locked/i.test(error.message)) throw error;
    }
    return { integrity, ...(checkpoint ? { checkpoint } : {}) };
  }

  private backupV7Database(): string | undefined {
    if (isMemoryDatabase(this.databasePath) || !existsSync(this.databasePath)) return undefined;
    const checkpoint = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<Record<string, unknown>>;
    if (Number(checkpoint[0]?.busy ?? 0) !== 0) {
      throw new Error('DATABASE_BACKUP_BUSY: 无法在迁移前完整落盘 WAL');
    }
    const timestamp = now().replace(/[:.]/g, '-');
    const backupPath = `${this.databasePath}.v7-${timestamp}-${randomUUID()}.bak`;
    copyFileSync(this.databasePath, backupPath, fsConstants.COPYFILE_EXCL);
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      const rows = backup.pragma('integrity_check') as Array<Record<string, unknown>>;
      const results = rows.map((row) => String(row.integrity_check ?? Object.values(row)[0] ?? 'unknown'));
      if (results.some((result) => result !== 'ok')) {
        throw new Error(`DATABASE_BACKUP_INTEGRITY_FAILED: ${results.join('; ')}`);
      }
    } finally {
      backup.close();
    }
    return backupPath;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
    `);
    const schemaRow = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    const schemaVersion = Number(schemaRow?.value ?? 1);
    if (schemaVersion > 8) throw new Error(`SCHEMA_VERSION_UNSUPPORTED: 数据库版本 ${schemaVersion} 高于当前服务支持的版本 8`);
    if (schemaVersion === 7) this.backupV7Database();

    this.db.transaction(() => {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
        is_git INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, question TEXT NOT NULL,
        state TEXT NOT NULL, previous_state TEXT, model_mode TEXT NOT NULL,
        execution_mode TEXT NOT NULL DEFAULT 'simple', provider_id TEXT NOT NULL,
        model TEXT NOT NULL, allowed_provider_ids_json TEXT NOT NULL DEFAULT '[]',
        generation INTEGER NOT NULL DEFAULT 1, base_ref TEXT NOT NULL DEFAULT 'HEAD',
        blocker_json TEXT, snapshot_version INTEGER NOT NULL DEFAULT 0,
        docs_approved INTEGER NOT NULL DEFAULT 0, pause_reason TEXT,
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
        description TEXT NOT NULL, status TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, depth INTEGER NOT NULL,
        dependencies_json TEXT NOT NULL, scope_json TEXT NOT NULL, doc_refs_json TEXT NOT NULL,
        acceptance_json TEXT NOT NULL, provider_id TEXT, model TEXT, assigned_agent_id TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, role TEXT NOT NULL,
        status TEXT NOT NULL, depth INTEGER NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL,
        task_id TEXT, context_usage REAL NOT NULL DEFAULT 0, lineage INTEGER NOT NULL DEFAULT 1,
        generation INTEGER NOT NULL DEFAULT 1, closed_at TEXT, closure_reason TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, tool TEXT NOT NULL, risk TEXT NOT NULL,
        rule_key TEXT NOT NULL DEFAULT 'legacy', reusable INTEGER NOT NULL DEFAULT 0,
        capability TEXT NOT NULL DEFAULT 'tool.execute', resource TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT 'once',
        summary TEXT NOT NULL, policy_reason TEXT NOT NULL, status TEXT NOT NULL,
        action_attempt_id TEXT, generation INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, resolved_at TEXT, consumed_at TEXT, closed_at TEXT, closure_reason TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, type TEXT NOT NULL,
        payload_json TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1,
        entity_revision INTEGER NOT NULL DEFAULT 0, snapshot_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (
        run_id TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0, active_execution_seconds REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT NOT NULL, lineage INTEGER NOT NULL,
        doc_refs_json TEXT NOT NULL, task_ids_json TEXT NOT NULL, event_watermark INTEGER NOT NULL,
        decisions_json TEXT NOT NULL, unresolved_json TEXT NOT NULL, next_action TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL, closed_at TEXT, closure_reason TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id), FOREIGN KEY(agent_id) REFERENCES agents(id)
      );
      CREATE TABLE IF NOT EXISTS task_leases (
        task_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, expires_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id), FOREIGN KEY(agent_id) REFERENCES agents(id)
      );
      CREATE TABLE IF NOT EXISTS approval_rules (
        run_id TEXT NOT NULL, rule_key TEXT NOT NULL, capability TEXT NOT NULL DEFAULT 'tool.execute',
        resource TEXT NOT NULL DEFAULT '', generation INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, rule_key), FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS plan_generations (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL,
        doc_refs_json TEXT NOT NULL DEFAULT '[]', reason TEXT, created_at TEXT NOT NULL, approved_at TEXT,
        UNIQUE(run_id, generation), FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS action_attempts (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, agent_id TEXT,
        generation INTEGER NOT NULL, sequence INTEGER NOT NULL, action_type TEXT NOT NULL,
        action_json TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
        approval_id TEXT, tool_output_id TEXT, error TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS action_attempts_sequence
        ON action_attempts(run_id, generation, COALESCE(task_id, ''), sequence);
      CREATE TABLE IF NOT EXISTS budget_reservations (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT, status TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1, dispatch_state TEXT NOT NULL DEFAULT 'queued',
        reserved_calls INTEGER NOT NULL, reserved_input_tokens INTEGER NOT NULL,
        reserved_output_tokens INTEGER NOT NULL, reserved_cost REAL NOT NULL,
        actual_calls INTEGER, actual_input_tokens INTEGER, actual_output_tokens INTEGER, actual_cost REAL,
        created_at TEXT NOT NULL, queued_at TEXT NOT NULL, dispatched_at TEXT, execution_started_at TEXT,
        active_execution_seconds REAL NOT NULL DEFAULT 0, unknown_at TEXT, settled_at TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE INDEX IF NOT EXISTS budget_reservations_active
        ON budget_reservations(run_id, provider_id, status);
      CREATE TABLE IF NOT EXISTS task_results (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, generation INTEGER NOT NULL,
        summary TEXT NOT NULL, evidence_json TEXT NOT NULL, verification_commands_json TEXT NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0, commit_sha TEXT, risks_json TEXT NOT NULL,
        unresolved_json TEXT NOT NULL, created_at TEXT NOT NULL, verified_at TEXT,
        UNIQUE(task_id, generation), FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS tool_outputs (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, action_attempt_id TEXT,
        generation INTEGER NOT NULL, tool TEXT NOT NULL, content TEXT NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0, byte_length INTEGER NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS worktree_artifacts (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, generation INTEGER NOT NULL,
        kind TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, base_ref TEXT NOT NULL,
        commit_sha TEXT, status TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0,
        retained_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(run_id, path), FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS delivery_summaries (
        run_id TEXT NOT NULL, generation INTEGER NOT NULL, base_ref TEXT NOT NULL,
        manifest_id TEXT, revision TEXT NOT NULL DEFAULT '',
        integration_branch TEXT, files_changed_json TEXT NOT NULL, commits_json TEXT NOT NULL,
        verification_commands_json TEXT NOT NULL, task_results_json TEXT NOT NULL,
        risks_json TEXT NOT NULL, unresolved_json TEXT NOT NULL, actual_cost REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id, generation), FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS operation_attempts (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, generation INTEGER NOT NULL, kind TEXT NOT NULL,
        status TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, input_json TEXT NOT NULL,
        task_id TEXT, action_attempt_id TEXT, approval_id TEXT, provider_id TEXT, model TEXT,
        result_ref TEXT, effect_fingerprint TEXT, error_code TEXT, recovery_actions_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, dispatched_at TEXT, observed_at TEXT,
        committed_at TEXT, completed_at TEXT, active_started_at TEXT,
        active_execution_seconds REAL NOT NULL DEFAULT 0, superseded_by_generation INTEGER, closed_reason TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS delivery_manifests (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, generation INTEGER NOT NULL, revision TEXT NOT NULL,
        content_hash TEXT NOT NULL, manifest_json TEXT NOT NULL, supersedes_id TEXT, created_at TEXT NOT NULL,
        UNIQUE(run_id, generation, revision), UNIQUE(run_id, generation, content_hash),
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS acceptance_records (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, generation INTEGER NOT NULL,
        delivery_manifest_id TEXT NOT NULL, delivery_revision TEXT NOT NULL,
        decision TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
        feedback TEXT, target_branch TEXT, merge_commit TEXT, failure_code TEXT,
        accepted_additions INTEGER NOT NULL DEFAULT 0, accepted_deletions INTEGER NOT NULL DEFAULT 0,
        decided_at TEXT NOT NULL,
        completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id), FOREIGN KEY(delivery_manifest_id) REFERENCES delivery_manifests(id)
      );
      CREATE TABLE IF NOT EXISTS run_config_snapshots (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, generation INTEGER NOT NULL, revision INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(run_id, generation, revision), UNIQUE(run_id, generation, content_hash),
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS settings_provenance (
        key TEXT PRIMARY KEY, source TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
    `);
    const ensureColumn = (table: string, column: string, definition: string): void => {
      const columns = this.db.prepare(`PRAGMA table_info('${table}')`).all() as { name?: string }[];
      if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    };
    ensureColumn('agents', 'generation', 'generation INTEGER NOT NULL DEFAULT 1');
    ensureColumn('agents', 'closed_at', 'closed_at TEXT');
    ensureColumn('agents', 'closure_reason', 'closure_reason TEXT');
    ensureColumn('approvals', 'generation', 'generation INTEGER NOT NULL DEFAULT 1');
    ensureColumn('approvals', 'closed_at', 'closed_at TEXT');
    ensureColumn('approvals', 'closure_reason', 'closure_reason TEXT');
    ensureColumn('checkpoints', 'generation', 'generation INTEGER NOT NULL DEFAULT 1');
    ensureColumn('checkpoints', 'status', "status TEXT NOT NULL DEFAULT 'active'");
    ensureColumn('checkpoints', 'closed_at', 'closed_at TEXT');
    ensureColumn('checkpoints', 'closure_reason', 'closure_reason TEXT');
    ensureColumn('approval_rules', 'generation', 'generation INTEGER NOT NULL DEFAULT 1');
    ensureColumn('usage', 'active_execution_seconds', 'active_execution_seconds REAL NOT NULL DEFAULT 0');
    ensureColumn('budget_reservations', 'generation', 'generation INTEGER NOT NULL DEFAULT 1');
    ensureColumn('budget_reservations', 'dispatch_state', "dispatch_state TEXT NOT NULL DEFAULT 'queued'");
    ensureColumn('budget_reservations', 'queued_at', "queued_at TEXT NOT NULL DEFAULT ''");
    ensureColumn('budget_reservations', 'dispatched_at', 'dispatched_at TEXT');
    ensureColumn('budget_reservations', 'execution_started_at', 'execution_started_at TEXT');
    ensureColumn('budget_reservations', 'active_execution_seconds', 'active_execution_seconds REAL NOT NULL DEFAULT 0');
    ensureColumn('delivery_summaries', 'manifest_id', 'manifest_id TEXT');
    ensureColumn('delivery_summaries', 'revision', "revision TEXT NOT NULL DEFAULT ''");
    const runColumns = this.db.prepare("PRAGMA table_info('runs')").all() as { name?: string }[];
    if (!runColumns.some((column) => column.name === 'allowed_provider_ids_json')) {
      this.db.exec("ALTER TABLE runs ADD COLUMN allowed_provider_ids_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!runColumns.some((column) => column.name === 'execution_mode')) {
      this.db.exec("ALTER TABLE runs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'simple'");
    }
    if (!runColumns.some((column) => column.name === 'generation')) {
      this.db.exec("ALTER TABLE runs ADD COLUMN generation INTEGER NOT NULL DEFAULT 1");
    }
    if (!runColumns.some((column) => column.name === 'base_ref')) {
      this.db.exec("ALTER TABLE runs ADD COLUMN base_ref TEXT NOT NULL DEFAULT 'HEAD'");
    }
    if (!runColumns.some((column) => column.name === 'blocker_json')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN blocker_json TEXT');
    }
    if (!runColumns.some((column) => column.name === 'snapshot_version')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN snapshot_version INTEGER NOT NULL DEFAULT 0');
    }
    const taskColumns = this.db.prepare("PRAGMA table_info('tasks')").all() as { name?: string }[];
    if (!taskColumns.some((column) => column.name === 'generation')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN generation INTEGER NOT NULL DEFAULT 1');
    }
    const documentColumns = this.db.prepare("PRAGMA table_info('documents')").all() as { name?: string }[];
    if (!documentColumns.some((column) => column.name === 'approved_hash')) {
      this.db.exec('ALTER TABLE documents ADD COLUMN approved_hash TEXT');
    }
    const approvalColumns = this.db.prepare("PRAGMA table_info('approvals')").all() as { name?: string }[];
    if (!approvalColumns.some((column) => column.name === 'rule_key')) {
      this.db.exec("ALTER TABLE approvals ADD COLUMN rule_key TEXT NOT NULL DEFAULT 'legacy'");
    }
    if (!approvalColumns.some((column) => column.name === 'consumed_at')) {
      this.db.exec('ALTER TABLE approvals ADD COLUMN consumed_at TEXT');
    }
    if (!approvalColumns.some((column) => column.name === 'reusable')) {
      this.db.exec('ALTER TABLE approvals ADD COLUMN reusable INTEGER NOT NULL DEFAULT 0');
    }
    if (!approvalColumns.some((column) => column.name === 'capability')) {
      this.db.exec("ALTER TABLE approvals ADD COLUMN capability TEXT NOT NULL DEFAULT 'tool.execute'");
    }
    if (!approvalColumns.some((column) => column.name === 'resource')) {
      this.db.exec("ALTER TABLE approvals ADD COLUMN resource TEXT NOT NULL DEFAULT ''");
    }
    if (!approvalColumns.some((column) => column.name === 'scope')) {
      this.db.exec("ALTER TABLE approvals ADD COLUMN scope TEXT NOT NULL DEFAULT 'once'");
    }
    if (!approvalColumns.some((column) => column.name === 'action_attempt_id')) {
      this.db.exec('ALTER TABLE approvals ADD COLUMN action_attempt_id TEXT');
    }
    const eventColumns = this.db.prepare("PRAGMA table_info('events')").all() as { name?: string }[];
    if (!eventColumns.some((column) => column.name === 'schema_version')) {
      this.db.exec('ALTER TABLE events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1');
    }
    if (!eventColumns.some((column) => column.name === 'entity_revision')) {
      this.db.exec('ALTER TABLE events ADD COLUMN entity_revision INTEGER NOT NULL DEFAULT 0');
    }
    if (!eventColumns.some((column) => column.name === 'snapshot_version')) {
      this.db.exec('ALTER TABLE events ADD COLUMN snapshot_version INTEGER NOT NULL DEFAULT 0');
    }
    const usageColumns = this.db.prepare("PRAGMA table_info('usage')").all() as { name?: string }[];
    if (!usageColumns.some((column) => column.name === 'estimated_cost')) {
      this.db.exec('ALTER TABLE usage ADD COLUMN estimated_cost REAL NOT NULL DEFAULT 0');
    }
    const budgetColumns = this.db.prepare("PRAGMA table_info('budget_reservations')").all() as { name?: string }[];
    if (!budgetColumns.some((column) => column.name === 'unknown_at')) {
      this.db.exec('ALTER TABLE budget_reservations ADD COLUMN unknown_at TEXT');
    }
    const approvalRuleColumns = this.db.prepare("PRAGMA table_info('approval_rules')").all() as { name?: string }[];
    if (!approvalRuleColumns.some((column) => column.name === 'rule_key')) {
      this.db.exec(`
        DROP TABLE approval_rules;
        CREATE TABLE approval_rules (
          run_id TEXT NOT NULL, rule_key TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(run_id, rule_key), FOREIGN KEY(run_id) REFERENCES runs(id)
        );
      `);
    }
    const refreshedApprovalRuleColumns = this.db.prepare("PRAGMA table_info('approval_rules')").all() as { name?: string }[];
    if (!refreshedApprovalRuleColumns.some((column) => column.name === 'capability')) {
      this.db.exec("ALTER TABLE approval_rules ADD COLUMN capability TEXT NOT NULL DEFAULT 'tool.execute'");
    }
    if (!refreshedApprovalRuleColumns.some((column) => column.name === 'resource')) {
      this.db.exec("ALTER TABLE approval_rules ADD COLUMN resource TEXT NOT NULL DEFAULT ''");
    }
    if (!refreshedApprovalRuleColumns.some((column) => column.name === 'generation')) {
      this.db.exec('ALTER TABLE approval_rules ADD COLUMN generation INTEGER NOT NULL DEFAULT 1');
    }
    this.db.exec(`
      UPDATE action_attempts
      SET tool_output_id = (
        SELECT candidate.id FROM tool_outputs candidate
        WHERE candidate.action_attempt_id = action_attempts.id
        ORDER BY CASE WHEN candidate.id = action_attempts.tool_output_id THEN 0 ELSE 1 END,
          candidate.created_at, candidate.id
        LIMIT 1
      )
      WHERE EXISTS (SELECT 1 FROM tool_outputs candidate WHERE candidate.action_attempt_id = action_attempts.id);

      DELETE FROM tool_outputs WHERE id IN (
        SELECT id FROM (
          SELECT output.id,
            ROW_NUMBER() OVER (
              PARTITION BY output.action_attempt_id
              ORDER BY CASE WHEN output.id = attempt.tool_output_id THEN 0 ELSE 1 END,
                output.created_at, output.id
            ) AS duplicate_rank
          FROM tool_outputs output
          LEFT JOIN action_attempts attempt ON attempt.id = output.action_attempt_id
          WHERE output.action_attempt_id IS NOT NULL
        ) duplicates
        WHERE duplicate_rank > 1
      );

      CREATE UNIQUE INDEX IF NOT EXISTS tool_outputs_action_attempt
        ON tool_outputs(action_attempt_id) WHERE action_attempt_id IS NOT NULL;
    `);

    const migrationRuns = this.db.prepare(`SELECT id, project_id, generation, docs_approved, created_at, updated_at
      FROM runs`).all() as Array<Record<string, unknown>>;
    for (const run of migrationRuns) {
      const documents = this.db.prepare(`SELECT id, version, status, hash, approved_hash
        FROM documents WHERE project_id = ? ORDER BY id`).all(String(run.project_id)) as Array<Record<string, unknown>>;
      const documentsAreApproved = documents.length > 0 && documents.every((document) =>
        String(document.status) === 'approved' && Boolean(document.approved_hash) && document.approved_hash === document.hash
      );
      const canKeepApproval = Number(run.docs_approved) === 1 && documentsAreApproved;
      const docRefs = documents.map((document) => ({
        docId: String(document.id), version: String(document.version), hash: String(document.hash), sections: [] as string[]
      }));
      const existing = this.db.prepare(`SELECT status, doc_refs_json FROM plan_generations
        WHERE run_id = ? AND generation = ?`).get(String(run.id), Number(run.generation)) as
        { status?: string; doc_refs_json?: string } | undefined;
      if (!existing) {
        this.db.prepare(`INSERT INTO plan_generations(id, run_id, generation, status, doc_refs_json, reason, created_at, approved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          randomUUID(), String(run.id), Number(run.generation), canKeepApproval ? 'approved' : 'draft',
          JSON.stringify(canKeepApproval ? docRefs : []), '由 v7 迁移创建', String(run.created_at),
          canKeepApproval ? String(run.updated_at) : null
        );
      } else if (existing.status === 'approved' && parseJson(existing.doc_refs_json, [] as unknown[]).length === 0) {
        this.db.prepare(`UPDATE plan_generations SET status = ?, doc_refs_json = ?, approved_at = ?
          WHERE run_id = ? AND generation = ?`).run(
          canKeepApproval ? 'approved' : 'draft', JSON.stringify(canKeepApproval ? docRefs : []),
          canKeepApproval ? String(run.updated_at) : null, String(run.id), Number(run.generation)
        );
      }
      if (Number(run.docs_approved) === 1 && !canKeepApproval) {
        this.db.prepare('UPDATE runs SET docs_approved = 0 WHERE id = ?').run(String(run.id));
      }
    }
    if (schemaVersion < 7) this.db.prepare("UPDATE meta SET value = '7' WHERE key = 'schema_version'").run();
    })();
    if (!this.getSetting<AppSettings>('app')) {
      this.setSetting<AppSettings>('app', {
        concurrency: 2,
        maxDepth: 1,
        maxAgents: 12,
        mainDirectLimit: 8,
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

  createRun(input: Pick<Run, 'projectId' | 'title' | 'question' | 'modelMode' | 'providerId' | 'model'> & {
    executionMode?: Run['executionMode'];
    allowedProviderIds?: ProviderId[];
    baseRef?: string;
  }): Run {
    const timestamp = now();
    const allowedProviderIds = input.allowedProviderIds?.length ? [...new Set(input.allowedProviderIds)] : [input.providerId];
    const run: Run = {
      id: randomUUID(), projectId: input.projectId, title: input.title, question: input.question,
      modelMode: input.modelMode, executionMode: input.executionMode ?? 'simple', providerId: input.providerId, model: input.model,
      allowedProviderIds, generation: 1, baseRef: input.baseRef ?? 'HEAD', state: 'intake', docsApproved: false,
      createdAt: timestamp, updatedAt: timestamp
    };
    const event = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO runs(id, project_id, title, question, state, model_mode, provider_id, model,
        execution_mode, allowed_provider_ids_json, generation, base_ref, docs_approved, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(
        run.id, run.projectId, run.title, run.question, run.state, run.modelMode, run.providerId, run.model, run.executionMode,
        JSON.stringify(run.allowedProviderIds), run.generation, run.baseRef, timestamp, timestamp
      );
      this.db.prepare('INSERT OR IGNORE INTO usage(run_id) VALUES (?)').run(run.id);
      this.db.prepare(`INSERT INTO plan_generations(id, run_id, generation, status, doc_refs_json, reason, created_at)
        VALUES (?, ?, 1, 'draft', '[]', ?, ?)`).run(randomUUID(), run.id, '运行创建', timestamp);
      return this.insertEvent(run.id, 'run.state', { state: run.state });
    })();
    this.publishEvent(event);
    return run;
  }

  updateRun(id: string, patch: RunPatch): Run {
    const current = this.getRun(id);
    if (!current) throw new Error('RUN_NOT_FOUND');
    const { pauseReason, blocker, ...rest } = patch;
    const next: Run = { ...current, ...rest, updatedAt: now() };
    if (pauseReason === null) delete next.pauseReason;
    else if (pauseReason !== undefined) next.pauseReason = pauseReason;
    if (blocker === null) {
      const pending = this.db.prepare("SELECT 1 FROM approvals WHERE run_id = ? AND status = 'pending' LIMIT 1").get(id);
      if (pending) throw new Error('RUN_BLOCKED_APPROVAL: 待处理审批不能由通用继续操作清除');
      delete next.blocker;
    } else if (blocker !== undefined) {
      next.blocker = blocker;
    }
    let event: RunEvent | undefined;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE runs SET state = ?, previous_state = ?, model_mode = ?, provider_id = ?, model = ?,
        execution_mode = ?, generation = ?, base_ref = ?, blocker_json = ?, docs_approved = ?, pause_reason = ?, updated_at = ? WHERE id = ?`).run(
        next.state, next.previousState ?? null, next.modelMode, next.providerId, next.model, next.executionMode,
        next.generation, next.baseRef, next.blocker ? JSON.stringify(next.blocker) : null,
        next.docsApproved ? 1 : 0, next.pauseReason ?? null, next.updatedAt, id
      );
      if (patch.state || blocker !== undefined) {
        event = this.insertEvent(id, 'run.state', {
          state: next.state,
          reason: next.pauseReason ?? null,
          generation: next.generation,
          blocker: next.blocker ?? null
        });
      }
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
      executionMode: String(row.execution_mode ?? 'simple') as Run['executionMode'],
      model: String(row.model),
      allowedProviderIds: parseJson<ProviderId[]>(row.allowed_provider_ids_json, []).length
        ? parseJson<ProviderId[]>(row.allowed_provider_ids_json, [])
        : [String(row.provider_id) as ProviderId],
      generation: Number(row.generation ?? 1),
      baseRef: String(row.base_ref ?? 'HEAD'),
      docsApproved: Number(row.docs_approved) === 1,
      ...optional<Record<never, never>, 'pauseReason', string>('pauseReason', row.pause_reason as string | null),
      ...optional<Record<never, never>, 'blocker', RunBlocker>(
        'blocker', row.blocker_json ? parseJson<RunBlocker | undefined>(row.blocker_json, undefined) : undefined
      ),
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

  listPlanGenerations(runId: string): PlanGeneration[] {
    const rows = this.db.prepare('SELECT * FROM plan_generations WHERE run_id = ? ORDER BY generation')
      .all(runId) as Record<string, unknown>[];
    return rows.map((row) => this.mapPlanGeneration(row));
  }

  getCurrentPlanGeneration(runId: string): PlanGeneration | undefined {
    const row = this.db.prepare(`SELECT pg.* FROM plan_generations pg
      JOIN runs r ON r.id = pg.run_id AND r.generation = pg.generation
      WHERE pg.run_id = ?`).get(runId) as Record<string, unknown> | undefined;
    return row ? this.mapPlanGeneration(row) : undefined;
  }

  createPlanGeneration(
    runId: string,
    docRefs: TaskSpec['docRefs'],
    reason = '规范文档已变更',
    completedAttemptId?: string
  ): PlanGeneration {
    const timestamp = now();
    let event: RunEvent | undefined;
    const generation = this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error('RUN_NOT_FOUND');
      if (completedAttemptId) {
        const attempt = this.getActionAttempt(completedAttemptId);
        if (
          !attempt || attempt.runId !== runId || attempt.generation !== run.generation ||
          attempt.action.type !== 'revise_docs' ||
          !['pending', 'executing', 'completed'].includes(attempt.status)
        ) {
          throw new Error('ACTION_ATTEMPT_STATE_CONFLICT');
        }
        if (attempt.status !== 'completed') {
          const completed = this.db.prepare(`UPDATE action_attempts SET status = 'completed', updated_at = ?, completed_at = ?
            WHERE id = ? AND run_id = ? AND generation = ? AND status IN ('pending', 'executing')`).run(
            timestamp, timestamp, attempt.id, runId, run.generation
          );
          if (completed.changes !== 1) throw new Error('ACTION_ATTEMPT_STATE_CONFLICT');
        }
      }
      const nextGeneration = Math.max(
        run.generation + 1,
        Number((this.db.prepare('SELECT MAX(generation) AS value FROM plan_generations WHERE run_id = ?')
          .get(runId) as { value?: number | null }).value ?? 0) + 1
      );
      this.db.prepare("UPDATE plan_generations SET status = 'superseded' WHERE run_id = ? AND status != 'superseded'")
        .run(runId);
      this.db.prepare(`INSERT INTO plan_generations(id, run_id, generation, status, doc_refs_json, reason, created_at)
        VALUES (?, ?, ?, 'draft', ?, ?, ?)`).run(randomUUID(), runId, nextGeneration, JSON.stringify(docRefs), reason, timestamp);
      this.db.prepare("UPDATE tasks SET status = 'stale' WHERE run_id = ? AND generation < ?")
        .run(runId, nextGeneration);
      this.db.prepare(`DELETE FROM task_leases WHERE task_id IN (
        SELECT id FROM tasks WHERE run_id = ? AND generation < ?
      )`).run(runId, nextGeneration);
      this.db.prepare(`UPDATE approvals SET status = 'rejected', resolved_at = ?
        WHERE run_id = ? AND status = 'pending' AND action_attempt_id IN (
          SELECT id FROM action_attempts WHERE run_id = ? AND generation < ?
        )`).run(timestamp, runId, runId, nextGeneration);
      this.db.prepare(`UPDATE action_attempts SET status = 'cancelled', updated_at = ?, completed_at = ?,
        error = COALESCE(error, 'PLAN_GENERATION_SUPERSEDED')
        WHERE run_id = ? AND generation < ? AND status NOT IN ('completed', 'failed', 'cancelled')`)
        .run(timestamp, timestamp, runId, nextGeneration);
      const blocker: RunBlocker = {
        kind: 'documents', code: 'DOC_VERSION_STALE', message: reason, since: timestamp, recoverable: true
      };
      this.db.prepare(`UPDATE runs SET generation = ?, docs_approved = 0, blocker_json = ?, updated_at = ? WHERE id = ?`)
        .run(nextGeneration, JSON.stringify(blocker), timestamp, runId);
      event = this.insertEvent(runId, 'doc.invalidated', { generation: nextGeneration, reason, docRefs });
      return nextGeneration;
    })();
    if (event) this.publishEvent(event);
    const created = this.listPlanGenerations(runId).find((item) => item.generation === generation);
    if (!created) throw new Error('PLAN_GENERATION_NOT_FOUND');
    return created;
  }

  setPlanGenerationDocuments(runId: string, docRefs: TaskSpec['docRefs'], generation?: number): PlanGeneration {
    const run = this.getRun(runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    const target = generation ?? run.generation;
    if (target !== run.generation) throw new Error('PLAN_GENERATION_STALE');
    const result = this.db.prepare(`UPDATE plan_generations SET doc_refs_json = ?
      WHERE run_id = ? AND generation = ? AND status != 'superseded'`)
      .run(JSON.stringify(docRefs), runId, target);
    if (result.changes !== 1) throw new Error('PLAN_GENERATION_NOT_FOUND');
    const updated = this.listPlanGenerations(runId).find((item) => item.generation === target);
    if (!updated) throw new Error('PLAN_GENERATION_NOT_FOUND');
    return updated;
  }

  approvePlanGeneration(runId: string, generation?: number): PlanGeneration {
    const timestamp = now();
    let event: RunEvent | undefined;
    const approvedGeneration = this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error('RUN_NOT_FOUND');
      const target = generation ?? run.generation;
      if (target !== run.generation) throw new Error('PLAN_GENERATION_STALE');
      const result = this.db.prepare(`UPDATE plan_generations SET status = 'approved', approved_at = ?
        WHERE run_id = ? AND generation = ? AND status != 'superseded'`).run(timestamp, runId, target);
      if (result.changes !== 1) throw new Error('PLAN_GENERATION_NOT_FOUND');
      this.db.prepare(`UPDATE runs SET docs_approved = 1,
        blocker_json = CASE WHEN json_extract(blocker_json, '$.kind') = 'documents' THEN NULL ELSE blocker_json END,
        updated_at = ? WHERE id = ?`).run(timestamp, runId);
      event = this.insertEvent(runId, 'run.state', { state: run.state, generation: target, docsApproved: true });
      return target;
    })();
    if (event) this.publishEvent(event);
    const approved = this.listPlanGenerations(runId).find((item) => item.generation === approvedGeneration);
    if (!approved) throw new Error('PLAN_GENERATION_NOT_FOUND');
    return approved;
  }

  private mapPlanGeneration(row: Record<string, unknown>): PlanGeneration {
    return {
      id: String(row.id), runId: String(row.run_id), generation: Number(row.generation),
      status: String(row.status) as PlanGeneration['status'], docRefs: parseJson(row.doc_refs_json, []),
      ...optional<Record<never, never>, 'reason', string>('reason', row.reason as string | null),
      createdAt: String(row.created_at),
      ...optional<Record<never, never>, 'approvedAt', string>('approvedAt', row.approved_at as string | null)
    };
  }

  listTasks(runId: string, generation?: number | 'all'): TaskSpec[] {
    const currentGeneration = generation === undefined ? this.getRun(runId)?.generation : generation;
    const rows = (currentGeneration === 'all'
      ? this.db.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY generation, depth, id').all(runId)
      : this.db.prepare('SELECT * FROM tasks WHERE run_id = ? AND generation = ? ORDER BY depth, id')
        .all(runId, currentGeneration ?? 1)) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), runId: String(row.run_id),
      ...optional<Record<never, never>, 'parentId', string>('parentId', row.parent_id as string | null),
      title: String(row.title), description: String(row.description), status: String(row.status) as TaskSpec['status'],
      generation: Number(row.generation ?? 1),
      depth: Number(row.depth), dependencies: parseJson(row.dependencies_json, []), scope: parseJson(row.scope_json, []),
      docRefs: parseJson(row.doc_refs_json, []), acceptanceCriteria: parseJson(row.acceptance_json, []),
      ...(row.provider_id ? { providerId: String(row.provider_id) as NonNullable<TaskSpec['providerId']> } : {}),
      ...(row.model ? { model: String(row.model) } : {}),
      ...(row.assigned_agent_id ? { assignedAgentId: String(row.assigned_agent_id) } : {})
    }));
  }

  listAllTasks(runId: string): TaskSpec[] {
    return this.listTasks(runId, 'all');
  }

  upsertTask(task: TaskSpec): void {
    const event = this.db.transaction(() => {
      const run = this.getRun(task.runId);
      if (!run) throw new Error('RUN_NOT_FOUND');
      const generation = task.generation ?? run.generation;
      if (generation !== run.generation && task.status !== 'stale') throw new Error('PLAN_GENERATION_STALE');
      const existing = this.db.prepare('SELECT generation FROM tasks WHERE id = ?').get(task.id) as { generation?: number } | undefined;
      if (existing && Number(existing.generation) !== generation) throw new Error('TASK_GENERATION_CONFLICT');
      this.db.prepare(`INSERT INTO tasks(id, run_id, parent_id, title, description, status, depth, dependencies_json,
        scope_json, doc_refs_json, acceptance_json, provider_id, model, assigned_agent_id, generation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, description=excluded.description,
        assigned_agent_id=excluded.assigned_agent_id, provider_id=excluded.provider_id, model=excluded.model`).run(
        task.id, task.runId, task.parentId ?? null, task.title, task.description, task.status, task.depth,
        JSON.stringify(task.dependencies), JSON.stringify(task.scope), JSON.stringify(task.docRefs),
        JSON.stringify(task.acceptanceCriteria), task.providerId ?? null, task.model ?? null, task.assignedAgentId ?? null,
        generation
      );
      return this.insertEvent(task.runId, 'task.state', { taskId: task.id, status: task.status, generation });
    })();
    this.publishEvent(event);
  }

  listAgents(runId: string): Agent[] {
    const rows = this.db.prepare('SELECT * FROM agents WHERE run_id = ? ORDER BY depth, id').all(runId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), runId: String(row.run_id),
      generation: Number(row.generation ?? 1),
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
      const task = this.db.prepare(`SELECT t.status, t.generation, r.generation AS current_generation
        FROM tasks t JOIN runs r ON r.id = t.run_id WHERE t.id = ?`).get(taskId) as
        { status?: string; generation?: number; current_generation?: number } | undefined;
      if (!task || task.status === 'stale' || Number(task.generation) !== Number(task.current_generation)) return false;
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
      WHERE task_id = ? AND agent_id = ? AND EXISTS (
        SELECT 1 FROM tasks t JOIN runs r ON r.id = t.run_id
        WHERE t.id = task_leases.task_id AND t.generation = r.generation AND t.status != 'stale'
      )`).run(timestamp + ttlMs, timestamp, taskId, agentId);
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
      const run = this.getRun(agent.runId);
      const generation = agent.generation ?? run?.generation ?? 1;
      this.db.prepare(`INSERT INTO agents(id, run_id, parent_id, name, role, status, depth, provider_id, model, task_id, context_usage, lineage, generation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, context_usage=excluded.context_usage, lineage=excluded.lineage`).run(
        agent.id, agent.runId, agent.parentId ?? null, agent.name, agent.role, agent.status, agent.depth,
        agent.providerId, agent.model, agent.taskId ?? null, agent.contextUsage, agent.lineage, generation
      );
      return this.insertEvent(agent.runId, 'agent.state', { agentId: agent.id, status: agent.status, contextUsage: agent.contextUsage });
    })();
    this.publishEvent(event);
  }

  listApprovals(runId: string): ApprovalRequest[] {
    const rows = this.db.prepare('SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at DESC').all(runId) as Record<string, unknown>[];
    return rows.map((row) => this.mapApproval(row));
  }

  getApproval(id: string): ApprovalRequest | undefined {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapApproval(row) : undefined;
  }

  private mapApproval(row: Record<string, unknown>): ApprovalRequest {
    return {
      id: String(row.id), runId: String(row.run_id),
      ...optional<Record<never, never>, 'taskId', string>('taskId', row.task_id as string | null),
      tool: String(row.tool), ruleKey: String(row.rule_key), risk: String(row.risk) as ApprovalRequest['risk'],
      reusable: Number(row.reusable) === 1,
      capability: String(row.capability || 'tool.execute'), resource: String(row.resource || `run:${String(row.run_id)}`),
      scope: String(row.scope || 'once') as ApprovalScope, summary: String(row.summary),
      policyReason: String(row.policy_reason), status: String(row.status) as ApprovalRequest['status'],
      createdAt: String(row.created_at),
      ...optional<Record<never, never>, 'resolvedAt', string>('resolvedAt', row.resolved_at as string | null),
      ...optional<Record<never, never>, 'consumedAt', string>('consumedAt', row.consumed_at as string | null),
      ...optional<Record<never, never>, 'actionAttemptId', string>('actionAttemptId', row.action_attempt_id as string | null)
    };
  }

  createApproval(input: CreateApprovalInput): ApprovalRequest {
    const reusable = Boolean(input.reusable) && !mustBeSingleUse(input);
    const approval: ApprovalRequest = {
      id: randomUUID(), runId: input.runId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.actionAttemptId ? { actionAttemptId: input.actionAttemptId } : {}),
      tool: input.tool, ruleKey: input.ruleKey, risk: input.risk, reusable,
      capability: input.capability ?? `workspace.tool.${input.tool}`,
      resource: input.resource ?? `run:${input.runId}`,
      scope: reusable ? (input.scope ?? 'once') : 'once',
      summary: input.summary, policyReason: input.policyReason,
      status: 'pending', createdAt: now()
    };
    const event = this.db.transaction(() => {
      if (approval.actionAttemptId) {
        const attempt = this.getActionAttempt(approval.actionAttemptId);
        const run = this.getRun(approval.runId);
        if (
          !attempt || !run || attempt.runId !== approval.runId || attempt.generation !== run.generation ||
          !['pending', 'executing', 'waiting_approval'].includes(attempt.status) ||
          (approval.taskId !== undefined && approval.taskId !== attempt.taskId)
        ) {
          throw new Error('APPROVAL_STALE: 绑定动作已结束或不属于当前 generation');
        }
      }
      this.db.prepare(`INSERT INTO approvals(id, run_id, task_id, tool, rule_key, risk, reusable, capability,
        resource, scope, summary, policy_reason, status, action_attempt_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        approval.id, approval.runId, approval.taskId ?? null, approval.tool, approval.ruleKey, approval.risk,
        approval.reusable ? 1 : 0, approval.capability, approval.resource, approval.scope,
        approval.summary, approval.policyReason, approval.status, approval.actionAttemptId ?? null, approval.createdAt
      );
      if (approval.actionAttemptId) {
        this.db.prepare(`UPDATE action_attempts SET status = 'waiting_approval', approval_id = ?, updated_at = ?
          WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`)
          .run(approval.id, approval.createdAt, approval.actionAttemptId);
      }
      const blocker: RunBlocker = {
        kind: 'approval', code: 'APPROVAL_REQUIRED', message: approval.policyReason,
        since: approval.createdAt, recoverable: true, approvalId: approval.id,
        details: { capability: approval.capability, resource: approval.resource }
      };
      this.db.prepare('UPDATE runs SET blocker_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(blocker), approval.createdAt, approval.runId);
      return this.insertEvent(approval.runId, 'approval.requested', approval);
    })();
    this.publishEvent(event);
    return approval;
  }

  resolveApproval(id: string, status: 'approved' | 'rejected', scope: ApprovalScope = 'once'): ApprovalRequest {
    let event: RunEvent | undefined;
    const resolved = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!row) throw new Error('APPROVAL_NOT_FOUND');
      const approval = this.mapApproval(row);
      if (approval.status !== 'pending') {
        if (approval.status !== status) throw new Error('APPROVAL_ALREADY_RESOLVED');
        return approval;
      }
      if (scope === 'rule' && (!approval.reusable || mustBeSingleUse(approval))) {
        throw new Error('APPROVAL_NOT_REUSABLE: 此能力必须逐次审批');
      }
      if (status === 'approved' && approval.actionAttemptId) {
        const attempt = this.getActionAttempt(approval.actionAttemptId);
        const run = this.getRun(approval.runId);
        if (
          !attempt || !run || attempt.runId !== approval.runId || attempt.generation !== run.generation ||
          attempt.status !== 'waiting_approval' || attempt.approvalId !== approval.id
        ) {
          throw new Error('APPROVAL_STALE: 绑定动作已结束或不属于当前 generation');
        }
      }
      const timestamp = now();
      const result = this.db.prepare(`UPDATE approvals SET status = ?, scope = ?, resolved_at = ?
        WHERE id = ? AND status = 'pending'`).run(status, scope, timestamp, id);
      if (result.changes !== 1) throw new Error('APPROVAL_ALREADY_RESOLVED');
      if (status === 'approved' && scope === 'rule' && approval.ruleKey !== 'legacy') {
        this.db.prepare(`INSERT INTO approval_rules(run_id, rule_key, capability, resource, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(run_id, rule_key) DO UPDATE SET capability=excluded.capability,
          resource=excluded.resource, created_at=excluded.created_at`)
          .run(approval.runId, approval.ruleKey, approval.capability, approval.resource, timestamp);
      }
      if (approval.actionAttemptId) {
        this.db.prepare(`UPDATE action_attempts SET status = ?, updated_at = ?, error = ?,
          completed_at = CASE WHEN ? = 'rejected' THEN ? ELSE completed_at END
          WHERE id = ? AND status = 'waiting_approval'`).run(
          status === 'approved' ? 'pending' : 'failed', timestamp,
          status === 'approved' ? null : 'APPROVAL_REJECTED', status, timestamp, approval.actionAttemptId
        );
      }
      const nextPending = this.db.prepare(`SELECT id, policy_reason, capability, resource, created_at
        FROM approvals WHERE run_id = ? AND status = 'pending' ORDER BY created_at LIMIT 1`)
        .get(approval.runId) as Record<string, unknown> | undefined;
      const nextBlocker: RunBlocker | undefined = nextPending ? {
        kind: 'approval', code: 'APPROVAL_REQUIRED', message: String(nextPending.policy_reason),
        since: String(nextPending.created_at), recoverable: true, approvalId: String(nextPending.id),
        details: { capability: String(nextPending.capability), resource: String(nextPending.resource) }
      } : undefined;
      this.db.prepare('UPDATE runs SET blocker_json = ?, updated_at = ? WHERE id = ?')
        .run(nextBlocker ? JSON.stringify(nextBlocker) : null, timestamp, approval.runId);
      const finalApproval = { ...approval, status, scope, resolvedAt: timestamp } as ApprovalRequest;
      event = this.insertEvent(approval.runId, 'approval.resolved', finalApproval);
      return finalApproval;
    })();
    if (event) this.publishEvent(event);
    return resolved;
  }

  consumeApprovedTool(runId: string, tool: string, summary: string): boolean;
  consumeApprovedTool(runId: string, taskId: string, tool: string, summary: string): boolean;
  consumeApprovedTool(runId: string, taskId: string, tool: string, ruleKey: string, summary: string,
    capability?: string, resource?: string): boolean;
  consumeApprovedTool(
    runId: string,
    taskIdOrTool: string,
    toolOrSummary: string,
    ruleKeyOrSummary?: string,
    providedSummary?: string,
    providedCapability?: string,
    providedResource?: string
  ): boolean {
    let taskId: string | undefined;
    let tool: string;
    let ruleKey: string;
    let summary: string;
    if (providedSummary !== undefined) {
      taskId = taskIdOrTool;
      tool = toolOrSummary;
      ruleKey = ruleKeyOrSummary ?? 'legacy';
      summary = providedSummary;
    } else if (ruleKeyOrSummary !== undefined) {
      taskId = taskIdOrTool;
      tool = toolOrSummary;
      ruleKey = 'legacy';
      summary = ruleKeyOrSummary;
    } else {
      tool = taskIdOrTool;
      summary = toolOrSummary;
      ruleKey = 'legacy';
    }
    const capability = providedCapability ?? `workspace.tool.${tool}`;
    const resource = providedResource ?? `run:${runId}`;
    return this.db.transaction(() => this.consumeApprovedToolRecord({
      runId, ...(taskId ? { taskId } : {}), tool, ruleKey, summary, capability, resource
    }))();
  }

  consumeApprovedRunCapability(input: {
    runId: string;
    tool: string;
    ruleKey: string;
    summary: string;
    capability: string;
    resource: string;
  }): boolean {
    return this.db.transaction(() => this.consumeApprovedToolRecord(input))();
  }

  claimActionAttemptWithApproval(
    attemptId: string,
    input: { tool: string; ruleKey: string; summary: string; capability?: string; resource?: string }
  ): { granted: boolean; claimed: boolean; attempt: ActionAttempt } {
    return this.db.transaction(() => {
      const attempt = this.getActionAttempt(attemptId);
      if (!attempt) throw new Error('ACTION_ATTEMPT_NOT_FOUND');
      const run = this.getRun(attempt.runId);
      if (!run || run.generation !== attempt.generation) throw new Error('PLAN_GENERATION_STALE');
      if (attempt.action.type !== 'call_tool' || attempt.action.tool !== input.tool) {
        throw new Error('ACTION_ATTEMPT_TOOL_CONFLICT');
      }
      if (attempt.status === 'executing') return { granted: true, claimed: true, attempt };
      if (attempt.status !== 'pending') {
        if (['completed', 'failed', 'cancelled'].includes(attempt.status)) throw new Error('ACTION_ATTEMPT_STATE_CONFLICT');
        return { granted: false, claimed: false, attempt };
      }
      const capability = input.capability ?? `workspace.tool.${input.tool}`;
      const resource = input.resource ?? `run:${attempt.runId}`;
      const granted = this.consumeApprovedToolRecord({
        runId: attempt.runId,
        ...(attempt.taskId ? { taskId: attempt.taskId } : {}),
        tool: input.tool,
        ruleKey: input.ruleKey,
        summary: input.summary,
        capability,
        resource,
        ...(attempt.approvalId ? { preferredApprovalId: attempt.approvalId } : {})
      });
      if (!granted) return { granted: false, claimed: false, attempt };
      const timestamp = now();
      const claimed = this.db.prepare(`UPDATE action_attempts SET status = 'executing',
        started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND status = 'pending' AND generation = ?`).run(
        timestamp, timestamp, attempt.id, run.generation
      );
      if (claimed.changes !== 1) throw new Error('ACTION_ATTEMPT_STATE_CONFLICT');
      const updated = this.getActionAttempt(attempt.id);
      if (!updated) throw new Error('ACTION_ATTEMPT_NOT_FOUND');
      return { granted: true, claimed: true, attempt: updated };
    })();
  }

  private consumeApprovedToolRecord(input: {
    runId: string;
    taskId?: string;
    tool: string;
    ruleKey: string;
    summary: string;
    capability: string;
    resource: string;
    preferredApprovalId?: string;
  }): boolean {
    if (!mustBeSingleUse({ tool: input.tool, ruleKey: input.ruleKey, risk: 'low' })) {
      const reusable = this.db.prepare(`SELECT 1 FROM approval_rules
        WHERE run_id = ? AND rule_key = ? AND capability = ? AND resource IN (?, '')`)
        .get(input.runId, input.ruleKey, input.capability, input.resource);
      if (reusable) return true;
    }
    if (input.preferredApprovalId) {
      const preferred = this.db.prepare(`SELECT id, consumed_at FROM approvals
        WHERE id = ? AND run_id = ? AND task_id IS ? AND tool = ? AND rule_key = ?
          AND summary = ? AND capability = ? AND resource = ? AND status = 'approved'`).get(
        input.preferredApprovalId, input.runId, input.taskId ?? null, input.tool, input.ruleKey,
        input.summary, input.capability, input.resource
      ) as { id?: string; consumed_at?: string | null } | undefined;
      if (preferred?.id) {
        if (preferred.consumed_at) return true;
        const consumed = this.db.prepare(`UPDATE approvals SET consumed_at = ?
          WHERE id = ? AND status = 'approved' AND consumed_at IS NULL`).run(now(), preferred.id);
        return consumed.changes === 1;
      }
    }
    const row = this.db.prepare(`SELECT id FROM approvals
      WHERE run_id = ? AND (? IS NULL OR task_id = ?) AND tool = ?
        AND (? = 'legacy' OR rule_key = ?) AND summary = ? AND capability = ? AND resource IN (?, '')
        AND status = 'approved' AND consumed_at IS NULL
      ORDER BY resolved_at LIMIT 1`).get(
      input.runId, input.taskId ?? null, input.taskId ?? null, input.tool,
      input.ruleKey, input.ruleKey, input.summary, input.capability, input.resource
    ) as { id?: string } | undefined;
    if (!row?.id) return false;
    const consumed = this.db.prepare(`UPDATE approvals SET consumed_at = ?
      WHERE id = ? AND status = 'approved' AND consumed_at IS NULL`).run(now(), row.id);
    return consumed.changes === 1;
  }

  private insertEvent<T>(runId: string, type: RunEvent<T>['type'], payload: T): RunEvent<T> {
    const createdAt = now();
    const revision = this.db.prepare(`UPDATE runs SET snapshot_version = snapshot_version + 1 WHERE id = ?`).run(runId);
    if (revision.changes !== 1) throw new Error('RUN_NOT_FOUND');
    const versionRow = this.db.prepare('SELECT snapshot_version FROM runs WHERE id = ?').get(runId) as { snapshot_version?: number };
    const snapshotVersion = Number(versionRow.snapshot_version ?? 0);
    const result = this.db.prepare(`INSERT INTO events(run_id, type, payload_json, schema_version,
      entity_revision, snapshot_version, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)`)
      .run(runId, type, JSON.stringify(payload), snapshotVersion, snapshotVersion, createdAt);
    return {
      id: Number(result.lastInsertRowid), runId, type, payload,
      schemaVersion: 1, entityRevision: snapshotVersion, snapshotVersion, createdAt
    };
  }

  private publishEvent<T>(event: RunEvent<T>): void {
    this.events.emit(`run:${event.runId}`, event);
  }

  appendEvent<T>(runId: string, type: RunEvent<T>['type'], payload: T): RunEvent<T> {
    const event = this.db.transaction(() => this.insertEvent(runId, type, payload))();
    this.publishEvent(event);
    return event;
  }

  listEvents(runId: string, after = 0, limit = 1000, through = Number.MAX_SAFE_INTEGER): RunEvent[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 10_000));
    const rows = this.db.prepare('SELECT * FROM events WHERE run_id = ? AND id > ? AND id <= ? ORDER BY id LIMIT ?')
      .all(runId, after, through, safeLimit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id), runId: String(row.run_id), type: String(row.type) as RunEvent['type'],
      payload: parseJson(row.payload_json, {}), schemaVersion: 1,
      entityRevision: Number(row.entity_revision ?? row.id), snapshotVersion: Number(row.snapshot_version ?? 0),
      createdAt: String(row.created_at)
    }));
  }

  listRecentEvents(runId: string, limit = 200): RunEvent[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 1000));
    const rows = this.db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT ?')
      .all(runId, safeLimit) as Record<string, unknown>[];
    return rows.reverse().map((row) => ({
      id: Number(row.id), runId: String(row.run_id), type: String(row.type) as RunEvent['type'],
      payload: parseJson(row.payload_json, {}), schemaVersion: 1,
      entityRevision: Number(row.entity_revision ?? row.id), snapshotVersion: Number(row.snapshot_version ?? 0),
      createdAt: String(row.created_at)
    }));
  }

  getEventWatermark(runId: string): number {
    const row = this.db.prepare('SELECT MAX(id) AS watermark FROM events WHERE run_id = ?').get(runId) as { watermark?: number | null };
    return Number(row.watermark ?? 0);
  }

  getSnapshotVersion(runId: string): number {
    const row = this.db.prepare('SELECT snapshot_version FROM runs WHERE id = ?').get(runId) as
      { snapshot_version?: number } | undefined;
    if (!row) throw new Error('RUN_NOT_FOUND');
    return Number(row.snapshot_version ?? 0);
  }

  getSnapshotWatermark(runId: string): Pick<SnapshotEnvelope<never>, 'schemaVersion' | 'snapshotVersion' | 'eventWatermark'> {
    return this.db.transaction(() => ({
      schemaVersion: 2 as const,
      snapshotVersion: this.getSnapshotVersion(runId),
      eventWatermark: this.getEventWatermark(runId)
    }))();
  }

  readSnapshot<T>(runId: string, reader: () => T): SnapshotEnvelope<T> {
    return this.db.transaction(() => ({
      schemaVersion: 2 as const,
      snapshotVersion: this.getSnapshotVersion(runId),
      eventWatermark: this.getEventWatermark(runId),
      data: reader()
    }))();
  }

  upsertCheckpoint(checkpoint: Checkpoint): void {
    const run = this.getRun(checkpoint.runId);
    const generation = checkpoint.generation ?? run?.generation ?? 1;
    this.db.prepare(`INSERT INTO checkpoints(id, run_id, agent_id, lineage, doc_refs_json, task_ids_json,
      event_watermark, decisions_json, unresolved_json, next_action, generation, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET doc_refs_json=excluded.doc_refs_json, task_ids_json=excluded.task_ids_json,
      event_watermark=excluded.event_watermark, decisions_json=excluded.decisions_json,
      unresolved_json=excluded.unresolved_json, next_action=excluded.next_action`).run(
      checkpoint.id, checkpoint.runId, checkpoint.agentId, checkpoint.lineage,
      JSON.stringify(checkpoint.docRefs), JSON.stringify(checkpoint.taskIds), checkpoint.eventWatermark,
      JSON.stringify(checkpoint.decisions), JSON.stringify(checkpoint.unresolved), checkpoint.nextAction, generation,
      checkpoint.createdAt
    );
  }

  listCheckpoints(runId: string): Checkpoint[] {
    const rows = this.db.prepare('SELECT * FROM checkpoints WHERE run_id = ? ORDER BY created_at').all(runId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), runId: String(row.run_id), agentId: String(row.agent_id), lineage: Number(row.lineage),
      generation: Number(row.generation ?? 1),
      docRefs: parseJson(row.doc_refs_json, []), taskIds: parseJson(row.task_ids_json, []),
      eventWatermark: Number(row.event_watermark), decisions: parseJson(row.decisions_json, []),
      unresolved: parseJson(row.unresolved_json, []), nextAction: String(row.next_action), createdAt: String(row.created_at)
    }));
  }

  createActionAttempt(input: {
    runId: string;
    taskId?: string;
    agentId?: string;
    generation?: number;
    sequence: number;
    action: AgentAction;
  }): ActionAttempt {
    return this.db.transaction(() => {
      const run = this.getRun(input.runId);
      if (!run) throw new Error('RUN_NOT_FOUND');
      const generation = input.generation ?? run.generation;
      if (generation !== run.generation) throw new Error('PLAN_GENERATION_STALE');
      const action = agentActionSchema.parse(input.action);
      const existingRow = this.db.prepare(`SELECT * FROM action_attempts
        WHERE run_id = ? AND generation = ? AND task_id IS ? AND sequence = ?`)
        .get(input.runId, generation, input.taskId ?? null, input.sequence) as Record<string, unknown> | undefined;
      if (existingRow) {
        const existing = this.mapActionAttempt(existingRow);
        if (JSON.stringify(existing.action) !== JSON.stringify(action)) throw new Error('ACTION_SEQUENCE_CONFLICT');
        return existing;
      }
      const timestamp = now();
      const attempt: ActionAttempt = {
        id: randomUUID(), runId: input.runId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        generation, sequence: input.sequence, action, status: 'pending',
        idempotencyKey: `action:${randomUUID()}`, createdAt: timestamp, updatedAt: timestamp
      };
      this.db.prepare(`INSERT INTO action_attempts(id, run_id, task_id, agent_id, generation, sequence,
        action_type, action_json, status, idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(
        attempt.id, attempt.runId, attempt.taskId ?? null, attempt.agentId ?? null, attempt.generation,
        attempt.sequence, attempt.action.type, JSON.stringify(attempt.action), attempt.idempotencyKey,
        attempt.createdAt, attempt.updatedAt
      );
      return attempt;
    })();
  }

  getActionAttempt(id: string): ActionAttempt | undefined {
    const row = this.db.prepare('SELECT * FROM action_attempts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapActionAttempt(row) : undefined;
  }

  listActionAttempts(runId: string, taskId?: string, generation?: number | 'all'): ActionAttempt[] {
    const currentGeneration = generation === undefined ? this.getRun(runId)?.generation : generation;
    const rows = (currentGeneration === 'all'
      ? this.db.prepare(`SELECT * FROM action_attempts WHERE run_id = ? AND (? IS NULL OR task_id = ?)
          ORDER BY generation, sequence`).all(runId, taskId ?? null, taskId ?? null)
      : this.db.prepare(`SELECT * FROM action_attempts WHERE run_id = ? AND generation = ?
          AND (? IS NULL OR task_id = ?) ORDER BY sequence`)
        .all(runId, currentGeneration ?? 1, taskId ?? null, taskId ?? null)) as Record<string, unknown>[];
    return rows.map((row) => this.mapActionAttempt(row));
  }

  listRecoverableActionAttempts(runId: string): ActionAttempt[] {
    const generation = this.getRun(runId)?.generation;
    if (generation === undefined) throw new Error('RUN_NOT_FOUND');
    const rows = this.db.prepare(`SELECT * FROM action_attempts WHERE run_id = ? AND generation = ?
      AND status IN ('pending', 'waiting_approval', 'executing') ORDER BY sequence`).all(runId, generation) as Record<string, unknown>[];
    return rows.map((row) => this.mapActionAttempt(row));
  }

  claimActionAttempt(id: string): ActionAttempt {
    return this.db.transaction(() => {
      const attempt = this.getActionAttempt(id);
      if (!attempt) throw new Error('ACTION_ATTEMPT_NOT_FOUND');
      const run = this.getRun(attempt.runId);
      if (!run || run.generation !== attempt.generation) throw new Error('PLAN_GENERATION_STALE');
      if (attempt.status === 'waiting_approval') throw new Error('ACTION_WAITING_APPROVAL');
      if (['completed', 'failed', 'cancelled'].includes(attempt.status)) return attempt;
      if (attempt.status === 'pending') {
        const timestamp = now();
        const result = this.db.prepare(`UPDATE action_attempts SET status = 'executing', started_at = COALESCE(started_at, ?),
          updated_at = ? WHERE id = ? AND status = 'pending'`).run(timestamp, timestamp, id);
        if (result.changes !== 1) throw new Error('ACTION_ATTEMPT_STATE_CONFLICT');
      }
      const claimed = this.getActionAttempt(id);
      if (!claimed) throw new Error('ACTION_ATTEMPT_NOT_FOUND');
      return claimed;
    })();
  }

  setActionAttemptApproval(id: string, approvalId: string): ActionAttempt {
    const current = this.getActionAttempt(id);
    if (!current) throw new Error('ACTION_ATTEMPT_NOT_FOUND');
    if (current.status === 'waiting_approval' && current.approvalId === approvalId) return current;
    const timestamp = now();
    const result = this.db.prepare(`UPDATE action_attempts SET status = 'waiting_approval', approval_id = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'executing')`).run(approvalId, timestamp, id);
    if (result.changes !== 1) throw new Error('ACTION_ATTEMPT_STATE_CONFLICT');
    const attempt = this.getActionAttempt(id);
    if (!attempt) throw new Error('ACTION_ATTEMPT_NOT_FOUND');
    return attempt;
  }

  resumeActionAttemptAfterApproval(id: string): ActionAttempt {
    return this.db.transaction(() => {
      const attempt = this.getActionAttempt(id);
      if (!attempt) throw new Error('ACTION_ATTEMPT_NOT_FOUND');
      if (attempt.status !== 'waiting_approval') return attempt;
      if (!attempt.approvalId) throw new Error('APPROVAL_NOT_FOUND');
      const approval = this.getApproval(attempt.approvalId);
      if (!approval) throw new Error('APPROVAL_NOT_FOUND');
      if (approval.status === 'pending') throw new Error('ACTION_WAITING_APPROVAL');
      if (approval.status === 'rejected') {
        this.failActionAttempt(id, 'APPROVAL_REJECTED');
        throw new Error('APPROVAL_REJECTED');
      }
      const timestamp = now();
      const result = this.db.prepare(`UPDATE action_attempts SET status = 'pending', updated_at = ?
        WHERE id = ? AND status = 'waiting_approval'`).run(timestamp, id);
      if (result.changes !== 1) throw new Error('ACTION_ATTEMPT_STATE_CONFLICT');
      const resumed = this.getActionAttempt(id);
      if (!resumed) throw new Error('ACTION_ATTEMPT_NOT_FOUND');
      return resumed;
    })();
  }

  completeActionAttempt(id: string, toolOutputId?: string): ActionAttempt {
    return this.db.transaction(() => {
      const current = this.getActionAttempt(id);
      if (!current) throw new Error('ACTION_ATTEMPT_NOT_FOUND');
      if (current.status === 'completed') return current;
      if (['failed', 'cancelled'].includes(current.status)) throw new Error('ACTION_ATTEMPT_STATE_CONFLICT');
      const timestamp = now();
      this.db.prepare(`UPDATE action_attempts SET status = 'completed', tool_output_id = COALESCE(?, tool_output_id),
        updated_at = ?, completed_at = ? WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`)
        .run(toolOutputId ?? null, timestamp, timestamp, id);
      const completed = this.getActionAttempt(id);
      if (!completed) throw new Error('ACTION_ATTEMPT_NOT_FOUND');
      return completed;
    })();
  }

  failActionAttempt(id: string, error: string): ActionAttempt {
    return this.db.transaction(() => {
      const current = this.getActionAttempt(id);
      if (!current) throw new Error('ACTION_ATTEMPT_NOT_FOUND');
      if (current.status === 'failed') return current;
      if (current.status === 'completed') throw new Error('ACTION_ATTEMPT_STATE_CONFLICT');
      const timestamp = now();
      this.db.prepare(`UPDATE action_attempts SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND status != 'completed'`).run(error, timestamp, timestamp, id);
      const failed = this.getActionAttempt(id);
      if (!failed) throw new Error('ACTION_ATTEMPT_NOT_FOUND');
      return failed;
    })();
  }

  private mapActionAttempt(row: Record<string, unknown>): ActionAttempt {
    return {
      id: String(row.id), runId: String(row.run_id),
      ...optional<Record<never, never>, 'taskId', string>('taskId', row.task_id as string | null),
      ...optional<Record<never, never>, 'agentId', string>('agentId', row.agent_id as string | null),
      generation: Number(row.generation), sequence: Number(row.sequence),
      action: agentActionSchema.parse(parseJson(row.action_json, {})),
      status: String(row.status) as ActionAttempt['status'], idempotencyKey: String(row.idempotency_key),
      ...optional<Record<never, never>, 'approvalId', string>('approvalId', row.approval_id as string | null),
      ...optional<Record<never, never>, 'toolOutputId', string>('toolOutputId', row.tool_output_id as string | null),
      ...optional<Record<never, never>, 'error', string>('error', row.error as string | null),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      ...optional<Record<never, never>, 'startedAt', string>('startedAt', row.started_at as string | null),
      ...optional<Record<never, never>, 'completedAt', string>('completedAt', row.completed_at as string | null)
    };
  }

  upsertTaskResult(input: Omit<TaskResult, 'id' | 'createdAt' | 'verifiedAt' | 'generation'> & {
    id?: string;
    generation?: number;
    createdAt?: string;
    verifiedAt?: string;
  }): TaskResult {
    let event: RunEvent | undefined;
    const result = this.db.transaction(() => {
      const run = this.getRun(input.runId);
      if (!run) throw new Error('RUN_NOT_FOUND');
      const generation = input.generation ?? run.generation;
      if (generation !== run.generation) throw new Error('PLAN_GENERATION_STALE');
      const task = this.db.prepare('SELECT run_id, generation, status FROM tasks WHERE id = ?').get(input.taskId) as
        { run_id?: string; generation?: number; status?: string } | undefined;
      if (!task) throw new Error('TASK_NOT_FOUND');
      if (task.run_id !== input.runId) throw new Error('TASK_RUN_CONFLICT');
      if (Number(task.generation) !== generation || task.status === 'stale') throw new Error('PLAN_GENERATION_STALE');
      const existing = this.db.prepare(`SELECT id, run_id, created_at FROM task_results
        WHERE task_id = ? AND generation = ?`).get(input.taskId, generation) as
        { id?: string; run_id?: string; created_at?: string } | undefined;
      if (existing?.run_id && existing.run_id !== input.runId) throw new Error('TASK_RESULT_OWNERSHIP_CONFLICT');
      if (existing?.id && input.id && existing.id !== input.id) throw new Error('TASK_RESULT_ID_CONFLICT');
      const createdAt = input.createdAt ?? existing?.created_at ?? now();
      const verifiedAt = input.verified ? (input.verifiedAt ?? now()) : undefined;
      const taskResult = taskResultSchema.parse({
        id: input.id ?? existing?.id ?? randomUUID(), runId: input.runId, taskId: input.taskId, generation,
        summary: input.summary, evidence: input.evidence, verificationCommands: input.verificationCommands,
        verified: input.verified, ...(input.commitSha ? { commitSha: input.commitSha } : {}),
        risks: input.risks, unresolved: input.unresolved, createdAt,
        ...(verifiedAt ? { verifiedAt } : {})
      });
      const write = this.db.prepare(`INSERT INTO task_results(id, run_id, task_id, generation, summary, evidence_json,
        verification_commands_json, verified, commit_sha, risks_json, unresolved_json, created_at, verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, generation) DO UPDATE SET summary=excluded.summary, evidence_json=excluded.evidence_json,
        verification_commands_json=excluded.verification_commands_json, verified=excluded.verified,
        commit_sha=excluded.commit_sha, risks_json=excluded.risks_json, unresolved_json=excluded.unresolved_json,
        verified_at=excluded.verified_at
        WHERE task_results.run_id = excluded.run_id`).run(
        taskResult.id, taskResult.runId, taskResult.taskId, taskResult.generation, taskResult.summary,
        JSON.stringify(taskResult.evidence), JSON.stringify(taskResult.verificationCommands), taskResult.verified ? 1 : 0,
        taskResult.commitSha ?? null, JSON.stringify(taskResult.risks), JSON.stringify(taskResult.unresolved),
        taskResult.createdAt, taskResult.verifiedAt ?? null
      );
      if (write.changes !== 1) throw new Error('TASK_RESULT_OWNERSHIP_CONFLICT');
      event = this.insertEvent(taskResult.runId, 'task.result', {
        taskId: taskResult.taskId, generation, resultId: taskResult.id, verified: taskResult.verified
      });
      return taskResult;
    })();
    if (event) this.publishEvent(event);
    return result;
  }

  getTaskResult(taskId: string, generation?: number): TaskResult | undefined {
    const row = (generation === undefined
      ? this.db.prepare('SELECT * FROM task_results WHERE task_id = ? ORDER BY generation DESC LIMIT 1').get(taskId)
      : this.db.prepare('SELECT * FROM task_results WHERE task_id = ? AND generation = ?').get(taskId, generation)) as
      Record<string, unknown> | undefined;
    return row ? this.mapTaskResult(row) : undefined;
  }

  listTaskResults(runId: string, generation?: number | 'all'): TaskResult[] {
    const currentGeneration = generation === undefined ? this.getRun(runId)?.generation : generation;
    const rows = (currentGeneration === 'all'
      ? this.db.prepare('SELECT * FROM task_results WHERE run_id = ? ORDER BY generation, created_at').all(runId)
      : this.db.prepare('SELECT * FROM task_results WHERE run_id = ? AND generation = ? ORDER BY created_at')
        .all(runId, currentGeneration ?? 1)) as Record<string, unknown>[];
    return rows.map((row) => this.mapTaskResult(row));
  }

  listIntegrableTaskResults(runId: string): TaskResult[] {
    const generation = this.getRun(runId)?.generation;
    if (generation === undefined) throw new Error('RUN_NOT_FOUND');
    const rows = this.db.prepare(`SELECT tr.* FROM task_results tr
      JOIN tasks t ON t.id = tr.task_id AND t.run_id = tr.run_id AND t.generation = tr.generation
      WHERE tr.run_id = ? AND tr.generation = ? AND tr.verified = 1 AND tr.commit_sha IS NOT NULL
        AND t.status = 'completed' ORDER BY tr.created_at`).all(runId, generation) as Record<string, unknown>[];
    return rows.map((row) => this.mapTaskResult(row));
  }

  private mapTaskResult(row: Record<string, unknown>): TaskResult {
    return {
      id: String(row.id), runId: String(row.run_id), taskId: String(row.task_id), generation: Number(row.generation),
      summary: String(row.summary), evidence: parseJson(row.evidence_json, []),
      verificationCommands: parseJson(row.verification_commands_json, []), verified: Number(row.verified) === 1,
      ...optional<Record<never, never>, 'commitSha', string>('commitSha', row.commit_sha as string | null),
      risks: parseJson(row.risks_json, []), unresolved: parseJson(row.unresolved_json, []),
      createdAt: String(row.created_at),
      ...optional<Record<never, never>, 'verifiedAt', string>('verifiedAt', row.verified_at as string | null)
    };
  }

  createToolOutput(input: {
    runId: string;
    taskId?: string;
    actionAttemptId?: string;
    generation?: number;
    tool: string;
    content: string;
    truncated?: boolean;
    byteLength?: number;
  }): ToolOutput {
    let event: RunEvent | undefined;
    const output = this.db.transaction(() => {
      const run = this.getRun(input.runId);
      if (!run) throw new Error('RUN_NOT_FOUND');
      let generation = input.generation ?? run.generation;
      let taskId = input.taskId;
      let attempt: ActionAttempt | undefined;
      if (input.actionAttemptId) {
        attempt = this.getActionAttempt(input.actionAttemptId);
        if (!attempt) throw new Error('ACTION_ATTEMPT_NOT_FOUND');
        if (attempt.runId !== input.runId) throw new Error('ACTION_ATTEMPT_OWNERSHIP_CONFLICT');
        if (attempt.action.type !== 'call_tool' || attempt.action.tool !== input.tool) {
          throw new Error('ACTION_ATTEMPT_TOOL_CONFLICT');
        }
        if (input.taskId !== undefined && input.taskId !== attempt.taskId) {
          throw new Error('ACTION_ATTEMPT_OWNERSHIP_CONFLICT');
        }
        if (input.generation !== undefined && input.generation !== attempt.generation) {
          throw new Error('ACTION_ATTEMPT_OWNERSHIP_CONFLICT');
        }
        taskId = attempt.taskId;
        generation = attempt.generation;
      }
      if (generation !== run.generation) throw new Error('PLAN_GENERATION_STALE');
      if (taskId) {
        const task = this.db.prepare('SELECT run_id, generation, status FROM tasks WHERE id = ?').get(taskId) as
          { run_id?: string; generation?: number; status?: string } | undefined;
        if (!task) throw new Error('TASK_NOT_FOUND');
        if (task.run_id !== input.runId) throw new Error('TASK_RUN_CONFLICT');
        if (Number(task.generation) !== generation || task.status === 'stale') throw new Error('PLAN_GENERATION_STALE');
      }
      const truncated = input.truncated ?? false;
      const byteLength = input.byteLength ?? Buffer.byteLength(input.content, 'utf8');
      if (attempt) {
        const existingRow = this.db.prepare('SELECT * FROM tool_outputs WHERE action_attempt_id = ?')
          .get(attempt.id) as Record<string, unknown> | undefined;
        if (existingRow) {
          const existing = this.mapToolOutput(existingRow);
          if (
            existing.runId !== input.runId || existing.taskId !== taskId || existing.generation !== generation ||
            existing.tool !== input.tool || existing.content !== input.content ||
            existing.truncated !== truncated || existing.byteLength !== byteLength
          ) {
            throw new Error('TOOL_OUTPUT_CONFLICT');
          }
          if (attempt.toolOutputId !== existing.id) {
            this.db.prepare(`UPDATE action_attempts SET tool_output_id = ?, updated_at = ?
              WHERE id = ? AND generation = ?`).run(existing.id, now(), attempt.id, generation);
          }
          return existing;
        }
        if (attempt.status !== 'executing') throw new Error('ACTION_ATTEMPT_STATE_CONFLICT');
      }
      const created = toolOutputSchema.parse({
        id: attempt ? `tool-output:${attempt.id}` : randomUUID(), runId: input.runId,
        ...(taskId ? { taskId } : {}),
        ...(input.actionAttemptId ? { actionAttemptId: input.actionAttemptId } : {}),
        generation, tool: input.tool, content: input.content, truncated, byteLength, createdAt: now()
      });
      this.db.prepare(`INSERT INTO tool_outputs(id, run_id, task_id, action_attempt_id, generation,
        tool, content, truncated, byte_length, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        created.id, created.runId, created.taskId ?? null, created.actionAttemptId ?? null, created.generation,
        created.tool, created.content, created.truncated ? 1 : 0, created.byteLength, created.createdAt
      );
      if (created.actionAttemptId) {
        const linked = this.db.prepare(`UPDATE action_attempts SET tool_output_id = ?, updated_at = ?
          WHERE id = ? AND run_id = ? AND generation = ? AND task_id IS ? AND status = 'executing'`)
          .run(created.id, created.createdAt, created.actionAttemptId, created.runId,
            created.generation, created.taskId ?? null);
        if (linked.changes !== 1) throw new Error('ACTION_ATTEMPT_STATE_CONFLICT');
      }
      event = this.insertEvent(created.runId, 'tool.output', {
        outputId: created.id, taskId: created.taskId, actionAttemptId: created.actionAttemptId,
        generation: created.generation, tool: created.tool,
        preview: created.content.slice(0, 8_000), truncated: created.truncated || created.content.length > 8_000
      });
      return created;
    })();
    if (event) this.publishEvent(event);
    return output;
  }

  getToolOutput(id: string): ToolOutput | undefined {
    const row = this.db.prepare('SELECT * FROM tool_outputs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapToolOutput(row) : undefined;
  }

  listToolOutputs(runId: string, taskId?: string, generation?: number | 'all'): ToolOutput[] {
    const currentGeneration = generation === undefined ? this.getRun(runId)?.generation : generation;
    const rows = (currentGeneration === 'all'
      ? this.db.prepare(`SELECT * FROM tool_outputs WHERE run_id = ? AND (? IS NULL OR task_id = ?)
          ORDER BY generation, created_at`).all(runId, taskId ?? null, taskId ?? null)
      : this.db.prepare(`SELECT * FROM tool_outputs WHERE run_id = ? AND generation = ?
          AND (? IS NULL OR task_id = ?) ORDER BY created_at`)
        .all(runId, currentGeneration ?? 1, taskId ?? null, taskId ?? null)) as Record<string, unknown>[];
    return rows.map((row) => this.mapToolOutput(row));
  }

  private mapToolOutput(row: Record<string, unknown>): ToolOutput {
    return {
      id: String(row.id), runId: String(row.run_id),
      ...optional<Record<never, never>, 'taskId', string>('taskId', row.task_id as string | null),
      ...optional<Record<never, never>, 'actionAttemptId', string>('actionAttemptId', row.action_attempt_id as string | null),
      generation: Number(row.generation), tool: String(row.tool), content: String(row.content),
      truncated: Number(row.truncated) === 1, byteLength: Number(row.byte_length), createdAt: String(row.created_at)
    };
  }

  upsertWorktreeArtifact(input: Omit<WorktreeArtifact, 'id' | 'generation' | 'sizeBytes' | 'createdAt' | 'updatedAt'> & {
    id?: string;
    generation?: number;
    sizeBytes?: number;
    createdAt?: string;
    updatedAt?: string;
  }): WorktreeArtifact {
    let event: RunEvent | undefined;
    const artifact = this.db.transaction(() => {
      const run = this.getRun(input.runId);
      if (!run) throw new Error('RUN_NOT_FOUND');
      const existingRow = this.db.prepare('SELECT * FROM worktree_artifacts WHERE run_id = ? AND path = ?')
        .get(input.runId, input.path) as Record<string, unknown> | undefined;
      const existing = existingRow ? this.mapWorktreeArtifact(existingRow) : undefined;
      const generation = input.generation ?? existing?.generation ?? run.generation;
      const historicalTerminalUpdate = Boolean(
        existing && generation !== run.generation && ['discarded', 'orphaned'].includes(input.status)
      );
      if (generation !== run.generation && !historicalTerminalUpdate) throw new Error('PLAN_GENERATION_STALE');
      if (existing) {
        if (input.id && input.id !== existing.id) throw new Error('WORKTREE_ARTIFACT_ID_CONFLICT');
        if (
          existing.generation !== generation || existing.kind !== input.kind || existing.taskId !== input.taskId ||
          existing.branch !== input.branch
        ) {
          throw new Error('WORKTREE_ARTIFACT_OWNERSHIP_CONFLICT');
        }
      }
      if (input.kind === 'task') {
        if (!input.taskId) throw new Error('TASK_NOT_FOUND');
        const task = this.db.prepare('SELECT run_id, generation, status FROM tasks WHERE id = ?').get(input.taskId) as
          { run_id?: string; generation?: number; status?: string } | undefined;
        if (!task) throw new Error('TASK_NOT_FOUND');
        if (task.run_id !== input.runId) throw new Error('TASK_RUN_CONFLICT');
        if (Number(task.generation) !== generation || (task.status === 'stale' && !historicalTerminalUpdate)) {
          throw new Error('PLAN_GENERATION_STALE');
        }
      } else if (input.taskId) {
        throw new Error('WORKTREE_ARTIFACT_OWNERSHIP_CONFLICT');
      }
      const timestamp = input.updatedAt ?? now();
      const parsed = worktreeArtifactSchema.parse({
        id: input.id ?? existing?.id ?? randomUUID(), runId: input.runId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        generation, kind: input.kind, path: input.path, branch: input.branch, baseRef: input.baseRef,
        ...((input.commitSha ?? existing?.commitSha) ? { commitSha: input.commitSha ?? existing?.commitSha } : {}),
        status: input.status, sizeBytes: input.sizeBytes ?? existing?.sizeBytes ?? 0,
        ...((input.retainedUntil ?? existing?.retainedUntil)
          ? { retainedUntil: input.retainedUntil ?? existing?.retainedUntil }
          : {}),
        createdAt: input.createdAt ?? existing?.createdAt ?? timestamp, updatedAt: timestamp
      });
      const write = this.db.prepare(`INSERT INTO worktree_artifacts(id, run_id, task_id, generation, kind, path, branch,
        base_ref, commit_sha, status, size_bytes, retained_until, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, path) DO UPDATE SET task_id=excluded.task_id,
        kind=excluded.kind, branch=excluded.branch, base_ref=excluded.base_ref, commit_sha=excluded.commit_sha,
        status=excluded.status, size_bytes=excluded.size_bytes, retained_until=excluded.retained_until,
        updated_at=excluded.updated_at
        WHERE worktree_artifacts.generation = excluded.generation`).run(
        parsed.id, parsed.runId, parsed.taskId ?? null, parsed.generation, parsed.kind, parsed.path,
        parsed.branch, parsed.baseRef, parsed.commitSha ?? null, parsed.status, parsed.sizeBytes,
        parsed.retainedUntil ?? null, parsed.createdAt, parsed.updatedAt
      );
      if (write.changes !== 1) throw new Error('WORKTREE_ARTIFACT_OWNERSHIP_CONFLICT');
      event = this.insertEvent(parsed.runId, 'artifact.updated', {
        artifactId: parsed.id, taskId: parsed.taskId, generation: parsed.generation,
        kind: parsed.kind, status: parsed.status, branch: parsed.branch, commitSha: parsed.commitSha
      });
      return parsed;
    })();
    if (event) this.publishEvent(event);
    return artifact;
  }

  getWorktreeArtifact(id: string): WorktreeArtifact | undefined {
    const row = this.db.prepare('SELECT * FROM worktree_artifacts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapWorktreeArtifact(row) : undefined;
  }

  listWorktreeArtifacts(runId?: string, status?: WorktreeArtifact['status']): WorktreeArtifact[] {
    const rows = this.db.prepare(`SELECT * FROM worktree_artifacts
      WHERE (? IS NULL OR run_id = ?) AND (? IS NULL OR status = ?) ORDER BY created_at`)
      .all(runId ?? null, runId ?? null, status ?? null, status ?? null) as Record<string, unknown>[];
    return rows.map((row) => this.mapWorktreeArtifact(row));
  }

  listExpiredWorktreeArtifacts(at = now()): WorktreeArtifact[] {
    const rows = this.db.prepare(`SELECT * FROM worktree_artifacts
      WHERE retained_until IS NOT NULL AND retained_until <= ? AND status IN ('completed', 'discarded')
      ORDER BY retained_until`).all(at) as Record<string, unknown>[];
    return rows.map((row) => this.mapWorktreeArtifact(row));
  }

  markWorktreeArtifactCleaned(id: string): WorktreeArtifact {
    let event: RunEvent | undefined;
    const artifact = this.db.transaction(() => {
      const current = this.getWorktreeArtifact(id);
      if (!current) throw new Error('WORKTREE_ARTIFACT_NOT_FOUND');
      const timestamp = now();
      const result = this.db.prepare(`UPDATE worktree_artifacts
        SET status = 'discarded', size_bytes = 0, retained_until = NULL, updated_at = ? WHERE id = ?`)
        .run(timestamp, id);
      if (result.changes !== 1) throw new Error('WORKTREE_ARTIFACT_OWNERSHIP_CONFLICT');
      event = this.insertEvent(current.runId, 'artifact.updated', {
        artifactId: current.id, taskId: current.taskId, generation: current.generation,
        kind: current.kind, status: 'discarded', branch: current.branch, commitSha: current.commitSha,
        cleaned: true
      });
      const updated = this.getWorktreeArtifact(id);
      if (!updated) throw new Error('WORKTREE_ARTIFACT_NOT_FOUND');
      return updated;
    })();
    if (event) this.publishEvent(event);
    return artifact;
  }

  private mapWorktreeArtifact(row: Record<string, unknown>): WorktreeArtifact {
    return {
      id: String(row.id), runId: String(row.run_id),
      ...optional<Record<never, never>, 'taskId', string>('taskId', row.task_id as string | null),
      generation: Number(row.generation), kind: String(row.kind) as WorktreeArtifact['kind'],
      path: String(row.path), branch: String(row.branch), baseRef: String(row.base_ref),
      ...optional<Record<never, never>, 'commitSha', string>('commitSha', row.commit_sha as string | null),
      status: String(row.status) as WorktreeArtifact['status'], sizeBytes: Number(row.size_bytes),
      ...optional<Record<never, never>, 'retainedUntil', string>('retainedUntil', row.retained_until as string | null),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
  }

  upsertDeliverySummary(input: Omit<DeliverySummary, 'createdAt' | 'updatedAt' | 'generation' | 'baseRef'> & {
    generation?: number;
    baseRef?: string;
    createdAt?: string;
    updatedAt?: string;
  }): DeliverySummary {
    let event: RunEvent | undefined;
    const summary = this.db.transaction(() => {
      const run = this.getRun(input.runId);
      if (!run) throw new Error('RUN_NOT_FOUND');
      const generation = input.generation ?? run.generation;
      if (generation !== run.generation) throw new Error('PLAN_GENERATION_STALE');
      for (const taskResult of input.taskResults) {
        if (taskResult.runId !== input.runId || taskResult.generation !== generation) {
          throw new Error('DELIVERY_TASK_RESULT_OWNERSHIP_CONFLICT');
        }
        const persisted = this.getTaskResult(taskResult.taskId, generation);
        if (
          !persisted || persisted.id !== taskResult.id || !persisted.verified ||
          persisted.commitSha !== taskResult.commitSha
        ) {
          throw new Error('DELIVERY_TASK_RESULT_CONFLICT');
        }
      }
      const existing = this.getDeliverySummary(input.runId, generation);
      const timestamp = input.updatedAt ?? now();
      const parsed = deliverySummarySchema.parse({
        runId: input.runId, generation, baseRef: input.baseRef ?? run.baseRef,
        ...(input.integrationBranch ? { integrationBranch: input.integrationBranch } : {}),
        filesChanged: input.filesChanged, commits: input.commits,
        verificationCommands: input.verificationCommands, taskResults: input.taskResults,
        risks: input.risks, unresolved: input.unresolved, actualCost: input.actualCost,
        createdAt: input.createdAt ?? existing?.createdAt ?? timestamp, updatedAt: timestamp
      });
      this.db.prepare(`INSERT INTO delivery_summaries(run_id, generation, base_ref, integration_branch,
        files_changed_json, commits_json, verification_commands_json, task_results_json,
        risks_json, unresolved_json, actual_cost, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, generation) DO UPDATE SET base_ref=excluded.base_ref,
        integration_branch=excluded.integration_branch, files_changed_json=excluded.files_changed_json,
        commits_json=excluded.commits_json, verification_commands_json=excluded.verification_commands_json,
        task_results_json=excluded.task_results_json, risks_json=excluded.risks_json,
        unresolved_json=excluded.unresolved_json, actual_cost=excluded.actual_cost, updated_at=excluded.updated_at`).run(
        parsed.runId, parsed.generation, parsed.baseRef, parsed.integrationBranch ?? null,
        JSON.stringify(parsed.filesChanged), JSON.stringify(parsed.commits), JSON.stringify(parsed.verificationCommands),
        JSON.stringify(parsed.taskResults), JSON.stringify(parsed.risks), JSON.stringify(parsed.unresolved),
        parsed.actualCost, parsed.createdAt, parsed.updatedAt
      );
      event = this.insertEvent(parsed.runId, 'delivery.updated', {
        generation: parsed.generation, integrationBranch: parsed.integrationBranch,
        filesChanged: parsed.filesChanged, commits: parsed.commits
      });
      return parsed;
    })();
    if (event) this.publishEvent(event);
    return summary;
  }

  getDeliverySummary(runId: string, generation?: number): DeliverySummary | undefined {
    const target = generation ?? this.getRun(runId)?.generation;
    if (target === undefined) return undefined;
    const row = this.db.prepare('SELECT * FROM delivery_summaries WHERE run_id = ? AND generation = ?')
      .get(runId, target) as Record<string, unknown> | undefined;
    return row ? {
      runId: String(row.run_id), generation: Number(row.generation), baseRef: String(row.base_ref),
      ...optional<Record<never, never>, 'integrationBranch', string>('integrationBranch', row.integration_branch as string | null),
      filesChanged: parseJson(row.files_changed_json, []), commits: parseJson(row.commits_json, []),
      verificationCommands: parseJson(row.verification_commands_json, []), taskResults: parseJson(row.task_results_json, []),
      risks: parseJson(row.risks_json, []), unresolved: parseJson(row.unresolved_json, []),
      actualCost: Number(row.actual_cost), createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    } : undefined;
  }

  getIdempotent<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT result_json FROM idempotency WHERE key = ?').get(key) as { result_json?: string } | undefined;
    return row?.result_json ? parseJson<T>(row.result_json, undefined as T) : undefined;
  }

  setIdempotent<T>(key: string, result: T): void {
    this.db.prepare('INSERT OR REPLACE INTO idempotency(key, result_json, created_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(result), now());
  }

  addUsage(runId: string, inputTokens: number, outputTokens: number, estimatedCost = 0): void {
    const event = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO usage(run_id, calls, input_tokens, output_tokens, estimated_cost) VALUES (?, 1, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET calls=calls+1, input_tokens=input_tokens+excluded.input_tokens,
        output_tokens=output_tokens+excluded.output_tokens, estimated_cost=estimated_cost+excluded.estimated_cost`)
        .run(runId, inputTokens, outputTokens, estimatedCost);
      const usage = this.db.prepare('SELECT * FROM usage WHERE run_id = ?').get(runId) as Record<string, SqlValue>;
      return this.insertEvent(runId, 'budget.updated', usage);
    })();
    this.publishEvent(event);
  }

  getUsage(runId: string): { calls: number; inputTokens: number; outputTokens: number; estimatedCost: number } {
    const row = this.db.prepare('SELECT calls, input_tokens, output_tokens, estimated_cost FROM usage WHERE run_id = ?').get(runId) as
      { calls?: number; input_tokens?: number; output_tokens?: number; estimated_cost?: number } | undefined;
    return {
      calls: Number(row?.calls ?? 0),
      inputTokens: Number(row?.input_tokens ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      estimatedCost: Number(row?.estimated_cost ?? 0)
    };
  }

  reserveBudget(input: {
    runId: string;
    providerId: ProviderId;
    model?: string;
    calls?: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCost?: number;
  }): BudgetReservation {
    const calls = Math.max(0, Math.trunc(input.calls ?? 1));
    const inputTokens = Math.max(0, Math.trunc(input.inputTokens));
    const outputTokens = Math.max(0, Math.trunc(input.outputTokens));
    const estimatedCost = Math.max(0, Number(input.estimatedCost ?? 0));
    if (![calls, inputTokens, outputTokens, estimatedCost].every(Number.isFinite)) throw new Error('INVALID_BUDGET_RESERVATION');
    try {
      return this.db.transaction(() => {
        const run = this.getRun(input.runId);
        if (!run) throw new Error('RUN_NOT_FOUND');
        const settings = this.getSetting<AppSettings>('app');
        if (!settings) throw new Error('SETTINGS_MISSING');
        const usage = this.getUsage(input.runId);
        const active = this.db.prepare(`SELECT COALESCE(SUM(reserved_calls), 0) AS calls,
          COALESCE(SUM(reserved_input_tokens), 0) AS input_tokens,
          COALESCE(SUM(reserved_output_tokens), 0) AS output_tokens,
          COALESCE(SUM(reserved_cost), 0) AS cost
          FROM budget_reservations WHERE run_id = ? AND status IN ('reserved', 'unknown')`).get(input.runId) as Record<string, SqlValue>;
        const exceeds = usage.calls + Number(active.calls ?? 0) + calls > settings.budget.maxCalls ||
          usage.inputTokens + Number(active.input_tokens ?? 0) + inputTokens > settings.budget.maxInputTokens ||
          usage.outputTokens + Number(active.output_tokens ?? 0) + outputTokens > settings.budget.maxOutputTokens ||
          (settings.budget.maxEstimatedCost !== undefined &&
            usage.estimatedCost + Number(active.cost ?? 0) + estimatedCost > settings.budget.maxEstimatedCost);
        if (exceeds) throw new Error('BUDGET_EXCEEDED');
        const timestamp = now();
        const reservation: BudgetReservation = {
          id: randomUUID(), runId: input.runId, providerId: input.providerId,
          ...(input.model ? { model: input.model } : {}),
          status: 'reserved', reservedCalls: calls, reservedInputTokens: inputTokens,
          reservedOutputTokens: outputTokens, reservedCost: estimatedCost, createdAt: timestamp
        };
        this.db.prepare(`INSERT INTO budget_reservations(id, run_id, provider_id, model, status,
          generation, dispatch_state, queued_at, reserved_calls, reserved_input_tokens, reserved_output_tokens, reserved_cost, created_at)
          VALUES (?, ?, ?, ?, 'reserved', ?, 'queued', ?, ?, ?, ?, ?, ?)`).run(
          reservation.id, reservation.runId, reservation.providerId, reservation.model ?? null,
          run.generation, timestamp,
          reservation.reservedCalls, reservation.reservedInputTokens, reservation.reservedOutputTokens,
          reservation.reservedCost, reservation.createdAt
        );
        return reservation;
      })();
    } catch (error) {
      if (error instanceof Error && error.message === 'BUDGET_EXCEEDED') {
        const blocker: RunBlocker = {
          kind: 'budget', code: 'BUDGET_EXCEEDED', message: '模型调用预算不足，无法预留本次调用。',
          since: now(), recoverable: true
        };
        this.updateRun(input.runId, { blocker });
      }
      throw error;
    }
  }

  getBudgetReservation(id: string): BudgetReservation | undefined {
    const row = this.db.prepare('SELECT * FROM budget_reservations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapBudgetReservation(row) : undefined;
  }

  listBudgetReservations(runId: string): BudgetReservation[] {
    const rows = this.db.prepare('SELECT * FROM budget_reservations WHERE run_id = ? ORDER BY created_at')
      .all(runId) as Record<string, unknown>[];
    return rows.map((row) => this.mapBudgetReservation(row));
  }

  countActiveBudgetReservations(providerId?: ProviderId): number {
    const row = (providerId
      ? this.db.prepare("SELECT COUNT(*) AS count FROM budget_reservations WHERE provider_id = ? AND status = 'reserved'").get(providerId)
      : this.db.prepare("SELECT COUNT(*) AS count FROM budget_reservations WHERE status = 'reserved'").get()) as { count?: number };
    return Number(row.count ?? 0);
  }

  settleBudgetReservation(id: string, actual: {
    calls?: number;
    inputTokens: number;
    outputTokens: number;
    actualCost?: number;
  }): BudgetReservation {
    let event: RunEvent | undefined;
    const settled = this.db.transaction(() => {
      const current = this.getBudgetReservation(id);
      if (!current) throw new Error('BUDGET_RESERVATION_NOT_FOUND');
      if (current.status === 'settled') return current;
      if (current.status === 'released') throw new Error('BUDGET_RESERVATION_RELEASED');
      const calls = Math.max(0, Math.trunc(actual.calls ?? 1));
      const inputTokens = Math.max(0, Math.trunc(actual.inputTokens));
      const outputTokens = Math.max(0, Math.trunc(actual.outputTokens));
      const actualCost = Math.max(0, Number(actual.actualCost ?? current.reservedCost));
      const timestamp = now();
      const update = this.db.prepare(`UPDATE budget_reservations SET status = 'settled', actual_calls = ?,
        actual_input_tokens = ?, actual_output_tokens = ?, actual_cost = ?, settled_at = ?
        WHERE id = ? AND status IN ('reserved', 'unknown')`).run(calls, inputTokens, outputTokens, actualCost, timestamp, id);
      if (update.changes !== 1) throw new Error('BUDGET_RESERVATION_STATE_CONFLICT');
      this.db.prepare(`INSERT INTO usage(run_id, calls, input_tokens, output_tokens, estimated_cost)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET calls=calls+excluded.calls,
        input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens,
        estimated_cost=estimated_cost+excluded.estimated_cost`).run(
        current.runId, calls, inputTokens, outputTokens, actualCost
      );
      const usage = this.getUsage(current.runId);
      event = this.insertEvent(current.runId, 'budget.updated', { reservationId: id, usage });
      const result = this.getBudgetReservation(id);
      if (!result) throw new Error('BUDGET_RESERVATION_NOT_FOUND');
      return result;
    })();
    if (event) this.publishEvent(event);
    return settled;
  }

  settleBudget(id: string, actual: Parameters<LoopStore['settleBudgetReservation']>[1]): BudgetReservation {
    return this.settleBudgetReservation(id, actual);
  }

  markBudgetReservationUnknown(id: string): BudgetReservation {
    let event: RunEvent | undefined;
    const reservation = this.db.transaction(() => {
      const current = this.getBudgetReservation(id);
      if (!current) throw new Error('BUDGET_RESERVATION_NOT_FOUND');
      if (current.status === 'unknown') return current;
      if (current.status !== 'reserved') throw new Error('BUDGET_RESERVATION_STATE_CONFLICT');
      const timestamp = now();
      const update = this.db.prepare(`UPDATE budget_reservations SET status = 'unknown', unknown_at = ?
        WHERE id = ? AND status = 'reserved'`).run(timestamp, id);
      if (update.changes !== 1) throw new Error('BUDGET_RESERVATION_STATE_CONFLICT');
      event = this.insertEvent(current.runId, 'budget.updated', {
        reservationId: id, status: 'unknown', reservedCalls: current.reservedCalls,
        reservedInputTokens: current.reservedInputTokens, reservedOutputTokens: current.reservedOutputTokens,
        reservedCost: current.reservedCost
      });
      const updated = this.getBudgetReservation(id);
      if (!updated) throw new Error('BUDGET_RESERVATION_NOT_FOUND');
      return updated;
    })();
    if (event) this.publishEvent(event);
    return reservation;
  }

  releaseBudgetReservation(id: string): BudgetReservation {
    const current = this.getBudgetReservation(id);
    if (!current) throw new Error('BUDGET_RESERVATION_NOT_FOUND');
    if (current.status === 'settled') throw new Error('BUDGET_RESERVATION_SETTLED');
    if (current.status === 'unknown') throw new Error('BUDGET_RESERVATION_OUTCOME_UNKNOWN');
    if (current.status === 'reserved') {
      this.db.prepare("UPDATE budget_reservations SET status = 'released', settled_at = ? WHERE id = ? AND status = 'reserved'")
        .run(now(), id);
    }
    return this.getBudgetReservation(id) ?? current;
  }

  private mapBudgetReservation(row: Record<string, unknown>): BudgetReservation {
    return {
      id: String(row.id), runId: String(row.run_id), providerId: String(row.provider_id) as ProviderId,
      ...optional<Record<never, never>, 'model', string>('model', row.model as string | null),
      status: String(row.status) as BudgetReservation['status'],
      reservedCalls: Number(row.reserved_calls), reservedInputTokens: Number(row.reserved_input_tokens),
      reservedOutputTokens: Number(row.reserved_output_tokens), reservedCost: Number(row.reserved_cost),
      ...optional<Record<never, never>, 'actualCalls', number>('actualCalls', row.actual_calls as number | null),
      ...optional<Record<never, never>, 'actualInputTokens', number>('actualInputTokens', row.actual_input_tokens as number | null),
      ...optional<Record<never, never>, 'actualOutputTokens', number>('actualOutputTokens', row.actual_output_tokens as number | null),
      ...optional<Record<never, never>, 'actualCost', number>('actualCost', row.actual_cost as number | null),
      createdAt: String(row.created_at),
      ...optional<Record<never, never>, 'unknownAt', string>('unknownAt', row.unknown_at as string | null),
      ...optional<Record<never, never>, 'settledAt', string>('settledAt', row.settled_at as string | null)
    };
  }
}
