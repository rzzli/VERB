import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fixture, project, write, verb } from './helpers.js';

const cli = path.join(project, 'bin/verb.js');
const historyBytes = dir => fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);

function observationFixture(t) {
  const f = fixture(t), flag = path.join(f.dir, 'service-state');
  write(flag, 'new');
  write(f.probe, `import fs from 'node:fs'; import path from 'node:path';
const origin=path.resolve('value'), value=fs.readFileSync(origin,'utf8');
console.log(JSON.stringify({origin,observations:{value:value==='old'?value:fs.readFileSync(${JSON.stringify(flag)},'utf8'),neighbor:'same'}}));`);
  const baseline = verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
  write(path.join(f.repo, 'value'), 'new');
  const proof = verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
  return { ...f, flag, proof, baseline, history: path.join(f.repo, '.git', 'verb', 'history', 'claims', path.basename(path.dirname(proof.receipt))) };
}

test('completed contradictory checks invalidate old proofs without status writing executions', t => {
  const f = observationFixture(t);
  for (let i = 0; i < 31; i++) verb(f.repo, 0, 'check', f.claim);
  assert.equal(verb(f.repo, 0, 'status').receipt, f.proof.receipt);
  verb(f.repo, 0, 'status', '--active');
  assert.equal(JSON.parse(fs.readFileSync(f.baseline.receipt)).digest, f.baseline.digest);
  assert.deepEqual(fs.readFileSync(path.join(f.baseline.frozen, 'claim.json')), fs.readFileSync(f.claim));
  assert.deepEqual(fs.readFileSync(path.join(f.baseline.frozen, 'fixtures', 'probe.mjs')), fs.readFileSync(f.probe));
  assert.equal(fs.readdirSync(path.dirname(f.proof.receipt)).length, 30);
  write(f.flag, 'wrong');
  verb(f.repo, 2, 'check', f.claim);
  const before = historyBytes(f.history);
  for (let i = 0; i < 3; i++) {
    verb(f.repo, 2, 'status');
    verb(f.repo, 2, 'status', '--active');
    verb(f.repo, 2, 'status', f.proof.receipt);
  }
  assert.deepEqual(historyBytes(f.history), before);
  write(f.flag, 'new');
  verb(f.repo, 2, 'check', f.claim);
  verb(f.repo, 2, 'check', f.claim);
  verb(f.repo, 0, 'check', f.claim);
  // Checks recover observations, but cannot turn an invalidated proof into a new proof.
  verb(f.repo, 2, 'status');
  verb(f.repo, 2, 'status', '--active');
  verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
  verb(f.repo, 0, 'status', '--active');
});

for (const slowExit of [0, 1]) {
  test(`concurrent proofs fail closed when the ${slowExit === 0 ? 'successful' : 'failed'} execution publishes last`, async t => {
    const f = fixture(t), ready = path.join(f.dir, 'cleanup-ready'), release = path.join(f.dir, 'cleanup-release');
    write(f.claim, { ...f.spec, required: [['{node}', '-e', `if(process.env.VERB_TEST_SLOW)require('node:fs').writeFileSync('slow-cleanup','');process.exit(Number(process.env.VERB_TEST_RESULT||0));`]] });
    verb(f.repo, 0, 'baseline', f.claim, '--base', 'HEAD');
    write(path.join(f.repo, 'value'), 'new');
    const wrapper = path.join(f.dir, 'slow-cleanup.mjs');
    write(wrapper, `import fs from 'node:fs';import path from 'node:path';
const remove=fs.rmSync;
fs.rmSync=(dir,options)=>{
 if(options?.recursive&&fs.existsSync(path.join(dir,'tree','slow-cleanup'))){
  fs.writeFileSync(${JSON.stringify(ready)},'');const deadline=Date.now()+12000;
  while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>deadline)throw Error('bounded test cleanup wait');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
 }
 return remove(dir,options);
};
process.argv=[process.execPath,${JSON.stringify(cli)},'prove',${JSON.stringify(f.claim)},'--base','HEAD','--json'];
await import(${JSON.stringify(pathToFileURL(cli).href)});`);
    const child = spawn(process.execPath, [wrapper], { cwd: f.repo,
      env: { ...process.env, VERB_TEST_SLOW: '1', VERB_TEST_RESULT: String(slowExit) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const finished = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => { try { resolve({ code, receipt: JSON.parse(stdout || stderr) }); } catch (error) { reject(error); } });
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let fast;
    try {
      const deadline = Date.now() + 12000;
      while (!fs.existsSync(ready)) {
        assert.ok(Date.now() < deadline, 'slow proof reaches candidate cleanup');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const fastWrapper = path.join(f.dir, 'fast-proof.mjs');
      write(fastWrapper, `process.env.VERB_TEST_RESULT=${JSON.stringify(String(1 - slowExit))};process.argv=[process.execPath,${JSON.stringify(cli)},'prove',${JSON.stringify(f.claim)},'--base','HEAD','--json'];await import(${JSON.stringify(pathToFileURL(cli).href)});`);
      const { spawnSync } = await import('node:child_process');
      const p = spawnSync(process.execPath, [fastWrapper], { cwd: f.repo, encoding: 'utf8', timeout: 15000 });
      assert.ifError(p.error);fast = JSON.parse(p.stdout || p.stderr);
      assert.notEqual(p.status, 0);
    } finally { write(release, ''); }
    const slow = await finished;
    assert.notEqual(slow.code, 0);
    assert.equal(slow.receipt.sides.candidate.commands.at(-1).code, slowExit);
    assert.equal(fast.sides.candidate.commands.at(-1).code, 1 - slowExit);
    verb(f.repo, 2, 'status');verb(f.repo, 2, 'status', '--active');
    for (let i = 0; i < 3; i++) verb(f.repo, 2, 'check', f.claim);
    // In the second case the fast proof already supplied the first agreeing success.
    const remaining = slowExit === 0 ? 3 : 2;
    for (let i = 1; i < remaining; i++) verb(f.repo, 2, 'prove', f.claim, '--base', 'HEAD');
    verb(f.repo, 0, 'prove', f.claim, '--base', 'HEAD');
    verb(f.repo, 0, 'status', '--active');
  });
}

test('a conflict in one active claim cannot be approved by another claim', t => {
  const f = observationFixture(t), other = path.join(f.dir, 'other.json');
  write(other, { ...f.spec, probe: ['{node}', '{bundle}/other-probe.mjs'], fixtures: ['other-probe.mjs'] });
  write(path.join(f.dir, 'other-probe.mjs'), `import fs from 'node:fs';import path from 'node:path';const origin=path.resolve('value');console.log(JSON.stringify({origin,observations:{value:fs.readFileSync(origin,'utf8'),neighbor:'same'}}));`);
  verb(f.repo, 0, 'baseline', other, '--base', 'HEAD');
  verb(f.repo, 0, 'prove', other, '--base', 'HEAD');
  verb(f.repo, 0, 'status', '--active');
  write(f.flag, 'wrong');verb(f.repo, 2, 'check', f.claim);
  verb(f.repo, 2, 'status', '--active');
  verb(f.repo, 0, 'prove', other, '--base', 'HEAD');
  verb(f.repo, 2, 'status', '--active');
});
