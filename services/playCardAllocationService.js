const db = require('../db/connection');
const {
  PLAY_CARD_RESOURCE_COLUMNS,
  reservePlayCardResources,
  getAvailablePlayCardBalances
} = require('../db/identityCardResources');
const { generatePlayCardId } = require('../utils/idGenerator');

class InsufficientPlayCardResourcesError extends Error {
  constructor() {
    super('INSUFFICIENT_PLAY_CARD_RESOURCES');
    this.name = 'InsufficientPlayCardResourcesError';
  }
}

function normalizePlayCardStats(type, stats = {}) {
  const allowedStats = Object.keys(PLAY_CARD_RESOURCE_COLUMNS[type] || {});
  if (allowedStats.length === 0) {
    throw new Error(`Unsupported play card type: ${type}`);
  }

  const normalized = {};
  for (const key of allowedStats) {
    const value = Number.parseInt(stats[key] || 0, 10);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid stat value for ${key}`);
    }
    normalized[key] = value;
  }

  const totalAllocated = Object.values(normalized).reduce((sum, value) => sum + value, 0);
  if (totalAllocated <= 0) {
    throw new Error('A play card must allocate at least one point.');
  }

  return normalized;
}

async function generateUniquePlayCardId(connection, idGenerator = generatePlayCardId) {
  let cardId;

  do {
    cardId = idGenerator();
    const [rows] = await connection.execute(
      'SELECT id FROM play_cards WHERE card_id = ? LIMIT 1',
      [cardId]
    );
    if (rows.length === 0) {
      return cardId;
    }
  } while (true);
}

async function insertPlayCard(connection, payload) {
  const [result] = await connection.execute(
    `INSERT INTO play_cards
       (card_id, player_id, identity_card_id, name, type, atk, magic, def, accuracy, spd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.cardId,
      payload.playerId,
      payload.identityCardId,
      payload.cardName,
      payload.type,
      payload.stats.atk || 0,
      payload.stats.magic || 0,
      payload.stats.def || 0,
      payload.stats.accuracy || 0,
      payload.stats.spd || 0
    ]
  );

  return result;
}

async function createPlayCardWithAllocation(input, deps = {}) {
  const stats = normalizePlayCardStats(input.type, input.stats);
  const connection = deps.connection || null;
  const database = deps.db || db;
  const idGenerator = deps.idGenerator || generatePlayCardId;

  const work = async (activeConnection) => {
    const reserved = await reservePlayCardResources(
      activeConnection,
      input.identityCardId,
      input.type,
      stats
    );

    if (!reserved) {
      throw new InsufficientPlayCardResourcesError();
    }

    const cardId = await generateUniquePlayCardId(activeConnection, idGenerator);
    await insertPlayCard(activeConnection, {
      cardId,
      playerId: input.playerId,
      identityCardId: input.identityCardId,
      cardName: input.cardName,
      type: input.type,
      stats
    });

    const balances = await getAvailablePlayCardBalances(activeConnection, input.identityCardId);
    return { cardId, balances, stats };
  };

  if (connection) {
    return work(connection);
  }

  return database.withTransaction(work);
}

module.exports = {
  InsufficientPlayCardResourcesError,
  normalizePlayCardStats,
  createPlayCardWithAllocation
};
