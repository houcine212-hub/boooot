'use strict';

const db           = require('../db/connection');
const session      = require('../middleware/sessionManager');
const combatEngine = require('../utils/CombatEngine');
const { sendCardVisual, escapeMarkdown } = require('../utils/cardVisuals');
const shop         = require('../utils/shopSystem');
const crafting     = require('../utils/craftingEngine');

const REQUEST_TTL      = 60 * 1000;        // challenge accept window
const STAKES_TTL       = 2 * 60 * 1000;    // challenger stakes input window
const FIGHT_TTL        = 3 * 60 * 1000;    // per-turn inactivity timeout
const STUN_NEGATE_TTL  = 30 * 1000;        // window to negate a stun
const CHAIN_SKIP_WORDS = new Set(['skip', 'pass']);

// ── State ──────────────────────────────────────────────────────────────────────
const pendingChallenges = new Map();  // chatId        → challenge
const pendingStakes     = new Map();  // challengerTid → challenge
const fights            = new Map();  // chatId        → fight

const requestTimers  = new Map();     // chatId        → timeout handle
const stakesTimers   = new Map();     // challengerTid → timeout handle
const fightTimers    = new Map();     // chatId        → timeout handle
const stunTimers     = new Map();     // chatId        → timeout handle

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── Display helpers ────────────────────────────────────────────────────────────
function getDisplayName(user, fallback = 'Player') {
  const parts = [user?.first_name, user?.last_name].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  if (user?.username) return `@${user.username}`;
  return fallback;
}

// ── DB helpers ─────────────────────────────────────────────────────────────────
async function getPlayerByTelegramId(telegramId) {
  return db.queryOne('SELECT id, character_name, mg_balance FROM players WHERE telegram_id = ?', [telegramId]);
}

async function loadPlayerCards(playerId) {
  const identity = await db.queryOne('SELECT * FROM identity_cards WHERE player_id = ?', [playerId]);
  if (!identity) return null;
  const playCards   = await db.query('SELECT * FROM play_cards   WHERE player_id = ?', [playerId]);
  const weaponCards = await db.query('SELECT * FROM weapon_cards WHERE player_id = ?', [playerId]);
  const skillCards  = await db.query('SELECT * FROM skill_cards  WHERE player_id = ?', [playerId]);
  return { identity, playCards, weaponCards, skillCards };
}

async function getPlayerCard(telegramId, cardId) {
  const join = 'JOIN players p ON p.id = TABLENAME.player_id WHERE TABLENAME.card_id = ? AND p.telegram_id = ?';
  if (cardId.startsWith('PLC-')) return db.queryOne(`SELECT pc.* FROM play_cards   pc ${join.replace(/TABLENAME/g, 'pc')}`, [cardId, telegramId]);
  if (cardId.startsWith('WPN-')) return db.queryOne(`SELECT wc.* FROM weapon_cards wc ${join.replace(/TABLENAME/g, 'wc')}`, [cardId, telegramId]);
  if (cardId.startsWith('SKL-')) return db.queryOne(`SELECT sc.* FROM skill_cards  sc ${join.replace(/TABLENAME/g, 'sc')}`, [cardId, telegramId]);
  return null;
}

// ── Stakes parser ──────────────────────────────────────────────────────────────
function parseStakes(text) {
  const parts = text.split('|').map(s => s.trim()).filter(Boolean);
  let mg = 0;
  const items = [];
  for (const part of parts) {
    const mgMatch = part.match(/^(\d+)\s+MG$/i);
    if (mgMatch) { mg += parseInt(mgMatch[1], 10); continue; }
    const itemMatch = part.match(/^(\d+)\s+(.+)$/);
    if (itemMatch) items.push({ qty: parseInt(itemMatch[1], 10), name: itemMatch[2].trim() });
  }
  return (mg === 0 && items.length === 0) ? null : { mg, items };
}

function formatStakes(stakes) {
  const parts = [];
  if (stakes.mg > 0) parts.push(`${stakes.mg} MG`);
  for (const { qty, name } of stakes.items) parts.push(`x${qty} ${name}`);
  return parts.join(' | ');
}

// ── Stakes validation ──────────────────────────────────────────────────────────
async function validatePlayerHasStakes(playerId, stakes) {
  const errors = [];
  if (stakes.mg > 0) {
    const player = await db.queryOne('SELECT mg_balance FROM players WHERE id = ? LIMIT 1', [playerId]);
    if (!player || player.mg_balance < stakes.mg) errors.push(`يحتاج ${stakes.mg} MG`);
  }
  for (const { qty, name } of stakes.items) {
    const shopItem = await db.queryOne('SELECT id, is_crafting_resource FROM shop_items WHERE name = ? LIMIT 1', [name]);
    if (!shopItem) { errors.push(`العنصر "${name}" غير معروف`); continue; }
    let owned = 0;
    if (shopItem.is_crafting_resource) {
      const row = await db.queryOne('SELECT quantity FROM player_resources WHERE player_id = ? AND resource_type = ? LIMIT 1', [playerId, name]);
      owned = row ? row.quantity : 0;
    } else {
      const row = await db.queryOne('SELECT quantity FROM player_inventory WHERE player_id = ? AND item_id = ? LIMIT 1', [playerId, shopItem.id]);
      owned = row ? row.quantity : 0;
    }
    if (owned < qty) errors.push(`يحتاج x${qty} ${name} (يملك ${owned})`);
  }
  return errors;
}

// ── State helpers ──────────────────────────────────────────────────────────────
function hasFight(chatId)               { return fights.has(chatId); }
function getFight(chatId)               { return fights.get(chatId) || null; }
function fightParticipants(fight)       { return Object.keys(fight.players).map(id => parseInt(id, 10)); }
function isFightParticipant(fight, tid) { return Boolean(fight && fight.players[tid]); }
function alivePlayers(fight)            { return fightParticipants(fight).filter(id => fight.players[id].alive); }

function getOtherPlayerId(fight, telegramId) {
  return fightParticipants(fight).find(id => id !== parseInt(telegramId, 10));
}

function areAllied(fight, idA, idB) {
  if (!fight.alliances) return false;
  const key = allianceKey(idA, idB);
  return fight.alliances.has(key);
}

function allianceKey(idA, idB) {
  return [idA, idB].map(Number).sort().join(':');
}

function buildPlayerState(telegramId, playerId, name) {
  return {
    telegramId, playerId, name,
    identityCard: null, currentHp: 0,
    playCards: [], weaponCards: [], skillCards: [],
    usedCards: new Set(), effects: [], sentIdentity: false,
    alive: true,
    pendingAllianceWith: null,   // tid of the player this one proposed alliance to
  };
}

