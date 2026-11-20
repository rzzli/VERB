'use strict';

const origin = require.resolve(process.cwd());
const escapeStringRegexp = require(origin);

function classMembers(input) {
  const expression = new RegExp('^[' + escapeStringRegexp(input) + ']$');
  const printableAscii = Array.from({length: 95}, (_, i) => String.fromCharCode(32 + i));
  return printableAscii.filter(character => expression.test(character)).join('');
}

function unicodeWholeLiteral() {
  const input = '2-5.J-M';
  try {
    const expression = new RegExp('^' + escapeStringRegexp(input) + '$', 'u');
    return [input, '25.JM', '2-5XJ-M'].map(value => expression.test(value)).join(',');
  } catch (error) {
    if (error instanceof SyntaxError) return 'invalid pattern';
    throw error;
  }
}

const observations = {
  singleClassMembers: classMembers('j-m'),
  repeatedClassMembers: classMembers('2-5J-M'),
  unicodeWholeLiteral: unicodeWholeLiteral()
};
console.log(JSON.stringify({origin, observations}));
