const db = require('../db/connection');
const session = require('../middleware/sessionManager');
const permissions = require('../utils/permissions');
const {
  upsertBotIdentityLevel,
  bindBotPlayCard,
  bindBotSkillCard,
  bindBotWeaponCard
} = require('../utils/botCardStorage');

const TYPE_CONFIG = {
  identity: {
    prefix: 'IDC-',
    table: 'identity_cards',
    label: ' تعريفية',
    bind: upsertBotIdentityLevel
  },
  attack: {
    prefix: 'PLC-',
    table: 'play_cards',
    label: ' هجومية',
    bind: bindBotPlayCard,
    validate: (card) => card.type === 'attack'
  },
  defense: {
    prefix: 'PLC-',
    table: 'play_cards',
    label: ' دفاعية',
    bind: bindBotPlayCard,
    validate: (card) => card.type === 'defense'
  },
  magic: {
    prefix: 'PLC-',
    table: 'play_cards',
    label: ' سحرية',
    bind: bindBotPlayCard,
    validate: (card) => card.type === 'magic'
  },
  weapon: {
    prefix: 'WPN-',
    table: 'weapon_cards',
    label: ' أسلحة',
    bind: bindBotWeaponCard
  },
  skill: {
    prefix: 'SKL-',
    table: 'skill_cards',
    label: ' مهارات',
    bind: bindBotSkillCard
  }
};

function register(bot) {
  bot.onText(/^\$setcardbot$/, async (msg) => {
    if (!(await permissions.isAdmin(msg.from.id))) {
      return bot.sendMessage(msg.chat.id, ' أدمن فقط.');
    }
    return showTypeMenu(bot, msg.chat.id, msg.from.id);
  });
}

function showTypeMenu(bot, chatId, telegramId) {
  session.setSession(telegramId, 'setcardbot', 'select_type');
  return bot.sendMessage(chatId, ` *اختر نوع البطاقة:*`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: ' تعريفية', callback_data: 'bcm_type_identity' }],
        [{ text: ' هجومية', callback_data: 'bcm_type_attack' }, { text: ' دفاعية', callback_data: 'bcm_type_defense' }],
        [{ text: ' سحرية', callback_data: 'bcm_type_magic' }, { text: ' أسلحة', callback_data: 'bcm_type_weapon' }],
        [{ text: ' مهارات', callback_data: 'bcm_type_skill' }]
      ]
    }
  });
}

async function handleCallback(bot, query) {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const telegramId = from.id;
  if (!(await permissions.isAdmin(telegramId))) return;

  if (data === 'bcm_setcards') return showTypeMenu(bot, chatId, telegramId);

  if (data.startsWith('bcm_type_')) {
    const type = data.replace('bcm_type_', '');
    const { prefix, label } = TYPE_CONFIG[type];
    session.setSession(telegramId, 'setcardbot', 'awaiting_card_id', { type });
    return bot.sendMessage(
      chatId,
      ` *${label}*\n\nأدخل ID البطاقة (مثال: \`${prefix}XXXXX\`):`,
      { parse_mode: 'Markdown' }
    );
  }
}

async function handleStep(bot, msg, extractedCardId) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const s = session.getSession(telegramId);
  if (s.action !== 'setcardbot') return false;

  if (s.step === 'awaiting_card_id') {
    const { type } = s.data;
    const { prefix, table, validate } = TYPE_CONFIG[type];

    if (!extractedCardId || !extractedCardId.startsWith(prefix)) {
      await bot.sendMessage(chatId, ` ID يجب أن يبدأ بـ \`${prefix}\``, { parse_mode: 'Markdown' });
      return true;
    }

    const card = await db.queryOne(`SELECT * FROM ${table} WHERE card_id = ?`, [extractedCardId]);
    if (!card) {
      await bot.sendMessage(chatId, ' البطاقة غير موجودة.');
      return true;
    }

    if (validate && !validate(card)) {
      await bot.sendMessage(chatId, ' نوع البطاقة غير مطابق.');
      return true;
    }

    session.setSession(telegramId, 'setcardbot', 'awaiting_level', { type, cardId: extractedCardId });
    await bot.sendMessage(chatId, ` \`${extractedCardId}\`\n\nأدخل *رقم المستوى*:`, { parse_mode: 'Markdown' });
    return true;
  }

  if (s.step === 'awaiting_level') {
    const level = parseInt((msg.text || '').trim(), 10);
    if (Number.isNaN(level) || level < 1) {
      await bot.sendMessage(chatId, ' رقم مستوى غير صالح.');
      return true;
    }

    const { type, cardId } = s.data;
    const { bind } = TYPE_CONFIG[type];

    try {
      await bind(level, cardId);
      session.clearSession(telegramId);
      await bot.sendMessage(chatId, ` تمت إضافة \`${cardId}\` للمستوى *${level}*.`, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('botCardManager save error:', err);
      await bot.sendMessage(chatId, ' خطأ أثناء الحفظ.');
    }
    return true;
  }

  return false;
}

module.exports = { register, handleCallback, handleStep };
