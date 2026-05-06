'use strict';

const db                              = require('../db/connection');
const session                         = require('../middleware/sessionManager');
const { sendCardVisual, escapeMarkdown } = require('../utils/cardVisuals');

// ─── Constants ────────────────────────────────────────────────────────────────

const OFFICIAL_GROUP_ID    = -1003976992809;
const BOT_SYSTEM_PLAYER_ID = 9;

const BOSS_NITRON    = 'nitron';
const BOSS_MONSTER_X = 'monster_x';

const STAGE = {
  CHAR_SELECTED  : 'character_selected',
  FAILED_NITRON  : 'failed_nitron',
  NITRON_CLEARED : 'nitron_cleared',
  FAILED_MONSTER : 'failed_monster_x',
  COMPLETE       : 'tutorial_complete',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── System message formatter ─────────────────────────────────────────────────
function sys(body) {
  return `\`\`\`\n[ SYSTEM ]\n\n${body}\n\`\`\``;
}

// ─── Combat Engine ─────────────────────────────────────────────────────────────

function resolveAttack(plc, targetIDC, currentShield = 0) {
  if (plc.type === 'defense') {
    return { isDefense: true, newShield: plc.def, damage: 0, missed: false, absorbed: 0 };
  }

  const evasionPenalty = Math.floor(targetIDC.spd * 0.05);
  const hitChance      = Math.min(95, Math.max(25, Math.floor(plc.accuracy / 10) - evasionPenalty));
  if (Math.floor(Math.random() * 100) >= hitChance) {
    return { isDefense: false, newShield: 0, damage: 0, missed: true, absorbed: 0 };
  }

  let raw = 0;
  if (plc.type === 'attack') {
    raw = Math.max(100, plc.atk   - Math.floor(targetIDC.def * 0.25));
  } else if (plc.type === 'magic') {
    raw = Math.max(100, plc.magic - Math.floor(targetIDC.def * 0.10));
  }

  const absorbed = Math.min(currentShield, raw);
  const damage   = raw - absorbed;

  return { isDefense: false, newShield: 0, damage, missed: false, absorbed };
}

// ─── DB Helpers ───────────────────────────────────────────────────────────────

async function loadBoss(bossType) {
  const rows = await db.query(
    'SELECT * FROM tutorial_boss_cards WHERE boss_type = ? LIMIT 1',
    [bossType]
  );
  if (!rows.length) throw Object.assign(new Error('BOSS_NOT_SET'), { bossType });

  const boss = rows[0];

  if (boss.idc_card_id == null) throw new Error('BOSS_IDC_MISSING');

  // plc_ids is a JSON array: ["PLC-XXXXX", ...]
  let plcIds;
  try { plcIds = JSON.parse(boss.plc_ids || '[]'); } catch { plcIds = []; }
  if (!plcIds.length) throw new Error('BOSS_CARDS_MISSING');

  // Identity Card
  const idcRows = await db.query(
    'SELECT * FROM identity_cards WHERE card_id = ? LIMIT 1',
    [boss.idc_card_id]
  );
  if (!idcRows.length) throw new Error('BOSS_IDC_MISSING');
  const idc = idcRows[0];

  // Play Cards (multiple — fetched by IN clause)
  const placeholders = plcIds.map(() => '?').join(',');
  const plcRows = await db.query(
    `SELECT * FROM play_cards WHERE card_id IN (${placeholders})`,
    plcIds
  );
  if (!plcRows.length) throw new Error('BOSS_CARDS_MISSING');

  return { idc, plcs: plcRows };
}

async function loadPlayerCards(playerId) {
  const idcRows = await db.query(
    'SELECT * FROM identity_cards WHERE player_id = ? LIMIT 1',
    [playerId]
  );
  const plcRows = await db.query(
    'SELECT * FROM play_cards WHERE player_id = ?',
    [playerId]
  );
  return { idc: idcRows[0] ?? null, plcs: plcRows };
}

async function getTutorialStage(playerId) {
  const rows = await db.query(
    'SELECT stage FROM player_tutorial_state WHERE player_id = ? LIMIT 1',
    [playerId]
  );
  return rows[0]?.stage ?? null;
}

async function setTutorialStage(playerId, stage) {
  await db.query(
    `INSERT INTO player_tutorial_state (player_id, stage)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE stage = VALUES(stage)`,
    [playerId, stage]
  );
}

// ─── Boss Card Visual ─────────────────────────────────────────────────────────

async function sendBossCard(bot, chatId, bossIdc, bossName) {
  const statsCaption =
    `[ ${bossName} — Identity Card ]\n\n` +
    `Name    : ${bossIdc.name}\n` +
    `Card ID : ${bossIdc.card_id}\n\n` +
    `HP      : ${bossIdc.hp}\n` +
    `ATK     : ${bossIdc.atk}\n` +
    `DEF     : ${bossIdc.def}\n` +
    `SPD     : ${bossIdc.spd}\n` +
    (bossIdc.magic !== undefined ? `MAGIC   : ${bossIdc.magic}\n` : '');

  await sendCardVisual(bot, chatId, bossIdc, statsCaption);
}

// ─── Fight Bootstrapper ───────────────────────────────────────────────────────

async function startFight(bot, chatId, tid, playerId, bossType) {
  let boss;
  try {
    boss = await loadBoss(bossType);
  } catch (err) {
    if (err.message === 'BOSS_NOT_SET') {
      return bot.sendMessage(
        chatId,
        sys(`إعدادات الخصم (${bossType}) لم يتم تعيينها.\nتواصل مع الادارة.`),
        { parse_mode: 'Markdown' }
      );
    }
    if (err.message === 'BOSS_IDC_MISSING') {
      return bot.sendMessage(
        chatId,
        sys(`بطاقة الهوية للخصم (${bossType}) غير موجودة او محذوفة.\nتواصل مع الادارة.`),
        { parse_mode: 'Markdown' }
      );
    }
    if (err.message === 'BOSS_CARDS_MISSING') {
      return bot.sendMessage(
        chatId,
        sys(`بطاقات الهجوم للخصم (${bossType}) لم يتم تهيئتها.\nتواصل مع الادارة.`),
        { parse_mode: 'Markdown' }
      );
    }
    throw err;
  }

  const { idc: playerIDC, plcs: playerPLCs } = await loadPlayerCards(playerId);
  if (!playerIDC) {
    return bot.sendMessage(
      chatId,
      sys('لا توجد بطاقة هوية مرتبطة بحسابك.\nتواصل مع الادارة.'),
      { parse_mode: 'Markdown' }
    );
  }

  const bossName = bossType === BOSS_NITRON ? 'Nitron' : 'Monster X';
  const phase    = bossType === BOSS_NITRON ? '1' : '2';

  await sendBossCard(bot, chatId, boss.idc, bossName);
  await sleep(800);

  await bot.sendMessage(
    chatId,
    sys(
      `المرحلة ${phase}: ${bossName}. أرسل بطاقة هويتك للبدء.\n\n` +
      `بطاقتك   : ${playerIDC.card_id}\n` +
      `نقاط حياتك : ${playerIDC.hp}\n\n` +
      `الخصم لن يرد إلا بعد أن تلعب.\n` +
      `لك حق البدء.`
    ),
    { parse_mode: 'Markdown' }
  );

  session.setSession(tid, 'start_exam', 'awaiting_idc', {
    bossType,
    bossName,
    playerId,
    playerIDC,
    playerHP     : playerIDC.hp,
    playerShield : 0,
    playerPLCs,
    bossIDC      : boss.idc,
    bossHP       : boss.idc.hp,
    bossShield   : 0,
    bossPLCs     : boss.plcs,
    bossPLCIndex : 0,
    round        : 1,
  });
}

// ─── Step Handler ─────────────────────────────────────────────────────────────

async function handleStep(bot, msg, cardId) {
  const chatId = msg.chat.id;
  const tid    = msg.from.id;
  const sess   = session.getSession(tid);

  if (!sess || sess.action !== 'start_exam') return;

  // ── STEP: awaiting IDC ─────────────────────────────────────────────────────
  if (sess.step === 'awaiting_idc') {
    if (!cardId || !cardId.toUpperCase().startsWith('IDC-')) {
      return bot.sendMessage(
        chatId,
        sys(`أرسل بطاقة هويتك (IDC) لبدء المعركة.\nبطاقتك: \`${sess.data.playerIDC.card_id}\``),
        { parse_mode: 'Markdown' }
      );
    }

    if (cardId.toUpperCase() !== sess.data.playerIDC.card_id.toUpperCase()) {
      return bot.sendMessage(
        chatId,
        sys(`هذه ليست بطاقتك.\nبطاقتك هي: \`${sess.data.playerIDC.card_id}\``),
        { parse_mode: 'Markdown' }
      );
    }

    const d = sess.data;
    session.setSession(tid, 'start_exam', 'in_combat', d);

    return bot.sendMessage(
      chatId,
      sys(
        `تم قبول بطاقة الهوية. بدأت المعركة.\n\n` +
        `[ ${d.playerIDC.name} ]   ح: ${d.playerHP}\n` +
        `       ضد\n` +
        `[ ${d.bossIDC.name} ]   ح: ${d.bossHP}\n\n` +
        `─────────────────────────\n\n` +
        `الجولة 1 — دورك.\n\n` +
        `أرسل بطاقة لعب (PLC) للهجوم.`
      ),
      { parse_mode: 'Markdown' }
    );
  }

  // ── STEP: in combat ────────────────────────────────────────────────────────
  if (sess.step === 'in_combat') {
    if (!cardId || !cardId.toUpperCase().startsWith('PLC-')) {
      return bot.sendMessage(
        chatId,
        sys('أرسل بطاقة لعب (PLC) للهجوم.'),
        { parse_mode: 'Markdown' }
      );
    }

    const d = { ...sess.data };

    const plc = d.playerPLCs.find(
      (p) => p.card_id.toUpperCase() === cardId.toUpperCase()
    );
    if (!plc) {
      return bot.sendMessage(
        chatId,
        sys('هذه البطاقة لا تخصك او ليست في يدك.'),
        { parse_mode: 'Markdown' }
      );
    }

    // ── Player attacks boss ────────────────────────────────────────────────
    const pRes  = resolveAttack(plc, d.bossIDC, d.bossShield);
    let   pLine = '';

    if (pRes.isDefense) {
      d.playerShield += pRes.newShield;
      pLine = `تم لعب بطاقة دفاع (${plc.name}) — درع +${pRes.newShield} نقطة.`;
    } else if (pRes.missed) {
      pLine = `هجومك (${plc.name}) فاته الهدف.`;
    } else {
      d.bossShield = Math.max(0, d.bossShield - pRes.absorbed);
      d.bossHP    -= pRes.damage;
      pLine        = `ضربت ${d.bossName} بـ ${pRes.damage} ضرر (${plc.name})`;
      if (pRes.absorbed) pLine += ` — ${pRes.absorbed} امتصه الدرع`;
      pLine += '.';
    }

    // ── Check boss defeated ────────────────────────────────────────────────
    if (d.bossHP <= 0) {
      d.bossHP = 0;
      session.clearSession(tid);
      await bot.sendMessage(
        chatId,
        sys(`${pLine}\n\n${d.bossName} نقاط الحياة: 0\n\n...`),
        { parse_mode: 'Markdown' }
      );
      await sleep(1200);
      return handleWin(bot, chatId, tid, d);
    }

    // ── Boss counter-attack ────────────────────────────────────────────────
    const bossCard     = d.bossPLCs[d.bossPLCIndex % d.bossPLCs.length];
    d.bossPLCIndex    += 1;
    const bRes         = resolveAttack(bossCard, d.playerIDC, d.playerShield);
    let   bLine        = '';

    if (bRes.isDefense) {
      d.bossShield += bRes.newShield;
      bLine         = `${d.bossName} لعب بطاقة دفاع (${bossCard.name}) — درع +${bRes.newShield}.`;
    } else if (bRes.missed) {
      bLine = `هجوم ${d.bossName} (${bossCard.name}) فاته الهدف.`;
    } else {
      d.playerShield = Math.max(0, d.playerShield - bRes.absorbed);
      d.playerHP    -= bRes.damage;
      bLine          = `${d.bossName} ضربك بـ ${bRes.damage} ضرر (${bossCard.name})`;
      if (bRes.absorbed) bLine += ` — ${bRes.absorbed} امتصه درعك`;
      bLine += '.';
    }

    // ── Check player defeated ──────────────────────────────────────────────
    if (d.playerHP <= 0) {
      d.playerHP = 0;
      session.clearSession(tid);
      await bot.sendMessage(
        chatId,
        sys(
          `${pLine}\n${bLine}\n\n` +
          `انت        :  0 نقطة حياة\n` +
          `${d.bossName}  :  ${d.bossHP} ح`
        ),
        { parse_mode: 'Markdown' }
      );
      await sleep(1000);
      return handleLoss(bot, chatId, tid, d);
    }

    // ── Advance round ──────────────────────────────────────────────────────
    d.round += 1;
    session.setSession(tid, 'start_exam', 'in_combat', d);

    return bot.sendMessage(
      chatId,
      sys(
        `الجولة ${d.round - 1}\n\n` +
        `${pLine}\n` +
        `${bLine}\n\n` +
        `─────────────────────────\n` +
        `انت        :  ${d.playerHP} ح${d.playerShield ? `   درع: ${d.playerShield}` : ''}\n` +
        `${d.bossName}  :  ${d.bossHP} ح${d.bossShield ? `   درع: ${d.bossShield}` : ''}\n\n` +
        `الجولة ${d.round} — أرسل بطاقتك التالية.`
      ),
      { parse_mode: 'Markdown' }
    );
  }
}

// ─── Win Handler ──────────────────────────────────────────────────────────────

async function handleWin(bot, chatId, tid, d) {

  // ── Nitron cleared → transfer SKL + WPN → start Monster X ─────────────────
  if (d.bossType === BOSS_NITRON) {
    await bot.sendMessage(
      chatId,
      sys('تم هزيمة نيترون. جاري تحضير الاختبار الثاني...'),
      { parse_mode: 'Markdown' }
    );

    await db.query(
      `UPDATE skill_cards sc
       INNER JOIN character_starter_templates cst
         ON cst.card_id = sc.card_id AND cst.card_type = 'SKL'
       INNER JOIN players p
         ON p.character_name = cst.char_name AND p.id = ?
       SET sc.player_id = p.id
       WHERE sc.player_id = ?`,
      [d.playerId, BOT_SYSTEM_PLAYER_ID]
    );

    await db.query(
      `UPDATE weapon_cards wc
       INNER JOIN character_starter_templates cst
         ON cst.card_id = wc.card_id AND cst.card_type = 'WPN'
       INNER JOIN players p
         ON p.character_name = cst.char_name AND p.id = ?
       SET wc.player_id = p.id
       WHERE wc.player_id = ?`,
      [d.playerId, BOT_SYSTEM_PLAYER_ID]
    );

    await setTutorialStage(d.playerId, STAGE.NITRON_CLEARED);

    await sleep(1200);
    await bot.sendMessage(
      chatId,
      sys(
        'تم نقل بطاقاتك المتبقية.\n\n' +
        'الاختبار لم ينته بعد.\n\n' +
        'خصم ثانٍ يظهر من الظلام.'
      ),
      { parse_mode: 'Markdown' }
    );
    await sleep(1500);

    try {
      return await startFight(bot, chatId, tid, d.playerId, BOSS_MONSTER_X);
    } catch (err) {
      console.error('[handleWin] Monster X startFight error:', err);
      return bot.sendMessage(
        chatId,
        sys('حدث خطأ اثناء تحضير المعركة الثانية.\nتواصل مع الادارة.'),
        { parse_mode: 'Markdown' }
      );
    }
  }

  // ── Monster X cleared → keep system_rank = 'none' so rankSystem.js calculates dynamically ──
  await db.query(
    `UPDATE players
     SET system_rank = 'none', is_tutorial_complete = 1
     WHERE id = ?`,
    [d.playerId]
  );
  await setTutorialStage(d.playerId, STAGE.COMPLETE);

  const pRows    = await db.query(
    'SELECT character_name, real_name FROM players WHERE id = ? LIMIT 1',
    [d.playerId]
  );
  const charName = pRows[0]?.character_name ?? '';
  const realName = pRows[0]?.real_name      ?? '';

  await sleep(600);
  return bot.sendMessage(
    chatId,
    sys(
      'مبروك لقد اجتزت الاختبار\n' +
      'لقد تبيّن أن المؤسس لديه نظرة صعبة ... "YAMP"\n\n' +
      `─────────────────────────\n\n` +
      `الاسم       :  ${realName}\n` +
      `الشخصية    :  ${charName}\n` +
      `الرتبة الجديدة :  لاجئ\n\n` +
      'انت حر الآن.\n' +
      'العالم مفتوح امامك.'
    ),
    { parse_mode: 'Markdown' }
  );
}

// ─── Loss Handler ─────────────────────────────────────────────────────────────

const TAUNTS_HEAVY = [
  'الخصم لم يتعرق.',
  'هذا ما كنا نخشى تأكيده.',
  'النظام يسجل هذه المعركة تحت خانة: لم تحدث.',
  'حتى نيترون بدا مُحرَجًا.',
  'لو كان هذا امتحانًا مدرسيًا، لما وُجدت درجة تُكتب لك.',
  'الساحة لم تُصمَّم لهذا المستوى.',
  'كنا نتوقع ضعفًا، لكن ليس بهذا الشكل.',
];

const TAUNTS_MID = [
  'كنا نتوقع أكثر. كثيرًا أكثر.',
  'المعركة لم تكن متكافئة — وليس لصالحك.',
  'هناك فجوة بين ما تظنه عن نفسك وما أثبتته الساحة.',
  'بذلت جهدًا. لكنه لم يكن كافيًا.',
  'الخصم أكمل يومه بلا إجهاد يُذكر.',
];

const TAUNTS_CLOSE = [
  'كدت تنجح. لكن "كاد" لا تُسجَّل في نظام RAAZN.',
  'كان الفارق صغيرًا. لكنه كان كافيًا.',
  'لحظة أخرى ربما. لكن تلك اللحظة لم تأتِ.',
];

function pickTaunt(d) {
  const maxHP  = d.bossIDC.hp;
  const leftHP = Math.max(0, d.bossHP);
  const ratio  = maxHP > 0 ? leftHP / maxHP : 0;

  let pool;
  if (ratio >= 0.55)      pool = TAUNTS_HEAVY;
  else if (ratio >= 0.25) pool = TAUNTS_MID;
  else                    pool = TAUNTS_CLOSE;

  return pool[Math.floor(Math.random() * pool.length)];
}

async function handleLoss(bot, chatId, tid, d) {
  const failStage = d.bossType === BOSS_NITRON
    ? STAGE.FAILED_NITRON
    : STAGE.FAILED_MONSTER;

  await setTutorialStage(d.playerId, failStage);

  const taunt = pickTaunt(d);

  return bot.sendMessage(
    chatId,
    sys(
      'لقد سقطت في المعركة.\n\n' +
      `${taunt}\n\n` +
      'النظام يمنحك فرصة اخيرة.\n\n' +
      'اكتب $continue لإعادة الاختبار،\n' +
      'إن كانت لديك الإرادة.'
    ),
    { parse_mode: 'Markdown' }
  );
}

// ─── Join Handler ─────────────────────────────────────────────────────────────

async function handleJoin(bot, msg) {
  const chatId = msg.chat.id;
  if (chatId !== OFFICIAL_GROUP_ID) return;
  if (!msg.new_chat_members || !msg.new_chat_members.length) return;

  for (const newMember of msg.new_chat_members) {
    if (newMember.is_bot) continue;

    const tid = newMember.id;

    const players = await db.query(
      'SELECT * FROM players WHERE telegram_id = ? LIMIT 1',
      [tid]
    );
    if (!players.length) continue;
    const player = players[0];

    if (player.is_tutorial_complete == 1) {
      await bot.sendMessage(
        chatId,
        sys(
          `البوابات تعرفك، ${player.character_name}.\n` +
          `لقد نلت مكانك هنا بجدارة. أهلا بعودتك.`
        ),
        { parse_mode: 'Markdown' }
      );
      continue;
    }

    if (session.hasActiveSession(tid)) continue;

    const stage = await getTutorialStage(player.id);

    if (stage === STAGE.NITRON_CLEARED || stage === STAGE.FAILED_MONSTER) {
      await bot.sendMessage(
        chatId,
        sys(
          `لقد عدت، ${player.character_name}.\n\n` +
          `محاولتك لم تنته بعد.\n` +
          `اكتب $continue للمتابعة من حيث توقفت.`
        ),
        { parse_mode: 'Markdown' }
      );
      continue;
    }

    if (stage === STAGE.FAILED_NITRON) {
      await bot.sendMessage(
        chatId,
        sys(
          `لقد عدت، ${player.character_name}.\n\n` +
          `لقد سقطت من قبل. الساحة لا تنسى.\n` +
          `اكتب $continue لمواجهة نيترون مرة اخرى.`
        ),
        { parse_mode: 'Markdown' }
      );
      continue;
    }

    await bot.sendMessage(
      chatId,
      sys(
        `مرحبا بك في ساحة الاختبار، ${player.character_name}.\n` +
        `ستُقاس جدارتك هنا.`
      ),
      { parse_mode: 'Markdown' }
    );
    await sleep(1500);

    try {
      await startFight(bot, chatId, tid, player.id, BOSS_NITRON);
    } catch (err) {
      console.error('[handleJoin] startFight error:', err);
      await bot.sendMessage(
        chatId,
        sys('حدث خطأ اثناء تحضير الاختبار.\nتواصل مع الادارة.'),
        { parse_mode: 'Markdown' }
      );
    }
  }
}

// ─── Register Commands ─────────────────────────────────────────────────────────

function register(bot) {

  // ── $start_exam ─────────────────────────────────────────────────────────────
  bot.onText(/^\$start_exam$/i, async (msg) => {
    const chatId = msg.chat.id;
    const tid    = msg.from.id;

    if (chatId !== OFFICIAL_GROUP_ID) {
      try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
      if (msg.chat.type === 'private') {
        return bot.sendMessage(
          chatId,
          sys('ساحة الاختبار موجودة في المجموعة الرسمية فقط.\nاذهب إليها للبدء.'),
          { parse_mode: 'Markdown' }
        );
      }
      return;
    }

    if (session.hasActiveSession(tid)) {
      const activeSess = session.getSession(tid);
      if (activeSess?.action === 'start_exam') {
        return bot.sendMessage(
          chatId,
          sys('انت بالفعل في منتصف اختبار.\nاكمل معركتك الحالية اولاً.'),
          { parse_mode: 'Markdown' }
        );
      }
    }

    const players = await db.query(
      'SELECT * FROM players WHERE telegram_id = ? LIMIT 1',
      [tid]
    );
    if (!players.length) {
      return bot.sendMessage(
        chatId,
        sys('انت غير مسجل.\nاستخدم $login في الرسائل الخاصة اولاً.'),
        { parse_mode: 'Markdown' }
      );
    }
    const player = players[0];

    if (player.is_tutorial_complete == 1) {
      return bot.sendMessage(
        chatId,
        sys(`لقد اجتزت الاختبار بالفعل، ${player.character_name}.\nرتبتك لاجئ.`),
        { parse_mode: 'Markdown' }
      );
    }

    const stage = await getTutorialStage(player.id);

    // ✅ FIX #2: Corrected stage guard logic.
    //
    // OLD (broken): outer if swallowed null/CHAR_SELECTED/FAILED_NITRON together,
    // then inner if could NEVER be true → dead code, null stage wrongly allowed through.
    //
    // NEW: explicit checks — null stage is blocked, valid stages proceed cleanly.

    // No tutorial state yet — player hasn't finished character selection
    if (!stage) {
      return bot.sendMessage(
        chatId,
        sys('اكمل اختيار شخصيتك قبل بدء الاختبار.'),
        { parse_mode: 'Markdown' }
      );
    }

    if (stage === STAGE.CHAR_SELECTED || stage === STAGE.FAILED_NITRON) {
      await bot.sendMessage(
        chatId,
        sys(
          'مرحبا بك في ساحة الاختبار.\n' +
          'ستُقاس جدارتك هنا.'
        ),
        { parse_mode: 'Markdown' }
      );
      await sleep(1200);

      try {
        return await startFight(bot, chatId, tid, player.id, BOSS_NITRON);
      } catch (err) {
        console.error('[start_exam] startFight error:', err);
        return bot.sendMessage(
          chatId,
          sys('حدث خطأ اثناء تحضير المعركة.\nتواصل مع الادارة.'),
          { parse_mode: 'Markdown' }
        );
      }
    }

    if (stage === STAGE.NITRON_CLEARED) {
      await bot.sendMessage(
        chatId,
        sys('نيترون تم هزيمته بالفعل.\nالاختبار الثاني لم يكتمل بعد.'),
        { parse_mode: 'Markdown' }
      );
      await sleep(1000);
      try {
        return await startFight(bot, chatId, tid, player.id, BOSS_MONSTER_X);
      } catch (err) {
        console.error('[start_exam] startFight error:', err);
        return bot.sendMessage(
          chatId,
          sys('حدث خطأ اثناء تحضير المعركة.\nتواصل مع الادارة.'),
          { parse_mode: 'Markdown' }
        );
      }
    }

    if (stage === STAGE.FAILED_MONSTER) {
      return bot.sendMessage(
        chatId,
        sys(
          'لقد فشلت سابقاً امام Monster X.\n\n' +
          'اكتب $continue لإعادة المحاولة.'
        ),
        { parse_mode: 'Markdown' }
      );
    }

    // Fallback — unexpected state
    return bot.sendMessage(
      chatId,
      sys('حالة غير متوقعة.\nتواصل مع الادارة.'),
      { parse_mode: 'Markdown' }
    );
  });

  // ── $continue ───────────────────────────────────────────────────────────────
  bot.onText(/^\$continue$/i, async (msg) => {
    const chatId = msg.chat.id;
    const tid    = msg.from.id;

    if (chatId !== OFFICIAL_GROUP_ID) {
      try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
      return;
    }

    const players = await db.query(
      'SELECT * FROM players WHERE telegram_id = ? LIMIT 1',
      [tid]
    );
    if (!players.length) return;
    const player = players[0];

    if (player.is_tutorial_complete == 1) {
      return bot.sendMessage(
        chatId,
        sys(`لقد اجتزت الاختبار بالفعل، ${player.character_name}.`),
        { parse_mode: 'Markdown' }
      );
    }

    const stage = await getTutorialStage(player.id);
    let bossType = null;

    if (stage === STAGE.FAILED_NITRON)  bossType = BOSS_NITRON;
    if (stage === STAGE.NITRON_CLEARED) bossType = BOSS_MONSTER_X;
    if (stage === STAGE.FAILED_MONSTER) bossType = BOSS_MONSTER_X;

    if (!bossType) {
      return bot.sendMessage(
        chatId,
        sys('لا توجد معركة لإعادتها.\nاستخدم $start_exam.'),
        { parse_mode: 'Markdown' }
      );
    }

    const bossName = bossType === BOSS_NITRON ? 'Nitron' : 'Monster X';
    await bot.sendMessage(
      chatId,
      sys(
        `إعادة المعركة ضد ${bossName}.\n\n` +
        'لن تفشل هذه المرة.'
      ),
      { parse_mode: 'Markdown' }
    );
    await sleep(1200);

    try {
      return await startFight(bot, chatId, tid, player.id, bossType);
    } catch (err) {
      console.error('[continue] startFight error:', err);
      return bot.sendMessage(
        chatId,
        sys('حدث خطأ اثناء تحضير المعركة.\nتواصل مع الادارة.'),
        { parse_mode: 'Markdown' }
      );
    }
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = { register, handleStep, handleJoin };