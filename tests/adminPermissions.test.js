const assert = require('node:assert/strict');

const db = require('../db/connection');
const permissions = require('../utils/permissions');

function createFakeDbState() {
  return {
    players: new Map()
  };
}

function installFakeDb(state) {
  const originalQueryOne = db.queryOne;
  const originalQuery = db.query;

  db.queryOne = async (sql, params = []) => {
    const telegramId = params[0];
    const player = state.players.get(telegramId) || null;

    if (sql.includes('SELECT is_admin FROM players')) {
      return player ? { is_admin: player.is_admin } : null;
    }

    if (sql.includes('SELECT can_manage_cards FROM players')) {
      return player ? { can_manage_cards: player.can_manage_cards } : null;
    }

    return null;
  };

  db.query = async (sql, params = []) => {
    const telegramId = params[0];
    const player = state.players.get(telegramId);

    if (sql.includes('UPDATE players SET is_admin = TRUE, can_manage_cards = TRUE')) {
      if (player) {
        player.is_admin = true;
        player.can_manage_cards = true;
      }
      return { affectedRows: player ? 1 : 0 };
    }

    if (sql.includes('UPDATE players SET can_manage_cards = TRUE')) {
      if (player) {
        player.can_manage_cards = true;
      }
      return { affectedRows: player ? 1 : 0 };
    }

    if (sql.includes('UPDATE players SET can_manage_cards = FALSE')) {
      if (player) {
        player.can_manage_cards = false;
      }
      return { affectedRows: player ? 1 : 0 };
    }

    return {};
  };

  return () => {
    db.queryOne = originalQueryOne;
    db.query = originalQuery;
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
  await runSingleTest('isAdmin recognizes stored admins', async () => {
    const state = createFakeDbState();
    state.players.set(1001, { is_admin: true, can_manage_cards: false });
    const restore = installFakeDb(state);

    try {
      assert.equal(await permissions.isAdmin(1001), true);
      assert.equal(await permissions.isAdmin(2002), false);
    } finally {
      restore();
    }
  });

  await runSingleTest('canManageCards allows admins and delegated card managers', async () => {
    const state = createFakeDbState();
    state.players.set(3003, { is_admin: true, can_manage_cards: false });
    state.players.set(4004, { is_admin: false, can_manage_cards: true });
    state.players.set(5005, { is_admin: false, can_manage_cards: false });
    const restore = installFakeDb(state);

    try {
      assert.equal(await permissions.canManageCards(3003), true);
      assert.equal(await permissions.canManageCards(4004), true);
      assert.equal(await permissions.canManageCards(5005), false);
    } finally {
      restore();
    }
  });

  await runSingleTest('grantAdmin promotes the player to full admin access', async () => {
    const state = createFakeDbState();
    state.players.set(6006, { is_admin: false, can_manage_cards: false });
    const restore = installFakeDb(state);

    try {
      await permissions.grantAdmin(6006);
      assert.equal(state.players.get(6006).is_admin, true);
      assert.equal(state.players.get(6006).can_manage_cards, true);
      assert.equal(await permissions.isAdmin(6006), true);
      assert.equal(await permissions.canManageCards(6006), true);
    } finally {
      restore();
    }
  });
}

runAll()
  .then(() => {
    console.log('All admin permission tests passed.');
  })
  .catch((error) => {
    process.exitCode = 1;
    throw error;
  });
