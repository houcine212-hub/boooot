const db = require('../db/connection');
const session = require('../middleware/sessionManager');
const combatEngine = require('../utils/CombatEngine');
const { sendCardVisual, escapeMarkdown } = require('../utils/cardVisuals');

const REQUEST_TTL = 60 * 1000;
const FIGHT_TTL = 3 * 60 * 1000;
const CHAIN_SKIP_WORDS = new Set(['skip', 'pass']);

const pendingChallenges = new Map();
const requestTimers = new Map();

const fights = new Map();
const fightTimers = new Map();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ─── Display helpers ──────────────────────────────────────────────────────────
function getDisplayName(user, fallback = 'Player') {
  const parts = [user?.first_name, user?.last_name].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  if (user?.username) return `@${user.username}`;
  return fallback;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
async function getPlayerByTelegramId(telegramId) {
  return db.queryOne('SELECT id, character_name FROM players WHERE telegram_id = ?', [telegramId]);
}

async function loadPlayerCards(playerId) {
  const identity = await db.queryOne('SELECT * FROM identity_cards WHERE player_id = ?', [playerId]);
  if (!identity) return null;
  const playCards   = await db.query('SELECT * FROM play_cards   WHERE player_id = ?', [playerId]);
  const weaponCards = await db.query('SELECT * FROM weapon_cards WHERE player_id = ?', [playerId]);
  const skillCards  = await db.query('SELECT * FROM skill_cards  WHERE player_id = ?', [playerId]);
  return { identity, playCards, weaponCards, skillCards };
}

// Returns card from DB only if it belongs to telegramId
async function getPlayerCard(telegramId, cardId) {
  const join = 'JOIN players p ON p.id = TABLENAME.player_id WHERE TABLENAME.card_id = ? AND p.telegram_id = ?';
  if (cardId.startsWith('PLC-')) return db.queryOne(`SELECT pc.* FROM play_cards   pc ${join.replace(/TABLENAME/g,'pc')}`, [cardId, telegramId]);
  if (cardId.startsWith('WPN-')) return db.queryOne(`SELECT wc.* FROM weapon_cards wc ${join.replace(/TABLENAME/g,'wc')}`, [cardId, telegramId]);
  if (cardId.startsWith('SKL-')) return db.queryOne(`SELECT sc.* FROM skill_cards  sc ${join.replace(/TABLENAME/g,'sc')}`, [cardId, telegramId]);
  return null;
}

// ─── Player state factory ──────────────────────────────────────────────────────
function buildPlayerState(telegramId, playerId, name) {
  return {
    telegramId,
    playerId,
    name,
    identityCard: null,
    currentHp: 0,
    playCards: [],
    weaponCards: [],
    skillCards: [],
    usedCards: new Set(),
    effects: [],
    sentIdentity: false
  };
}

// ─── State query helpers ───────────────────────────────────────────────────────
function hasPendingChallenge(chatId)  { return pendingChallenges.has(chatId); }
function getPendingChallenge(chatId)  { return pendingChallenges.get(chatId) || null; }
function hasFight(chatId)             { return fights.has(chatId); }
function getFight(chatId)             { return fights.get(chatId) || null; }

function fightParticipants(fight) {
  return Object.keys(fight.players).map(id => parseInt(id, 10));
}

function isFightParticipant(fight, telegramId) {
  return Boolean(fight && fight.players[telegramId]);
}

function isChallengeParticipant(challenge, telegramId) {
  return Boolean(
    challenge &&
    (challenge.challengerId === telegramId || challenge.opponentId === telegramId)
  );
}

function getOtherPlayerId(fight, telegramId) {
  return fightParticipants(fight).find(id => id !== parseInt(telegramId, 10));
}

// ─── Timer helpers ─────────────────────────────────────────────────────────────
function clearRequestTimer(chatId) {
  if (!requestTimers.has(chatId)) return;
  clearTimeout(requestTimers.get(chatId));
  requestTimers.delete(chatId);
}

function deletePendingChallenge(chatId) {
  clearRequestTimer(chatId);
  pendingChallenges.delete(chatId);
}

function clearFightTimer(chatId) {
  if (!fightTimers.has(chatId)) return;
  clearTimeout(fightTimers.get(chatId));
  fightTimers.delete(chatId);
}

// ─── Message helpers ───────────────────────────────────────────────────────────
async function replaceChatMessage(bot, chatId, messageId, text) {
  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] }
    });
    return;
  } catch (err) {
    const message = err?.message || '';
    if (!message.includes('message is not modified')) {
      try { await bot.sendMessage(chatId, text); } catch {}
    }
  }
}

async function replaceChallengeMessage(bot, challenge, text) {
  await replaceChatMessage(bot, challenge.chatId, challenge.requestMessageId, text);
}

