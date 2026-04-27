'use strict';

const db = require('../db/connection');

/**
 * Write one entry to rank_audit_log.
 *
 * @param {object} opts
 * @param {number} opts.actorId   - players.id of who performed the action
 * @param {number} opts.targetId  - players.id of who was affected
 * @param {string} opts.action    - 'settitle' | 'setrank' | 'deletecity' | 'removeplayer'
 * @param {string} opts.details   - human-readable summary
 */
async function log({ actorId, targetId, action, details }) {
  try {
    await db.query(
      'INSERT INTO rank_audit_log (actor_id, target_id, action, details) VALUES (?, ?, ?, ?)',
      [actorId, targetId, action, details]
    );
  } catch (err) {
    // Never crash the bot because of a logging failure
    console.error('[rankLogger] Failed to write log:', err.message);
  }
}

module.exports = { log };