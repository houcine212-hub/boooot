const assert = require('node:assert/strict');

const {
  createPlayCardWithAllocation,
  normalizePlayCardStats,
  InsufficientPlayCardResourcesError
} = require('../services/playCardAllocationService');

function createFakeConnection(options = {}) {
  const state = {
    updateCalls: 0,
    insertCalls: 0,
    selectIdCalls: 0,
    balanceCalls: 0
  };

  return {
    state,
    async execute(sql, params = []) {
      if (sql.includes('UPDATE identity_cards')) {
        state.updateCalls += 1;
        return [{ affectedRows: options.reserveAffectedRows ?? 1 }];
      }

      if (sql.includes('SELECT id FROM play_cards')) {
        state.selectIdCalls += 1;
        return [options.existingCardRows ?? []];
      }

      if (sql.includes('INSERT INTO play_cards')) {
        state.insertCalls += 1;
        return [{ insertId: 55 }];
      }

      if (sql.includes('SELECT available_atk, available_magic, available_def, available_spd, available_accuracy')) {
        state.balanceCalls += 1;
        return [[options.balances || {
          available_atk: 120,
          available_magic: 340,
          available_def: 560,
          available_spd: 780,
          available_accuracy: 900
        }]];
      }

      throw new Error(`Unhandled SQL in fake connection: ${sql}`);
    }
  };
}

async function runSingleTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function runAll() {
  await runSingleTest('createPlayCardWithAllocation uses a transaction wrapper and returns remaining balances', async () => {
    const connection = createFakeConnection({
      balances: {
        available_atk: 400,
        available_magic: 300,
        available_def: 200,
        available_spd: 100,
        available_accuracy: 50
      }
    });
    let usedTransaction = false;

    const result = await createPlayCardWithAllocation(
      {
        playerId: 7,
        identityCardId: 11,
        cardName: 'Burst',
        type: 'attack',
        stats: { atk: 250, accuracy: 90 }
      },
      {
        db: {
          async withTransaction(work) {
            usedTransaction = true;
            return work(connection);
          }
        },
        idGenerator: () => 'PLC-ALLOC-1'
      }
    );

    assert.equal(usedTransaction, true);
    assert.equal(result.cardId, 'PLC-ALLOC-1');
    assert.equal(result.balances.available_atk, 400);
    assert.equal(connection.state.updateCalls, 1);
    assert.equal(connection.state.insertCalls, 1);
    assert.equal(connection.state.balanceCalls, 1);
  });

  await runSingleTest('createPlayCardWithAllocation stops when the identity has insufficient balance', async () => {
    const connection = createFakeConnection({ reserveAffectedRows: 0 });

    await assert.rejects(
      () => createPlayCardWithAllocation(
        {
          playerId: 7,
          identityCardId: 11,
          cardName: 'Wall',
          type: 'defense',
          stats: { def: 999, spd: 999 }
        },
        { connection, idGenerator: () => 'PLC-ALLOC-2' }
      ),
      (error) => error instanceof InsufficientPlayCardResourcesError
    );

    assert.equal(connection.state.updateCalls, 1);
    assert.equal(connection.state.insertCalls, 0);
    assert.equal(connection.state.balanceCalls, 0);
  });

  await runSingleTest('normalizePlayCardStats rejects zero-point cards', async () => {
    assert.throws(
      () => normalizePlayCardStats('magic', { magic: 0 }),
      /at least one point/i
    );
  });

  await runSingleTest('normalizePlayCardStats keeps magic accuracy allocation when provided', async () => {
    const stats = normalizePlayCardStats('magic', { magic: 120, accuracy: 45 });
    assert.equal(stats.magic, 120);
    assert.equal(stats.accuracy, 45);
  });
}

runAll()
  .then(() => {
    console.log('All playCardAllocationService tests passed.');
  })
  .catch((error) => {
    process.exitCode = 1;
    throw error;
  });
