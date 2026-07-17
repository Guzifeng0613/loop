import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('uses expectedHash CAS and returns the latest metadata without overwriting an external edit', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'loop-doc-cas-external-'));
    const store = new LoopStore(':memory:');
    try {
      await mkdir(resolve(root, 'docs'));
      const filename = resolve(root, 'docs', '总体方案.md');
      const initial = '---\ndoc_id: architecture\nversion: 0.3.0-alpha.1\n---\n\n# Architecture\nInitial\n';
      const external = '---\ndoc_id: architecture\nversion: 0.3.0-alpha.1\n---\n\n# Architecture\nExternal\n';
      const attempted = '---\ndoc_id: architecture\nversion: 0.3.0-alpha.1\n---\n\n# Architecture\nAttempted overwrite\n';
      await writeFile(filename, initial, 'utf8');
      const project = store.createProject({ name: 'fixture', rootPath: root, isGit: false });
      const service = new DocumentService(store);
      await service.syncProject(project.id, root);
      const expectedHash = store.getDocument(project.id, 'architecture')!.hash;

      await writeFile(filename, external, 'utf8');
      await expect(service.save(project.id, root, 'architecture', attempted, expectedHash))
        .rejects.toMatchObject({
          code: 'DOC_VERSION_STALE',
          statusCode: 409,
          details: { latest: { hash: hashContent(external) } }
        });
      expect(await readFile(filename, 'utf8')).toBe(external);
      expect(store.getDocument(project.id, 'architecture')).toMatchObject({
        hash: hashContent(external),
        content: external
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes competing saves so the same expectedHash produces at most one effect', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'loop-doc-cas-lock-'));
    const store = new LoopStore(':memory:');
    try {
      await mkdir(resolve(root, 'docs'));
      const filename = resolve(root, 'docs', '总体方案.md');
      const initial = '---\ndoc_id: architecture\nversion: 0.3.0-alpha.1\n---\n\n# Architecture\nInitial\n';
      const first = initial.replace('Initial', 'First');
      const second = initial.replace('Initial', 'Second');
      await writeFile(filename, initial, 'utf8');
      const project = store.createProject({ name: 'fixture', rootPath: root, isGit: false });
      const service = new DocumentService(store);
      await service.syncProject(project.id, root);
      const expectedHash = store.getDocument(project.id, 'architecture')!.hash;

      const results = await Promise.allSettled([
        service.save(project.id, root, 'architecture', first, expectedHash),
        service.save(project.id, root, 'architecture', second, expectedHash)
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect(rejected?.reason).toMatchObject({ code: 'DOC_VERSION_STALE', statusCode: 409 });
      const disk = await readFile(filename, 'utf8');
      expect([first, second]).toContain(disk);
      expect(store.getDocument(project.id, 'architecture')?.hash).toBe(hashContent(disk));
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
