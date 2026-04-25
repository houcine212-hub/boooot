const botFight = require('../handlers/botFight');

function register(bot) {
  bot.onText(/^\$bot(?:\s*(\d+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const rawLevel = match[1];

    if (!rawLevel) {
      return bot.sendMessage(
        chatId,
        '🤖 استعمل الأمر بهاد الشكل: `$bot1` أو `$bot 1` باش تعاود تلعب مع مستوى قديم من KimiBot.',
        { parse_mode: 'Markdown' }
      );
    }

    const requestedLevel = Number.parseInt(rawLevel, 10);
    if (Number.isNaN(requestedLevel) || requestedLevel < 1) {
      return bot.sendMessage(chatId, '❌ أدخل رقم مستوى صحيح أكبر من 0.');
    }

    return botFight.startBotFight(bot, chatId, telegramId, requestedLevel);
  });
}

module.exports = { register };