// ─── Busy check ───────────────────────────────────────────────────────────────
function findBusyContextByParticipant(telegramId) {
  for (const challenge of pendingChallenges.values()) {
    if (isChallengeParticipant(challenge, telegramId)) {
      return { type: 'challenge', chatId: challenge.chatId };
    }
  }
  for (const fight of fights.values()) {
    if (isFightParticipant(fight, telegramId)) {
      return { type: 'fight', chatId: fight.chatId };
    }
  }
  return null;
}

// ─── TTL timers ───────────────────────────────────────────────────────────────
function setChallengeTimer(bot, challenge) {
  clearRequestTimer(challenge.chatId);
  const timerId = setTimeout(async () => {
    const current = pendingChallenges.get(challenge.chatId);
    if (!current) return;
    deletePendingChallenge(challenge.chatId);
    await replaceChallengeMessage(
      bot, current,
      `⌛ تحدي Friendly PvP بين ${current.challengerName} و${current.opponentName} انتهى بسبب عدم الرد.`
    );
  }, REQUEST_TTL);
  requestTimers.set(challenge.chatId, timerId);
}

function setFightTimer(bot, chatId) {
  clearFightTimer(chatId);
  const timerId = setTimeout(async () => {
    const fight = fights.get(chatId);
    if (!fight) return;

    // Determine staller based on current fight status
    let stallerId = null;
    if (fight.status === 'initiative_waiting_other') {
      stallerId = fight.reactivePlayerId; // active already sent IDC, reactive is stalling
    } else if (fight.status === 'active_turn') {
      stallerId = fight.activePlayerId;
    } else if (fight.status === 'chain_response') {
      stallerId = fight.chainResponderId;
    }

    // No identifiable staller — cancel normally
    if (!stallerId) {
      cancelFight(chatId);
      try {
        await bot.sendMessage(chatId, '⌛ انتهت مهلة Friendly PvP بسبب عدم النشاط. تم إنهاء النزال تلقائياً.');
      } catch {}
      return;
    }

    // Staller identified — award win by timeout
    const winnerId = getOtherPlayerId(fight, stallerId);
    const winner   = fight.players[winnerId];
    const loser    = fight.players[stallerId];

    try {
      await bot.sendMessage(chatId,
        [
          '⌛ *انتهت المهلة! \\(3 دقيقة\\)*',
          `😴 *${escapeMarkdown(loser.name)}* تقاعس ولم يتحرك في الوقت المحدد\\.`,
          `🏆 *${escapeMarkdown(winner.name)}* فاز بـ *Timeout Forfeit*\\!`
        ].join('\n'),
        { parse_mode: 'MarkdownV2' }
      );
    } catch {}

    try {
      await db.query('UPDATE players SET wins   = wins   + 1 WHERE telegram_id = ?', [winner.telegramId]);
      await db.query('UPDATE players SET losses = losses + 1 WHERE telegram_id = ?', [loser.telegramId]);
      await applyPvPWinBonus(bot, chatId, winner, loser);
    } catch {}

    _endFight(chatId);
  }, FIGHT_TTL);
  fightTimers.set(chatId, timerId);
}

// ─── Cancel helpers (used externally by cancel.js) ────────────────────────────
function cancelPendingChallenge(chatId) {
  const challenge = pendingChallenges.get(chatId) || null;
  deletePendingChallenge(chatId);
  return challenge;
}

function cancelFight(chatId) {
  const fight = fights.get(chatId) || null;
  if (!fight) return null;
  clearFightTimer(chatId);
  for (const telegramId of fightParticipants(fight)) {
    session.clearSession(telegramId);
  }
  fights.delete(chatId);
  return fight;
}

// -----------------------------------------------------------------------------
// Unified Combat Flow
// -----------------------------------------------------------------------------

function hpLine(fight) {
  const ids = fightParticipants(fight);
  return ids
    .map(id => `❤️ ${fight.players[id].name}: *${fight.players[id].currentHp}*`)
    .join('  |  ');
}

function getCardTypeLabel(card) {
  const kind = combatEngine.getCardKind(card);

  if (kind === 'attack') return 'Attack';
  if (kind === 'defense') return 'Defense';
  if (kind === 'support') return 'Support';

  if (kind === 'skill') {
    const skillType = combatEngine.getSkillProfile(card)?.type;
    const labels = {
      reflect: 'Reflect',
      negate: 'Negate',
      almighty: 'Almighty',
      stun: 'Stun',
      poison: 'Poison',
      weapon_buff: 'Weapon Buff'
    };

    return labels[skillType] || 'Skill';
  }

  return 'Card';
}

