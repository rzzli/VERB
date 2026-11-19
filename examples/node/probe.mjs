import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Execute the actual built CLI. Do not read source text or reimplement its greeting logic.
const origin = path.resolve(process.env.VERB_ROOT, 'dist', 'greeter.cjs');
function observe(input) {
  const child = spawnSync(process.execPath, [origin, JSON.stringify(input)], {
    encoding: 'utf8', windowsHide: true, timeout: 5000
  });
  if (child.error || child.status !== 0) throw Error(child.error?.message || child.stderr || 'Greeter did not complete');
  const result = JSON.parse(child.stdout);
  if (typeof result.greeting !== 'string' || typeof result.version !== 'string') throw Error('Invalid Greeter output');
  return result;
}
const empty = observe({ displayName: '' });
const missing = observe({});
const named = observe({ displayName: 'Ada' });
if (new Set([empty.version, missing.version, named.version]).size !== 1) throw Error('Inconsistent build versions');
console.log(JSON.stringify({ origin, observations: {
  'empty name': empty.greeting,
  'missing name': missing.greeting,
  'named person': named.greeting,
  'build version': empty.version
} }));
