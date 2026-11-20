'use strict';

const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const origin = require.resolve(path.resolve('index.js'));
const escape = require(origin);
const fixture = 'subjects.txt';
const lines = fs.readFileSync(path.join(__dirname, fixture), 'utf8').trimEnd().split(/\r?\n/);
const literalPattern = '^' + escape('x-.-y') + '$';
const classPattern = '^[' + escape('a-c') + ']$';

function javascriptMatches(pattern) {
    try {
        const regexp = new RegExp(pattern, 'u');
        return JSON.stringify(lines.filter(line => regexp.test(line)));
    } catch (error) {
        if (error instanceof SyntaxError) return 'pattern rejected';
        throw error;
    }
}

function pcreMatches(pattern) {
    const result = spawnSync('git', [
        'grep', '--no-index', '-P', '--no-color', '--no-line-number', '--no-column',
        '-h', '-e', pattern, '--', fixture
    ], {cwd: __dirname, encoding: 'utf8'});
    if (result.error) throw result.error;
    if (result.status === 0) return JSON.stringify(result.stdout.trimEnd().split(/\r?\n/));
    if (result.status === 1) return '[]';
    if (/^fatal: -e option,|pcre2?[^\n]*compil(?:e|ation)[^\n]*error/i.test(result.stderr)) {
        return 'pattern rejected';
    }
    throw new Error('Git PCRE matcher failed: ' + result.stderr);
}

if (pcreMatches('^(?=x-)x-[.]-y$') !== '["x-.-y"]') {
    throw new Error('PCRE preflight failed to match the known fixture line');
}

const observations = {
    pcreLiteral: pcreMatches(literalPattern),
    javascriptLiteral: javascriptMatches(literalPattern),
    pcreClass: pcreMatches(classPattern),
    javascriptClass: javascriptMatches(classPattern)
};
process.stdout.write(JSON.stringify({origin, observations}) + '\n');
