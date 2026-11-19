// Tutorial-only patch selector. It edits only the initialized demo's greeting expression.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const expressions = {
  broken: "config.displayName || 'Guest'",
  wrong: "config.displayName ?? ''",
  fixed: "config.displayName ?? 'Guest'"
};
const mode = process.argv[2];
if (process.argv.length !== 3 || !Object.hasOwn(expressions, mode) || !fs.existsSync(path.join(root, '.git'))) {
  console.error('Run node patch.mjs broken|wrong|fixed from a demo created by create-demo.mjs.');
  process.exit(2);
}
const file = path.join(root, 'greeter.cjs');
const source = fs.readFileSync(file, 'utf8');
const matches = source.match(/^const name = .*; \/\/ tutorial patch$/gm);
if (matches?.length !== 1) throw Error('Tutorial expression changed; inspect greeter.cjs instead of replacing unrelated code.');
fs.writeFileSync(file, source.replace(matches[0], 'const name = ' + expressions[mode] + '; // tutorial patch'));
console.log('Applied ' + mode + ' greeting expression.');
