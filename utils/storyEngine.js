// utils/storyEngine.js
// Core navigation engine for the Dynamic Story System.
// Handles node fetching, progress tracking, and display rendering.

const db = require('../db/connection');

// ─── Solo Leveling dark-style text wrapper ────────────────────────────────────
function storyCaption(narrativeText) {
  return `\`\`\`\n◈ ═══════════════════════ ◈\n\n${narrativeText}\n\n◈ ═══════════════════════ ◈\n\`\`\``;
}

// ─── Fetch a node by its key ──────────────────────────────────────────────────
async function getNode(nodeKey) {
  return db.queryOne(
    `SELECT sn.*, ss.season_name
       FROM story_nodes sn
       JOIN story_seasons ss ON ss.id = sn.season_id
      WHERE sn.node_key = ?`,
    [nodeKey]
  );
}

// ─── Fetch choices for a node ─────────────────────────────────────────────────
async function getChoices(nodeId) {
  return db.query(
    `SELECT * FROM story_choices WHERE node_id = ? ORDER BY id ASC`,
    [nodeId]
  );
}

// ─── Fetch scripted battle for a node ────────────────────────────────────────
async function getBattle(nodeId) {
  return db.queryOne(
    `SELECT * FROM story_battles WHERE node_id = ?`,
    [nodeId]
  );
}

// ─── Resolve the first available node in the active season ───────────────────
async function resolveStarterNode() {
  const row = await db.queryOne(
    `SELECT sn.node_key
       FROM story_nodes sn
       JOIN story_seasons ss ON ss.id = sn.season_id
      WHERE ss.is_active = 1
      ORDER BY sn.id ASC
      LIMIT 1`
  );
  return row ? row.node_key : null;
}

// ─── Get or create player progress ───────────────────────────────────────────
async function getProgress(playerId) {
  let row = await db.queryOne(
    `SELECT * FROM player_story_progress WHERE player_id = ?`,
    [playerId]
  );

  if (!row) {
    const starterKey = await resolveStarterNode();
    if (!starterKey) return null;

    await db.query(
      `INSERT INTO player_story_progress (player_id, current_node_key, completed_seasons)
       VALUES (?, ?, '[]')`,
      [playerId, starterKey]
    );
    row = { player_id: playerId, current_node_key: starterKey, completed_seasons: '[]' };
  }

  return row;
}

// ─── Advance player to a new node ────────────────────────────────────────────
async function advancePlayer(playerId, nextNodeKey) {
  await db.query(
    `UPDATE player_story_progress SET current_node_key = ? WHERE player_id = ?`,
    [nextNodeKey, playerId]
  );
}

// ─── Mark a season complete ───────────────────────────────────────────────────
async function markSeasonComplete(playerId, seasonId) {
  const row = await db.queryOne(
    `SELECT completed_seasons FROM player_story_progress WHERE player_id = ?`,
    [playerId]
  );
  if (!row) return;
  const list = JSON.parse(row.completed_seasons || '[]');
  if (!list.includes(seasonId)) {
    list.push(seasonId);
    await db.query(
      `UPDATE player_story_progress SET completed_seasons = ? WHERE player_id = ?`,
      [JSON.stringify(list), playerId]
    );
  }
}

// ─── Build inline keyboard for choices ───────────────────────────────────────
function buildChoiceKeyboard(choices) {
  return {
    inline_keyboard: choices.map(c => [{
      text: c.choice_text,
      callback_data: `story_choice_${c.id}`
    }])
  };
}

// ─── Build battle prompt keyboard ────────────────────────────────────────────
function buildBattleKeyboard(nodeKey) {
  return {
    inline_keyboard: [[
      { text: '⚔️ ادخل المعركة', callback_data: `story_battle_${nodeKey}` }
    ]]
  };
}

