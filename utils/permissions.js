const db = require('../db/connection');
require('dotenv').config();

const ADMIN_ID = parseInt(process.env.ADMIN_ID);

/**
 * Check if a Telegram user is the main admin
 */
function isMainAdmin(telegramId) {
  return parseInt(telegramId) === ADMIN_ID;
}

/**
 * Check if a user has permission to manage cards (admin or granted)
 */
async function isAdmin(telegramId) {
  if (isMainAdmin(telegramId)) return true;

  const player = await db.queryOne(
    'SELECT is_admin FROM players WHERE telegram_id = ?',
    [telegramId]
  );

  return Boolean(player && player.is_admin);
}

/**
 * Check if a user has permission to manage cards (admin or granted)
 */
async function canManageCards(telegramId) {
  if (await isAdmin(telegramId)) return true;
  
  const player = await db.queryOne(
    'SELECT can_manage_cards FROM players WHERE telegram_id = ?',
    [telegramId]
  );
  
  return Boolean(player && player.can_manage_cards);
}

/**
 * Grant full admin permission to a player
 */
async function grantAdmin(telegramId) {
  await db.query(
    'UPDATE players SET is_admin = TRUE, can_manage_cards = TRUE WHERE telegram_id = ?',
    [telegramId]
  );
}

/**
 * Grant card management permission to a player
 */
async function grantPermission(telegramId) {
  await db.query(
    'UPDATE players SET can_manage_cards = TRUE WHERE telegram_id = ?',
    [telegramId]
  );
}

/**
 * Revoke card management permission from a player
 */
async function revokePermission(telegramId) {
  await db.query(
    'UPDATE players SET can_manage_cards = FALSE WHERE telegram_id = ?',
    [telegramId]
  );
}

module.exports = {
  isMainAdmin,
  isAdmin,
  canManageCards,
  grantAdmin,
  grantPermission,
  revokePermission,
  ADMIN_ID
};