// ── Timer helpers ──────────────────────────────────────────────────────────────
function clearRequestTimer(chatId) {
  if (!requestTimers.has(chatId)) return;
  clearTimeout(requestTimers.get(chatId)); requestTimers.delete(chatId);
}

function clearStakesTimer(challengerTid) {
  if (!stakesTimers.has(challengerTid)) return;
  clearTimeout(stakesTimers.get(challengerTid)); stakesTimers.delete(challengerTid);
}

function clearFightTimer(chatId) {
  if (!fightTimers.has(chatId)) return;
  clearTimeout(fightTimers.get(chatId)); fightTimers.delete(chatId);
}

function clearStunTimer(chatId) {
  if (!stunTimers.has(chatId)) return;
  clearTimeout(stunTimers.get(chatId)); stunTimers.delete(chatId);
}

function deletePendingChallenge(chatId) {
  clearRequestTimer(chatId);
  pendingChallenges.delete(chatId);
}

function _endFight(chatId) {
  clearFightTimer(chatId);
  clearStunTimer(chatId);
  const fight = fights.get(chatId);
  if (fight) {
    for (const tid of fightParticipants(fight)) session.clearSession(tid);
  }
  fights.delete(chatId);
}

// ── Eliminate a player mid-fight (No Mercy) ───────────────────────────────────
/**
 * Marks a player as eliminated, adds their stake to the pool,
 * and resolves the fight if only one player remains.
 * Returns true if the fight ended.
 */
async function eliminatePlayer(bot, chatId, fight, eliminatedTid, reason) {
  const eliminated = fight.players[eliminatedTid];
  if (!eliminated || !eliminated.alive) return false;

  eliminated.alive = false;
  session.clearSession(eliminatedTid);

  // Add their stake to the pool
  if (fight.stakes && (fight.stakes.mg > 0 || fight.stakes.items.length > 0)) {
    fight.pool = fight.pool || [];
    fight.pool.push({ playerId: eliminated.playerId, stakes: fight.stakes });
  }

  await bot.sendMessage(chatId,
    `[ SYSTEM ] *${escapeMarkdown(eliminated.name)}* خرج من النزال — No Mercy!\n${reason}`,
    { parse_mode: 'Markdown' }
  );

  const remaining = alivePlayers(fight);
  if (remaining.length === 1) {
    await resolveLootWin(bot, chatId, fight.players[remaining[0]], eliminated, 'آخر لاعب واقف');
    return true;
  }
  if (remaining.length === 0) {
    await bot.sendMessage(chatId, 'تعادل! كل اللاعبين خرجو. لا رهان ينقل.', { parse_mode: 'Markdown' });
    _endFight(chatId);
    return true;
  }
  return false;
}

// ── Win/loss resolution ────────────────────────────────────────────────────────
async function resolveLootWin(bot, chatId, winnerState, loserState, reason) {
  const fight  = fights.get(chatId);
  const stakes = fight?.stakes;

  let stakeMsg = '';
  if (stakes && (stakes.mg > 0 || stakes.items.length > 0)) {
    try {
      // Transfer direct stakes
      await shop.transferStakes(winnerState.playerId, loserState.playerId, stakes);
      stakeMsg = `\nالرهان انتقل: ${formatStakes(stakes)} -> *${escapeMarkdown(winnerState.name)}*`;

      // Transfer any pooled stakes from eliminated players
      if (fight.pool && fight.pool.length > 0) {
        for (const entry of fight.pool) {
          if (entry.playerId === winnerState.playerId) continue;
          await shop.transferStakesFromPool(winnerState.playerId, entry.playerId, entry.stakes).catch(() => {});
        }
        stakeMsg += `\nالمجمع من اللاعبين المحذوفين انتقل ايضا لـ *${escapeMarkdown(winnerState.name)}*`;
      }
    } catch (err) {
      console.error('[lootPvp] transferStakes error:', err.message);
      stakeMsg = '\nفشل نقل الرهان — راجع المشرف.';
    }
  }

  const pvpDrops = await crafting.getCombatLoot('loot_pvp').catch(() => []);
  let pvpLootMsg = '';
  if (pvpDrops.length > 0) {
    await crafting.awardCombatLoot(winnerState.playerId, pvpDrops).catch(() => {});
    const lootLines = pvpDrops.map(d => `  ${d.emoji} ${d.display_name} x${d.qty}`).join('\n');
    pvpLootMsg = `\n\n\`\`\`text\n[ EXTRA LOOT ]\n${lootLines}\n\`\`\``;
  }

  try {
    await bot.sendMessage(chatId,
      [
        `[ SYSTEM ] *نزال النهب انتهى!*`,
        reason,
        `*${escapeMarkdown(winnerState.name)}* فاز!`,
        `*${escapeMarkdown(loserState.name)}* خسر!${stakeMsg}${pvpLootMsg}`,
      ].join('\n'),
      { parse_mode: 'Markdown' }
    );
  } catch {}

  try {
    await db.query('UPDATE players SET wins   = wins   + 1 WHERE telegram_id = ?', [winnerState.telegramId]);
    await db.query('UPDATE players SET losses = losses + 1 WHERE telegram_id = ?', [loserState.telegramId]);
  } catch {}

  _endFight(chatId);
}

// ── Win check ──────────────────────────────────────────────────────────────────
async function checkWin(bot, chatId, fight) {
  const players = fightParticipants(fight).map(id => fight.players[id]);
  const dead    = players.filter(p => p.currentHp <= 0 && p.alive);
  if (dead.length === 0) return false;

  for (const loser of dead) loser.alive = false;

  const alive = players.filter(p => p.alive);

  if (alive.length === 0) {
    await bot.sendMessage(chatId,
      'تعادل! كلا اللاعبين وصلا 0 HP. لا رهان ينقل.',
      { parse_mode: 'Markdown' }
    );
    _endFight(chatId);
    return true;
  }

  const winner = alive[0];
  const loser  = dead[0];
  await resolveLootWin(bot, chatId, winner, loser, `HP المتبقي للفائز: *${winner.currentHp}*`);
  return true;
}

// ── Inactivity timeout (No Mercy) ─────────────────────────────────────────────
function setFightTimer(bot, chatId) {
  clearFightTimer(chatId);
  const timerId = setTimeout(async () => {
    const fight = fights.get(chatId);
    if (!fight) return;

    let stallerId = null;
    if (fight.status === 'initiative_waiting_other') stallerId = fight.reactivePlayerId;
    else if (fight.status === 'active_turn')         stallerId = fight.activePlayerId;
    else if (fight.status === 'targeting')           stallerId = fight.activePlayerId;
    else if (fight.status === 'chain_response')      stallerId = fight.chainResponderId;

    if (!stallerId) {
      _endFight(chatId);
      try { await bot.sendMessage(chatId, 'انتهت مهلة نزال النهب بسبب عدم النشاط.'); } catch {}
      return;
    }

    const staller = fight.players[stallerId];
    const ended   = await eliminatePlayer(bot, chatId, fight, stallerId,
      `انتهت المهلة (3 دقائق) — *${escapeMarkdown(staller.name)}* تقاعس.`
    );
    if (!ended) {
      // Fight continues with next alive player
      const remaining = alivePlayers(fight);
      if (remaining.length >= 2) {
        fight.activePlayerId   = remaining[0];
        fight.reactivePlayerId = remaining[1];
        await promptTargeting(bot, chatId, fight);
      }
    }
  }, FIGHT_TTL);
  fightTimers.set(chatId, timerId);
}

