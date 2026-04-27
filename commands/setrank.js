'use strict';

const db         = require('../db/connection');
const rankSystem = require('../utils/rankSystem');
const rankLogger = require('../utils/rankLogger');

/**
 * $setrank [PlayerCode] [rank]
 *
 * Allowed by: city_ruler, governor, sage, prince, emperor, overlord
 * Restrictions:
 *   - city_ruler / governor → only within their city, max deputy/advisor
 *   - 5 uses per day for city_ruler / governor
 *   - cannot assign rank >= own rank
 *   - cannot act on someone >= own rank
 */
function register(bot) {
  bot.onText(/^\$setrank\s+(\S+)\s+(\S+)$/i, async (msg, match) => {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;

    try {
      // 1. Check actor has at least city_ruler rank
      if (!(await rankSystem.canSetRank(telegramId))) {
        return bot.sendMessage(chatId, '❌ ليس لديك صلاحية استخدام $setrank.');
      }

      const actorRank   = await rankSystem.getEffectiveRank(telegramId);
      const actorPlayer = await db.queryOne(
        'SELECT id, character_name, system_rank, city_id FROM players WHERE telegram_id = ?',
        [telegramId]
      );

      if (!actorPlayer) {
        return bot.sendMessage(chatId, '❌ لم يُعثر على حسابك في النظام.');
      }

      const targetCode = match[1].trim().toUpperCase();
      const newRank    = match[2].trim().toLowerCase();

      // 2. Validate the requested rank exists
      // FIX 1: was rankSystem.RANKS (does not exist) → now rankSystem.MANUAL_RANKS
      // Also exclude 'overlord' and 'none' from the user-facing valid list
      if (!rankSystem.MANUAL_RANKS.includes(newRank)) {
        const validList = rankSystem.MANUAL_RANKS
          .filter(r => r !== 'overlord' && r !== 'none')
          .join(' | ');
        return bot.sendMessage(chatId, `❌ رتبة غير صحيحة.\nالرتب المتاحة: ${validList}`);
      }

      // 3. Check actor is allowed to assign this rank
      const allowed = rankSystem.assignableRanks(actorRank);
      if (!allowed.includes(newRank)) {
        return bot.sendMessage(
          chatId,
          `❌ لا يمكنك إسناد رتبة *${rankSystem.MANUAL_LABELS[newRank]}*.\nحدّك الأقصى: ${allowed.map(r => rankSystem.MANUAL_LABELS[r]).join(', ')}`,
          { parse_mode: 'Markdown' }
        );
      }

      // 4. Fetch target player
      const target = await db.queryOne(
        'SELECT id, character_name, system_rank, city_id, telegram_id FROM players WHERE player_code = ?',
        [targetCode]
      );

      if (!target) {
        return bot.sendMessage(chatId, `❌ لم يُعثر على لاعب بالكود: ${targetCode}`);
      }

      // 5. Rank protection — cannot act on equal or higher
      if (!(await rankSystem.canActOn(telegramId, target.telegram_id))) {
        return bot.sendMessage(chatId, '❌ لا يمكنك التأثير على شخص برتبة مساوية أو أعلى منك.');
      }

      // 6. City restriction for city_ruler / governor
      const actorIndex = rankSystem.manualIndex(actorRank);
      if (actorIndex <= rankSystem.manualIndex('governor')) {
        if (!actorPlayer.city_id || actorPlayer.city_id !== target.city_id) {
          return bot.sendMessage(chatId, '❌ يمكنك فقط إسناد رتب داخل مدينتك.');
        }
      }

      // 7. Cooldown (city_ruler + governor only)
      if (actorIndex <= rankSystem.manualIndex('governor')) {
        const cooldown = await rankSystem.checkAndIncrementCooldown(actorPlayer.id);
        if (!cooldown.allowed) {
          return bot.sendMessage(chatId, `⏳ وصلت للحد اليومي (${rankSystem.SETRANK_DAILY_LIMIT} مرات). حاول غداً.`);
        }
      }

      // 8. Apply rank
      await rankSystem.applyRank(targetCode, newRank);

      // 9. Log the action
      await rankLogger.log({
        actorId:  actorPlayer.id,
        targetId: target.id,
        action:   'setrank',
        details:  `${actorPlayer.character_name} set rank of ${target.character_name} (${targetCode}) → ${newRank}`,
      });

      const label = rankSystem.MANUAL_LABELS[newRank];
      await bot.sendMessage(
        chatId,
        `✅ تم تعيين رتبة *${label}* للاعب *${target.character_name}* (${targetCode}).`,
        { parse_mode: 'Markdown' }
      );

    } catch (err) {
      console.error('[setrank] Error:', err.message);
      bot.sendMessage(chatId, '⚠️ حدث خطأ أثناء تنفيذ الأمر.');
    }
  });
}

module.exports = { register };