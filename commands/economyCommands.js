'use strict';

const db         = require('../db/connection');
const rankSystem = require('../utils/rankSystem');
const economy    = require('../utils/economy');
const ledgerManager = require('../utils/ledgerManager');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

function esc(str) {
  // Escape special MarkdownV2 characters
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

async function getActorLabel(telegramId) {
  const player = await db.queryOne(
    'SELECT player_code, character_name FROM players WHERE telegram_id = ?',
    [telegramId]
  );
  return player ? `${player.character_name} (${player.player_code})` : `TG:${telegramId}`;
}

// ─── Register ─────────────────────────────────────────────────────────────────

function register(bot) {

  // ── $giveMoney ────────────────────────────────────────────────────────────
  bot.onText(/^\$giveMoney\s+(.+)$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const tid    = msg.from.id;

    const actorRank = await rankSystem.getEffectiveRank(tid);
    if (actorRank === 'none') {
      return bot.sendMessage(chatId, ' ما عندكش الصلاحية باش تستعمل هاد الأمر.');
    }

    const args = match[1].trim().split(/\s+/);

    // Form 1: $giveMoney [amount] — mint to treasury
    if (args.length === 1) {
      if (actorRank !== 'overlord') {
        return bot.sendMessage(chatId, ' خلق الفلوس مخصص للـ Overlord فقط.');
      }
      const amount = parseInt(args[0], 10);
      if (!amount || amount <= 0) return bot.sendMessage(chatId, ' المبلغ يجب أن يكون رقم موجب.');
      try {
        const actorLabel = await getActorLabel(tid);
        const newBalance = await economy.mintToTreasury(amount, actorLabel);

        const actorPlayer = await db.queryOne('SELECT id FROM players WHERE telegram_id = ?', [tid]);
        if (actorPlayer) await ledgerManager.updateLedger(actorPlayer.id, 'mg_given', amount);

        return bot.sendMessage(
          chatId,
          ` تم إنشاء *${esc(fmt(amount))} MG* وإيداعها في الخزينة الإمبراطورية\\.\n *الرصيد الجديد للخزينة:* ${esc(fmt(newBalance))} MG`,
          { parse_mode: 'MarkdownV2' }
        );
      } catch (err) {
        console.error('[giveMoney/mint]', err.message);
        return bot.sendMessage(chatId, ` خطأ: ${err.message}`);
      }
    }

    // Form 2 & 3: $giveMoney [name] [amount]
    if (args.length >= 2) {
      const amount     = parseInt(args[args.length - 1], 10);
      const targetName = args.slice(0, args.length - 1).join(' ');
      if (!amount || amount <= 0) return bot.sendMessage(chatId, ' المبلغ يجب أن يكون رقم موجب.');

      const actorIdx = rankSystem.manualIndex(actorRank);

      const kingdom = await db.queryOne('SELECT id, name FROM kingdoms WHERE name = ?', [targetName]);
      if (kingdom) {
        if (actorIdx < rankSystem.manualIndex('emperor')) {
          return bot.sendMessage(chatId, ' منح فلوس لمملكة يتطلب رتبة *إمبراطور* أو أعلى.', { parse_mode: 'Markdown' });
        }
        try {
          const actorLabel = await getActorLabel(tid);
          const result     = await economy.treasuryToKingdom(kingdom.id, amount, actorLabel);

          const actorPlayer = await db.queryOne('SELECT id FROM players WHERE telegram_id = ?', [tid]);
          if (actorPlayer) await ledgerManager.updateLedger(actorPlayer.id, 'mg_given', amount);

          return bot.sendMessage(
            chatId,
            ` تم تحويل *${esc(fmt(amount))} MG* إلى مملكة *${esc(kingdom.name)}*\\.\n *رصيد المملكة الجديد:* ${esc(fmt(result.newKingdomBalance))} MG\n💰 *رصيد الخزينة المتبقي:* ${esc(fmt(result.newTreasuryBalance))} MG`,
            { parse_mode: 'MarkdownV2' }
          );
        } catch (err) {
          console.error('[giveMoney/kingdom]', err.message);
          return bot.sendMessage(chatId, ` ${err.message}`);
        }
      }

      const city = await db.queryOne('SELECT id, name FROM cities WHERE name = ?', [targetName]);
      if (city) {
        if (actorIdx < rankSystem.manualIndex('governor')) {
          return bot.sendMessage(chatId, ' منح فلوس لمدينة يتطلب رتبة *والي* أو أعلى.', { parse_mode: 'Markdown' });
        }
        try {
          const actorLabel = await getActorLabel(tid);
          const result     = await economy.treasuryToCity(city.id, amount, actorLabel);

          const actorPlayer = await db.queryOne('SELECT id FROM players WHERE telegram_id = ?', [tid]);
          if (actorPlayer) await ledgerManager.updateLedger(actorPlayer.id, 'mg_given', amount);

          return bot.sendMessage(
            chatId,
            ` تم تحويل *${esc(fmt(amount))} MG* إلى مدينة *${esc(city.name)}*\\.\n *رصيد المدينة الجديد:* ${esc(fmt(result.newCityBalance))} MG\n *رصيد الخزينة المتبقي:* ${esc(fmt(result.newTreasuryBalance))} MG`,
            { parse_mode: 'MarkdownV2' }
          );
        } catch (err) {
          console.error('[giveMoney/city]', err.message);
          return bot.sendMessage(chatId, ` ${err.message}`);
        }
      }

      return bot.sendMessage(
        chatId,
        ` لم يُعثر على مملكة أو مدينة باسم: *${targetName}*\nاستعمل \`$kingdoms\` باش تشوف القائمة.`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  // ── $giveEmpir [amount] ───────────────────────────────────────────────────
  bot.onText(/^\$giveEmpir\s+(\d+)$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const tid    = msg.from.id;

    const actorRank = await rankSystem.getEffectiveRank(tid);
    if (rankSystem.manualIndex(actorRank) < rankSystem.manualIndex('emperor')) {
      return bot.sendMessage(chatId, ' هاد الأمر مخصص للإمبراطور والـ Overlord فقط.');
    }

    const amount = parseInt(match[1], 10);
    if (!amount || amount <= 0) return bot.sendMessage(chatId, ' المبلغ يجب أن يكون رقم موجب.');

    const player = await db.queryOne(
      'SELECT id, player_code, character_name FROM players WHERE telegram_id = ?',
      [tid]
    );
    if (!player) return bot.sendMessage(chatId, ' لم يُعثر على حسابك. استخدم $login أولاً.');

    try {
      const actorLabel = `${player.character_name} (${player.player_code})`;
      const result     = await economy.treasuryToPlayer(player.id, amount, actorLabel);

      await ledgerManager.updateLedger(player.id, 'mg_given', amount);

      return bot.sendMessage(
        chatId,
        ` تم تحويل *${esc(fmt(amount))} MG* إلى حسابك الشخصي\\.\n👤 *رصيدك الجديد:* ${esc(fmt(result.newPlayerBalance))} MG\n💰 *رصيد الخزينة المتبقي:* ${esc(fmt(result.newTreasuryBalance))} MG`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch (err) {
      console.error('[giveEmpir]', err.message);
      return bot.sendMessage(chatId, ` ${err.message}`);
    }
  });

  // ── $statusMG ─────────────────────────────────────────────────────────────
  bot.onText(/^\$statusMG$/i, async (msg) => {
    const chatId = msg.chat.id;
    const tid    = msg.from.id;

    const actorRank = await rankSystem.getEffectiveRank(tid);
    if (rankSystem.manualIndex(actorRank) < rankSystem.manualIndex('prince')) {
      return bot.sendMessage(chatId, ' هاد الأمر مخصص للأمير وما فوقه.');
    }

    try {
      const [treasuryBalance, totals, recentTxs] = await Promise.all([
        economy.getTreasuryBalance(),
        economy.getTotals(),
        economy.getRecentTransactions(8),
      ]);

      const lines = [
        '* نظام الاقتصاد — Master Card MG*',
        '',
        ` *الخزينة الإمبراطورية:* ${esc(fmt(treasuryBalance))} MG`,
        '',
        '* ملخص الحركات:*',
      ];

      const typeLabels = {
        mint:                ' صنع',
        treasury_to_kingdom: ' خزينة → مملكة',
        treasury_to_city:    ' خزينة → مدينة',
        treasury_to_player:  ' خزينة → لاعب',
        city_distribution:   ' توزيع مدينة',
        p2p_transfer:        ' تحويل بين لاعبين',
        official_payout:     ' راتب مسؤول',
      };

      if (totals.length === 0) {
        lines.push('_لا توجد معاملات بعد\\._');
      } else {
        for (const row of totals) {
          const label = typeLabels[row.type] || row.type;
          lines.push(`  ${esc(label)}: *${esc(fmt(row.total_amount))} MG* \\(${esc(String(row.tx_count))} عملية\\)`);
        }
      }

      lines.push('', '* آخر المعاملات:*');

      if (recentTxs.length === 0) {
        lines.push('_لا توجد معاملات\\._');
      } else {
        for (const tx of recentTxs) {
          const date = new Date(tx.created_at).toLocaleDateString('ar-MA', {
            day: '2-digit', month: '2-digit', year: 'numeric'
          });
          lines.push(`  \\• ${esc(tx.description || tx.type)} — *${esc(fmt(tx.amount))} MG* \\[${esc(date)}\\]`);
        }
      }

      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'MarkdownV2' });
    } catch (err) {
      console.error('[statusMG]', err.message);
      await bot.sendMessage(chatId, ' حدث خطأ أثناء تحميل البيانات الاقتصادية.');
    }
  });

  // ── $distribute [city_name] ───────────────────────────────────────────────
  bot.onText(/^\$distribute\s+(.+)$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const tid    = msg.from.id;

    const actorRank = await rankSystem.getEffectiveRank(tid);
    if (rankSystem.manualIndex(actorRank) < rankSystem.manualIndex('city_ruler')) {
      return bot.sendMessage(chatId, ' هاد الأمر مخصص لحاكم المدينة وما فوقه.');
    }

    const cityName = match[1].trim();

    try {
      const actorLabel = await getActorLabel(tid);
      const r          = await economy.distributeCityFunds(cityName, actorLabel);

      const rulerLine = r.rulers.length > 0
        ? r.rulers.map(p => `${esc(p.character_name)} \\+${esc(fmt(r.perRuler))} MG`).join(', ')
        : '_لا يوجد حاكم — بقيت في رصيد المدينة_';

      const deputyLine = r.deputies.length > 0
        ? r.deputies.map(p => `${esc(p.character_name)} \\+${esc(fmt(r.perDeputy))} MG`).join(', ')
        : '_لا يوجد نواب — بقيت في رصيد المدينة_';

      const advisorLine = r.advisors.length > 0
        ? r.advisors.map(p => `${esc(p.character_name)} \\+${esc(fmt(r.perAdvisor))} MG`).join(', ')
        : '_لا يوجد مستشارون — بقيت في رصيد المدينة_';

      const lines = [
        `* توزيع خزينة مدينة ${esc(r.cityName)}*`,
        '',
        ` *الصندوق الإجمالي:* ${esc(fmt(r.totalFund))} MG`,
        '',
        ` *الحاكم \\(35%\\):* ${rulerLine}`,
        ` *النواب \\(15%\\):* ${deputyLine}`,
        ` *المستشارون \\(10%\\):* ${advisorLine}`,
        '',
        ` *احتياطي المدينة \\(للأحداث\\):* ${esc(fmt(r.cityKeeps))} MG`,
        ` *إجمالي ما وُزِّع:* ${esc(fmt(r.totalDistributed))} MG`,
      ];

      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'MarkdownV2' });
    } catch (err) {
      console.error('[distribute]', err.message);
      await bot.sendMessage(chatId, ` ${err.message}`);
    }
  });

  // ── $sendMG [PlayerCode] [Amount] ─────────────────────────────────────────
  bot.onText(/^\$sendMG\s+(\S+)\s+(\d+)$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const tid    = msg.from.id;

    const sender = await db.queryOne(
      'SELECT id FROM players WHERE telegram_id = ?',
      [tid]
    );
    if (!sender) {
      return bot.sendMessage(chatId, ' غير مسجل. استخدم $login أولاً.');
    }

    const targetCode = match[1].trim().toUpperCase();
    const amount     = parseInt(match[2], 10);

    if (!amount || amount <= 0) {
      return bot.sendMessage(chatId, ' المبلغ يجب أن يكون رقم موجب.');
    }

    try {
      const result = await economy.playerToPlayerTransfer(tid, targetCode, amount);
      await bot.sendMessage(
        chatId,
        ` تم تحويل *${esc(fmt(result.amount))} MG* إلى *${esc(result.targetName)}* \\(${esc(result.targetCode)}\\) بنجاح\\.\n💰 *رصيدك المتبقي:* ${esc(fmt(result.senderNewBalance))} MG`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch (err) {
      console.error('[sendMG]', err.message);
      await bot.sendMessage(chatId, ` ${err.message}`);
    }
  });

  // ── NEW: $payOfficial [PlayerCode] [Amount] ───────────────────────────────
  // الرتب المسموح بها للمستهدف: governor, sage, prince فقط
  // الصلاحية: emperor أو overlord فقط
  const OFFICIAL_RANKS = new Set(['governor', 'sage', 'prince']);

  const OFFICIAL_RANK_LABELS = {
    governor: 'الوالي',
    sage:     'الحكيم',
    prince:   'الأمير',
  };

  bot.onText(/^\$payOfficial\s+(\S+)\s+(\d+)$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const tid    = msg.from.id;

    // ── 1. التحقق من صلاحية المُرسِل ─────────────────────────────────────
    const actorRank = await rankSystem.getEffectiveRank(tid);
    if (rankSystem.manualIndex(actorRank) < rankSystem.manualIndex('emperor')) {
      return bot.sendMessage(chatId, ' هاد الأمر مخصص للإمبراطور والـ Overlord فقط.');
    }

    const targetCode = match[1].trim().toUpperCase();
    const amount     = parseInt(match[2], 10);

    if (!amount || amount <= 0) {
      return bot.sendMessage(chatId, ' المبلغ يجب أن يكون رقم موجب.');
    }

    // ── 2. البحث عن اللاعب المستهدف بواسطة الكود ─────────────────────────
    const target = await db.queryOne(
      'SELECT id, player_code, character_name, system_rank FROM players WHERE player_code = ?',
      [targetCode]
    );
    if (!target) {
      return bot.sendMessage(chatId, ` لم يُعثر على لاعب بكود: *${esc(targetCode)}*`, { parse_mode: 'MarkdownV2' });
    }

    // ── 3. التحقق من أن رتبة المستهدف هي governor أو sage أو prince ────────
    const targetRank = target.system_rank || 'none';
    if (!OFFICIAL_RANKS.has(targetRank)) {
      return bot.sendMessage(
        chatId,
        ` *${esc(target.character_name)}* ليس مسؤولاً رفيعاً\\.\nهاد الأمر مخصص للوالي والحكيم والأمير فقط\\.`,
        { parse_mode: 'MarkdownV2' }
      );
    }

    // ── 4. تنفيذ الدفع من الخزينة ─────────────────────────────────────────
    try {
      const actorLabel = await getActorLabel(tid);
      const result     = await economy.treasuryToOfficial(target.id, amount, actorLabel);
      const rankLabel  = OFFICIAL_RANK_LABELS[targetRank];

      await bot.sendMessage(
        chatId,
        [
          ` تم صرف راتب المسؤول بنجاح\\.`,
          ``,
          ` *المسؤول:* ${esc(target.character_name)} \\(${esc(target.player_code)}\\)`,
          ` *الرتبة:* ${esc(rankLabel)}`,
          ` *المبلغ المدفوع:* ${esc(fmt(amount))} MG`,
          ` *رصيد المسؤول الجديد:* ${esc(fmt(result.newPlayerBalance))} MG`,
          ` *رصيد الخزينة المتبقي:* ${esc(fmt(result.newTreasuryBalance))} MG`,
        ].join('\n'),
        { parse_mode: 'MarkdownV2' }
      );
    } catch (err) {
      console.error('[payOfficial]', err.message);
      await bot.sendMessage(chatId, ` ${err.message}`);
    }
  });
}

module.exports = { register };