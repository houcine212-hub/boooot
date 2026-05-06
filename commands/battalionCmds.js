'use strict';

const db         = require('../db/connection');
const rankSystem = require('../utils/rankSystem');
const ledgerManager = require('../utils/ledgerManager');

// ── UI helpers ────────────────────────────────────────────────────────────────

function box(lines) {
  return '```text\n' + lines.join('\n') + '\n```';
}

const BORDER_TOP = '╔══════════════════════════════╗';
const BORDER_MID = '╠══════════════════════════════╣';
const BORDER_BOT = '╚══════════════════════════════╝';
const TITLE_LINE = '║   ［ ＳＹＳＴＥＭ ］             ║';

// ── Permission helpers ────────────────────────────────────────────────────────

/** Knight or higher: RP rank (7000+) OR manual rank >= city_ruler */
async function isKnightOrHigher(player) {
  if (player.rank_points >= 7000) return true;
  const idx = rankSystem.manualIndex(player.system_rank || 'none');
  return idx >= rankSystem.manualIndex('city_ruler');
}

/** Returns true if actor is city_ruler+ and (same city as battalion OR emperor/overlord) */
async function canSetDuty(actorTelegramId, battalionCityId) {
  const effectiveRank = await rankSystem.getEffectiveRank(actorTelegramId);
  if (rankSystem.manualIndex(effectiveRank) < rankSystem.manualIndex('city_ruler')) return false;

  // emperor / overlord can act on any city
  if (rankSystem.manualIndex(effectiveRank) >= rankSystem.manualIndex('emperor')) return true;

  const actor = await db.queryOne(
    'SELECT city_id FROM players WHERE telegram_id = ?',
    [actorTelegramId]
  );
  return actor && actor.city_id === battalionCityId;
}

// ── $registerCamp [Camp Name] ─────────────────────────────────────────────────

async function handleRegisterCamp(bot, msg, campName) {
  const chatId = msg.chat.id;
  const tid    = msg.from.id;

  if (msg.chat.type === 'private') {
    return bot.sendMessage(chatId, box([
      BORDER_TOP, TITLE_LINE, BORDER_BOT,
      '',
      '  يجب استخدام هذا الأمر داخل مجموعة.',
    ]));
  }

  // Check: not already a city
  const existingCity = await db.queryOne('SELECT id FROM cities WHERE chat_id = ?', [chatId]);
  if (existingCity) {
    return bot.sendMessage(chatId, box([
      BORDER_TOP, TITLE_LINE, BORDER_BOT,
      '',
      '  هذه المجموعة مسجلة بالفعل كمدينة.',
    ]));
  }

  // Check: not already a battalion
  const existingBat = await db.queryOne('SELECT id FROM battalions WHERE chat_id = ?', [chatId]);
  if (existingBat) {
    return bot.sendMessage(chatId, box([
      BORDER_TOP, TITLE_LINE, BORDER_BOT,
      '',
      '  هذه المجموعة مسجلة بالفعل كمعسكر.',
    ]));
  }

  const player = await db.queryOne(
    'SELECT id, character_name, city_id, rank_points, system_rank FROM players WHERE telegram_id = ?',
    [tid]
  );
  if (!player) {
    return bot.sendMessage(chatId, box([BORDER_TOP, TITLE_LINE, BORDER_BOT, '', '  أنت غير مسجل في اللعبة.']));
  }
  if (!player.city_id) {
    return bot.sendMessage(chatId, box([BORDER_TOP, TITLE_LINE, BORDER_BOT, '', '  يجب أن تنتمي إلى مدينة أولاً.']));
  }
  if (!(await isKnightOrHigher(player))) {
    return bot.sendMessage(chatId, box([
      BORDER_TOP, TITLE_LINE, BORDER_BOT,
      '',
      '  يجب أن تكون فارساً (7000 نقطة) أو أعلى لتأسيس معسكر.',
    ]));
  }

  const city = await db.queryOne('SELECT name FROM cities WHERE id = ?', [player.city_id]);

  await db.withTransaction(async (conn) => {
    const result = await conn.query(
      'INSERT INTO battalions (chat_id, city_id, name, leader_id) VALUES (?, ?, ?, ?)',
      [chatId, player.city_id, campName, player.id]
    );
    const battalionId = result.insertId;
    await conn.query(
      'INSERT INTO battalion_members (player_id, battalion_id) VALUES (?, ?)',
      [player.id, battalionId]
    );
  });

  await ledgerManager.updateLedger(player.id, 'camps_registered');

  return bot.sendMessage(chatId, box([
    BORDER_TOP,
    '║   ［ ＳＹＳＴＥＭ ］  تأسيس معسكر   ║',
    BORDER_BOT,
    '',
    '  تم تأسيس المعسكر بنجاح!',
    '',
    `  الاسم    : ${campName}`,
    `  المدينة  : ${city.name}`,
    `  القائد   : ${player.character_name}`,
    '',
    'ادعُ رفاقك بـ $joinCamp لبناء كتيبتك!',
  ]));
}

