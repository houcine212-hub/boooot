// commands/storyManager.js
// Admin tools:  $addSeason  $editSeason  $delSeason
//               $addNode    $editNode    $delNode    $setNodeImage
//               $addChoice  $delChoices
//               $scriptBattle  $delBattle
//               $setRawi    $removeRawi
//               $monsterCard
// Player tools: $story
// Callbacks:    story_choice_*  story_battle_*
//               mc_type_*  mc_plctype_*

'use strict';

const db          = require('../db/connection');
const permissions = require('../utils/permissions');
const rankSystem  = require('../utils/rankSystem');
const engine      = require('../utils/storyEngine');
const economy     = require('../utils/economy');
const botFight    = require('../handlers/botFight');
const session     = require('../middleware/sessionManager');
const { sendQR } = require('../utils/qrHelper'); 

const { generateIdentityCardId } = require('../utils/idGenerator');
const { TOTAL_IDENTITY_POINTS, PLAY_TYPE_LABELS } = require('../utils/constants');

let createPlayCardWithAllocation, InsufficientPlayCardResourcesError;
try {
  const svc = require('../services/playCardAllocationService');
  createPlayCardWithAllocation        = svc.createPlayCardWithAllocation;
  InsufficientPlayCardResourcesError  = svc.InsufficientPlayCardResourcesError;
} catch {
  createPlayCardWithAllocation       = null;
  InsufficientPlayCardResourcesError = null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const STORY_ADMIN_ONLY =
  '🚫 هذا الأمر مخصص للراوي، الأمير، والإمبراطور فقط.';

const NO_STORY_YET =
  '[ ＳＹＳＴＥＭ ] القصة لم تبدأ بعد، يرجى الانتظار حتى يفتح الإمبراطور الموسم الأول.';

// ─── Tutorial Boss targets ────────────────────────────────────────────────────
// Any nodeKey matching one of these is routed to tutorial_boss_cards instead
// of story_battles.  Must stay in sync with engine.TUTORIAL_BOSS_TYPES.
const TUTORIAL_BOSS_TYPES = new Set(['nitron', 'monster_x']);

/** Human-readable label for display in confirmation messages. */
function tutorialBossLabel(bossType) {
  return bossType === 'nitron' ? '⚡ Nitron' : '👾 Monster X';
}

function split(text, sep = '|') {
  return text.split(sep).map(s => s.trim());
}

async function guardAdmin(bot, chatId, tid) {
  if (await rankSystem.isStoryAdmin(tid)) return true;
  await bot.sendMessage(chatId, STORY_ADMIN_ONLY);
  return false;
}

async function guardRoleAssigner(bot, chatId, tid) {
  if (await rankSystem.canAssignSpecialRoles(tid)) return true;
  await bot.sendMessage(chatId, '🚫 هذا الأمر للإمبراطور والأوفرلورد فقط.');
  return false;
}

// ─── Solo Leveling system-panel wrapper ──────────────────────────────────────
function systemPanel(text) {
  return `\`\`\`\n◈ ══════[ ＳＹＳＴＥＭ ]══════ ◈\n\n${text}\n\n◈ ═══════════════════════════ ◈\n\`\`\``;
}

// ─── Monster card stat definitions ───────────────────────────────────────────
const IDC_STATS       = ['hp', 'atk', 'def', 'spd', 'accuracy'];
const IDC_STAT_LABELS = {
  hp:       '❤️ HP',
  atk:      '⚔️ ATK',
  def:      '🛡️ DEF',
  spd:      '💨 SPD',
  accuracy: '🎯 Accuracy',
};

const PLC_TYPE_STATS = {
  attack:  [['atk',   '⚔️ ATK',    'ic_atk'],      ['accuracy', '🎯 Accuracy', 'ic_accuracy']],
  magic:   [['magic', '✨ Magic',   'ic_magic'],     ['accuracy', '🎯 Accuracy', 'ic_accuracy']],
  defense: [['def',   '🛡️ DEF',    'ic_def'],       ['spd',      '💨 SPD',      'ic_spd'     ]],
};

// ═══════════════════════════════════════════════════════════════════════════════
// SEASON COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleAddSeason(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text } = msg;
  if (!await guardAdmin(bot, chatId, tid)) return;

  const name = text.replace(/^\$addSeason\s*/i, '').trim();
  if (!name) {
    return bot.sendMessage(chatId, '⚠️ الاستخدام: `$addSeason [اسم الموسم]`', { parse_mode: 'Markdown' });
  }

  const result = await db.query(
    `INSERT INTO story_seasons (season_name, is_active) VALUES (?, 1)`,
    [name]
  );
  await bot.sendMessage(chatId,
    `✅ الموسم أُنشئ!\n📖 *${name}*\n🆔 Season ID: \`${result.insertId}\``,
    { parse_mode: 'Markdown' }
  );
}

async function handleEditSeason(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text } = msg;
  if (!await guardAdmin(bot, chatId, tid)) return;

  const raw   = text.replace(/^\$editSeason\s*/i, '').trim();
  const parts = split(raw);
  if (parts.length < 2) {
    return bot.sendMessage(chatId,
      '⚠️ الاستخدام: `$editSeason [SeasonID] | [الاسم الجديد]`',
      { parse_mode: 'Markdown' }
    );
  }

  const seasonId = parseInt(parts[0], 10);
  const newName  = parts.slice(1).join('|');

  const season = await db.queryOne(`SELECT id FROM story_seasons WHERE id = ?`, [seasonId]);
  if (!season) {
    return bot.sendMessage(chatId, `❌ لا يوجد موسم بـ ID: \`${seasonId}\``, { parse_mode: 'Markdown' });
  }

  await db.query(`UPDATE story_seasons SET season_name = ? WHERE id = ?`, [newName, seasonId]);
  await bot.sendMessage(chatId,
    `✅ تم تحديث اسم الموسم \`${seasonId}\` إلى *${newName}*`,
    { parse_mode: 'Markdown' }
  );
}

