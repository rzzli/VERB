// Source entry point. build.cjs copies it and writes version.json into dist/.
const { version } = require('./version.json');
let config;
try {
  config = JSON.parse(process.argv[2]);
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      (config.displayName != null && typeof config.displayName !== 'string')) throw Error('invalid object');
} catch {
  console.error('Expected one JSON object argument with an optional string displayName.');
  process.exit(2);
}
// An explicitly empty name should stay empty; only an absent/null name should use Guest.
const name = config.displayName || 'Guest'; // tutorial patch
console.log(JSON.stringify({ greeting: `Hello, ${name}!`, version }));
