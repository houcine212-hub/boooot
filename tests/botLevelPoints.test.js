const assert = require('node:assert/strict');

const {
  TOTAL_IDENTITY_POINTS,
  TOTAL_WEAPON_POINTS,
  BOT_LEVEL_POINT_STEP,
  getBotLevelDistributionPoints
} = require('../utils/constants');

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('Level 1 keeps the base distribution points', () => {
  assert.equal(getBotLevelDistributionPoints(1), TOTAL_IDENTITY_POINTS);
});

runTest('Each next level adds the configured point step', () => {
  assert.equal(getBotLevelDistributionPoints(2), TOTAL_IDENTITY_POINTS + BOT_LEVEL_POINT_STEP);
  assert.equal(getBotLevelDistributionPoints(3), TOTAL_IDENTITY_POINTS + (BOT_LEVEL_POINT_STEP * 2));
  assert.equal(getBotLevelDistributionPoints(4), TOTAL_IDENTITY_POINTS + (BOT_LEVEL_POINT_STEP * 3));
});

runTest('Weapon point scaling uses the same level formula', () => {
  assert.equal(getBotLevelDistributionPoints(4, TOTAL_WEAPON_POINTS), TOTAL_WEAPON_POINTS + (BOT_LEVEL_POINT_STEP * 3));
});

console.log('All bot level point tests passed.');