function createChainEntry(fight, playerId, card) {
  return {
    playerId,
    playerName: fight.players[playerId]?.name || 'Player',
    role: playerId === fight.activePlayerId ? 'active' : 'reactive',
    card,
    kind: combatEngine.getCardKind(card),
    createdAt: Date.now()
  };
}

function getChainEntryCaption(entry) {
  if (!entry?.card) return null;
  const actionLabel = entry.role === 'active' ? 'لعب' : 'رد بـ';
  return `🎴 *${escapeMarkdown(entry.playerName)}* ${actionLabel}: *${escapeMarkdown(entry.card.name)}* (\`${entry.card.card_id}\`)`;
}

function getChainSummary(fight) {
  const chain = Array.isArray(fight.turnChain) ? fight.turnChain : [];

  if (chain.length === 0) {
    return '_The chain is empty._';
  }

  return chain
    .map((entry, index) =>
      `${index + 1}. [${entry.playerName}] used *${entry.card.name}* (${getCardTypeLabel(entry.card)})`
    )
    .join('\n');
}

function getThreatDescription(fight) {
  const chain = Array.isArray(fight.turnChain) ? fight.turnChain : [];
  const lastEntry = chain[chain.length - 1];

  if (!lastEntry) {
    return '⚠️ *Threat:* No pending threat.';
  }

  const opponentRole = lastEntry.role === 'active' ? 'reactive' : 'active';
  const opponentId = opponentRole === 'active' ? fight.activePlayerId : fight.reactivePlayerId;
  const opponentName = fight.players[opponentId]?.name || 'the opponent';
  const skill = combatEngine.getSkillProfile(lastEntry.card);

  if (lastEntry.kind === 'attack') {
    const damage = (Number(lastEntry.card.atk) || 0) + (Number(lastEntry.card.magic) || 0);
    return `⚠️ *Threat:* ${lastEntry.playerName}'s *${lastEntry.card.name}* will deal *${damage} HP* to *${opponentName}* if it is not countered.`;
  }

  if (lastEntry.kind === 'skill') {
    switch (skill?.type) {
      case 'reflect':
        return `⚠️ *Threat:* ${lastEntry.playerName}'s *${lastEntry.card.name}* will reflect the previous attack or harmful skill if it is strong enough.`;
      case 'negate':
        return `⚠️ *Threat:* ${lastEntry.playerName}'s *${lastEntry.card.name}* will negate the previous attack or skill if it is strong enough, then cleanse its caster.`;
      case 'almighty':
        return `⚠️ *Threat:* ${lastEntry.playerName}'s *${lastEntry.card.name}* will overpower the previous attack or skill if it is strong enough, then cleanse its caster.`;
      case 'stun':
        return `⚠️ *Threat:* ${lastEntry.playerName}'s *${lastEntry.card.name}* will stun *${opponentName}* and make them lose their next turn if it resolves.`;
      case 'poison':
        return `⚠️ *Threat:* ${lastEntry.playerName}'s *${lastEntry.card.name}* will poison *${opponentName}* if it resolves.`;
      case 'weapon_buff':
        return `⚠️ *Threat:* ${lastEntry.playerName}'s *${lastEntry.card.name}* will activate a weapon buff if it resolves.`;
      default:
        return `⚠️ *Threat:* ${lastEntry.playerName}'s *${lastEntry.card.name}* will resolve next if nobody counters it.`;
    }
  }

  if (lastEntry.kind === 'defense') {
    return `⚠️ *Threat:* ${lastEntry.playerName}'s *${lastEntry.card.name}* is the latest defensive play in the stack.`;
  }

  if (lastEntry.kind === 'support') {
    return `⚠️ *Threat:* ${lastEntry.playerName}'s *${lastEntry.card.name}* is the latest support play in the stack.`;
  }

  return `⚠️ *Threat:* ${lastEntry.playerName}'s *${lastEntry.card.name}* will resolve next if nobody counters it.`;
}

// ─── End fight (natural win/lose) ─────────────────────────────────────────────
function _endFight(chatId) {
  clearFightTimer(chatId);
  const fight = fights.get(chatId);
  if (fight) {
    for (const telegramId of fightParticipants(fight)) {
      session.clearSession(telegramId);
    }
  }
  fights.delete(chatId);
}

// ─── PvP win bonus ────────────────────────────────────────────────────────────
function _calcPower(identityCard) {
  return (
    (identityCard.hp        || 0) +
    (identityCard.atk       || 0) +
    (identityCard.magic     || 0) +
    (identityCard.def       || 0) +
    (identityCard.spd       || 0) +
    (identityCard.accuracy  || 0)
  );
}

