import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

export class PathPolicyError extends Error {
  constructor(readonly code: 'INVALID_PATH' | 'PATH_ESCAPE', message: string) {
    super(message);
  }
}

const windowsAds = /(^|[\\/])[^\\/:]+:[^\\/]+/;

export async function resolveProjectPath(root: string, candidate: string, forWrite = false): Promise<string> {
  if (candidate.includes('\0') || windowsAds.test(candidate)) {
    throw new PathPolicyError('INVALID_PATH', '路径包含不允许的字符或 Windows ADS。');
  }
  if (/^\\\\/.test(candidate) && !/^\\\\/.test(root)) {
    throw new PathPolicyError('PATH_ESCAPE', '项目未授权 UNC 路径。');
  }

  const realRoot = await realpath(root);
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(realRoot, candidate);
  const relation = relative(realRoot, absolute);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new PathPolicyError('PATH_ESCAPE', '目标路径超出项目根目录。');
  }

  try {
    const resolved = await realpath(absolute);
    const realRelation = relative(realRoot, resolved);
    if (realRelation === '..' || realRelation.startsWith(`..${sep}`) || isAbsolute(realRelation)) {
      throw new PathPolicyError('PATH_ESCAPE', '符号链接或 junction 指向项目外部。');
    }
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new PathPolicyError('PATH_ESCAPE', '不允许直接操作符号链接。');
    return resolved;
  } catch (error) {
    if (error instanceof PathPolicyError) throw error;
    if (!forWrite) throw error;
    const parent = resolve(absolute, '..');
    const realParent = await realpath(parent);
    const parentRelation = relative(realRoot, realParent);
    if (parentRelation === '..' || parentRelation.startsWith(`..${sep}`) || isAbsolute(parentRelation)) {
      throw new PathPolicyError('PATH_ESCAPE', '新文件父目录超出项目根目录。');
    }
    return absolute;
  }
}

export interface PolicyDecision {
  decision: 'allow' | 'approval' | 'deny';
  risk: 'low' | 'medium' | 'high' | 'critical';
  reason: string;
}

const safeCommands = [
  /^git\s+(status|diff)(\s|$)/i,
  /^npm\.cmd\s+(test|run\s+(test|typecheck|lint|build))(\s|$)/i,
  /^rg(\.exe)?\s/i
];
const hardDenied = [
  /Remove-Item\s+.*(-Recurse.*-Force|-Force.*-Recurse)/i,
  /format(\.com)?\s+[a-z]:/i,
  /git\s+push\s+.*--force/i,
  /\b(runAs|Start-Process\s+.*-Verb\s+RunAs)\b/i,
  /\b(cmdkey|Get-Credential|vaultcmd)\b/i
];

export function evaluateCommand(command: string, autoMode: boolean): PolicyDecision {
  if (hardDenied.some((pattern) => pattern.test(command))) {
    return { decision: 'deny', risk: 'critical', reason: '命令触发不可绕过的硬安全规则。' };
  }
  if (safeCommands.some((pattern) => pattern.test(command))) {
    return { decision: 'allow', risk: 'low', reason: '只读或文档批准的验证命令。' };
  }
  if (autoMode) return { decision: 'allow', risk: 'medium', reason: '项目内全自动模式。' };
  return { decision: 'approval', risk: 'high', reason: '未知、联网、安装或可能改变工作区的命令需要批准。' };
}

export function runProcess(command: string, cwd: string, signal?: AbortSignal): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      cwd, windowsHide: true, signal
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? -1, output: output.slice(-100_000) }));
  });
}

