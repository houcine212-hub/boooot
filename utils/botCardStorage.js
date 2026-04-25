const db = require('../db/connection');

const BOT_STORAGE_TELEGRAM_ID = -900000000001;
const BOT_STORAGE_PLAYER_CODE = 'BOTFAST';

function hasExecute(target) {
  return target && typeof target.execute === 'function';
}

function hasQueryApi(target) {
  return target && typeof target.query === 'function';
}

function hasQueryOneApi(target) {
  return target && typeof target.queryOne === 'function';
}

async function runQuery(target, sql, params = []) {
  if (hasExecute(target)) {
    const [rows] = await target.execute(sql, params);
    return rows;
  }

  if (hasQueryApi(target)) {
    return target.query(sql, params);
  }

  return db.query(sql, params);
}

async function runQueryOne(target, sql, params = []) {
  if (hasQueryOneApi(target)) {
    return target.queryOne(sql, params);
  }

  const rows = await runQuery(target, sql, params);
  return rows[0] || null;
}

async function ensureBotStoragePlayer(target = db) {
  const existing = await runQueryOne(
    target,
    'SELECT * FROM players WHERE telegram_id = ? LIMIT 1',
    [BOT_STORAGE_TELEGRAM_ID]
  );
  if (existing) return existing;

  await runQuery(
    target,
    `INSERT INTO players (telegram_id, real_name, character_name, player_code, is_admin, can_manage_cards)
     VALUES (?, ?, ?, ?, FALSE, FALSE)`,
    [BOT_STORAGE_TELEGRAM_ID, 'Bot System', 'KimiBot Storage', BOT_STORAGE_PLAYER_CODE]
  );

  return runQueryOne(
    target,
    'SELECT * FROM players WHERE telegram_id = ? LIMIT 1',
    [BOT_STORAGE_TELEGRAM_ID]
  );
}

async function upsertBotIdentityLevel(level, cardId, target = db) {
  const existing = await runQueryOne(
    target,
    'SELECT level FROM bot_card_sets WHERE level = ?',
    [level]
  );

  if (existing) {
    await runQuery(
      target,
      'UPDATE bot_card_sets SET identity_card_id = ? WHERE level = ?',
      [cardId, level]
    );
    return;
  }

  await runQuery(
    target,
    'INSERT INTO bot_card_sets (level, identity_card_id) VALUES (?, ?)',
    [level, cardId]
  );
}

async function bindBotPlayCard(level, cardId, target = db) {
  await runQuery(
    target,
    'INSERT IGNORE INTO bot_play_cards (level, card_id) VALUES (?, ?)',
    [level, cardId]
  );
}

async function bindBotSkillCard(level, cardId, target = db) {
  await runQuery(
    target,
    'INSERT IGNORE INTO bot_skill_cards (level, card_id) VALUES (?, ?)',
    [level, cardId]
  );
}

async function bindBotWeaponCard(level, cardId, target = db) {
  await runQuery(
    target,
    'INSERT IGNORE INTO bot_weapon_cards (level, card_id) VALUES (?, ?)',
    [level, cardId]
  );
}

async function loadBotIdentityForLevel(level, target = db) {
  return runQueryOne(
    target,
    `SELECT ic.*, bcs.level AS bot_level
     FROM bot_card_sets bcs
     JOIN identity_cards ic ON ic.card_id = bcs.identity_card_id
     WHERE bcs.level = ?
     LIMIT 1`,
    [level]
  );
}

module.exports = {
  BOT_STORAGE_TELEGRAM_ID,
  BOT_STORAGE_PLAYER_CODE,
  ensureBotStoragePlayer,
  upsertBotIdentityLevel,
  bindBotPlayCard,
  bindBotSkillCard,
  bindBotWeaponCard,
  loadBotIdentityForLevel
};
