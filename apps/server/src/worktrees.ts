import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runProcess } from './security.js';

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
}

export class WorktreeManager {
  constructor(private readonly worktreeRoot: string) {}

  async isGit(root: string): Promise<boolean> {
    return (await runProcess('git rev-parse --is-inside-work-tree', root)).code === 0;
  }

  async isClean(root: string): Promise<boolean> {
    const result = await runProcess('git status --porcelain', root);
    return result.code === 0 && result.output.trim().length === 0;
  }

  branchName(runId: string, taskId: string): string {
    return `loop/${safeName(runId)}/${safeName(taskId)}`;
  }

  async create(runId: string, taskId: string, projectRoot: string, baseRef = 'HEAD', signal?: AbortSignal): Promise<{ path: string; branch: string }> {
    if (!(await this.isGit(projectRoot))) throw new Error('WORKTREE_NOT_GIT');
    if (!(await this.isClean(projectRoot))) throw new Error('WORKTREE_DIRTY');
    const runKey = safeName(runId);
    const taskKey = safeName(taskId);
    const directory = resolve(this.worktreeRoot, runKey, taskKey);
    const branch = this.branchName(runId, taskId);
    await mkdir(resolve(this.worktreeRoot, runKey), { recursive: true });
    try {
      await stat(directory);
      return { path: directory, branch };
    } catch {
      // Create a new worktree below.
    }
    const branchExists = (await runProcess(`git show-ref --verify --quiet 'refs/heads/${branch}'`, projectRoot, signal)).code === 0;
    const result = await runProcess(
      branchExists
        ? `git worktree add '${directory.replace(/'/g, "''")}' '${branch}'`
        : `git worktree add -b '${branch}' '${directory.replace(/'/g, "''")}' '${baseRef.replace(/'/g, "''")}'`,
      projectRoot,
      signal
    );
    if (result.code !== 0) throw new Error(`WORKTREE_CREATE_FAILED: ${result.output}`);
    return { path: directory, branch };
  }

  async mergeInto(worktreePath: string, branch: string, signal?: AbortSignal): Promise<void> {
    const result = await runProcess(`git merge --no-ff '${branch.replace(/'/g, "''")}' -m 'loop: merge ${safeName(branch)}'`, worktreePath, signal);
    if (result.code !== 0) {
      await runProcess('git merge --abort', worktreePath);
      throw new Error(`WORKTREE_CONFLICT: ${branch}\n${result.output}`);
    }
  }

  async commit(worktreePath: string, taskId: string, signal?: AbortSignal): Promise<string | undefined> {
    await runProcess('git add -A', worktreePath, signal);
    const status = await runProcess('git status --porcelain', worktreePath, signal);
    if (!status.output.trim()) return undefined;
    const result = await runProcess(`git commit -m 'loop: complete ${safeName(taskId)}'`, worktreePath, signal);
    if (result.code !== 0) throw new Error(`WORKTREE_COMMIT_FAILED: ${result.output}`);
    const revision = await runProcess('git rev-parse HEAD', worktreePath, signal);
    return revision.output.trim();
  }

  async integrate(runId: string, projectRoot: string, signal?: AbortSignal): Promise<{ path: string; branch: string; verification: string[] }> {
    if (!(await this.isGit(projectRoot))) throw new Error('PROJECT_NOT_GIT');
    if (!(await this.isClean(projectRoot))) throw new Error('WORKTREE_DIRTY');
    const runKey = safeName(runId);
    const directory = resolve(this.worktreeRoot, runKey, '_integration');
    const branch = `loop/${runKey}/integration`;
    await mkdir(resolve(this.worktreeRoot, runKey), { recursive: true });
    let directoryExists = false;
    try {
      await stat(directory);
      directoryExists = true;
    } catch {
      // Create or restore the integration worktree below.
    }
    if (!directoryExists) {
      const branchExists = (await runProcess(`git show-ref --verify --quiet 'refs/heads/${branch}'`, projectRoot, signal)).code === 0;
      const create = await runProcess(
        branchExists
          ? `git worktree add '${directory.replace(/'/g, "''")}' '${branch}'`
          : `git worktree add -b '${branch}' '${directory.replace(/'/g, "''")}' HEAD`,
        projectRoot,
        signal
      );
      if (create.code !== 0) throw new Error(`INTEGRATION_CREATE_FAILED: ${create.output}`);
    } else if ((await runProcess('git rev-parse --is-inside-work-tree', directory, signal)).code !== 0) {
      throw new Error('WORKTREE_CONFLICT: 集成目录存在但不是有效 Git worktree');
    }
    const branchesResult = await runProcess(`git for-each-ref --format='%(refname:short)' 'refs/heads/loop/${runKey}/*'`, projectRoot, signal);
    const branches = branchesResult.output.split(/\r?\n/).map((item) => item.trim()).filter((item) => item && item !== branch);
    for (const taskBranch of branches) {
      const merge = await runProcess(`git merge --no-ff '${taskBranch.replace(/'/g, "''")}' -m 'loop: integrate ${safeName(taskBranch)}'`, directory, signal);
      if (merge.code !== 0) {
        await runProcess('git merge --abort', directory);
        throw new Error(`WORKTREE_CONFLICT: ${taskBranch}\n${merge.output}`);
      }
    }
    const verification: string[] = [];
    for (const command of ['npm.cmd run typecheck', 'npm.cmd test', 'npm.cmd run build']) {
      const result = await runProcess(command, directory, signal);
      verification.push(`${command}: ${result.code === 0 ? 'passed' : 'failed'}\n${result.output.slice(-4000)}`);
      if (result.code !== 0) throw new Error(`INTEGRATION_VERIFY_FAILED: ${command}\n${result.output}`);
    }
    return { path: directory, branch, verification };
  }
}
