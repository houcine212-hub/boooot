const db = require('../db/connection');
const session = require('../middleware/sessionManager');
const { generateIdentityCardId } = require('../utils/idGenerator');
const { TOTAL_IDENTITY_POINTS } = require('../utils/constants');
const { sendQR } = require('../utils/qrHelper');

const STATS = ['hp', 'atk', 'def', 'spd', 'accuracy'];
const STAT_LABELS = { hp: '❤️ HP', atk: '⚔️ ATK', def: '🛡️ DEF', spd: '💨 SPD', accuracy: '🎯 Accuracy' };

function startIdentityCardCreation(bot, chatId, telegramId) {
  session.setSession(telegramId, 'identity_card', 'awaiting_player_id');
  bot.sendMessage(chatId, `🎭 *إنشاء بطاقة تعريفية*\n\nأدخل *كود اللاعب*:`, { parse_mode: 'Markdown' });
}

async function handleIdentityCardStep(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const s = session.getSession(telegramId);
  if (s.action !== 'identity_card') return false;

  if (s.step === 'awaiting_player_id') {
    const player = await db.queryOne('SELECT * FROM players WHERE player_code = ?', [msg.text.trim()]);
    if (!player) { bot.sendMessage(chatId, '❌ لاعب غير موجود.'); return true; }
    session.setSession(telegramId, 'identity_card', 'awaiting_card_name', { playerId: player.id });
    bot.sendMessage(chatId, `✅ *${player.character_name}*\n\nأدخل *اسم البطاقة*:`, { parse_mode: 'Markdown' });
    return true;
  }

  if (s.step === 'awaiting_card_name') {
    const name = msg.text.trim();
    if (!name || name.length > 100) { bot.sendMessage(chatId, '❌ اسم غير صالح (1-100 حرف).'); return true; }
    session.setSession(telegramId, 'identity_card', 'awaiting_stat_0', { ...s.data, cardName: name, remaining: TOTAL_IDENTITY_POINTS, stats: {} });
    bot.sendMessage(chatId, `📊 توزيع *${TOTAL_IDENTITY_POINTS}* نقطة\n\n${STAT_LABELS.hp}:\n💰 المتبقي: *${TOTAL_IDENTITY_POINTS}*`, { parse_mode: 'Markdown' });
    return true;
  }

  // Stats loop: awaiting_stat_0 → awaiting_stat_4
  const statMatch = s.step.match(/^awaiting_stat_(\d+)$/);
  if (statMatch) {
    const idx = parseInt(statMatch[1]);
    const stat = STATS[idx];
    const val = parseInt(msg.text.trim());

    if (isNaN(val) || val < 0 || val > s.data.remaining) {
      bot.sendMessage(chatId, `❌ أدخل رقماً بين 0 و ${s.data.remaining}:`);
      return true;
    }

    const remaining = s.data.remaining - val;
    const stats = { ...s.data.stats, [stat]: val };

    if (idx < STATS.length - 1) {
      const nextStat = STATS[idx + 1];
      session.setSession(telegramId, 'identity_card', `awaiting_stat_${idx + 1}`, { ...s.data, remaining, stats });
      bot.sendMessage(chatId, `✅ ${STAT_LABELS[stat]} = ${val}\n\n${STAT_LABELS[nextStat]}:\n💰 المتبقي: *${remaining}*`, { parse_mode: 'Markdown' });
    } else {
      session.setSession(telegramId, 'identity_card', 'awaiting_magic', { ...s.data, remaining, stats });
      bot.sendMessage(chatId, `✅ ${STAT_LABELS[stat]} = ${val}\n\n✨ أدخل *حد السحر (Magic Cap)*:\n_لا يخصم من النقاط_`, { parse_mode: 'Markdown' });
    }
    return true;
  }

  if (s.step === 'awaiting_magic') {
    const val = parseInt(msg.text.trim());
    if (isNaN(val) || val < 0) { bot.sendMessage(chatId, '❌ أدخل رقماً صالحاً:'); return true; }

    const { playerId, cardName, stats } = s.data;
    const { hp, atk, def, spd, accuracy } = stats;
    const used = hp + atk + def + spd + accuracy;

    let cardId;
    do { cardId = generateIdentityCardId(); } while (await db.queryOne('SELECT id FROM identity_cards WHERE card_id = ?', [cardId]));

    await db.query(
      `INSERT INTO identity_cards
       (card_id,player_id,name,hp,atk,available_atk,magic,available_magic,def,available_def,spd,available_spd,accuracy,available_accuracy,total_points,remaining_points)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cardId, playerId, cardName, hp, atk, atk, val, val, def, def, spd, spd, accuracy, accuracy, TOTAL_IDENTITY_POINTS, TOTAL_IDENTITY_POINTS - used]
    );

    session.clearSession(telegramId);
    bot.sendMessage(chatId,
      `✅ *تم إنشاء البطاقة التعريفية!*\n\n🆔 \`${cardId}\`\n📛 *${cardName}*\n\n` +
      `❤️ HP: ${hp} | ⚔️ ATK: ${atk} | ✨ Magic: ${val}\n🛡️ DEF: ${def} | 💨 SPD: ${spd} | 🎯 Acc: ${accuracy}\n\n` +
      `💰 مستخدم: ${used}/${TOTAL_IDENTITY_POINTS}`,
      { parse_mode: 'Markdown' }
    );
    await sendQR(bot, chatId, cardId);
    return true;
  }

  return false;
}

module.exports = { startIdentityCardCreation, handleIdentityCardStep };
