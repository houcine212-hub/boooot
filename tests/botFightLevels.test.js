const assert = require('node:assert/strict');

const {
  getMaxReplayableBotLevel,
  canReplayBotLevel
} = require('../handlers/botFight');

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('Replay range stays below the currently unlocked challenge level', () => {
  assert.equal(getMaxReplayableBotLevel(1), 0);
  assert.equal(getMaxReplayableBotLevel(3), 2);
  assert.equal(getMaxReplayableBotLevel(4), 3);
});

runTest('A player can replay only previously cleared bot levels', () => {
  assert.equal(canReplayBotLevel(3, 1), true);
  assert.equal(canReplayBotLevel(3, 2), true);
  assert.equal(canReplayBotLevel(3, 3), false);
  assert.equal(canReplayBotLevel(4, 3), true);
  assert.equal(canReplayBotLevel(4, 4), false);
});

runTest('Invalid requested levels are rejected', () => {
  assert.equal(canReplayBotLevel(5, 0), false);
  assert.equal(canReplayBotLevel(5, -1), false);
  assert.equal(canReplayBotLevel(5, 'abc'), false);
});

console.log('All bot fight level tests passed.');