// ── Cancel (called from cancel.js) ────────────────────────────────────────────
async function cancelLootFight(bot, chatId, cancellerTelegramId) {
  const fight = fights.get(chatId);
  if (!fight) return null;

  if (isFightParticipant(fight, cancellerTelegramId)) {
    clearStunTimer(chatId);
    const ended = await eliminatePlayer(bot, chatId, fight, cancellerTelegramId,
      `*${escapeMarkdown(fight.players[cancellerTelegramId].name)}* ألغى النزال — No Mercy!`
    );
    if (!ended) {
      const remaining = alivePlayers(fight);
      if (remaining.length >= 2) {
        fight.activePlayerId   = remaining[0];
        fight.reactivePlayerId = remaining[1];
        await promptTargeting(bot, chatId, fight);
      }
    }
  } else {
    _endFight(chatId);
  }
  return fight;
}

function cancelLootPendingChallenge(chatId) {
  const challenge = pendingChallenges.get(chatId) || null;
  deletePendingChallenge(chatId);
  return challenge;
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 1 — Challenge
// ══════════════════════════════════════════════════════════════════════════════

async function startLootChallenge(bot, { chatId, challengerUser, opponentUser }) {
  const challengerId = challengerUser.id;
  const opponentId   = opponentUser?.id;

  if (!opponentUser || !opponentId) {
    return bot.sendMessage(chatId,
      'باش تبدا نزال النهب، دير $fight كردّ على message ديال اللاعب اللي بغيتي تتحداه، ومن بعد اختار نزال النهب.'
    );
  }
  if (opponentUser.is_bot)         return bot.sendMessage(chatId, 'نزال النهب كيتخدم غير بين جوج لاعبين.');
  if (challengerId === opponentId) return bot.sendMessage(chatId, 'ما تقدرش تتحدى راسك.');

  if (pendingChallenges.has(chatId) || fights.has(chatId)) {
    return bot.sendMessage(chatId, 'كاين بالفعل نزال خدام فهاد الشات. تسنّى حتى يسالي.');
  }

  if (session.hasActiveSession(challengerId) || session.hasActiveSession(opponentId)) {
    return bot.sendMessage(chatId,
      'واحد من اللاعبين عندو عملية جارية دابا. ساليوها بـ $cancel ومن بعد عاودو المحاولة.'
    );
  }

  const challengerPlayer = await getPlayerByTelegramId(challengerId);
  if (!challengerPlayer) return bot.sendMessage(chatId, 'خاصك تدير $login قبل ما تبدا نزال النهب.');

  const opponentPlayer = await getPlayerByTelegramId(opponentId);
  if (!opponentPlayer) {
    return bot.sendMessage(chatId,
      `${getDisplayName(opponentUser, 'الخصم')} مازال ما مسجلش. خاصو يدير $login الأول.`
    );
  }

  const challenge = {
    chatId,
    challengerId,
    challengerPlayerId: challengerPlayer.id,
    challengerName: challengerPlayer.character_name || getDisplayName(challengerUser, 'Player A'),
    opponentId,
    opponentPlayerId: opponentPlayer.id,
    opponentName: opponentPlayer.character_name || getDisplayName(opponentUser, 'Player B'),
    stakes: null,
    requestMessageId: null,
    createdAt: Date.now(),
  };

  const msg = await bot.sendMessage(chatId,
    [
      '[ SYSTEM ] *تحدي نزال النهب!*',
      `${challenge.challengerName} تحدّى ${challenge.opponentName} على الرهان.`,
      '',
      `${challenge.opponentName}، واش كتقبل التحدي؟`,
      'الطلب كيسالي تلقائياً بعد 60 ثانية.',
    ].join('\n'),
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: 'قبول',  callback_data: `loot_accept_${opponentId}`  },
          { text: 'رفض',   callback_data: `loot_decline_${opponentId}` },
        ]]
      }
    }
  );

  challenge.requestMessageId = msg.message_id;
  pendingChallenges.set(chatId, challenge);

  const timerId = setTimeout(async () => {
    const current = pendingChallenges.get(chatId);
    if (!current || current.createdAt !== challenge.createdAt) return;
    deletePendingChallenge(chatId);
    try {
      await bot.editMessageText(
        `تحدي نزال النهب بين ${challenge.challengerName} و${challenge.opponentName} انتهى بسبب عدم الرد.`,
        { chat_id: chatId, message_id: challenge.requestMessageId, reply_markup: { inline_keyboard: [] } }
      );
    } catch {}
  }, REQUEST_TTL);
  requestTimers.set(chatId, timerId);

  return true;
}