function _getPvPBonus(powerDiff) {
  if (powerDiff >= 2000)             return { points: 200, label: '💪 الخصم كان أقوى بكثير' };
  if (powerDiff > 0)                 return { points: 100, label: '⚔️ الخصم كان أقوى قليلاً' };
  if (powerDiff > -2000)             return { points: 50,  label: '⚖️ الخصم كان بنفس مستواك تقريباً' };
  /* powerDiff <= -2000 */           return { points: 20,  label: '🐣 الخصم كان أضعف بكثير' };
}

async function applyPvPWinBonus(bot, chatId, winnerState, loserState) {
  const winnerPower = _calcPower(winnerState.identityCard);
  const loserPower  = _calcPower(loserState.identityCard);
  const powerDiff   = loserPower - winnerPower;

  const { points, label } = _getPvPBonus(powerDiff);
  const playerId = winnerState.playerId;

  await db.query(
    `UPDATE identity_cards
        SET hp=hp+?,
            atk=atk+?,
            available_atk=available_atk+?,
            magic=magic+?,
            available_magic=available_magic+?,
            def=def+?,
            available_def=available_def+?,
            spd=spd+?,
            available_spd=available_spd+?,
            accuracy=accuracy+?,
            available_accuracy=available_accuracy+?
      WHERE player_id=?`,
    [points, points, points, points, points, points, points, points, points, points, points, playerId]
  );
  await db.query(
    'UPDATE play_cards SET atk=atk+?,magic=magic+?,def=def+?,accuracy=accuracy+?,spd=spd+? WHERE player_id=?',
    [points, points, points, points, points, playerId]
  );
  await db.query(
    `UPDATE weapon_cards SET atk=atk+?,magic=magic+?,def=def+?,accuracy=accuracy+?,spd=spd+?
     WHERE player_id=? AND weapon_type='normal'`,
    [points, points, points, points, points, playerId]
  );

  await bot.sendMessage(chatId,
    [
      `🎉 *مكافأة الفوز في PvP!*`,
      `${label}`,
      `⬆️ جميع إحصائياتك ارتفعت *+${points}* نقطة!`
    ].join('\n'),
    { parse_mode: 'Markdown' }
  );
}

// ─── Win check ────────────────────────────────────────────────────────────────
async function checkWin(bot, chatId, fight) {
  const players = fightParticipants(fight).map(id => fight.players[id]);
  const dead    = players.filter(p => p.currentHp <= 0);

  if (dead.length === 0) return false;

  if (dead.length >= 2) {
    await bot.sendMessage(chatId,
      `🤝 *تعادل!* كلا اللاعبين وصلا إلى 0 HP في نفس الوقت!`,
      { parse_mode: 'Markdown' }
    );
  } else {
    const winner = players.find(p => p.currentHp > 0);
    const loser  = dead[0];
    await bot.sendMessage(chatId,
      `🏆 *${winner.name} فاز!*\n💀 ${loser.name} هُزم!\n❤️ HP المتبقي: *${winner.currentHp}*`,
      { parse_mode: 'Markdown' }
    );
    await db.query('UPDATE players SET wins   = wins   + 1 WHERE telegram_id = ?', [winner.telegramId]);
    await db.query('UPDATE players SET losses = losses + 1 WHERE telegram_id = ?', [loser.telegramId]);
    await db.query('UPDATE players SET rank_points = rank_points + 30 WHERE telegram_id = ?', [winner.telegramId]);
    await db.query('UPDATE players SET rank_points = GREATEST(0, rank_points - 20) WHERE telegram_id = ?', [loser.telegramId]);
    await applyPvPWinBonus(bot, chatId, winner, loser);
  }

  _endFight(chatId);
  return true;
}

// ─── Start combat (called once after initiative is decided) ───────────────────

// -----------------------------------------------------------------------------
// Unified Combat Engine overrides
// -----------------------------------------------------------------------------

async function sendCombatLines(bot, chatId, lines) {
  const payload = (lines || []).filter(Boolean);
  if (payload.length === 0) return;
  await bot.sendMessage(chatId, payload.join('\n'), { parse_mode: 'Markdown' });
}

async function promptChainResponse(bot, chatId, fight) {
  const responder = fight.players[fight.chainResponderId];
  if (!responder) return true;

  fight.status = 'chain_response';

  const latestEntry = Array.isArray(fight.turnChain)
    ? fight.turnChain[fight.turnChain.length - 1]
    : null;

  if (latestEntry?.card) {
    await sendCardVisual(bot, chatId, latestEntry.card, getChainEntryCaption(latestEntry));
  }

  await sendCombatLines(bot, chatId, [
    '📊 *Battle Update*',
    hpLine(fight),
    '',
    '⛓️ *Current Chain:*',
    getChainSummary(fight),
    '',
    getThreatDescription(fight),
    '',
    `👉 *${responder.name}*, do you want to respond with a *Skill* to counter this, or *Pass*?`,
    'Send a Skill card (`SKL-XXXXX`) or type `skip`.'
  ]);

  return true;
}

