// utils/storyEngine.js
// Core navigation engine for the Dynamic Story System.
// Handles node fetching, progress tracking, and display rendering.
// Battle integration is handled in the next phase via commands/storyManager.js.

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

// ─── Get or create player progress ───────────────────────────────────────────
async function getProgress(playerId) {
  let row = await db.queryOne(
    `SELECT * FROM player_story_progress WHERE player_id = ?`,
    [playerId]
  );
  if (!row) {
    await db.query(
      `INSERT INTO player_story_progress (player_id, current_node_key, completed_seasons)
       VALUES (?, 'prologue_1', '[]')`,
      [playerId]
    );
    row = { player_id: playerId, current_node_key: 'prologue_1', completed_seasons: '[]' };
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
// Returns the sent message object.
async function sendNode(bot, chatId, node, choices, battle) {
  const caption = storyCaption(node.narrative_text);
  let keyboard;

  if (node.node_type === 'battle' && battle) {
    keyboard = buildBattleKeyboard(node.node_key);
  } else if (choices && choices.length > 0) {
    keyboard = buildChoiceKeyboard(choices);
  } else {
    // Leaf / end-of-chapter node — no buttons
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
// Used by botFight.js after a story battle concludes.
async function advanceAndRender(bot, chatId, playerId, nextNodeKey) {
  await advancePlayer(playerId, nextNodeKey);
  await renderNode(bot, chatId, nextNodeKey);
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
  advanceAndRender
};