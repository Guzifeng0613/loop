import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import type { AppSettings, Project } from '@loop/contracts';
import {
  assertTaskVerificationSnapshot,
  assertRepositoryContentSafe,
  captureTaskVerificationSnapshot,
  evaluateStructuredCommand,
  loadRepositoryPathPolicy,
  markUntrustedRepositoryContent,
  parseStructuredCommand,
  pathWithinTaskScope,
  PathPolicyError,
  resolveProjectPath,
  resolveWritableProjectPath,
  runExecutable,
  runNpmScript,
  type PolicyDecision,
  type StructuredCommand
} from './security.js';

export type WorkspaceToolName = 'list_files' | 'read_file' | 'search_text' | 'write_file' | 'run_command' | 'git_status';

export interface ToolCallContext {
  project: Project;
  workspaceRoot?: string;
  taskScope?: string[];
  settings: AppSettings;
}

export interface ToolOutcome {
  ok: boolean;
  output: string;
  policy: PolicyDecision;
}

export class WorkspaceTools {
  evaluate(name: WorkspaceToolName, args: Record<string, unknown>, _settings: AppSettings): PolicyDecision {
    if (name === 'run_command') return evaluateStructuredCommand(args);
    if (name === 'search_text') {
      return evaluateStructuredCommand({
        command: {
          kind: 'search',
          query: args.query,
          path: args.path,
          maxResults: args.maxResults
        }
      });
    }
    if (name === 'write_file') {
      return {
        decision: 'allow',
        risk: 'medium',
        ruleKey: 'write:task-scope',
        reason: '批准任务作用域内的项目文件写入。',
        reusable: true
      };
    }
    return {
      decision: 'allow',
      risk: 'low',
      ruleKey: `read:${name}`,
      reason: '通过数据外发策略检查的项目内只读工具。',
      reusable: true
    };
  }

