import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import {
  assertGitChangesWithinTaskScope,
  assertTaskVerificationSnapshot,
  captureTaskVerificationSnapshot,
  loadRepositoryPathPolicy,
  pathWithinTaskScope,
  runExecutable,
  runNpmScript,
  runProcess,
  type SupportedNpmScript,
  type TaskVerificationSnapshot
} from './security.js';

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
}

export class WorktreeManager {
  private readonly quotaBytes: number;

  constructor(private readonly worktreeRoot: string, quotaBytes = 10 * 1024 * 1024 * 1024) {
    this.quotaBytes = quotaBytes;
  }

  private runDirectory(runId: string): string {
    return resolve(this.worktreeRoot, safeName(runId));
  }

  private integrationIdentity(runId: string, generation: number): { path: string; branch: string } {
    const runKey = safeName(runId);
    return {
      path: resolve(this.worktreeRoot, runKey, `_integration-g${generation}`),
      branch: `loop/${runKey}/integration-g${generation}`
    };
  }

  private async directorySize(path: string): Promise<number> {
    let total = 0;
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) total += await this.directorySize(child);
      else if (entry.isFile()) total += (await stat(child)).size;
    }
    return total;
  }

  async storageUsage(): Promise<{ usedBytes: number; quotaBytes: number; ratio: number }> {
    const usedBytes = await this.directorySize(this.worktreeRoot);
    return { usedBytes, quotaBytes: this.quotaBytes, ratio: this.quotaBytes === 0 ? 1 : usedBytes / this.quotaBytes };
  }

  private async assertCapacity(): Promise<void> {
    const usage = await this.storageUsage();
    if (usage.usedBytes >= usage.quotaBytes) {
      throw new Error(`WORKTREE_QUOTA_EXCEEDED: 已使用 ${usage.usedBytes} 字节，配额为 ${usage.quotaBytes} 字节`);
    }
  }

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

  async create(runId: string, taskId: string, projectRoot: string, baseRef = 'HEAD', signal?: AbortSignal): Promise<{ path: string; branch: string; reused: boolean }> {
    if (!(await this.isGit(projectRoot))) throw new Error('WORKTREE_NOT_GIT');
    if (!(await this.isClean(projectRoot))) throw new Error('WORKTREE_DIRTY');
    await this.assertCapacity();
    const runKey = safeName(runId);
    const taskKey = safeName(taskId);
    const directory = resolve(this.worktreeRoot, runKey, taskKey);
    const branch = this.branchName(runId, taskId);
    await mkdir(resolve(this.worktreeRoot, runKey), { recursive: true });
    try {
      await stat(directory);
      return { path: directory, branch, reused: true };
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
    return { path: directory, branch, reused: false };
  }

  async mergeInto(worktreePath: string, branch: string, signal?: AbortSignal): Promise<void> {
    const result = await runProcess(`git merge --no-ff '${branch.replace(/'/g, "''")}' -m 'loop: merge ${safeName(branch)}'`, worktreePath, signal);
    if (result.code !== 0) {
      await runProcess('git merge --abort', worktreePath);
      throw new Error(`WORKTREE_CONFLICT: ${branch}\n${result.output}`);
    }
  }

  async commit(
    worktreePath: string,
    taskId: string,
    taskScopes: readonly string[] = [],
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const expectedHead = await this.head(worktreePath, signal);
    const changedPaths = await assertGitChangesWithinTaskScope(worktreePath, taskScopes, signal);
    if (changedPaths.length === 0) return expectedHead;
    for (let index = 0; index < changedPaths.length; index += 100) {
      const batch = changedPaths.slice(index, index + 100);
      const staged = await runExecutable('git', ['add', '--', ...batch], worktreePath, signal);
      if (staged.code !== 0) throw new Error(`WORKTREE_COMMIT_FAILED: 无法暂存任务路径。\n${staged.output}`);
    }
    const headAfterStaging = await this.head(worktreePath, signal);
    if (headAfterStaging !== expectedHead) {
      throw new Error(`WORKTREE_ARTIFACT_DRIFT: 暂存期间 HEAD 从 ${expectedHead} 变化为 ${headAfterStaging}`);
    }
    await assertGitChangesWithinTaskScope(worktreePath, taskScopes, signal);
    const status = await runExecutable('git', ['status', '--porcelain'], worktreePath, signal);
    if (status.code !== 0) throw new Error(`WORKTREE_COMMIT_FAILED: ${status.output}`);
    if (!status.output.trim()) return expectedHead;
    const result = await runExecutable(
      'git',
      ['commit', '--only', '-m', `loop: complete ${safeName(taskId)}`, '--', ...changedPaths],
      worktreePath,
      signal
    );
    if (result.code !== 0) throw new Error(`WORKTREE_COMMIT_FAILED: ${result.output}`);
    const revision = await runExecutable('git', ['rev-parse', 'HEAD'], worktreePath, signal);
    return revision.output.trim();
  }

  async captureTaskVerification(
    worktreePath: string,
    taskScopes: readonly string[] = [],
    signal?: AbortSignal
  ): Promise<TaskVerificationSnapshot> {
    return captureTaskVerificationSnapshot(worktreePath, taskScopes, signal);
  }

  async assertTaskVerification(
    worktreePath: string,
    snapshot: TaskVerificationSnapshot,
    signal?: AbortSignal
  ): Promise<string[]> {
    return assertTaskVerificationSnapshot(worktreePath, snapshot, signal);
  }

  async integrate(
    runId: string,
    projectRoot: string,
    targets: Array<{ branch: string; commitSha: string }>,
    baseRef: string,
    generation: number,
    taskScopes: readonly string[] = [],
    signal?: AbortSignal
  ): Promise<{
    path: string;
    branch: string;
    verification: string[];
    verificationCommands: string[];
    headCommit: string;
    baseCommit: string;
    files: string[];
    diffStat: string;
  }> {
    if (!(await this.isGit(projectRoot))) throw new Error('PROJECT_NOT_GIT');
    if (!(await this.isClean(projectRoot))) throw new Error('WORKTREE_DIRTY');
    await this.assertCapacity();
    const { path: directory, branch } = this.integrationIdentity(runId, generation);
    await mkdir(this.runDirectory(runId), { recursive: true });
    let directoryExists = false;
    try {
      await stat(directory);
      directoryExists = true;
    } catch {
      // Create or restore the integration worktree below.
    }
    if (!directoryExists) {
      const branchExists = (await runProcess(`git show-ref --verify --quiet 'refs/heads/${branch}'`, projectRoot, signal)).code === 0;
      if (branchExists) {
        throw new Error('WORKTREE_RECOVERY_REQUIRED: 检测到未登记的既有集成分支，拒绝自动复用');
      }
      const create = await runProcess(
        `git worktree add -b '${branch}' '${directory.replace(/'/g, "''")}' '${baseRef.replace(/'/g, "''")}'`,
        projectRoot,
        signal
      );
      if (create.code !== 0) throw new Error(`INTEGRATION_CREATE_FAILED: ${create.output}`);
    } else {
      throw new Error('WORKTREE_RECOVERY_REQUIRED: 检测到未完成的既有集成 worktree，需人工核对后再处理');
    }
    const uniqueTargets = [...new Map(targets.map((target) => [target.commitSha, target])).values()]
      .filter((target) => target.branch !== branch);
    for (const { branch: taskBranch, commitSha } of uniqueTargets) {
      if (!/^loop\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(taskBranch)) {
        throw new Error(`WORKTREE_CONFLICT: 非法任务分支 ${taskBranch}`);
      }
      if (!/^[0-9a-f]{40,64}$/i.test(commitSha)) throw new Error(`WORKTREE_CONFLICT: 非法任务提交 ${commitSha}`);
      const branchHead = await runProcess(`git rev-parse 'refs/heads/${taskBranch.replace(/'/g, "''")}'`, projectRoot, signal);
      if (branchHead.code !== 0 || branchHead.output.trim() !== commitSha) {
        throw new Error(`WORKTREE_ARTIFACT_DRIFT: ${taskBranch} 当前 HEAD 与登记提交 ${commitSha} 不一致`);
      }
      const merge = await runProcess(`git merge --no-ff '${commitSha}' -m 'loop: integrate ${safeName(taskBranch)}'`, directory, signal);
      if (merge.code !== 0) {
        await runProcess('git merge --abort', directory);
        throw new Error(`WORKTREE_CONFLICT: ${taskBranch}\n${merge.output}`);
      }
    }
    const integratedHead = (await runProcess('git rev-parse HEAD', directory, signal)).output.trim();
    const resolvedBase = (await runProcess(`git rev-parse '${baseRef.replace(/'/g, "''")}'`, directory, signal)).output.trim();
    const filesResult = await runProcess(`git diff --name-only --no-renames '${resolvedBase.replace(/'/g, "''")}..${integratedHead.replace(/'/g, "''")}' --`, directory, signal);
    if (filesResult.code !== 0) throw new Error(`INTEGRATION_SCOPE_CHECK_FAILED: ${filesResult.output}`);
    const files = filesResult.output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    const pathPolicy = await loadRepositoryPathPolicy(directory);
    for (const path of files) {
      pathPolicy.assertWritable(path);
      if (taskScopes.length > 0 && !pathWithinTaskScope(path, [...taskScopes])) {
        throw new Error(`TOOL_SCOPE_VIOLATION: 集成交付包含任务作用域外文件 ${path}`);
      }
    }
    const cleanBefore = await runProcess('git status --porcelain', directory, signal);
    if (cleanBefore.code !== 0 || cleanBefore.output.trim()) {
      throw new Error('INTEGRATION_VERIFY_FAILED: 验证前集成 worktree 不是干净状态');
    }
    const verificationScripts = await this.availableVerificationScripts(directory);
    const verificationCommands = verificationScripts.map((script) => `npm.cmd run ${script}`);
    const verification: string[] = [];
    for (const script of verificationScripts) {
      const command = `npm.cmd run ${script}`;
      const result = await runNpmScript(script, [], directory, signal);
      verification.push(`${command}: ${result.code === 0 ? 'passed' : 'failed'}\n${result.output.slice(-4000)}`);
      if (result.code !== 0) throw new Error(`INTEGRATION_VERIFY_FAILED: ${command}\n${result.output}`);
    }
    const headCommit = (await runProcess('git rev-parse HEAD', directory, signal)).output.trim();
    const cleanAfter = await runProcess('git status --porcelain', directory, signal);
    if (headCommit !== integratedHead || cleanAfter.code !== 0 || cleanAfter.output.trim()) {
      throw new Error('INTEGRATION_VERIFY_MUTATED: 验证脚本改变了集成提交或留下未提交文件，结果不予采信');
    }
    const statResult = await runProcess(`git diff --stat '${resolvedBase.replace(/'/g, "''")}..${headCommit.replace(/'/g, "''")}'`, directory, signal);
    return {
      path: directory,
      branch,
      verification,
      verificationCommands,
      headCommit,
      baseCommit: resolvedBase,
      files,
      diffStat: statResult.output.trim()
    };
  }

  private async availableVerificationScripts(root: string): Promise<SupportedNpmScript[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    } catch (error) {
      throw new Error(`INTEGRATION_VERIFY_UNAVAILABLE: 无法读取 package.json：${error instanceof Error ? error.message : String(error)}`);
    }
    const scripts = parsed && typeof parsed === 'object' && 'scripts' in parsed
      ? (parsed as { scripts?: unknown }).scripts
      : undefined;
    const scriptRecord = scripts && typeof scripts === 'object' && !Array.isArray(scripts)
      ? scripts as Record<string, unknown>
      : {};
    const scriptsToRun = (['typecheck', 'lint', 'test', 'build'] as const)
      .filter((script) => typeof scriptRecord[script] === 'string' && String(scriptRecord[script]).trim().length > 0);
    if (scriptsToRun.length === 0) {
      throw new Error('INTEGRATION_VERIFY_UNAVAILABLE: package.json 未声明 typecheck、lint、test 或 build 验证脚本');
    }
    return scriptsToRun;
  }

  async head(root: string, signal?: AbortSignal): Promise<string> {
    const result = await runProcess('git rev-parse HEAD', root, signal);
    if (result.code !== 0) throw new Error(`WORKTREE_NOT_GIT: ${result.output}`);
    return result.output.trim();
  }

  async assertTaskReference(worktreePath: string, branch: string, expectedCommit: string, signal?: AbortSignal): Promise<void> {
    if (!/^[0-9a-f]{40,64}$/i.test(expectedCommit)) throw new Error('WORKTREE_CONFLICT: 任务登记提交格式无效');
    const currentBranch = await this.currentBranch(worktreePath, signal);
    const currentHead = await this.head(worktreePath, signal);
    if (currentBranch !== branch || currentHead !== expectedCommit) {
      throw new Error(`WORKTREE_ARTIFACT_DRIFT: 任务 worktree 当前 ${currentBranch}@${currentHead} 与登记 ${branch}@${expectedCommit} 不一致`);
    }
  }

  async currentBranch(root: string, signal?: AbortSignal): Promise<string> {
    const result = await runProcess('git symbolic-ref --quiet --short HEAD', root, signal);
    const branch = result.output.trim();
    if (result.code !== 0 || !branch) throw new Error('WORKTREE_DETACHED_HEAD: 最终合并要求根工作区位于具名分支');
    return branch;
  }

  async assertIntegrationReference(projectRoot: string, branch: string, expectedCommit: string, runId: string, signal?: AbortSignal): Promise<void> {
    const expectedPrefix = `loop/${safeName(runId)}/integration-g`;
    if (!branch.startsWith(expectedPrefix)) throw new Error('WORKTREE_CONFLICT: 集成分支不属于当前运行');
    if (!/^[0-9a-f]{40,64}$/i.test(expectedCommit)) throw new Error('WORKTREE_CONFLICT: 集成提交格式无效');
    const branchHead = await runProcess(`git rev-parse 'refs/heads/${branch.replace(/'/g, "''")}'`, projectRoot, signal);
    if (branchHead.code !== 0 || branchHead.output.trim() !== expectedCommit) {
      throw new Error(`WORKTREE_ARTIFACT_DRIFT: 集成分支 HEAD 与已验证提交 ${expectedCommit} 不一致`);
    }
  }

  async mergeAccepted(
    projectRoot: string,
    branch: string,
    expectedCommit: string,
    expectedBase: string,
    expectedTargetBranch: string,
    runId: string,
    signal?: AbortSignal
  ): Promise<string> {
    if (!(await this.isClean(projectRoot))) throw new Error('WORKTREE_DIRTY');
    const currentBranch = await this.currentBranch(projectRoot, signal);
    if (currentBranch !== expectedTargetBranch) {
      throw new Error(`WORKTREE_TARGET_DRIFT: 当前分支 ${currentBranch} 与审批目标 ${expectedTargetBranch} 不一致`);
    }
    const currentHead = (await runProcess('git rev-parse HEAD', projectRoot, signal)).output.trim();
    if (currentHead !== expectedBase) {
      throw new Error(`WORKTREE_BASE_DRIFT: 当前 HEAD ${currentHead} 与运行基线 ${expectedBase} 不一致`);
    }
    await this.assertIntegrationReference(projectRoot, branch, expectedCommit, runId, signal);
    const merge = await runProcess(`git merge --no-ff '${expectedCommit}' -m 'loop: accept ${safeName(runId)}'`, projectRoot, signal);
    if (merge.code !== 0) {
      await runProcess('git merge --abort', projectRoot);
      throw new Error(`WORKTREE_CONFLICT: 验收合并失败\n${merge.output}`);
    }
    return (await runProcess('git rev-parse HEAD', projectRoot, signal)).output.trim();
  }

  async reconcileAcceptedMerge(
    projectRoot: string,
    expectedBase: string,
    expectedCommit: string,
    expectedTargetBranch: string,
    runId: string,
    signal?: AbortSignal
  ): Promise<{ status: 'pending' | 'completed' | 'unknown'; mergeCommit?: string }> {
    const currentBranch = await this.currentBranch(projectRoot, signal);
    if (currentBranch !== expectedTargetBranch) return { status: 'unknown' };
    const currentHead = (await runProcess('git rev-parse HEAD', projectRoot, signal)).output.trim();
    if (currentHead === expectedBase) return { status: 'pending' };
    const parents = await runProcess('git show -s --format=%P HEAD', projectRoot, signal);
    const subject = await runProcess('git show -s --format=%s HEAD', projectRoot, signal);
    const [firstParent, secondParent, ...extraParents] = parents.output.trim().split(/\s+/).filter(Boolean);
    if (
      parents.code === 0
      && subject.code === 0
      && firstParent === expectedBase
      && secondParent === expectedCommit
      && extraParents.length === 0
      && subject.output.trim() === `loop: accept ${safeName(runId)}`
    ) {
      return { status: 'completed', mergeCommit: currentHead };
    }
    return { status: 'unknown' };
  }

  async listRegisteredPaths(runId: string): Promise<string[]> {
    const root = this.runDirectory(runId);
    try {
      return (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => resolve(root, entry.name))
        .filter((path) => relative(this.worktreeRoot, path).split(/[\\/]/).every((part) => part !== '..'));
    } catch {
      return [];
    }
  }

  async cleanupArtifact(projectRoot: string, artifactPath: string, expectedCommit?: string, signal?: AbortSignal): Promise<void> {
    const relation = relative(this.worktreeRoot, resolve(artifactPath));
    if (!relation || relation === '..' || relation.startsWith('..\\') || relation.startsWith('../')) {
      throw new Error('WORKTREE_CONFLICT: 清理目标不在 Loop worktree 根目录内');
    }
    try {
      await stat(artifactPath);
    } catch {
      await runProcess('git worktree prune', projectRoot, signal);
      return;
    }
    const realRoot = await realpath(this.worktreeRoot);
    const realArtifact = await realpath(artifactPath);
    const realRelation = relative(realRoot, realArtifact);
    if (!realRelation || realRelation === '..' || realRelation.startsWith('..\\') || realRelation.startsWith('../')) {
      throw new Error('WORKTREE_CONFLICT: worktree 的真实路径超出 Loop 根目录');
    }
    const status = await runProcess('git status --porcelain', realArtifact, signal);
    if (status.code !== 0) throw new Error(`WORKTREE_CLEANUP_FAILED: 无法确认 worktree 状态\n${status.output}`);
    if (status.output.trim()) throw new Error('WORKTREE_DIRTY: worktree 含未提交改动，拒绝自动清理');
    if (expectedCommit) {
      if (!/^[0-9a-f]{40,64}$/i.test(expectedCommit)) throw new Error('WORKTREE_CLEANUP_FAILED: 登记提交格式无效');
      const head = await runProcess('git rev-parse HEAD', realArtifact, signal);
      if (head.code !== 0 || head.output.trim() !== expectedCommit) {
        throw new Error(`WORKTREE_ARTIFACT_DRIFT: worktree HEAD 与登记提交 ${expectedCommit} 不一致，拒绝清理`);
      }
    }
    const escaped = realArtifact.replace(/'/g, "''");
    const result = await runProcess(`git worktree remove '${escaped}'`, projectRoot, signal);
    if (result.code !== 0) throw new Error(`WORKTREE_CLEANUP_FAILED: ${result.output}`);
    await runProcess('git worktree prune', projectRoot, signal);
  }

  async listLoopBranches(projectRoot: string, signal?: AbortSignal): Promise<string[]> {
    const result = await runProcess("git for-each-ref --format='%(refname:short)' 'refs/heads/loop/*'", projectRoot, signal);
    if (result.code !== 0) return [];
    return result.output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }
}
