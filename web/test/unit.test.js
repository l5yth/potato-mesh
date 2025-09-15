const test = require('node:test');
const assert = require('node:assert');
const { timeHum } = require('../public/utils');

test('timeHum formats seconds', () => {
  assert.strictEqual(timeHum(65), '1m 5s');
});