// ── Accept / Decline callback ──────────────────────────────────────────────────
async function handleLootCallback(bot, query) {
  const { data, message, from } = query;
  const chatId  = message.chat.id;
  const actorId = from.id;

  // Accept / Decline
  const acceptMatch = data.match(/^loot_(accept|decline)_(\d+)$/);
  if (acceptMatch) {
    const [, action, rawTargetId] = acceptMatch;
    const targetId  = parseInt(rawTargetId, 10);
    const challenge = pendingChallenges.get(chatId);
    if (!challenge) return false;
    if (challenge.opponentId !== targetId) return false;
    if (actorId !== challenge.opponentId)  return false;

    deletePendingChallenge(chatId);
    const editText = async (text) => {
      try {
        await bot.editMessageText(text, {
          chat_id: chatId, message_id: challenge.requestMessageId, reply_markup: { inline_keyboard: [] }
        });
      } catch {}
    };

    if (action === 'decline') {
      await editText(`${challenge.opponentName} رفض تحدي نزال النهب ديال ${challenge.challengerName}.`);
      return true;
    }

    await editText(`${challenge.opponentName} قبل تحدي نزال النهب ديال ${challenge.challengerName}!`);

    pendingStakes.set(challenge.challengerId, challenge);
    session.setSession(challenge.challengerId, 'awaiting_stakes', 'input', { chatId });

    const timerId = setTimeout(() => {
      if (!pendingStakes.has(challenge.challengerId)) return;
      pendingStakes.delete(challenge.challengerId);
      clearStakesTimer(challenge.challengerId);
      session.clearSession(challenge.challengerId);
      bot.sendMessage(chatId,
        `${challenge.challengerName} لم يحدد الرهان في الوقت المحدد. تم إلغاء نزال النهب.`
      ).catch(() => {});
    }, STAKES_TTL);
    stakesTimers.set(challenge.challengerId, timerId);

    await bot.sendMessage(chatId,
      [
        `[ SYSTEM ] ${challenge.challengerName}، حدد الرهان الذي سيخسره *كلا اللاعبين* عند الهزيمة.`,
        '',
        'الصيغة: `1000 MG | 2 خام الحديد | 1 سيف الفجر`',
        '_(يمكنك وضع MG فقط، عناصر فقط، أو مزيج منهما)_',
        '',
        'أرسل `$cancel` لإلغاء النزال.',
      ].join('\n'),
      { parse_mode: 'Markdown' }
    );
    return true;
  }

  // ── Target selection ──────────────────────────────────────────────────────
  // loot_target_<targetTid>
  const targetMatch = data.match(/^loot_target_(\d+)$/);
  if (targetMatch) {
    return handleTargetSelection(bot, query, parseInt(targetMatch[1], 10));
  }

  // ── Chain reaction buttons ────────────────────────────────────────────────
  // loot_react_<action>_<reactorTid>   action: defend | negate | reflect | pass
  const reactMatch = data.match(/^loot_react_(defend|negate|reflect|pass)_(\d+)$/);
  if (reactMatch) {
    return handleReactButton(bot, query, reactMatch[1], parseInt(reactMatch[2], 10));
  }

  // ── Reflect redirect target ───────────────────────────────────────────────
  // loot_reflect_to_<victimTid>_<reactorTid>
  const reflectMatch = data.match(/^loot_reflect_to_(\d+)_(\d+)$/);
  if (reflectMatch) {
    return handleReflectTarget(bot, query, parseInt(reflectMatch[1], 10), parseInt(reflectMatch[2], 10));
  }

  // ── Alliance callbacks ────────────────────────────────────────────────────
  // loot_ally_propose_<proposerTid>_<targetTid>
  const proposeMatch = data.match(/^loot_ally_propose_(\d+)_(\d+)$/);
  if (proposeMatch) {
    return handleAlliancePropose(bot, query, parseInt(proposeMatch[1], 10), parseInt(proposeMatch[2], 10));
  }

  // loot_ally_respond_<accept|decline>_<proposerTid>_<targetTid>
  const respondMatch = data.match(/^loot_ally_respond_(accept|decline)_(\d+)_(\d+)$/);
  if (respondMatch) {
    return handleAllianceRespond(bot, query, respondMatch[1], parseInt(respondMatch[2], 10), parseInt(respondMatch[3], 10));
  }

  // loot_ally_break_<breakerTid>_<partnerTid>
  const breakMatch = data.match(/^loot_ally_break_(\d+)_(\d+)$/);
  if (breakMatch) {
    return handleAllianceBreak(bot, query, parseInt(breakMatch[1], 10), parseInt(breakMatch[2], 10));
  }

  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 2 — Stakes Input
// ══════════════════════════════════════════════════════════════════════════════

async function handleStakesInput(bot, msg) {
  const telegramId = msg.from.id;
  const chatId     = msg.chat.id;
  const text       = (msg.text || '').trim();

  const challenge = pendingStakes.get(telegramId);
  if (!challenge) { session.clearSession(telegramId); return; }

  const stakes = parseStakes(text);
  if (!stakes) {
    return bot.sendMessage(chatId,
      'صيغة الرهان غير صحيحة.\nمثال: `1000 MG | 2 خام الحديد`\nأو أرسل `$cancel` لإلغاء النزال.',
      { parse_mode: 'Markdown' }
    );
  }

  const [challengerErrors, opponentErrors] = await Promise.all([
    validatePlayerHasStakes(challenge.challengerPlayerId, stakes),
    validatePlayerHasStakes(challenge.opponentPlayerId, stakes),
  ]);

  const allErrors = [];
  if (challengerErrors.length > 0) allErrors.push(`*${escapeMarkdown(challenge.challengerName)}*: ${challengerErrors.join(', ')}`);
  if (opponentErrors.length > 0)   allErrors.push(`*${escapeMarkdown(challenge.opponentName)}*: ${opponentErrors.join(', ')}`);

  if (allErrors.length > 0) {
    return bot.sendMessage(chatId,
      ['الرهان غير ممكن — أحد اللاعبين لا يملك ما يكفي:', ...allErrors].join('\n'),
      { parse_mode: 'Markdown' }
    );
  }

  clearStakesTimer(telegramId);
  pendingStakes.delete(telegramId);
  session.clearSession(telegramId);

  challenge.stakes = stakes;

  await bot.sendMessage(chatId,
    `[ SYSTEM ] الرهان تحدد: *${formatStakes(stakes)}*\nكلا اللاعبين سيخسران هذا الرهان عند الهزيمة.`,
    { parse_mode: 'Markdown' }
  );

  await startInitiative(bot, challenge);
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 3 — Initiative Race
// ══════════════════════════════════════════════════════════════════════════════

async function startInitiative(bot, challenge) {
  const fight = {
    chatId: challenge.chatId,
    status: 'countdown',
    round: 0,
    activePlayerId: null,
    reactivePlayerId: null,
    pendingActiveCard: null,
    turnChain: [],
    chainResponderId: null,
    stakes: challenge.stakes,
    pool: [],
    alliances: new Set(),
    createdAt: Date.now(),
    currentTargetId: null,       // who the active player chose to attack this turn
    players: {
      [challenge.challengerId]: buildPlayerState(challenge.challengerId, challenge.challengerPlayerId, challenge.challengerName),
      [challenge.opponentId]:   buildPlayerState(challenge.opponentId,   challenge.opponentPlayerId,   challenge.opponentName),
    },
  };

  fights.set(challenge.chatId, fight);
  setFightTimer(bot, challenge.chatId);

  session.setSession(challenge.challengerId, 'loot_fight', 'initiative', { chatId: challenge.chatId });
  session.setSession(challenge.opponentId,   'loot_fight', 'initiative', { chatId: challenge.chatId });

  await bot.sendMessage(challenge.chatId,
    `نزال النهب بين ${challenge.challengerName} و${challenge.opponentName} غادي يبدا دابا!`
  );

  for (const count of ['3...', '2...', '1...']) {
    if (!fights.has(challenge.chatId)) return false;
    await bot.sendMessage(challenge.chatId, count);
    await sleep(800);
  }

  if (!fights.has(challenge.chatId)) return false;

  fights.get(challenge.chatId).status = 'initiative_race';
  await bot.sendMessage(challenge.chatId,
    [
      'صيفطو دابا Identity Card ديالكم.',
      'الصيغة: IDC-XXXXX',
      'أول واحد يصيفط IDC صحيح غادي ياخذ initiative ويولي Active Player.',
    ].join('\n')
  );
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 4 — Initiative Card Handling
// ══════════════════════════════════════════════════════════════════════════════

async function loadAndLockIdentityCard(telegramId, playerId, cardId) {
  const row = await db.queryOne(
    `SELECT ic.* FROM identity_cards ic
     JOIN players p ON p.id = ic.player_id
     WHERE ic.card_id = ? AND p.telegram_id = ?`,
    [cardId, telegramId]
  );
  if (!row) return null;
  return loadPlayerCards(playerId);
}

function getOtherParticipantId(fight, telegramId) {
  return fightParticipants(fight).find(id => id !== telegramId) || null;
}

async function handleInitiativeCard(bot, chatId, fight, telegramId, cardId) {
  const player = fight.players[telegramId];
  if (!player) return false;

  if (player.sentIdentity) {
    await bot.sendMessage(chatId, `${player.name} صيفط IDC ديالو already. كنتسناو اللاعب الآخر.`);
    return true;
  }

  const cards = await loadAndLockIdentityCard(telegramId, player.playerId, cardId);
  if (!cards || cards.identity.card_id !== cardId) {
    await bot.sendMessage(chatId, 'هاد IDC ماشي ديالك أو غير صالح. صيفط Identity Card صحيحة ديالك.');
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

  if (!fight.activePlayerId) {
    const reactiveId       = getOtherParticipantId(fight, telegramId);
    fight.activePlayerId   = telegramId;
    fight.reactivePlayerId = reactiveId;
    fight.status           = 'initiative_waiting_other';

    await bot.sendMessage(chatId,
      [
        `${player.name} صيفط IDC أولاً!`,
        `${player.name} ولى Active Player.`,
        `${fight.players[reactiveId].name}، دابا دورك صيفط IDC ديالك باش نكملو setup.`,
      ].join('\n')
    );
    return true;
  }

  if (fight.activePlayerId === telegramId) {
    await bot.sendMessage(chatId, `${player.name} راه خذا initiative déjà. كنتسناو اللاعب الآخر.`);
    return true;
  }

  const activePlayer   = fight.players[fight.activePlayerId];
  const reactivePlayer = fight.players[fight.reactivePlayerId];

  await bot.sendMessage(chatId,
    [
      '*Initiative تحدد بنجاح!*',
      `Active:   ${activePlayer.name}   HP ${activePlayer.currentHp}`,
      `Reactive: ${reactivePlayer.name}  HP ${reactivePlayer.currentHp}`,
      '',
      `${activePlayer.name}: \`${activePlayer.identityCard.card_id}\` — ${activePlayer.identityCard.name}`,
      `${reactivePlayer.name}: \`${reactivePlayer.identityCard.card_id}\` — ${reactivePlayer.identityCard.name}`,
    ].join('\n'),
    { parse_mode: 'Markdown' }
  );

  await sleep(800);
  await startCombat(bot, chatId, fight);
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 5 — Combat
// ══════════════════════════════════════════════════════════════════════════════

function hpLine(fight) {
  return fightParticipants(fight)
    .filter(id => fight.players[id].alive)
    .map(id => `HP ${fight.players[id].name}: *${fight.players[id].currentHp}*`)
    .join('  |  ');
}

function getCardTypeLabel(card) {
  const kind = combatEngine.getCardKind(card);
  if (kind === 'attack')  return 'Attack';
  if (kind === 'defense') return 'Defense';
  if (kind === 'support') return 'Support';
  if (kind === 'skill') {
    const labels = {
      reflect: 'Reflect', negate: 'Negate', almighty: 'Almighty',
      stun: 'Stun', poison: 'Poison', weapon_buff: 'Weapon Buff',
    };
    return labels[combatEngine.getSkillProfile(card)?.type] || 'Skill';
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
    createdAt: Date.now(),
  };
}

function getChainEntryCaption(entry) {
  if (!entry?.card) return null;
  const actionLabel = entry.role === 'active' ? 'لعب' : 'رد بـ';
  return `*${escapeMarkdown(entry.playerName)}* ${actionLabel}: *${escapeMarkdown(entry.card.name)}* (\`${entry.card.card_id}\`)`;
}

function getChainSummary(fight) {
  const chain = Array.isArray(fight.turnChain) ? fight.turnChain : [];
  if (chain.length === 0) return '_The chain is empty._';
  return chain
    .map((e, i) => `${i + 1}. [${e.playerName}] ${e.card.name} (${getCardTypeLabel(e.card)})`)
    .join('\n');
}

function getThreatDescription(fight) {
  const chain = Array.isArray(fight.turnChain) ? fight.turnChain : [];
  const last  = chain[chain.length - 1];
  if (!last) return 'Threat: لا يوجد.';

  const opRole = last.role === 'active' ? 'reactive' : 'active';
  const opId   = opRole === 'active' ? fight.activePlayerId : fight.reactivePlayerId;
  const opName = fight.players[opId]?.name || 'الخصم';
  const skill  = combatEngine.getSkillProfile(last.card);

  if (last.kind === 'attack') {
    const dmg = (Number(last.card.atk) || 0) + (Number(last.card.magic) || 0);
    return `Threat: ${last.playerName} — ${last.card.name} سيتسبب في *${dmg} HP* على *${opName}* إذا لم يُكافح.`;
  }
  if (last.kind === 'skill') {
    const map = {
      reflect:     `سيعكس الهجوم السابق.`,
      negate:      `سيلغي الهجوم أو المهارة السابقة.`,
      almighty:    `سيتغلب على الهجوم أو المهارة السابقة.`,
      stun:        `سيصعق *${opName}* ويجعله يخسر دوره التالي.`,
      poison:      `سيسمم *${opName}*.`,
      weapon_buff: `سيفعّل تعزيزاً للسلاح.`,
    };
    return `Threat: ${last.playerName} — ${last.card.name} ${map[skill?.type] || 'سيُفعَّل في المرحلة التالية.'}`;
  }
  return `Threat: ${last.playerName} — ${last.card.name} سيُفعَّل التالي.`;
}

async function sendCombatLines(bot, chatId, lines) {
  const payload = (lines || []).filter(Boolean);
  if (!payload.length) return;
  await bot.sendMessage(chatId, payload.join('\n'), { parse_mode: 'Markdown' });
}

// ── Targeting UI ───────────────────────────────────────────────────────────────
/**
 * Shows inline buttons for the active player to pick a target (alive opponents).
 * Also shows Alliance and Break Alliance buttons.
 */
async function promptTargeting(bot, chatId, fight) {
  const active  = fight.players[fight.activePlayerId];
  fight.status  = 'targeting';
  fight.currentTargetId = null;

  const aliveOpponents = alivePlayers(fight).filter(id => id !== fight.activePlayerId);
  const targetButtons  = aliveOpponents.map(tid => ({
    text: `Attack ${fight.players[tid].name}`,
    callback_data: `loot_target_${tid}`,
  }));

  // Alliance buttons
  const allianceButtons = [];
  for (const tid of aliveOpponents) {
    if (areAllied(fight, fight.activePlayerId, tid)) {
      allianceButtons.push({
        text: `Break Alliance with ${fight.players[tid].name}`,
        callback_data: `loot_ally_break_${fight.activePlayerId}_${tid}`,
      });
    } else {
      allianceButtons.push({
        text: `Propose Alliance to ${fight.players[tid].name}`,
        callback_data: `loot_ally_propose_${fight.activePlayerId}_${tid}`,
      });
    }
  }

  const keyboard = [
    targetButtons,
    allianceButtons,
  ].filter(row => row.length > 0);

  await bot.sendMessage(chatId,
    [
      `*Round ${fight.round} — ${active.name}، دورك!*`,
      hpLine(fight),
      '',
      'اختر هدفك:',
    ].join('\n'),
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard },
    }
  );
}

async function handleTargetSelection(bot, query, targetTid) {
  const chatId  = query.message.chat.id;
  const actorId = query.from.id;
  const fight   = fights.get(chatId);

  if (!fight || fight.status !== 'targeting') return false;
  if (actorId !== fight.activePlayerId) {
    return bot.sendMessage(chatId, 'غير دورك ماشي دابا.');
  }

  const target = fight.players[targetTid];
  if (!target || !target.alive) {
    return bot.sendMessage(chatId, 'هذا اللاعب ماشي موجود أو خرج من النزال.');
  }

  // Alliance check — cannot attack ally unless last two standing
  if (areAllied(fight, actorId, targetTid) && alivePlayers(fight).length > 2) {
    return bot.sendMessage(chatId,
      `مش ممكن تهاجم ${target.name} — عندكم حلف. كسّر الحلف أولاً إذا بغيتي تهاجمو.`
    );
  }

  fight.currentTargetId   = targetTid;
  fight.reactivePlayerId  = targetTid;
  fight.status            = 'active_turn';

  // Try to remove the targeting message buttons
  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: query.message.message_id
    });
  } catch {}

  await bot.sendMessage(chatId,
    `${fight.players[actorId].name} اختار ${target.name} كهدف!\nصيفط بطاقة هجوم (PLC / WPN / SKL):`,
    { parse_mode: 'Markdown' }
  );
  return true;
}

