'use strict';

const db          = require('../db/connection');
const permissions = require('../utils/permissions');

/**
 * Registers the $settitle command (Main Admin only).
 * Usage: $settitle [PlayerCode] [TitleName]
 * Example: $settitle PLR-12345 الوصي الملكي
 * Pass an empty title to clear it: $settitle PLR-12345 -
 */
function register(bot) {
  bot.onText(/^\$settitle\s+(\S+)\s+(.+)$/i, async (msg, match) => {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;

    if (!permissions.isMainAdmin(telegramId)) {
      return bot.sendMessage(chatId, 'هذا الأمر مخصص للمشرف الرئيسي فقط.');
    }

    const playerCode = match[1].trim().toUpperCase();
    const rawTitle   = match[2].trim();
    // Using "-" as a sentinel to clear the title
    const newTitle   = rawTitle === '-' ? null : rawTitle;

    const player = await db.queryOne(
      'SELECT id, character_name FROM players WHERE player_code = ?',
      [playerCode]
    );

    if (!player) {
      return bot.sendMessage(chatId, `لم يُعثر على لاعب بالكود: ${playerCode}`);
    }

    await db.query(
      'UPDATE players SET title = ? WHERE player_code = ?',
      [newTitle, playerCode]
    );

    const confirmation = newTitle
      ? `تم تعيين منصب *${newTitle}* للاعب *${player.character_name}* (${playerCode}).`
      : `تم إزالة المنصب المخصص للاعب *${player.character_name}* (${playerCode}).`;

    await bot.sendMessage(chatId, confirmation, { parse_mode: 'Markdown' });
  });
}

module.exports = { register };