async function promptActiveTurn(bot, chatId, fight, { showIntro = false } = {}) {
  const active = fight.players[fight.activePlayerId];
  const reactive = fight.players[fight.reactivePlayerId];

  fight.status = 'processing';
  fight.pendingActiveCard = null;
  fight.turnChain = [];
  fight.chainResponderId = null;

  if (showIntro) {
    await sendCombatLines(bot, chatId, [
      `🥊 *Round ${fight.round} — النزال يبدأ!*`,
      `⚡ Active: ${active.name}   ❤️ ${active.currentHp}`,
      `🛡️ Reactive: ${reactive.name}   ❤️ ${reactive.currentHp}`
    ]);
  }

  const turnStart = combatEngine.processTurnStart(active, { playerName: active.name });
  await sendCombatLines(bot, chatId, turnStart.summaryLines);

  if (await checkWin(bot, chatId, fight)) return true;

  if (turnStart.skipTurn) {
    await sleep(800);
    await nextRound(bot, chatId, fight);
    return true;
  }

  fight.status = 'active_turn';
  await sendCombatLines(bot, chatId, [
    `⚔️ *Round ${fight.round}* — ${active.name}، دورك!`,
    `صيفط بطاقة (PLC / WPN / SKL):`
  ]);
  return true;
}

async function sendResolution(bot, chatId, fight, resolution) {
  await sendCombatLines(bot, chatId, [
    `📊 *نتيجة Round ${fight.round}:*`,
    ...(resolution.summaryLines.length > 0 ? resolution.summaryLines : ['ℹ️ لم يحدث أي تأثير مباشر.']),
    '',
    hpLine(fight)
  ]);
}

async function startCombat(bot, chatId, fight) {
  fight.status = 'processing';
  fight.round = 1;
  fight.pendingActiveCard = null;
  fight.turnChain = [];
  fight.chainResponderId = null;
  await promptActiveTurn(bot, chatId, fight, { showIntro: true });
}

async function handleActiveTurn(bot, chatId, fight, telegramId, cardId) {
  const activePlayer = fight.players[telegramId];
  const reactiveId = getOtherPlayerId(fight, telegramId);
  const reactivePlayer = fight.players[reactiveId];

  if (!cardId) {
    await bot.sendMessage(chatId, `❌ ${activePlayer.name}: صيفط بطاقة صالحة (PLC / WPN / SKL).`);
    return true;
  }

  const card = await getPlayerCard(telegramId, cardId);
  if (!card) {
    await bot.sendMessage(chatId, '❌ البطاقة غير موجودة أو ليست لك.');
    return true;
  }

  if (activePlayer.usedCards.has(cardId)) {
    await bot.sendMessage(chatId, '❌ هذه البطاقة استُخدمت مسبقاً.');
    return true;
  }

  activePlayer.usedCards.add(cardId);
  fight.pendingActiveCard = card;
  fight.turnChain = [createChainEntry(fight, telegramId, card)];
  fight.chainResponderId = reactiveId;

  return promptChainResponse(bot, chatId, fight);
}

async function handleChainResponse(bot, chatId, fight, telegramId, cardId, rawText) {
  const respondingPlayer = fight.players[telegramId];
  const activePlayer = fight.players[fight.activePlayerId];
  const reactivePlayer = fight.players[fight.reactivePlayerId];
  const normalizedText = String(rawText || '').trim().toLowerCase();

  if (!Array.isArray(fight.turnChain) || fight.turnChain.length === 0) {
    fight.status = 'active_turn';
    fight.chainResponderId = null;
    await bot.sendMessage(chatId, 'ℹ️ The chain was empty, so the active player can play again.');
    return true;
  }

  if (CHAIN_SKIP_WORDS.has(normalizedText)) {
    fight.status = 'processing';

    await sendCombatLines(bot, chatId, [
      `⏭️ *${respondingPlayer.name}* passed.`,
      'Resolving the chain...'
    ]);

    const resolution = combatEngine.resolveChain(
      fight.turnChain,
      activePlayer,
      reactivePlayer,
      {
        activeName: activePlayer.name,
        reactiveName: reactivePlayer.name
      }
    );

    fight.pendingActiveCard = null;
    fight.turnChain = [];
    fight.chainResponderId = null;

    await sendResolution(bot, chatId, fight, resolution);

    if (await checkWin(bot, chatId, fight)) return true;

    await sleep(800);
    await nextRound(bot, chatId, fight);
    return true;
  }

  if (!cardId) {
    await bot.sendMessage(chatId, `❌ ${respondingPlayer.name}: send a Skill card (\`SKL-XXXXX\`) or type \`skip\`.`, {
      parse_mode: 'Markdown'
    });
    return true;
  }

  const card = await getPlayerCard(telegramId, cardId);
  if (!card) {
    await bot.sendMessage(chatId, '❌ البطاقة غير موجودة أو ليست لك.');
    return true;
  }

  if (combatEngine.getCardKind(card) !== 'skill') {
    await bot.sendMessage(chatId, '❌ During a chain response, only Skill cards are allowed. Type `skip` to pass.', {
      parse_mode: 'Markdown'
    });
    return true;
  }

  if (respondingPlayer.usedCards.has(cardId)) {
    await bot.sendMessage(chatId, '❌ هذه البطاقة استُخدمت مسبقاً.');
    return true;
  }

  respondingPlayer.usedCards.add(cardId);
  fight.turnChain.push(createChainEntry(fight, telegramId, card));
  fight.chainResponderId = getOtherPlayerId(fight, telegramId);

  return promptChainResponse(bot, chatId, fight);
}

