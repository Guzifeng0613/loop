import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import type { AppSettings, Project } from '@loop/contracts';
import { evaluateCommand, resolveProjectPath, runProcess, type PolicyDecision } from './security.js';

export type WorkspaceToolName = 'list_files' | 'read_file' | 'search_text' | 'write_file' | 'run_command' | 'git_status';

export interface ToolCallContext {
  project: Project;
  workspaceRoot?: string;
  settings: AppSettings;
}

export interface ToolOutcome {
  ok: boolean;
  output: string;
  policy: PolicyDecision;
}

export class WorkspaceTools {
  evaluate(name: WorkspaceToolName, args: Record<string, unknown>, settings: AppSettings): PolicyDecision {
    if (name === 'run_command') return evaluateCommand(String(args.command ?? ''), settings.autoMode);
    if (name === 'write_file') {
      return { decision: 'allow', risk: 'medium', reason: '批准任务作用域内的项目文件写入。' };
    }
    return { decision: 'allow', risk: 'low', reason: '项目内只读工具。' };
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
      ? { decision: 'allow', risk: evaluated.risk, reason: '用户已批准本次同类工具调用。' }
      : evaluated;
    if (policy.decision !== 'allow') return { ok: false, output: policy.reason, policy };

    if (name === 'list_files') {
      const target = await resolveProjectPath(root, String(args.path ?? '.'));
      const entries = await readdir(target, { withFileTypes: true });
      return {
        ok: true,
        output: entries.slice(0, 500).map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`).join('\n'),
        policy
      };
    }

    if (name === 'read_file') {
      const target = await resolveProjectPath(root, String(args.path ?? ''));
      const content = await readFile(target, 'utf8');
      const maxChars = Math.min(Number(args.maxChars ?? 80_000), 160_000);
      return { ok: true, output: content.slice(0, maxChars), policy };
    }

    if (name === 'search_text') {
      const query = String(args.query ?? '');
      if (!query) return { ok: false, output: 'query 不能为空', policy };
      const escaped = query.replace(/'/g, "''");
      const result = await runProcess(`rg --line-number --hidden --glob '!node_modules' --glob '!dist' -- '${escaped}' .`, root, signal);
      return { ok: result.code === 0 || result.code === 1, output: result.output.slice(0, 80_000), policy };
    }

    if (name === 'write_file') {
      const target = await resolveProjectPath(root, String(args.path ?? ''), true);
      const content = String(args.content ?? '');
      await mkdir(dirname(target), { recursive: true });
      const temp = `${target}.loop-tmp`;
      await writeFile(temp, content, 'utf8');
      await rename(temp, target);
      return { ok: true, output: `已原子写入 ${relative(root, target)}（${content.length} 字符）`, policy };
    }

    const command = name === 'git_status' ? 'git status --short --branch' : String(args.command ?? '');
    const result = await runProcess(command, root, signal);
    return { ok: result.code === 0, output: result.output || `退出码 ${result.code}`, policy };
  }
}
