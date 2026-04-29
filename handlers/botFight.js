const db      = require('../db/connection');
const session = require('../middleware/sessionManager');
const combatEngine = require('../utils/CombatEngine');
const { sendCardVisual, escapeMarkdown } = require('../utils/cardVisuals');
const economy = require('../utils/economy');
const crafting = require('../utils/craftingEngine');
const storyEngine = require('../utils/storyEngine');

// Active fights: chatId -> fight state
const fights = new Map();
// Fight TTL timers: chatId -> timeoutId
const fightTimers = new Map();
const FIGHT_TTL = 3 * 60 * 1000; // 3 minutes

// ─── Internal: set/reset fight TTL ───────────────────────────────────────────
function _setFightTimer(bot, chatId) {
  if (fightTimers.has(chatId)) clearTimeout(fightTimers.get(chatId));
  const id = setTimeout(async () => {
    const fight = fights.get(chatId);
    if (!fight) return;
    fights.delete(chatId);
    fightTimers.delete(chatId);
    session.clearSession(fight.playerTelegramId);
    try {
      await bot.sendMessage(chatId, ' دازت 3 دقايق بلا حتى شي تفاعل. تم إنهاء النزال تلقائياً.');
    }
    catch {}
  }, FIGHT_TTL);
  fightTimers.set(chatId, id);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function hasFight(chatId)  { return fights.has(chatId); }
function getFight(chatId)  { return fights.get(chatId) || null; }

// ─── Load cards from DB ───────────────────────────────────────────────────────
async function loadBotCards(level) {
  const set = await db.queryOne('SELECT * FROM bot_card_sets WHERE level = ?', [level]);
  if (!set) return null;

  const identity = await db.queryOne('SELECT * FROM identity_cards WHERE card_id = ?', [set.identity_card_id]);
  const playCards   = await db.query(`SELECT pc.* FROM play_cards pc   JOIN bot_play_cards   b ON b.card_id = pc.card_id WHERE b.level = ?`, [level]);
  const weaponCards = await db.query(`SELECT wc.* FROM weapon_cards wc JOIN bot_weapon_cards  b ON b.card_id = wc.card_id WHERE b.level = ?`, [level]);
  const skillCards  = await db.query(`SELECT sc.* FROM skill_cards sc  JOIN bot_skill_cards   b ON b.card_id = sc.card_id WHERE b.level = ?`, [level]);

  return { identity, playCards, weaponCards, skillCards };
}

async function loadPlayerCards(playerId) {
  const identity    = await db.queryOne('SELECT * FROM identity_cards WHERE player_id = ?', [playerId]);
  if (!identity) return null;
  const playCards   = await db.query('SELECT * FROM play_cards   WHERE player_id = ?', [playerId]);
  const weaponCards = await db.query('SELECT * FROM weapon_cards WHERE player_id = ?', [playerId]);
  const skillCards  = await db.query('SELECT * FROM skill_cards  WHERE player_id = ?', [playerId]);
  return { identity, playCards, weaponCards, skillCards };
}

async function getPlayerCard(telegramId, cardId) {
  const join = 'JOIN players p ON p.id = TABLENAME.player_id WHERE TABLENAME.card_id = ? AND p.telegram_id = ?';
  if (cardId.startsWith('PLC-')) return db.queryOne(`SELECT pc.* FROM play_cards   pc ${join.replace(/TABLENAME/g,'pc')}`, [cardId, telegramId]);
  if (cardId.startsWith('WPN-')) return db.queryOne(`SELECT wc.* FROM weapon_cards wc ${join.replace(/TABLENAME/g,'wc')}`, [cardId, telegramId]);
  if (cardId.startsWith('SKL-')) return db.queryOne(`SELECT sc.* FROM skill_cards  sc ${join.replace(/TABLENAME/g,'sc')}`, [cardId, telegramId]);
  return null;
}

async function getPlayerBotLevel(playerId) {
  const row = await db.queryOne('SELECT unlocked_level FROM player_bot_progress WHERE player_id = ?', [playerId]);
  return row ? row.unlocked_level : 1;
}

function getMaxReplayableBotLevel(unlockedLevel) {
  return Math.max(0, Number.parseInt(unlockedLevel, 10) - 1);
}

function canReplayBotLevel(unlockedLevel, requestedLevel) {
  const level = Number.parseInt(requestedLevel, 10);
  if (Number.isNaN(level) || level < 1) return false;
  return level <= getMaxReplayableBotLevel(unlockedLevel);
}

// ─── Bot AI: choose attack card ───────────────────────────────────────────────
function chooseBotAttack(fight) {
  const bot = fight.bot;

  // Round 1 offensive → try stun first
  if (fight.round <= 1) {
    const stun = bot.skillCards.find(c => c.type === 'stun' && !bot.usedCards.has(c.card_id));
    if (stun) return stun;
  }

  // Best attack play card
  const atk = bot.playCards
    .filter(c => c.type === 'attack' && !bot.usedCards.has(c.card_id))
    .sort((a, b) => (b.atk || 0) - (a.atk || 0))[0];
  if (atk) return atk;

  // Best magic play card
  const magic = bot.playCards
    .filter(c => c.type === 'magic' && !bot.usedCards.has(c.card_id))
    .sort((a, b) => (b.magic || 0) - (a.magic || 0))[0];
  if (magic) return magic;

  // Offensive normal weapon
  const weapon = bot.weaponCards
    .filter(c => c.weapon_type === 'normal' && ['attack', 'magic'].includes(c.sub_type) && !bot.usedCards.has(c.card_id))
    .sort((a, b) => ((b.atk || 0) + (b.magic || 0)) - ((a.atk || 0) + (a.magic || 0)))[0];
  if (weapon) return weapon;

  // Anything left
  return [...bot.playCards, ...bot.weaponCards, ...bot.skillCards]
    .find(c => !bot.usedCards.has(c.card_id)) || null;
}

// ─── HP status line ───────────────────────────────────────────────────────────
function hpLine(fight) {
  return `❤️ ${escapeMarkdown(fight.player.name)}: *${fight.player.currentHp}*  |  ❤️ KimiBot: *${fight.bot.currentHp}*`;
}

// ─── Check win / lose ─────────────────────────────────────────────────────────
// ─── Check win / lose ─────────────────────────────────────────────────────────
async function checkWin(bot, chatId, fight) {
  // 1. حالة فوز اللاعب
  if (fight.bot.currentHp <= 0) {
    const idealReward = fight.botLevel * 50;
    const mgReward = await economy.rewardPlayerFromCity(
      fight.playerId, chatId, idealReward, 'فوز ضد KimiBot'
    );
    const mgLine = mgReward > 0
      ? `\n💰 مكافأة المدينة: +${mgReward} MG`
      : `\n⚠️ صندوق مدينتك فارغ، لم تحصل على مكافأة MG!`;

    // ── غنائم نزال النهب (Loot Drop) ──
    const lootSource = `bot_level_${fight.botLevel}`;
    const drops      = await crafting.getCombatLoot(lootSource);
    let lootMsg      = '';
    if (drops.length > 0) {
      await crafting.awardCombatLoot(fight.playerId, drops);
      const lootLines = drops.map(d => `  ${d.emoji} ${d.display_name} ×${d.qty}`).join('\n');
      lootMsg = `\n\n\`\`\`text\n[ LOOT DROP ]\n${lootLines}\n\`\`\``;
    }

    await bot.sendMessage(chatId,
      `🏆 *${escapeMarkdown(fight.player.name)} فاز!*\n💀 KimiBot هُزم!\n❤️ HP المتبقي: ${fight.player.currentHp}${mgLine}${lootMsg}`,
      { parse_mode: 'Markdown' }
    );

    await applyWinBonus(bot, chatId, fight);
    await db.query(
      'UPDATE players SET rank_points = rank_points + ? WHERE telegram_id = ?',
      [fight.botLevel * 10, fight.playerTelegramId]
    );

    _endFight(chatId, fight.playerTelegramId);
    return true;
  }

  // 2. حالة فوز البوت (خسارة اللاعب)
  if (fight.player.currentHp <= 0) {
    await bot.sendMessage(chatId,
      `💀 *KimiBot فاز!*\n❌ ${escapeMarkdown(fight.player.name)} هُزم! حاول مرة أخرى.`,
      { parse_mode: 'Markdown' }
    );
    await db.query('UPDATE players SET losses = losses + 1 WHERE telegram_id = ?', [fight.playerTelegramId]);
    await db.query('UPDATE players SET rank_points = GREATEST(0, rank_points - 15) WHERE telegram_id = ?', [fight.playerTelegramId]);
    
    _endFight(chatId, fight.playerTelegramId);
    return true;
  }

  return false;
}


// ─── Win bonus: +100 × level to all stats ────────────────────────────────────
async function applyWinBonus(bot, chatId, fight) {
  const bonus    = fight.botLevel * 100;
  const playerId = fight.playerId;

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
    [bonus, bonus, bonus, bonus, bonus, bonus, bonus, bonus, bonus, bonus, bonus, playerId]
  );
  await db.query(
    'UPDATE play_cards SET atk=atk+?,magic=magic+?,def=def+?,accuracy=accuracy+?,spd=spd+? WHERE player_id=?',
    [bonus, bonus, bonus, bonus, bonus, playerId]
  );
  await db.query(
    `UPDATE weapon_cards SET atk=atk+?,magic=magic+?,def=def+?,accuracy=accuracy+?,spd=spd+?
     WHERE player_id=? AND weapon_type='normal'`,
    [bonus, bonus, bonus, bonus, bonus, playerId]
  );
  await db.query('UPDATE players SET wins = wins + 1 WHERE telegram_id = ?', [fight.playerTelegramId]);

  const nextLevel = fight.botLevel + 1;
  await db.query(
    `INSERT INTO player_bot_progress (player_id, unlocked_level) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE unlocked_level = GREATEST(unlocked_level, ?)`,
    [playerId, nextLevel, nextLevel]
  );

  await bot.sendMessage(chatId,
    `🎉 *مكافأة الفوز!*\n⬆️ جميع إحصائياتك ارتفعت *+${bonus}* نقطة!\n🔓 المستوى ${nextLevel} مفتوح الآن!`,
    { parse_mode: 'Markdown' }
  );
}

