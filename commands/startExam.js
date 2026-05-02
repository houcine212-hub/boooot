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
// Wraps text in a Solo Leveling dark-style code block. No icons or emojis.
function sys(body) {
  return `\`\`\`\n[ SYSTEM ]\n\n${body}\n\`\`\``;
}

// ─── Combat Engine ─────────────────────────────────────────────────────────────

/**
 * Resolves a single card played against a target IDC.
 *
 * Returns:
 *   { isDefense, newShield }   — DEF card: builds a shield, deals no damage
 *   { missed }                 — accuracy roll failed
 *   { damage, absorbed }       — hit landed; absorbed = shield that was consumed
 */
function resolveAttack(plc, targetIDC, currentShield = 0) {
  if (plc.type === 'defense') {
    return { isDefense: true, newShield: plc.def, damage: 0, missed: false, absorbed: 0 };
  }

  // Accuracy check — speed stat of the target reduces hit probability slightly
  const evasionPenalty = Math.floor(targetIDC.spd * 0.05);
  const hitChance      = Math.min(95, Math.max(25, Math.floor(plc.accuracy / 10) - evasionPenalty));
  if (Math.floor(Math.random() * 100) >= hitChance) {
    return { isDefense: false, newShield: 0, damage: 0, missed: true, absorbed: 0 };
  }

  // Raw damage — defense stat of the target reduces the blow
  let raw = 0;
  if (plc.type === 'attack') {
    raw = Math.max(100, plc.atk   - Math.floor(targetIDC.def * 0.25));
  } else if (plc.type === 'magic') {
    raw = Math.max(100, plc.magic - Math.floor(targetIDC.def * 0.10));
  }
  // SKL cards or unknown types contribute 0 raw — harmless pass

  const absorbed = Math.min(currentShield, raw);
  const damage   = raw - absorbed;

  return { isDefense: false, newShield: 0, damage, missed: false, absorbed };
}

// ─── DB Helpers ───────────────────────────────────────────────────────────────

/**
 * Loads the boss IDC, PLCs, and SKLs from tutorial_boss_cards.
 * PLCs and SKLs are merged into a single attack rotation array.
 */
async function loadBoss(bossType) {
  const rows = await db.query(
    'SELECT * FROM tutorial_boss_cards WHERE boss_type = ? LIMIT 1',
    [bossType]
  );
  if (!rows.length) throw Object.assign(new Error('BOSS_NOT_SET'), { bossType });

  const boss   = rows[0];
  const plcIds = JSON.parse(boss.plc_ids || '[]');
  const sklIds = JSON.parse(boss.skl_ids || '[]');

  // Identity Card
  const [idc] = await db.query(
    'SELECT * FROM identity_cards WHERE card_id = ? LIMIT 1',
    [boss.idc_card_id]
  );
  if (!idc) throw new Error('BOSS_IDC_MISSING');

  // Play Cards
  let plcs = [];
  if (plcIds.length) {
    const ph = plcIds.map(() => '?').join(',');
    plcs = await db.query(`SELECT * FROM play_cards WHERE card_id IN (${ph})`, plcIds);
  }

  // Skill Cards (loaded and appended to the rotation so the boss uses them too)
  let skls = [];
  if (sklIds.length) {
    const ph = sklIds.map(() => '?').join(',');
    skls = await db.query(`SELECT * FROM skill_cards WHERE card_id IN (${ph})`, sklIds);
  }

  // Combined card pool — PLCs first, SKLs cycle in after
  const allCards = [...plcs, ...skls];
  if (!allCards.length) throw new Error('BOSS_CARDS_MISSING');

  return { idc, plcs: allCards };
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

/**
 * Sends the boss Identity Card as a visual (photo if image_id exists, text otherwise).
 * Builds a clean stats block beneath it — no emojis.
 */
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

  // sendCardVisual handles photo vs. text automatically based on image_id
  await sendCardVisual(bot, chatId, bossIdc, statsCaption);
}

// ─── Fight Bootstrapper ───────────────────────────────────────────────────────

/**
 * Initialises a boss fight:
 *   1. Loads boss data from tutorial_boss_cards.
 *   2. Sends the boss Identity Card visually.
 *   3. Posts the phase rules.
 *   4. Sets up session and waits for the player to submit their IDC.
 */
