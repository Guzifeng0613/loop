import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

export class PathPolicyError extends Error {
  constructor(readonly code: 'INVALID_PATH' | 'PATH_ESCAPE', message: string) {
    super(message);
  }
}

const windowsAds = /(^|[\\/])[^\\/:]+:[^\\/]+/;

function isOutside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation);
}

export async function resolveProjectPath(root: string, candidate: string, forWrite = false): Promise<string> {
  if (candidate.includes('\0') || windowsAds.test(candidate)) {
    throw new PathPolicyError('INVALID_PATH', '路径包含不允许的字符或 Windows ADS。');
  }
  if (/^\\\\/.test(candidate) && !/^\\\\/.test(root)) {
    throw new PathPolicyError('PATH_ESCAPE', '项目未授权 UNC 路径。');
  }

  const realRoot = await realpath(root);
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(realRoot, candidate);
  if (isOutside(realRoot, absolute)) {
    throw new PathPolicyError('PATH_ESCAPE', '目标路径超出项目根目录。');
  }

  try {
    const resolved = await realpath(absolute);
    if (isOutside(realRoot, resolved)) {
      throw new PathPolicyError('PATH_ESCAPE', '符号链接或 junction 指向项目外部。');
    }
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new PathPolicyError('PATH_ESCAPE', '不允许直接操作符号链接。');
    return resolved;
  } catch (error) {
    if (error instanceof PathPolicyError) throw error;
    if (!forWrite) throw error;
    let ancestor = dirname(absolute);
    while (true) {
      try {
        const stat = await lstat(ancestor);
        if (stat.isSymbolicLink()) throw new PathPolicyError('PATH_ESCAPE', '新文件父目录包含符号链接。');
        const realAncestor = await realpath(ancestor);
        if (isOutside(realRoot, realAncestor)) {
          throw new PathPolicyError('PATH_ESCAPE', '新文件父目录超出项目根目录。');
        }
        break;
      } catch (ancestorError) {
        if (ancestorError instanceof PathPolicyError) throw ancestorError;
        const parent = dirname(ancestor);
        if (parent === ancestor || isOutside(realRoot, parent)) {
          throw new PathPolicyError('PATH_ESCAPE', '无法在项目边界内验证新文件父目录。');
        }
        ancestor = parent;
      }
    }
    return absolute;
  }
}

export function pathWithinTaskScope(candidate: string, scopes: string[]): boolean {
  if (scopes.length === 0) return false;
  const normalizedCandidate = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
  return scopes.some((scope) => {
    const normalizedScope = scope.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (normalizedScope === '' || normalizedScope === '.') return true;
    return normalizedCandidate === normalizedScope || normalizedCandidate.startsWith(`${normalizedScope}/`);
  });
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
  /Remove-Item\s+.*-Recurse/i,
  /\b(rmdir|rd)\s+\/s\b/i,
  /format(\.com)?\s+[a-z]:/i,
  /git\s+push\s+.*--force/i,
  /\b(runAs|Start-Process\s+.*-Verb\s+RunAs)\b/i,
  /\b(cmdkey|Get-Credential|vaultcmd)\b/i,
  /\$(?:env:(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOME)|HOME)\b/i,
  /(?:^|\s)['"]?(?:[a-z]:[\\/]|\\\\)/i,
  /(?:^|[\\/])\.\.(?:[\\/]|$)/
];
const alwaysApproved = [
  /^npm\.cmd\s+(install|uninstall|update)(\s|$)/i,
  /^git\s+(push|rebase|reset\s+--hard|clean)(\s|$)/i,
  /\b(Invoke-WebRequest|Invoke-RestMethod|curl(?:\.exe)?|wget(?:\.exe)?)\b/i,
  /\b(Remove-Item|del|erase)\b/i
];

export function evaluateCommand(command: string, autoMode: boolean): PolicyDecision {
  if (hardDenied.some((pattern) => pattern.test(command))) {
    return { decision: 'deny', risk: 'critical', reason: '命令触发不可绕过的硬安全规则。' };
  }
  if (safeCommands.some((pattern) => pattern.test(command))) {
    return { decision: 'allow', risk: 'low', reason: '只读或文档批准的验证命令。' };
  }
  if (alwaysApproved.some((pattern) => pattern.test(command))) {
    return { decision: 'approval', risk: 'high', reason: '安装、联网、删除、历史重写或推送命令需要明确批准。' };
  }
  if (autoMode) return { decision: 'approval', risk: 'medium', reason: '全自动模式不能证明未知命令只影响项目边界，需要批准。' };
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