async function handleDelSeason(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text } = msg;
  if (!await guardAdmin(bot, chatId, tid)) return;

  const seasonId = parseInt(text.replace(/^\$delSeason\s*/i, '').trim(), 10);
  if (!seasonId) {
    return bot.sendMessage(chatId, '⚠️ الاستخدام: `$delSeason [SeasonID]`', { parse_mode: 'Markdown' });
  }

  const season = await db.queryOne(`SELECT id FROM story_seasons WHERE id = ?`, [seasonId]);
  if (!season) {
    return bot.sendMessage(chatId, `❌ لا يوجد موسم بـ ID: \`${seasonId}\``, { parse_mode: 'Markdown' });
  }

  await db.query(
    `DELETE sc FROM story_choices sc
       JOIN story_nodes sn ON sn.id = sc.node_id
      WHERE sn.season_id = ?`,
    [seasonId]
  );
  await db.query(
    `DELETE sb FROM story_battles sb
       JOIN story_nodes sn ON sn.id = sb.node_id
      WHERE sn.season_id = ?`,
    [seasonId]
  );
  await db.query(`DELETE FROM story_nodes WHERE season_id = ?`, [seasonId]);
  await db.query(`DELETE FROM story_seasons WHERE id = ?`, [seasonId]);

  await bot.sendMessage(chatId,
    `🗑️ تم حذف الموسم \`${seasonId}\` وجميع نوداته.`,
    { parse_mode: 'Markdown' }
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// NODE COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleAddNode(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text, reply_to_message: reply } = msg;
  if (!await guardAdmin(bot, chatId, tid)) return;

  const raw   = (text || '').replace(/^\$addNode\s*/i, '').trim();
  const parts = split(raw);
  if (parts.length < 3) {
    return bot.sendMessage(chatId,
      '⚠️ الاستخدام:\n`$addNode [SeasonID] | [node_key] | [النص]`\n\nأرسله كـ reply على صورة لتعيين الصورة تلقائياً.',
      { parse_mode: 'Markdown' }
    );
  }

  const [seasonIdStr, nodeKey, ...textParts] = parts;
  const seasonId      = parseInt(seasonIdStr, 10);
  const narrativeText = textParts.join('|');

  let imageId = null;
  if (reply?.photo) {
    imageId = reply.photo[reply.photo.length - 1].file_id;
  }

  const season = await db.queryOne(`SELECT id FROM story_seasons WHERE id = ?`, [seasonId]);
  if (!season) {
    return bot.sendMessage(chatId, `❌ لا يوجد موسم بـ ID: \`${seasonId}\``, { parse_mode: 'Markdown' });
  }

  const existing = await db.queryOne(`SELECT id FROM story_nodes WHERE node_key = ?`, [nodeKey]);
  if (existing) {
    return bot.sendMessage(chatId, `❌ المفتاح \`${nodeKey}\` مستخدم مسبقاً.`, { parse_mode: 'Markdown' });
  }

  await db.query(
    `INSERT INTO story_nodes (season_id, node_key, image_id, narrative_text, node_type)
     VALUES (?, ?, ?, ?, 'dialogue')`,
    [seasonId, nodeKey, imageId, narrativeText]
  );

  await bot.sendMessage(chatId,
    `✅ نود جديد!\n🔑 Key: \`${nodeKey}\`\n🖼️ صورة: ${imageId ? '✔️' : '❌ لا توجد'}\n📝 النص مُسجَّل.`,
    { parse_mode: 'Markdown' }
  );
}

async function handleEditNode(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text } = msg;
  if (!await guardAdmin(bot, chatId, tid)) return;

  const raw   = (text || '').replace(/^\$editNode\s*/i, '').trim();
  const parts = split(raw);
  if (parts.length < 2) {
    return bot.sendMessage(chatId,
      '⚠️ الاستخدام: `$editNode [NodeKey] | [النص الجديد]`',
      { parse_mode: 'Markdown' }
    );
  }

  const nodeKey = parts[0];
  const newText = parts.slice(1).join('|');

  const node = await db.queryOne(`SELECT id FROM story_nodes WHERE node_key = ?`, [nodeKey]);
  if (!node) {
    return bot.sendMessage(chatId, `❌ النود \`${nodeKey}\` غير موجود.`, { parse_mode: 'Markdown' });
  }

  await db.query(`UPDATE story_nodes SET narrative_text = ? WHERE node_key = ?`, [newText, nodeKey]);
  await bot.sendMessage(chatId,
    `✅ تم تحديث نص النود \`${nodeKey}\`.`,
    { parse_mode: 'Markdown' }
  );
}

async function handleDelNode(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text } = msg;
  if (!await guardAdmin(bot, chatId, tid)) return;

  const nodeKey = (text || '').replace(/^\$delNode\s*/i, '').trim();
  if (!nodeKey) {
    return bot.sendMessage(chatId, '⚠️ الاستخدام: `$delNode [NodeKey]`', { parse_mode: 'Markdown' });
  }

  const node = await db.queryOne(`SELECT id FROM story_nodes WHERE node_key = ?`, [nodeKey]);
  if (!node) {
    return bot.sendMessage(chatId, `❌ النود \`${nodeKey}\` غير موجود.`, { parse_mode: 'Markdown' });
  }

  await db.query(`DELETE FROM story_choices WHERE node_id = ?`, [node.id]);
  await db.query(`DELETE FROM story_battles WHERE node_id = ?`, [node.id]);
  await db.query(`DELETE FROM story_nodes WHERE id = ?`, [node.id]);

  await bot.sendMessage(chatId,
    `🗑️ تم حذف النود \`${nodeKey}\` مع اختياراته ومعركته.`,
    { parse_mode: 'Markdown' }
  );
}

