// commands/storyManager.js
// Admin tools:  $addNode  $addChoice  $scriptBattle  $addSeason
// Player tools: $story
// Callbacks:    story_choice_*  story_battle_*  (battle wired in next phase)

const db          = require('../db/connection');
const permissions = require('../utils/permissions');
const session     = require('../middleware/sessionManager');
const engine      = require('../utils/storyEngine');
const economy     = require('../utils/economy');

// ─── Helpers ─────────────────────────────────────────────────────────────────
const ADMIN_ONLY = '🚫 هذا الأمر للإمبراطور والأوفرلورد فقط.';

function split(text, sep = '|') {
  return text.split(sep).map(s => s.trim());
}

async function guardAdmin(bot, chatId, tid) {
  if (await permissions.isAdmin(tid)) return true;
  await bot.sendMessage(chatId, ADMIN_ONLY);
  return false;
}

// ─── $addSeason [SeasonName] ──────────────────────────────────────────────────
async function handleAddSeason(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text } = msg;
  if (!await guardAdmin(bot, chatId, tid)) return;

  const name = text.replace(/^\$addSeason\s*/i, '').trim();
  if (!name) return bot.sendMessage(chatId, '⚠️ الاستخدام: `$addSeason [اسم الموسم]`', { parse_mode: 'Markdown' });

  const result = await db.query(
    `INSERT INTO story_seasons (season_name, is_active) VALUES (?, 1)`,
    [name]
  );
  const id = result.insertId;
  await bot.sendMessage(chatId,
    `✅ الموسم أُنشئ!\n📖 *${name}*\n🆔 Season ID: \`${id}\``,
    { parse_mode: 'Markdown' }
  );
}

// ─── $addNode [SeasonID] | [Key] | [Text] ────────────────────────────────────
// If the command is sent as a reply to a photo, that photo becomes the node image.
async function handleAddNode(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text, reply_to_message: reply } = msg;
  if (!await guardAdmin(bot, chatId, tid)) return;

  const raw = (text || '').replace(/^\$addNode\s*/i, '').trim();
  const parts = split(raw);
  if (parts.length < 3) {
    return bot.sendMessage(chatId,
      '⚠️ الاستخدام:\n`$addNode [SeasonID] | [node_key] | [النص]`\n\nأرسله كـ reply على صورة لتعيين الصورة تلقائياً.',
      { parse_mode: 'Markdown' }
    );
  }

  const [seasonIdStr, nodeKey, ...textParts] = parts;
  const seasonId = parseInt(seasonIdStr, 10);
  const narrativeText = textParts.join('|');

  // Image from replied photo
  let imageId = null;
  if (reply?.photo) {
    imageId = reply.photo[reply.photo.length - 1].file_id;
  }

  // Validate season
  const season = await db.queryOne(`SELECT id FROM story_seasons WHERE id = ?`, [seasonId]);
  if (!season) return bot.sendMessage(chatId, `❌ لا يوجد موسم بـ ID: \`${seasonId}\``, { parse_mode: 'Markdown' });

  // Check key uniqueness
  const existing = await db.queryOne(`SELECT id FROM story_nodes WHERE node_key = ?`, [nodeKey]);
  if (existing) return bot.sendMessage(chatId, `❌ المفتاح \`${nodeKey}\` مستخدم مسبقاً.`, { parse_mode: 'Markdown' });

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

// ─── $setNodeImage — reply to a photo to set/update a node's image ────────────
// Usage: reply to a photo with  $setNodeImage [node_key]
async function handleSetNodeImage(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text, reply_to_message: reply } = msg;
  if (!await guardAdmin(bot, chatId, tid)) return;

  const nodeKey = (text || '').replace(/^\$setNodeImage\s*/i, '').trim();
  if (!nodeKey) return bot.sendMessage(chatId, '⚠️ الاستخدام: `$setNodeImage [node_key]` — أرسله كـ reply على صورة.', { parse_mode: 'Markdown' });
  if (!reply?.photo) return bot.sendMessage(chatId, '⚠️ يجب أن يكون الأمر reply على صورة.');

  const imageId = reply.photo[reply.photo.length - 1].file_id;
  const result = await db.query(
    `UPDATE story_nodes SET image_id = ? WHERE node_key = ?`,
    [imageId, nodeKey]
  );
  if (!result.affectedRows) return bot.sendMessage(chatId, `❌ لم يُعثر على نود بمفتاح \`${nodeKey}\``, { parse_mode: 'Markdown' });

  await bot.sendMessage(chatId, `✅ صورة النود \`${nodeKey}\` مُحدَّثة.`, { parse_mode: 'Markdown' });
}