// ── $setDeputy [PlayerCode] ───────────────────────────────────────────────────

async function handleSetDeputy(bot, msg, targetCode) {
  const chatId = msg.chat.id;
  const tid    = msg.from.id;

  const battalion = await db.queryOne('SELECT id, leader_id, name FROM battalions WHERE chat_id = ?', [chatId]);
  if (!battalion) {
    return bot.sendMessage(chatId, box([BORDER_TOP, TITLE_LINE, BORDER_BOT, '', '  هذه المجموعة ليست معسكراً مسجلاً.']));
  }

  const actor = await db.queryOne('SELECT id FROM players WHERE telegram_id = ?', [tid]);
  if (!actor || actor.id !== battalion.leader_id) {
    return bot.sendMessage(chatId, box([BORDER_TOP, TITLE_LINE, BORDER_BOT, '', '  فقط قائد المعسكر يمكنه تعيين النائب.']));
  }

  const target = await db.queryOne(
    'SELECT p.id, p.character_name FROM players p WHERE p.player_code = ?',
    [targetCode.toUpperCase()]
  );
  if (!target) {
    return bot.sendMessage(chatId, box([BORDER_TOP, TITLE_LINE, BORDER_BOT, '', '  الرمز غير موجود.']));
  }

  const isMember = await db.queryOne(
    'SELECT 1 FROM battalion_members WHERE player_id = ? AND battalion_id = ?',
    [target.id, battalion.id]
  );
  if (!isMember) {
    return bot.sendMessage(chatId, box([
      BORDER_TOP, TITLE_LINE, BORDER_BOT,
      '',
      '  اللاعب ليس عضواً في هذا المعسكر.',
    ]));
  }

  await db.query('UPDATE battalions SET vice_id = ? WHERE id = ?', [target.id, battalion.id]);

  return bot.sendMessage(chatId, box([
    BORDER_TOP,
    '║   ［ ＳＹＳＴＥＭ ］  تعيين نائب    ║',
    BORDER_BOT,
    '',
    `  تم تعيين ${target.character_name} نائباً للقائد.`,
  ]));
}

// ── $joinCamp ─────────────────────────────────────────────────────────────────

async function handleJoinCamp(bot, msg) {
  const chatId = msg.chat.id;
  const tid    = msg.from.id;

  const battalion = await db.queryOne(
    'SELECT id, city_id, name FROM battalions WHERE chat_id = ?',
    [chatId]
  );
  if (!battalion) {
    return bot.sendMessage(chatId, box([BORDER_TOP, TITLE_LINE, BORDER_BOT, '', '  هذه المجموعة ليست معسكراً مسجلاً.']));
  }

  const player = await db.queryOne(
    'SELECT id, character_name, city_id FROM players WHERE telegram_id = ?',
    [tid]
  );
  if (!player) {
    return bot.sendMessage(chatId, box([BORDER_TOP, TITLE_LINE, BORDER_BOT, '', '  أنت غير مسجل في اللعبة.']));
  }
  if (player.city_id !== battalion.city_id) {
    return bot.sendMessage(chatId, box([
      BORDER_TOP, TITLE_LINE, BORDER_BOT,
      '',
      '  يجب أن تنتمي إلى نفس المدينة لتنضم لهذا المعسكر.',
    ]));
  }

  await db.withTransaction(async (conn) => {
    // Remove from any existing battalion
    await conn.query('DELETE FROM battalion_members WHERE player_id = ?', [player.id]);
    // Join new battalion
    await conn.query(
      'INSERT INTO battalion_members (player_id, battalion_id) VALUES (?, ?)',
      [player.id, battalion.id]
    );
  });

  return bot.sendMessage(chatId, box([
    BORDER_TOP,
    '║   ［ ＳＹＳＴＥＭ ］  انضمام         ║',
    BORDER_BOT,
    '',
    `  ${player.character_name} انضم إلى معسكر "${battalion.name}" كجندي.`,
  ]));
}

// ── $setDuty [Camp Name] ──────────────────────────────────────────────────────

