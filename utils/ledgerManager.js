'use strict';

const db = require('../db/connection');

const COLUMN_MAP = {
  mg_given:           'total_mg_given',
  ranks_assigned:     'total_ranks_assigned',
  titles_assigned:    'total_titles_assigned',
  camps_registered:   'total_camps_registered',
  duty_activations:   'total_duty_activations',
};

/**
 * Update the activity ledger for a player.
 * @param {number} playerId   - The player's DB id.
 * @param {string} actionType - Key from COLUMN_MAP.
 * @param {number} amount     - Amount to increment (default 1).
 */
async function updateLedger(playerId, actionType, amount = 1) {
  const column = COLUMN_MAP[actionType];
  if (!column) {
    console.error(`[ledgerManager] Unknown actionType: ${actionType}`);
    return;
  }

  const player = await db.queryOne(
    'SELECT character_name, system_rank FROM players WHERE id = ?',
    [playerId]
  );
  if (!player) {
    console.error(`[ledgerManager] Player not found: ${playerId}`);
    return;
  }

  const sql = `
    INSERT INTO \`rank_activity_ledger\`
      (\`player_id\`, \`player_name\`, \`player_rank\`, \`${column}\`, \`last_action_at\`)
    VALUES
      (?, ?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      \`player_name\`    = VALUES(\`player_name\`),
      \`player_rank\`    = VALUES(\`player_rank\`),
      \`${column}\`      = \`${column}\` + VALUES(\`${column}\`),
      \`last_action_at\` = VALUES(\`last_action_at\`)
  `;

  await db.query(sql, [
    playerId,
    player.character_name,
    player.system_rank || 'none',
    amount,
  ]);
}

module.exports = { updateLedger };