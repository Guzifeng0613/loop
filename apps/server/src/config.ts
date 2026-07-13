import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(moduleDirectory, '../../..');

const localAppData = process.env.LOCALAPPDATA ?? resolve(repoRoot, '.loop');
export const dataDirectory = process.env.LOOP_DATA_DIR ?? resolve(localAppData, 'Loop');
mkdirSync(dataDirectory, { recursive: true });

export const config = {
  host: '127.0.0.1',
  port: Number(process.env.LOOP_PORT ?? 4317),
  webOrigin: process.env.LOOP_WEB_ORIGIN ?? 'http://127.0.0.1:5173',
  databasePath: process.env.LOOP_DATABASE_PATH ?? resolve(dataDirectory, 'loop.db'),
  defaultProjectRoot: process.env.LOOP_DEFAULT_PROJECT ?? repoRoot,
  sessionToken: randomBytes(32).toString('base64url')
};

