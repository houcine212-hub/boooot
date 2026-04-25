const db = require('../db/connection');
const session = require('../middleware/sessionManager');
const { generateWeaponCardId } = require('../utils/idGenerator');
const {
  TOTAL_WEAPON_POINTS,
  WEAPON_TYPE_LABELS,
  BOOST_TARGET_LABELS,
  DURATION_LABELS,
  PLAY_TYPE_LABELS,
  getBotLevelDistributionPoints
} = require('../utils/constants');
const { sendQR } = require('../utils/qrHelper');
const {
  ensureBotStoragePlayer,
  bindBotWeaponCard
} = require('../utils/botCardStorage');

const WEAPON_STATS = {
  attack: [['atk', '⚔️ ATK'], ['accuracy', '🎯 Accuracy']],
  magic: [['magic', '✨ Magic'], ['accuracy', '🎯 Accuracy']],
  defense: [['def', '🛡️ DEF'], ['spd', '💨 SPD']]
};

function startBotWeaponCardCreation(bot, chatId, telegramId) {
  session.setSession(telegramId, 'bot_weapon_card', 'awaiting_weapon_type');
  return bot.sendMessage(chatId, `🗡️ *إنشاء بطاقة سلاح للبوت*\n\nاختر النوع:`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '🔮 سلاح معزز', callback_data: 'panelbot_weapontype_enhanced' },
        { text: '🗡️ سلاح عادي', callback_data: 'panelbot_weapontype_normal' }
      ]]
    }
  });
}

function handleBotWeaponTypeSelection(bot, chatId, telegramId, weaponType) {
  session.setSession(telegramId, 'bot_weapon_card', 'awaiting_level', { weaponType });
  return bot.sendMessage(
    chatId,
    `✅ *${WEAPON_TYPE_LABELS[weaponType]}*\n\nأدخل *رقم المستوى* الذي تريد إنشاء البطاقة له:`,
    { parse_mode: 'Markdown' }
  );
}

async function handleBotWeaponCardStep(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const s = session.getSession(telegramId);
  if (s.action !== 'bot_weapon_card') return false;

  if (s.step === 'awaiting_level') {
    const level = parseInt((msg.text || '').trim(), 10);
    if (Number.isNaN(level) || level < 1) {
      await bot.sendMessage(chatId, '❌ أدخل رقم مستوى صحيح أكبر من 0.');
      return true;
    }

    const totalPoints = getBotLevelDistributionPoints(level, TOTAL_WEAPON_POINTS);
    session.setSession(telegramId, 'bot_weapon_card', 'awaiting_card_name', {
      ...s.data,
      level,
      totalPoints
    });
    await bot.sendMessage(
      chatId,
      `✅ المستوى: *${level}*\n💰 نقاط التوزيع: *${totalPoints}*\n\nأدخل *اسم السلاح*:`,
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

    if (s.data.weaponType === 'enhanced') {
      session.setSession(telegramId, 'bot_weapon_card', 'awaiting_boost_percent', {
        ...s.data,
        cardName: name
      });
      await bot.sendMessage(chatId, `🔮 أدخل *نسبة التعزيز* (مثال: 25):`, { parse_mode: 'Markdown' });
      return true;
    }

    session.setSession(telegramId, 'bot_weapon_card', 'awaiting_sub_type', {
      ...s.data,
      cardName: name
    });
    await bot.sendMessage(chatId, `🗡️ اختر *نوع السلاح*:`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '⚔️ هجومي', callback_data: 'panelbot_weaponsub_attack' },
          { text: '🛡️ دفاعي', callback_data: 'panelbot_weaponsub_defense' },
          { text: '✨ سحري', callback_data: 'panelbot_weaponsub_magic' }
        ]]
      }
    });
    return true;
  }

  if (s.step === 'awaiting_boost_percent') {
    const value = parseFloat((msg.text || '').trim());
    if (Number.isNaN(value) || value <= 0) {
      await bot.sendMessage(chatId, '❌ أدخل رقماً أكبر من 0:');
      return true;
    }

    session.setSession(telegramId, 'bot_weapon_card', 'awaiting_boost_target', {
      ...s.data,
      boostPercent: value
    });
    await bot.sendMessage(chatId, `🎯 اختر *هدف التعزيز*:`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '⚔️ هجوم', callback_data: 'panelbot_weaponboost_atk' },
            { text: '✨ سحر', callback_data: 'panelbot_weaponboost_magic' },
            { text: '🛡️ دفاع', callback_data: 'panelbot_weaponboost_def' }
          ],
          [
            { text: '💨 سرعة', callback_data: 'panelbot_weaponboost_spd' },
            { text: '🎯 دقة', callback_data: 'panelbot_weaponboost_accuracy' },
            { text: '💥 تأثير', callback_data: 'panelbot_weaponboost_effect' }
          ],
          [
            { text: '🌟 الكل', callback_data: 'panelbot_weaponboost_all' }
          ]
        ]
      }
    });
    return true;
  }

  const statMatch = s.step.match(/^awaiting_stat_(\d+)$/);
  if (statMatch) {
    const idx = parseInt(statMatch[1], 10);
    const stats = WEAPON_STATS[s.data.subType];
    const [key, label] = stats[idx];
    const value = parseInt((msg.text || '').trim(), 10);

    if (Number.isNaN(value) || value < 0 || value > s.data.remaining) {
      await bot.sendMessage(chatId, `❌ أدخل رقماً بين 0 و ${s.data.remaining}:`);
      return true;
    }

    const remaining = s.data.remaining - value;
    const collected = { ...s.data.collected, [key]: value };

    if (idx < stats.length - 1) {
      const [, nextLabel] = stats[idx + 1];
      session.setSession(telegramId, 'bot_weapon_card', `awaiting_stat_${idx + 1}`, {
        ...s.data,
        remaining,
        collected
      });
      await bot.sendMessage(
        chatId,
        `✅ ${label} = ${value}\n\n${nextLabel}:\n💰 المتبقي: *${remaining}*`,
        { parse_mode: 'Markdown' }
      );
      return true;
    }

    return saveNormalBotWeapon(bot, chatId, telegramId, {
      ...s.data,
      remaining,
      collected
    });
  }

  return false;
}

