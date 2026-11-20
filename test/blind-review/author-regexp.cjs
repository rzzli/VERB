// Run the upstream test bodies with their two synchronous AVA assertions.
// A new process loads the actual candidate module for every comparison.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const [testFile, ...selection] = process.argv.slice(2);
const tests = new Map();
const imports = "import test from 'ava';\nimport escapeStringRegexp from '.';\n";
const source = fs.readFileSync(testFile, 'utf8').replaceAll('\r\n', '\n');
assert.ok(source.startsWith(imports), 'Unknown upstream test imports');
vm.runInNewContext(source.slice(imports.length), {
  escapeStringRegexp: require(path.resolve('index.js')),
  test: (name, body) => tests.set(name, body)
}, {filename: 'upstream-test.js'});
const results = selection.map(name => {
  assert.ok(tests.has(name), 'Missing upstream assertion: ' + name);
  try {
    tests.get(name)({is: assert.strictEqual, regex: assert.match});
    return {name, verdict: 'passed'};
  } catch (error) {
    if (error.code !== 'ERR_ASSERTION' && error.name !== 'SyntaxError') throw error;
    return {name, verdict: 'failed', error: error.name};
  }
});
console.log(JSON.stringify(results));
