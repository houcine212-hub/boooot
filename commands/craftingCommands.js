'use strict';

/**
 * craftingCommands.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Telegram bot commands for the Dynamic Resource & Crafting Engine.
 *
 * Admin Commands (emperor+):
 *   $addRes [Key] | [Name] | [Emoji] | [Desc]   — register a new material
 *   $resList                                     — show System Catalog
 *   $delRes [Key]                                — delete a material
 *   $setRule [Name] | [iron:10,gold:5] | [MG] | [Type] | [Data JSON]
 *   $addLoot [Source] | [ResKey] | [Min] | [Max] | [Rate]
 *
 * Player Commands (DM only):
 *   $forge                                       — open Forging Window
 *   $bag                                         — show resource bag
 */

const db           = require('../db/connection');
const session      = require('../middleware/sessionManager');
const rankSystem   = require('../utils/rankSystem');
const crafting     = require('../utils/craftingEngine');

// ─────────────────────────────────────────────────────────────────────────────
// UI helpers — Solo Leveling dark code-block aesthetic
// ─────────────────────────────────────────────────────────────────────────────

/** Wrap an array of lines into a MarkdownV2 code block. */
function cb(lines) {
  return '```text\n' + lines.join('\n') + '\n```';
}

/** DM-only guard. Returns false and warns if in a group. */
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

/** Check admin level (emperor+). */
async function isAdmin(telegramId) {
  return rankSystem.hasRank(telegramId, 'emperor');
}

