const db = require('../db/connection');
const session = require('../middleware/sessionManager');
const { generateIdentityCardId } = require('../utils/idGenerator');
const {
  TOTAL_IDENTITY_POINTS,
  getBotLevelDistributionPoints
} = require('../utils/constants');
const { sendQR } = require('../utils/qrHelper');
const {
  ensureBotStoragePlayer,
  upsertBotIdentityLevel
} = require('../utils/botCardStorage');

const STATS = ['hp', 'atk', 'def', 'spd', 'accuracy'];
const STAT_LABELS = {
  hp: '❤️ HP',
  atk: '⚔️ ATK',
  def: '🛡️ DEF',
  spd: '💨 SPD',
  accuracy: '🎯 Accuracy'
};

function startBotIdentityCardCreation(bot, chatId, telegramId) {
  session.setSession(telegramId, 'bot_identity_card', 'awaiting_level');
  return bot.sendMessage(
    chatId,
    `🤖 *إنشاء بطاقة تعريفية للبوت*\n\nأدخل *رقم المستوى* الذي تريد ربط البطاقة به:`,
    { parse_mode: 'Markdown' }
  );
}

async function handleBotIdentityCardStep(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const s = session.getSession(telegramId);
  if (s.action !== 'bot_identity_card') return false;

  if (s.step === 'awaiting_level') {
    const level = parseInt((msg.text || '').trim(), 10);
    if (Number.isNaN(level) || level < 1) {
      await bot.sendMessage(chatId, '❌ أدخل رقم مستوى صحيح أكبر من 0.');
      return true;
    }

    const totalPoints = getBotLevelDistributionPoints(level, TOTAL_IDENTITY_POINTS);
    session.setSession(telegramId, 'bot_identity_card', 'awaiting_card_name', {
      level,
      totalPoints
    });
    await bot.sendMessage(
      chatId,
      `✅ المستوى: *${level}*\n💰 نقاط التوزيع: *${totalPoints}*\n\nأدخل *اسم البطاقة*:`,
      { parse_mode: 'Markdown' }
    );
    return true;
  }

  if (s.step === 'awaiting_card_name') {
    const name = (msg.text || '').trim();
    if (!name || name.length > 100) {
      await bot.sendMessage(chatId, '❌ اسم غير صالح (1-100 حرف).');
      return true;
    }

    session.setSession(telegramId, 'bot_identity_card', 'awaiting_stat_0', {
      ...s.data,
      cardName: name,
      remaining: s.data.totalPoints,
      stats: {}
    });
    await bot.sendMessage(
      chatId,
      `📊 توزيع *${s.data.totalPoints}* نقطة\n\n${STAT_LABELS.hp}:\n💰 المتبقي: *${s.data.totalPoints}*`,
      { parse_mode: 'Markdown' }
    );
    return true;
  }

  const statMatch = s.step.match(/^awaiting_stat_(\d+)$/);
  if (statMatch) {
    const idx = parseInt(statMatch[1], 10);
    const stat = STATS[idx];
    const value = parseInt((msg.text || '').trim(), 10);

    if (Number.isNaN(value) || value < 0 || value > s.data.remaining) {
      await bot.sendMessage(chatId, `❌ أدخل رقماً بين 0 و ${s.data.remaining}:`);
      return true;
    }

    const remaining = s.data.remaining - value;
    const stats = { ...s.data.stats, [stat]: value };

    if (idx < STATS.length - 1) {
      const nextStat = STATS[idx + 1];
      session.setSession(telegramId, 'bot_identity_card', `awaiting_stat_${idx + 1}`, {
        ...s.data,
        remaining,
        stats
      });
      await bot.sendMessage(
        chatId,
        `✅ ${STAT_LABELS[stat]} = ${value}\n\n${STAT_LABELS[nextStat]}:\n💰 المتبقي: *${remaining}*`,
        { parse_mode: 'Markdown' }
      );
      return true;
    }

    session.setSession(telegramId, 'bot_identity_card', 'awaiting_magic', {
      ...s.data,
      remaining,
      stats
    });
    await bot.sendMessage(
      chatId,
      `✅ ${STAT_LABELS[stat]} = ${value}\n\n✨ أدخل *حد السحر (Magic Cap)*:\n_لا يخصم من النقاط_`,
      { parse_mode: 'Markdown' }
    );
    return true;
  }

  if (s.step === 'awaiting_magic') {
    const magic = parseInt((msg.text || '').trim(), 10);
    if (Number.isNaN(magic) || magic < 0) {
      await bot.sendMessage(chatId, '❌ أدخل رقماً صالحاً:');
      return true;
    }

    const owner = await ensureBotStoragePlayer();
    const { level, cardName, stats, totalPoints } = s.data;
    const { hp, atk, def, spd, accuracy } = stats;
    const used = hp + atk + def + spd + accuracy;

    let cardId;
    do {
      cardId = generateIdentityCardId();
    } while (await db.queryOne('SELECT id FROM identity_cards WHERE card_id = ?', [cardId]));

    await db.query(
      `INSERT INTO identity_cards
       (card_id, player_id, name, hp, atk, available_atk, magic, available_magic, def, available_def, spd, available_spd, accuracy, available_accuracy, total_points, remaining_points)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cardId, owner.id, cardName, hp, atk, atk, magic, magic, def, def, spd, spd, accuracy, accuracy, totalPoints, totalPoints - used]
    );

    await upsertBotIdentityLevel(level, cardId);
    session.clearSession(telegramId);

    await bot.sendMessage(
      chatId,
      `✅ *تم إنشاء البطاقة التعريفية للبوت!*\n\n` +
      `🎯 المستوى: *${level}*\n` +
      `🆔 \`${cardId}\`\n` +
      `📝 *${cardName}*\n\n` +
      `❤️ HP: ${hp} | ⚔️ ATK: ${atk} | ✨ Magic: ${magic}\n` +
      `🛡️ DEF: ${def} | 💨 SPD: ${spd} | 🎯 Acc: ${accuracy}\n\n` +
      `💰 مستخدم: ${used}/${totalPoints}`,
      { parse_mode: 'Markdown' }
    );
    await sendQR(bot, chatId, cardId);
    return true;
  }

  return false;
}

module.exports = {
  startBotIdentityCardCreation,
  handleBotIdentityCardStep
};