async function handleSetNodeImage(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text, reply_to_message: reply } = msg;
  if (!await guardAdmin(bot, chatId, tid)) return;

  const nodeKey = (text || '').replace(/^\$setNodeImage\s*/i, '').trim();
  if (!nodeKey) {
    return bot.sendMessage(chatId,
      '⚠️ الاستخدام: `$setNodeImage [node_key]` — أرسله كـ reply على صورة.',
      { parse_mode: 'Markdown' }
    );
  }
  if (!reply?.photo) {
    return bot.sendMessage(chatId, '⚠️ يجب أن يكون الأمر reply على صورة.');
  }

  const imageId = reply.photo[reply.photo.length - 1].file_id;
  const result  = await db.query(
    `UPDATE story_nodes SET image_id = ? WHERE node_key = ?`,
    [imageId, nodeKey]
  );
  if (!result.affectedRows) {
    return bot.sendMessage(chatId, `❌ لم يُعثر على نود بمفتاح \`${nodeKey}\``, { parse_mode: 'Markdown' });
  }

  await bot.sendMessage(chatId, `✅ صورة النود \`${nodeKey}\` مُحدَّثة.`, { parse_mode: 'Markdown' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHOICE COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleAddChoice(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text } = msg;
  if (!await guardAdmin(bot, chatId, tid)) return;

  const raw   = (text || '').replace(/^\$addChoice\s*/i, '').trim();
  const parts = split(raw);
  if (parts.length < 3) {
    return bot.sendMessage(chatId,
      '⚠️ الاستخدام:\n`$addChoice [NodeKey] | [TargetNodeKey] | [نص الزر] | [MG Reward]`',
      { parse_mode: 'Markdown' }
    );
  }

  const [fromKey, toKey, choiceText, mgStr] = parts;
  const mgReward = parseInt(mgStr || '0', 10) || 0;

  const fromNode = await db.queryOne(`SELECT id, node_type FROM story_nodes WHERE node_key = ?`, [fromKey]);
  if (!fromNode) {
    return bot.sendMessage(chatId, `❌ النود \`${fromKey}\` غير موجود.`, { parse_mode: 'Markdown' });
  }
  if (fromNode.node_type === 'battle') {
    return bot.sendMessage(chatId,
      `❌ نود المعركة لا يقبل اختيارات — استخدم \`$scriptBattle\`.`,
      { parse_mode: 'Markdown' }
    );
  }

  if (fromNode.node_type === 'dialogue') {
    await db.query(`UPDATE story_nodes SET node_type = 'choice' WHERE id = ?`, [fromNode.id]);
  }

  await db.query(
    `INSERT INTO story_choices (node_id, choice_text, next_node_key, mg_reward)
     VALUES (?, ?, ?, ?)`,
    [fromNode.id, choiceText, toKey, mgReward]
  );

  await bot.sendMessage(chatId,
    `✅ اختيار مضاف!\n➡️ \`${fromKey}\` → \`${toKey}\`\n🔘 زر: *${choiceText}*\n💰 مكافأة: ${mgReward} MG`,
    { parse_mode: 'Markdown' }
  );
}

async function handleDelChoices(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text } = msg;
  if (!await guardAdmin(bot, chatId, tid)) return;

  const nodeKey = (text || '').replace(/^\$delChoices\s*/i, '').trim();
  if (!nodeKey) {
    return bot.sendMessage(chatId, '⚠️ الاستخدام: `$delChoices [NodeKey]`', { parse_mode: 'Markdown' });
  }

  const node = await db.queryOne(`SELECT id FROM story_nodes WHERE node_key = ?`, [nodeKey]);
  if (!node) {
    return bot.sendMessage(chatId, `❌ النود \`${nodeKey}\` غير موجود.`, { parse_mode: 'Markdown' });
  }

  const result = await db.query(`DELETE FROM story_choices WHERE node_id = ?`, [node.id]);

  await db.query(
    `UPDATE story_nodes SET node_type = 'dialogue' WHERE id = ? AND node_type = 'choice'`,
    [node.id]
  );

  await bot.sendMessage(chatId,
    `🗑️ تم حذف ${result.affectedRows} اختيار(ات) من النود \`${nodeKey}\`.`,
    { parse_mode: 'Markdown' }
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// BATTLE COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleScriptBattle(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text } = msg;
  if (!await guardAdmin(bot, chatId, tid)) return;

  const raw   = (text || '').replace(/^\$scriptBattle\s*/i, '').trim();
  const parts = split(raw);

  if (parts.length < 5) {
    return bot.sendMessage(chatId,
      '⚠️ الاستخدام:\n`$scriptBattle [NodeKey] | [BotIDC] | [PLC-1,PLC-2,...] | [SKL-1,...] | [SuccessKey] | [FailKey]`\n\nيمكن ترك SKL فارغاً.',
      { parse_mode: 'Markdown' }
    );
  }

  const [nodeKey, botIDC, plcStr, sklStr, victoryKey, defeatKey] = parts;

  const node = await db.queryOne(`SELECT id FROM story_nodes WHERE node_key = ?`, [nodeKey]);
  if (!node) {
    return bot.sendMessage(chatId, `❌ النود \`${nodeKey}\` غير موجود.`, { parse_mode: 'Markdown' });
  }

  const idc = await db.queryOne(`SELECT card_id FROM identity_cards WHERE card_id = ?`, [botIDC]);
  if (!idc) {
    return bot.sendMessage(chatId, `❌ بطاقة الهوية \`${botIDC}\` غير موجودة.`, { parse_mode: 'Markdown' });
  }

  const plcIds       = plcStr ? plcStr.split(',').map(s => s.trim()).filter(Boolean) : [];
  const sklIds       = sklStr ? sklStr.split(',').map(s => s.trim()).filter(Boolean) : [];
  const botCardsJson = JSON.stringify({ idc: botIDC, plc: plcIds, skl: sklIds });

  const existing = await db.queryOne(`SELECT id FROM story_battles WHERE node_id = ?`, [node.id]);
  if (existing) {
    await db.query(
      `UPDATE story_battles
          SET bot_cards_json = ?, victory_node_key = ?, defeat_node_key = ?
        WHERE node_id = ?`,
      [botCardsJson, victoryKey, defeatKey, node.id]
    );
  } else {
    await db.query(
      `INSERT INTO story_battles (node_id, bot_cards_json, victory_node_key, defeat_node_key)
       VALUES (?, ?, ?, ?)`,
      [node.id, botCardsJson, victoryKey, defeatKey]
    );
  }

  await db.query(`UPDATE story_nodes SET node_type = 'battle' WHERE id = ?`, [node.id]);

  await bot.sendMessage(chatId,
    `⚔️ معركة مبرمجة!\n🔑 Node: \`${nodeKey}\`\n🧬 IDC: \`${botIDC}\`\n🃏 PLC: ${plcIds.join(', ') || '—'}\n✨ SKL: ${sklIds.join(', ') || '—'}\n✅ فوز → \`${victoryKey}\`\n❌ خسارة → \`${defeatKey}\``,
    { parse_mode: 'Markdown' }
  );
}

async function handleDelBattle(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text } = msg;
  if (!await guardAdmin(bot, chatId, tid)) return;

  const nodeKey = (text || '').replace(/^\$delBattle\s*/i, '').trim();
  if (!nodeKey) {
    return bot.sendMessage(chatId, '⚠️ الاستخدام: `$delBattle [NodeKey]`', { parse_mode: 'Markdown' });
  }

  const node = await db.queryOne(`SELECT id FROM story_nodes WHERE node_key = ?`, [nodeKey]);
  if (!node) {
    return bot.sendMessage(chatId, `❌ النود \`${nodeKey}\` غير موجود.`, { parse_mode: 'Markdown' });
  }

  const result = await db.query(`DELETE FROM story_battles WHERE node_id = ?`, [node.id]);
  if (!result.affectedRows) {
    return bot.sendMessage(chatId, `⚠️ لا توجد معركة مرتبطة بالنود \`${nodeKey}\`.`, { parse_mode: 'Markdown' });
  }

  await db.query(`UPDATE story_nodes SET node_type = 'dialogue' WHERE id = ?`, [node.id]);

  await bot.sendMessage(chatId,
    `🗑️ تم حذف معركة النود \`${nodeKey}\` وتحويله إلى نود حوار.`,
    { parse_mode: 'Markdown' }
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPECIAL ROLE COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleSetRawi(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text } = msg;
  if (!await guardRoleAssigner(bot, chatId, tid)) return;

  const playerCode = (text || '').replace(/^\$setRawi\s*/i, '').trim();
  if (!playerCode) {
    return bot.sendMessage(chatId, '⚠️ الاستخدام: `$setRawi [PlayerCode]`', { parse_mode: 'Markdown' });
  }

  const player = await db.queryOne(
    `SELECT id, character_name FROM players WHERE player_code = ?`,
    [playerCode]
  );
  if (!player) {
    return bot.sendMessage(chatId, `❌ لا يوجد لاعب بالكود: \`${playerCode}\``, { parse_mode: 'Markdown' });
  }

  await db.query(`UPDATE players SET is_rawi = TRUE WHERE id = ?`, [player.id]);

  await bot.sendMessage(chatId,
    `\`\`\`\n[ ＳＹＳＴＥＭ ]\n\nتم منح لقب 'الراوي' للاعب ${player.character_name}.\nهو الآن يمتلك سلطة نسج الأقدار.\n\`\`\``,
    { parse_mode: 'Markdown' }
  );
}

async function handleRemoveRawi(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text } = msg;
  if (!await guardRoleAssigner(bot, chatId, tid)) return;

  const playerCode = (text || '').replace(/^\$removeRawi\s*/i, '').trim();
  if (!playerCode) {
    return bot.sendMessage(chatId, '⚠️ الاستخدام: `$removeRawi [PlayerCode]`', { parse_mode: 'Markdown' });
  }

  const player = await db.queryOne(
    `SELECT id, character_name FROM players WHERE player_code = ?`,
    [playerCode]
  );
  if (!player) {
    return bot.sendMessage(chatId, `❌ لا يوجد لاعب بالكود: \`${playerCode}\``, { parse_mode: 'Markdown' });
  }

  await db.query(`UPDATE players SET is_rawi = FALSE WHERE id = ?`, [player.id]);

  await bot.sendMessage(chatId,
    `\`\`\`\n[ ＳＹＳＴＥＭ ]\n\nتم سحب لقب 'الراوي' من اللاعب ${player.character_name}.\nصلاحياته على السرد أُلغيت.\n\`\`\``,
    { parse_mode: 'Markdown' }
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MONSTER CARD WIZARD  —  $monsterCard [NodeKey | BossType]
//
// Unified entry point for both Story-Battle nodes and Tutorial Bosses.
// • If [Target] is 'nitron' or 'monster_x'  → Tutorial Boss path
//   (saves to tutorial_boss_cards, no story_nodes lookup required)
// • Otherwise                                → Story Node path
//   (existing behaviour: requires a battle node + story_battles row)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Entry point ─────────────────────────────────────────────────────────────
async function handleMonsterCard(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text } = msg;
  if (!await guardAdmin(bot, chatId, tid)) return;

  const nodeKey = (text || '').replace(/^\$monsterCard\s*/i, '').trim().toLowerCase();
  if (!nodeKey) {
    return bot.sendMessage(chatId,
      '⚠️ الاستخدام: `$monsterCard [NodeKey]`\nمثال: `$monsterCard battle_1` أو `$monsterCard nitron`',
      { parse_mode: 'Markdown' }
    );
  }

  // ── Tutorial Boss path ────────────────────────────────────────────────────
  // Skip story_nodes / story_battles checks entirely for known boss targets.
  if (TUTORIAL_BOSS_TYPES.has(nodeKey)) {
    session.setSession(tid, 'monster_card', 'awaiting_card_category', { nodeKey });

    return bot.sendMessage(chatId,
      systemPanel(
        `🔮 إنشاء بطاقة وحش\n` +
        `🎯 الهدف: Tutorial Boss — ${tutorialBossLabel(nodeKey)}\n\n` +
        `اختر نوع البطاقة:`
      ),
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🪪 هوية (IDC)',  callback_data: `mc_type_idc_${nodeKey}`  },
            { text: '⚔️ لعب (PLC)',   callback_data: `mc_type_plc_${nodeKey}`  },
            { text: '🌟 مهارة (SKL)', callback_data: `mc_type_skl_${nodeKey}`  },
          ]]
        }
      }
    );
  }

  // ── Story Node path ───────────────────────────────────────────────────────
  const node = await db.queryOne(
    `SELECT id, node_type FROM story_nodes WHERE node_key = ?`,
    [nodeKey]
  );
  if (!node) {
    return bot.sendMessage(chatId,
      systemPanel(`❌ لا يوجد نود بمفتاح: ${nodeKey}`),
      { parse_mode: 'Markdown' }
    );
  }
  if (node.node_type !== 'battle') {
    return bot.sendMessage(chatId,
      systemPanel(`❌ النود "${nodeKey}" ليس نود معركة.\nاستخدم $scriptBattle أولاً لتحويله.`),
      { parse_mode: 'Markdown' }
    );
  }

  const battle = await engine.getBattleByNodeKey(nodeKey);
  if (!battle) {
    return bot.sendMessage(chatId,
      systemPanel(`❌ لا توجد بيانات معركة للنود "${nodeKey}".\nشغّل $scriptBattle أولاً.`),
      { parse_mode: 'Markdown' }
    );
  }

  session.setSession(tid, 'monster_card', 'awaiting_card_category', { nodeKey });

  await bot.sendMessage(chatId,
    systemPanel(`🔮 إنشاء بطاقة وحش\n🔑 Node: ${nodeKey}\n\nاختر نوع البطاقة:`),
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🪪 هوية (IDC)',  callback_data: `mc_type_idc_${nodeKey}`  },
          { text: '⚔️ لعب (PLC)',   callback_data: `mc_type_plc_${nodeKey}`  },
          { text: '🌟 مهارة (SKL)', callback_data: `mc_type_skl_${nodeKey}`  },
        ]]
      }
    }
  );
}

