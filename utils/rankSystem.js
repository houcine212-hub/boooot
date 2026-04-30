'use strict';

const db          = require('../db/connection');
const permissions = require('./permissions');

// ============================================================
// TIER 1 — Automatic ranks (derived from rank_points in DB)
// These are NEVER stored in system_rank and NEVER assigned via $setrank
// ============================================================
const RP_THRESHOLDS = [
  { min: 10000, rank: 'city_champion',  label: 'بطل المدينة' },
  { min: 7000,  rank: 'knight',         label: 'فارس'        },
  { min: 4000,  rank: 'knight_trainee', label: 'فارس متدرب' },
  { min: 2000,  rank: 'soldier',        label: 'جندي'        },
  { min: 1000,  rank: 'citizen_rp',     label: 'مواطن'       },
  { min: 0,     rank: 'refugee',        label: 'لاجئ'        },
];

function getRpRank(points) {
  const p = Math.max(0, points || 0);
  for (const tier of RP_THRESHOLDS) {
    if (p >= tier.min) return tier;
  }
  return RP_THRESHOLDS[RP_THRESHOLDS.length - 1];
}

// ============================================================
// TIER 2 — Manual ranks (stored in players.system_rank)
// Higher index = more authority.
// Only these can be assigned/removed via $setrank.
// RP ranks are fully excluded from this list.
// ============================================================
const MANUAL_RANKS = [
  'none',       // 0 — no manual rank → fall back to RP rank
  'advisor',    // 1 — المستشار
  'deputy',     // 2 — النواب
  'city_ruler', // 3 — حاكم المدينة
  'governor',   // 4 — الوالي
  'sage',       // 5 — الحكيم
  'prince',     // 6 — الأمير
  'emperor',    // 7 — الإمبراطور
  'overlord',   // 8 — derived from ADMIN_ID only, never stored in DB
];

const MANUAL_LABELS = {
  none:       null,
  advisor:    'المستشار',
  deputy:     'النواب',
  city_ruler: 'حاكم المدينة',
  governor:   'الوالي',
  sage:       'الحكيم',
  prince:     'الأمير',
  emperor:    'الإمبراطور',
  overlord:   'Overlord',
};

function manualIndex(rank) {
  const i = MANUAL_RANKS.indexOf(rank);
  return i === -1 ? 0 : i;
}

// ============================================================
// Fetch player row
// ============================================================
async function getPlayer(telegramId) {
  return db.queryOne(
    'SELECT id, character_name, system_rank, rank_points FROM players WHERE telegram_id = ?',
    [telegramId]
  );
}

// ============================================================
// Effective rank — used for permission checks only
// Returns a MANUAL_RANKS value (authority level)
// Overlord is always derived from ADMIN_ID, never from DB
// RP ranks (below advisor) are treated as 'none' for authority purposes
// ============================================================
async function getEffectiveRank(telegramId) {
  if (permissions.isMainAdmin(telegramId)) return 'overlord';

  const player = await getPlayer(telegramId);
  if (!player) return 'none';

  const stored = player.system_rank || 'none';
  return MANUAL_RANKS.includes(stored) ? stored : 'none';
}

// ============================================================
// Display rank — used in $status output
// Priority: manual rank → RP rank (title is handled in status command)
// Returns { label: string, isManual: boolean }
// ============================================================
async function getDisplayRank(telegramId) {
  if (permissions.isMainAdmin(telegramId)) {
    return { label: MANUAL_LABELS['overlord'], isManual: true };
  }

  const player = await getPlayer(telegramId);
  if (!player) return { label: getRpRank(0).label, isManual: false };

  return getDisplayRankFromRow(player);
}

// Same but accepts a player row directly (avoids extra DB call)
function getDisplayRankFromRow(player) {
  const stored = player.system_rank || 'none';
  if (stored !== 'none' && MANUAL_RANKS.includes(stored) && MANUAL_LABELS[stored]) {
    return { label: MANUAL_LABELS[stored], isManual: true };
  }
  return { label: getRpRank(player.rank_points).label, isManual: false };
}

// ============================================================
// Core protection: actor must be strictly above target
// Any player without a manual rank is treated as level 0 ('none')
// so any manual-rank holder can act on them
// ============================================================
async function canActOn(actorTelegramId, targetTelegramId) {
  const actorRank  = await getEffectiveRank(actorTelegramId);
  const targetRank = await getEffectiveRank(targetTelegramId);
  return manualIndex(actorRank) > manualIndex(targetRank);
}

