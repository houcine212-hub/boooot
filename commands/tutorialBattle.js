'use strict';

/**
 * commands/tutorialBattle.js
 *
 * Phase 3 — The Nitron Fight ($start_exam)
 *
 * Flow:
 *  1. $start_exam  →  group-only guard  →  player validation (stage = 'character_selected')
 *  2. Cinematic narrative sequence
 *  3. startNitronFight() — launches a tutorial fight against the Nitron boss
 *     CRITICAL DIFFERENCE from startStoryBattle():
 *       The bot NEVER sends its IDC proactively.
 *       It only reveals its IDC *after* the player has sent theirs.
 *       This guarantees the player is always the Active Player in Round 1.
 *  4. Win  → stage = 'nitron_defeated' + waiting-for-next-test message
 *     Loss / Timeout → retry message with $continue hint
 *
 * Integration points:
 *   • botFight.js   — hasFight(), fights Map, _endFight (re-exported as cancelFight),
 *                     handleFightMessage(), _handleIdentityCard internals are mirrored
 *                     here with tutorial-specific overrides.
 *   • setTutorialBoss.js — loadTutorialBossCards('nitron')
 *   • sessionManager    — setSession / clearSession / getSession
 *   • db/connection     — db.queryOne / db.query
 */

const db            = require('../db/connection');
const session       = require('../middleware/sessionManager');
const combatEngine  = require('../utils/CombatEngine');
const { sendCardVisual, escapeMarkdown } = require('../utils/cardVisuals');
const { loadTutorialBossCards }          = require('./admin/setTutorialBoss');
const botFight                           = require('./botFight');

// ─── Config ───────────────────────────────────────────────────────────────────

const OFFICIAL_GROUP_ID = -1005139545387;

// TTL for the tutorial fight — same as standard fights (3 min)
const FIGHT_TTL = 3 * 60 * 1000;

// ─── In-memory fight storage (tutorial fights only) ──────────────────────────
// Key: chatId (string)  Value: tutorial fight-state object
const tutFights = new Map();
const tutTimers = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sys(body) {
  return `\`\`\`\n[ ＳＹＳＴＥＭ ]\n\n${body}\n\`\`\``;
}

function hasTutFight(chatId) { return tutFights.has(String(chatId)); }
function getTutFight(chatId) { return tutFights.get(String(chatId)) || null; }

// HP status line shown after each round
function hpLine(fight) {
  return (
    ` ${escapeMarkdown(fight.player.name)}: *${fight.player.currentHp}*  ` +
    `|   Nitron: *${fight.bot.currentHp}*`
  );
}

// ─── TTL timer ────────────────────────────────────────────────────────────────

function _setTutTimer(bot, chatId) {
  const key = String(chatId);
  if (tutTimers.has(key)) clearTimeout(tutTimers.get(key));

  const id = setTimeout(async () => {
    const fight = tutFights.get(key);
    if (!fight) return;
    tutFights.delete(key);
    tutTimers.delete(key);
    session.clearSession(fight.playerTelegramId);
    try {
      await bot.sendMessage(
        chatId,
        `\`\`\`\n[ ＳＹＳＴＥＭ ]\n\n` +
        `للأسف، ثقتنا فيك كانت خطيئة من البداية.\n\n` +
        `دازت 3 دقايق بدون أي تفاعل.\n` +
        `اكتب $start_exam لإعادة الاختبار أيها الضعيف.\n` +
        `\`\`\``,
        { parse_mode: 'Markdown' }
      );
    } catch (_) {}
  }, FIGHT_TTL);

  tutTimers.set(key, id);
}

function _endTutFight(chatId, telegramId) {
  const key = String(chatId);
  tutFights.delete(key);
  session.clearSession(telegramId);
  if (tutTimers.has(key)) {
    clearTimeout(tutTimers.get(key));
    tutTimers.delete(key);
  }
}

// ─── Load player cards ────────────────────────────────────────────────────────

