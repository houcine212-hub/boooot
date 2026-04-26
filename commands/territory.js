'use strict';

const db          = require('../db/connection');
const permissions = require('../utils/permissions');

/**
 * Registers territory management commands (Main Admin only).
 *
 * Commands:
 *   $addkingdom [Name]
 *   $registercity [Name] [KingdomID] [is_palace: 0 or 1]
 *
 * Note: $registercity always registers the CURRENT group's chat_id as the city.
 * The admin must run the command FROM inside the target group.
 */
function register(bot) {

  // $addkingdom [Name]
  bot.onText(/^\$addkingdom\s+(.+)$/i, async (msg, match) => {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;

    if (!permissions.isMainAdmin(telegramId)) {
      return bot.sendMessage(chatId, 'هذا الأمر مخصص للمشرف الرئيسي فقط.');
    }

    const name = match[1].trim();
    if (!name) {
      return bot.sendMessage(chatId, 'استخدام: $addkingdom [اسم المملكة]');
    }

    const result = await db.query(
      'INSERT INTO kingdoms (name) VALUES (?)',
      [name]
    );

    await bot.sendMessage(
      chatId,
      `تم إنشاء مملكة جديدة.\n*الاسم:* ${name}\n*ID:* ${result.insertId}`,
      { parse_mode: 'Markdown' }
    );
  });

  // $registercity [Name] [KingdomID] [is_palace: 0 or 1]
  // Must be sent from inside the group you want to register.
  bot.onText(/^\$registercity\s+(.+?)\s+(\d+)\s+([01])$/i, async (msg, match) => {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;

    if (!permissions.isMainAdmin(telegramId)) {
      return bot.sendMessage(chatId, 'هذا الأمر مخصص للمشرف الرئيسي فقط.');
    }

    const name       = match[1].trim();
    const kingdomId  = parseInt(match[2], 10);
    const isCapital  = match[3] === '1';

    // Verify the kingdom exists
    const kingdom = await db.queryOne(
      'SELECT id, name FROM kingdoms WHERE id = ?',
      [kingdomId]
    );
    if (!kingdom) {
      return bot.sendMessage(chatId, `لم يُعثر على مملكة بـ ID: ${kingdomId}`);
    }

    // Check if this chat is already registered
    const existing = await db.queryOne(
      'SELECT id FROM cities WHERE chat_id = ?',
      [chatId]
    );
    if (existing) {
      return bot.sendMessage(chatId, 'هذه المجموعة مسجلة بالفعل كمدينة في النظام.');
    }

    await db.query(
      'INSERT INTO cities (chat_id, name, kingdom_id, is_capital) VALUES (?, ?, ?, ?)',
      [chatId, name, kingdomId, isCapital]
    );

    const typeLabel = isCapital ? 'القصر الإمبراطوري' : 'مدينة';
    await bot.sendMessage(
      chatId,
      `تم تسجيل هذه المجموعة.\n*النوع:* ${typeLabel}\n*الاسم:* ${name}\n*المملكة:* ${kingdom.name}`,
      { parse_mode: 'Markdown' }
    );
  });
}

module.exports = { register };