async function handleSetDuty(bot, msg, campName) {
  const chatId = msg.chat.id;
  const tid    = msg.from.id;

  const battalion = await db.queryOne(
    'SELECT id, city_id, chat_id, name FROM battalions WHERE name = ?',
    [campName]
  );
  if (!battalion) {
    return bot.sendMessage(chatId, box([BORDER_TOP, TITLE_LINE, BORDER_BOT, '', `  لم يُعثر على معسكر بالاسم: ${campName}`]));
  }

  if (!(await canSetDuty(tid, battalion.city_id))) {
    return bot.sendMessage(chatId, box([
      BORDER_TOP, TITLE_LINE, BORDER_BOT,
      '',
      '  فقط حاكم المدينة (أو أعلى) يمكنه تفعيل حالة الاستنفار.',
    ]));
  }

  await db.withTransaction(async (conn) => {
    await conn.query('UPDATE battalions SET is_on_duty = 0 WHERE city_id = ?', [battalion.city_id]);
    await conn.query('UPDATE battalions SET is_on_duty = 1 WHERE id = ?', [battalion.id]);
  });

  const actor = await db.queryOne('SELECT id FROM players WHERE telegram_id = ?', [tid]);
  if (actor) await ledgerManager.updateLedger(actor.id, 'duty_activations');

  // Notify the battalion group
  try {
    await bot.sendMessage(battalion.chat_id, box([
      BORDER_TOP,
      '║   ［ ＳＹＳＴＥＭ ＡＬＥＲＴ ］     ║',
      BORDER_BOT,
      '',
      `كتيبتكم "${battalion.name}" الآن في حالة استنفار!`,
      '',
      '  أنتم خط الدفاع الأول عن المدينة.',
      '     كونوا مستعدين!',
    ]));
  } catch (_) {
    // Bot might not be in that group — ignore silently
  }

  return bot.sendMessage(chatId, box([
    BORDER_TOP,
    '║   ［ ＳＹＳＴＥＭ ］  استنفار        ║',
    BORDER_BOT,
    '',
    `  معسكر "${battalion.name}" الآن على رأس الواجب.`,
    '    تم إرسال إنذار للكتيبة.',
  ]));
}

// ── $campInfo ─────────────────────────────────────────────────────────────────

async function handleCampInfo(bot, msg) {
  const chatId = msg.chat.id;

  const bat = await db.queryOne(
    `SELECT b.id, b.name, b.is_on_duty,
            c.name  AS city_name,
            l.character_name AS leader_name,
            v.character_name AS vice_name
     FROM battalions b
     JOIN cities  c ON c.id = b.city_id
     JOIN players l ON l.id = b.leader_id
     LEFT JOIN players v ON v.id = b.vice_id
     WHERE b.chat_id = ?`,
    [chatId]
  );
  if (!bat) {
    return bot.sendMessage(chatId, box([BORDER_TOP, TITLE_LINE, BORDER_BOT, '', '  هذه المجموعة ليست معسكراً مسجلاً.']));
  }

  const countRow = await db.queryOne(
    'SELECT COUNT(*) AS cnt FROM battalion_members WHERE battalion_id = ?',
    [bat.id]
  );
  const memberCount = countRow ? countRow.cnt : 0;
  const dutyLabel   = bat.is_on_duty ? ' في الخدمة' : '🟢 في الراحة';

  return bot.sendMessage(chatId, box([
    BORDER_TOP,
    '║   ［ ＳＹＳＴＥＭ ］  معلومات المعسكر ║',
    BORDER_BOT,
    '',
    `  الاسم      : ${bat.name}`,
    `  المدينة    : ${bat.city_name}`,
    `  القائد     : ${bat.leader_name}`,
    `  النائب     : ${bat.vice_name || 'غير معيّن'}`,
    `  الأعضاء    : ${memberCount}`,
    `  الحالة     : ${dutyLabel}`,
  ]));
}

// ── Register ──────────────────────────────────────────────────────────────────

function register(bot) {
  bot.onText(/^\$registerCamp\s+(.+)/i, (msg, match) =>
    handleRegisterCamp(bot, msg, match[1].trim()).catch(console.error)
  );

  bot.onText(/^\$setDeputy\s+(\S+)/i, (msg, match) =>
    handleSetDeputy(bot, msg, match[1].trim()).catch(console.error)
  );

  bot.onText(/^\$joinCamp$/i, (msg) =>
    handleJoinCamp(bot, msg).catch(console.error)
  );

  bot.onText(/^\$setDuty\s+(.+)/i, (msg, match) =>
    handleSetDuty(bot, msg, match[1].trim()).catch(console.error)
  );

  bot.onText(/^\$campInfo$/i, (msg) =>
    handleCampInfo(bot, msg).catch(console.error)
  );
}

module.exports = { register };