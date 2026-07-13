import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { evaluateCommand, pathWithinTaskScope, PathPolicyError, resolveProjectPath } from '../apps/server/src/security.js';

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('workspace security', () => {
  it('allows an existing file inside the project and rejects traversal', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'loop-security-'));
    temporaryPaths.push(root);
    await mkdir(resolve(root, 'src'));
    await writeFile(resolve(root, 'src', 'index.ts'), 'export {};', 'utf8');
    await expect(resolveProjectPath(root, 'src/index.ts')).resolves.toBe(resolve(root, 'src', 'index.ts'));
    await expect(resolveProjectPath(root, '../outside.txt')).rejects.toBeInstanceOf(PathPolicyError);
  });

  it('validates a new file through its real parent', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'loop-write-'));
    temporaryPaths.push(root);
    await mkdir(resolve(root, 'docs'));
    await expect(resolveProjectPath(root, 'docs/new.md', true)).resolves.toBe(resolve(root, 'docs', 'new.md'));
    await expect(resolveProjectPath(root, 'generated/nested/new.md', true)).resolves.toBe(resolve(root, 'generated', 'nested', 'new.md'));
  });

  it('keeps a hard safety line in auto mode', () => {
    expect(evaluateCommand('npm.cmd run typecheck', false).decision).toBe('allow');
    expect(evaluateCommand('npm.cmd install', false).decision).toBe('approval');
    expect(evaluateCommand('npm.cmd install', true).decision).toBe('approval');
    expect(evaluateCommand('node -e "process.exit(0)"', true).decision).toBe('approval');
    expect(evaluateCommand('git push --force origin main', true).decision).toBe('deny');
    expect(evaluateCommand('Remove-Item -Recurse .', true).decision).toBe('deny');
    expect(evaluateCommand('Set-Content C:\\outside.txt value', true).decision).toBe('deny');
    expect(evaluateCommand("Set-Content 'C:\\outside.txt' value", true).decision).toBe('deny');
  });

  it('matches writes against the declared task scope', () => {
    expect(pathWithinTaskScope('apps/server/src/app.ts', ['apps/server/'])).toBe(true);
    expect(pathWithinTaskScope('apps/web/src/App.tsx', ['apps/server/'])).toBe(false);
    expect(pathWithinTaskScope('anything.txt', ['.'])).toBe(true);
  });
});