async function _loadPlayerCards(playerId) {
  const identity    = await db.queryOne('SELECT * FROM identity_cards WHERE player_id = ?', [playerId]);
  if (!identity) return null;
  const playCards   = await db.query('SELECT * FROM play_cards   WHERE player_id = ?', [playerId]);
  const weaponCards = await db.query('SELECT * FROM weapon_cards WHERE player_id = ?', [playerId]);
  const skillCards  = await db.query('SELECT * FROM skill_cards  WHERE player_id = ?', [playerId]);
  return { identity, playCards, weaponCards, skillCards };
}

// ─── Get a single player card by ID (PLC / WPN / SKL) ────────────────────────

async function _getPlayerCard(telegramId, cardId) {
  const join = 'JOIN players p ON p.id = TABLENAME.player_id WHERE TABLENAME.card_id = ? AND p.telegram_id = ?';
  if (cardId.startsWith('PLC-')) return db.queryOne(`SELECT pc.* FROM play_cards   pc ${join.replace(/TABLENAME/g,'pc')}`, [cardId, telegramId]);
  if (cardId.startsWith('WPN-')) return db.queryOne(`SELECT wc.* FROM weapon_cards wc ${join.replace(/TABLENAME/g,'wc')}`, [cardId, telegramId]);
  if (cardId.startsWith('SKL-')) return db.queryOne(`SELECT sc.* FROM skill_cards  sc ${join.replace(/TABLENAME/g,'sc')}`, [cardId, telegramId]);
  return null;
}

// ─── Bot AI: choose attack card (identical to botFight.chooseBotAttack) ───────

function _chooseBotAttack(fight) {
  const bot = fight.bot;

  if (fight.round <= 1) {
    const stun = bot.skillCards.find(c => c.type === 'stun' && !bot.usedCards.has(c.card_id));
    if (stun) return stun;
  }

  const atk = bot.playCards
    .filter(c => c.type === 'attack' && !bot.usedCards.has(c.card_id))
    .sort((a, b) => (b.atk || 0) - (a.atk || 0))[0];
  if (atk) return atk;

  const magic = bot.playCards
    .filter(c => c.type === 'magic' && !bot.usedCards.has(c.card_id))
    .sort((a, b) => (b.magic || 0) - (a.magic || 0))[0];
  if (magic) return magic;

  const weapon = bot.weaponCards
    .filter(c => c.weapon_type === 'normal' && ['attack','magic'].includes(c.sub_type) && !bot.usedCards.has(c.card_id))
    .sort((a, b) => ((b.atk||0)+(b.magic||0)) - ((a.atk||0)+(a.magic||0)))[0];
  if (weapon) return weapon;

  return [...bot.playCards, ...bot.weaponCards, ...bot.skillCards]
    .find(c => !bot.usedCards.has(c.card_id)) || null;
}

// ─── Bot response chooser ─────────────────────────────────────────────────────

function _chooseBotResponse(fight, activeCard) {
  const botState  = fight.bot;
  const activeKind = combatEngine.getCardKind(activeCard);

  if (activeKind === 'attack') {
    const defenses = [
      ...botState.playCards.filter(c => c.type === 'defense'),
      ...botState.weaponCards.filter(c => c.weapon_type === 'normal' && c.sub_type === 'defense')
    ].filter(c => !botState.usedCards.has(c.card_id));

    const bestDef = defenses.sort((a, b) => {
      const da = combatEngine.calculateDamage(activeCard, a).toReactive;
      const db_ = combatEngine.calculateDamage(activeCard, b).toReactive;
      return da - db_;
    })[0] || null;

    const reflect = botState.skillCards
      .filter(c => c.type === 'reflect' && !botState.usedCards.has(c.card_id) &&
        combatEngine.getSkillEffectPoints(c) > ((activeCard.atk || 0) + (activeCard.magic || 0)))
      .sort((a,b) => combatEngine.getSkillEffectPoints(b) - combatEngine.getSkillEffectPoints(a))[0] || null;

    if (reflect && bestDef && combatEngine.calculateDamage(activeCard, bestDef).toReactive > 0) return reflect;
    if (bestDef) return bestDef;
  }

  const punish = botState.skillCards
    .filter(c => ['stun','poison'].includes(c.type) && !botState.usedCards.has(c.card_id))
    .sort((a,b) => combatEngine.getSkillEffectPoints(b) - combatEngine.getSkillEffectPoints(a))[0];
  return punish || null;
}

