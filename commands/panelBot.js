const permissions = require('../utils/permissions');

function register(bot) {
  bot.onText(/^\$panelbot$/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    if (!(await permissions.isAdmin(telegramId))) {
      return bot.sendMessage(chatId, '🚫 هذا الأمر مخصص للأدمن فقط.');
    }

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🎭 بطاقة تعريفية', callback_data: 'panelbot_identity' },
            { text: '⚔️ بطاقة لعب', callback_data: 'panelbot_play' }
          ],
          [
            { text: '🌟 بطاقة مهارات', callback_data: 'panelbot_skill' },
            { text: '🗡️ بطاقة أسلحة', callback_data: 'panelbot_weapon' }
          ]
        ]
      }
    };

    return bot.sendMessage(
      chatId,
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🤖 *لوحة بطاقات البوت*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `اختر نوع البطاقة التي تريد إنشاءها للبوت:`,
      { parse_mode: 'Markdown', ...keyboard }
    );
  });
}

module.exports = { register };
