import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runExecutable } from '../apps/server/src/security.js';
import { WorktreeManager } from '../apps/server/src/worktrees.js';

interface GitFixture {
  projectRoot: string;
  worktreesRoot: string;
  manager: WorktreeManager;
  baseCommit: string;
}

const fixtures: GitFixture[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runExecutable('git', args, cwd);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.output}`);
  return result.output.trim();
}

async function createFixture(testScript = 'node -e "process.exit(0)"'): Promise<GitFixture> {
  const projectRoot = await mkdtemp(resolve(tmpdir(), 'loop-worktree-project-'));
  const worktreesRoot = await mkdtemp(resolve(tmpdir(), 'loop-worktree-artifacts-'));
  await git(projectRoot, 'init', '-b', 'main');
  await git(projectRoot, 'config', 'user.email', 'loop@example.local');
  await git(projectRoot, 'config', 'user.name', 'Loop Worktree Test');
  await writeFile(resolve(projectRoot, 'README.md'), '# fixture\n', 'utf8');
  await writeFile(resolve(projectRoot, 'package.json'), JSON.stringify({
    name: 'loop-worktree-fixture',
    private: true,
    scripts: { test: testScript }
  }, null, 2), 'utf8');
  await git(projectRoot, 'add', '-A');
  await git(projectRoot, 'commit', '-m', 'fixture');
  const fixture = {
    projectRoot,
    worktreesRoot,
    manager: new WorktreeManager(worktreesRoot),
    baseCommit: await git(projectRoot, 'rev-parse', 'HEAD')
  };
  fixtures.push(fixture);
  return fixture;
}

async function commitTask(
  fixture: GitFixture,
  runId: string,
  taskId: string,
  filename = `${taskId}.txt`
): Promise<{ path: string; branch: string; commitSha: string }> {
  const worktree = await fixture.manager.create(runId, taskId, fixture.projectRoot, fixture.baseCommit);
  await writeFile(resolve(worktree.path, filename), `${taskId}\n`, 'utf8');
  const commitSha = await fixture.manager.commit(worktree.path, taskId, ['.']);
  if (!commitSha) throw new Error(`missing task commit for ${taskId}`);
  return { path: worktree.path, branch: worktree.branch, commitSha };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) {
    await rm(fixture.worktreesRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await runExecutable('git', ['worktree', 'prune'], fixture.projectRoot);
    await rm(fixture.projectRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 30_000);

describe('WorktreeManager safety invariants', () => {
  it('rejects out-of-scope and sensitive changes before staging, then commits explicit allowed paths', async () => {
    const fixture = await createFixture();
    const worktree = await fixture.manager.create('run-scoped-commit', 'task-scoped-commit', fixture.projectRoot, fixture.baseCommit);
    await writeFile(resolve(worktree.path, 'allowed.txt'), 'allowed\n', 'utf8');
    await writeFile(resolve(worktree.path, 'outside.txt'), 'outside\n', 'utf8');
    await expect(fixture.manager.commit(worktree.path, 'task-scoped-commit', ['allowed.txt']))
      .rejects.toThrow('TOOL_SCOPE_VIOLATION');
    expect(await git(worktree.path, 'diff', '--cached', '--name-only')).toBe('');

    await rm(resolve(worktree.path, 'outside.txt'), { force: true });
    const commitSha = await fixture.manager.commit(worktree.path, 'task-scoped-commit', ['allowed.txt']);
    expect(commitSha).toBeTruthy();
    expect(await git(worktree.path, 'show', '--pretty=', '--name-only', commitSha!)).toBe('allowed.txt');

    await writeFile(resolve(worktree.path, '.env.local'), 'TOKEN=blocked\n', 'utf8');
    await expect(fixture.manager.commit(worktree.path, 'task-sensitive-commit', ['.']))
      .rejects.toMatchObject({ code: 'SENSITIVE_PATH' });
  }, 30_000);

  it('detects HEAD mutation and scope escape after task verification', async () => {
    const fixture = await createFixture();
    const worktree = await fixture.manager.create('run-task-verification', 'task-task-verification', fixture.projectRoot, fixture.baseCommit);
    const snapshot = await fixture.manager.captureTaskVerification(worktree.path, ['src/']);
    await writeFile(resolve(worktree.path, 'outside.txt'), 'outside\n', 'utf8');
    await expect(fixture.manager.assertTaskVerification(worktree.path, snapshot))
      .rejects.toThrow('TOOL_SCOPE_VIOLATION');

    await rm(resolve(worktree.path, 'outside.txt'), { force: true });
    const headSnapshot = await fixture.manager.captureTaskVerification(worktree.path, ['.']);
    await writeFile(resolve(worktree.path, 'committed.txt'), 'committed\n', 'utf8');
    await git(worktree.path, 'add', 'committed.txt');
    await git(worktree.path, 'commit', '-m', 'verification mutation');
    await expect(fixture.manager.assertTaskVerification(worktree.path, headSnapshot))
      .rejects.toThrow('TASK_VERIFICATION_MUTATED_HEAD');
  }, 30_000);

  it('rejects task and integration branches whose HEAD advanced past the registered commit', async () => {
    const fixture = await createFixture();
    const task = await commitTask(fixture, 'run-reference', 'task-reference');

    await writeFile(resolve(task.path, 'unexpected-task.txt'), 'advanced\n', 'utf8');
    await git(task.path, 'add', '-A');
    await git(task.path, 'commit', '-m', 'unexpected task advance');
    await expect(
      fixture.manager.assertTaskReference(task.path, task.branch, task.commitSha)
    ).rejects.toThrow('WORKTREE_ARTIFACT_DRIFT');

    const integrationRunId = 'run-integration-reference';
    const integrationBranch = `loop/${integrationRunId}/integration-g1`;
    await git(fixture.projectRoot, 'switch', '-c', integrationBranch);
    await writeFile(resolve(fixture.projectRoot, 'registered-integration.txt'), 'registered\n', 'utf8');
    await git(fixture.projectRoot, 'add', '-A');
    await git(fixture.projectRoot, 'commit', '-m', 'registered integration');
    const registeredIntegrationCommit = await git(fixture.projectRoot, 'rev-parse', 'HEAD');
    await writeFile(resolve(fixture.projectRoot, 'unexpected-integration.txt'), 'advanced\n', 'utf8');
    await git(fixture.projectRoot, 'add', '-A');
    await git(fixture.projectRoot, 'commit', '-m', 'unexpected integration advance');
    await expect(
      fixture.manager.assertIntegrationReference(
        fixture.projectRoot,
        integrationBranch,
        registeredIntegrationCommit,
        integrationRunId
      )
    ).rejects.toThrow('WORKTREE_ARTIFACT_DRIFT');
  }, 30_000);

  it.each([
    {
      label: 'advances HEAD',
      script: 'node -e "require(\'node:fs\').writeFileSync(\'verification-commit.txt\',\'mutated\')" && git add verification-commit.txt && git commit -m verification-mutated'
    },
    {
      label: 'leaves a dirty file',
      script: 'node -e "require(\'node:fs\').writeFileSync(\'verification-dirty.txt\',\'mutated\')"'
    }
  ])('rejects integration verification that $label', async ({ script }) => {
    const fixture = await createFixture(script);
    const task = await commitTask(fixture, 'run-verification', 'task-verification');

    await expect(fixture.manager.integrate(
      'run-verification',
      fixture.projectRoot,
      [{ branch: task.branch, commitSha: task.commitSha }],
      fixture.baseCommit,
      1
    )).rejects.toThrow('INTEGRATION_VERIFY_MUTATED');
  }, 30_000);

  it('rejects detached HEAD and a different target branch even when both point at the approved base', async () => {
    const fixture = await createFixture();
    const runId = 'run-accept-target';
    const integrationBranch = `loop/${runId}/integration-g1`;
    await git(fixture.projectRoot, 'switch', '-c', integrationBranch);
    await writeFile(resolve(fixture.projectRoot, 'delivery.txt'), 'delivery\n', 'utf8');
    await git(fixture.projectRoot, 'add', '-A');
    await git(fixture.projectRoot, 'commit', '-m', 'verified delivery');
    const integrationCommit = await git(fixture.projectRoot, 'rev-parse', 'HEAD');
    await git(fixture.projectRoot, 'switch', 'main');
    await git(fixture.projectRoot, 'branch', 'release', fixture.baseCommit);

    await git(fixture.projectRoot, 'checkout', '--detach', fixture.baseCommit);
    await expect(fixture.manager.mergeAccepted(
      fixture.projectRoot,
      integrationBranch,
      integrationCommit,
      fixture.baseCommit,
      'main',
      runId
    )).rejects.toThrow('WORKTREE_DETACHED_HEAD');

    await git(fixture.projectRoot, 'switch', 'release');
    await expect(fixture.manager.mergeAccepted(
      fixture.projectRoot,
      integrationBranch,
      integrationCommit,
      fixture.baseCommit,
      'main',
      runId
    )).rejects.toThrow('WORKTREE_TARGET_DRIFT');
  }, 30_000);

  it('refuses cleanup for dirty worktrees and for clean worktrees whose HEAD drifted', async () => {
    const fixture = await createFixture();
    const task = await commitTask(fixture, 'run-cleanup', 'task-cleanup');

    const dirtyPath = resolve(task.path, 'dirty.txt');
    await writeFile(dirtyPath, 'dirty\n', 'utf8');
    await expect(
      fixture.manager.cleanupArtifact(fixture.projectRoot, task.path, task.commitSha)
    ).rejects.toThrow('WORKTREE_DIRTY');

    await rm(dirtyPath, { force: true });
    await writeFile(resolve(task.path, 'advanced.txt'), 'advanced\n', 'utf8');
    await git(task.path, 'add', '-A');
    await git(task.path, 'commit', '-m', 'advanced after registration');
    await expect(
      fixture.manager.cleanupArtifact(fixture.projectRoot, task.path, task.commitSha)
    ).rejects.toThrow('WORKTREE_ARTIFACT_DRIFT');
  }, 30_000);
});