// ─── Callback: mc_type_[idc|plc|skl]_[NodeKey] ───────────────────────────────
async function handleMonsterCardTypeCallback(bot, query) {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const tid    = from.id;

  const match = data.match(/^mc_type_(idc|plc|skl)_(.+)$/);
  if (!match) return;
  const [, category, nodeKey] = match;

  const s = session.getSession(tid);
  if (!s || s.action !== 'monster_card') return;

  await bot.answerCallbackQuery(query.id);

  if (category === 'idc') {
    session.setSession(tid, 'monster_card', 'mc_idc_awaiting_name', { nodeKey, cardCategory: 'idc' });
    return bot.sendMessage(chatId,
      systemPanel(`🪪 بطاقة هوية الوحش\n🔑 Node: ${nodeKey}\n\nأدخل اسم البطاقة:`),
      { parse_mode: 'Markdown' }
    );
  }

  if (category === 'plc') {
    // Fetch the IDC currently linked to this node/boss — needed for stat caps
    const linkedIDC = await engine.getBattleIDC(nodeKey);
    if (!linkedIDC) {
      return bot.sendMessage(chatId,
        systemPanel(
          `❌ لا توجد بطاقة هوية (IDC) مرتبطة بـ [${nodeKey}] بعد.\n\n` +
          `يجب إنشاء IDC للوحش أولاً قبل إضافة PLC.\n` +
          `استخدم \`$monsterCard ${nodeKey}\` واختر 🪪 هوية (IDC).`
        ),
        { parse_mode: 'Markdown' }
      );
    }

    session.setSession(tid, 'monster_card', 'mc_plc_awaiting_type', {
      nodeKey,
      cardCategory:        'plc',
      identity_card_id:    linkedIDC.id,
      idc_card_id_str:     linkedIDC.card_id,
      // Real available caps drawn directly from the monster's IDC balance
      ic_atk:      linkedIDC.available_atk      ?? 0,
      ic_magic:    linkedIDC.available_magic     ?? 0,
      ic_def:      linkedIDC.available_def       ?? 0,
      ic_spd:      linkedIDC.available_spd       ?? 0,
      ic_accuracy: linkedIDC.available_accuracy  ?? 0,
    });

    return bot.sendMessage(chatId,
      systemPanel(
        `⚔️ بطاقة لعب الوحش\n🔑 Node: ${nodeKey}\n` +
        `🪪 IDC: ${linkedIDC.card_id} — ${linkedIDC.name}\n\n` +
        `📊 الإحصائيات المتاحة:\n` +
        `  ⚔️ ATK: ${linkedIDC.available_atk ?? 0}\n` +
        `  ✨ Magic: ${linkedIDC.available_magic ?? 0}\n` +
        `  🛡️ DEF: ${linkedIDC.available_def ?? 0}\n` +
        `  💨 SPD: ${linkedIDC.available_spd ?? 0}\n` +
        `  🎯 Accuracy: ${linkedIDC.available_accuracy ?? 0}\n\n` +
        `اختر نوع بطاقة اللعب:`
      ),
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '⚔️ هجومية',  callback_data: `mc_plctype_attack_${nodeKey}`  },
            { text: '🛡️ دفاعية', callback_data: `mc_plctype_defense_${nodeKey}` },
            { text: '✨ سحرية',   callback_data: `mc_plctype_magic_${nodeKey}`   },
          ]]
        }
      }
    );
  }

  if (category === 'skl') {
    session.setSession(tid, 'monster_card', 'mc_skl_awaiting_name', { nodeKey, cardCategory: 'skl' });
    return bot.sendMessage(chatId,
      systemPanel(`🌟 بطاقة مهارة الوحش\n🔑 Node: ${nodeKey}\n\nأدخل معرّف المهارة (SKL ID):`),
      { parse_mode: 'Markdown' }
    );
  }
}