/** Fetch a player row by telegram ID. */
async function getPlayer(telegramId) {
  return db.queryOne('SELECT * FROM players WHERE telegram_id = ? LIMIT 1', [telegramId]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: $addRes
// ─────────────────────────────────────────────────────────────────────────────

function registerAddRes(bot) {
  bot.onText(/^\$addRes (.+)/i, async (msg, match) => {
    if (!(await isAdmin(msg.from.id))) return;

    const parts = match[1].split('|').map(s => s.trim());
    if (parts.length < 2) {
      return bot.sendMessage(msg.chat.id, cb([
        '[ USAGE ]',
        '$addRes [Key] | [Name] | [Emoji] | [Description]',
        '',
        'Key   : حروف صغيرة بدون مسافات مثل: iron',
        'Name  : الاسم المعروض مثل: خام الحديد',
        'Emoji : اختياري',
        'Desc  : وصف اختياري',
      ]), { parse_mode: 'MarkdownV2' });
    }

    const [key, name, emoji, ...descParts] = parts;
    const description = descParts.join('|').trim();

    try {
      const id = await crafting.addResource(key, name, emoji || '🔹', description);
      return bot.sendMessage(msg.chat.id, cb([
        '[ ＳＹＳＴＥＭ : RESOURCE REGISTERED ]',
        '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
        `   ${emoji || '🔹'} ${name} مسجلة في الكون!`,
        '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
        `🔑 المفتاح   : ${key}`,
        `🆔 ID        : #${id}`,
        description ? `📜 الوصف    : ${description}` : '',
      ].filter(l => l !== '')), { parse_mode: 'MarkdownV2' });
    } catch (err) {
      return bot.sendMessage(msg.chat.id, cb([
        '[ ＳＹＳＴＥＭ : ERROR ]',
        `❌ ${err.message}`,
      ]), { parse_mode: 'MarkdownV2' });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: $resList
// ─────────────────────────────────────────────────────────────────────────────

function registerResList(bot) {
  bot.onText(/^\$resList$/i, async (msg) => {
    if (!(await isAdmin(msg.from.id))) return;

    const resources = await crafting.listResources();
    if (!resources.length) {
      return bot.sendMessage(msg.chat.id, cb([
        '[ ＳＹＳＴＥＭ : RESOURCE CATALOG ]',
        '  لا توجد مواد مسجلة بعد.',
        '  استخدم $addRes لإضافة أولى المواد.',
      ]), { parse_mode: 'MarkdownV2' });
    }

    const lines = [
      '[ ＳＹＳＴＥＭ : RESOURCE CATALOG ]',
      '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
      '   📦 سجل الموارد الكونية',
      '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
      '─────────────────────────────────────',
      ...resources.map(r =>
        `  ${r.emoji} ${r.display_name.padEnd(18)} [${r.resource_key}]`
      ),
      '─────────────────────────────────────',
      `  إجمالي: ${resources.length} مادة مسجلة`,
    ];

    return bot.sendMessage(msg.chat.id, cb(lines), { parse_mode: 'MarkdownV2' });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: $delRes
// ─────────────────────────────────────────────────────────────────────────────

function registerDelRes(bot) {
  bot.onText(/^\$delRes (.+)/i, async (msg, match) => {
    if (!(await isAdmin(msg.from.id))) return;
    const key = match[1].trim().toLowerCase();

    const deleted = await crafting.deleteResource(key);
    if (!deleted) {
      return bot.sendMessage(msg.chat.id, cb([
        '[ ＳＹＳＴＥＭ : ERROR ]',
        `❌ المادة "${key}" غير موجودة في السجل.`,
      ]), { parse_mode: 'MarkdownV2' });
    }
    return bot.sendMessage(msg.chat.id, cb([
      '[ ＳＹＳＴＥＭ : RESOURCE DELETED ]',
      `✅ تم حذف "${key}" من الكون.`,
      '  تم مسح جميع مخزونات اللاعبين من هذه المادة.',
    ]), { parse_mode: 'MarkdownV2' });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: $setRule
// ─────────────────────────────────────────────────────────────────────────────
//
// Usage: $setRule [Name] | [iron:10,gold:5] | [MG] | [Type] | [Data]
// Data examples:
//   resource → iron_bar:5          (resource_key:qty)
//   item     → 3                   (shop_item_id)
//   card     → play,Flame Sword,atk:2000,def:0
//
// ─────────────────────────────────────────────────────────────────────────────

function parseRequirementsStr(str) {
  // "iron:10, gold:5" → { iron: 10, gold: 5 }
  const result = {};
  for (const pair of str.split(',')) {
    const [k, v] = pair.trim().split(':');
    if (k && v) result[k.trim().toLowerCase()] = parseInt(v.trim(), 10) || 1;
  }
  return result;
}

function parseOutputData(outputType, dataStr) {
  if (outputType === 'resource') {
    const [key, qty] = dataStr.split(':');
    return { resource_key: key.trim().toLowerCase(), quantity: parseInt(qty || '1', 10) };
  }
  if (outputType === 'item') {
    return { shop_item_id: parseInt(dataStr.trim(), 10), quantity: 1 };
  }
  if (outputType === 'card') {
    // "play,Flame Sword,atk:2000,def:500,magic:0,spd:0,accuracy:0"
    const parts = dataStr.split(',');
    const card_type = parts[0].trim();
    const name      = parts[1].trim();
    const stats = {};
    for (const p of parts.slice(2)) {
      const [k, v] = p.split(':');
      if (k) stats[k.trim()] = parseInt(v || '0', 10);
    }
    return { card_type, name, ...stats };
  }
  return {};
}

function registerSetRule(bot) {
  bot.onText(/^\$setRule (.+)/i, async (msg, match) => {
    if (!(await isAdmin(msg.from.id))) return;

    const parts = match[1].split('|').map(s => s.trim());
    if (parts.length < 5) {
      return bot.sendMessage(msg.chat.id, cb([
        '[ USAGE ]',
        '$setRule [Name] | [iron:10,gold:5] | [MG] | [Type] | [Data]',
        '',
        'Type  : resource | item | card',
        '',
        'Data بحسب النوع:',
        '  resource → iron_bar:5',
        '  item     → [shop_item_id]',
        '  card     → play,SwordName,atk:2000,def:500',
      ]), { parse_mode: 'MarkdownV2' });
    }

    const [name, reqStr, mgStr, outputType, dataStr] = parts;
    const inputRequirements = parseRequirementsStr(reqStr);
    const mgCost = parseInt(mgStr, 10) || 0;
    const outputData = parseOutputData(outputType, dataStr);

    const player = await getPlayer(msg.from.id);

    try {
      await crafting.setRule(name, inputRequirements, mgCost, outputType, outputData, player?.id);

      const reqDisplay = Object.entries(inputRequirements)
        .map(([k, v]) => `${v}x ${k}`)
        .join(' + ');

      return bot.sendMessage(msg.chat.id, cb([
        '[ ＳＹＳＴＥＭ : LAW OF CREATION DEFINED ]',
        '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
        `   ⚗️ "${name}" ← قانون جديد!`,
        '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
        `📥 المدخلات : ${reqDisplay}`,
        `🟡 التكلفة  : ${mgCost} MG`,
        `📤 المخرج   : [${outputType}] ${dataStr}`,
      ]), { parse_mode: 'MarkdownV2' });
    } catch (err) {
      return bot.sendMessage(msg.chat.id, cb([
        '[ ＳＹＳＴＥＭ : ERROR ]',
        `❌ ${err.message}`,
      ]), { parse_mode: 'MarkdownV2' });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: $addLoot
// ─────────────────────────────────────────────────────────────────────────────

function registerAddLoot(bot) {
  bot.onText(/^\$addLoot (.+)/i, async (msg, match) => {
    if (!(await isAdmin(msg.from.id))) return;

    const parts = match[1].split('|').map(s => s.trim());
    if (parts.length < 5) {
      return bot.sendMessage(msg.chat.id, cb([
        '[ USAGE ]',
        '$addLoot [Source] | [ResKey] | [Min] | [Max] | [Rate]',
        '',
        'مثال:',
        '$addLoot bot_level_1 | iron | 1 | 3 | 0.5',
        '',
        'Source : bot_level_1 / pvp / loot_pvp / event_X',
        'Rate   : 0.01 = 1%   |  0.5 = 50%  |  1.0 = 100%',
      ]), { parse_mode: 'MarkdownV2' });
    }

    const [source, resKey, minStr, maxStr, rateStr] = parts;
    try {
      const id = await crafting.addLoot(
        source, resKey,
        parseInt(minStr, 10) || 1,
        parseInt(maxStr, 10) || 1,
        parseFloat(rateStr) || 0.5
      );
      const res = await crafting.getResource(resKey.toLowerCase());
      return bot.sendMessage(msg.chat.id, cb([
        '[ ＳＹＳＴＥＭ : LOOT RULE ADDED ]',
        `✅ قاعدة عشوائية جديدة — ID #${id}`,
        `📍 المصدر   : ${source}`,
        `${res?.emoji || '🔹'} المادة   : ${res?.display_name || resKey}`,
        `📦 الكمية   : ${minStr} – ${maxStr}`,
        `🎲 الاحتمال : ${(parseFloat(rateStr) * 100).toFixed(0)}%`,
      ]), { parse_mode: 'MarkdownV2' });
    } catch (err) {
      return bot.sendMessage(msg.chat.id, cb([
        '[ ＳＹＳＴＥＭ : ERROR ]',
        `❌ ${err.message}`,
      ]), { parse_mode: 'MarkdownV2' });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Player: $resBag / $resources  — show resource bag
// ─────────────────────────────────────────────────────────────────────────────

function registerResBag(bot) {
  bot.onText(/^\$(resBag|resources)$/i, async (msg) => {
    if (!(await requireDm(bot, msg))) return;
    const player = await getPlayer(msg.from.id);
    if (!player) return bot.sendMessage(msg.chat.id, cb(['[ ERROR ]', 'غير مسجل. استخدم $login أولاً.']), { parse_mode: 'MarkdownV2' });

    const bag = await crafting.getPlayerBag(player.id);
    if (!bag.length) {
      return bot.sendMessage(msg.chat.id, cb([
        '[ ＳＹＳＴＥＭ : RESOURCE BAG ]',
        `👤 ${player.character_name}`,
        '══════════════════════════════════',
        '  حقيبة الموارد فارغة.',
        '  اكسب مواد من المعارك أو المحل!',
        '══════════════════════════════════',
      ]), { parse_mode: 'MarkdownV2' });
    }

    const lines = [
      '[ ＳＹＳＴＥＭ : RESOURCE BAG ]',
      `👤 ${player.character_name}`,
      '══════════════════════════════════',
      ...bag.map(r => `  ${r.emoji || '🔹'} ${(r.display_name || r.resource_key).padEnd(20)} ×${r.quantity}`),
      '══════════════════════════════════',
      `  إجمالي: ${bag.length} نوع`,
    ];
    return bot.sendMessage(msg.chat.id, cb(lines), { parse_mode: 'MarkdownV2' });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Player: $forge — open the Forging Window
// ─────────────────────────────────────────────────────────────────────────────

async function sendForgeWindow(bot, chatId, player) {
  const rules = await crafting.listRules();
  const bag   = await crafting.getPlayerBag(player.id);
  const bagMap = {};
  for (const r of bag) bagMap[r.resource_key] = r.quantity;

  if (!rules.length) {
    return bot.sendMessage(chatId, cb([
      '[ ＳＹＳＴＥＭ : FORGE ]',
      '══════════════════════════════════',
      '  لا توجد قوانين صنع بعد.',
      '  انتظر حتى يضع الإمبراطور قوانين.',
      '══════════════════════════════════',
    ]), { parse_mode: 'MarkdownV2' });
  }

  // Build inline keyboard: one button per rule
  const keyboard = {
    inline_keyboard: [
      ...rules.map(r => {
        const req = typeof r.input_requirements === 'object'
          ? r.input_requirements
          : JSON.parse(r.input_requirements || '{}');
        const canForge = Object.entries(req).every(([k, v]) => (bagMap[k] || 0) >= v);
        return [{ text: `${canForge ? '✅' : '❌'} ${r.rule_name}`, callback_data: `forge_detail_${r.id}` }];
      }),
    ],
  };

  const lines = [
    '[ ＳＹＳＴＥＭ : FORGE — BLUEPRINTS ]',
    '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
    '   ⚗️  مصنع الكون — قوانين الخلق',
    '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
    `👤 الكيان   : ${player.character_name}`,
    `🟡 الرصيد   : ${player.mg_balance} MG`,
    '──────────────────────────────────',
    '✅ = تملك المواد  |  ❌ = مواد ناقصة',
    '──────────────────────────────────',
    `  ${rules.length} قانون متاح — اضغط لعرض التفاصيل`,
  ];

  return bot.sendMessage(chatId, cb(lines), {
    parse_mode: 'MarkdownV2',
    reply_markup: keyboard,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Callback: forge_detail_X  /  forge_confirm_X
// ─────────────────────────────────────────────────────────────────────────────

async function handleForgeCallback(bot, query) {
  const { data, from, message } = query;
  const chatId = message.chat.id;
  const player = await getPlayer(from.id);
  if (!player) return bot.answerCallbackQuery(query.id, { text: '⚠️ غير مسجل', show_alert: true });

  // ── Detail view ──────────────────────────────────────────────────────────
  if (data.startsWith('forge_detail_')) {
    const ruleId = parseInt(data.slice(13), 10);
    const rule   = await crafting.getRule(ruleId);
    if (!rule) return bot.answerCallbackQuery(query.id, { text: '❌ القانون غير موجود', show_alert: true });

    const req    = typeof rule.input_requirements === 'object' ? rule.input_requirements : JSON.parse(rule.input_requirements || '{}');
    const bag    = await crafting.getPlayerBag(player.id);
    const bagMap = {};
    for (const r of bag) bagMap[r.resource_key] = r.quantity;

    const lines = [
      `[ ＳＹＳＴＥＭ : BLUEPRINT — ${rule.rule_name} ]`,
      '┌──────────────────────────────────',
      '│ 📥 المدخلات المطلوبة:',
    ];

    let canForge = player.mg_balance >= rule.mg_cost;
    for (const [key, qty] of Object.entries(req)) {
      const have = bagMap[key] || 0;
      const ok   = have >= qty;
      if (!ok) canForge = false;
      const res = await crafting.getResource(key);
      lines.push(`│  ${ok ? '✅' : '❌'} ${res?.emoji || '🔹'} ${res?.display_name || key}: ${have}/${qty}`);
    }

    lines.push('├──────────────────────────────────');
    if (rule.mg_cost > 0) {
      const mgOk = player.mg_balance >= rule.mg_cost;
      if (!mgOk) canForge = false;
      lines.push(`│ 🟡 التكلفة: ${player.mg_balance}/${rule.mg_cost} MG ${mgOk ? '✅' : '❌'}`);
    }
    lines.push('├──────────────────────────────────');
    lines.push(`│ 📤 المخرج: [${rule.output_type}]`);
    lines.push('└──────────────────────────────────');

    return bot.editMessageText(cb(lines), {
      chat_id: chatId,
      message_id: message.message_id,
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          canForge
            ? [{ text: '⚗️ صنع الآن!', callback_data: `forge_confirm_${ruleId}` }]
            : [{ text: '❌ مواد غير كافية', callback_data: 'forge_noop' }],
          [{ text: '🔙 رجوع', callback_data: 'forge_back' }],
        ],
      },
    });
  }

  // ── Confirm forge ─────────────────────────────────────────────────────────
  if (data.startsWith('forge_confirm_')) {
    const ruleId = parseInt(data.slice(14), 10);

    // Show animation
    await bot.editMessageText(cb([
      '[ ＳＹＳＴＥＭ : FORGING... ]',
      '══════════════════════════════════',
      '  ◆ ◆ ◆   دمج العناصر...   ◆ ◆ ◆',
      '  █████████░░░░░░░░░░  47%',
      '  ██████████████░░░░░  72%',
      '  ████████████████████ 100%',
      '══════════════════════════════════',
    ]), {
      chat_id: chatId,
      message_id: message.message_id,
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: [] },
    });

    await new Promise(r => setTimeout(r, 1600));

    try {
      const result = await crafting.executeForge(player.id, ruleId);
      return bot.editMessageText(cb([
        '[ ＳＹＳＴＥＭ : CRAFTING SUCCESS ]',
        '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
        '   تم دمج العناصر بنجاح!',
        `   العنصر المكتسب: ${result.outputSummary}`,
        `   القانون: "${result.rule.rule_name}"`,
        '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
        result.rule.mg_cost > 0 ? `🟡 تم خصم: ${result.rule.mg_cost} MG` : '',
      ].filter(Boolean)), {
        chat_id: chatId,
        message_id: message.message_id,
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [[{ text: '⚗️ صنع مجدداً', callback_data: 'forge_back' }]],
        },
      });
    } catch (err) {
      return bot.editMessageText(cb([
        '[ ＳＹＳＴＥＭ : FORGE FAILED ]',
        '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
        `   ❌ ${err.message}`,
        '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
      ]), {
        chat_id: chatId,
        message_id: message.message_id,
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'forge_back' }]],
        },
      });
    }
  }

  // ── Back to forge window ──────────────────────────────────────────────────
  if (data === 'forge_back') {
    const rules = await crafting.listRules();
    const bag   = await crafting.getPlayerBag(player.id);
    const bagMap = {};
    for (const r of bag) bagMap[r.resource_key] = r.quantity;

    const keyboard = {
      inline_keyboard: rules.map(r => {
        const req = typeof r.input_requirements === 'object'
          ? r.input_requirements
          : JSON.parse(r.input_requirements || '{}');
        const canForge = Object.entries(req).every(([k, v]) => (bagMap[k] || 0) >= v);
        return [{ text: `${canForge ? '✅' : '❌'} ${r.rule_name}`, callback_data: `forge_detail_${r.id}` }];
      }),
    };

    return bot.editMessageText(cb([
      '[ ＳＹＳＴＥＭ : FORGE — BLUEPRINTS ]',
      '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
      '   ⚗️  مصنع الكون — قوانين الخلق',
      '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
      `👤 ${player.character_name}   🟡 ${player.mg_balance} MG`,
      '──────────────────────────────────',
      `  ${rules.length} قانون متاح`,
    ]), {
      chat_id: chatId,
      message_id: message.message_id,
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
    });
  }

  // noop
  if (data === 'forge_noop') {
    return bot.answerCallbackQuery(query.id, { text: 'مواد غير كافية للصنع!', show_alert: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Register all commands
// ─────────────────────────────────────────────────────────────────────────────

function register(bot) {
  // Admin
  registerAddRes(bot);
  registerResList(bot);
  registerDelRes(bot);
  registerSetRule(bot);
  registerAddLoot(bot);

  // Player
  registerResBag(bot);

  // $forge — DM only
  bot.onText(/^\$forge$/i, async (msg) => {
    if (!(await requireDm(bot, msg))) return;
    const player = await getPlayer(msg.from.id);
    if (!player) {
      return bot.sendMessage(msg.chat.id, cb(['[ ERROR ]', 'غير مسجل. استخدم $login أولاً.']), { parse_mode: 'MarkdownV2' });
    }
    await sendForgeWindow(bot, msg.chat.id, player);
  });
}

module.exports = { register, handleForgeCallback };