// ─── $addChoice [NodeKey] | [TargetNodeKey] | [ButtonText] | [MG_Reward] ──────
async function handleAddChoice(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text } = msg;
  if (!await guardAdmin(bot, chatId, tid)) return;

  const raw = (text || '').replace(/^\$addChoice\s*/i, '').trim();
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
  if (!fromNode) return bot.sendMessage(chatId, `❌ النود \`${fromKey}\` غير موجود.`, { parse_mode: 'Markdown' });
  if (fromNode.node_type === 'battle') return bot.sendMessage(chatId, `❌ نود المعركة لا يقبل اختيارات — استخدم \`$scriptBattle\`.`, { parse_mode: 'Markdown' });

  // Auto-upgrade node_type to 'choice' if it was 'dialogue'
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

// ─── $scriptBattle [NodeKey] | [BotIDC] | [PLC_1,...] | [SKL_1,...] | [SuccessKey] | [FailKey] ──
async function handleScriptBattle(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid }, text } = msg;
  if (!await guardAdmin(bot, chatId, tid)) return;

  const raw = (text || '').replace(/^\$scriptBattle\s*/i, '').trim();
  const parts = split(raw);

  // Minimum: NodeKey | BotIDC | PLCs | SuccessKey | FailKey  (SKL optional)
  if (parts.length < 5) {
    return bot.sendMessage(chatId,
      '⚠️ الاستخدام:\n`$scriptBattle [NodeKey] | [BotIDC] | [PLC-1,PLC-2,...] | [SKL-1,...] | [SuccessKey] | [FailKey]`\n\nيمكن تركSKL فارغاً.',
      { parse_mode: 'Markdown' }
    );
  }

  const [nodeKey, botIDC, plcStr, sklStr, victoryKey, defeatKey] = parts;

  const node = await db.queryOne(`SELECT id FROM story_nodes WHERE node_key = ?`, [nodeKey]);
  if (!node) return bot.sendMessage(chatId, `❌ النود \`${nodeKey}\` غير موجود.`, { parse_mode: 'Markdown' });

  // Validate IDC exists
  const idc = await db.queryOne(`SELECT card_id FROM identity_cards WHERE card_id = ?`, [botIDC]);
  if (!idc) return bot.sendMessage(chatId, `❌ بطاقة الهوية \`${botIDC}\` غير موجودة.`, { parse_mode: 'Markdown' });

  const plcIds = plcStr ? plcStr.split(',').map(s => s.trim()).filter(Boolean) : [];
  const sklIds = sklStr ? sklStr.split(',').map(s => s.trim()).filter(Boolean) : [];

  const botCardsJson = JSON.stringify({ idc: botIDC, plc: plcIds, skl: sklIds });

  // Upsert battle record
  const existing = await db.queryOne(`SELECT id FROM story_battles WHERE node_id = ?`, [node.id]);
  if (existing) {
    await db.query(
      `UPDATE story_battles SET bot_cards_json = ?, victory_node_key = ?, defeat_node_key = ? WHERE node_id = ?`,
      [botCardsJson, victoryKey, defeatKey, node.id]
    );
  } else {
    await db.query(
      `INSERT INTO story_battles (node_id, bot_cards_json, victory_node_key, defeat_node_key)
       VALUES (?, ?, ?, ?)`,
      [node.id, botCardsJson, victoryKey, defeatKey]
    );
  }

  // Mark node as battle type
  await db.query(`UPDATE story_nodes SET node_type = 'battle' WHERE id = ?`, [node.id]);

  await bot.sendMessage(chatId,
    `⚔️ معركة مبرمجة!\n🔑 Node: \`${nodeKey}\`\n🧬 IDC: \`${botIDC}\`\n🃏 PLC: ${plcIds.join(', ') || '—'}\n✨ SKL: ${sklIds.join(', ') || '—'}\n✅ فوز → \`${victoryKey}\`\n❌ خسارة → \`${defeatKey}\``,
    { parse_mode: 'Markdown' }
  );
}

