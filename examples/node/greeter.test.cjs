const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.join(__dirname, 'dist', 'greeter.cjs');
function run(argument) {
  const child = spawnSync(process.execPath, [cli, argument], {
    encoding: 'utf8', windowsHide: true, timeout: 5000
  });
  assert.ifError(child.error);
  return child;
}
for (const [input, expected] of [
  [{ displayName: '' }, 'Hello, !'],
  [{}, 'Hello, Guest!'],
  [{ displayName: null }, 'Hello, Guest!'],
  [{ displayName: 'Ada' }, 'Hello, Ada!']
]) {
  test('greeting for ' + JSON.stringify(input), () => {
    const child = run(JSON.stringify(input));
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.greeting, expected);
    assert.ok(result.version.length > 0);
  });
}
test('malformed input fails instead of producing a greeting', () => {
  for (const input of ['not JSON', '[]', '{"displayName":42}']) {
    const child = run(input);
    assert.equal(child.status, 2);
    assert.equal(child.stdout, '');
    assert.match(child.stderr, /Expected one JSON object/);
  }
});
