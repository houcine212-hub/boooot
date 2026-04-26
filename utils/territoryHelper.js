'use strict';

const db = require('../db/connection');

/**
 * Fetches city and kingdom info for a given Telegram group chat_id.
 *
 * Returns one of three shapes:
 *   { found: false }
 *   { found: true, isCapital: false, cityName: '...', kingdomName: '...' }
 *   { found: true, isCapital: true,  cityName: '...', kingdomName: '...' }
 *
 * @param {number|string} chatId - Telegram group chat ID
 * @returns {Promise<object>}
 */
async function getLocationInfo(chatId) {
  const row = await db.queryOne(
    `SELECT c.name AS cityName, c.is_capital, k.name AS kingdomName
       FROM cities c
       JOIN kingdoms k ON k.id = c.kingdom_id
      WHERE c.chat_id = ?
      LIMIT 1`,
    [chatId]
  );

  if (!row) return { found: false };

  return {
    found:       true,
    isCapital:   Boolean(row.is_capital),
    cityName:    row.cityName,
    kingdomName: row.kingdomName
  };
}

module.exports = { getLocationInfo };