// ─── START BOT FIGHT ──────────────────────────────────────────────────────────
async function startBotFight(bot, chatId, telegramId, requestedLevel = null) {
  if (fights.has(chatId)) {
    return bot.sendMessage(chatId, '⚠️ هناك نزال جارٍ حالياً. انتظر حتى ينتهي.');
  }

  const player = await db.queryOne(
    `SELECT p.*, ic.id AS ic_db_id FROM players p
     LEFT JOIN identity_cards ic ON ic.player_id = p.id
     WHERE p.telegram_id = ?`,
    [telegramId]
  );
  if (!player)        return bot.sendMessage(chatId, '❌ يجب أن تكون مسجلاً ($login) أولاً.');
  if (!player.ic_db_id) return bot.sendMessage(chatId, '❌ يجب أن تمتلك بطاقة تعريفية أولاً.');

  const unlockedLevel = await getPlayerBotLevel(player.id);
  let botLevel = unlockedLevel;

  if (requestedLevel !== null && requestedLevel !== undefined) {
    const parsedLevel = Number.parseInt(requestedLevel, 10);
    if (Number.isNaN(parsedLevel) || parsedLevel < 1) {
      return bot.sendMessage(chatId, '❌ أدخل رقم مستوى صحيح أكبر من 0.');
    }

    const maxReplayableLevel = getMaxReplayableBotLevel(unlockedLevel);
    if (maxReplayableLevel < 1) {
      return bot.sendMessage(
        chatId,
        '❌ مازال ما فتحتي حتى مستوى قديم تعاود تلعبه.\nاستعمل `$fight` باش تبدا أول نزال مع KimiBot.',
        { parse_mode: 'Markdown' }
      );
    }

    if (!canReplayBotLevel(unlockedLevel, parsedLevel)) {
      return bot.sendMessage(
        chatId,
        `❌ ما تقدرش تلعب مع bot level *${parsedLevel}* دابا.\n` +
        `تقدر تعاود غير levels من *1* حتى *${maxReplayableLevel}*.\n` +
        `أما المستوى الحالي المفتوح عندك فهو *${unlockedLevel}* عبر \`$fight\`.`,
        { parse_mode: 'Markdown' }
      );
    }

    botLevel = parsedLevel;
  }

  const botCards = await loadBotCards(botLevel);
  if (!botCards) return bot.sendMessage(chatId, `❌ بطاقات البوت للمستوى ${botLevel} لم تُعدَّ بعد.`);

  // Create fight state
  fights.set(chatId, {
    playerTelegramId : telegramId,
    playerId         : player.id,
    botLevel,
    status           : 'countdown',
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
  });

  // Set fight TTL (auto-cleanup after 15 min of inactivity)
  _setFightTimer(bot, chatId);

  // Set player session so messages are routed here
  session.setSession(telegramId, 'bot_fight', 'race');

  // Countdown
  await bot.sendMessage(chatId, `⚔️ *نزال مع KimiBot — المستوى ${botLevel}!*\n\nاستعد...`, { parse_mode: 'Markdown' });
  await sleep(900);
  await bot.sendMessage(chatId, '1️⃣...');
  await sleep(900);
  await bot.sendMessage(chatId, '2️⃣...');
  await sleep(900);
  await bot.sendMessage(chatId, '3️⃣...');
  await sleep(500);

  const fight = fights.get(chatId);
  fight.status = 'race';
  await bot.sendMessage(chatId, `📤 *أرسل بطاقتك التعريفية الآن!*`, { parse_mode: 'Markdown' });

  // Bot races: sends its card after a random 1-5 second delay
  const delay = Math.floor(Math.random() * 4000) + 1000;
  setTimeout(async () => {
    const f = fights.get(chatId);
    if (!f || f.status !== 'race') return; // player already sent theirs
    f.status = 'waiting_player_identity';
    f.turn   = 'bot'; // bot sent first → bot attacks first

    const ic = f.bot.identityCard;
    await sendCardVisual(bot, chatId, ic,
      `🤖 *KimiBot* أرسل بطاقته التعريفية أولاً!\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🆔 \`${ic.card_id}\`\n` +
      `🎭 الاسم: *${escapeMarkdown(ic.name)}*\n` +
      `❤️ HP: ${ic.hp}  ⚔️ ATK: ${ic.atk}  ✨ Magic: ${ic.magic || 0}\n` +
      `🛡️ DEF: ${ic.def}  💨 SPD: ${ic.spd}  🎯 Accuracy: ${ic.accuracy}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📤 الآن أرسل بطاقتك التعريفية للمتابعة!`
    );
  }, delay);
}

