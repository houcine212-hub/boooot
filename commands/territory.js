'use strict';

const db          = require('../db/connection');
const permissions = require('../utils/permissions');

/**
 * Territory management commands (Main Admin only).
 *
 * $addkingdom [Name]
 *   → إضافة مملكة جديدة
 *
 * $addcitytokingdom [chat_id] [Name] [KingdomID] [is_capital: 0|1]
 *   → إضافة مدينة بـ chat_id صريح (ما خاصكش تكون داخل المجموعة)
 *
 * $deletC [chat_id]
 *   → حذف مدينة بـ chat_id ديالها
 *
 * $deletK [kingdom_id]
 *   → حذف مملكة (وكل مدنها) بـ ID ديالها
 *
 * $kingdoms
 *   → عرض قائمة كل الممالك والمدن
 */
function register(bot) {

  // ─── $addkingdom [Name] ───────────────────────────────────────────────────
  bot.onText(/^\$addkingdom\s+(.+)$/i, async (msg, match) => {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;

    if (!permissions.isMainAdmin(telegramId)) {
      return bot.sendMessage(chatId, ' هذا الأمر مخصص للمشرف الرئيسي فقط.');
    }

    const name = match[1].trim();
    if (!name) {
      return bot.sendMessage(chatId, ' استخدام: `$addkingdom [اسم المملكة]`', { parse_mode: 'Markdown' });
    }

    const existing = await db.queryOne('SELECT id FROM kingdoms WHERE name = ?', [name]);
    if (existing) {
      return bot.sendMessage(chatId, ` مملكة باسم *${name}* موجودة بالفعل بـ ID: \`${existing.id}\``, { parse_mode: 'Markdown' });
    }

    const result = await db.query('INSERT INTO kingdoms (name) VALUES (?)', [name]);

    await bot.sendMessage(
      chatId,
      `تم إنشاء المملكة بنجاح\\!\n*الاسم:* ${name}\n*ID:* \`${result.insertId}\`\n\nاستعمل هاد ID باش تضيف مدن بـ \`$addcitytokingdom\``,
      { parse_mode: 'Markdown' }
    );
  });

  // ─── $addcitytokingdom [chat_id] [Name] [KingdomID] [0|1] ────────────────
  bot.onText(/^\$addcitytokingdom\s+(-?\d+)\s+(.+?)\s+(\d+)\s+([01])$/i, async (msg, match) => {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;

    if (!permissions.isMainAdmin(telegramId)) {
      return bot.sendMessage(chatId, ' هذا الأمر مخصص للمشرف الرئيسي فقط.');
    }

    const groupChatId = parseInt(match[1], 10);
    const name        = match[2].trim();
    const kingdomId   = parseInt(match[3], 10);
    const isCapital   = match[4] === '1';

    // تحقق من وجود المملكة
    const kingdom = await db.queryOne('SELECT id, name FROM kingdoms WHERE id = ?', [kingdomId]);
    if (!kingdom) {
      return bot.sendMessage(chatId, ` لم يُعثر على مملكة بـ ID: \`${kingdomId}\`\nاستعمل \`$kingdoms\` باش تشوف القائمة.`, { parse_mode: 'Markdown' });
    }

    // تحقق إذا المجموعة مسجلة بالفعل
    const existing = await db.queryOne('SELECT id, name FROM cities WHERE chat_id = ?', [groupChatId]);
    if (existing) {
      return bot.sendMessage(
        chatId,
        ` هاد الـ chat_id (\`${groupChatId}\`) مسجل بالفعل كمدينة *${existing.name}*.`,
        { parse_mode: 'Markdown' }
      );
    }

    await db.query(
      'INSERT INTO cities (chat_id, name, kingdom_id, is_capital) VALUES (?, ?, ?, ?)',
      [groupChatId, name, kingdomId, isCapital]
    );

    const typeLabel = isCapital ? ' القصر الإمبراطوري' : ' مدينة';
    await bot.sendMessage(
      chatId,
      `تمت إضافة المدينة بنجاح\\!\n${typeLabel}: *${name}*\n*المملكة:* ${kingdom.name}\n*Chat ID:* \`${groupChatId}\``,
      { parse_mode: 'Markdown' }
    );
  });

  // ─── $deletC [chat_id] ────────────────────────────────────────────────────
  bot.onText(/^\$deletC\s+(-?\d+)$/i, async (msg, match) => {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;

    if (!permissions.isMainAdmin(telegramId)) {
      return bot.sendMessage(chatId, ' هذا الأمر مخصص للمشرف الرئيسي فقط.');
    }

    const groupChatId = parseInt(match[1], 10);

    const city = await db.queryOne(
      `SELECT c.id, c.name, k.name AS kingdomName
         FROM cities c
         JOIN kingdoms k ON k.id = c.kingdom_id
        WHERE c.chat_id = ?`,
      [groupChatId]
    );

    if (!city) {
      return bot.sendMessage(chatId, ` لم يُعثر على مدينة بـ chat_id: \`${groupChatId}\``, { parse_mode: 'Markdown' });
    }

    await db.query('DELETE FROM cities WHERE chat_id = ?', [groupChatId]);

    await bot.sendMessage(
      chatId,
      ` تم حذف المدينة *${city.name}* \\(${city.kingdomName}\\) بنجاح\\.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ─── $deletK [kingdom_id] ─────────────────────────────────────────────────
  bot.onText(/^\$deletK\s+(\d+)$/i, async (msg, match) => {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;

    if (!permissions.isMainAdmin(telegramId)) {
      return bot.sendMessage(chatId, ' هذا الأمر مخصص للمشرف الرئيسي فقط.');
    }

    const kingdomId = parseInt(match[1], 10);

    const kingdom = await db.queryOne('SELECT id, name FROM kingdoms WHERE id = ?', [kingdomId]);
    if (!kingdom) {
      return bot.sendMessage(chatId, ` لم يُعثر على مملكة بـ ID: \`${kingdomId}\``, { parse_mode: 'Markdown' });
    }

    // عدّ المدن قبل الحذف باش نبلّغ
    const [{ total }] = await db.query(
      'SELECT COUNT(*) AS total FROM cities WHERE kingdom_id = ?',
      [kingdomId]
    );

    // cities تتحذف تلقائياً بسبب ON DELETE CASCADE
    await db.query('DELETE FROM kingdoms WHERE id = ?', [kingdomId]);

    await bot.sendMessage(
      chatId,
      ` تم حذف مملكة *${kingdom.name}* وكل مدنها \\(${total} مدينة\\) بنجاح\\.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ─── $kingdoms ────────────────────────────────────────────────────────────
  bot.onText(/^\$kingdoms$/i, async (msg) => {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;

    if (!permissions.isMainAdmin(telegramId)) {
      return bot.sendMessage(chatId, ' هذا الأمر مخصص للمشرف الرئيسي فقط.');
    }

    const kingdoms = await db.query('SELECT id, name FROM kingdoms ORDER BY id');

    if (kingdoms.length === 0) {
      return bot.sendMessage(chatId, ' لا توجد ممالك مسجلة بعد.');
    }

    const lines = ['*قائمة الممالك والمدن:*', ''];

    for (const kingdom of kingdoms) {
      lines.push(` *${kingdom.name}* \\(ID: \`${kingdom.id}\`\\)`);

      const cities = await db.query(
        'SELECT chat_id, name, is_capital FROM cities WHERE kingdom_id = ? ORDER BY is_capital DESC, name',
        [kingdom.id]
      );

      if (cities.length === 0) {
        lines.push('  _لا توجد مدن_');
      } else {
        for (const city of cities) {
          const icon = city.is_capital ? '' : '';
          lines.push(`  ${icon} ${city.name} \\| \`${city.chat_id}\``);
        }
      }

      lines.push('');
    }

    await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'MarkdownV2' });
  });
}

module.exports = { register };