const db = require('../db/connection');
const session = require('../middleware/sessionManager');
const permissions = require('../utils/permissions');

const DONE_WORDS = ['تم', 'done', 'skip', 'تخطي'];

function register(bot) {
  bot.onText(/^\$newbotcard$/, async (msg) => {
    if (!(await permissions.isAdmin(msg.from.id))) return bot.sendMessage(msg.chat.id, '🚫 أدمن فقط.');
    session.setSession(msg.from.id, 'newbotcard', 'awaiting_level', { identityCardId: null, playCards: [], skillCards: [], weaponCards: [] });
    bot.sendMessage(msg.chat.id,
      `🤖 *إنشاء مجموعة بطاقات بوت*\n\n1️⃣ المستوى → 2️⃣ IDC → 3️⃣ PLC → 4️⃣ SKL → 5️⃣ WPN\n\nأدخل *رقم المستوى*:`,
      { parse_mode: 'Markdown' }
    );
  });
}

async function handleStep(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const s = session.getSession(telegramId);
  if (s.action !== 'newbotcard') return false;

  const text = (msg.text || '').trim();
  const done = DONE_WORDS.includes(text.toLowerCase());

  if (s.step === 'awaiting_level') {
    const level = parseInt(text);
    if (isNaN(level) || level < 1) { bot.sendMessage(chatId, '❌ رقم مستوى غير صالح.'); return true; }
    session.setSession(telegramId, 'newbotcard', 'awaiting_identity', { ...s.data, level });
    bot.sendMessage(chatId, `✅ المستوى: *${level}*\n\nأدخل ID البطاقة التعريفية (IDC-):`, { parse_mode: 'Markdown' });
    return true;
  }

  if (s.step === 'awaiting_identity') {
    const cardId = extractId(text, 'IDC-');
    if (!cardId) { bot.sendMessage(chatId, '❌ ID يجب أن يبدأ بـ `IDC-`', { parse_mode: 'Markdown' }); return true; }
    const card = await db.queryOne('SELECT * FROM identity_cards WHERE card_id = ?', [cardId]);
    if (!card) { bot.sendMessage(chatId, `❌ البطاقة \`${cardId}\` غير موجودة.`, { parse_mode: 'Markdown' }); return true; }
    session.setSession(telegramId, 'newbotcard', 'awaiting_play_cards', { ...s.data, identityCardId: cardId });
    bot.sendMessage(chatId, `✅ \`${cardId}\` (${card.name})\n\nأدخل *بطاقات اللعب* (PLC-) أو اكتب \`تم\`:`, { parse_mode: 'Markdown' });
    return true;
  }

  if (s.step === 'awaiting_play_cards') {
    if (done) {
      session.setSession(telegramId, 'newbotcard', 'awaiting_skill_cards', s.data);
      bot.sendMessage(chatId, `✅ لعب: ${s.data.playCards.length}\n\nأدخل *بطاقات المهارات* (SKL-) أو اكتب \`تم\`:`, { parse_mode: 'Markdown' });
      return true;
    }
    return addCard(bot, chatId, telegramId, s, text, 'PLC-', 'play_cards', 'playCards', 'awaiting_play_cards');
  }

  if (s.step === 'awaiting_skill_cards') {
    if (done) {
      session.setSession(telegramId, 'newbotcard', 'awaiting_weapon_cards', s.data);
      bot.sendMessage(chatId, `✅ مهارات: ${s.data.skillCards.length}\n\nأدخل *بطاقات الأسلحة* (WPN-) أو اكتب \`تم\`:`, { parse_mode: 'Markdown' });
      return true;
    }
    return addCard(bot, chatId, telegramId, s, text, 'SKL-', 'skill_cards', 'skillCards', 'awaiting_skill_cards');
  }

  if (s.step === 'awaiting_weapon_cards') {
    if (done) return saveAll(bot, chatId, telegramId, s.data);
    return addCard(bot, chatId, telegramId, s, text, 'WPN-', 'weapon_cards', 'weaponCards', 'awaiting_weapon_cards');
  }

  return false;
}

// Shared helper for collecting cards in any stage
async function addCard(bot, chatId, telegramId, s, text, prefix, table, key, step) {
  const cardId = extractId(text, prefix);
  if (!cardId) {
    bot.sendMessage(chatId, `❌ ID يجب أن يبدأ بـ \`${prefix}\` أو اكتب \`تم\``, { parse_mode: 'Markdown' });
    return true;
  }
  if (s.data[key].includes(cardId)) {
    bot.sendMessage(chatId, `⚠️ \`${cardId}\` مضافة مسبقاً.`, { parse_mode: 'Markdown' });
    return true;
  }
  const card = await db.queryOne(`SELECT * FROM ${table} WHERE card_id = ?`, [cardId]);
  if (!card) {
    bot.sendMessage(chatId, `❌ \`${cardId}\` غير موجودة.`, { parse_mode: 'Markdown' });
    return true;
  }
  const updated = [...s.data[key], cardId];
  session.setSession(telegramId, 'newbotcard', step, { ...s.data, [key]: updated });
  bot.sendMessage(chatId, `➕ \`${cardId}\` — الإجمالي: ${updated.length}\n\nأدخل بطاقة أخرى أو اكتب \`تم\`:`, { parse_mode: 'Markdown' });
  return true;
}

async function saveAll(bot, chatId, telegramId, data) {
  const { level, identityCardId, playCards, skillCards, weaponCards } = data;
  try {
    const exists = await db.queryOne('SELECT level FROM bot_card_sets WHERE level = ?', [level]);
    exists
      ? await db.query('UPDATE bot_card_sets SET identity_card_id = ? WHERE level = ?', [identityCardId, level])
      : await db.query('INSERT INTO bot_card_sets (level, identity_card_id) VALUES (?,?)', [level, identityCardId]);

    await db.query('DELETE FROM bot_play_cards   WHERE level = ?', [level]);
    await db.query('DELETE FROM bot_skill_cards  WHERE level = ?', [level]);
    await db.query('DELETE FROM bot_weapon_cards WHERE level = ?', [level]);

    for (const id of playCards)   await db.query('INSERT INTO bot_play_cards   (level,card_id) VALUES (?,?)', [level, id]);
    for (const id of skillCards)  await db.query('INSERT INTO bot_skill_cards  (level,card_id) VALUES (?,?)', [level, id]);
    for (const id of weaponCards) await db.query('INSERT INTO bot_weapon_cards (level,card_id) VALUES (?,?)', [level, id]);

    session.clearSession(telegramId);
    bot.sendMessage(chatId,
      `✅ *تم الحفظ!*\n\n🎯 المستوى: *${level}*\n🎭 \`${identityCardId}\`\n` +
      `⚔️ لعب: ${playCards.length} | 🌟 مهارات: ${skillCards.length} | 🗡️ أسلحة: ${weaponCards.length}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('botCardWizard saveAll error:', err);
    bot.sendMessage(chatId, '❌ خطأ أثناء الحفظ.');
  }
  return true;
}

function extractId(text, prefix) {
  const match = text.match(new RegExp(`(${prefix}\\d{5})`));
  return match ? match[1] : null;
}

module.exports = { register, handleStep };
