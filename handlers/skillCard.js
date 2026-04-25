const db = require('../db/connection');
const session = require('../middleware/sessionManager');
const { generateSkillCardId } = require('../utils/idGenerator');
const { SKILL_LABELS, DURATION_LABELS } = require('../utils/constants');
const { sendQR } = require('../utils/qrHelper');

function startSkillCardCreation(bot, chatId, telegramId) {
  session.setSession(telegramId, 'skill_card', 'awaiting_type');
  bot.sendMessage(chatId, `🌟 *إنشاء بطاقة مهارات*\n\nاختر النوع:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '🔄 عكس', callback_data: 'skilltype_reflect' }, { text: '❌ نفي', callback_data: 'skilltype_negate' }],
      [{ text: '🔒 تثبيت', callback_data: 'skilltype_stun' }, { text: '💪 جبروت', callback_data: 'skilltype_almighty' }],
      [{ text: '☠️ سم', callback_data: 'skilltype_poison' }]
    ]}
  });
}

function handleSkillTypeSelection(bot, chatId, telegramId, type) {
  session.setSession(telegramId, 'skill_card', 'awaiting_player_id', { type });
  bot.sendMessage(chatId, `✅ *${SKILL_LABELS[type]}*\n\nأدخل *كود اللاعب*:`, { parse_mode: 'Markdown' });
}

async function handleSkillCardStep(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const s = session.getSession(telegramId);
  if (s.action !== 'skill_card') return false;

  if (s.step === 'awaiting_player_id') {
    const player = await db.queryOne('SELECT * FROM players WHERE player_code = ?', [msg.text.trim()]);
    if (!player) { bot.sendMessage(chatId, '❌ لاعب غير موجود.'); return true; }
    session.setSession(telegramId, 'skill_card', 'awaiting_card_name', { ...s.data, playerId: player.id });
    bot.sendMessage(chatId, `✅ *${player.character_name}*\n\nأدخل *اسم البطاقة*:`, { parse_mode: 'Markdown' });
    return true;
  }

  if (s.step === 'awaiting_card_name') {
    const name = msg.text.trim();
    if (!name || name.length > 100) { bot.sendMessage(chatId, '❌ اسم غير صالح.'); return true; }
    const { type } = s.data;
    const base = { ...s.data, cardName: name };

    if (type === 'reflect' || type === 'almighty' || type === 'stun') {
      session.setSession(telegramId, 'skill_card', 'awaiting_effect_points', base);
      bot.sendMessage(chatId, `💥 أدخل *نقاط التأثير*:`, { parse_mode: 'Markdown' });
    } else if (type === 'poison') {
      session.setSession(telegramId, 'skill_card', 'awaiting_poison_percent', base);
      bot.sendMessage(chatId, `☠️ أدخل *نسبة السم* (مثال: 10):`, { parse_mode: 'Markdown' });
    } else {
      session.setSession(telegramId, 'skill_card', 'awaiting_duration', { ...base, effectPoints: 0, poisonPercent: 0 });
      showDurationButtons(bot, chatId);
    }
    return true;
  }

  if (s.step === 'awaiting_effect_points') {
    const val = parseInt(msg.text.trim());
    if (isNaN(val) || val < 1) { bot.sendMessage(chatId, '❌ أدخل رقماً أكبر من 0:'); return true; }
    session.setSession(telegramId, 'skill_card', 'awaiting_duration', { ...s.data, effectPoints: val, poisonPercent: 0 });
    showDurationButtons(bot, chatId);
    return true;
  }

  if (s.step === 'awaiting_poison_percent') {
    const val = parseFloat(msg.text.trim());
    if (isNaN(val) || val <= 0 || val > 100) { bot.sendMessage(chatId, '❌ أدخل نسبة بين 1 و 100:'); return true; }
    session.setSession(telegramId, 'skill_card', 'awaiting_duration', { ...s.data, effectPoints: 0, poisonPercent: val });
    showDurationButtons(bot, chatId);
    return true;
  }

  return false;
}

function showDurationButtons(bot, chatId) {
  bot.sendMessage(chatId, `⏳ اختر *مدة الأدوار*:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '1️⃣ دور',   callback_data: 'skilldur_1'   },
      { text: '2️⃣ دوران', callback_data: 'skilldur_2'   },
      { text: '♾️ جميع',  callback_data: 'skilldur_all' }
    ]]}
  });
}

async function handleSkillDurationSelection(bot, chatId, telegramId, duration) {
  const s = session.getSession(telegramId);
  if (s.action !== 'skill_card') return;

  const { playerId, cardName, type, effectPoints, poisonPercent } = s.data;

  let cardId;
  do { cardId = generateSkillCardId(); } while (await db.queryOne('SELECT id FROM skill_cards WHERE card_id = ?', [cardId]));

  await db.query(
    'INSERT INTO skill_cards (card_id,player_id,name,type,effect_points,poison_percent,duration) VALUES (?,?,?,?,?,?,?)',
    [cardId, playerId, cardName, type, effectPoints||0, poisonPercent||0, duration]
  );

  session.clearSession(telegramId);
  bot.sendMessage(chatId,
    `✅ *تم إنشاء بطاقة المهارة!*\n\n🆔 \`${cardId}\`\n📛 *${cardName}* — ${SKILL_LABELS[type]}\n⏳ ${DURATION_LABELS[duration]}`,
    { parse_mode: 'Markdown' }
  );
  await sendQR(bot, chatId, cardId);
}

module.exports = { startSkillCardCreation, handleSkillTypeSelection, handleSkillCardStep, handleSkillDurationSelection };
