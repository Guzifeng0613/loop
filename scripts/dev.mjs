import { spawn } from 'node:child_process';
import net from 'node:net';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const node = process.execPath;
const tsx = resolve(root, 'node_modules/tsx/dist/cli.mjs');
const vite = resolve(root, 'node_modules/vite/bin/vite.js');
const taskkill = resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
let shuttingDown = false;
const children = [];

function startChild(name, command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: ['inherit', 'pipe', 'pipe'], env: process.env });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', (code, signal) => {
    if (code && !shuttingDown) {
      shuttingDown = true;
      stopAll(code, signal);
    }
  });
  children.push(child);
  return child;
}

function stopAll(exitCode = 0, signal) {
  for (const child of children) {
    if (child.killed || child.exitCode !== null || child.pid === undefined) continue;
    if (process.platform === 'win32') {
      // Node signals do not reliably terminate process trees on Windows.
      // taskkill /T keeps Vite/tsx children from surviving Ctrl+C or a peer crash.
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', () => child.kill(signal ?? 'SIGTERM'));
    } else {
      child.kill(signal ?? 'SIGTERM');
    }
  }
  if (signal || exitCode !== 0) process.exitCode = exitCode || 1;
}

function waitForPort(port, host, timeoutMs = 15_000) {
  const startedAt = Date.now();
  return new Promise((resolvePromise, reject) => {
    const probe = () => {
      const socket = net.createConnection({ port, host });
      socket.once('connect', () => { socket.destroy(); resolvePromise(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) reject(new Error(`服务端口 ${host}:${port} 启动超时`));
        else globalThis.setTimeout(probe, 100);
      });
    };
    probe();
  });
}

process.on('SIGINT', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopAll(0, 'SIGINT');
});
process.on('SIGTERM', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopAll(0, 'SIGTERM');
});

startChild('server', node, [tsx, 'src/index.ts'], resolve(root, 'apps/server'));
try {
  await waitForPort(4317, '127.0.0.1');
  startChild('web', node, [vite, '--host', '127.0.0.1'], resolve(root, 'apps/web'));
} catch (error) {
  shuttingDown = true;
  stopAll(1);
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
