import { fileURLToPath } from 'node:url';

// All Git subprocesses in this test or replay own disposable checkouts.
// Remove hook routing and private config while preserving tool discovery on PATH.
for (const key of Object.keys(process.env)) {
  if (/^GIT_/i.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: fileURLToPath(new URL('./git-defaults.conf', import.meta.url)),
  GIT_ATTR_NOSYSTEM: '1'
});
