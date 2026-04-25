const session = require('../middleware/sessionManager');
const { PLAY_TYPE_LABELS } = require('../utils/constants');
const { sendQR } = require('../utils/qrHelper');
const {
  createPlayCardWithAllocation,
  InsufficientPlayCardResourcesError
} = require('../services/playCardAllocationService');
const {
  ensureBotStoragePlayer,
  bindBotPlayCard,
  loadBotIdentityForLevel
} = require('../utils/botCardStorage');

const TYPE_STATS = {
  attack: [['atk', '⚔️ ATK', 'ic_atk'], ['accuracy', '🎯 Accuracy', 'ic_accuracy']],
  magic: [['magic', '✨ Magic', 'ic_magic'], ['accuracy', '🎯 Accuracy', 'ic_accuracy']],
  defense: [['def', '🛡️ DEF', 'ic_def'], ['spd', '💨 SPD', 'ic_spd']]
};

function startBotPlayCardCreation(bot, chatId, telegramId) {
  session.setSession(telegramId, 'bot_play_card', 'awaiting_type');
  return bot.sendMessage(chatId, `⚔️ *إنشاء بطاقة لعب للبوت*\n\nاختر النوع:`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '⚔️ هجومية', callback_data: 'panelbot_playtype_attack' },
        { text: '🛡️ دفاعية', callback_data: 'panelbot_playtype_defense' },
        { text: '✨ سحرية', callback_data: 'panelbot_playtype_magic' }
      ]]
    }
  });
}

function handleBotPlayCardTypeSelection(bot, chatId, telegramId, type) {
  session.setSession(telegramId, 'bot_play_card', 'awaiting_level', { type });
  return bot.sendMessage(
    chatId,
    `✅ *${PLAY_TYPE_LABELS[type]}*\n\nأدخل *رقم المستوى* الذي تريد إنشاء البطاقة له:`,
    { parse_mode: 'Markdown' }
  );
}

async function handleBotPlayCardStep(bot, msg, deps = {}) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const s = session.getSession(telegramId);
  const loadIdentityForLevel = deps.loadBotIdentityForLevel || loadBotIdentityForLevel;
  if (s.action !== 'bot_play_card') return false;

  if (s.step === 'awaiting_level') {
    const level = parseInt((msg.text || '').trim(), 10);
    if (Number.isNaN(level) || level < 1) {
      await bot.sendMessage(chatId, '❌ أدخل رقم مستوى صحيح أكبر من 0.');
      return true;
    }

    const identity = await loadIdentityForLevel(level);
    if (!identity) {
      session.clearSession(telegramId);
      await bot.sendMessage(
        chatId,
        `❌ لا توجد بطاقة تعريفية مرتبطة بالمستوى *${level}*.\nأنشئ بطاقة تعريفية للبوت أولاً ثم أعد المحاولة.`,
        { parse_mode: 'Markdown' }
      );
      return true;
    }

    session.setSession(telegramId, 'bot_play_card', 'awaiting_card_name', {
      ...s.data,
      level,
      icId: identity.id,
      ic_atk: identity.available_atk ?? identity.atk,
      ic_magic: identity.available_magic ?? identity.magic,
      ic_def: identity.available_def ?? identity.def,
      ic_spd: identity.available_spd ?? identity.spd,
      ic_accuracy: identity.available_accuracy ?? identity.accuracy
    });
    await bot.sendMessage(
      chatId,
      `✅ المستوى: *${level}*\n` +
      `🎭 البطاقة التعريفية: \`${identity.card_id}\`\n` +
      `⚔️ ${identity.available_atk ?? identity.atk} | ✨ ${identity.available_magic ?? identity.magic} | 🛡️ ${identity.available_def ?? identity.def} | 💨 ${identity.available_spd ?? identity.spd} | 🎯 ${identity.available_accuracy ?? identity.accuracy}\n\n` +
      `أدخل *اسم البطاقة*:`,
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

    session.setSession(telegramId, 'bot_play_card', 'awaiting_stat_0', {
      ...s.data,
      cardName: name,
      collected: {}
    });
    const [, label, limitKey] = TYPE_STATS[s.data.type][0];
    await bot.sendMessage(chatId, `${label}:\n📌 الحد الأقصى: *${s.data[limitKey]}*`, { parse_mode: 'Markdown' });
    return true;
  }

  const statMatch = s.step.match(/^awaiting_stat_(\d+)$/);
  if (statMatch) {
    const idx = parseInt(statMatch[1], 10);
    const stats = TYPE_STATS[s.data.type];
    const [key, label, limitKey] = stats[idx];
    const max = s.data[limitKey];
    const value = parseInt((msg.text || '').trim(), 10);

    if (Number.isNaN(value) || value < 0 || value > max) {
      await bot.sendMessage(chatId, `❌ أدخل رقماً بين 0 و ${max}:`);
      return true;
    }

    const collected = { ...s.data.collected, [key]: value };

    if (idx < stats.length - 1) {
      const [, nextLabel, nextLimitKey] = stats[idx + 1];
      session.setSession(telegramId, 'bot_play_card', `awaiting_stat_${idx + 1}`, {
        ...s.data,
        collected
      });
      await bot.sendMessage(chatId, `✅ ${label} = ${value}\n\n${nextLabel}:\n📌 الحد الأقصى: *${s.data[nextLimitKey]}*`, {
        parse_mode: 'Markdown'
      });
      return true;
    }

    return saveBotPlayCard(bot, chatId, telegramId, { ...s.data, collected }, deps);
  }

  return false;
}

async function saveBotPlayCard(bot, chatId, telegramId, data, deps = {}) {
  const storagePlayer = deps.ensureBotStoragePlayer || ensureBotStoragePlayer;
  const bindPlayCard = deps.bindBotPlayCard || bindBotPlayCard;

  const owner = await storagePlayer();
  const { level, icId, cardName, type, collected } = data;

  let created;
  try {
    created = await createPlayCardWithAllocation({
      playerId: owner.id,
      identityCardId: icId,
      cardName,
      type,
      stats: collected
    });
  } catch (error) {
    if (error instanceof InsufficientPlayCardResourcesError) {
      await bot.sendMessage(chatId, '❌ لا يوجد رصيد كافٍ في البطاقة التعريفية المرتبطة بهذا المستوى.');
      return true;
    }
    throw error;
  }

  await bindPlayCard(level, created.cardId);
  session.clearSession(telegramId);

  const statsText = Object.entries(collected)
    .map(([key, value]) => `${key.toUpperCase()}: ${value}`)
    .join(' | ');
  const balanceText = created.balances
    ? `\nالمتبقي: ATK ${created.balances.available_atk} | Magic ${created.balances.available_magic} | DEF ${created.balances.available_def} | SPD ${created.balances.available_spd} | Acc ${created.balances.available_accuracy}`
    : '';

  await bot.sendMessage(
    chatId,
    `✅ *تم إنشاء بطاقة اللعب للبوت!*\n\n` +
    `🎯 المستوى: *${level}*\n` +
    `🆔 \`${created.cardId}\`\n` +
    `📝 *${cardName}* — ${PLAY_TYPE_LABELS[type]}\n` +
    `${statsText}${balanceText}`,
    { parse_mode: 'Markdown' }
  );
  await sendQR(bot, chatId, created.cardId);
  return true;
}

module.exports = {
  startBotPlayCardCreation,
  handleBotPlayCardTypeSelection,
  handleBotPlayCardStep
};