// ─── HANDLE FIGHT MESSAGE (called from bot.js session routing) ────────────────
async function handleFightMessage(bot, msg, cardId) {
  const chatId     = msg.chat.id;
  const telegramId = msg.from.id;
  const fight      = fights.get(chatId);
  if (!fight) return false;

  // Only the fight's player can interact
  if (telegramId !== fight.playerTelegramId) return false;

  _setFightTimer(bot, chatId); // reset 15-min inactivity timer on every valid move

  // ── Identity card ──────────────────────────────────────────────────────────
  if (['race', 'waiting_player_identity'].includes(fight.status)) {
    if (!cardId || !cardId.startsWith('IDC-')) {
      bot.sendMessage(chatId, '📤 أرسل *بطاقتك التعريفية* (IDC-XXXXX) للبدء.', { parse_mode: 'Markdown' });
      return true;
    }
    return await _handleIdentityCard(bot, chatId, fight, telegramId, cardId);
  }

  // ── Player's attack turn ───────────────────────────────────────────────────
  if (fight.status === 'player_turn') {
    if (!cardId) {
      bot.sendMessage(chatId, '❌ أرسل رقم بطاقة صالح (PLC / WPN / SKL).');
      return true;
    }
    return await _handlePlayerAttack(bot, chatId, fight, cardId);
  }

  // ── Player responds to bot's attack ───────────────────────────────────────
  if (fight.status === 'player_response') {
    if (!cardId) {
      bot.sendMessage(chatId, '❌ أرسل بطاقة للرد (PLC / WPN / SKL).');
      return true;
    }
    return await _handlePlayerResponse(bot, chatId, fight, cardId);
  }

  return false;
}

