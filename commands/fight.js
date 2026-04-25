const botFight = require('../handlers/botFight');
const pvpFight = require('./pvp');

const FIGHT_GROUP_ID = -1003817802467;
const MENU_TTL = 2 * 60 * 1000;

const menuContexts = new Map();
const menuTimers = new Map();

function buildMenuKey(chatId, messageId) {
  return `${chatId}:${messageId}`;
}

function clearMenuTimer(key) {
  if (!menuTimers.has(key)) return;
  clearTimeout(menuTimers.get(key));
  menuTimers.delete(key);
}

function setMenuContext(chatId, messageId, context) {
  const key = buildMenuKey(chatId, messageId);
  menuContexts.set(key, context);
  clearMenuTimer(key);

  const timerId = setTimeout(() => {
    menuContexts.delete(key);
    menuTimers.delete(key);
  }, MENU_TTL);

  menuTimers.set(key, timerId);
}

function popMenuContext(chatId, messageId) {
  const key = buildMenuKey(chatId, messageId);
  const context = menuContexts.get(key) || null;
  menuContexts.delete(key);
  clearMenuTimer(key);
  return context;
}

function getMenuContext(chatId, messageId) {
  return menuContexts.get(buildMenuKey(chatId, messageId)) || null;
}

function register(bot) {
  bot.onText(/^\$fight$/, async (msg) => {
    const chatId = msg.chat.id;

    const menuMessage = await bot.sendMessage(chatId, `⚔️ *اختر نوع النزال:*`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🤖 نزالات مع KimiBot', callback_data: 'fight_bot' }],
          [{ text: '🤝 نزالات ودية', callback_data: 'fight_friendly' }],
          [{ text: '💰 نزالات النهب', callback_data: 'fight_loot' }],
          [{ text: '📖 طور القصة', callback_data: 'fight_story' }]
        ]
      }
    });

    setMenuContext(chatId, menuMessage.message_id, {
      challengerId: msg.from.id,
      challengerUser: msg.from,
      opponentUser: msg.reply_to_message?.from || null
    });
  });
}

async function handleFightCallback(bot, query) {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const telegramId = from.id;
  const context = getMenuContext(chatId, message.message_id);

  if (!context) {
    return bot.sendMessage(chatId, '❌ هاد menu ديال $fight سالات. عاود كتب $fight من جديد.');
  }

  if (context.challengerId !== telegramId) {
    return bot.sendMessage(chatId, '❌ غير اللي كتب $fight هو اللي يقدر يختار mode.');
  }

  if (data === 'fight_bot') {
    popMenuContext(chatId, message.message_id);

    if (chatId !== FIGHT_GROUP_ID) {
      return bot.sendMessage(
        chatId,
        `نزالات KimiBot متاحة فقط في المجموعة الرسمية!\nاكتب \`$fight\` تما واختار mode من جديد.`,
        { parse_mode: 'Markdown' }
      );
    }
    return botFight.startBotFight(bot, chatId, telegramId);
  }

  if (data === 'fight_friendly') {
    popMenuContext(chatId, message.message_id);

    if (botFight.hasFight(chatId)) {
      return bot.sendMessage(chatId, '❌ كاين نزال آخر خدام دابا فهاد الشات. تسنّى حتى يسالي.');
    }

    return pvpFight.startFriendlyChallenge(bot, {
      chatId,
      challengerUser: context.challengerUser,
      opponentUser: context.opponentUser
    });
  }

  if (['fight_loot', 'fight_story'].includes(data)) {
    popMenuContext(chatId, message.message_id);
    return bot.sendMessage(chatId, '🚧 هاد الوضع مازال قيد التطوير.');
  }

  return false;
}

module.exports = { register, handleFightCallback, FIGHT_GROUP_ID };
