import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DocumentService, hashContent } from '../apps/server/src/documents.js';
import { LoopStore } from '../apps/server/src/store.js';

describe('document hashing', () => {
  it('normalizes line endings and trailing whitespace', () => {
    expect(hashContent('# Spec\r\n\r\nContent\r\n')).toBe(hashContent('# Spec\n\nContent'));
  });

  it('changes when normative content changes', () => {
    expect(hashContent('# Spec\nA')).not.toBe(hashContent('# Spec\nB'));
  });

  it('requires explicit approval and never restores stale approval from front matter', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'loop-doc-gate-'));
    const store = new LoopStore(':memory:');
    try {
      await mkdir(resolve(root, 'docs'));
      const filename = resolve(root, 'docs', '总体方案.md');
      await writeFile(filename, '---\ndoc_id: architecture\nversion: 0.1.0\nstatus: approved\n---\n\n# Architecture\nA\n', 'utf8');
      const project = store.createProject({ name: 'fixture', rootPath: root, isGit: false });
      const service = new DocumentService(store);

      await service.syncProject(project.id, root);
      expect(store.getDocument(project.id, 'architecture')?.status).toBe('draft');

      store.approveDocument(project.id, 'architecture');
      await writeFile(filename, '---\ndoc_id: architecture\nversion: 0.1.0\nstatus: approved\n---\n\n# Architecture\nB\n', 'utf8');
      await service.syncProject(project.id, root);
      expect(store.getDocument(project.id, 'architecture')?.status).toBe('stale');

      await service.syncProject(project.id, root);
      expect(store.getDocument(project.id, 'architecture')?.status).toBe('stale');
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
