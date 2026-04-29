'use strict';

const db         = require('../db/connection');
const shop       = require('../utils/shopSystem');
const rankSystem = require('../utils/rankSystem');
const { sendQR } = require('../utils/qrHelper');
const session    = require('../middleware/sessionManager');

// ── constants ─────────────────────────────────────────────────────────────────

const RARITY_EMOJI = { common: '⚪', rare: '🔵', epic: '🟣', legendary: '🔴' };
const STORE_LABEL  = {
  city:    '🏙️ متجر المدينة',
  kingdom: '🏰 متجر المملكة',
  empire:  '👑 متجر الإمبراطورية',
};

const VALID_LEVELS  = ['city', 'kingdom', 'empire'];
const VALID_TYPES   = ['potion', 'material', 'card_pack', 'special'];
const VALID_RARITY  = ['common', 'rare', 'epic', 'legendary'];

// ── helpers ───────────────────────────────────────────────────────────────────

/** Wrap lines in a MarkdownV2 code block. Content inside needs no escaping. */
function cb(lines) {
  return '```text\n' + lines.join('\n') + '\n```';
}

/** Escape text for use OUTSIDE code blocks in MarkdownV2. */
function escMd(text) {
  return String(text || '').replace(/[_*[\]()~`>#+=|{}.!\-\\]/g, '\\$&');
}

async function getPlayer(telegramId) {
  return db.queryOne('SELECT * FROM players WHERE telegram_id = ? LIMIT 1', [telegramId]);
}

/** Admin gate: emperor or overlord only. */
async function isAdmin(telegramId) {
  return rankSystem.hasRank(telegramId, 'emperor');
}

/** DM-only guard: delete group message, send timed warning, return false. */
async function requireDm(bot, msg) {
  if (msg.chat.type === 'private') return true;
  try { await bot.deleteMessage(msg.chat.id, msg.message_id); } catch {}
  const sent = await bot.sendMessage(
    msg.chat.id,
    cb(['[ ＳＹＳＴＥＭ ]', 'هذا الأمر متاح في المحادثة الخاصة فقط.']),
    { parse_mode: 'MarkdownV2' }
  );
  setTimeout(() => bot.deleteMessage(msg.chat.id, sent.message_id).catch(() => {}), 5000);
  return false;
}

// ── main shop menu ────────────────────────────────────────────────────────────

function buildMainMenuText(player) {
  return cb([
    '[ ＳＹＳＴＥＭ ]',
    'Accessing Imperial Network... █ 100%',
    '',
    '┏━━━━━━━━━━━━━━━━━━━━┓',
    '   🛒 قـائـمـة الـمـتـاجـر',
    '┗━━━━━━━━━━━━━━━━━━━━┛',
    `👤 الكيان : ${player.character_name}`,
    `🟡 الرصيد : ${player.mg_balance} MG`,
  ]);
}

const MAIN_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '🏙️ City Store',    callback_data: 'shop_tier_city' },
      { text: '🏰 Kingdom Store', callback_data: 'shop_tier_kingdom' },
    ],
    [{ text: '👑 Empire Store',   callback_data: 'shop_tier_empire' }],
  ],
};

async function sendMainMenu(bot, chatId, telegramId) {
  const player = await getPlayer(telegramId);
  if (!player) {
    return bot.sendMessage(chatId, cb(['[ ERROR ]', 'غير مسجل. استخدم /login أولاً.']), { parse_mode: 'MarkdownV2' });
  }
  return bot.sendMessage(chatId, buildMainMenuText(player), {
    parse_mode: 'MarkdownV2',
    reply_markup: MAIN_KEYBOARD,
  });
}

async function editMainMenu(bot, query) {
  const player = await getPlayer(query.from.id);
  if (!player) return;
  return bot.editMessageText(buildMainMenuText(player), {
    chat_id:    query.message.chat.id,
    message_id: query.message.message_id,
    parse_mode: 'MarkdownV2',
    reply_markup: MAIN_KEYBOARD,
  });
}

// ── tier item list ────────────────────────────────────────────────────────────

async function showTierItems(bot, query, tier) {
  const { chat, message_id } = query.message;
  const items = await shop.getActiveItems(tier);

  if (!items.length) {
    return bot.editMessageText(cb(['[ ＳＹＳＴＥＭ ]', 'المتجر فارغ حالياً.']), {
      chat_id: chat.id, message_id, parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'shop_main' }]] },
    });
  }

  const lines = [
    `[ ＳＹＳＴＥＭ : ${STORE_LABEL[tier]} ]`,
    '─────────────────────────────────',
    ...items.map(i => {
      const expiry = i.expires_at ? `  ⏳${fmtExpiry(i.expires_at)}` : '';
      return `${RARITY_EMOJI[i.rarity]} ${i.name.padEnd(18)}  🟡${i.price}${expiry}`;
    }),
    '─────────────────────────────────',
  ];

  return bot.editMessageText(cb(lines), {
    chat_id: chat.id, message_id, parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [
        ...items.map(i => [{ text: `${RARITY_EMOJI[i.rarity]} ${i.name}`, callback_data: `shop_item_${i.id}` }]),
        [{ text: '🔙 رجوع', callback_data: 'shop_main' }],
      ],
    },
  });
}

function fmtExpiry(expiresAt) {
  const ms   = new Date(expiresAt) - Date.now();
  const hrs  = Math.max(0, Math.floor(ms / 3_600_000));
  const mins = Math.max(0, Math.floor((ms % 3_600_000) / 60_000));
  return hrs > 0 ? `${hrs}h` : `${mins}m`;
}

// ── item detail ───────────────────────────────────────────────────────────────

async function showItemDetail(bot, query, itemId) {
  const { chat, message_id } = query.message;
  const item = await db.queryOne(
    'SELECT * FROM shop_items WHERE id = ? AND show_in_shop = TRUE LIMIT 1',
    [itemId]
  );
  if (!item) return;

  const expiryLine = item.expires_at
    ? `│ ⏳ ينتهي بعد  : ${fmtExpiry(item.expires_at)}`
    : '│ ⏳ ينتهي      : لا يوجد';

  const lines = [
    '[ ＳＹＳＴＥＭ : Item Details ]',
    '┌──────────────────────────────────',
    `│ 💠 الإسم    : ${item.name}`,
    `│ 📊 الندرة   : ${RARITY_EMOJI[item.rarity]} ${item.rarity}`,
    `│ 🟡 السعر    : ${item.price} MG`,
    expiryLine,
    '├──────────────────────────────────',
    `│ 📜 الوصف    : ${item.description || '—'}`,
    '└──────────────────────────────────',
  ];

  return bot.editMessageText(cb(lines), {
    chat_id: chat.id, message_id, parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [[
        { text: '💳 شراء',  callback_data: `shop_buy_${itemId}` },
        { text: '🔙 رجوع', callback_data: `shop_tier_${item.store_level}` },
      ]],
    },
  });
}

// ── buy flow ──────────────────────────────────────────────────────────────────

async function handleBuy(bot, query, itemId) {
  const { chat, message_id } = query.message;
  const player = await getPlayer(query.from.id);
  if (!player) {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ غير مسجل', show_alert: true });
  }

  let item;
  try {
    item = await shop.buyItem(player.id, itemId);
  } catch (err) {
    return bot.answerCallbackQuery(query.id, { text: `❌ ${err.message}`, show_alert: true });
  }

  await bot.editMessageText(cb([
    '[ ＳＹＳＴＥＭ : SUCCESS ]',
    '──────────────────────────────────',
    `✅ تم الشراء   : ${item.name}`,
    `📊 الندرة      : ${RARITY_EMOJI[item.rarity]} ${item.rarity}`,
    `🟡 المدفوع     : ${item.price} MG`,
    '──────────────────────────────────',
    '  تم تحديث مخزونك.',
  ]), {
    chat_id: chat.id, message_id, parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: [[{ text: '🔙 العودة للمتجر', callback_data: 'shop_main' }]] },
  });

  if (item.item_type === 'card_pack') {
    await sendQR(bot, chat.id, item.name);
  }

  if (item.rarity === 'legendary') {
    await shop.announceLegendaryDrop(bot, player.id, item.name, item.store_level);
  }
}

// ── inventory ($inventory / $bag) ─────────────────────────────────────────────

async function showInventory(bot, chatId, telegramId) {
  const player = await getPlayer(telegramId);
  if (!player) {
    return bot.sendMessage(chatId, cb(['[ ERROR ]', 'غير مسجل. استخدم /login أولاً.']), { parse_mode: 'MarkdownV2' });
  }

  const [items, resources] = await Promise.all([
    shop.getPlayerInventory(player.id),
    shop.getPlayerResources(player.id),
  ]);

  const isEmpty = !items.length && !resources.length;
  if (isEmpty) {
    return bot.sendMessage(chatId, cb([
      '[ ＳＹＳＴＥＭ : Inventory ]',
      `👤 الكيان : ${player.character_name}`,
      '──────────────────────────────────',
      '  حقيبتك فارغة حالياً.',
      '──────────────────────────────────',
    ]), { parse_mode: 'MarkdownV2' });
  }

  const lines = [
    '[ ＳＹＳＴＥＭ : Inventory ]',
    `👤 الكيان : ${player.character_name}`,
    `🟡 الرصيد : ${player.mg_balance} MG`,
    '══════════════════════════════════',
  ];

  lines.push('  [ 🧪 المستهلكات ]');
  lines.push('  ──────────────────────────────');
  if (items.length) {
    for (const i of items) {
      const expTag = i.expires_at ? `  ⏳${fmtExpiry(i.expires_at)}` : '';
      lines.push(`  ${RARITY_EMOJI[i.rarity]} ${i.name.padEnd(18)}  x${i.quantity}${expTag}`);
    }
  } else {
    lines.push('  لا يوجد.');
  }

  lines.push('');

  lines.push('  [ ⚒️ المواد ]');
  lines.push('  ──────────────────────────────');
  if (resources.length) {
    for (const r of resources) {
      lines.push(`  ◆ ${r.resource_type.padEnd(20)}  x${r.quantity}`);
    }
  } else {
    lines.push('  لا يوجد.');
  }

  lines.push('══════════════════════════════════');
  lines.push(`  إجمالي: ${items.length} عنصر  |  ${resources.length} مادة`);

  return bot.sendMessage(chatId, cb(lines), { parse_mode: 'MarkdownV2' });
}

// ── spin menu ─────────────────────────────────────────────────────────────────

function buildSpinMenuText(player, price, active) {
  if (!active) {
    return cb([
      '[ ＳＹＳＴＥＭ : LOCKED ]',
      '══════════════════════════════════',
      '  🔒 بوابة الاستدعاء مغلقة',
      '  الوصول مرفوض من الإمبراطورية.',
      '══════════════════════════════════',
    ]);
  }
  return cb([
    '[ ＳＹＳＴＥＭ : SUMMONING GATE ]',
    '══════════════════════════════════',
    '  🌀  بوابة الاستدعاء — مفتوحة',
    '══════════════════════════════════',
    `  👤 الكيان  : ${player ? player.character_name : '???'}`,
    `  🟡 الرصيد  : ${player ? player.mg_balance : '???'} MG`,
    '──────────────────────────────────',
    `  💠 سعر x1  : ${price} MG`,
    `  💠 سعر x10 : ${price * 10} MG`,
    '──────────────────────────────────',
    '  "ماذا ستستدعي من الظلام..?"',
  ]);
}

const SPIN_KEYBOARD = {
  inline_keyboard: [[
    { text: '🌀 Spin x1',  callback_data: 'spin_do_1' },
    { text: '🌀 Spin x10', callback_data: 'spin_do_10' },
  ]],
};

async function sendSpinMenu(bot, chatId, telegramId) {
  const [active, pool, player] = await Promise.all([
    shop.getSpinStatus(),
    db.query('SELECT price_per_spin FROM spin_pool LIMIT 1'),
    getPlayer(telegramId),
  ]);
  const price = pool.length ? pool[0].price_per_spin : 0;
  const text  = buildSpinMenuText(player, price, active);
  return bot.sendMessage(chatId, text, {
    parse_mode: 'MarkdownV2',
    reply_markup: active ? SPIN_KEYBOARD : undefined,
  });
}

async function editSpinMenu(bot, query) {
  const { chat, message_id } = query.message;
  const [active, pool, player] = await Promise.all([
    shop.getSpinStatus(),
    db.query('SELECT price_per_spin FROM spin_pool LIMIT 1'),
    getPlayer(query.from.id),
  ]);
  const price = pool.length ? pool[0].price_per_spin : 0;
  return bot.editMessageText(buildSpinMenuText(player, price, active), {
    chat_id: chat.id, message_id, parse_mode: 'MarkdownV2',
    reply_markup: active ? SPIN_KEYBOARD : { inline_keyboard: [] },
  });
}

// ── spin execution ────────────────────────────────────────────────────────────

async function handleSpin(bot, query, count) {
  const { chat, message_id } = query.message;
  const player = await getPlayer(query.from.id);
  if (!player) {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ غير مسجل', show_alert: true });
  }

  await bot.editMessageText(cb([
    '[ ＳＹＳＴＥＭ : SUMMONING ]',
    '══════════════════════════════════',
    '  ◆ ◆ ◆ ◆ ◆   جاري الاستدعاء...',
    '  تمزيق نسيج الواقع...',
    '  فتح البوابة المظلمة...',
    '══════════════════════════════════',
  ]), {
    chat_id: chat.id, message_id, parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: [] },
  });

  let spinResult;
  try {
    spinResult = await shop.performSpin(player.id, count);
  } catch (err) {
    await bot.editMessageText(cb([
      '[ ＳＹＳＴＥＭ : ERROR ]',
      `  ❌ ${err.message}`,
    ]), {
      chat_id: chat.id, message_id, parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'spin_menu' }]] },
    });
    return;
  }

  await new Promise(r => setTimeout(r, 1400));

  const { results, totalCost } = spinResult;
  let resultLines;

  if (count === 1) {
    const won = results[0];
    resultLines = [
      '[ ＳＹＳＴＥＭ : SUMMONING COMPLETE ]',
      '══════════════════════════════════',
      `  ${RARITY_EMOJI[won.rarity]}  ${won.item_name}`,
      `  الندرة : ${won.rarity}`,
      '══════════════════════════════════',
      `  🟡 المدفوع : ${totalCost} MG`,
    ];
  } else {
    const grouped = {};
    for (const won of results) {
      const key = `${RARITY_EMOJI[won.rarity]} ${won.item_name}`;
      grouped[key] = (grouped[key] || 0) + 1;
    }
    resultLines = [
      '[ ＳＹＳＴＥＭ : MULTI-SUMMON x10 ]',
      '══════════════════════════════════',
      ...Object.entries(grouped).map(([k, v]) => `  ${k}${v > 1 ? `  x${v}` : ''}`),
      '══════════════════════════════════',
      `  🟡 المدفوع : ${totalCost} MG`,
    ];
  }

  await bot.editMessageText(cb(resultLines), {
    chat_id: chat.id, message_id, parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [[
        { text: count === 1 ? '🌀 Spin Again' : '🌀 Spin x10 Again', callback_data: `spin_do_${count}` },
        { text: '🔙 رجوع', callback_data: 'spin_menu' },
      ]],
    },
  });

  for (const won of results) {
    if (won.rarity === 'legendary') {
      await shop.announceLegendaryDrop(bot, player.id, won.item_name, 'empire');
    }
  }
}

// ── admin commands ────────────────────────────────────────────────────────────

function registerAdminCommands(bot) {
  bot.onText(/^\$additem (.+)/i, async (msg, match) => {
    if (!(await isAdmin(msg.from.id))) return;

    const parts = match[1].split('|').map(s => s.trim());
    if (parts.length < 5) {
      return bot.sendMessage(msg.chat.id, cb([
        '[ USAGE ]',
        '$additem Name | Price | StoreLevel | Type | Rarity',
        '         | HoursToExpire | TargetType | BoostValue | IsCraftingResource',
        '',
        'StoreLevel         : city / kingdom / empire',
        'Type               : potion / material / card_pack / special',
        'Rarity             : common / rare / epic / legendary',
        'HoursToExpire      : اختياري (0 = بدون انتهاء)',
        'TargetType         : stats / poison / reflect / almighty / stun / weapon',
        'BoostValue         : القيمة المضافة (مثال: 50)',
        'IsCraftingResource : 1 أو 0',
      ]), { parse_mode: 'MarkdownV2' });
    }

    const [name, priceStr, storeLevel, type, rarity,
           hoursStr, targetType, boostStr, craftingStr] = parts;

    if (!VALID_LEVELS.includes(storeLevel) || !VALID_TYPES.includes(type) || !VALID_RARITY.includes(rarity)) {
      return bot.sendMessage(msg.chat.id, cb(['[ ERROR ]', 'قيم غير صحيحة في StoreLevel أو Type أو Rarity.']), { parse_mode: 'MarkdownV2' });
    }

    const hours              = parseInt(hoursStr) || 0;
    const isCraftingResource = craftingStr === '1';
    const boostValue         = parseFloat(boostStr) || 0;
    const resolvedTargetType = targetType || null;

    const itemId = await shop.addItem(
      name, parseInt(priceStr) || 0, storeLevel, type, rarity, hours,
      { targetType: resolvedTargetType, boostValue, isCraftingResource }
    );

    return bot.sendMessage(msg.chat.id, cb([
      '[ ＳＹＳＴＥＭ : SUCCESS ]',
      `✅ تم الإضافة       : ${name}`,
      `🆔 ID               : ${itemId}`,
      `🟡 السعر            : ${priceStr} MG`,
      `📦 النوع            : ${type} / ${storeLevel}`,
      `📊 الندرة           : ${RARITY_EMOJI[rarity]} ${rarity}`,
      resolvedTargetType ? `⚡ نوع التأثير     : ${resolvedTargetType}` : '⚡ نوع التأثير     : —',
      boostValue ? `💪 قيمة التعزيز   : +${boostValue}` : '💪 قيمة التعزيز   : —',
      isCraftingResource ? '⚒️ مادة تصنيع      : نعم' : '⚒️ مادة تصنيع      : لا',
      hours > 0 ? `⏳ ينتهي بعد       : ${hours} ساعة` : '⏳ ينتهي           : لا يوجد',
    ]), { parse_mode: 'MarkdownV2' });
  });

  bot.onText(/^\$delitem (\d+)$/i, async (msg, match) => {
    if (!(await isAdmin(msg.from.id))) return;
    const itemId  = parseInt(match[1]);
    const deleted = await shop.deleteItem(itemId);
    return bot.sendMessage(msg.chat.id, cb(
      deleted
        ? ['[ ＳＹＳＴＥＭ : SUCCESS ]', `✅ تم حذف العنصر رقم ${itemId}`]
        : ['[ ＳＹＳＴＥＭ : ERROR ]',   `❌ العنصر ${itemId} غير موجود`]
    ), { parse_mode: 'MarkdownV2' });
  });

  bot.onText(/^\$togglespin$/i, async (msg) => {
    if (!(await isAdmin(msg.from.id))) return;
    const newState = await shop.toggleSpin();
    return bot.sendMessage(msg.chat.id, cb([
      '[ ＳＹＳＴＥＭ : SPIN STATUS ]',
      '──────────────────────────────────',
      newState
        ? '✅ بوابة الاستدعاء : مفتوحة  🟢'
        : '🔒 بوابة الاستدعاء : مغلقة   🔴',
    ]), { parse_mode: 'MarkdownV2' });
  });

  bot.onText(/^\$addspin (.+)/i, async (msg, match) => {
    if (!(await isAdmin(msg.from.id))) return;

    const parts = match[1].split('|').map(s => s.trim());
    if (parts.length < 3) {
      return bot.sendMessage(msg.chat.id, cb([
        '[ USAGE ]',
        '$addspin Name | Rarity | DropRate | PricePerSpin',
        '',
        'Rarity    : common / rare / epic / legendary',
        'DropRate  : 0.01 = 1%,  0.5 = 50%',
        'PricePerSpin : اختياري (افتراضي 100 MG)',
      ]), { parse_mode: 'MarkdownV2' });
    }

    const [name, rarity, dropRateStr, priceStr] = parts;

    if (!VALID_RARITY.includes(rarity)) {
      return bot.sendMessage(msg.chat.id, cb(['[ ERROR ]', `الندرة "${rarity}" غير صحيحة.`]), { parse_mode: 'MarkdownV2' });
    }

    const dropRate = parseFloat(dropRateStr);
    if (isNaN(dropRate) || dropRate <= 0) {
      return bot.sendMessage(msg.chat.id, cb(['[ ERROR ]', 'DropRate يجب أن يكون رقماً موجباً مثل: 0.05']), { parse_mode: 'MarkdownV2' });
    }

    await shop.addSpinItem(name, rarity, dropRate, parseInt(priceStr) || 100);

    return bot.sendMessage(msg.chat.id, cb([
      '[ ＳＹＳＴＥＭ : SUCCESS ]',
      `✅ أضيف للسحب    : ${name}`,
      `📊 الندرة        : ${RARITY_EMOJI[rarity]} ${rarity}`,
      `🎲 نسبة الظهور   : ${(dropRate * 100).toFixed(2)}%`,
      `🟡 سعر السحبة    : ${parseInt(priceStr) || 100} MG`,
    ]), { parse_mode: 'MarkdownV2' });
  });
}

// ── register & callback entry points ─────────────────────────────────────────

function register(bot) {
  bot.onText(/^\$shop$/i, async (msg) => {
    if (!(await requireDm(bot, msg))) return;
    await sendMainMenu(bot, msg.chat.id, msg.from.id);
  });

  bot.onText(/^\$(inventory|bag)$/i, async (msg) => {
    if (!(await requireDm(bot, msg))) return;
    await showInventory(bot, msg.chat.id, msg.from.id);
  });

  bot.onText(/^\$spin$/i, async (msg) => {
    await sendSpinMenu(bot, msg.chat.id, msg.from.id);
  });

  bot.onText(/^\$use\s+(.+)$/i, (msg, match) => handleUse(bot, msg, match[1].trim()));

  registerAdminCommands(bot);
}

// ── use flow ($use [ItemName]) ────────────────────────────────────────────────

async function handleUse(bot, msg, itemName) {
  const chatId = msg.chat.id;
  const tid = msg.from.id;

  if (!(await requireDm(bot, msg))) return;

  const player = await getPlayer(tid);
  if (!player) return;

  const item = await db.queryOne(
    `SELECT si.*, 
            COALESCE(pi.quantity, 0) as inv_qty, 
            COALESCE(pr.quantity, 0) as res_qty
     FROM shop_items si 
     LEFT JOIN player_inventory pi ON si.id = pi.item_id AND pi.player_id = ?
     LEFT JOIN player_resources pr ON si.name = pr.resource_type AND pr.player_id = ?
     WHERE si.name = ? AND (pi.quantity > 0 OR pr.quantity > 0) LIMIT 1`,
    [player.id, player.id, itemName]
  );

  if (!item) {
    return bot.sendMessage(chatId, cb(['[ ＳＹＳＴＥＭ ]', `❌ لا تملك هذا العنصر في حقيبتك:`, `> ${itemName}`]), { parse_mode: 'MarkdownV2' });
  }

  if (['stats', 'poison', 'reflect', 'almighty', 'stun', 'weapon'].includes(item.target_type) && item.target_type !== 'none') {
    if (item.target_type === 'stats') {
      try {
        const result = await shop.useItem(player.id, item.name);
        return bot.sendMessage(chatId, cb([
          '[ ＳＹＳＴＥＭ : SUCCESS ]',
          '──────────────────────────────────',
          `✅ تم استخدام : ${item.name}`,
          `📝 النتيجة   : ${result.message}`,
          '──────────────────────────────────'
        ]), { parse_mode: 'MarkdownV2' });
      } catch (err) {
        return bot.sendMessage(chatId, cb(['[ ERROR ]', err.message]), { parse_mode: 'MarkdownV2' });
      }
    }

    session.setSession(tid, 'use_enhancer', 'awaiting_card_id', { itemName: item.name });
    return bot.sendMessage(chatId, cb([
      '[ ＳＹＳＴＥＭ ]',
      `⚡ تفعيل: ${item.name}`,
      '──────────────────────────────────',
      'يرجى إرسال ID البطاقة التي تريد تطويرها',
      '(أو قم بتصوير الـ QR الخاص بها الآن).',
      '──────────────────────────────────'
    ]), { parse_mode: 'MarkdownV2' });
  }

  try {
    const result = await shop.useItem(player.id, item.name);
    return bot.sendMessage(chatId, cb([
      '[ ＳＹＳＴＥＭ : SUCCESS ]',
      `✅ تم استخدام : ${item.name}`,
      `📝 النتيجة   : ${result.message}`
    ]), { parse_mode: 'MarkdownV2' });
  } catch (err) {
    return bot.sendMessage(chatId, cb(['[ ERROR ]', err.message]), { parse_mode: 'MarkdownV2' });
  }
}

// ── use step (card enhancer: receive card ID) ─────────────────────────────────

async function handleUseStep(bot, msg) {
  const tid = msg.from.id;
  const s = session.getSession(tid);
  if (s.action !== 'use_enhancer') return false;

  const cardId = (msg.text || '').trim().toUpperCase();

  // ✅ FIX: fetch player to get internal player.id instead of passing telegram tid
  const player = await getPlayer(tid);
  if (!player) {
    session.clearSession(tid);
    return bot.sendMessage(msg.chat.id, cb(['[ ERROR ]', 'غير مسجل. استخدم /login أولاً.']), { parse_mode: 'MarkdownV2' });
  }

  try {
    const result = await shop.useItem(player.id, s.data.itemName, cardId); // ✅ player.id لا tid
    session.clearSession(tid);

    return bot.sendMessage(msg.chat.id, cb([
      '[ ＳＹＳＴＥＭ : ENHANCEMENT SUCCESS ]',
      '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
      `   تم دمج: ${s.data.itemName}`,
      `   مع البطاقة: ${cardId}`,
      '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
      `✨ النتيجة: +${result.boostValue} قوة إضافية!`,
      `📊 الحالة الحالية: تم التحديث بنجاح.`
    ]), { parse_mode: 'MarkdownV2' });
  } catch (err) {
    session.clearSession(tid);
    return bot.sendMessage(msg.chat.id, cb(['[ ＳＹＳＴＥＭ : ERROR ]', `❌ ${err.message}`]), { parse_mode: 'MarkdownV2' });
  }
}

async function handleCallback(bot, query) {
  const { data } = query;
  if (data === 'shop_main')            return editMainMenu(bot, query);
  if (data.startsWith('shop_tier_'))   return showTierItems(bot, query, data.slice(10));
  if (data.startsWith('shop_item_'))   return showItemDetail(bot, query, parseInt(data.slice(10), 10));
  if (data.startsWith('shop_buy_'))    return handleBuy(bot, query, parseInt(data.slice(9), 10));
  if (data === 'spin_menu')            return editSpinMenu(bot, query);
  if (data === 'spin_do_1')            return handleSpin(bot, query, 1);
  if (data === 'spin_do_10')           return handleSpin(bot, query, 10);
}

module.exports = { register, handleCallback, handleUseStep };