async function hasRank(telegramId, requiredRank) {
  const rank = await getEffectiveRank(telegramId);
  return manualIndex(rank) >= manualIndex(requiredRank);
}

// ============================================================
// Command permission checks
// ============================================================
async function canSetTitle(telegramId) {
  return hasRank(telegramId, 'emperor');
}

async function canSetRank(telegramId) {
  return hasRank(telegramId, 'city_ruler');
}

// ============================================================
// What manual ranks can actor assign via $setrank
// 'none' is included — it removes the manual rank (player reverts to RP rank)
// RP ranks are intentionally excluded
// ============================================================
function assignableRanks(actorRank) {
  const i = manualIndex(actorRank);
  if (i >= manualIndex('overlord')) return ['none','advisor','deputy','city_ruler','governor','sage','prince','emperor'];
  if (i >= manualIndex('emperor'))  return ['none','advisor','deputy','city_ruler','governor','sage','prince'];
  if (i >= manualIndex('prince'))   return ['none','advisor','deputy','city_ruler','governor','sage'];
  if (i >= manualIndex('governor')) return ['none','advisor','deputy'];
  if (i >= manualIndex('city_ruler')) return ['none','advisor','deputy'];
  return [];
}

// ============================================================
// Cooldown — 5 setrank uses per day for city_ruler / governor
// ============================================================
const SETRANK_DAILY_LIMIT = 5;

async function checkAndIncrementCooldown(playerId) {
  const now     = new Date();
  const resetAt = new Date();
  resetAt.setUTCHours(24, 0, 0, 0);

  const row = await db.queryOne(
    'SELECT used_count, reset_at FROM rank_action_cooldowns WHERE player_id = ? AND action = ?',
    [playerId, 'setrank']
  );

  if (!row || new Date(row.reset_at) <= now) {
    await db.query(
      `INSERT INTO rank_action_cooldowns (player_id, action, used_count, reset_at)
       VALUES (?, 'setrank', 1, ?)
       ON DUPLICATE KEY UPDATE used_count = 1, reset_at = ?`,
      [playerId, resetAt, resetAt]
    );
    return { allowed: true, remaining: SETRANK_DAILY_LIMIT - 1 };
  }

  if (row.used_count >= SETRANK_DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  await db.query(
    `UPDATE rank_action_cooldowns SET used_count = used_count + 1
     WHERE player_id = ? AND action = 'setrank'`,
    [playerId]
  );
  return { allowed: true, remaining: SETRANK_DAILY_LIMIT - row.used_count - 1 };
}

// ============================================================
// Apply a manual rank change
// Passing 'none' clears the manual rank → player reverts to RP rank
// ============================================================
async function applyRank(targetPlayerCode, newRank) {
  await db.query(
    'UPDATE players SET system_rank = ? WHERE player_code = ?',
    [newRank === 'none' ? null : newRank, targetPlayerCode]
  );
}

// ============================================================
// Special Roles Track
// ============================================================

// Story admin: Overlord, Emperor, Prince, OR anyone with is_rawi = true
async function isStoryAdmin(telegramId) {
  if (permissions.isMainAdmin(telegramId)) return true;

  const player = await db.queryOne(
    'SELECT system_rank, is_rawi FROM players WHERE telegram_id = ?',
    [telegramId]
  );
  if (!player) return false;

  const rank = player.system_rank || 'none';
  return rank === 'emperor' || rank === 'prince' || !!player.is_rawi;
}

// Can assign special roles: Overlord or Emperor only
async function canAssignSpecialRoles(telegramId) {
  if (permissions.isMainAdmin(telegramId)) return true;

  const player = await db.queryOne(
    'SELECT system_rank FROM players WHERE telegram_id = ?',
    [telegramId]
  );
  if (!player) return false;

  return (player.system_rank || '') === 'emperor';
}

module.exports = {
  getRpRank,
  RP_THRESHOLDS,
  MANUAL_RANKS,
  MANUAL_LABELS,
  manualIndex,
  getPlayer,
  getEffectiveRank,
  getDisplayRank,
  getDisplayRankFromRow,
  canActOn,
  hasRank,
  canSetTitle,
  canSetRank,
  assignableRanks,
  checkAndIncrementCooldown,
  SETRANK_DAILY_LIMIT,
  applyRank,
  isStoryAdmin,
  canAssignSpecialRoles,
};