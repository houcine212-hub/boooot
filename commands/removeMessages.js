const permissions = require('../utils/permissions');

function register(bot) {
  bot.onText(/^\$rm(?:\s+(\d+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    // تحقق من الأدمن
    if (!(await permissions.isAdmin(telegramId))) {
      return bot.sendMessage(chatId, '❌ هذا الأمر مخصص للأدمن فقط.');
    }

    // عدد الرسائل (default 50)
    const count = Math.min(parseInt(match[1]) || 50, 100);

    let deleted = 0;

    for (let i = 0; i < count; i++) {
      const messageId = msg.message_id - i;

      try {
        await bot.deleteMessage(chatId, messageId);
        deleted++;
      } catch (err) {
        // ignore errors (message already deleted / too old)
      }
    }

    bot.sendMessage(chatId, `🧹 تم حذف ${deleted} رسالة.`);
  });
}

module.exports = { register };
