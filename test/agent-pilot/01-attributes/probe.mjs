import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const origin = path.resolve('bin/verb.js');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'verb-attributes-pilot-'));
const repo = path.join(work, 'repo');
fs.mkdirSync(repo);
const run = (exe, args, cwd = repo) => {
  const p = spawnSync(exe, args, { cwd, encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (p.error) throw p.error;
  return p;
};
const git = (...args) => { const p = run('git', args); if (p.status) throw Error(p.stderr); return p.stdout.trim(); };
try {
  git('init', '-q'); git('config', 'user.name', 'Pilot'); git('config', 'user.email', 'pilot@localhost');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt text eol=lf\n');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'alpha\nbeta\n');
  git('add', '.'); git('commit', '-qm', 'LF policy');
  const base = git('rev-parse', 'HEAD');
  const script = path.join(work, 'observe.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';import path from 'node:path';
const origin=path.resolve('app.txt');const value=fs.readFileSync(origin,'utf8');
console.log(JSON.stringify({origin,observations:{newlines:value.includes('\\r\\n')?'CRLF':'LF',content:value.replaceAll('\\r','')}}));`);
  const claim = path.join(work, 'claim.json');
  fs.writeFileSync(claim, JSON.stringify({claim:'LF asset baseline',probe:['{node}','{bundle}/observe.mjs'],fixtures:['observe.mjs'],
    assertions:[{key:'newlines',base:'LF',fixed:'CRLF'},{key:'content',base:'alpha\nbeta\n',fixed:'alpha\nbeta\n'}],required:[]}));
  const baseline = () => {
    const p = run(process.execPath, [origin, 'baseline', claim, '--base', base, '--json']);
    const r = JSON.parse(p.stdout || p.stderr);
    if (![0,2].includes(p.status) || !r.sides?.base?.assertions) throw Error(JSON.stringify(r));
    return r.verdict;
  };
  const control = baseline();
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt text eol=crlf\n');
  git('add', '.gitattributes'); git('commit', '-qm', 'candidate CRLF policy');
  const changed = baseline();
  console.log(JSON.stringify({origin, observations:{'historical baseline after attribute change':changed,'unchanged policy control':control}}));
} finally {
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
}
