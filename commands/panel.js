const permissions = require('../utils/permissions');

/**
 * Handle $panel command - Admin panel
 */
function register(bot) {
  bot.onText(/^\$panel$/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    // Check permissions
    const hasPermission = await permissions.canManageCards(telegramId);
    if (!hasPermission) {
      return bot.sendMessage(chatId,
        `🚫 *ليس لديك صلاحية الوصول إلى لوحة التحكم.*\n\n` +
        `هذا الأمر مخصص للأدمن فقط.`,
        { parse_mode: 'Markdown' }
      );
    }

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🎭 بطاقة تعريفية', callback_data: 'panel_identity' },
            { text: '⚔️ بطاقة لعب', callback_data: 'panel_play' }
          ],
          [
            { text: '🌟 بطاقة مهارات', callback_data: 'panel_skill' },
            { text: '🗡️ بطاقة أسلحة', callback_data: 'panel_weapon' }
          ]
        ]
      }
    };

    bot.sendMessage(chatId,
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🎴 *لوحة تحكم البطاقات*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `اختر نوع البطاقة التي تريد إنشاءها:`,
      { parse_mode: 'Markdown', ...keyboard }
    );
  });
}

module.exports = { register };