// ── Chain reaction buttons ─────────────────────────────────────────────────────
/**
 * After active player plays a card, send Defend/Negate/Reflect/Pass buttons
 * ONLY to the targeted player.
 */
async function promptReactionButtons(bot, chatId, fight) {
  const responder = fight.players[fight.chainResponderId];
  if (!responder) return promptChainResponse(bot, chatId, fight);

  fight.status = 'chain_response';

  const last = Array.isArray(fight.turnChain) ? fight.turnChain[fight.turnChain.length - 1] : null;
  if (last?.card) await sendCardVisual(bot, chatId, last.card, getChainEntryCaption(last));

  const tid = responder.telegramId;

  await bot.sendMessage(chatId,
    [
      '*Battle Update*',
      hpLine(fight),
      '',
      'Current Chain:',
      getChainSummary(fight),
      '',
      getThreatDescription(fight),
      '',
      `${responder.name}، كيف تردّ?`,
    ].join('\n'),
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Defend',  callback_data: `loot_react_defend_${tid}`  },
            { text: 'Negate',  callback_data: `loot_react_negate_${tid}`  },
            { text: 'Reflect', callback_data: `loot_react_reflect_${tid}` },
          ],
          [
            { text: 'Pass',    callback_data: `loot_react_pass_${tid}`    },
          ],
        ],
      },
    }
  );
  return true;
}