function handleBotWeaponSubTypeSelection(bot, chatId, telegramId, subType) {
  const s = session.getSession(telegramId);
  if (s.action !== 'bot_weapon_card') return;

  session.setSession(telegramId, 'bot_weapon_card', 'awaiting_stat_0', {
    ...s.data,
    subType,
    remaining: s.data.totalPoints,
    collected: {}
  });
  const [, label] = WEAPON_STATS[subType][0];
  return bot.sendMessage(chatId, `${label}:\n💰 المتبقي: *${s.data.totalPoints}*`, {
    parse_mode: 'Markdown'
  });
}

function handleBotWeaponBoostTargetSelection(bot, chatId, telegramId, target) {
  const s = session.getSession(telegramId);
  if (s.action !== 'bot_weapon_card') return;

  session.setSession(telegramId, 'bot_weapon_card', 'awaiting_duration', {
    ...s.data,
    boostTarget: target
  });
  return showDurationButtons(bot, chatId);
}

function showDurationButtons(bot, chatId) {
  return bot.sendMessage(chatId, `⏳ اختر *عدد الأدوار*:`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '1️⃣ دور', callback_data: 'panelbot_weapondur_1' },
        { text: '2️⃣ دوران', callback_data: 'panelbot_weapondur_2' },
        { text: '♾️ جميع', callback_data: 'panelbot_weapondur_all' }
      ]]
    }
  });
}

async function handleBotWeaponDurationSelection(bot, chatId, telegramId, duration) {
  const s = session.getSession(telegramId);
  if (s.action !== 'bot_weapon_card') return;

  const owner = await ensureBotStoragePlayer();
  const { level, cardName, weaponType, boostPercent, boostTarget } = s.data;

  let cardId;
  do {
    cardId = generateWeaponCardId();
  } while (await db.queryOne('SELECT id FROM weapon_cards WHERE card_id = ?', [cardId]));

  await db.query(
    `INSERT INTO weapon_cards (card_id, player_id, name, weapon_type, boost_percent, boost_target, duration)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [cardId, owner.id, cardName, weaponType, boostPercent, boostTarget, duration]
  );

  await bindBotWeaponCard(level, cardId);
  session.clearSession(telegramId);

  await bot.sendMessage(
    chatId,
    `✅ *تم إنشاء السلاح المعزز للبوت!*\n\n` +
      `🎯 المستوى: *${level}*\n` +
      `🆔 \`${cardId}\`\n` +
      `📝 *${cardName}*\n` +
      `🔮 ${boostPercent}% → ${BOOST_TARGET_LABELS[boostTarget]}\n` +
      `⏳ ${DURATION_LABELS[duration]}`,
    { parse_mode: 'Markdown' }
  );
  await sendQR(bot, chatId, cardId);
}

async function saveNormalBotWeapon(bot, chatId, telegramId, data) {
  const owner = await ensureBotStoragePlayer();
  const { level, cardName, subType, collected, totalPoints } = data;

  let cardId;
  do {
    cardId = generateWeaponCardId();
  } while (await db.queryOne('SELECT id FROM weapon_cards WHERE card_id = ?', [cardId]));

  await db.query(
    `INSERT INTO weapon_cards
     (card_id, player_id, name, weapon_type, sub_type, atk, magic, def, accuracy, spd, total_points)
     VALUES (?, ?, ?, 'normal', ?, ?, ?, ?, ?, ?, ?)`,
    [cardId, owner.id, cardName, subType, collected.atk || 0, collected.magic || 0, collected.def || 0, collected.accuracy || 0, collected.spd || 0, totalPoints]
  );

  await bindBotWeaponCard(level, cardId);
  session.clearSession(telegramId);

  const statsText = Object.entries(collected)
    .map(([key, value]) => `${key.toUpperCase()}: ${value}`)
    .join(' | ');

  await bot.sendMessage(
    chatId,
    `✅ *تم إنشاء السلاح العادي للبوت!*\n\n` +
      `🎯 المستوى: *${level}*\n` +
      `🆔 \`${cardId}\`\n` +
      `📝 *${cardName}* — ${PLAY_TYPE_LABELS[subType]}\n` +
      `${statsText}\n` +
      `💰 نقاط التوزيع: ${totalPoints}`,
    { parse_mode: 'Markdown' }
  );
  await sendQR(bot, chatId, cardId);
  return true;
}

module.exports = {
  startBotWeaponCardCreation,
  handleBotWeaponTypeSelection,
  handleBotWeaponSubTypeSelection,
  handleBotWeaponBoostTargetSelection,
  handleBotWeaponDurationSelection,
  handleBotWeaponCardStep
};
