'use strict';

const origin = require.resolve(process.cwd());
const escape = require(origin);

function observe(buildObservation) {
  try {
    return buildObservation();
  } catch (error) {
    return error.name;
  }
}

const observations = {
  unicodeLiteral: observe(() => {
    const input = 'a-b.+-c';
    const pattern = new RegExp(`^(?:${escape(input)})$`, 'u');
    return `self=${pattern.test(input)},changed=${pattern.test('a_b.+-c')},expanded=${pattern.test('a-bxxx-c')}`;
  }),
  classMembers: observe(() => {
    const pattern = new RegExp(`^[${escape('a-z')}]$`, 'u');
    return ['a', '-', 'm', 'z', '!'].filter(character => pattern.test(character)).join(',');
  })
};

console.log(JSON.stringify({origin, observations}));
