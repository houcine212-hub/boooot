'use strict';

const db         = require('../db/connection');
const rankSystem = require('../utils/rankSystem');
const rankLogger = require('../utils/rankLogger');
const ledgerManager = require('../utils/ledgerManager');

/**
 * $settitle [PlayerCode] [TitleName]
 * Pass "-" as title to clear it.
 *
 * Allowed by: overlord, emperor only.
 */
function register(bot) {
  bot.onText(/^\$settitle\s+(\S+)\s+(.+)$/i, async (msg, match) => {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;

    try {
      if (!(await rankSystem.canSetTitle(telegramId))) {
        return bot.sendMessage(chatId, ' هذا الأمر مخصص للإمبراطور و Overlord فقط.');
      }

      const actorPlayer = await rankSystem.getPlayer(telegramId);
      if (!actorPlayer) {
        return bot.sendMessage(chatId, ' لم يُعثر على حسابك في النظام.');
      }

      const playerCode = match[1].trim().toUpperCase();
      const rawTitle   = match[2].trim();
      const newTitle   = rawTitle === '-' ? null : rawTitle;

      const target = await db.queryOne(
        'SELECT id, character_name, telegram_id FROM players WHERE player_code = ?',
        [playerCode]
      );

      if (!target) {
        return bot.sendMessage(chatId, ` لم يُعثر على لاعب بالكود: ${playerCode}`);
      }

      // Overlord can set title on anyone including themselves.
      // Emperor and below cannot touch someone at equal or higher rank.
      const actorIsOverlord = rankSystem.rankIndex(await rankSystem.getEffectiveRank(telegramId)) >= rankSystem.rankIndex('overlord');
      if (!actorIsOverlord && !(await rankSystem.canActOn(telegramId, target.telegram_id))) {
        return bot.sendMessage(chatId, ' لا يمكنك التأثير على شخص برتبة مساوية أو أعلى منك.');
      }

      await db.query(
        'UPDATE players SET title = ? WHERE player_code = ?',
        [newTitle, playerCode]
      );

      await rankLogger.log({
        actorId:  actorPlayer.id,
        targetId: target.id,
        action:   'settitle',
        details:  `${actorPlayer.character_name} set title of ${target.character_name} (${playerCode}) → "${newTitle ?? 'cleared'}"`,
      });

      await ledgerManager.updateLedger(actorPlayer.id, 'titles_assigned');

      const confirmation = newTitle
        ? ` تم تعيين منصب *${newTitle}* للاعب *${target.character_name}* (${playerCode}).`
        : ` تم إزالة المنصب المخصص للاعب *${target.character_name}* (${playerCode}).`;

      await bot.sendMessage(chatId, confirmation, { parse_mode: 'Markdown' });

    } catch (err) {
      console.error('[settitle] Error:', err.message);
      bot.sendMessage(chatId, ' حدث خطأ أثناء تنفيذ الأمر.');
    }
  });
}

module.exports = { register };