// ─── Internal: identity card received ─────────────────────────────────────────
async function _handleIdentityCard(bot, chatId, fight, telegramId, cardId) {
  const row = await db.queryOne(
    `SELECT ic.* FROM identity_cards ic
     JOIN players p ON p.id = ic.player_id
     WHERE ic.card_id = ? AND p.telegram_id = ?`,
    [cardId, telegramId]
  );
  if (!row) {
    bot.sendMessage(chatId, '❌ هذه البطاقة ليست لك أو غير موجودة.');
    return true;
  }

  // Load player's full card set
  const pCards = await loadPlayerCards(fight.playerId);

  fight.player.identityCard = pCards.identity;
  fight.player.currentHp    = pCards.identity.hp;
  fight.player.playCards    = pCards.playCards;
  fight.player.weaponCards  = pCards.weaponCards;
  fight.player.skillCards   = pCards.skillCards;

  // If player got here first (status was 'race'), player attacks first
  if (fight.turn === null) fight.turn = 'player';

  const pi = fight.player.identityCard;
  const bi = fight.bot.identityCard;

  await bot.sendMessage(chatId,
    `✅ بطاقتك مقبولة!\n\n` +
    `━━━━━━━━ 👤 ${escapeMarkdown(fight.player.name)} ━━━━━━━━\n` +
    `❤️ HP: ${pi.hp}  ⚔️ ATK: ${pi.atk}  ✨ Magic: ${pi.magic || 0}\n` +
    `🛡️ DEF: ${pi.def}  💨 SPD: ${pi.spd}  🎯 Accuracy: ${pi.accuracy}\n\n` +
    `━━━━━━━━ 🤖 KimiBot ━━━━━━━━\n` +
    `❤️ HP: ${bi.hp}  ⚔️ ATK: ${bi.atk}  ✨ Magic: ${bi.magic || 0}\n` +
    `🛡️ DEF: ${bi.def}  💨 SPD: ${bi.spd}  🎯 Accuracy: ${bi.accuracy}`,
    { parse_mode: 'Markdown' }
  );

  await sleep(800);
  if (fight.round === 0) fight.round = 1;

  if (fight.turn === 'player') {
    fight.status = 'player_turn';
    await bot.sendMessage(chatId, `⚔️ *أنت تبدأ!* أرسل إحدى بطاقاتك (PLC / WPN / SKL):`, { parse_mode: 'Markdown' });
  } else {
    await botAttackTurn(bot, chatId, fight);
  }
  return true;
}