async function handleReactButton(bot, query, action, reactorTid) {
  const chatId  = query.message.chat.id;
  const actorId = query.from.id;
  const fight   = fights.get(chatId);

  if (!fight) return false;
  if (actorId !== reactorTid) {
    return bot.sendMessage(chatId, 'هاد الأزرار غير ديالك نتا.');
  }
  if (fight.chainResponderId !== actorId) {
    return bot.sendMessage(chatId, 'مش دورك في الرد.');
  }

  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: query.message.message_id
    });
  } catch {}

  if (action === 'pass') {
    return resolveChainAndNext(bot, chatId, fight);
  }

  if (action === 'reflect') {
    // Ask the reactor to pick a new victim (any other alive player)
    fight.status = 'choosing_reflect_target';
    const otherAlive = alivePlayers(fight).filter(id => id !== actorId);
    const buttons = otherAlive.map(tid => ({
      text: `${fight.players[tid].name}`,
      callback_data: `loot_reflect_to_${tid}_${actorId}`,
    }));
    await bot.sendMessage(chatId,
      `${fight.players[actorId].name}، اختار اللاعب اللي تعكس عليه الهجوم:`,
      { reply_markup: { inline_keyboard: [buttons] } }
    );
    return true;
  }

  // defend or negate — ask for a skill card via text
  await bot.sendMessage(chatId,
    `${fight.players[actorId].name}، صيفط بطاقة مهارة (SKL-XXXXX) للـ${action === 'defend' ? 'دفاع' : 'إلغاء'}, أو اكتب \`skip\` للتخطي.`,
    { parse_mode: 'Markdown' }
  );
  return true;
}

async function handleReflectTarget(bot, query, victimTid, reactorTid) {
  const chatId  = query.message.chat.id;
  const actorId = query.from.id;
  const fight   = fights.get(chatId);

  if (!fight) return false;
  if (actorId !== reactorTid) return false;

  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: query.message.message_id
    });
  } catch {}

  const newVictim = fight.players[victimTid];
  if (!newVictim || !newVictim.alive) {
    return bot.sendMessage(chatId, 'هذا اللاعب غير موجود أو خرج من النزال.');
  }

  // Redirect the pending attack to the new victim
  fight.currentTargetId  = victimTid;
  fight.reactivePlayerId = victimTid;
  fight.chainResponderId = victimTid;

  await bot.sendMessage(chatId,
    `${fight.players[reactorTid].name} عكس الهجوم على ${newVictim.name}!\n${newVictim.name}، يمكنك الرد بمهارة (SKL-XXXXX) أو اكتب \`skip\`.`,
    { parse_mode: 'Markdown' }
  );
  fight.status = 'chain_response';
  return true;
}

