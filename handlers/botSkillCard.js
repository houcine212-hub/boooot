const db = require('../db/connection');
const session = require('../middleware/sessionManager');
const { generateSkillCardId } = require('../utils/idGenerator');
const { SKILL_LABELS, DURATION_LABELS } = require('../utils/constants');
const { sendQR } = require('../utils/qrHelper');
const {
  ensureBotStoragePlayer,
  bindBotSkillCard
} = require('../utils/botCardStorage');

function startBotSkillCardCreation(bot, chatId, telegramId) {
  session.setSession(telegramId, 'bot_skill_card', 'awaiting_type');
  return bot.sendMessage(chatId, `🌟 *إنشاء بطاقة مهارات للبوت*\n\nاختر النوع:`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔄 عكس', callback_data: 'panelbot_skilltype_reflect' },
          { text: '❌ نفي', callback_data: 'panelbot_skilltype_negate' }
        ],
        [
          { text: '🔒 تثبيت', callback_data: 'panelbot_skilltype_stun' },
          { text: '💪 جبروت', callback_data: 'panelbot_skilltype_almighty' }
        ],
        [
          { text: '☠️ سم', callback_data: 'panelbot_skilltype_poison' }
        ]
      ]
    }
  });
}

function handleBotSkillTypeSelection(bot, chatId, telegramId, type) {
  session.setSession(telegramId, 'bot_skill_card', 'awaiting_level', { type });
  return bot.sendMessage(
    chatId,
    `✅ *${SKILL_LABELS[type]}*\n\nأدخل *رقم المستوى* الذي تريد إنشاء البطاقة له:`,
    { parse_mode: 'Markdown' }
  );
}

async function handleBotSkillCardStep(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const s = session.getSession(telegramId);
  if (s.action !== 'bot_skill_card') return false;

  if (s.step === 'awaiting_level') {
    const level = parseInt((msg.text || '').trim(), 10);
    if (Number.isNaN(level) || level < 1) {
      await bot.sendMessage(chatId, '❌ أدخل رقم مستوى صحيح أكبر من 0.');
      return true;
    }

    session.setSession(telegramId, 'bot_skill_card', 'awaiting_card_name', {
      ...s.data,
      level
    });
    await bot.sendMessage(
      chatId,
      `✅ المستوى: *${level}*\n\nأدخل *اسم البطاقة*:`,
      { parse_mode: 'Markdown' }
    );
    return true;
  }

  if (s.step === 'awaiting_card_name') {
    const name = (msg.text || '').trim();
    if (!name || name.length > 100) {
      await bot.sendMessage(chatId, '❌ اسم غير صالح.');
      return true;
    }

    const { type } = s.data;
    const base = { ...s.data, cardName: name };

    if (type === 'reflect' || type === 'almighty' || type === 'stun') {
      session.setSession(telegramId, 'bot_skill_card', 'awaiting_effect_points', base);
      await bot.sendMessage(chatId, `💥 أدخل *نقاط التأثير*:`, { parse_mode: 'Markdown' });
      return true;
    }

    if (type === 'poison') {
      session.setSession(telegramId, 'bot_skill_card', 'awaiting_poison_percent', base);
      await bot.sendMessage(chatId, `☠️ أدخل *نسبة السم* (مثال: 10):`, { parse_mode: 'Markdown' });
      return true;
    }

    session.setSession(telegramId, 'bot_skill_card', 'awaiting_duration', {
      ...base,
      effectPoints: 0,
      poisonPercent: 0
    });
    return showDurationButtons(bot, chatId);
  }

  if (s.step === 'awaiting_effect_points') {
    const value = parseInt((msg.text || '').trim(), 10);
    if (Number.isNaN(value) || value < 1) {
      await bot.sendMessage(chatId, '❌ أدخل رقماً أكبر من 0:');
      return true;
    }

    session.setSession(telegramId, 'bot_skill_card', 'awaiting_duration', {
      ...s.data,
      effectPoints: value,
      poisonPercent: 0
    });
    return showDurationButtons(bot, chatId);
  }

  if (s.step === 'awaiting_poison_percent') {
    const value = parseFloat((msg.text || '').trim());
    if (Number.isNaN(value) || value <= 0 || value > 100) {
      await bot.sendMessage(chatId, '❌ أدخل نسبة بين 1 و 100:');
      return true;
    }

    session.setSession(telegramId, 'bot_skill_card', 'awaiting_duration', {
      ...s.data,
      effectPoints: 0,
      poisonPercent: value
    });
    return showDurationButtons(bot, chatId);
  }

  return false;
}

function showDurationButtons(bot, chatId) {
  return bot.sendMessage(chatId, `⏳ اختر *مدة الأدوار*:`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '1️⃣ دور', callback_data: 'panelbot_skilldur_1' },
        { text: '2️⃣ دوران', callback_data: 'panelbot_skilldur_2' },
        { text: '♾️ جميع', callback_data: 'panelbot_skilldur_all' }
      ]]
    }
  });
}

async function handleBotSkillDurationSelection(bot, chatId, telegramId, duration) {
  const s = session.getSession(telegramId);
  if (s.action !== 'bot_skill_card') return;

  const owner = await ensureBotStoragePlayer();
  const { level, cardName, type, effectPoints, poisonPercent } = s.data;

  let cardId;
  do {
    cardId = generateSkillCardId();
  } while (await db.queryOne('SELECT id FROM skill_cards WHERE card_id = ?', [cardId]));

  await db.query(
    `INSERT INTO skill_cards (card_id, player_id, name, type, effect_points, poison_percent, duration)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [cardId, owner.id, cardName, type, effectPoints || 0, poisonPercent || 0, duration]
  );

  await bindBotSkillCard(level, cardId);
  session.clearSession(telegramId);

  await bot.sendMessage(
    chatId,
    `✅ *تم إنشاء بطاقة المهارة للبوت!*\n\n` +
    `🎯 المستوى: *${level}*\n` +
    `🆔 \`${cardId}\`\n` +
    `📝 *${cardName}* — ${SKILL_LABELS[type]}\n` +
    `⏳ ${DURATION_LABELS[duration]}`,
    { parse_mode: 'Markdown' }
  );
  await sendQR(bot, chatId, cardId);
}

module.exports = {
  startBotSkillCardCreation,
  handleBotSkillTypeSelection,
  handleBotSkillCardStep,
  handleBotSkillDurationSelection
};