async function nextRound(bot, chatId, fight) {
  fight.pendingActiveCard = null;
  fight.turnChain = [];
  fight.chainResponderId = null;
  fight.round += 1;

  const previousActive = fight.activePlayerId;
  fight.activePlayerId = fight.reactivePlayerId;
  fight.reactivePlayerId = previousActive;

  await promptActiveTurn(bot, chatId, fight);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 1 — Challenge & Acceptance
// ═══════════════════════════════════════════════════════════════════════════════

async function startFriendlyChallenge(bot, { chatId, challengerUser, opponentUser }) {
  const challengerId = challengerUser.id;
  const opponentId   = opponentUser?.id;

  if (!opponentUser || !opponentId) {
    return bot.sendMessage(chatId,
      '❌ باش تبدا Friendly PvP، دير $fight كردّ على message ديال اللاعب اللي بغيتي تتحداه، ومن بعد اختار Friendly.'
    );
  }

  if (opponentUser.is_bot)        return bot.sendMessage(chatId, '❌ Friendly PvP كيتخدم غير بين جوج لاعبين، ماشي ضد bot.');
  if (challengerId === opponentId) return bot.sendMessage(chatId, '❌ ما تقدرش تتحدى راسك.');

  if (hasPendingChallenge(chatId) || hasFight(chatId)) {
    return bot.sendMessage(chatId, '❌ كاين بالفعل Friendly PvP challenge أو fight خدام فهاد الشات.');
  }

  if (session.hasActiveSession(challengerId) || session.hasActiveSession(opponentId)) {
    return bot.sendMessage(chatId,
      '❌ واحد من اللاعبين عندو عملية جارية دابا. ساليوها أولاً بـ $cancel ومن بعد عاودو المحاولة.'
    );
  }

  if (findBusyContextByParticipant(challengerId) || findBusyContextByParticipant(opponentId)) {
    return bot.sendMessage(chatId, '❌ واحد من اللاعبين راه داخل already فـ Friendly PvP آخر.');
  }

  const challengerPlayer = await getPlayerByTelegramId(challengerId);
  if (!challengerPlayer) {
    return bot.sendMessage(chatId, '❌ خاصك تدير $login قبل ما تبدا Friendly PvP.');
  }

  const opponentPlayer = await getPlayerByTelegramId(opponentId);
  if (!opponentPlayer) {
    const opponentName = getDisplayName(opponentUser, 'هاد اللاعب');
    return bot.sendMessage(chatId, `❌ ${opponentName} مازال ما مسجلش. خاصو يدير $login الأول.`);
  }

  const challenge = {
    chatId,
    challengerId,
    challengerPlayerId: challengerPlayer.id,
    challengerName: challengerPlayer.character_name || getDisplayName(challengerUser, 'Player A'),
    opponentId,
    opponentPlayerId: opponentPlayer.id,
    opponentName: opponentPlayer.character_name || getDisplayName(opponentUser, 'Player B'),
    requestMessageId: null,
    createdAt: Date.now()
  };

  const requestMessage = await bot.sendMessage(chatId,
    [
      '⚔️ Friendly PvP Challenge!',
      `${challenge.challengerName} تحدّى ${challenge.opponentName}.`,
      '',
      `${challenge.opponentName}، واش كتقبل التحدي؟`,
      'الطلب كيسالي تلقائياً بعد 60 ثانية.'
    ].join('\n'),
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Accept',  callback_data: `pvp_accept_${challenge.opponentId}`  },
          { text: '❌ Decline', callback_data: `pvp_decline_${challenge.opponentId}` }
        ]]
      }
    }
  );

  challenge.requestMessageId = requestMessage.message_id;
  pendingChallenges.set(chatId, challenge);
  setChallengeTimer(bot, challenge);
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 2 — Initiative Race
// ═══════════════════════════════════════════════════════════════════════════════