// ── Alliance System ────────────────────────────────────────────────────────────
async function handleAlliancePropose(bot, query, proposerTid, targetTid) {
  const chatId  = query.message.chat.id;
  const actorId = query.from.id;
  const fight   = fights.get(chatId);

  if (!fight) return false;
  if (actorId !== proposerTid) return false;
  if (actorId !== fight.activePlayerId) {
    return bot.sendMessage(chatId, 'اقتراح الحلف متاح فقط في دورك.');
  }

  const proposer = fight.players[proposerTid];
  const target   = fight.players[targetTid];
  if (!target || !target.alive) {
    return bot.sendMessage(chatId, 'هذا اللاعب غير موجود.');
  }

  if (areAllied(fight, proposerTid, targetTid)) {
    return bot.sendMessage(chatId, `أنتم بالفعل حلفاء مع ${target.name}.`);
  }

  // Store pending proposal on the proposer's state
  proposer.pendingAllianceWith = targetTid;

  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: query.message.message_id
    });
  } catch {}

  await bot.sendMessage(chatId,
    [
      `${proposer.name} يقترح حلفاً على ${target.name}!`,
      '',
      `${target.name}، هل تقبل؟`,
    ].join('\n'),
    {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Accept',  callback_data: `loot_ally_respond_accept_${proposerTid}_${targetTid}`  },
          { text: 'Decline', callback_data: `loot_ally_respond_decline_${proposerTid}_${targetTid}` },
        ]],
      }
    }
  );
  return true;
}

async function handleAllianceRespond(bot, query, response, proposerTid, targetTid) {
  const chatId  = query.message.chat.id;
  const actorId = query.from.id;
  const fight   = fights.get(chatId);

  if (!fight) return false;
  if (actorId !== targetTid) {
    return bot.sendMessage(chatId, 'هذا القرار ليس لك.');
  }

  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: query.message.message_id
    });
  } catch {}

  const proposer = fight.players[proposerTid];
  const target   = fight.players[targetTid];
  if (!proposer || !target) return false;

  if (response === 'decline') {
    proposer.pendingAllianceWith = null;
    await bot.sendMessage(chatId, `${target.name} رفض اقتراح الحلف من ${proposer.name}.`);
    // Resume targeting turn for the active player
    return promptTargeting(bot, chatId, fight);
  }

  // Accept
  fight.alliances.add(allianceKey(proposerTid, targetTid));
  proposer.pendingAllianceWith = null;

  await bot.sendMessage(chatId,
    `${proposer.name} و${target.name} دخلو في حلف! لن يتمكنا من مهاجمة بعضهما ما لم يبقيا فقط.`
  );

  // Resume targeting for active player (now restricted from attacking their ally)
  return promptTargeting(bot, chatId, fight);
}

async function handleAllianceBreak(bot, query, breakerTid, partnerTid) {
  const chatId  = query.message.chat.id;
  const actorId = query.from.id;
  const fight   = fights.get(chatId);

  if (!fight) return false;
  if (actorId !== breakerTid) return false;
  if (actorId !== fight.activePlayerId) {
    return bot.sendMessage(chatId, 'كسر الحلف متاح فقط في دورك.');
  }

  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: query.message.message_id
    });
  } catch {}

  const key = allianceKey(breakerTid, partnerTid);
  fight.alliances.delete(key);

  const breaker = fight.players[breakerTid];
  const partner = fight.players[partnerTid];

  await bot.sendMessage(chatId,
    `${breaker?.name} كسر الحلف مع ${partner?.name}! يمكنهما الآن مهاجمة بعضهما.`
  );

  return promptTargeting(bot, chatId, fight);
}

// ── Stun handling ──────────────────────────────────────────────────────────────
/**
 * When a player starts their turn while stunned, give them 30s to play a Negate card.
 * If they don't, skip their turn automatically.
 */
async function handleStunnedTurn(bot, chatId, fight) {
  const active = fight.players[fight.activePlayerId];
  fight.status = 'stun_negate_window';

  await bot.sendMessage(chatId,
    [
      `${active.name} مصعوق (Stun)!`,
      'لديك 30 ثانية لتقديم بطاقة Negate (SKL-XXXXX) لإلغاء التأثير، وإلا سيُتخطى دورك تلقائياً.',
    ].join('\n')
  );

  clearStunTimer(chatId);
  const timerId = setTimeout(async () => {
    const f = fights.get(chatId);
    if (!f || f.status !== 'stun_negate_window') return;

    await bot.sendMessage(chatId,
      `${active.name} لم يرد — دوره مُتخطى.`
    );
    await nextRound(bot, chatId, f);
  }, STUN_NEGATE_TTL);
  stunTimers.set(chatId, timerId);
}

// ── Turn prompt ────────────────────────────────────────────────────────────────
async function promptActiveTurn(bot, chatId, fight, { showIntro = false } = {}) {
  const active   = fight.players[fight.activePlayerId];
  const reactive = fight.players[fight.reactivePlayerId];

  fight.status = 'processing';
  fight.pendingActiveCard = null;
  fight.turnChain = [];
  fight.chainResponderId = null;
  fight.currentTargetId  = null;

  if (showIntro) {
    await sendCombatLines(bot, chatId, [
      `*Round ${fight.round} — النزال يبدأ!*`,
      `Active: ${active.name}   HP ${active.currentHp}`,
      `Reactive: ${reactive.name}   HP ${reactive.currentHp}`,
    ]);
  }

  const turnStart = combatEngine.processTurnStart(active, { playerName: active.name });
  await sendCombatLines(bot, chatId, turnStart.summaryLines);
  if (await checkWin(bot, chatId, fight)) return true;

  // Stun: skip or open negate window
  if (turnStart.skipTurn) {
    const isStunned = active.effects?.some(e => e.type === 'stun');
    if (isStunned) {
      await handleStunnedTurn(bot, chatId, fight);
      return true;
    }
    await sleep(800);
    await nextRound(bot, chatId, fight);
    return true;
  }

  // Show targeting UI
  await promptTargeting(bot, chatId, fight);
  return true;
}

async function sendResolution(bot, chatId, fight, resolution) {
  await sendCombatLines(bot, chatId, [
    `*نتيجة Round ${fight.round}:*`,
    ...(resolution.summaryLines.length > 0 ? resolution.summaryLines : ['لم يحدث أي تأثير مباشر.']),
    '',
    hpLine(fight),
  ]);
}

async function startCombat(bot, chatId, fight) {
  fight.status = 'processing';
  fight.round  = 1;
  fight.pendingActiveCard = null;
  fight.turnChain = [];
  fight.chainResponderId = null;
  await promptActiveTurn(bot, chatId, fight, { showIntro: true });
}

