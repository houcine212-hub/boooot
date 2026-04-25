const db = require('../db/connection');
const session = require('../middleware/sessionManager');
const { generatePlayerId } = require('../utils/idGenerator');

/**
 * Handle $login command
 */
function register(bot) {
  bot.onText(/^\$login$/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    // Check if already registered
    const existing = await db.queryOne(
      'SELECT * FROM players WHERE telegram_id = ?',
      [telegramId]
    );

    if (existing) {
      return bot.sendMessage(chatId,
        `⚠️ *أنت مسجل بالفعل!*\n\n` +
        `🆔 كود اللاعب: \`${existing.player_code}\`\n` +
        `👤 الاسم الحقيقي: ${existing.real_name}\n` +
        `🎭 اسم الشخصية: ${existing.character_name}`,
        { parse_mode: 'Markdown' }
      );
    }

    // Start registration flow
    session.setSession(telegramId, 'login', 'awaiting_real_name');

    bot.sendMessage(chatId,
      `🎴 *مرحباً بك في لعبة بطاقات الأنمي!*\n\n` +
      `📝 لنبدأ بتسجيلك في النظام.\n\n` +
      `👤 الرجاء إدخال *اسمك الحقيقي*:`,
      { parse_mode: 'Markdown' }
    );
  });
}

/**
 * Handle login conversation steps
 */
async function handleLoginStep(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const userSession = session.getSession(telegramId);

  if (userSession.action !== 'login') return false;

  switch (userSession.step) {
    case 'awaiting_real_name': {
      const realName = msg.text.trim();
      if (realName.length < 2 || realName.length > 100) {
        bot.sendMessage(chatId, '❌ الاسم يجب أن يكون بين 2 و 100 حرف. حاول مجدداً:');
        return true;
      }
      session.updateSessionData(telegramId, { realName });
      session.setSession(telegramId, 'login', 'awaiting_character_name', { realName });

      bot.sendMessage(chatId,
        `✅ تم حفظ اسمك: *${realName}*\n\n` +
        `🎭 الآن أدخل *اسم شخصيتك* في اللعبة:`,
        { parse_mode: 'Markdown' }
      );
      return true;
    }

    case 'awaiting_character_name': {
      const characterName = msg.text.trim();
      if (characterName.length < 2 || characterName.length > 100) {
        bot.sendMessage(chatId, '❌ اسم الشخصية يجب أن يكون بين 2 و 100 حرف. حاول مجدداً:');
        return true;
      }

      // Generate unique player code
      let playerCode;
      let isUnique = false;
      while (!isUnique) {
        playerCode = generatePlayerId();
        const check = await db.queryOne(
          'SELECT id FROM players WHERE player_code = ?',
          [playerCode]
        );
        if (!check) isUnique = true;
      }

      // Save to database
      const { realName } = userSession.data;
      await db.query(
        `INSERT INTO players (telegram_id, real_name, character_name, player_code) 
         VALUES (?, ?, ?, ?)`,
        [telegramId, realName, characterName, playerCode]
      );

      session.clearSession(telegramId);

      bot.sendMessage(chatId,
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🎉 *تم التسجيل بنجاح!*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `👤 الاسم الحقيقي: *${realName}*\n` +
        `🎭 اسم الشخصية: *${characterName}*\n` +
        `🆔 كود اللاعب: \`${playerCode}\`\n\n` +
        `📌 احتفظ بكود اللاعب الخاص بك!\n` +
        `🎴 يمكنك الآن البدء في اللعب.`,
        { parse_mode: 'Markdown' }
      );
      return true;
    }
  }

  return false;
}

module.exports = { register, handleLoginStep };