async function startInitiative(bot, challenge) {
  if (session.hasActiveSession(challenge.challengerId) || session.hasActiveSession(challenge.opponentId)) {
    await bot.sendMessage(challenge.chatId,
      '❌ ما قدرتش نبدا Friendly PvP حيت شي لاعب بدا session أخرى قبل ما نبداو.'
    );
    return false;
  }

  const fight = {
    chatId: challenge.chatId,
    status: 'countdown',
    round: 0,
    activePlayerId: null,
    reactivePlayerId: null,
    pendingActiveCard: null,
    turnChain: [],
    chainResponderId: null,
    createdAt: Date.now(),
    players: {
      [challenge.challengerId]: buildPlayerState(
        challenge.challengerId,
        challenge.challengerPlayerId,
        challenge.challengerName
      ),
      [challenge.opponentId]: buildPlayerState(
        challenge.opponentId,
        challenge.opponentPlayerId,
        challenge.opponentName
      )
    }
  };

  fights.set(challenge.chatId, fight);
  setFightTimer(bot, challenge.chatId);

  session.setSession(challenge.challengerId, 'pvp_fight', 'initiative', { chatId: challenge.chatId });
  session.setSession(challenge.opponentId,   'pvp_fight', 'initiative', { chatId: challenge.chatId });

  await bot.sendMessage(challenge.chatId,
    `⚡ Friendly PvP بين ${challenge.challengerName} و${challenge.opponentName} غادي يبدا دابا!`
  );

  for (const count of ['3...', '2...', '1...']) {
    if (!fights.has(challenge.chatId)) return false;
    await bot.sendMessage(challenge.chatId, count);
    await sleep(800);
  }

  const currentFight = fights.get(challenge.chatId);
  if (!currentFight) return false;

  currentFight.status = 'initiative_race';
  await bot.sendMessage(challenge.chatId,
    [
      '📤 صيفطو دابا Identity Card ديالكم.',
      'الصيغة: IDC-XXXXX',
      'أول واحد يصيفط IDC صحيح غادي ياخذ initiative ويولي Active Player.'
    ].join('\n')
  );

  return true;
}

// ─── Accept / Decline callback ────────────────────────────────────────────────
async function handlePvpCallback(bot, query) {
  const match = query.data.match(/^pvp_(accept|decline)_(\d+)$/);
  if (!match) return false;

  const [, action, rawTargetId] = match;
  const chatId   = query.message.chat.id;
  const actorId  = query.from.id;
  const targetId = parseInt(rawTargetId, 10);
  const challenge = getPendingChallenge(chatId);

  if (!challenge) return false;
  if (challenge.opponentId !== targetId) return false;
  if (actorId !== challenge.opponentId)  return false;

  deletePendingChallenge(chatId);

  if (action === 'decline') {
    await replaceChallengeMessage(bot, challenge,
      `❌ ${challenge.opponentName} رفض Friendly PvP challenge ديال ${challenge.challengerName}.`
    );
    return true;
  }

  await replaceChallengeMessage(bot, challenge,
    `✅ ${challenge.opponentName} قبل Friendly PvP challenge ديال ${challenge.challengerName}.`
  );

  await startInitiative(bot, challenge);
  return true;
}

// ─── Initiative: verify and lock IDC ─────────────────────────────────────────
function getOtherParticipantId(fight, telegramId) {
  return fightParticipants(fight).find(id => id !== telegramId) || null;
}

async function loadAndLockIdentityCard(telegramId, playerId, cardId) {
  const row = await db.queryOne(
    `SELECT ic.* FROM identity_cards ic
     JOIN players p ON p.id = ic.player_id
     WHERE ic.card_id = ? AND p.telegram_id = ?`,
    [cardId, telegramId]
  );
  if (!row) return null;
  const cards = await loadPlayerCards(playerId);
  if (!cards || !cards.identity) return null;
  return cards;
}