async function nextRound(bot, chatId, fight) {
  fight.pendingActiveCard = null;
  fight.turnChain = [];
  fight.chainResponderId = null;
  fight.currentTargetId  = null;
  fight.round += 1;

  const prev = fight.activePlayerId;
  fight.activePlayerId   = fight.reactivePlayerId;
  fight.reactivePlayerId = prev;

  await promptActiveTurn(bot, chatId, fight);
}

async function resolveChainAndNext(bot, chatId, fight) {
  const activePlayer   = fight.players[fight.activePlayerId];
  const reactivePlayer = fight.players[fight.reactivePlayerId];

  fight.status = 'processing';
  await sendCombatLines(bot, chatId, ['تخطّى. جارٍ حل السلسلة...']);

  const resolution = combatEngine.resolveChain(
    fight.turnChain, activePlayer, reactivePlayer,
    { activeName: activePlayer.name, reactiveName: reactivePlayer.name }
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

async function promptChainResponse(bot, chatId, fight) {
  // Use the reaction buttons UI instead of plain text
  return promptReactionButtons(bot, chatId, fight);
}

async function handleActiveTurn(bot, chatId, fight, telegramId, cardId) {
  const activePlayer = fight.players[telegramId];

  if (!cardId) {
    await bot.sendMessage(chatId, `${activePlayer.name}: صيفط بطاقة صالحة (PLC / WPN / SKL).`);
    return true;
  }

  const card = await getPlayerCard(telegramId, cardId);
  if (!card) { await bot.sendMessage(chatId, 'البطاقة غير موجودة أو ليست لك.'); return true; }
  if (activePlayer.usedCards.has(cardId)) { await bot.sendMessage(chatId, 'هذه البطاقة استُخدمت مسبقاً.'); return true; }

  activePlayer.usedCards.add(cardId);
  fight.pendingActiveCard = card;
  fight.turnChain = [createChainEntry(fight, telegramId, card)];
  fight.chainResponderId = fight.currentTargetId || fight.reactivePlayerId;

  return promptReactionButtons(bot, chatId, fight);
}

async function handleChainResponse(bot, chatId, fight, telegramId, cardId, rawText) {
  const respondingPlayer = fight.players[telegramId];
  const activePlayer     = fight.players[fight.activePlayerId];
  const reactivePlayer   = fight.players[fight.reactivePlayerId];
  const normalizedText   = String(rawText || '').trim().toLowerCase();

  if (!Array.isArray(fight.turnChain) || fight.turnChain.length === 0) {
    fight.status = 'active_turn';
    fight.chainResponderId = null;
    await bot.sendMessage(chatId, 'السلسلة كانت فارغة، يمكن للاعب النشط اللعب مجدداً.');
    return true;
  }

  if (CHAIN_SKIP_WORDS.has(normalizedText)) {
    return resolveChainAndNext(bot, chatId, fight);
  }

  if (!cardId) {
    await bot.sendMessage(chatId,
      `${respondingPlayer.name}: صيفط بطاقة مهارة (\`SKL-XXXXX\`) أو اكتب \`skip\`.`,
      { parse_mode: 'Markdown' }
    );
    return true;
  }

  const card = await getPlayerCard(telegramId, cardId);
  if (!card) { await bot.sendMessage(chatId, 'البطاقة غير موجودة أو ليست لك.'); return true; }
  if (combatEngine.getCardKind(card) !== 'skill') {
    await bot.sendMessage(chatId,
      'فقط بطاقات المهارة مسموح بها في الرد. اكتب `skip` للتخطي.',
      { parse_mode: 'Markdown' }
    );
    return true;
  }
  if (respondingPlayer.usedCards.has(cardId)) { await bot.sendMessage(chatId, 'هذه البطاقة استُخدمت مسبقاً.'); return true; }

  // If responding with a Negate during stun window, clear the stun timer
  const skillProfile = combatEngine.getSkillProfile(card);
  if (fight.status === 'stun_negate_window' && skillProfile?.type === 'negate') {
    clearStunTimer(chatId);
    fight.status = 'chain_response';
  }

  respondingPlayer.usedCards.add(cardId);
  fight.turnChain.push(createChainEntry(fight, telegramId, card));
  fight.chainResponderId = getOtherPlayerId(fight, telegramId);

  return promptReactionButtons(bot, chatId, fight);
}

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGE ROUTER
// ══════════════════════════════════════════════════════════════════════════════

async function handleFightMessage(bot, msg, cardId) {
  const chatId     = msg.chat.id;
  const telegramId = msg.from.id;
  const fight      = fights.get(chatId);
  const rawText    = (msg.text || msg.caption || '').trim();

  if (!fight) return false;
  if (!isFightParticipant(fight, telegramId)) return false;
  if (!fight.players[telegramId]?.alive) return false;

  setFightTimer(bot, chatId);

  if (fight.status === 'countdown') {
    await bot.sendMessage(chatId, 'تسناو حتى يكمل countdown، ومن بعد صيفطو IDC.');
    return true;
  }

  if (['initiative_race', 'initiative_waiting_other'].includes(fight.status)) {
    if (!cardId || !cardId.startsWith('IDC-')) {
      await bot.sendMessage(chatId, 'صيفط Identity Card ديالك بصيغة IDC-XXXXX باش نحدد initiative.');
      return true;
    }
    return handleInitiativeCard(bot, chatId, fight, telegramId, cardId);
  }

  // Stun negate window — only the stunned (active) player can respond
  if (fight.status === 'stun_negate_window') {
    if (telegramId !== fight.activePlayerId) return true;
    // Only a Negate SKL card is meaningful here; let handleChainResponse filter it
    return handleChainResponse(bot, chatId, fight, telegramId, cardId, rawText);
  }

  if (fight.status === 'targeting') {
    // Targeting is handled via inline buttons; ignore text
    return true;
  }

  if (fight.status === 'active_turn') {
    if (telegramId !== fight.activePlayerId) return true;
    return handleActiveTurn(bot, chatId, fight, telegramId, cardId);
  }

  if (fight.status === 'chain_response') {
    if (telegramId !== fight.chainResponderId) return true;
    return handleChainResponse(bot, chatId, fight, telegramId, cardId, rawText);
  }

  if (fight.status === 'reactive_turn') {
    fight.status = 'chain_response';
    fight.chainResponderId = fight.chainResponderId || fight.reactivePlayerId;
    if (telegramId !== fight.chainResponderId) return true;
    return handleChainResponse(bot, chatId, fight, telegramId, cardId, rawText);
  }

  if (fight.status === 'processing') return true;

  return true;
}

// ── Exports ────────────────────────────────────────────────────────────────────
module.exports = {
  startLootChallenge,
  handleLootCallback,
  handleStakesInput,
  handleFightMessage,
  cancelLootFight,
  cancelLootPendingChallenge,
  hasFight,
  getFight,
  isFightParticipant,
};