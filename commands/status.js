'use strict';

const db                   = require('../db/connection');
const { getEmpireRank }    = require('../utils/rankHelper');
const { getLocationInfo }  = require('../utils/territoryHelper');

function register(bot) {
  bot.onText(/^\$status$/i, async (msg) => {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;

    try {
      const player = await db.queryOne(
        `SELECT p.id, p.character_name, p.player_code, p.wins, p.losses,
                p.rank_points, p.title, p.mg_balance
           FROM players p
          WHERE p.telegram_id = ?`,
        [telegramId]
      );

      if (!player) {
        return bot.sendMessage(chatId, 'غير مسجل. استخدم $login أولاً.');
      }

      const [identity, location] = await Promise.all([
        db.queryOne('SELECT * FROM identity_cards WHERE player_id = ? LIMIT 1', [player.id]),
        getLocationInfo(chatId)
      ]);

      const rankName = getEmpireRank(player.rank_points, player.title);

      // Build location line
      let locationLine;
      if (!location.found) {
        locationLine = '*الموقع:* خارج نطاق الإمبراطورية (أرض مجهولة)';
      } else if (location.isCapital) {
        locationLine = '*الموقع:* القصر الملكي (مقر العرش)';
      } else {
        locationLine = `*الموقع:* مدينة ${location.cityName} | ${location.kingdomName}`;
      }

      const statsBlock = identity
        ? [
            `HP: ${identity.hp}`,
            `ATK: ${identity.atk}  |  Magic: ${identity.magic || 0}`,
            `DEF: ${identity.def}  |  SPD: ${identity.spd}  |  Accuracy: ${identity.accuracy}`
          ].join('\n')
        : '_لا توجد بطاقة تعريفية مرتبطة بعد._';

      const mgBalance = Number(player.mg_balance || 0).toLocaleString('en-US');

      const lines = [
        '*[نظام إمبراطورية Master Card]*',
        locationLine,
        '',
        `*الكيان:* ${player.character_name} (${player.player_code})`,
        `*الرتبة/المنصب:* ${rankName}`,
        `*نقاط المجد:* ${player.rank_points} RP`,
        `*السجل:* ${player.wins} فوز | ${player.losses} هزيمة`,
        `*الرصيد:* ${mgBalance} MG 💰`,
        '',
        '*الخصائص الجسدية:*',
        statsBlock
      ];

      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });

    } catch (err) {
      console.error('[status] error:', err.message);
      await bot.sendMessage(chatId, 'حدث خطأ أثناء تحميل بياناتك. تأكد أن المشرف شغّل Migration ديال Territory.');
    }
  });
}

module.exports = { register };