// ─── Send a story node to chat ────────────────────────────────────────────────
async function sendNode(bot, chatId, node, choices, battle) {
  const caption = storyCaption(node.narrative_text);
  let keyboard;

  if (node.node_type === 'battle' && battle) {
    keyboard = buildBattleKeyboard(node.node_key);
  } else if (choices && choices.length > 0) {
    keyboard = buildChoiceKeyboard(choices);
  } else {
    keyboard = undefined;
  }

  const opts = {
    parse_mode: 'Markdown',
    ...(keyboard ? { reply_markup: keyboard } : {})
  };

  if (node.image_id) {
    return bot.sendPhoto(chatId, node.image_id, { caption, ...opts });
  }
  return bot.sendMessage(chatId, caption, opts);
}

// ─── Full render: load node + choices + battle, then send ────────────────────
async function renderNode(bot, chatId, nodeKey) {
  const node = await getNode(nodeKey);
  if (!node) {
    return bot.sendMessage(chatId, '⚠️ لم يُعثر على هذا المشهد. راجع الأدمن.');
  }

  const choices = node.node_type !== 'battle' ? await getChoices(node.id) : [];
  const battle  = node.node_type === 'battle'  ? await getBattle(node.id) : null;

  await sendNode(bot, chatId, node, choices, battle);
  return { node, choices, battle };
}

// ─── Advance player and immediately render the next node ──────────────────────
async function advanceAndRender(bot, chatId, playerId, nextNodeKey) {
  await advancePlayer(playerId, nextNodeKey);
  await renderNode(bot, chatId, nextNodeKey);
}

// ─── Fetch the story_battles row for a battle node ───────────────────────────
async function getBattleByNodeKey(nodeKey) {
  return db.queryOne(
    `SELECT sb.*
       FROM story_battles sb
       JOIN story_nodes   sn ON sn.id = sb.node_id
      WHERE sn.node_key = ?`,
    [nodeKey]
  );
}

// ─── Update bot_cards_json for a battle node ─────────────────────────────────
// cardType: 'idc' | 'plc' | 'skl'
// cardId:   the new card ID to apply
// IDC replaces the single idc field.
// PLC / SKL push into their respective arrays (no duplicates).
async function linkCardToBattle(nodeKey, cardType, cardId) {
  const battle = await getBattleByNodeKey(nodeKey);
  if (!battle) throw new Error(`No battle found for node key: ${nodeKey}`);

  let cards;
  try {
    cards = JSON.parse(battle.bot_cards_json || '{}');
  } catch {
    cards = {};
  }

  // Ensure defaults
  if (!cards.idc) cards.idc = null;
  if (!Array.isArray(cards.plc)) cards.plc = [];
  if (!Array.isArray(cards.skl)) cards.skl = [];

  if (cardType === 'idc') {
    cards.idc = cardId;
  } else if (cardType === 'plc') {
    if (!cards.plc.includes(cardId)) cards.plc.push(cardId);
  } else if (cardType === 'skl') {
    if (!cards.skl.includes(cardId)) cards.skl.push(cardId);
  } else {
    throw new Error(`Unknown card type: ${cardType}`);
  }

  await db.query(
    `UPDATE story_battles SET bot_cards_json = ? WHERE id = ?`,
    [JSON.stringify(cards), battle.id]
  );

  return cards; // Return updated state for confirmation message
}

// ─── Fetch (or create) the "Bot System" player — used as owner of monster cards
// Expects a player row with player_code = 'BOT_SYSTEM' to exist.
async function getBotSystemPlayerId() {
  const row = await db.queryOne(
    `SELECT id FROM players WHERE player_code = 'BOT_SYSTEM' LIMIT 1`
  );
  if (!row) throw new Error('BOT_SYSTEM player not found. Create it in the DB first.');
  return row.id;
}

module.exports = {
  getNode,
  getChoices,
  getBattle,
  getProgress,
  advancePlayer,
  markSeasonComplete,
  renderNode,
  storyCaption,
  advanceAndRender,
  getBattleByNodeKey,
  linkCardToBattle,
  getBotSystemPlayerId,
};