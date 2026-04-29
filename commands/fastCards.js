const db = require('../db/connection');
const session = require('../middleware/sessionManager');
const permissions = require('../utils/permissions');
const {
  generateIdentityCardId,
  generatePlayCardId,
  generateSkillCardId
} = require('../utils/idGenerator');
const {
  PLAY_TYPE_LABELS,
  SKILL_LABELS,
  DURATION_LABELS
} = require('../utils/constants');
const { createPlayCardWithAllocation } = require('../services/playCardAllocationService');
const {
  ensureBotStoragePlayer,
  upsertBotIdentityLevel,
  bindBotPlayCard,
  bindBotSkillCard
} = require('../utils/botCardStorage');

const PLAYER_IDENTITY_TEMPLATE = {
  hp: 2600,
  atk: 1800,
  magic: 1500,
  def: 1700,
  spd: 1600,
  accuracy: 2300,
  total_points: 10000
};

function register(bot) {
  bot.onText(/^\$fastP(?:\s+(\S+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const hasPermission = await permissions.canManageCards(telegramId);

    if (!hasPermission) {
      return bot.sendMessage(chatId, ' هذا الأمر مخصص للمشرفين أو من لديهم صلاحية إدارة البطاقات.');
    }

    const playerCode = match[1]?.trim();
    if (playerCode) {
      return runFastPlayerGeneration(bot, chatId, telegramId, playerCode);
    }

    session.setSession(telegramId, 'fast_player_cards', 'awaiting_player_code');
    return bot.sendMessage(
      chatId,
      `🧪 *إنشاء مجموعة تجريبية للاعب*\n\nأدخل *كود اللاعب* ليتم توليد البطاقات وحفظها مباشرة في حسابه:`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/^\$fastB(?:\s+(\d+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    if (!(await permissions.isAdmin(telegramId))) {
      return bot.sendMessage(chatId, '🚫 هذا الأمر مخصص للأدمن فقط.');
    }

    const level = parseInt(match[1], 10);
    if (!Number.isNaN(level)) {
      return runFastBotGeneration(bot, chatId, telegramId, level);
    }

    session.setSession(telegramId, 'fast_bot_cards', 'awaiting_level');
    return bot.sendMessage(
      chatId,
      `🤖 *إنشاء مجموعة بوت تجريبية*\n\nأدخل *رقم المستوى* الذي تريد توليد بطاقاته تلقائياً:`,
      { parse_mode: 'Markdown' }
    );
  });
}

async function handleStep(bot, msg) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const text = (msg.text || '').trim();
  const s = session.getSession(telegramId);

  if (s.action === 'fast_player_cards' && s.step === 'awaiting_player_code') {
    const hasPermission = await permissions.canManageCards(telegramId);
    if (!hasPermission) {
      session.clearSession(telegramId);
      await bot.sendMessage(chatId, '🚫 لم تعد لديك صلاحية استخدام هذا الأمر.');
      return true;
    }
    await runFastPlayerGeneration(bot, chatId, telegramId, text);
    return true;
  }

  if (s.action === 'fast_bot_cards' && s.step === 'awaiting_level') {
    if (!(await permissions.isAdmin(telegramId))) {
      session.clearSession(telegramId);
      await bot.sendMessage(chatId, '🚫 لم تعد لديك صلاحية استخدام هذا الأمر.');
      return true;
    }

    const level = parseInt(text, 10);
    if (Number.isNaN(level) || level < 1) {
      await bot.sendMessage(chatId, '❌ أدخل رقم مستوى صالحًا أكبر من 0.');
      return true;
    }

    await runFastBotGeneration(bot, chatId, telegramId, level);
    return true;
  }

  return false;
}

async function runFastPlayerGeneration(bot, chatId, telegramId, playerCode) {
  const player = await db.queryOne('SELECT * FROM players WHERE player_code = ?', [playerCode]);
  if (!player) {
    await bot.sendMessage(chatId, '❌ لم يتم العثور على لاعب بهذا الكود. حاول مجددًا.');
    return;
  }

  const existingIdentity = await db.queryOne(
    'SELECT * FROM identity_cards WHERE player_id = ? ORDER BY id ASC LIMIT 1',
    [player.id]
  );

  try {
    const created = await db.withTransaction(async (conn) => {
      let identity = existingIdentity || await createIdentityCard(conn, player.id, buildPlayerIdentity(player));

      // If reusing an existing identity card, reset the available stat budgets
      // back to their base values so createPlayCards has a full allocation to work with.
      if (existingIdentity) {
        await conn.execute(
          `UPDATE identity_cards
              SET available_atk      = atk,
                  available_magic    = magic,
                  available_def      = def,
                  available_spd      = spd,
                  available_accuracy = accuracy
            WHERE id = ?`,
          [identity.id]
        );
        // Refresh the local object so buildPlayTemplates sees the reset values
        identity = {
          ...identity,
          available_atk:      identity.atk,
          available_magic:    identity.magic,
          available_def:      identity.def,
          available_spd:      identity.spd,
          available_accuracy: identity.accuracy,
        };
      }

      const playCards  = await createPlayCards(conn, player.id, identity.id, buildPlayTemplates(identity, 'تجريبي'));
      const skillCards = await createSkillCards(conn, player.id, buildSkillTemplates({ scope: 'player' }));

      return {
        player,
        identity,
        identityCreated: !existingIdentity,
        playCards,
        skillCards
      };
    });

    session.clearSession(telegramId);
    await sendPlayerPresetSummary(bot, chatId, created);
  } catch (error) {
    console.error('fastCards runFastPlayerGeneration error:', error);
    session.clearSession(telegramId);
    await bot.sendMessage(chatId, '❌ وقع خطأ أثناء إنشاء المجموعة التجريبية للاعب.');
  }
}

async function runFastBotGeneration(bot, chatId, telegramId, level) {
  if (Number.isNaN(level) || level < 1) {
    await bot.sendMessage(chatId, '❌ أدخل رقم مستوى صالحًا أكبر من 0.');
    return;
  }

  try {
    const created = await db.withTransaction(async (conn) => {
      const owner = await ensureBotStoragePlayer(conn);
      const identity = await createIdentityCard(conn, owner.id, buildBotIdentity(level));
      const playCards = await createPlayCards(conn, owner.id, identity.id, buildPlayTemplates(identity, `L${level}`));
      const skillCards = await createSkillCards(conn, owner.id, buildSkillTemplates({ scope: 'bot', level }));

      await saveBotLevelSet(conn, level, identity.card_id, playCards.map((card) => card.card_id), skillCards.map((card) => card.card_id));

      return {
        owner,
        level,
        identity,
        playCards,
        skillCards
      };
    });

    session.clearSession(telegramId);
    await sendBotPresetSummary(bot, chatId, created);
  } catch (error) {
    console.error('fastCards runFastBotGeneration error:', error);
    session.clearSession(telegramId);
    await bot.sendMessage(chatId, '❌ وقع خطأ أثناء إنشاء مجموعة البوت التجريبية.');
  }
}

async function queryOneConn(conn, sql, params = []) {
  const [rows] = await conn.execute(sql, params);
  return rows[0] || null;
}

async function executeConn(conn, sql, params = []) {
  const [result] = await conn.execute(sql, params);
  return result;
}

async function generateUniqueId(conn, table, column, generator) {
  let value;
  do {
    value = generator();
  } while (await queryOneConn(conn, `SELECT ${column} FROM ${table} WHERE ${column} = ?`, [value]));
  return value;
}

function buildPlayerIdentity(player) {
  return {
    name: `${player.character_name} - تجريبي`,
    ...PLAYER_IDENTITY_TEMPLATE,
    remaining_points: 0
  };
}

function buildBotIdentity(level) {
  return {
    name: `KimiBot L${level}`,
    hp: 2600 + (level * 180),
    atk: 1800 + (level * 110),
    magic: 1500 + (level * 100),
    def: 1700 + (level * 90),
    spd: 1600 + (level * 85),
    accuracy: 2300 + (level * 95),
    total_points: 10000 + (level * 500),
    remaining_points: 0
  };
}

function splitTwo(base, firstRatio) {
  if (!base || base <= 0) return [0, 0];

  const safeFirstRatio = Math.min(1, Math.max(0, firstRatio));
  const first = Math.max(0, Math.min(base, Math.round(base * safeFirstRatio)));
  return [first, Math.max(0, base - first)];
}

function splitMany(base, ratios) {
  if (!base || base <= 0) {
    return ratios.map(() => 0);
  }

  const totalRatio = ratios.reduce((sum, ratio) => sum + Math.max(0, ratio), 0) || 1;
  const scaledRatios = ratios.map((ratio) => Math.max(0, ratio) / totalRatio);
  const rawValues = scaledRatios.map((ratio) => base * ratio);
  const values = rawValues.map((value) => Math.floor(value));
  let remainder = base - values.reduce((sum, value) => sum + value, 0);

  const order = rawValues
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  for (let i = 0; i < order.length && remainder > 0; i += 1) {
    values[order[i].index] += 1;
    remainder -= 1;
  }

  return values;
}

function buildPlayTemplates(identity, prefix = '') {
  const namePrefix = prefix ? `${prefix} ` : '';
  const [swiftAtk, breakerAtk] = splitTwo(identity.atk, 0.46);
  const [swiftAcc, breakerAcc, focusedAcc, waveAcc] = splitMany(identity.accuracy, [0.32, 0.23, 0.19, 0.26]);
  const [focusedMagic, waveMagic] = splitTwo(identity.magic, 0.43);
  const [barrierDef, evadeDef] = splitTwo(identity.def, 0.57);
  const [barrierSpd, evadeSpd] = splitTwo(identity.spd, 0.38);

  return [
    {
      name: `${namePrefix}هجوم خاطف`,
      type: 'attack',
      atk: swiftAtk,
      accuracy: swiftAcc,
      description: 'بطاقة هجومية متوازنة بدقة مرتفعة.'
    },
    {
      name: `${namePrefix}هجوم كاسر`,
      type: 'attack',
      atk: breakerAtk,
      accuracy: breakerAcc,
      description: 'بطاقة هجومية أقوى لكنها أقل دقة.'
    },
    {
      name: `${namePrefix}شرارة مركزة`,
      type: 'magic',
      magic: focusedMagic,
      accuracy: focusedAcc,
      description: 'بطاقة سحرية مستقرة للاستخدام الآمن.'
    },
    {
      name: `${namePrefix}موجة مدمرة`,
      type: 'magic',
      magic: waveMagic,
      accuracy: waveAcc,
      description: 'بطاقة سحرية عالية الضرر.'
    },
    {
      name: `${namePrefix}حاجز ثابت`,
      type: 'defense',
      def: barrierDef,
      spd: barrierSpd,
      description: 'بطاقة دفاعية تركز على الصد المباشر.'
    },
    {
      name: `${namePrefix}تفادي سريع`,
      type: 'defense',
      def: evadeDef,
      spd: evadeSpd,
      description: 'بطاقة دفاعية تعتمد على السرعة والمناورة.'
    }
  ];
}

function buildSkillTemplates({ scope, level = 1 }) {
  const prefix = scope === 'bot' ? `L${level} ` : 'تجريبي ';
  const reflectPoints = scope === 'bot' ? 450 + (level * 60) : 650;
  const almightyPoints = scope === 'bot' ? 650 + (level * 75) : 900;
  const poisonPercent = scope === 'bot' ? Math.min(30, 8 + level) : 12;

  return [
    {
      name: `${prefix}مرآة الرد`,
      type: 'reflect',
      effect_points: reflectPoints,
      poison_percent: 0,
      duration: '1',
      description: 'تعكس تأثيرًا أضعف منها إذا كانت نقاط تأثيرها أعلى.'
    },
    {
      name: `${prefix}نفي الأثر`,
      type: 'negate',
      effect_points: 0,
      poison_percent: 0,
      duration: '1',
      description: 'تلغي التأثيرات الحالية على مستخدمها.'
    },
    {
      name: `${prefix}الجبروت`,
      type: 'almighty',
      effect_points: almightyPoints,
      poison_percent: 0,
      duration: '1',
      description: 'يلغي تأثيرًا أضعف منه أو يمحو التأثيرات الحالية.'
    },
    {
      name: `${prefix}سم الزعاف`,
      type: 'poison',
      effect_points: 0,
      poison_percent: poisonPercent,
      duration: '2',
      description: 'يسمم الخصم ويستنزف نسبة من HP كل دور.'
    }
  ];
}

async function createIdentityCard(conn, playerId, identity) {
  const cardId = await generateUniqueId(conn, 'identity_cards', 'card_id', generateIdentityCardId);
  const result = await executeConn(
    conn,
    `INSERT INTO identity_cards
     (card_id, player_id, name, hp, atk, available_atk, magic, available_magic, def, available_def, spd, available_spd, accuracy, available_accuracy, total_points, remaining_points)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cardId,
      playerId,
      identity.name,
      identity.hp,
      identity.atk,
      identity.atk,
      identity.magic,
      identity.magic,
      identity.def,
      identity.def,
      identity.spd,
      identity.spd,
      identity.accuracy,
      identity.accuracy,
      identity.total_points,
      identity.remaining_points
    ]
  );

  return {
    id: result.insertId,
    card_id: cardId,
    ...identity
  };
}

async function createPlayCards(conn, playerId, identityCardId, templates) {
  const cards = [];

  for (const template of templates) {
    const created = await createPlayCardWithAllocation(
      {
        playerId,
        identityCardId,
        cardName: template.name,
        type: template.type,
        stats: {
          atk: template.atk || 0,
          magic: template.magic || 0,
          def: template.def || 0,
          accuracy: template.accuracy || 0,
          spd: template.spd || 0
        }
      },
      { connection: conn, idGenerator: generatePlayCardId }
    );

    cards.push({ card_id: created.cardId, ...template });
  }

  return cards;
}

async function createSkillCards(conn, playerId, templates) {
  const cards = [];

  for (const template of templates) {
    const cardId = await generateUniqueId(conn, 'skill_cards', 'card_id', generateSkillCardId);
    await executeConn(
      conn,
      `INSERT INTO skill_cards (card_id, player_id, name, type, effect_points, poison_percent, duration)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        cardId,
        playerId,
        template.name,
        template.type,
        template.effect_points || 0,
        template.poison_percent || 0,
        template.duration
      ]
    );

    cards.push({ card_id: cardId, ...template });
  }

  return cards;
}

async function saveBotLevelSet(conn, level, identityCardId, playCards, skillCards) {
  await upsertBotIdentityLevel(level, identityCardId, conn);

  await executeConn(conn, 'DELETE FROM bot_play_cards WHERE level = ?', [level]);
  await executeConn(conn, 'DELETE FROM bot_skill_cards WHERE level = ?', [level]);
  await executeConn(conn, 'DELETE FROM bot_weapon_cards WHERE level = ?', [level]);

  for (const cardId of playCards) {
    await bindBotPlayCard(level, cardId, conn);
  }

  for (const cardId of skillCards) {
    await bindBotSkillCard(level, cardId, conn);
  }
}

function formatIdentityMessage(identity, reused) {
  const reusedLine = reused ? '\n♻️ تم استخدام البطاقة التعريفية الموجودة مسبقًا.' : '';

  return (
    `🎭 *البطاقة التعريفية*\n` +
    `• \`${identity.card_id}\` — *${identity.name}*\n` +
    `الوظيفة: البطاقة الأساسية التي يعتمد عليها HP و ATK و DEF و SPD و Accuracy.\n` +
    `الإحصائيات: HP ${identity.hp} | ATK ${identity.atk} | Magic ${identity.magic} | DEF ${identity.def} | SPD ${identity.spd} | Acc ${identity.accuracy}` +
    reusedLine
  );
}

function formatPlayCardLine(card) {
  const stats = card.type === 'attack'
    ? `ATK ${card.atk} | Acc ${card.accuracy}`
    : card.type === 'magic'
      ? `Magic ${card.magic}`
      : `DEF ${card.def} | SPD ${card.spd}`;

  return `• \`${card.card_id}\` — *${card.name}* (${PLAY_TYPE_LABELS[card.type]})\n${card.description}\n${stats}`;
}

function formatSkillCardLine(card) {
  const details = card.type === 'poison'
    ? `نسبة السم: ${card.poison_percent}% | المدة: ${DURATION_LABELS[card.duration]}`
    : card.type === 'negate'
      ? `المدة: ${DURATION_LABELS[card.duration]}`
      : `نقاط التأثير: ${card.effect_points} | المدة: ${DURATION_LABELS[card.duration]}`;

  return `• \`${card.card_id}\` — *${card.name}* (${SKILL_LABELS[card.type]})\n${card.description}\n${details}`;
}

async function sendPlayerPresetSummary(bot, chatId, created) {
  await bot.sendMessage(
    chatId,
    `✅ *تم تجهيز المجموعة التجريبية للاعب ${created.player.character_name}*\n\n` +
    `المحتوى:\n` +
    `• 1 بطاقة تعريفية\n` +
    `• 2 هجومية\n` +
    `• 2 سحرية\n` +
    `• 2 دفاعية\n` +
    `• 1 عكس\n` +
    `• 1 نفي\n` +
    `• 1 جبروت\n` +
    `• 1 سم`,
    { parse_mode: 'Markdown' }
  );

  await bot.sendMessage(chatId, formatIdentityMessage(created.identity, !created.identityCreated), { parse_mode: 'Markdown' });
  await bot.sendMessage(
    chatId,
    `⚔️ *بطاقات اللعب*\n\n${created.playCards.map(formatPlayCardLine).join('\n\n')}`,
    { parse_mode: 'Markdown' }
  );
  await bot.sendMessage(
    chatId,
    `🌟 *بطاقات المهارة*\n\n${created.skillCards.map(formatSkillCardLine).join('\n\n')}`,
    { parse_mode: 'Markdown' }
  );
}

async function sendBotPresetSummary(bot, chatId, created) {
  await bot.sendMessage(
    chatId,
    `✅ *تم إنشاء مجموعة بوت تجريبية للمستوى ${created.level}*\n\n` +
    `تم ربطها مباشرة بقاعدة بيانات البوت.\n` +
    `المالك التقني: *${created.owner.character_name}*`,
    { parse_mode: 'Markdown' }
  );

  await bot.sendMessage(chatId, formatIdentityMessage(created.identity, false), { parse_mode: 'Markdown' });
  await bot.sendMessage(
    chatId,
    `⚔️ *بطاقات اللعب للمستوى ${created.level}*\n\n${created.playCards.map(formatPlayCardLine).join('\n\n')}`,
    { parse_mode: 'Markdown' }
  );
  await bot.sendMessage(
    chatId,
    `🌟 *بطاقات المهارة للمستوى ${created.level}*\n\n${created.skillCards.map(formatSkillCardLine).join('\n\n')}`,
    { parse_mode: 'Markdown' }
  );
}

module.exports = { register, handleStep };