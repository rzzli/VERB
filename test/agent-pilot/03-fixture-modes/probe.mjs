import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
if (process.platform === 'win32') throw Error('This trial requires POSIX executable modes');
const origin = path.resolve('bin/verb.js');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'verb-mode-pilot-'));
const repo = path.join(work, 'repo'); fs.mkdirSync(repo);
const run = (exe, args) => {
  const p = spawnSync(exe, args, { cwd: repo, encoding: 'utf8', timeout: 30000 });
  if (p.error) throw p.error;
  return p;
};
const git = (...args) => { const p = run('git', args); if (p.status) throw Error(p.stderr); return p.stdout.trim(); };
try {
  git('init', '-q'); git('config', 'user.name', 'Pilot'); git('config', 'user.email', 'pilot@localhost');
  fs.writeFileSync(path.join(repo, 'value'), 'old'); git('add', '.'); git('commit', '-qm', 'old value');
  function make(name, interpreted, mode) {
    const dir = path.join(work, name); fs.mkdirSync(dir);
    const helper = path.join(dir, 'helper.sh');
    fs.writeFileSync(helper, '#!/bin/sh\ncat "$1"\n'); fs.chmodSync(helper, mode);
    fs.writeFileSync(path.join(dir, 'observe.mjs'), `import path from 'node:path';import{fileURLToPath}from'node:url';import{spawnSync}from'node:child_process';
const origin=path.resolve('value');const helper=fileURLToPath(new URL('./helper.sh',import.meta.url));
const p=spawnSync(${interpreted ? "'sh',[helper,origin]" : "helper,[origin]"},{encoding:'utf8'});
if(p.error)throw p.error;if(p.status)throw Error(p.stderr);
console.log(JSON.stringify({origin,observations:{value:p.stdout,control:'same'}}));`);
    const claim = path.join(dir, 'claim.json');
    fs.writeFileSync(claim, JSON.stringify({claim:name,probe:['{node}','{bundle}/observe.mjs'],fixtures:['observe.mjs','helper.sh'],
      assertions:[{key:'value',base:'old',fixed:'new'},{key:'control',base:'same',fixed:'same'}],required:[]}));
    return {claim,helper};
  }
  const invoke = (action, claim) => {
    const p = run(process.execPath, [origin, action, claim, ...(action === 'baseline' ? ['--base','HEAD'] : []), '--json']);
    return JSON.parse(p.stdout || p.stderr);
  };
  const direct = make('executable', false, 0o755);
  const interpreted = make('interpreter-control', true, 0o755);
  const blocked = make('nonexecutable-control', false, 0o644);
  const a = invoke('baseline', direct.claim), b = invoke('baseline', interpreted.claim), c = invoke('baseline', blocked.claim);
  if (b.verdict !== 'verified') throw Error(JSON.stringify(b));
  fs.chmodSync(interpreted.helper, 0o644);
  fs.writeFileSync(path.join(repo, 'value'), 'new');
  const check = invoke('check', interpreted.claim);
  console.log(JSON.stringify({origin,observations:{
    'executable fixture baseline':a.verdict,
    'mode change invalidates baseline':/claim changed/.test(check.reason ?? '')?'yes':'no',
    'explicit interpreter control':b.verdict,
    'nonexecutable control':c.verdict
  }}));
} finally { fs.rmSync(work, { recursive: true, force: true }); }