// ─── Send combat lines helper ─────────────────────────────────────────────────

async function _sendLines(bot, chatId, lines) {
  const payload = (lines || []).filter(Boolean);
  if (payload.length === 0) return;
  await bot.sendMessage(chatId, payload.join('\n'), { parse_mode: 'Markdown' });
}

// ─── Win / Loss resolution ────────────────────────────────────────────────────

async function _checkWin(bot, chatId, fight) {
  // ── Player wins ──────────────────────────────────────────────────────────
  if (fight.bot.currentHp <= 0) {
    // Update tutorial stage
    await db.query(
      `UPDATE player_tutorial_state SET stage = 'nitron_defeated' WHERE player_id = ?`,
      [fight.playerId]
    );

    await bot.sendMessage(
      chatId,
      `\`\`\`\n◈ ═══════════════════════ ◈\n\n` +
      `  النصر...\n\n` +
      `لقد أثبتت جدارتك وهزمت Nitron.\n` +
      `رتبتك الأولى في الأفق.\n\n` +
      `انتظر الاختبار التالي من النظام.\n\n` +
      `◈ ═══════════════════════ ◈\n\`\`\``,
      { parse_mode: 'Markdown' }
    );

    _endTutFight(chatId, fight.playerTelegramId);
    return true;
  }

  // ── Bot wins (player loses) ───────────────────────────────────────────────
  if (fight.player.currentHp <= 0) {
    await bot.sendMessage(
      chatId,
      `\`\`\`\n[ ＳＹＳＴＥＭ ]\n\n` +
      `للأسف، ثقتنا فيك كانت خطيئة من البداية.\n\n` +
      `اكتب $start_exam لإعادة الاختبار أيها الضعيف.\n` +
      `\`\`\``,
      { parse_mode: 'Markdown' }
    );

    _endTutFight(chatId, fight.playerTelegramId);
    return true;
  }

  return false;
}

// ─── Bot attack turn ──────────────────────────────────────────────────────────

async function _botAttackTurn(bot, chatId, fight) {
  fight.turn   = 'bot';
  fight.status = 'bot_turn';
  await sleep(1200);

  const start = combatEngine.processTurnStart(fight.bot, { playerName: 'Nitron' });
  await _sendLines(bot, chatId, start.summaryLines);
  if (await _checkWin(bot, chatId, fight)) return true;

  if (start.skipTurn) {
    await sleep(800);
    await _nextTurn(bot, chatId, fight);
    return true;
  }

  const card = _chooseBotAttack(fight);
  if (!card) {
    await bot.sendMessage(chatId, ` Nitron لا يملك بطاقات متبقية!`);
    await _announcePlayerTurn(bot, chatId, fight);
    return true;
  }

  fight.bot.usedCards.add(card.card_id);
  fight.lastBotCard = card;
  fight.status      = 'player_response';

  await sendCardVisual(
    bot, chatId, card,
    ` *Nitron* يلعب: *${escapeMarkdown(card.name)}* (\`${card.card_id}\`)\n` +
    ` *رد!* أرسل بطاقة للرد (PLC / WPN / SKL):`
  );
  return true;
}

// ─── Player turn announcement ─────────────────────────────────────────────────

async function _announcePlayerTurn(bot, chatId, fight) {
  fight.turn   = 'player';
  fight.status = 'processing';

  const start = combatEngine.processTurnStart(fight.player, { playerName: escapeMarkdown(fight.player.name) });
  await _sendLines(bot, chatId, start.summaryLines);
  if (await _checkWin(bot, chatId, fight)) return true;

  if (start.skipTurn) {
    await sleep(800);
    await _nextTurn(bot, chatId, fight);
    return true;
  }

  fight.status = 'player_turn';
  await bot.sendMessage(chatId, ` *دورك!* أرسل إحدى بطاقاتك (PLC / WPN / SKL):`, { parse_mode: 'Markdown' });
  return true;
}

// ─── Next turn router ─────────────────────────────────────────────────────────

async function _nextTurn(bot, chatId, fight) {
  fight.round += 1;
  if (fight.turn === 'player') {
    fight.turn = 'bot';
    await _botAttackTurn(bot, chatId, fight);
  } else {
    await _announcePlayerTurn(bot, chatId, fight);
  }
}

