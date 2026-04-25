const db = require('../db/connection');
const session = require('../middleware/sessionManager');
const { generateWeaponCardId } = require('../utils/idGenerator');
const { TOTAL_WEAPON_POINTS, WEAPON_TYPE_LABELS, BOOST_TARGET_LABELS, DURATION_LABELS, PLAY_TYPE_LABELS } = require('../utils/constants');
const { sendQR } = require('../utils/qrHelper');

// Stats to collect per normal weapon sub-type: [key, label]
const WEAPON_STATS = {
  attack:  [['atk', '⚔️ ATK'], ['accuracy', '🎯 Accuracy']],
  magic:   [['magic', '✨ Magic'], ['accuracy', '🎯 Accuracy']],
  defense: [['def', '🛡️ DEF'], ['spd', '💨 SPD']],
};

function startWeaponCardCreation(bot, chatId, telegramId) {
  session.setSession(telegramId, 'weapon_card', 'awaiting_weapon_type');
  bot.sendMessage(chatId, `🗡️ *إنشاء بطاقة سلاح*\n\nاختر النوع:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '🔮 سلاح معزز', callback_data: 'weapontype_enhanced' },
      { text: '🗡️ سلاح عادي', callback_data: 'weapontype_normal'  }
    ]]}
  });
}

function handleWeaponTypeSelection(bot, chatId, telegramId, weaponType) {
  session.setSession(telegramId, 'weapon_card', 'awaiting_player_id', { weaponType });
  bot.sendMessage(chatId, `✅ *${WEAPON_TYPE_LABELS[weaponType]}*\n\nأدخل *كود اللاعب*:`, { parse_mode: 'Markdown' });
}

function handleWeaponSubTypeSelection(bot, chatId, telegramId, subType) {
  const s = session.getSession(telegramId);
  if (s.action !== 'weapon_card') return;
  session.setSession(telegramId, 'weapon_card', 'awaiting_stat_0', { ...s.data, subType, remaining: TOTAL_WEAPON_POINTS, collected: {} });
  const [, label] = WEAPON_STATS[subType][0];
  bot.sendMessage(chatId, `${label}:\n💰 المتبقي: *${TOTAL_WEAPON_POINTS}*`, { parse_mode: 'Markdown' });
}

function handleWeaponBoostTargetSelection(bot, chatId, telegramId, target) {
  const s = session.getSession(telegramId);
  if (s.action !== 'weapon_card') return;
  session.setSession(telegramId, 'weapon_card', 'awaiting_duration', { ...s.data, boostTarget: target });
  showDurationButtons(bot, chatId);
}

async function handleWeaponDurationSelection(bot, chatId, telegramId, duration) {
  const s = session.getSession(telegramId);
  if (s.action !== 'weapon_card') return;
  const { playerId, cardName, weaponType, boostPercent, boostTarget } = s.data;

  let cardId;
  do { cardId = generateWeaponCardId(); } while (await db.queryOne('SELECT id FROM weapon_cards WHERE card_id = ?', [cardId]));

  await db.query(
    'INSERT INTO weapon_cards (card_id,player_id,name,weapon_type,boost_percent,boost_target,duration) VALUES (?,?,?,?,?,?,?)',
    [cardId, playerId, cardName, weaponType, boostPercent, boostTarget, duration]
  );

  session.clearSession(telegramId);
  bot.sendMessage(chatId,
    `✅ *تم إنشاء السلاح المعزز!*\n\n🆔 \`${cardId}\`\n📛 *${cardName}*\n🔮 ${boostPercent}% → ${BOOST_TARGET_LABELS[boostTarget]}\n⏳ ${DURATION_LABELS[duration]}`,
    { parse_mode: 'Markdown' }
  );
  await sendQR(bot, chatId, cardId);
}

