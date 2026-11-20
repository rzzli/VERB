const path = require('node:path');
const origin = require.resolve(path.join(process.cwd(), 'index.js'));
const escape = require(origin);
const scenario = process.argv[2];
let observed;
if (scenario === 'character class') {
  observed = String(new RegExp('[' + escape('a-z') + ']').test('m'));
} else if (scenario === 'unicode') {
  try {
    observed = String(new RegExp(escape('-'), 'u').test('-'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    observed = 'syntax error';
  }
} else if (scenario === 'portable escape') {
  observed = escape('-');
} else {
  throw Error('Unknown pilot case');
}
console.log(JSON.stringify({origin, observations: {
  [scenario]: observed, 'plain text': escape('abc')
}}));