// ─── End fight cleanly ────────────────────────────────────────────────────────
function _endFight(chatId, telegramId) {
  fights.delete(chatId);
  session.clearSession(telegramId);
  if (fightTimers.has(chatId)) { clearTimeout(fightTimers.get(chatId)); fightTimers.delete(chatId); }
}
function cancelFight(chatId) {
  const fight = fights.get(chatId);
  if (fight) { session.clearSession(fight.playerTelegramId); }
  fights.delete(chatId);
  if (fightTimers.has(chatId)) { clearTimeout(fightTimers.get(chatId)); fightTimers.delete(chatId); }
}

// -----------------------------------------------------------------------------
// Unified Combat Engine overrides
// -----------------------------------------------------------------------------

async function sendCombatLines(bot, chatId, lines) {
  const payload = (lines || []).filter(Boolean);
  if (payload.length === 0) return;
  await bot.sendMessage(chatId, payload.join('\n'), { parse_mode: 'Markdown' });
}

function chooseBotCounterSkill(botState, incomingCard) {
  const incomingSkill = combatEngine.getSkillProfile(incomingCard);
  if (!incomingSkill) return null;

  const counters = botState.skillCards
    .filter(card =>
      ['reflect', 'almighty', 'negate'].includes(card.type) &&
      !botState.usedCards.has(card.card_id)
    )
    .sort((left, right) =>
      combatEngine.compareSkillPower(
        combatEngine.getSkillProfile(right),
        combatEngine.getSkillProfile(left)
      )
    );

  return counters.find(card =>
    combatEngine.compareSkillPower(combatEngine.getSkillProfile(card), incomingSkill) > 0
  ) || null;
}