async function handleWeaponCardStep(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const s = session.getSession(telegramId);
  if (s.action !== 'weapon_card') return false;

  if (s.step === 'awaiting_player_id') {
    const player = await db.queryOne('SELECT * FROM players WHERE player_code = ?', [msg.text.trim()]);
    if (!player) { bot.sendMessage(chatId, '❌ لاعب غير موجود.'); return true; }
    session.setSession(telegramId, 'weapon_card', 'awaiting_card_name', { ...s.data, playerId: player.id });
    bot.sendMessage(chatId, `✅ *${player.character_name}*\n\nأدخل *اسم السلاح*:`, { parse_mode: 'Markdown' });
    return true;
  }

  if (s.step === 'awaiting_card_name') {
    const name = msg.text.trim();
    if (!name || name.length > 100) { bot.sendMessage(chatId, '❌ اسم غير صالح.'); return true; }

    if (s.data.weaponType === 'enhanced') {
      session.setSession(telegramId, 'weapon_card', 'awaiting_boost_percent', { ...s.data, cardName: name });
      bot.sendMessage(chatId, `🔮 أدخل *نسبة التعزيز* (مثال: 25):`, { parse_mode: 'Markdown' });
    } else {
      session.setSession(telegramId, 'weapon_card', 'awaiting_sub_type', { ...s.data, cardName: name });
      bot.sendMessage(chatId, `🗡️ اختر *نوع السلاح*:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: '⚔️ هجومي',  callback_data: 'weaponsub_attack'  },
          { text: '🛡️ دفاعي', callback_data: 'weaponsub_defense' },
          { text: '✨ سحري',  callback_data: 'weaponsub_magic'   }
        ]]}
      });
    }
    return true;
  }

  if (s.step === 'awaiting_boost_percent') {
    const val = parseFloat(msg.text.trim());
    if (isNaN(val) || val <= 0) { bot.sendMessage(chatId, '❌ أدخل رقماً أكبر من 0:'); return true; }
    session.setSession(telegramId, 'weapon_card', 'awaiting_boost_target', { ...s.data, boostPercent: val });
    bot.sendMessage(chatId, `🎯 اختر *هدف التعزيز*:`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '⚔️ هجوم', callback_data: 'weaponboost_atk' }, { text: '✨ سحر', callback_data: 'weaponboost_magic' }, { text: '🛡️ دفاع', callback_data: 'weaponboost_def' }],
        [{ text: '💨 سرعة', callback_data: 'weaponboost_spd' }, { text: '🎯 دقة', callback_data: 'weaponboost_accuracy' }, { text: '💥 تأثير', callback_data: 'weaponboost_effect' }],
        [{ text: '🌟 الكل', callback_data: 'weaponboost_all' }]
      ]}
    });
    return true;
  }

  // Normal weapon stat loop
  const statMatch = s.step.match(/^awaiting_stat_(\d+)$/);
  if (statMatch) {
    const idx = parseInt(statMatch[1]);
    const stats = WEAPON_STATS[s.data.subType];
    const [key, label] = stats[idx];
    const val = parseInt(msg.text.trim());

    if (isNaN(val) || val < 0 || val > s.data.remaining) {
      bot.sendMessage(chatId, `❌ أدخل رقماً بين 0 و ${s.data.remaining}:`);
      return true;
    }

    const remaining = s.data.remaining - val;
    const collected = { ...s.data.collected, [key]: val };

    if (idx < stats.length - 1) {
      const [nk, nl] = stats[idx + 1];
      session.setSession(telegramId, 'weapon_card', `awaiting_stat_${idx + 1}`, { ...s.data, remaining, collected });
      bot.sendMessage(chatId, `✅ ${label} = ${val}\n\n${nl}:\n💰 المتبقي: *${remaining}*`, { parse_mode: 'Markdown' });
    } else {
      return await saveNormalWeapon(bot, chatId, telegramId, { ...s.data, remaining, collected });
    }
    return true;
  }

  return false;
}

async function saveNormalWeapon(bot, chatId, telegramId, data) {
  const { playerId, cardName, subType, collected } = data;

  let cardId;
  do { cardId = generateWeaponCardId(); } while (await db.queryOne('SELECT id FROM weapon_cards WHERE card_id = ?', [cardId]));

  await db.query(
    `INSERT INTO weapon_cards (card_id,player_id,name,weapon_type,sub_type,atk,magic,def,accuracy,spd,total_points) VALUES (?,?,?,'normal',?,?,?,?,?,?,?)`,
    [cardId, playerId, cardName, subType, collected.atk||0, collected.magic||0, collected.def||0, collected.accuracy||0, collected.spd||0, TOTAL_WEAPON_POINTS]
  );

  session.clearSession(telegramId);
  const statsText = Object.entries(collected).map(([k, v]) => `${k.toUpperCase()}: ${v}`).join(' | ');
  bot.sendMessage(chatId,
    `✅ *تم إنشاء السلاح العادي!*\n\n🆔 \`${cardId}\`\n📛 *${cardName}* — ${PLAY_TYPE_LABELS[subType]}\n${statsText}`,
    { parse_mode: 'Markdown' }
  );
  await sendQR(bot, chatId, cardId);
  return true;
}

function showDurationButtons(bot, chatId) {
  bot.sendMessage(chatId, `⏳ اختر *عدد الأدوار*:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '1️⃣ دور',   callback_data: 'weapondur_1'   },
      { text: '2️⃣ دوران', callback_data: 'weapondur_2'   },
      { text: '♾️ جميع',  callback_data: 'weapondur_all' }
    ]]}
  });
}

module.exports = {
  startWeaponCardCreation, handleWeaponTypeSelection, handleWeaponSubTypeSelection,
  handleWeaponBoostTargetSelection, handleWeaponDurationSelection, handleWeaponCardStep
};
