import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const project = fileURLToPath(new URL('../', import.meta.url));
export const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verb gate ')));
export const clean = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
export const write = (file, data) => fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
export function cmd(cwd, exe, args) {
  const p = spawnSync(exe, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  assert.ifError(p.error);
  assert.equal(p.status, 0, p.stderr + p.stdout);
  return p.stdout.trim();
}
export function verb(cwd, code, ...args) {
  const p = spawnSync(process.execPath, [path.join(project, 'bin/verb.js'), ...args, '--json'],
    { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  assert.ifError(p.error);
  const result = JSON.parse(p.stdout || p.stderr);
  assert.equal(p.status, code, JSON.stringify(result, null, 2));
  assert.equal(result.verdict, ['verified', 'failed', 'inconclusive'][code]);
  return result;
}