// ─── Send combat resolution ───────────────────────────────────────────────────

async function _sendResolution(bot, chatId, fight, resolution) {
  await _sendLines(bot, chatId, [
    ` *النتيجة:*`,
    ...(resolution.summaryLines.length > 0 ? resolution.summaryLines : [' لم يحدث أي تأثير مباشر.']),
    '',
    hpLine(fight)
  ]);
}

// ─── Handle player attack turn ────────────────────────────────────────────────

async function _handlePlayerAttack(bot, chatId, fight, cardId) {
  const card = await _getPlayerCard(fight.playerTelegramId, cardId);
  if (!card) {
    await bot.sendMessage(chatId, ' البطاقة غير موجودة أو ليست لك.');
    return true;
  }
  if (fight.player.usedCards.has(cardId)) {
    await bot.sendMessage(chatId, ' هذه البطاقة استُخدمت مسبقاً.');
    return true;
  }

  fight.player.usedCards.add(cardId);
  fight.status = 'processing';

  await _sendLines(bot, chatId, [
    ` *${escapeMarkdown(fight.player.name)}* لعب: *${escapeMarkdown(card.name)}*`
  ]);

  const botResp = _chooseBotResponse(fight, card);
  if (botResp) {
    fight.bot.usedCards.add(botResp.card_id);
    await sendCardVisual(bot, chatId, botResp,
      ` Nitron يرد بـ: *${escapeMarkdown(botResp.name)}* (\`${botResp.card_id}\`)`
    );
  } else {
    await _sendLines(bot, chatId, [` Nitron لم يجد رداً مناسباً.`]);
  }

  const resolution = combatEngine.resolveTurn(
    card, botResp, fight.player, fight.bot,
    { activeName: escapeMarkdown(fight.player.name), reactiveName: 'Nitron' }
  );

  await _sendResolution(bot, chatId, fight, resolution);
  if (await _checkWin(bot, chatId, fight)) return true;

  await sleep(800);
  await _nextTurn(bot, chatId, fight);
  return true;
}

// ─── Handle player response to bot attack ─────────────────────────────────────

async function _handlePlayerResponse(bot, chatId, fight, cardId) {
  if (!fight.lastBotCard) return true;

  const card = await _getPlayerCard(fight.playerTelegramId, cardId);
  if (!card) {
    await bot.sendMessage(chatId, ' البطاقة غير موجودة أو ليست لك.');
    return true;
  }
  if (fight.player.usedCards.has(cardId)) {
    await bot.sendMessage(chatId, ' هذه البطاقة استُخدمت مسبقاً.');
    return true;
  }

  fight.player.usedCards.add(cardId);
  fight.status = 'processing';

  const playerIsAttacking = combatEngine.getCardKind(card) === 'attack';

  await _sendLines(bot, chatId, [
    ` *${escapeMarkdown(fight.player.name)}* يرد بـ: *${escapeMarkdown(card.name)}*`
  ]);

  const botAttackCard  = fight.lastBotCard;
  fight.lastBotCard    = null;

  const resolution = combatEngine.resolveTurn(
    botAttackCard, card, fight.bot, fight.player,
    { activeName: 'Nitron', reactiveName: escapeMarkdown(fight.player.name) }
  );
  await _sendResolution(bot, chatId, fight, resolution);
  if (await _checkWin(bot, chatId, fight)) return true;

  if (playerIsAttacking) {
    await sleep(600);
    await _sendLines(bot, chatId, [
      ` *${escapeMarkdown(fight.player.name)}* هاجم في نفس الوقت — Nitron يرد!`
    ]);

    const botCounter = _chooseBotResponse(fight, card);
    if (botCounter) {
      fight.bot.usedCards.add(botCounter.card_id);
      await sendCardVisual(bot, chatId, botCounter,
        ` Nitron يرد بـ: *${escapeMarkdown(botCounter.name)}* (\`${botCounter.card_id}\`)`
      );
    } else {
      await _sendLines(bot, chatId, [` Nitron لم يجد رداً — الهجوم يصل مباشرة!`]);
    }

    const counterRes = combatEngine.resolveTurn(
      card, botCounter, fight.player, fight.bot,
      { activeName: escapeMarkdown(fight.player.name), reactiveName: 'Nitron' }
    );
    await _sendResolution(bot, chatId, fight, counterRes);
    if (await _checkWin(bot, chatId, fight)) return true;
  }

  await sleep(800);
  await _nextTurn(bot, chatId, fight);
  return true;
}