// ─── Callback: mc_plctype_[type]_[NodeKey] ───────────────────────────────────
async function handleMonsterCardPlcTypeCallback(bot, query) {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const tid    = from.id;

  const match = data.match(/^mc_plctype_(attack|defense|magic)_(.+)$/);
  if (!match) return;
  const [, plcType, nodeKey] = match;

  const s = session.getSession(tid);
  if (!s || s.action !== 'monster_card') return;

  await bot.answerCallbackQuery(query.id);

  // Real caps come from the monster IDC's available stats, stored in the session
  // when the admin selected PLC from the type menu.
  session.setSession(tid, 'monster_card', 'mc_plc_awaiting_name', {
    ...s.data,
    plcType,
    collected: {}
  });

  return bot.sendMessage(chatId,
    systemPanel(`⚔️ بطاقة لعب الوحش — ${PLAY_TYPE_LABELS[plcType]}\n🔑 Node: ${nodeKey}\n\nأدخل اسم البطاقة:`),
    { parse_mode: 'Markdown' }
  );
}

// ─── Main step handler ────────────────────────────────────────────────────────
async function handleMonsterCardStep(bot, msg) {
  const chatId = msg.chat.id;
  const tid    = msg.from.id;
  const s      = session.getSession(tid);

  if (!s || s.action !== 'monster_card') return false;

  // ── IDC WIZARD ──────────────────────────────────────────────────────────────

  if (s.step === 'mc_idc_awaiting_name') {
    const name = (msg.text || '').trim();
    if (!name || name.length > 100) {
      await bot.sendMessage(chatId, '❌ اسم غير صالح (1-100 حرف).');
      return true;
    }
    session.setSession(tid, 'monster_card', 'mc_idc_stat_0', {
      ...s.data, cardName: name, remaining: TOTAL_IDENTITY_POINTS, stats: {}
    });
    await bot.sendMessage(chatId,
      systemPanel(`📊 توزيع ${TOTAL_IDENTITY_POINTS} نقطة على الوحش\n\n${IDC_STAT_LABELS.hp}:\n💰 المتبقي: ${TOTAL_IDENTITY_POINTS}`),
      { parse_mode: 'Markdown' }
    );
    return true;
  }

  const idcStatMatch = s.step.match(/^mc_idc_stat_(\d+)$/);
  if (idcStatMatch) {
    const idx  = parseInt(idcStatMatch[1], 10);
    const stat = IDC_STATS[idx];
    const val  = parseInt((msg.text || '').trim(), 10);

    if (isNaN(val) || val < 0 || val > s.data.remaining) {
      await bot.sendMessage(chatId, `❌ أدخل رقماً بين 0 و ${s.data.remaining}:`);
      return true;
    }

    const remaining = s.data.remaining - val;
    const stats     = { ...s.data.stats, [stat]: val };

    if (idx < IDC_STATS.length - 1) {
      const next = IDC_STATS[idx + 1];
      session.setSession(tid, 'monster_card', `mc_idc_stat_${idx + 1}`, { ...s.data, remaining, stats });
      await bot.sendMessage(chatId,
        systemPanel(`✅ ${IDC_STAT_LABELS[stat]} = ${val}\n\n${IDC_STAT_LABELS[next]}:\n💰 المتبقي: ${remaining}`),
        { parse_mode: 'Markdown' }
      );
    } else {
      session.setSession(tid, 'monster_card', 'mc_idc_awaiting_magic', { ...s.data, remaining, stats });
      await bot.sendMessage(chatId,
        systemPanel(`✅ ${IDC_STAT_LABELS[stat]} = ${val}\n\n✨ أدخل حد السحر (Magic Cap):\n_لا يُخصم من النقاط_`),
        { parse_mode: 'Markdown' }
      );
    }
    return true;
  }

  if (s.step === 'mc_idc_awaiting_magic') {
    const magicCap = parseInt((msg.text || '').trim(), 10);
    if (isNaN(magicCap) || magicCap < 0) {
      await bot.sendMessage(chatId, '❌ أدخل رقماً صالحاً:');
      return true;
    }
    await _saveMonsterIdc(bot, chatId, tid, { ...s.data, magicCap });
    return true;
  }

  // ── PLC WIZARD ──────────────────────────────────────────────────────────────

  if (s.step === 'mc_plc_awaiting_name') {
    const name = (msg.text || '').trim();
    if (!name || name.length > 100) {
      await bot.sendMessage(chatId, '❌ اسم غير صالح.');
      return true;
    }
    const typeStats         = PLC_TYPE_STATS[s.data.plcType];
    const [, label, limitKey] = typeStats[0];
    session.setSession(tid, 'monster_card', 'mc_plc_stat_0', { ...s.data, cardName: name, collected: {} });
    await bot.sendMessage(chatId,
      systemPanel(`${label}:\n📌 الحد الأقصى: ${s.data[limitKey]}`),
      { parse_mode: 'Markdown' }
    );
    return true;
  }

  const plcStatMatch = s.step.match(/^mc_plc_stat_(\d+)$/);
  if (plcStatMatch) {
    const idx       = parseInt(plcStatMatch[1], 10);
    const typeStats = PLC_TYPE_STATS[s.data.plcType];
    const [key, label, limitKey] = typeStats[idx];
    const max = s.data[limitKey];
    const val = parseInt((msg.text || '').trim(), 10);

    if (isNaN(val) || val < 0 || val > max) {
      await bot.sendMessage(chatId, `❌ أدخل رقماً بين 0 و ${max}:`);
      return true;
    }

    const collected = { ...s.data.collected, [key]: val };

    if (idx < typeStats.length - 1) {
      const [, nextLabel, nextLimitKey] = typeStats[idx + 1];
      session.setSession(tid, 'monster_card', `mc_plc_stat_${idx + 1}`, { ...s.data, collected });
      await bot.sendMessage(chatId,
        systemPanel(`✅ ${label} = ${val}\n\n${nextLabel}:\n📌 الحد الأقصى: ${s.data[nextLimitKey]}`),
        { parse_mode: 'Markdown' }
      );
    } else {
      await _saveMonsterPlc(bot, chatId, tid, { ...s.data, collected });
    }
    return true;
  }

  // ── SKL WIZARD ──────────────────────────────────────────────────────────────

  if (s.step === 'mc_skl_awaiting_name') {
    const sklId = (msg.text || '').trim();
    if (!sklId || sklId.length > 50) {
      await bot.sendMessage(chatId, '❌ معرّف المهارة غير صالح (1-50 حرف).');
      return true;
    }
    await _linkMonsterSkl(bot, chatId, tid, s.data.nodeKey, sklId);
    return true;
  }

  return false;
}

