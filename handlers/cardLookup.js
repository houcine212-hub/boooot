const db = require('../db/connection');
const {
  SKILL_LABELS,
  DURATION_LABELS,
  WEAPON_TYPE_LABELS,
  BOOST_TARGET_LABELS,
  PLAY_TYPE_LABELS
} = require('../utils/constants');

const CARD_CONFIG = {
  IDC: {
    sql: `SELECT ic.*, p.character_name, p.player_code
            FROM identity_cards ic
            JOIN players p ON p.id = ic.player_id
           WHERE ic.card_id = ?`,
    format: (card) =>
      `🎭 *بطاقة تعريفية*\n\n🆔 \`${card.card_id}\`\n📝 *${card.name}*\n👤 ${card.character_name} (${card.player_code})\n\n` +
      `❤️ HP: ${card.hp} | ⚔️ ATK: ${card.atk} | ✨ Magic: ${card.magic}\n🛡️ DEF: ${card.def} | 💨 SPD: ${card.spd} | 🎯 Acc: ${card.accuracy}\n\n` +
      `💰 متبقي: ${card.remaining_points}/${card.total_points}\n` +
      `🧩 رصيد البطاقات الفرعية: ATK ${card.available_atk ?? card.atk} | Magic ${card.available_magic ?? card.magic} | DEF ${card.available_def ?? card.def} | SPD ${card.available_spd ?? card.spd} | Acc ${card.available_accuracy ?? card.accuracy}`
  },
  PLC: {
    sql: `SELECT pc.*, p.character_name
            FROM play_cards pc
            JOIN players p ON p.id = pc.player_id
           WHERE pc.card_id = ?`,
    format: (card) => {
      const stats = card.type === 'attack'
        ? `⚔️ ATK: ${card.atk} | 🎯 Acc: ${card.accuracy}`
        : card.type === 'magic'
          ? `✨ Magic: ${card.magic} | 🎯 Acc: ${card.accuracy}`
          : `🛡️ DEF: ${card.def} | 💨 SPD: ${card.spd}`;
      return `⚔️ *بطاقة لعب*\n\n🆔 \`${card.card_id}\`\n📝 *${card.name}* — ${PLAY_TYPE_LABELS[card.type]}\n👤 ${card.character_name}\n\n${stats}`;
    }
  },
  SKL: {
    sql: `SELECT sc.*, p.character_name
            FROM skill_cards sc
            JOIN players p ON p.id = sc.player_id
           WHERE sc.card_id = ?`,
    format: (card) => {
      const details = card.type === 'poison'
        ? `☠️ نسبة السم: ${card.poison_percent}%`
        : ['reflect', 'almighty', 'stun'].includes(card.type)
          ? `💥 نقاط التأثير: ${card.effect_points || 0}`
          : card.effect_points
            ? `💥 نقاط التأثير: ${card.effect_points}`
            : `ℹ️ بدون نقاط إضافية`;
      return `🌟 *بطاقة مهارة*\n\n🆔 \`${card.card_id}\`\n📝 *${card.name}* — ${SKILL_LABELS[card.type]}\n👤 ${card.character_name}\n\n${details}\n⏳ ${DURATION_LABELS[card.duration]}`;
    }
  },
  WPN: {
    sql: `SELECT wc.*, p.character_name
            FROM weapon_cards wc
            JOIN players p ON p.id = wc.player_id
           WHERE wc.card_id = ?`,
    format: (card) => {
      const stats = card.weapon_type === 'enhanced'
        ? `🔮 ${card.boost_percent}% → ${BOOST_TARGET_LABELS[card.boost_target]}\n⏳ ${DURATION_LABELS[card.duration]}`
        : card.sub_type === 'attack'
          ? `⚔️ ATK: ${card.atk} | 🎯 Acc: ${card.accuracy}`
          : card.sub_type === 'magic'
            ? `✨ Magic: ${card.magic} | 🎯 Acc: ${card.accuracy}`
            : `🛡️ DEF: ${card.def} | 💨 SPD: ${card.spd}`;
      return `🗡️ *بطاقة سلاح*\n\n🆔 \`${card.card_id}\`\n📝 *${card.name}* — ${WEAPON_TYPE_LABELS[card.weapon_type]}\n👤 ${card.character_name}\n\n${stats}`;
    }
  }
};

async function lookupCard(bot, chatId, cardId) {
  const prefix = cardId.split('-')[0];
  const config = CARD_CONFIG[prefix];
  if (!config) {
    return bot.sendMessage(chatId, '❌ نوع ID غير معروف.');
  }

  try {
    const card = await db.queryOne(config.sql, [cardId]);
    if (!card) {
      return bot.sendMessage(chatId, `❌ لم يتم العثور على: \`${cardId}\``, { parse_mode: 'Markdown' });
    }
    bot.sendMessage(chatId, config.format(card), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Card lookup error:', error.message);
    bot.sendMessage(chatId, '⚠️ خطأ أثناء البحث. حاول مجددًا.');
  }
}

module.exports = { lookupCard };