// ─── Identity card received (TUTORIAL VERSION) ────────────────────────────────
//
// CRITICAL CUSTOM LOGIC:
//   In the standard botFight flow, the bot races to send its IDC concurrently
//   with the player via a random timeout. This means the bot can win the race
//   and become the Active Player (attacks first) in Round 1.
//
//   For the tutorial, we INVERT this:
//     • The fight starts in status='wait_player_identity' (no race).
//     • The bot does NOT send its IDC proactively.
//     • Only AFTER the player's IDC arrives do we reveal the bot IDC.
//     • The player's turn is always set first (turn = 'player').
//
// This guarantees the player is always the Active Player in Round 1.

async function _handleIdentityCard(bot, chatId, fight, telegramId, cardId) {
  // Verify the card belongs to this player
  const row = await db.queryOne(
    `SELECT ic.* FROM identity_cards ic
     JOIN players p ON p.id = ic.player_id
     WHERE ic.card_id = ? AND p.telegram_id = ?`,
    [cardId, telegramId]
  );
  if (!row) {
    await bot.sendMessage(chatId, ' هذه البطاقة ليست لك أو غير موجودة.');
    return true;
  }

  // Load player's full card set
  const pCards = await _loadPlayerCards(fight.playerId);
  if (!pCards) {
    await bot.sendMessage(chatId, ' تعذّر تحميل بطاقاتك. تواصل مع الإدارة.');
    return true;
  }

  fight.player.identityCard = pCards.identity;
  fight.player.currentHp    = pCards.identity.hp;
  fight.player.playCards    = pCards.playCards;
  fight.player.weaponCards  = pCards.weaponCards;
  fight.player.skillCards   = pCards.skillCards;

  // Player always attacks first in the tutorial
  fight.turn   = 'player';
  fight.status = 'processing';

  const pi = fight.player.identityCard;
  const bi = fight.bot.identityCard;

  // ── Show player card ──────────────────────────────────────────────────────
  await bot.sendMessage(
    chatId,
    ` بطاقتك مقبولة!\n\n` +
    `━━━━━━━━  ${escapeMarkdown(fight.player.name)} ━━━━━━━━\n` +
    ` HP: ${pi.hp}   ATK: ${pi.atk}   Magic: ${pi.magic || 0}\n` +
    ` DEF: ${pi.def}   SPD: ${pi.spd}   Accuracy: ${pi.accuracy}`,
    { parse_mode: 'Markdown' }
  );

  await sleep(700);

  // ── Reveal bot IDC AFTER player (tutorial guarantee) ─────────────────────
  await sendCardVisual(
    bot, chatId, bi,
    ` *Nitron* يكشف بطاقته!\n\n` +
    `━━━━━━━━  Nitron ━━━━━━━━\n` +
    ` HP: ${bi.hp}   ATK: ${bi.atk}   Magic: ${bi.magic || 0}\n` +
    ` DEF: ${bi.def}   SPD: ${bi.spd}   Accuracy: ${bi.accuracy}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━`
  );

  await sleep(800);

  if (fight.round === 0) fight.round = 1;

  // Player always starts — guaranteed by tutorial design
  fight.status = 'player_turn';
  await bot.sendMessage(
    chatId,
    ` *أنت تبدأ!* أرسل إحدى بطاقاتك (PLC / WPN / SKL):`,
    { parse_mode: 'Markdown' }
  );
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ▶  startNitronFight  —  launches the tutorial Nitron battle
// ═══════════════════════════════════════════════════════════════════════════════

async function startNitronFight(bot, chatId, telegramId) {
  const cid = String(chatId);

  // Refuse to start if a standard or tutorial fight is already running
  if (botFight.hasFight(chatId) || tutFights.has(cid)) {
    return bot.sendMessage(chatId, ' هناك نزال جارٍ حالياً في هذه المجموعة. انتظر حتى ينتهي.');
  }

  // Load player record
  const player = await db.queryOne(
    `SELECT p.*, ic.id AS ic_db_id
     FROM players p
     LEFT JOIN identity_cards ic ON ic.player_id = p.id
     WHERE p.telegram_id = ?`,
    [telegramId]
  );
  if (!player)         return bot.sendMessage(chatId, ' لم يُعثر على ملفك. تأكد من التسجيل ($login).');
  if (!player.ic_db_id) return bot.sendMessage(chatId, ' يجب أن تمتلك بطاقة تعريفية (IDC) للدخول في النزال.');

  // Load Nitron boss cards
  const botCards = await loadTutorialBossCards('nitron');
  if (!botCards) {
    return bot.sendMessage(
      chatId,
      sys(' بطاقات Nitron غير مُعدَّة بعد.\nتواصل مع الإدارة.')
    );
  }

  // Build tutorial fight state
  // status = 'wait_player_identity'  (NOT 'race') — bot never sends IDC first
  const fightState = {
    playerTelegramId : telegramId,
    playerId         : player.id,
    isTutorial       : true,           // flag used for win/loss routing
    status           : 'wait_player_identity',
    turn             : null,
    round            : 0,
    lastBotCard      : null,
    player: {
      name         : player.character_name,
      identityCard : null,
      currentHp    : 0,
      playCards    : [],
      weaponCards  : [],
      skillCards   : [],
      usedCards    : new Set(),
      effects      : []
    },
    bot: {
      identityCard : botCards.identity,
      currentHp    : botCards.identity.hp,
      playCards    : botCards.playCards,
      weaponCards  : botCards.weaponCards,
      skillCards   : botCards.skillCards,
      usedCards    : new Set(),
      effects      : []
    }
  };

  tutFights.set(cid, fightState);
  _setTutTimer(bot, chatId);
  session.setSession(telegramId, 'tutorial_fight', 'wait_player_identity');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ▶  handleTutorialFightMessage  —  card routing during the Nitron fight
//    Called from bot.js message listener when session.action === 'tutorial_fight'
// ═══════════════════════════════════════════════════════════════════════════════

async function handleTutorialFightMessage(bot, msg, cardId) {
  const chatId     = msg.chat.id;
  const telegramId = msg.from.id;
  const fight      = tutFights.get(String(chatId));
  if (!fight) return false;

  // Only the fight's player can interact
  if (telegramId !== fight.playerTelegramId) return false;

  // Reset inactivity timer on every valid interaction
  _setTutTimer(bot, chatId);

  // ── Waiting for player IDC ─────────────────────────────────────────────────
  if (fight.status === 'wait_player_identity') {
    if (!cardId || !cardId.startsWith('IDC-')) {
      await bot.sendMessage(chatId,
        ' أرسل *بطاقتك التعريفية* (IDC-XXXXX) للبدء.',
        { parse_mode: 'Markdown' }
      );
      return true;
    }
    return _handleIdentityCard(bot, chatId, fight, telegramId, cardId);
  }

  // ── Player's attack turn ───────────────────────────────────────────────────
  if (fight.status === 'player_turn') {
    if (!cardId) {
      await bot.sendMessage(chatId, ' أرسل رقم بطاقة صالح (PLC / WPN / SKL).');
      return true;
    }
    return _handlePlayerAttack(bot, chatId, fight, cardId);
  }

  // ── Player responds to Nitron's attack ────────────────────────────────────
  if (fight.status === 'player_response') {
    if (!cardId) {
      await bot.sendMessage(chatId, ' أرسل بطاقة للرد (PLC / WPN / SKL).');
      return true;
    }
    return _handlePlayerResponse(bot, chatId, fight, cardId);
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ▶  register  —  registers the $start_exam command on the bot instance
// ═══════════════════════════════════════════════════════════════════════════════

function register(bot) {
  bot.onText(/^\$start_exam$/i, async (msg) => {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;

    // ── 1. Location guard: group only ──────────────────────────────────────
    if (chatId !== OFFICIAL_GROUP_ID) {
      return bot.sendMessage(
        chatId,
        sys(
          ` هذا الأمر يعمل فقط في المجموعة الرسمية.\n\n` +
          `توجّه إلى المجموعة الرسمية وأعد كتابة $start_exam هناك.`
        ),
        { parse_mode: 'Markdown' }
      );
    }

    // ── 2. Player validation ───────────────────────────────────────────────
    const player = await db.queryOne(
      `SELECT p.id, p.character_name, pts.stage
       FROM players p
       JOIN player_tutorial_state pts ON pts.player_id = p.id
       WHERE p.telegram_id = ?`,
      [telegramId]
    );

    // Not registered at all
    if (!player) {
      return bot.sendMessage(
        chatId,
        sys(` أنت غير مسجّل في النظام.\nافتح محادثة خاصة مع البوت واكتب $login أولاً.`),
        { parse_mode: 'Markdown' }
      );
    }

    // Phase 2 not completed
    if (player.stage !== 'character_selected') {
      // Let already-cleared players retry if needed
      if (player.stage === 'nitron_defeated') {
        return bot.sendMessage(
          chatId,
          sys(` لقد اجتزت اختبار Nitron بالفعل.\nانتظر الاختبار التالي من النظام.`),
          { parse_mode: 'Markdown' }
        );
      }

      return bot.sendMessage(
        chatId,
        sys(
          ` لم تكتمل المرحلة الثانية بعد.\n\n` +
          `افتح محادثة خاصة مع البوت واكتب $login لإكمال التسجيل أولاً.`
        ),
        { parse_mode: 'Markdown' }
      );
    }

    // ── 3. Block if a fight is already running in this group ───────────────
    if (botFight.hasFight(chatId) || hasTutFight(chatId)) {
      return bot.sendMessage(
        chatId,
        ' هناك نزال جارٍ حالياً في هذه المجموعة. انتظر حتى ينتهي.'
      );
    }

    // ── 4. Cinematic narrative sequence ────────────────────────────────────
    const loadMsg = await bot.sendMessage(
      chatId,
      sys(` جاري فحص العزيمة...\n\n[ ░░░░░░░░░░ ]  0%`),
      { parse_mode: 'Markdown' }
    );

    await sleep(1100);
    await bot.editMessageText(
      sys(` جاري فحص العزيمة...\n\n[ █████████░ ]  90%`),
      { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'Markdown' }
    );

    await sleep(900);
    await bot.editMessageText(
      sys(` جاري فحص العزيمة...\n\n[ █████████▉ ]  95%`),
      { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'Markdown' }
    );

    await sleep(900);
    await bot.editMessageText(
      sys(` [ ██████████ ]  100%\n\فحص مكتمل.`),
      { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'Markdown' }
    );

    await sleep(800);

    // Narrative
    await bot.sendMessage(
      chatId,
      `\`\`\`\n◈ ═══════════════════════ ◈\n\n` +
      `مرحباً بك في أرض التأهيل،\n` +
      `${escapeMarkdown(player.character_name)}.\n\n` +
      `هنا سنختبر عزيمتك واستحقاقك\n` +
      `لرتبة لاجئ في نظام Raazn.\n\n` +
      `أمامك كيان يُعرف بـ Nitron.\n` +
      `أثبت لنا أنك تستحق.\n\n` +
      `◈ ═══════════════════════ ◈\n\`\`\``,
      { parse_mode: 'Markdown' }
    );

    await sleep(1000);
    await bot.sendMessage(chatId, '1️⃣...');
    await sleep(900);
    await bot.sendMessage(chatId, '2️⃣...');
    await sleep(900);
    await bot.sendMessage(chatId, '3️⃣...');
    await sleep(600);

    // ── 5. Launch the tutorial fight ───────────────────────────────────────
    await startNitronFight(bot, chatId, telegramId);

    // The fight state is now set to 'wait_player_identity'.
    // The bot will NOT send its IDC — it waits for the player's card first.
    await bot.sendMessage(
      chatId,
      ` *أرسل بطاقتك التعريفية (IDC\\-XXXXX) لبدء النزال\\!*`,
      { parse_mode: 'MarkdownV2' }
    );
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  register,
  startNitronFight,
  handleTutorialFightMessage,
  hasTutFight,
  getTutFight,
};