// ─── $story — Player entry point ──────────────────────────────────────────────
async function handleStory(bot, msg) {
  const { chat: { id: chatId }, from: { id: tid } } = msg;

  const player = await db.queryOne(
    `SELECT p.id FROM players p WHERE p.telegram_id = ?`,
    [tid]
  );
  if (!player) return bot.sendMessage(chatId, '❌ ليس لديك حساب. استخدم $login أولاً.');

  const progress = await engine.getProgress(player.id);
  await engine.renderNode(bot, chatId, progress.current_node_key);
}

// ─── Callback: story_choice_[id] ─────────────────────────────────────────────
async function handleChoiceCallback(bot, query) {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const tid    = from.id;

  const choiceId = parseInt(data.replace('story_choice_', ''), 10);
  const choice   = await db.queryOne(`SELECT * FROM story_choices WHERE id = ?`, [choiceId]);
  if (!choice) return bot.sendMessage(chatId, '⚠️ هذا الاختيار لم يعد متاحاً.');

  const player = await db.queryOne(`SELECT id FROM players WHERE telegram_id = ?`, [tid]);
  if (!player) return bot.sendMessage(chatId, '❌ ليس لديك حساب.');

  // MG reward
  if (choice.mg_reward > 0) {
    await economy.addToPlayerWallet(player.id, choice.mg_reward, 'مكافأة قصة');
    await bot.sendMessage(chatId,
      `💰 *+${choice.mg_reward} MG* من خيارك!`,
      { parse_mode: 'Markdown' }
    );
  }

  // Advance progress
  await engine.advancePlayer(player.id, choice.next_node_key);
  await engine.renderNode(bot, chatId, choice.next_node_key);
}

// ─── Callback: story_battle_[nodeKey] ────────────────────────────────────────
// Stub — full CombatEngine wiring delivered in Phase 2.
async function handleBattleCallback(bot, query) {
  const { data, message, from } = query;
  const chatId = message.chat.id;

  const nodeKey = data.replace('story_battle_', '');
  const node    = await engine.getNode(nodeKey);
  const battle  = node ? await engine.getBattle(node.id) : null;
  if (!battle) return bot.sendMessage(chatId, '⚠️ معركة هذا النود غير مُعدَّة بعد.');

  // TODO Phase 2: launch story combat instance using battle.bot_cards_json
  await bot.sendMessage(chatId,
    `⚔️ *المعركة القادمة...*\nسيتم تفعيل نظام القتال في الإصدار القادم.\n\n🔑 Node: \`${nodeKey}\``,
    { parse_mode: 'Markdown' }
  );
}

// ─── Register ─────────────────────────────────────────────────────────────────
function register(bot) {
  bot.onText(/^\$addSeason\s+.+/i,    msg => handleAddSeason(bot, msg));
  bot.onText(/^\$addNode\s+.+/i,      msg => handleAddNode(bot, msg));
  bot.onText(/^\$setNodeImage\s+.+/i, msg => handleSetNodeImage(bot, msg));
  bot.onText(/^\$addChoice\s+.+/i,    msg => handleAddChoice(bot, msg));
  bot.onText(/^\$scriptBattle\s+.+/i, msg => handleScriptBattle(bot, msg));
  bot.onText(/^\$story$/i,            msg => handleStory(bot, msg));
}

module.exports = {
  register,
  handleChoiceCallback,
  handleBattleCallback,
};