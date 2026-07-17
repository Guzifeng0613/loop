import { createHash, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { LoopDocument } from '@loop/contracts';
import { LoopError } from './errors.js';
import { resolveProjectPath } from './security.js';
import type { LoopStore } from './store.js';

export const coreDocuments = [
  { filename: '总体方案.md', id: 'architecture' },
  { filename: '功能.md', id: 'features' },
  { filename: 'UI.md', id: 'ui' },
  { filename: 'API接口.md', id: 'api' },
  { filename: '版本更迭.md', id: 'roadmap' }
] as const;
export const coreFiles = coreDocuments.map((document) => document.filename);

export function hashContent(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n').trimEnd()).digest('hex');
}

function frontMatter(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match?.[1]) return {};
  return Object.fromEntries(match[1].split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf(':');
    return separator === -1 ? [] : [[line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')]];
  }));
}

function titleFrom(content: string, filename: string): string {
  const heading = /^#\s+(.+)$/m.exec(content)?.[1];
  return heading?.trim() ?? basename(filename, '.md');
}

export function validateCoreDocuments(documents: LoopDocument[]): string[] {
  const byFilename = new Map(documents.map((document) => [document.filename.replace(/\\/g, '/'), document]));
  const errors: string[] = [];
  for (const expected of coreDocuments) {
    const document = byFilename.get(`docs/${expected.filename}`);
    if (!document) {
      errors.push(`缺少 docs/${expected.filename}`);
      continue;
    }
    const metadata = frontMatter(document.content);
    if (document.id !== expected.id || metadata.doc_id !== expected.id) errors.push(`${expected.filename} 的 doc_id 必须为 ${expected.id}`);
    if (metadata.loop_schema !== '1') errors.push(`${expected.filename} 的 loop_schema 必须为 1`);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version ?? '')) errors.push(`${expected.filename} 缺少有效的语义化 version`);
  }
  return errors;
}

export class DocumentService {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly documentLocks = new Map<string, Promise<void>>();

  constructor(private readonly store: LoopStore) {}

  watchProject(projectId: string, rootPath: string, onInvalidated: (docIds: string[]) => void): void {
    if (this.watchers.has(projectId)) return;
    const docsRoot = resolve(rootPath, 'docs');
    const watcher = watch(docsRoot, { recursive: true }, (_event, filename) => {
      if (!filename || filename.endsWith('.loop-tmp')) return;
      const previous = this.debounceTimers.get(projectId);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(async () => {
        const before = new Map(this.store.listDocuments(projectId).map((doc) => [doc.id, doc]));
        const after = await this.syncProject(projectId, rootPath);
        const invalidated = after.filter((doc) => before.get(doc.id)?.status === 'approved' && doc.status === 'stale').map((doc) => doc.id);
        if (invalidated.length > 0) onInvalidated(invalidated);
      }, 180);
      this.debounceTimers.set(projectId, timer);
    });
    this.watchers.set(projectId, watcher);
  }

  closeWatchers(): void {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.debounceTimers.clear();
    this.watchers.clear();
  }

  private async withDocumentLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.documentLocks.get(path) ?? Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.documentLocks.set(path, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.documentLocks.get(path) === queued) this.documentLocks.delete(path);
    }
  }

  private documentFromContent(existing: LoopDocument, content: string): LoopDocument {
    const hash = hashContent(content);
    const metadata = frontMatter(content);
    return {
      ...existing,
      title: titleFrom(content, existing.filename),
      version: metadata.version ?? existing.version,
      status: existing.hash === hash
        ? existing.status
        : existing.status === 'approved' ? 'stale' : existing.status,
      hash,
      content,
      updatedAt: new Date().toISOString()
    };
  }

  private documentMetadata(document: LoopDocument): Omit<LoopDocument, 'content'> {
    return {
      id: document.id,
      projectId: document.projectId,
      filename: document.filename,
      title: document.title,
      version: document.version,
      status: document.status,
      hash: document.hash,
      updatedAt: document.updatedAt
    };
  }

  private staleDocumentError(document: LoopDocument): LoopError {
    return new LoopError(
      'DOC_VERSION_STALE',
      '文档已在磁盘上变化；当前保存未覆盖任何内容，请重新同步后再提交。',
      { latest: this.documentMetadata(document) }
    );
  }

  async syncProject(projectId: string, rootPath: string): Promise<LoopDocument[]> {
    const docsRoot = resolve(rootPath, 'docs');
    try {
      await stat(docsRoot);
    } catch {
      await mkdir(docsRoot, { recursive: true });
    }

    for (const filename of coreFiles) {
      const filePath = resolve(docsRoot, filename);
      await this.withDocumentLock(filePath, async () => {
        let content: string;
        try {
          content = await readFile(filePath, 'utf8');
        } catch {
          return;
        }
        const metadata = frontMatter(content);
        const id = metadata.doc_id ?? basename(filename, '.md').toLowerCase();
        const hash = hashContent(content);
        const prior = this.store.getDocument(projectId, id);
        // Front matter describes the document's authored status, but only an
        // explicit API approval may establish the runtime approval gate.
        const status: LoopDocument['status'] = !prior
          ? 'draft'
          : prior.status === 'approved' && prior.hash !== hash
            ? 'stale'
            : prior.status;
        const document: LoopDocument = {
          id,
          projectId,
          filename: `docs/${filename}`,
          title: titleFrom(content, filename),
          version: metadata.version ?? prior?.version ?? '0.2.0-alpha.1',
          status,
          hash,
          content,
          updatedAt: new Date().toISOString()
        };
        this.store.upsertDocument(document, prior?.status === 'approved' && prior.hash === hash ? hash : undefined);
      });
    }
    return this.store.listDocuments(projectId);
  }

  async save(
    projectId: string,
    rootPath: string,
    docId: string,
    content: string,
    expectedHash: string
  ): Promise<LoopDocument> {
    const existing = this.store.listDocuments(projectId).find((doc) => doc.id === docId);
    if (!existing) throw new Error('DOCUMENT_NOT_FOUND');
    const filePath = await resolveProjectPath(rootPath, existing.filename, true);
    return this.withDocumentLock(filePath, async () => {
      const stored = this.store.getDocument(projectId, docId) ?? existing;
      const diskContent = await readFile(filePath, 'utf8');
      const current = this.documentFromContent(stored, diskContent);
      if (current.hash !== stored.hash) this.store.upsertDocument(current);
      if (expectedHash !== current.hash) throw this.staleDocumentError(current);

      await mkdir(dirname(filePath), { recursive: true });
      const temp = resolve(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.loop-tmp`);
      let renamed = false;
      try {
        await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
        const latestDiskContent = await readFile(filePath, 'utf8');
        const latest = this.documentFromContent(current, latestDiskContent);
        if (latest.hash !== expectedHash) {
          if (latest.hash !== current.hash) this.store.upsertDocument(latest);
          throw this.staleDocumentError(latest);
        }
        await rename(temp, filePath);
        renamed = true;
      } finally {
        if (!renamed) await rm(temp, { force: true });
      }
      const next = this.documentFromContent(current, content);
      this.store.upsertDocument(next);
      return next;
    });
  }
}