// ─── Internal savers ─────────────────────────────────────────────────────────

async function _saveMonsterIdc(bot, chatId, tid, data) {
  const { nodeKey, cardName, stats, magicCap } = data;
  const { hp, atk, def, spd, accuracy }        = stats;

  const isBoss = engine.isTutorialBoss(nodeKey);

  let botPlayerId;
  try {
    botPlayerId = await engine.getBotSystemPlayerId();
  } catch (e) {
    session.clearSession(tid);
    return bot.sendMessage(chatId,
      systemPanel(`❌ خطأ في النظام: ${e.message}`),
      { parse_mode: 'Markdown' }
    );
  }

  let cardId;
  do {
    cardId = generateIdentityCardId();
  } while (await db.queryOne('SELECT id FROM identity_cards WHERE card_id = ?', [cardId]));

  const used = hp + atk + def + spd + accuracy;

  await db.query(
    `INSERT INTO identity_cards
     (card_id, player_id, name, hp, atk, available_atk, magic, available_magic,
      def, available_def, spd, available_spd, accuracy, available_accuracy,
      total_points, remaining_points)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cardId, botPlayerId, cardName,
      hp,  atk, atk,
      magicCap, magicCap,
      def, def,
      spd, spd,
      accuracy, accuracy,
      TOTAL_IDENTITY_POINTS, TOTAL_IDENTITY_POINTS - used
    ]
  );

  // ── Route to the correct linker ───────────────────────────────────────────
  let updatedCards;
  try {
    updatedCards = isBoss
      ? await engine.linkCardToTutorialBoss(nodeKey, 'idc', cardId)
      : await engine.linkCardToBattle(nodeKey, 'idc', cardId);
  } catch (e) {
    session.clearSession(tid);
    return bot.sendMessage(chatId,
      systemPanel(`✅ تم إنشاء IDC: ${cardId}\n❌ لكن فشل الربط: ${e.message}`),
      { parse_mode: 'Markdown' }
    );
  }

  session.clearSession(tid);

  // ── Build confirmation message ────────────────────────────────────────────
  const targetLine = isBoss
    ? `🎯 Tutorial Boss: ${tutorialBossLabel(nodeKey)}`
    : `🔑 Node: [${nodeKey}]`;

  const cardsLine = isBoss
    ? `📦 tutorial_boss_cards الحالية:\n` +
      `  IDC → ${updatedCards.idc || '—'}\n` +
      `  PLC → [${(updatedCards.plc || []).join(', ') || '—'}]\n` +
      `  SKL → [${(updatedCards.skl || []).join(', ') || '—'}]\n` +
      `  WPN → [${(updatedCards.wpn || []).join(', ') || '—'}]`
    : `📦 bot_cards الحالية:\n` +
      `  IDC → ${updatedCards.idc}\n` +
      `  PLC → [${updatedCards.plc.join(', ') || '—'}]\n` +
      `  SKL → [${updatedCards.skl.join(', ') || '—'}]`;

  const successMsg = isBoss
    ? `✅ ${cardName} linked to Tutorial Boss ${tutorialBossLabel(nodeKey)} successfully!`
    : `[ ＳＹＳＴＥＭ ] تم إنشاء البطاقة وربطها تلقائياً\nبوحش المشهد [${nodeKey}] بنجاح!`;

  await bot.sendMessage(chatId,
    systemPanel(
      `${successMsg}\n\n` +
      `${targetLine}\n\n` +
      `🪪 نوع: هوية (IDC)\n` +
      `🆔 ${cardId}\n` +
      `📛 ${cardName}\n\n` +
      `❤️ HP: ${hp}  ⚔️ ATK: ${atk}  ✨ Magic: ${magicCap}\n` +
      `🛡️ DEF: ${def}  💨 SPD: ${spd}  🎯 Acc: ${accuracy}\n\n` +
      `💰 مستخدم: ${used}/${TOTAL_IDENTITY_POINTS}\n\n` +
      cardsLine
    ),
    { parse_mode: 'Markdown' }
  );
  try { await sendQR(bot, chatId, cardId); } catch (e) {}
}

async function _saveMonsterPlc(bot, chatId, tid, data) {
  const { nodeKey, cardName, plcType, collected, identity_card_id, idc_card_id_str } = data;

  const isBoss = engine.isTutorialBoss(nodeKey);

  // Resolve the numeric player ID that owns the monster's IDC
  let botPlayerId;
  try {
    botPlayerId = await engine.getBotSystemPlayerId();
  } catch (e) {
    session.clearSession(tid);
    return bot.sendMessage(chatId,
      systemPanel(`❌ خطأ في النظام: ${e.message}`),
      { parse_mode: 'Markdown' }
    );
  }

  // Guard: identity_card_id must be present — satisfies the FK constraint
  // and lets the allocation service deduct stats from the monster's IDC balance.
  if (!identity_card_id) {
    session.clearSession(tid);
    return bot.sendMessage(chatId,
      systemPanel(
        `❌ لم يتم تحديد بطاقة الهوية للوحش.\n` +
        `أعد بدء الـ wizard بـ \`$monsterCard ${nodeKey}\`.`
      ),
      { parse_mode: 'Markdown' }
    );
  }

  if (!createPlayCardWithAllocation) {
    session.clearSession(tid);
    return bot.sendMessage(chatId,
      systemPanel(`❌ خدمة إنشاء PLC غير متاحة. تواصل مع المطور.`),
      { parse_mode: 'Markdown' }
    );
  }

  let cardId;
  try {
    const created = await createPlayCardWithAllocation({
      playerId:       botPlayerId,
      identityCardId: identity_card_id,   // numeric FK → links PLC to monster IDC + deducts stats
      cardName,
      type:           plcType,
      stats:          collected,
    });
    cardId = created.cardId;
  } catch (err) {
    session.clearSession(tid);
    if (InsufficientPlayCardResourcesError && err instanceof InsufficientPlayCardResourcesError) {
      return bot.sendMessage(chatId,
        systemPanel(
          `❌ نقاط IDC الوحش غير كافية لهذه البطاقة.\n\n` +
          `تأكد أن الإحصائيات التي أدخلتها لا تتجاوز الرصيد المتاح في IDC الوحش.`
        ),
        { parse_mode: 'Markdown' }
      );
    }
    console.error('[monsterCard] _saveMonsterPlc error:', err.message);
    return bot.sendMessage(chatId,
      systemPanel(`❌ فشل إنشاء PLC: ${err.message}`),
      { parse_mode: 'Markdown' }
    );
  }

  // ── Route to the correct linker ───────────────────────────────────────────
  let updatedCards;
  try {
    updatedCards = isBoss
      ? await engine.linkCardToTutorialBoss(nodeKey, 'plc', cardId)
      : await engine.linkCardToBattle(nodeKey, 'plc', cardId);
  } catch (e) {
    session.clearSession(tid);
    return bot.sendMessage(chatId,
      systemPanel(`✅ تم إنشاء PLC: ${cardId}\n❌ لكن فشل الربط: ${e.message}`),
      { parse_mode: 'Markdown' }
    );
  }

  const statsText = Object.entries(collected).map(([k, v]) => `${k.toUpperCase()}: ${v}`).join('  ');

  session.clearSession(tid);

  // ── Build confirmation message ────────────────────────────────────────────
  const targetLine = isBoss
    ? `🎯 Tutorial Boss: ${tutorialBossLabel(nodeKey)}`
    : `🔑 Node: [${nodeKey}]`;

  const cardsLine = isBoss
    ? `📦 tutorial_boss_cards الحالية:\n` +
      `  IDC → ${updatedCards.idc || '—'}\n` +
      `  PLC → [${(updatedCards.plc || []).join(', ') || '—'}]\n` +
      `  SKL → [${(updatedCards.skl || []).join(', ') || '—'}]\n` +
      `  WPN → [${(updatedCards.wpn || []).join(', ') || '—'}]`
    : `📦 bot_cards الحالية:\n` +
      `  IDC → ${updatedCards.idc || '—'}\n` +
      `  PLC → [${updatedCards.plc.join(', ') || '—'}]\n` +
      `  SKL → [${updatedCards.skl.join(', ') || '—'}]`;

  const successMsg = isBoss
    ? `✅ ${cardName} linked to Tutorial Boss ${tutorialBossLabel(nodeKey)} successfully!`
    : `[ ＳＹＳＴＥＭ ] تم إنشاء البطاقة وربطها تلقائياً\nبوحش المشهد [${nodeKey}] بنجاح!`;

  await bot.sendMessage(chatId,
    systemPanel(
      `${successMsg}\n\n` +
      `${targetLine}\n\n` +
      `⚔️ نوع: بطاقة لعب (PLC) — ${PLAY_TYPE_LABELS[plcType]}\n` +
      `🆔 ${cardId}\n` +
      `📛 ${cardName}\n` +
      `🔗 IDC: ${idc_card_id_str || identity_card_id}\n` +
      `${statsText}\n\n` +
      cardsLine
    ),
    { parse_mode: 'Markdown' }
  );
  try {
    await sendQR(bot, chatId, cardId);
  } catch (e) {
    console.error('[monsterCard] sendQR (PLC) failed:', e.message);
  }
}

