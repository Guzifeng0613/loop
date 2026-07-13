import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { LoopDocument } from '@loop/contracts';
import { resolveProjectPath } from './security.js';
import type { LoopStore } from './store.js';

const coreFiles = [
  '总体方案.md',
  '功能.md',
  'UI.md',
  'API接口.md',
  '版本更迭.md'
];

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

export class DocumentService {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();

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

  async syncProject(projectId: string, rootPath: string): Promise<LoopDocument[]> {
    const docsRoot = resolve(rootPath, 'docs');
    try {
      await stat(docsRoot);
    } catch {
      await mkdir(docsRoot, { recursive: true });
    }

    const existing = new Map(this.store.listDocuments(projectId).map((doc) => [doc.id, doc]));
    for (const filename of coreFiles) {
      const filePath = resolve(docsRoot, filename);
      let content: string;
      try {
        content = await readFile(filePath, 'utf8');
      } catch {
        continue;
      }
      const metadata = frontMatter(content);
      const id = metadata.doc_id ?? basename(filename, '.md').toLowerCase();
      const hash = hashContent(content);
      const prior = existing.get(id);
      const status: LoopDocument['status'] = prior?.status === 'approved' && prior.hash !== hash ? 'stale' :
        ((metadata.status as LoopDocument['status']) ?? prior?.status ?? 'draft');
      const document: LoopDocument = {
        id,
        projectId,
        filename: `docs/${filename}`,
        title: titleFrom(content, filename),
        version: metadata.version ?? prior?.version ?? '0.1.0',
        status,
        hash,
        content,
        updatedAt: new Date().toISOString()
      };
      this.store.upsertDocument(document, prior?.status === 'approved' && prior.hash === hash ? hash : undefined);
    }
    return this.store.listDocuments(projectId);
  }

  async save(projectId: string, rootPath: string, docId: string, content: string): Promise<LoopDocument> {
    const existing = this.store.listDocuments(projectId).find((doc) => doc.id === docId);
    if (!existing) throw new Error('Document not found');
    const filePath = await resolveProjectPath(rootPath, existing.filename, true);
    await mkdir(dirname(filePath), { recursive: true });
    const temp = `${filePath}.loop-tmp`;
    await writeFile(temp, content, 'utf8');
    await rename(temp, filePath);
    const metadata = frontMatter(content);
    const next: LoopDocument = {
      ...existing,
      title: titleFrom(content, existing.filename),
      version: metadata.version ?? existing.version,
      status: existing.hash === hashContent(content) ? existing.status : 'stale',
      hash: hashContent(content),
      content,
      updatedAt: new Date().toISOString()
    };
    this.store.upsertDocument(next);
    return next;
  }
}