async function handleInitiativeCard(bot, chatId, fight, telegramId, cardId) {
  const player = fight.players[telegramId];
  if (!player) return false;

  if (player.sentIdentity) {
    await bot.sendMessage(chatId, `ℹ️ ${player.name} صيفط IDC ديالو already. كنتسناو اللاعب الآخر.`);
    return true;
  }

  const cards = await loadAndLockIdentityCard(telegramId, player.playerId, cardId);
  if (!cards || cards.identity.card_id !== cardId) {
    await bot.sendMessage(chatId, '❌ هاد IDC ماشي ديالك أو غير صالح. صيفط Identity Card صحيحة ديالك.');
    return true;
  }

  player.identityCard = cards.identity;
  player.currentHp    = cards.identity.hp;
  player.playCards    = cards.playCards;
  player.weaponCards  = cards.weaponCards;
  player.skillCards   = cards.skillCards;
  player.usedCards    = new Set();
  player.effects      = [];
  player.sentIdentity = true;

  // First to submit → becomes Active Player
  if (!fight.activePlayerId) {
    const reactiveId     = getOtherParticipantId(fight, telegramId);
    fight.activePlayerId   = telegramId;
    fight.reactivePlayerId = reactiveId;
    fight.status           = 'initiative_waiting_other';

    const reactivePlayer = fight.players[reactiveId];
    await bot.sendMessage(chatId,
      [
        `⚡ ${player.name} صيفط IDC أولاً!`,
        `${player.name} ولى Active Player.`,
        `${reactivePlayer.name}، دابا دورك صيفط IDC ديالك باش نكملو setup.`
      ].join('\n')
    );
    return true;
  }

  // Already first was set — this is the second player
  if (fight.activePlayerId === telegramId) {
    await bot.sendMessage(chatId, `ℹ️ ${player.name} راه خذا initiative déjà. كنتسناو اللاعب الآخر.`);
    return true;
  }

  // Both submitted — announce and start combat
  const activePlayer   = fight.players[fight.activePlayerId];
  const reactivePlayer = fight.players[fight.reactivePlayerId];

  await bot.sendMessage(chatId,
    [
      '⚔️ *Initiative تحدد بنجاح!*',
      `⚡ Active:   ${activePlayer.name}   ❤️ ${activePlayer.currentHp}`,
      `🛡️ Reactive: ${reactivePlayer.name}  ❤️ ${reactivePlayer.currentHp}`,
      '',
      `🎴 ${activePlayer.name}: \`${activePlayer.identityCard.card_id}\` — ${activePlayer.identityCard.name}`,
      `🎴 ${reactivePlayer.name}: \`${reactivePlayer.identityCard.card_id}\` — ${reactivePlayer.identityCard.name}`,
    ].join('\n'),
    { parse_mode: 'Markdown' }
  );

  await sleep(800);
  await startCombat(bot, chatId, fight);
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MESSAGE ROUTER  (called from bot.js session handler)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleFightMessage(bot, msg, cardId) {
  const chatId     = msg.chat.id;
  const telegramId = msg.from.id;
  const fight      = fights.get(chatId);
  const rawText    = (msg.text || msg.caption || '').trim();

  if (!fight) return false;
  if (!isFightParticipant(fight, telegramId)) return false;

  setFightTimer(bot, chatId);

  // ── Countdown: too early ───────────────────────────────────────────────────
  if (fight.status === 'countdown') {
    await bot.sendMessage(chatId, '⏳ تسناو حتى يكمل countdown، ومن بعد صيفطو IDC.');
    return true;
  }

  // ── Initiative phase ───────────────────────────────────────────────────────
  if (['initiative_race', 'initiative_waiting_other'].includes(fight.status)) {
    if (!cardId || !cardId.startsWith('IDC-')) {
      await bot.sendMessage(chatId, '📤 صيفط Identity Card ديالك بصيغة IDC-XXXXX باش نحدد initiative.');
      return true;
    }
    return handleInitiativeCard(bot, chatId, fight, telegramId, cardId);
  }

  // ── Active player's turn ───────────────────────────────────────────────────
  if (fight.status === 'active_turn') {
    if (telegramId !== fight.activePlayerId) {
      // Wrong player — soft ignore (don't delete, just no response)
      return true;
    }
    return handleActiveTurn(bot, chatId, fight, telegramId, cardId);
  }

  // ── Chain response ─────────────────────────────────────────────────────────
  if (fight.status === 'chain_response') {
    if (telegramId !== fight.chainResponderId) {
      return true;
    }
    return handleChainResponse(bot, chatId, fight, telegramId, cardId, rawText);
  }

  if (fight.status === 'reactive_turn') {
    fight.status = 'chain_response';
    fight.chainResponderId = fight.chainResponderId || fight.reactivePlayerId;

    if (telegramId !== fight.chainResponderId) {
      return true;
    }

    return handleChainResponse(bot, chatId, fight, telegramId, cardId, rawText);
  }

  // ── Still resolving ────────────────────────────────────────────────────────
  if (fight.status === 'processing') {
    return true;
  }

  return true;
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  startFriendlyChallenge,
  handlePvpCallback,
  handleFightMessage,
  hasPendingChallenge,
  getPendingChallenge,
  cancelPendingChallenge,
  hasFight,
  getFight,
  cancelFight,
  isFightParticipant,
  isChallengeParticipant
};