async function _linkMonsterSkl(bot, chatId, tid, nodeKey, sklId) {
  const isBoss = engine.isTutorialBoss(nodeKey);

  const skill = await db.queryOne(`SELECT id FROM skill_cards WHERE card_id = ?`, [sklId]);
  if (!skill) {
    await bot.sendMessage(chatId,
      systemPanel(`❌ لا توجد مهارة بمعرّف: ${sklId}\nتحقق من الـ ID وأعد المحاولة.`),
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // ── Route to the correct linker ───────────────────────────────────────────
  let updatedCards;
  try {
    updatedCards = isBoss
      ? await engine.linkCardToTutorialBoss(nodeKey, 'skl', sklId)
      : await engine.linkCardToBattle(nodeKey, 'skl', sklId);
  } catch (e) {
    session.clearSession(tid);
    return bot.sendMessage(chatId,
      systemPanel(`❌ فشل الربط: ${e.message}`),
      { parse_mode: 'Markdown' }
    );
  }

  session.clearSession(tid);

  // ── Build confirmation message ────────────────────────────────────────────
  const targetLine = isBoss
    ? `🎯 Tutorial Boss: ${tutorialBossLabel(nodeKey)}`
    : `🔑 Node: [${nodeKey}]`;

  const cardsLine = isBoss
    ? `📦 tutorial_boss_cards الحالية:\n` +
      `  IDC → ${updatedCards.idc || '—'}\n` +
      `  PLC → [${(updatedCards.plc || []).join(', ') || '—'}]\n` +
      `  SKL → [${(updatedCards.skl || []).join(', ') || '—'}]\n` +
      `  WPN → [${(updatedCards.wpn || []).join(', ') || '—'}]`
    : `📦 bot_cards الحالية:\n` +
      `  IDC → ${updatedCards.idc || '—'}\n` +
      `  PLC → [${updatedCards.plc.join(', ') || '—'}]\n` +
      `  SKL → [${updatedCards.skl.join(', ') || '—'}]`;

  const successMsg = isBoss
    ? `✅ ${sklId} linked to Tutorial Boss ${tutorialBossLabel(nodeKey)} successfully!`
    : `[ ＳＹＳＴＥＭ ] تم إنشاء البطاقة وربطها تلقائياً\nبوحش المشهد [${nodeKey}] بنجاح!`;

  await bot.sendMessage(chatId,
    systemPanel(
      `${successMsg}\n\n` +
      `${targetLine}\n\n` +
      `🌟 نوع: مهارة (SKL)\n` +
      `🆔 ${sklId}\n\n` +
      cardsLine
    ),
    { parse_mode: 'Markdown' }
  );
  try { await sendQR(bot, chatId, sklId); } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYER COMMAND
// ═══════════════════════════════════════════════════════════════════════════════

async function handleStory(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid } } = msg;

  const player = await db.queryOne(
    `SELECT id FROM players WHERE telegram_id = ?`,
    [tid]
  );
  if (!player) {
    return bot.sendMessage(chatId, '❌ ليس لديك حساب. استخدم $login أولاً.');
  }

  const progress = await engine.getProgress(player.id);

  if (!progress) {
    return bot.sendMessage(chatId, NO_STORY_YET);
  }

  await engine.renderNode(bot, chatId, progress.current_node_key);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CALLBACKS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleChoiceCallback(bot, query) {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const tid    = from.id;

  const choiceId = parseInt(data.replace('story_choice_', ''), 10);
  const choice   = await db.queryOne(`SELECT * FROM story_choices WHERE id = ?`, [choiceId]);
  if (!choice) {
    return bot.sendMessage(chatId, '⚠️ هذا الاختيار لم يعد متاحاً.');
  }

  const player = await db.queryOne(`SELECT id FROM players WHERE telegram_id = ?`, [tid]);
  if (!player) {
    return bot.sendMessage(chatId, '❌ ليس لديك حساب.');
  }

  if (choice.mg_reward > 0) {
    await db.query('UPDATE players SET mg_balance = mg_balance + ? WHERE id = ?', [choice.mg_reward, player.id]);
    await db.query(
      `INSERT INTO mg_transactions (type, amount, source, target, description)
       VALUES ('story_reward', ?, 'system', ?, 'مكافأة قصة')`,
      [choice.mg_reward, `player:${player.id}`]
    );
    await bot.sendMessage(chatId,
      `💰 *+${choice.mg_reward} MG* من خيارك!`,
      { parse_mode: 'Markdown' }
    );
  }

  await engine.advancePlayer(player.id, choice.next_node_key);
  await engine.renderNode(bot, chatId, choice.next_node_key);
}

async function handleBattleCallback(bot, query) {
  const { data, message, from } = query;
  const chatId = message.chat.id;

  const nodeKey = data.replace('story_battle_', '');
  const node    = await engine.getNode(nodeKey);
  const battle  = node ? await engine.getBattle(node.id) : null;
  if (!battle) {
    return bot.sendMessage(chatId, '⚠️ معركة هذا النود غير مُعدَّة بعد.');
  }

  await botFight.startStoryBattle(bot, chatId, from.id, battle);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGISTER
// ═══════════════════════════════════════════════════════════════════════════════

function register(bot) {
  const sendMessage = (id, text) => bot.sendMessage(id, text, { parse_mode: 'Markdown' });

  // ─── Season Commands ────────────────────────────────────────────────────────
  bot.onText(/^\$addSeason(?:\s+(.+))?$/i, async (msg, match) => {
    if (!match[1]) return sendMessage(msg.chat.id, "⚠️ الاستخدام: `$addSeason [اسم الموسم]`\nمثال: `$addSeason الموسم الأول`");
    return handleAddSeason(bot, msg);
  });

  bot.onText(/^\$editSeason(?:\s+(.+))?$/i, async (msg, match) => {
    if (!match[1]) return sendMessage(msg.chat.id, "⚠️ الاستخدام: `$editSeason [SeasonID] | [الاسم الجديد]`");
    return handleEditSeason(bot, msg);
  });

  bot.onText(/^\$delSeason(?:\s+(\d+))?$/i, async (msg, match) => {
    if (!match[1]) return sendMessage(msg.chat.id, "⚠️ الاستخدام: `$delSeason [SeasonID]`");
    return handleDelSeason(bot, msg);
  });

  // ─── Node Commands ──────────────────────────────────────────────────────────
  bot.onText(/^\$addNode(?:\s+(.+))?$/i, async (msg, match) => {
    if (!match[1]) return sendMessage(msg.chat.id, "⚠️ الاستخدام: `$addNode [SeasonID] | [node_key] | [النص]`\n💡 نصيحة: أرسل الأمر كـ رد (Reply) على صورة لتعيينها للمشهد.");
    return handleAddNode(bot, msg);
  });

  bot.onText(/^\$editNode(?:\s+(.+))?$/i, async (msg, match) => {
    if (!match[1]) return sendMessage(msg.chat.id, "⚠️ الاستخدام: `$editNode [node_key] | [النص الجديد]`");
    return handleEditNode(bot, msg);
  });

  bot.onText(/^\$delNode(?:\s+(\S+))?$/i, async (msg, match) => {
    if (!match[1]) return sendMessage(msg.chat.id, "⚠️ الاستخدام: `$delNode [node_key]`");
    return handleDelNode(bot, msg);
  });

  bot.onText(/^\$setNodeImage(?:\s+(\S+))?$/i, async (msg, match) => {
    if (!match[1]) return sendMessage(msg.chat.id, "⚠️ الاستخدام: `$setNodeImage [node_key]`\n💡 ملاحظة: يجب إرسال الأمر كـ رد (Reply) على صورة.");
    return handleSetNodeImage(bot, msg);
  });

  // ─── Choice Commands ────────────────────────────────────────────────────────
  bot.onText(/^\$addChoice(?:\s+(.+))?$/i, async (msg, match) => {
    if (!match[1]) return sendMessage(msg.chat.id, "⚠️ الاستخدام: `$addChoice [FromKey] | [ToKey] | [نص الزر] | [MG_Reward]`");
    return handleAddChoice(bot, msg);
  });

  bot.onText(/^\$delChoices(?:\s+(\S+))?$/i, async (msg, match) => {
    if (!match[1]) return sendMessage(msg.chat.id, "⚠️ الاستخدام: `$delChoices [node_key]`");
    return handleDelChoices(bot, msg);
  });

  // ─── Battle Commands ────────────────────────────────────────────────────────
  bot.onText(/^\$scriptBattle(?:\s+(.+))?$/i, async (msg, match) => {
    if (!match[1]) return sendMessage(msg.chat.id, "⚠️ الاستخدام: `$scriptBattle [NodeKey] | [BotIDC] | [PLC1,PLC2...] | [SKL1...] | [SuccessKey] | [FailKey]`");
    return handleScriptBattle(bot, msg);
  });

  bot.onText(/^\$delBattle(?:\s+(\S+))?$/i, async (msg, match) => {
    if (!match[1]) return sendMessage(msg.chat.id, "⚠️ الاستخدام: `$delBattle [node_key]`");
    return handleDelBattle(bot, msg);
  });

  // ─── Monster Card Wizard ────────────────────────────────────────────────────
  bot.onText(/^\$monsterCard(?:\s+(\S+))?$/i, async (msg, match) => {
    const nodeKey = match[1];
    if (!nodeKey) {
      return bot.sendMessage(msg.chat.id,
        "⚠️ يرجى تحديد مفتاح النود أو نوع البوس.\nمثال: `$monsterCard battle_1` أو `$monsterCard nitron`",
        { parse_mode: 'Markdown' }
      );
    }
    return handleMonsterCard(bot, msg);
  });

  // ─── Special Roles ───────────────────────────────────────────────────────────
  bot.onText(/^\$setRawi(?:\s+(\S+))?$/i, async (msg, match) => {
    const playerCode = match[1];
    if (!playerCode) {
      return bot.sendMessage(msg.chat.id, "⚠️ يرجى تحديد كود اللاعب لمنحه رتبة الراوي.\nمثال: `$setRawi PLR-12345`", { parse_mode: 'Markdown' });
    }
    return handleSetRawi(bot, msg);
  });

  bot.onText(/^\$removeRawi(?:\s+(\S+))?$/i, async (msg, match) => {
    const playerCode = match[1];
    if (!playerCode) {
      return bot.sendMessage(msg.chat.id, "⚠️ يرجى تحديد كود اللاعب لسحب رتبة الراوي منه.\nمثال: `$removeRawi PLR-12345`", { parse_mode: 'Markdown' });
    }
    return handleRemoveRawi(bot, msg);
  });

  // ─── Player ──────────────────────────────────────────────────────────────────
  bot.onText(/^\$story$/i, msg => handleStory(bot, msg));
}

module.exports = {
  register,
  handleChoiceCallback,
  handleBattleCallback,
  handleMonsterCardTypeCallback,
  handleMonsterCardPlcTypeCallback,
  handleMonsterCardStep,
};