function chooseBotResponse(fight, activeCard) {
  const botState = fight.bot;
  const activeKind = combatEngine.getCardKind(activeCard);

  if (activeKind === 'attack') {
    const defenses = [
      ...botState.playCards.filter(card => card.type === 'defense'),
      ...botState.weaponCards.filter(card => card.weapon_type === 'normal' && card.sub_type === 'defense')
    ].filter(card => !botState.usedCards.has(card.card_id));

    const bestDefense = defenses
      .sort((left, right) => {
        const leftDamage = combatEngine.calculateDamage(activeCard, left).toReactive;
        const rightDamage = combatEngine.calculateDamage(activeCard, right).toReactive;
        return leftDamage - rightDamage;
      })[0] || null;

    const reflect = botState.skillCards
      .filter(card =>
        card.type === 'reflect' &&
        !botState.usedCards.has(card.card_id) &&
        combatEngine.getSkillEffectPoints(card) > ((activeCard.atk || 0) + (activeCard.magic || 0))
      )
      .sort((left, right) => combatEngine.getSkillEffectPoints(right) - combatEngine.getSkillEffectPoints(left))[0] || null;

    if (reflect) {
      const defendedDamage = bestDefense ? combatEngine.calculateDamage(activeCard, bestDefense).toReactive : Number.MAX_SAFE_INTEGER;
      if (defendedDamage > 0) return reflect;
    }

    if (bestDefense) return bestDefense;
  }

  if (activeKind === 'skill') {
    const counter = chooseBotCounterSkill(botState, activeCard);
    if (counter) return counter;
  }

  const punishSkill = botState.skillCards
    .filter(card =>
      ['stun', 'poison'].includes(card.type) &&
      !botState.usedCards.has(card.card_id)
    )
    .sort((left, right) => combatEngine.getSkillEffectPoints(right) - combatEngine.getSkillEffectPoints(left))[0];
  if (punishSkill) return punishSkill;

  return null;
}

async function sendResolution(bot, chatId, fight, resolution) {
  await sendCombatLines(bot, chatId, [
    `📊 *النتيجة:*`,
    ...(resolution.summaryLines.length > 0 ? resolution.summaryLines : ['ℹ️ لم يحدث أي تأثير مباشر.']),
    '',
    hpLine(fight)
  ]);
}

async function announcePlayerTurn(bot, chatId, fight) {
  fight.turn = 'player';
  fight.status = 'processing';

  const start = combatEngine.processTurnStart(fight.player, { playerName: escapeMarkdown(fight.player.name) });
  await sendCombatLines(bot, chatId, start.summaryLines);

  if (await checkWin(bot, chatId, fight)) return true;

  if (start.skipTurn) {
    await sleep(800);
    await nextTurn(bot, chatId, fight);
    return true;
  }

  fight.status = 'player_turn';
  await bot.sendMessage(chatId, `⚔️ *دورك!* أرسل إحدى بطاقاتك (PLC / WPN / SKL):`, { parse_mode: 'Markdown' });
  return true;
}

async function nextTurn(bot, chatId, fight) {
  fight.round += 1;

  if (fight.turn === 'player') {
    fight.turn = 'bot';
    await botAttackTurn(bot, chatId, fight);
  } else {
    await announcePlayerTurn(bot, chatId, fight);
  }
}

async function botAttackTurn(bot, chatId, fight) {
  fight.turn = 'bot';
  fight.status = 'bot_turn';
  await sleep(1200);

  const start = combatEngine.processTurnStart(fight.bot, { playerName: 'KimiBot' });
  await sendCombatLines(bot, chatId, start.summaryLines);

  if (await checkWin(bot, chatId, fight)) return true;

  if (start.skipTurn) {
    await sleep(800);
    await nextTurn(bot, chatId, fight);
    return true;
  }

  const card = chooseBotAttack(fight);
  if (!card) {
    await bot.sendMessage(chatId, `🤖 KimiBot لا يملك بطاقات متبقية!`);
    await announcePlayerTurn(bot, chatId, fight);
    return true;
  }

  fight.bot.usedCards.add(card.card_id);
  fight.lastBotCard = card;
  fight.status = 'player_response';

  await sendCardVisual(
    bot,
    chatId,
    card,
    `🤖 *KimiBot* يلعب: *${escapeMarkdown(card.name)}* (\`${card.card_id}\`)\n🛡️ *رد!* أرسل بطاقة للرد (PLC / WPN / SKL):`
  );
  return true;
}