async function startFight(bot, chatId, tid, playerId, bossType) {
  // ── Load boss ──────────────────────────────────────────────────────────────
  let boss;
  try {
    boss = await loadBoss(bossType);
  } catch (err) {
    if (err.message === 'BOSS_NOT_SET') {
      return bot.sendMessage(
        chatId,
        sys(`Boss configuration for (${bossType}) has not been set.\nContact administration.`),
        { parse_mode: 'Markdown' }
      );
    }
    if (err.message === 'BOSS_IDC_MISSING') {
      return bot.sendMessage(
        chatId,
        sys(`Identity Card for boss (${bossType}) is missing or deleted.\nContact administration.`),
        { parse_mode: 'Markdown' }
      );
    }
    if (err.message === 'BOSS_CARDS_MISSING') {
      return bot.sendMessage(
        chatId,
        sys(`Attack cards for boss (${bossType}) have not been configured.\nContact administration.`),
        { parse_mode: 'Markdown' }
      );
    }
    throw err;
  }

  // ── Load player ────────────────────────────────────────────────────────────
  const { idc: playerIDC, plcs: playerPLCs } = await loadPlayerCards(playerId);
  if (!playerIDC) {
    return bot.sendMessage(
      chatId,
      sys('No Identity Card is linked to your account.\nContact administration.'),
      { parse_mode: 'Markdown' }
    );
  }

  const bossName = bossType === BOSS_NITRON ? 'Nitron' : 'Monster X';
  const phase    = bossType === BOSS_NITRON ? '1' : '2';

  // ── Send boss IDC — photo first, then stats ────────────────────────────────
  await sendBossCard(bot, chatId, boss.idc, bossName);
  await sleep(800);

  // ── Phase rules ────────────────────────────────────────────────────────────
  await bot.sendMessage(
    chatId,
    sys(
      `Phase ${phase}: ${bossName}. Send your IDC to begin.\n\n` +
      `Your card : ${playerIDC.card_id}\n` +
      `Your HP   : ${playerIDC.hp}\n\n` +
      `The opponent will respond only after you play.\n` +
      `You have the first move.`
    ),
    { parse_mode: 'Markdown' }
  );

  // ── Initialise session ─────────────────────────────────────────────────────
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

// ─── Step Handler (called from bot.js message listener) ───────────────────────

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
        sys(`Send your Identity Card (IDC) to begin the fight.\nYour card: \`${sess.data.playerIDC.card_id}\``),
        { parse_mode: 'Markdown' }
      );
    }

    if (cardId.toUpperCase() !== sess.data.playerIDC.card_id.toUpperCase()) {
      return bot.sendMessage(
        chatId,
        sys(`That is not your card.\nYour card is: \`${sess.data.playerIDC.card_id}\``),
        { parse_mode: 'Markdown' }
      );
    }

    // IDC accepted — advance to combat phase
    const d = sess.data;
    session.setSession(tid, 'start_exam', 'in_combat', d);

    return bot.sendMessage(
      chatId,
      sys(
        `Identity Card accepted. Combat initiated.\n\n` +
        `[ ${d.playerIDC.name} ]   HP: ${d.playerHP}\n` +
        `       VS\n` +
        `[ ${d.bossIDC.name} ]   HP: ${d.bossHP}\n\n` +
        `─────────────────────────\n\n` +
        `Round 1 — Your turn.\n\n` +
        `Send a Play Card (PLC) to attack.`
      ),
      { parse_mode: 'Markdown' }
    );
  }

  // ── STEP: in combat ────────────────────────────────────────────────────────
  if (sess.step === 'in_combat') {
    if (!cardId || !cardId.toUpperCase().startsWith('PLC-')) {
      return bot.sendMessage(
        chatId,
        sys('Send a Play Card (PLC) to attack.'),
        { parse_mode: 'Markdown' }
      );
    }

    const d = { ...sess.data };

    // Verify the card belongs to this player
    const plc = d.playerPLCs.find(
      (p) => p.card_id.toUpperCase() === cardId.toUpperCase()
    );
    if (!plc) {
      return bot.sendMessage(
        chatId,
        sys('That card does not belong to you or is not in your hand.'),
        { parse_mode: 'Markdown' }
      );
    }

    // ── Player attacks boss ────────────────────────────────────────────────
    const pRes  = resolveAttack(plc, d.bossIDC, d.bossShield);
    let   pLine = '';

    if (pRes.isDefense) {
      d.playerShield += pRes.newShield;
      pLine = `Defense card played (${plc.name}) — Shield +${pRes.newShield} points.`;
    } else if (pRes.missed) {
      pLine = `Your attack (${plc.name}) missed the target.`;
    } else {
      d.bossShield = Math.max(0, d.bossShield - pRes.absorbed);
      d.bossHP    -= pRes.damage;
      pLine        = `You struck ${d.bossName} for ${pRes.damage} damage (${plc.name})`;
      if (pRes.absorbed) pLine += ` — ${pRes.absorbed} absorbed by shield`;
      pLine += '.';
    }

    // ── Check boss defeated ────────────────────────────────────────────────
    if (d.bossHP <= 0) {
      d.bossHP = 0;
      session.clearSession(tid);
      await bot.sendMessage(
        chatId,
        sys(`${pLine}\n\n${d.bossName} HP: 0\n\n...`),
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
      bLine         = `${d.bossName} played a defense card (${bossCard.name}) — Shield +${bRes.newShield}.`;
    } else if (bRes.missed) {
      bLine = `${d.bossName} attack (${bossCard.name}) missed.`;
    } else {
      d.playerShield = Math.max(0, d.playerShield - bRes.absorbed);
      d.playerHP    -= bRes.damage;
      bLine          = `${d.bossName} struck you for ${bRes.damage} damage (${bossCard.name})`;
      if (bRes.absorbed) bLine += ` — ${bRes.absorbed} absorbed by your shield`;
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
          `You        :  0 HP\n` +
          `${d.bossName}  :  ${d.bossHP} HP`
        ),
        { parse_mode: 'Markdown' }
      );
      await sleep(1000);
      return handleLoss(bot, chatId, tid, d);
    }

    // ── Advance round — update session and prompt next card ────────────────
    d.round += 1;
    session.setSession(tid, 'start_exam', 'in_combat', d);

    return bot.sendMessage(
      chatId,
      sys(
        `Round ${d.round - 1}\n\n` +
        `${pLine}\n` +
        `${bLine}\n\n` +
        `─────────────────────────\n` +
        `You        :  ${d.playerHP} HP${d.playerShield ? `   Shield: ${d.playerShield}` : ''}\n` +
        `${d.bossName}  :  ${d.bossHP} HP${d.bossShield ? `   Shield: ${d.bossShield}` : ''}\n\n` +
        `Round ${d.round} — Send your next card.`
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
      sys('Nitron defeated. Initializing second test...'),
      { parse_mode: 'Markdown' }
    );

    // Transfer Skill cards (SKL) from BOT_SYSTEM to the player
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

    // Transfer Weapon cards (WPN) from BOT_SYSTEM to the player
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
        'Your remaining cards have been transferred.\n\n' +
        'The trial is not over.\n\n' +
        'A second adversary emerges from the dark.'
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
        sys('An error occurred while initializing the second fight.\nContact administration.'),
        { parse_mode: 'Markdown' }
      );
    }
  }

  // ── Monster X cleared → grant Refugee rank ─────────────────────────────────
  await db.query(
    `UPDATE players
     SET system_rank = 'refugee', is_tutorial_complete = 1
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
      'You have proven your worth.\n\n' +
      '"Welcome, warrior, to the Raazn system.\n' +
      'YATG."\n\n' +
      `─────────────────────────\n\n` +
      `Name        :  ${realName}\n` +
      `Character   :  ${charName}\n` +
      `New Rank    :  Refugee\n\n` +
      'You are free now.\n' +
      'The world is open before you.'
    ),
    { parse_mode: 'Markdown' }
  );
}

// ─── Loss Handler ─────────────────────────────────────────────────────────────

async function handleLoss(bot, chatId, tid, d) {
  const failStage = d.bossType === BOSS_NITRON
    ? STAGE.FAILED_NITRON
    : STAGE.FAILED_MONSTER;

  await setTutorialStage(d.playerId, failStage);

  return bot.sendMessage(
    chatId,
    sys(
      'You fell in battle.\n\n' +
      '"Our confidence in you was misplaced.\n\n' +
      'The system grants you one more chance.\n\n' +
      'Type $continue to retake the test,\n' +
      'if you still have the will."'
    ),
    { parse_mode: 'Markdown' }
  );
}

// ─── Register Commands ─────────────────────────────────────────────────────────

// ─── Join Handler (called directly from bot.js on new_chat_members) ──────────
// Extracted from register() so bot.js can call it explicitly at the top of its
// message handler — before any early-return guards on missing text.
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

    // Already a refugee — welcome back, no exam
    if (player.is_tutorial_complete == 1) {
      await bot.sendMessage(
        chatId,
        sys(
          `The gates recognise you, ${player.character_name}.\n` +
          `You earned your place here. Welcome back.`
        ),
        { parse_mode: 'Markdown' }
      );
      continue;
    }

    // Active session already running — do not double-trigger
    if (session.hasActiveSession(tid)) continue;

    const stage = await getTutorialStage(player.id);

    if (stage === STAGE.NITRON_CLEARED || stage === STAGE.FAILED_MONSTER) {
      await bot.sendMessage(
        chatId,
        sys(
          `You have returned, ${player.character_name}.\n\n` +
          `Your trial is not finished.\n` +
          `Type $continue to resume.`
        ),
        { parse_mode: 'Markdown' }
      );
      continue;
    }

    if (stage === STAGE.FAILED_NITRON) {
      await bot.sendMessage(
        chatId,
        sys(
          `You have returned, ${player.character_name}.\n\n` +
          `You failed before. The arena remembers.\n` +
          `Type $continue to face Nitron again.`
        ),
        { parse_mode: 'Markdown' }
      );
      continue;
    }

    // Fresh entrant — welcome and auto-start
    await bot.sendMessage(
      chatId,
      sys(
        `Welcome to the Proving Grounds, ${player.character_name}.\n` +
        `Your worth will be tested here.`
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
        sys('An error occurred while initializing your trial.\nContact administration.'),
        { parse_mode: 'Markdown' }
      );
    }
  }
}

function register(bot) {

  // ── $start_exam ─────────────────────────────────────────────────────────────
  bot.onText(/^\$start_exam$/i, async (msg) => {
    const chatId = msg.chat.id;
    const tid    = msg.from.id;

    // Official group only
    if (chatId !== OFFICIAL_GROUP_ID) {
      try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
      if (msg.chat.type === 'private') {
        return bot.sendMessage(
          chatId,
          sys('The Proving Grounds exist in the official group only.\nGo there to begin.'),
          { parse_mode: 'Markdown' }
        );
      }
      return;
    }

    // Prevent re-entry during an active session
    if (session.hasActiveSession(tid)) {
      const activeSess = session.getSession(tid);
      if (activeSess?.action === 'start_exam') {
        return bot.sendMessage(
          chatId,
          sys('You are already in the middle of a test.\nFinish your current fight first.'),
          { parse_mode: 'Markdown' }
        );
      }
    }

    // Must be registered
    const players = await db.query(
      'SELECT * FROM players WHERE telegram_id = ? LIMIT 1',
      [tid]
    );
    if (!players.length) {
      return bot.sendMessage(
        chatId,
        sys('You are not registered.\nUse $login in DM first.'),
        { parse_mode: 'Markdown' }
      );
    }
    const player = players[0];

    if (player.is_tutorial_complete == 1) {
      return bot.sendMessage(
        chatId,
        sys(`You have already completed the exam, ${player.character_name}.\nYou are a Refugee.`),
        { parse_mode: 'Markdown' }
      );
    }

    // Must have reached character selection before attempting the exam
    const stage = await getTutorialStage(player.id);

    if (!stage || stage === STAGE.CHAR_SELECTED || stage === STAGE.FAILED_NITRON) {

      if (stage !== STAGE.CHAR_SELECTED && stage !== STAGE.FAILED_NITRON && stage !== null) {
        // Guard: only character_selected may start fresh
        return bot.sendMessage(
          chatId,
          sys('Complete character selection before starting the exam.'),
          { parse_mode: 'Markdown' }
        );
      }

      // ── Welcoming message ────────────────────────────────────────────────
      await bot.sendMessage(
        chatId,
        sys(
          'Welcome to the Proving Grounds.\n' +
          'Your worth will be tested here.'
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
          sys('An error occurred while initializing the fight.\nContact administration.'),
          { parse_mode: 'Markdown' }
        );
      }
    }

    if (stage === STAGE.NITRON_CLEARED) {
      await bot.sendMessage(
        chatId,
        sys('Nitron was already defeated.\nThe second test has not yet been completed.'),
        { parse_mode: 'Markdown' }
      );
      await sleep(1000);
      try {
        return await startFight(bot, chatId, tid, player.id, BOSS_MONSTER_X);
      } catch (err) {
        console.error('[start_exam] startFight error:', err);
        return bot.sendMessage(
          chatId,
          sys('An error occurred while initializing the fight.\nContact administration.'),
          { parse_mode: 'Markdown' }
        );
      }
    }

    if (stage === STAGE.FAILED_MONSTER) {
      return bot.sendMessage(
        chatId,
        sys(
          'You previously failed against Monster X.\n\n' +
          'Type $continue to retry.'
        ),
        { parse_mode: 'Markdown' }
      );
    }

    // Fallback — unexpected state
    return bot.sendMessage(
      chatId,
      sys('Unexpected state detected.\nContact administration.'),
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
        sys(`You have already completed the exam, ${player.character_name}.`),
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
        sys('There is no fight to retry.\nUse $start_exam.'),
        { parse_mode: 'Markdown' }
      );
    }

    const bossName = bossType === BOSS_NITRON ? 'Nitron' : 'Monster X';
    await bot.sendMessage(
      chatId,
      sys(
        `Retrying fight against ${bossName}.\n\n` +
        'You will not fail again.'
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
        sys('An error occurred while initializing the fight.\nContact administration.'),
        { parse_mode: 'Markdown' }
      );
    }
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = { register, handleStep, handleJoin };