const db = require('../db/connection');
const session = require('../middleware/sessionManager');
const { PLAY_TYPE_LABELS } = require('../utils/constants');
const { sendQR } = require('../utils/qrHelper');
const {
  createPlayCardWithAllocation,
  InsufficientPlayCardResourcesError
} = require('../services/playCardAllocationService');

// Stats to collect per card type: [key, label, ic_limit_key]
const TYPE_STATS = {
  attack: [['atk', '⚔️ ATK', 'ic_atk'], ['accuracy', '🎯 Accuracy', 'ic_accuracy']],
  magic: [['magic', '✨ Magic', 'ic_magic'], ['accuracy', '🎯 Accuracy', 'ic_accuracy']],
  defense: [['def', '🛡️ DEF', 'ic_def'], ['spd', '💨 SPD', 'ic_spd']]
};

function startPlayCardCreation(bot, chatId, telegramId) {
  session.setSession(telegramId, 'play_card', 'awaiting_type');
  bot.sendMessage(chatId, `⚔️ *إنشاء بطاقة لعب*\n\nاختر النوع:`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '⚔️ هجومية', callback_data: 'playtype_attack' },
        { text: '🛡️ دفاعية', callback_data: 'playtype_defense' },
        { text: '✨ سحرية', callback_data: 'playtype_magic' }
      ]]
    }
  });
}

function handlePlayCardTypeSelection(bot, chatId, telegramId, type) {
  session.setSession(telegramId, 'play_card', 'awaiting_player_id', { type });
  bot.sendMessage(chatId, `✅ *${PLAY_TYPE_LABELS[type]}*\n\nأدخل *كود اللاعب*:`, { parse_mode: 'Markdown' });
}

async function handlePlayCardStep(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const s = session.getSession(telegramId);
  if (s.action !== 'play_card') return false;

  if (s.step === 'awaiting_player_id') {
    const player = await db.queryOne(
      `SELECT p.*, ic.id AS ic_id, COALESCE(ic.available_atk, ic.atk) AS ic_atk, COALESCE(ic.available_magic, ic.magic) AS ic_magic,
              COALESCE(ic.available_def, ic.def) AS ic_def, COALESCE(ic.available_spd, ic.spd) AS ic_spd, COALESCE(ic.available_accuracy, ic.accuracy) AS ic_accuracy
       FROM players p
       LEFT JOIN identity_cards ic ON ic.player_id = p.id
       WHERE p.player_code = ?`,
      [msg.text.trim()]
    );
    if (!player) {
      bot.sendMessage(chatId, '❌ لاعب غير موجود.');
      return true;
    }
    if (!player.ic_id) {
      bot.sendMessage(chatId, '❌ لا توجد بطاقة تعريفية لهذا اللاعب.');
      return true;
    }

    session.setSession(telegramId, 'play_card', 'awaiting_card_name', {
      ...s.data,
      playerId: player.id,
      icId: player.ic_id,
      ic_atk: player.ic_atk,
      ic_magic: player.ic_magic,
      ic_def: player.ic_def,
      ic_spd: player.ic_spd,
      ic_accuracy: player.ic_accuracy
    });
    bot.sendMessage(
      chatId,
      `✅ *${player.character_name}*\n⚔️ ${player.ic_atk} | ✨ ${player.ic_magic} | 🛡️ ${player.ic_def} | 💨 ${player.ic_spd} | 🎯 ${player.ic_accuracy}\n\nأدخل *اسم البطاقة*:`,
      { parse_mode: 'Markdown' }
    );
    return true;
  }

  if (s.step === 'awaiting_card_name') {
    const name = msg.text.trim();
    if (!name || name.length > 100) {
      bot.sendMessage(chatId, '❌ اسم غير صالح.');
      return true;
    }
    session.setSession(telegramId, 'play_card', 'awaiting_stat_0', { ...s.data, cardName: name, collected: {} });
    const [, label, limitKey] = TYPE_STATS[s.data.type][0];
    bot.sendMessage(chatId, `${label}:\n📌 الحد الأقصى: *${s.data[limitKey]}*`, { parse_mode: 'Markdown' });
    return true;
  }

  const statMatch = s.step.match(/^awaiting_stat_(\d+)$/);
  if (statMatch) {
    const idx = parseInt(statMatch[1], 10);
    const stats = TYPE_STATS[s.data.type];
    const [key, label, limitKey] = stats[idx];
    const max = s.data[limitKey];
    const val = parseInt(msg.text.trim(), 10);

    if (Number.isNaN(val) || val < 0 || val > max) {
      bot.sendMessage(chatId, `❌ أدخل رقماً بين 0 و ${max}:`);
      return true;
    }

    const collected = { ...s.data.collected, [key]: val };

    if (idx < stats.length - 1) {
      const [, nextLabel, nextLimitKey] = stats[idx + 1];
      session.setSession(telegramId, 'play_card', `awaiting_stat_${idx + 1}`, { ...s.data, collected });
      bot.sendMessage(chatId, `✅ ${label} = ${val}\n\n${nextLabel}:\n📌 الحد الأقصى: *${s.data[nextLimitKey]}*`, { parse_mode: 'Markdown' });
    } else {
      return savePlayCard(bot, chatId, telegramId, { ...s.data, collected });
    }
    return true;
  }

  return false;
}

async function savePlayCard(bot, chatId, telegramId, data) {
  const { playerId, icId, cardName, type, collected } = data;

  let created;
  try {
    created = await createPlayCardWithAllocation({
      playerId,
      identityCardId: icId,
      cardName,
      type,
      stats: collected
    });
  } catch (error) {
    if (error instanceof InsufficientPlayCardResourcesError) {
      await bot.sendMessage(chatId, '❌ لا يوجد رصيد كافٍ في البطاقة التعريفية لهذا التوزيع.');
      return true;
    }
    throw error;
  }

  session.clearSession(telegramId);
  const statsText = Object.entries(collected).map(([key, value]) => `${key.toUpperCase()}: ${value}`).join(' | ');
  const balanceText = created.balances
    ? `\nالمتبقي: ATK ${created.balances.available_atk} | Magic ${created.balances.available_magic} | DEF ${created.balances.available_def} | SPD ${created.balances.available_spd} | Acc ${created.balances.available_accuracy}`
    : '';
  bot.sendMessage(
    chatId,
    `✅ *تم إنشاء بطاقة اللعب!*\n\n🆔 \`${created.cardId}\`\n📝 *${cardName}* — ${PLAY_TYPE_LABELS[type]}\n${statsText}${balanceText}`,
    { parse_mode: 'Markdown' }
  );
  await sendQR(bot, chatId, created.cardId);
  return true;
}

module.exports = { startPlayCardCreation, handlePlayCardTypeSelection, handlePlayCardStep };
