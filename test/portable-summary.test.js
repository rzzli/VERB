import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { scratch, clean, cmd, project } from './helpers.js';

const cases = [
  {
    label: 'Windows drive', repo: 'C:\\workspace\\project', claim: 'C:\\workspace\\project\\claims\\feature.json',
    origin: 'src\\app.js',
    command: ['C:\\tools\\node.exe', 'C:\\workspace\\project\\check.js',
      '--config=C:\\workspace\\project\\config.json', '--cache=D:\\scratch\\cache'],
    expected: ['../../tools/node.exe', 'check.js', '--config=config.json', '--cache=(outside repository volume)']
  },
  {
    label: 'Windows UNC', repo: '\\\\build-host\\projects\\app',
    claim: '\\\\build-host\\projects\\app\\claims\\feature.json', origin: 'src\\app.js',
    command: ['\\\\build-host\\projects\\tools\\node.exe',
      '--config=\\\\build-host\\projects\\app\\config.json'],
    expected: ['../tools/node.exe', '--config=config.json']
  },
  {
    label: 'Windows DOS alias', repo: 'C:\\Users\\runneradmin\\app',
    aliases: ['C:\\Users\\RUNNER~1\\app'], claim: 'C:\\Users\\runneradmin\\app\\claims\\feature.json',
    origin: 'src\\app.js', command: ['node', '--config=C:\\Users\\RUNNER~1\\app\\config.json'],
    expected: ['node', '--config=config.json']
  },
  {
    label: 'POSIX', repo: '/workspace/project', claim: '/workspace/project/claims/feature.json',
    origin: 'src/app.js',
    command: ['/usr/bin/node', '/workspace/project/check.js', '--config=/workspace/project/config.json'],
    expected: ['../../usr/bin/node', 'check.js', '--config=config.json']
  }
];

for (const sample of cases) {
  test(`summary formats ${sample.label} receipt paths independently of host platform`, t => {
    const dir = scratch();
    t.after(() => clean(dir));
    const file = path.join(dir, 'receipt.json');
    const literal = 'literal C:\\private\\observation is not a structured path';
    const receipt = {
      action: 'prove', verdict: 'verified', claim: 'Portable receipt summary', digest: 'frozen-digest',
      repo: sample.repo, repoAliases: sample.aliases, claimPath: sample.claim,
      sides: {
        base: { kind: 'commit', id: 'base-id', origin: sample.origin, verdict: 'verified',
          assertions: [{ key: 'literal', pass: true, control: false, expected: 'old', actual: 'old' }],
          commands: [{ phase: 'probe', code: 0 }] },
        candidate: { kind: 'working', id: 'candidate-id', origin: sample.origin, verdict: 'verified',
          assertions: [{ key: 'literal', pass: true, control: false, expected: literal, actual: literal }],
          commands: [{ phase: 'probe', code: 0 }, { phase: 'required', code: 0 }] }
      },
      required: [sample.command]
    };
    fs.writeFileSync(file, JSON.stringify(receipt));
    const output = cmd(dir, process.execPath, [path.join(project, 'bin/verb.js'), 'summary', file]);
    const lines = output.split(/\r?\n/);
    assert.ok(lines.includes('Claim: claims/feature.json'), output);
    assert.equal(lines.filter(line => line === '  Origin: src/app.js').length, 2, output);
    assert.ok(lines.includes('Required ' + JSON.stringify(sample.expected) + ': exit 0'), output);
    assert.ok(output.includes(JSON.stringify(literal)), output);
    assert.ok(output.includes('Claim digest (SHA-256): frozen-digest'), output);
    assert.ok(lines.includes('base: commit base-id') && lines.includes('candidate: working candidate-id'), output);
  });
}