async function _handlePlayerAttack(bot, chatId, fight, cardId) {
  const card = await getPlayerCard(fight.playerTelegramId, cardId);
  if (!card) {
    bot.sendMessage(chatId, '❌ البطاقة غير موجودة أو ليست لك.');
    return true;
  }

  if (fight.player.usedCards.has(cardId)) {
    bot.sendMessage(chatId, '❌ هذه البطاقة استُخدمت مسبقاً.');
    return true;
  }

  fight.player.usedCards.add(cardId);
  fight.status = 'processing';

  await sendCombatLines(bot, chatId, [
    `👤 *${escapeMarkdown(fight.player.name)}* لعب: *${escapeMarkdown(card.name)}*`
  ]);

  const botResponse = chooseBotResponse(fight, card);
  if (botResponse) {
    fight.bot.usedCards.add(botResponse.card_id);
    await sendCardVisual(
      bot,
      chatId,
      botResponse,
      `🤖 KimiBot يرد بـ: *${escapeMarkdown(botResponse.name)}* (\`${botResponse.card_id}\`)`
    );
  } else {
    await sendCombatLines(bot, chatId, [
      `🤖 KimiBot لم يجد رداً مناسباً.`
    ]);
  }

  const resolution = combatEngine.resolveTurn(
    card,
    botResponse,
    fight.player,
    fight.bot,
    {
      activeName: escapeMarkdown(fight.player.name),
      reactiveName: 'KimiBot'
    }
  );

  await sendResolution(bot, chatId, fight, resolution);

  if (await checkWin(bot, chatId, fight)) return true;

  await sleep(800);
  await nextTurn(bot, chatId, fight);
  return true;
}

async function _handlePlayerResponse(bot, chatId, fight, cardId) {
  if (!fight.lastBotCard) return true;

  const card = await getPlayerCard(fight.playerTelegramId, cardId);
  if (!card) {
    bot.sendMessage(chatId, '❌ البطاقة غير موجودة أو ليست لك.');
    return true;
  }

  if (fight.player.usedCards.has(cardId)) {
    bot.sendMessage(chatId, '❌ هذه البطاقة استُخدمت مسبقاً.');
    return true;
  }

  fight.player.usedCards.add(cardId);
  fight.status = 'processing';

  const playerCardKind = combatEngine.getCardKind(card);
  const playerIsAttacking = playerCardKind === 'attack';

  await sendCombatLines(bot, chatId, [
    `👤 *${escapeMarkdown(fight.player.name)}* يرد بـ: *${escapeMarkdown(card.name)}*`
  ]);

  // ── Phase 1: resolve bot's attack (player's card acts as defense or not) ──
  const botAttackCard = fight.lastBotCard;
  fight.lastBotCard = null;

  const resolution = combatEngine.resolveTurn(
    botAttackCard,
    card,
    fight.bot,
    fight.player,
    {
      activeName: 'KimiBot',
      reactiveName: escapeMarkdown(fight.player.name)
    }
  );

  await sendResolution(bot, chatId, fight, resolution);
  if (await checkWin(bot, chatId, fight)) return true;

  // ── Phase 2: if player played an attack card, their attack also resolves ──
  if (playerIsAttacking) {
    await sleep(600);
    await sendCombatLines(bot, chatId, [
      `⚡ *${escapeMarkdown(fight.player.name)}* هاجم في نفس الوقت — KimiBot يرد!`
    ]);

    const botResponse = chooseBotResponse(fight, card);
    if (botResponse) {
      fight.bot.usedCards.add(botResponse.card_id);
      await sendCardVisual(
        bot, chatId, botResponse,
        `🤖 KimiBot يرد بـ: *${escapeMarkdown(botResponse.name)}* (\`${botResponse.card_id}\`)`
      );
    } else {
      await sendCombatLines(bot, chatId, [`🤖 KimiBot لم يجد رداً — الهجوم يصل مباشرة!`]);
    }

    const counterResolution = combatEngine.resolveTurn(
      card,
      botResponse,
      fight.player,
      fight.bot,
      {
        activeName: escapeMarkdown(fight.player.name),
        reactiveName: 'KimiBot'
      }
    );

    await sendResolution(bot, chatId, fight, counterResolution);
    if (await checkWin(bot, chatId, fight)) return true;
  }

  await sleep(800);
  await nextTurn(bot, chatId, fight);
  return true;
}

module.exports = {
  startBotFight,
  handleFightMessage,
  hasFight,
  getFight,
  cancelFight,
  getMaxReplayableBotLevel,
  canReplayBotLevel
};