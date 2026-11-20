import fs from 'node:fs';
import path from 'node:path';
import { withClaimLock } from '../lib/store.js';

const [mode, store, round, index] = process.argv.slice(2);
if (mode === 'leave-lock') {
  withClaimLock(store, 'claim', () => process.kill(process.pid, 'SIGKILL'));
} else if (mode === 'interrupt-recovery') {
  const lock = path.join(store, 'locks', 'claim.lock');
  const unlink = fs.unlinkSync;
  fs.unlinkSync = file => {
    if (file !== lock) return unlink(file);
    if (round === 'after-unlink') unlink(file);
    process.kill(process.pid, 'SIGKILL');
  };
  withClaimLock(store, 'claim', () => { throw Error('expected a dead writer'); });
} else {
  const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  // Make all six real processes inspect the *same* dead owner before any can
  // attempt recovery. The actual PID lookup, locks and critical sections are real.
  const kill = process.kill.bind(process);
  process.kill = (pid, signal) => {
    try { return kill(pid, signal); }
    catch (error) {
      if (signal === 0 && error.code === 'ESRCH') {
        fs.writeFileSync(path.join(round, index), '');
        const deadline = Date.now() + 15000;
        while (fs.readdirSync(round).length < 6) {
          if (Date.now() >= deadline) throw Error('contenders did not reach the barrier');
          wait(5);
        }
      }
      throw error;
    }
  };
  withClaimLock(store, 'claim', () => {
    const witness = path.join(store, 'inside');
    fs.writeFileSync(witness, index, { flag: 'wx' });
    wait(20);
    fs.unlinkSync(witness);
  });
}
