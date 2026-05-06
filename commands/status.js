'use strict';

const db                   = require('../db/connection');
const rankSystem           = require('../utils/rankSystem');
const permissions          = require('../utils/permissions');
const { getLocationInfo }  = require('../utils/territoryHelper');

// ──────────────────────────────────────────────
// الرتب العالية: من city_ruler فما فوق
// هذا هو الحد اللي من فوقه يظهر الـ status الفاخر
// وتختفي نقاط RP
// ──────────────────────────────────────────────
const ELITE_MIN_INDEX = rankSystem.manualIndex('city_ruler'); // = 3

// إيموجي خاص لكل رتبة عالية
const ELITE_BADGE = {
  city_ruler: '⚔️',
  governor:   '🏛️',
  sage:       '🔮',
  prince:     '👑',
  emperor:    '👑⚔️',
  overlord:   '🔱',
};

function register(bot) {
  bot.onText(/^\$status$/i, async (msg) => {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;

    try {
      const player = await db.queryOne(
        `SELECT p.id, p.character_name, p.player_code, p.wins, p.losses,
                p.rank_points, p.title, p.mg_balance, p.system_rank
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

      // ─── تحديد الرتبة ─────────────────────────────
      // isMainAdmin → overlord (مشتق من ID مش من DB)
      // وإلا نشوفو system_rank في DB
      const isOverlord   = permissions.isMainAdmin(telegramId);
      const systemRank   = isOverlord ? 'overlord' : (player.system_rank || 'none');
      const rankIndex    = rankSystem.manualIndex(systemRank);
      const isElite      = rankIndex >= ELITE_MIN_INDEX;

      let rankName;
      if (player.title) {
        // title مخصص يطغى على كل شيء
        rankName = player.title;
      } else if (isOverlord) {
        rankName = rankSystem.MANUAL_LABELS['overlord'];
      } else {
        // getDisplayRankFromRow: بدون DB call زيادة
        rankName = rankSystem.getDisplayRankFromRow(player).label;
      }

      // ─── بناء سطر الموقع ──────────────────────────
      let locationLine;
      if (!location.found) {
        locationLine = '*الموقع:* خارج نطاق الإمبراطورية (أرض مجهولة)';
      } else if (location.isCapital) {
        locationLine = '*الموقع:* القصر الملكي (مقر العرش)';
      } else {
        locationLine = `*الموقع:* مدينة ${location.cityName} | ${location.kingdomName}`;
      }

      // ─── الخصائص الجسدية ──────────────────────────
      const statsBlock = identity
        ? [
            `HP: ${identity.hp}`,
            `ATK: ${identity.atk}  |  Magic: ${identity.magic || 0}`,
            `DEF: ${identity.def}  |  SPD: ${identity.spd}  |  Accuracy: ${identity.accuracy}`
          ].join('\n')
        : '_لا توجد بطاقة تعريفية مرتبطة بعد._';

      const mgBalance = Number(player.mg_balance || 0).toLocaleString('en-US');

      // ══════════════════════════════════════════════
      // STATUS الفاخر — للرتب العالية فقط
      // (city_ruler، governor، sage، prince، emperor، overlord)
      // ══════════════════════════════════════════════
      if (isElite) {
        const badge   = ELITE_BADGE[systemRank] || '⚔️';
        const divider = '═══════════════════════';

        const lines = [
          `*${divider}*`,
          `*${badge}  [نظام إمبراطورية Master Card]  ${badge}*`,
          `*${divider}*`,
          '',
          locationLine,
          '',
          `*الكيان:*  *${player.character_name}*  \`(${player.player_code})\``,
          `*الرتبة/المنصب:*  *${rankName}*`,
          `*السجل:*  ${player.wins} فوز  |  ${player.losses} هزيمة`,
          `*الرصيد:*  ${mgBalance} MG`,
          '',
          `*${divider}*`,
          '*الخصائص الجسدية:*',
          statsBlock,
          `*${divider}*`,
        ];

        return await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      }

      // ══════════════════════════════════════════════
      // STATUS العادي — للرتب الأقل (RP ranks + advisor + deputy)
      // ══════════════════════════════════════════════
      const lines = [
        '*[نظام إمبراطورية Master Card]*',
        locationLine,
        '',
        `*الكيان:* ${player.character_name} (${player.player_code})`,
        `*الرتبة/المنصب:* ${rankName}`,
        `*نقاط المجد:* ${player.rank_points} RP`,
        `*السجل:* ${player.wins} فوز | ${player.losses} هزيمة`,
        `*الرصيد:* ${mgBalance} MG`,
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