  async execute(
    name: WorkspaceToolName,
    args: Record<string, unknown>,
    context: ToolCallContext,
    signal?: AbortSignal,
    approvalGranted = false
  ): Promise<ToolOutcome> {
    const root = context.workspaceRoot ?? context.project.rootPath;
    const evaluated = this.evaluate(name, args, context.settings);
    const policy: PolicyDecision = approvalGranted && evaluated.decision === 'approval'
      ? {
          decision: 'allow',
          risk: evaluated.risk,
          ruleKey: evaluated.ruleKey,
          reason: '用户已批准本次工具调用。',
          reusable: evaluated.reusable
        }
      : evaluated;
    if (policy.decision !== 'allow') return { ok: false, output: policy.reason, policy };
    if (name === 'write_file' && (!context.taskScope?.length || !pathWithinTaskScope(String(args.path ?? ''), context.taskScope))) {
      const denied: PolicyDecision = {
        decision: 'deny',
        risk: 'high',
        ruleKey: 'write:outside-task-scope',
        reason: '写入路径不在当前任务声明的作用域内。',
        reusable: false
      };
      return { ok: false, output: 'TOOL_SCOPE_VIOLATION: 写入路径不在当前任务作用域内。', policy: denied };
    }

    try {
      if (name === 'list_files') {
        const readPolicy = await loadRepositoryPathPolicy(root);
        const target = await resolveProjectPath(root, String(args.path ?? '.'));
        readPolicy.assertAllowed(readPolicy.relativePath(target));
        const entries = await readdir(target, { withFileTypes: true });
        const visibleEntries = entries.filter((entry) =>
          readPolicy.isAllowed(readPolicy.relativePath(resolve(target, entry.name)))
        );
        return {
          ok: true,
          output: this.repositoryOutput(
            visibleEntries.slice(0, 500).map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`).join('\n')
          ),
          policy
        };
      }

      if (name === 'read_file') {
        const readPolicy = await loadRepositoryPathPolicy(root);
        const target = await resolveProjectPath(root, String(args.path ?? ''));
        readPolicy.assertAllowed(readPolicy.relativePath(target));
        const content = await readFile(target, 'utf8');
        assertRepositoryContentSafe(content);
        const requestedMax = Number(args.maxChars ?? 80_000);
        const maxChars = Number.isFinite(requestedMax) ? Math.max(1, Math.min(requestedMax, 160_000)) : 80_000;
        return { ok: true, output: this.repositoryOutput(content.slice(0, maxChars)), policy };
      }

      if (name === 'search_text') {
        const command: StructuredCommand = {
          kind: 'search',
          query: String(args.query ?? ''),
          ...(args.path === undefined ? {} : { path: String(args.path) }),
          ...(args.maxResults === undefined ? {} : { maxResults: Number(args.maxResults) })
        };
        return await this.executeSearch(command, root, policy, signal);
      }

      if (name === 'write_file') {
        const target = await resolveWritableProjectPath(root, String(args.path ?? ''));
        const content = String(args.content ?? '');
        await mkdir(dirname(target), { recursive: true });
        const temp = resolve(dirname(target), `.${basename(target)}.${randomUUID()}.loop-tmp`);
        let renamed = false;
        try {
          await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
          await rename(temp, target);
          renamed = true;
        } finally {
          if (!renamed) await rm(temp, { force: true });
        }
        return { ok: true, output: `已原子写入 ${relative(root, target)}（${content.length} 字符）`, policy };
      }

      if (name === 'git_status') return await this.executeGitStatus(root, policy, signal);
      return await this.executeStructuredCommand(
        parseStructuredCommand(args, approvalGranted),
        root,
        policy,
        context.taskScope,
        signal
      );
    } catch (error) {
      if (error instanceof PathPolicyError) throw error;
      if (signal?.aborted) throw error;
      return { ok: false, output: `TOOL_ERROR: ${error instanceof Error ? error.message : String(error)}`, policy };
    }
  }

  private repositoryOutput(content: string): string {
    assertRepositoryContentSafe(content);
    return markUntrustedRepositoryContent(content);
  }

  private async executeStructuredCommand(
    command: StructuredCommand,
    root: string,
    policy: PolicyDecision,
    taskScopes?: readonly string[],
    signal?: AbortSignal
  ): Promise<ToolOutcome> {
    if (command.kind === 'git_status') return this.executeGitStatus(root, policy, signal);
    if (command.kind === 'git_diff') return this.executeGitDiff(command, root, policy, signal);
    if (command.kind === 'search') return this.executeSearch(command, root, policy, signal);

    if (!taskScopes?.length) throw new Error('TOOL_SCOPE_VIOLATION: npm 验证缺少任务作用域。');
    const snapshot = await captureTaskVerificationSnapshot(root, taskScopes, signal);
    const result = await runNpmScript(command.script, command.args ?? [], root, signal);
    await assertTaskVerificationSnapshot(root, snapshot, signal);
    return {
      ok: result.code === 0,
      output: this.repositoryOutput(result.output || `退出码 ${result.code}`),
      policy
    };
  }

  private async executeGitStatus(root: string, policy: PolicyDecision, signal?: AbortSignal): Promise<ToolOutcome> {
    const result = await runExecutable('git', ['status', '--short', '--branch'], root, signal);
    let output = result.output || `退出码 ${result.code}`;
    if (result.code === 0) {
      const readPolicy = await loadRepositoryPathPolicy(root);
      output = output
        .split(/\r?\n/)
        .filter((line) => {
          if (!line || line.startsWith('## ')) return true;
          const displayedPaths = line.slice(3).split(' -> ').map((path) => path.replace(/^"|"$/g, ''));
          return displayedPaths.every((path) => readPolicy.isAllowed(path));
        })
        .join('\n');
    }
    return {
      ok: result.code === 0,
      output: this.repositoryOutput(output),
      policy
    };
  }

  private async executeGitDiff(
    command: Extract<StructuredCommand, { kind: 'git_diff' }>,
    root: string,
    policy: PolicyDecision,
    signal?: AbortSignal
  ): Promise<ToolOutcome> {
    const readPolicy = await loadRepositoryPathPolicy(root);
    let requestedPath = '.';
    if (command.path !== undefined) {
      const target = await resolveProjectPath(root, command.path, true);
      requestedPath = readPolicy.relativePath(target);
      readPolicy.assertAllowed(requestedPath);
    }

    const modeArgs = command.staged ? ['--cached'] : [];
    const names = await runExecutable(
      'git',
      ['diff', ...modeArgs, '--name-only', '-z', '--', requestedPath],
      root,
      signal
    );
    if (names.code !== 0) {
      return { ok: false, output: this.repositoryOutput(names.output || `退出码 ${names.code}`), policy };
    }

    const allowedFiles = names.output
      .split('\0')
      .filter(Boolean)
      .filter((path) => !/[\0\r\n;&|<>`"'()]|\$\(/.test(path) && readPolicy.isAllowed(path))
      .slice(0, 200);
    if (allowedFiles.length === 0) return { ok: true, output: this.repositoryOutput('没有可公开的差异。'), policy };

    const result = await runExecutable('git', ['diff', ...modeArgs, '--', ...allowedFiles], root, signal);
    return {
      ok: result.code === 0,
      output: this.repositoryOutput(result.output || `退出码 ${result.code}`),
      policy
    };
  }

  private async executeSearch(
    command: Extract<StructuredCommand, { kind: 'search' }>,
    root: string,
    policy: PolicyDecision,
    signal?: AbortSignal
  ): Promise<ToolOutcome> {
    const readPolicy = await loadRepositoryPathPolicy(root);
    const target = await resolveProjectPath(root, command.path ?? '.');
    const searchPath = readPolicy.relativePath(target);
    readPolicy.assertAllowed(searchPath);

    const rgArgs = [
      '--line-number',
      '--hidden',
      '--fixed-strings',
      '--glob', '!node_modules/**',
      '--glob', '!dist/**',
      '--glob', '!.git/**',
      '--glob', '!**/.git/**',
      '--glob', '!.env*',
      '--glob', '!**/.env*',
      '--glob', '!**/.ssh/**',
      '--glob', '!**/.aws/**',
      '--glob', '!**/.azure/**',
      '--glob', '!**/.kube/**',
      '--glob', '!**/.gnupg/**',
      '--glob', '!**/*.{pem,key,p12,pfx,jks,keystore,kdbx}',
      '--glob', '!**/{credential,credentials,secret,secrets}*'
    ];
    if (readPolicy.loopIgnorePath) rgArgs.push('--ignore-file', readPolicy.loopIgnorePath);
    rgArgs.push('--', command.query, searchPath);

    const result = await runExecutable('rg', rgArgs, root, signal);
    const maxResults = command.maxResults ?? 200;
    const limited = result.output
      .split(/\r?\n/)
      .filter((line) => {
        const separator = line.indexOf(':');
        return separator <= 0 || readPolicy.isAllowed(line.slice(0, separator));
      })
      .slice(0, maxResults)
      .join('\n')
      .slice(0, 80_000);
    return {
      ok: result.code === 0 || result.code === 1,
      output: this.repositoryOutput(limited),
      policy
    };
  }
}
