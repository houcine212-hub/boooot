'use strict';

/**
 * craftingEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Core logic for the Dynamic Resource & Crafting Engine.
 *
 * Responsibilities:
 *   • Resource Registry  — CRUD on resource_registry
 *   • Player Bag         — read / credit / debit player_resource_bag
 *   • Crafting Rules     — CRUD on crafting_rules (with registry validation)
 *   • Loot Tables        — CRUD on loot_tables + getCombatLoot()
 *   • Forge              — execute a rule for a player (transactional)
 */

const db = require('../db/connection');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a JSON column that may already be an object (mysql2 auto-parses). */
function parseJson(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource Registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register a new resource in the universe.
 * Throws if the key already exists.
 */
async function addResource(resourceKey, displayName, emoji, description) {
  const key = resourceKey.toLowerCase().trim();
  const existing = await db.queryOne(
    'SELECT id FROM resource_registry WHERE resource_key = ?', [key]
  );
  if (existing) throw new Error(`المادة "${key}" مسجلة بالفعل في الكون.`);

  const result = await db.query(
    `INSERT INTO resource_registry (resource_key, display_name, emoji, description)
     VALUES (?, ?, ?, ?)`,
    [key, displayName.trim(), (emoji || '🔹').trim(), (description || '').trim() || null]
  );
  return result.insertId;
}

/** Fetch all registered resources, ordered alphabetically by key. */
async function listResources() {
  return db.query(
    'SELECT * FROM resource_registry ORDER BY resource_key ASC'
  );
}

/** Look up one resource by key. Returns null if not found. */
async function getResource(resourceKey) {
  return db.queryOne(
    'SELECT * FROM resource_registry WHERE resource_key = ?',
    [resourceKey.toLowerCase().trim()]
  );
}

/**
 * Delete a resource from the registry AND wipe it from all players' bags.
 * Returns true if something was deleted.
 */
async function deleteResource(resourceKey) {
  const key = resourceKey.toLowerCase().trim();
  await db.query(
    'DELETE FROM player_resource_bag WHERE resource_key = ?', [key]
  );
  const result = await db.query(
    'DELETE FROM resource_registry WHERE resource_key = ?', [key]
  );
  return result.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Player Resource Bag
// ─────────────────────────────────────────────────────────────────────────────

/** Get all resources owned by a player. */
async function getPlayerBag(playerId) {
  return db.query(
    `SELECT prb.resource_key, prb.quantity, rr.display_name, rr.emoji
     FROM player_resource_bag prb
     LEFT JOIN resource_registry rr ON rr.resource_key = prb.resource_key
     WHERE prb.player_id = ?
     ORDER BY prb.resource_key ASC`,
    [playerId]
  );
}

/**
 * Credit resources to a player's bag (upsert).
 * conn: optional existing transaction connection.
 */
async function creditResources(playerId, resourceKey, qty, conn) {
  const executor = conn || db;
  if (conn) {
    await conn.execute(
      `INSERT INTO player_resource_bag (player_id, resource_key, quantity)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
      [playerId, resourceKey, qty, qty]
    );
  } else {
    await db.query(
      `INSERT INTO player_resource_bag (player_id, resource_key, quantity)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
      [playerId, resourceKey, qty, qty]
    );
  }
}

/**
 * Debit resources from a player's bag inside a transaction.
 * Throws if the player doesn't have enough.
 */
async function debitResources(conn, playerId, resourceKey, qty) {
  const [[row]] = await conn.execute(
    'SELECT quantity FROM player_resource_bag WHERE player_id = ? AND resource_key = ? FOR UPDATE',
    [playerId, resourceKey]
  );
  const owned = row ? row.quantity : 0;
  if (owned < qty) {
    const res = await getResource(resourceKey);
    const label = res ? `${res.emoji} ${res.display_name}` : resourceKey;
    throw new Error(`تحتاج ${qty}x ${label} — عندك فقط ${owned}`);
  }
  if (owned === qty) {
    await conn.execute(
      'DELETE FROM player_resource_bag WHERE player_id = ? AND resource_key = ?',
      [playerId, resourceKey]
    );
  } else {
    await conn.execute(
      'UPDATE player_resource_bag SET quantity = quantity - ? WHERE player_id = ? AND resource_key = ?',
      [qty, playerId, resourceKey]
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Crafting Rules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate that every key in inputObj exists in resource_registry.
 * Returns an array of unknown keys (empty = all valid).
 */
async function validateInputKeys(inputObj) {
  const keys = Object.keys(inputObj);
  if (!keys.length) return ['يجب أن تحتوي على مادة واحدة على الأقل'];
  const unknowns = [];
  for (const key of keys) {
    const exists = await getResource(key);
    if (!exists) unknowns.push(key);
  }
  return unknowns;
}

/**
 * Create a new crafting rule.
 *
 * @param {string}  ruleName         — unique name
 * @param {Object}  inputRequirements — { resource_key: qty, ... }
 * @param {number}  mgCost
 * @param {string}  outputType       — 'card' | 'item' | 'resource'
 * @param {Object}  outputData       — depends on outputType
 * @param {number}  creatorId        — players.id of the admin
 */
async function setRule(ruleName, inputRequirements, mgCost, outputType, outputData, creatorId) {
  const unknowns = await validateInputKeys(inputRequirements);
  if (unknowns.length > 0) {
    throw new Error(`المواد التالية غير مسجلة في الكون: ${unknowns.join(', ')} — استخدم $addRes أولاً.`);
  }

  const validTypes = ['card', 'item', 'resource'];
  if (!validTypes.includes(outputType)) {
    throw new Error(`نوع المخرج "${outputType}" غير صالح. الأنواع المتاحة: ${validTypes.join(', ')}`);
  }

  const result = await db.query(
    `INSERT INTO crafting_rules
       (rule_name, input_requirements, mg_cost, output_type, output_data, created_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       input_requirements = VALUES(input_requirements),
       mg_cost            = VALUES(mg_cost),
       output_type        = VALUES(output_type),
       output_data        = VALUES(output_data),
       created_by         = VALUES(created_by)`,
    [
      ruleName.trim(),
      JSON.stringify(inputRequirements),
      mgCost,
      outputType,
      JSON.stringify(outputData),
      creatorId || null,
    ]
  );
  return result.insertId || result.insertId;
}

/** Fetch all crafting rules. */
async function listRules() {
  return db.query('SELECT * FROM crafting_rules ORDER BY id ASC');
}

/** Fetch one rule by ID. */
async function getRule(ruleId) {
  return db.queryOne('SELECT * FROM crafting_rules WHERE id = ?', [ruleId]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Loot Tables
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add a loot drop rule.
 * Validates the resource_key exists in resource_registry.
 */
async function addLoot(sourceType, resourceKey, minQty, maxQty, dropRate) {
  const key = resourceKey.toLowerCase().trim();
  const res = await getResource(key);
  if (!res) throw new Error(`المادة "${key}" غير موجودة في السجل — استخدم $addRes أولاً.`);
  if (dropRate <= 0 || dropRate > 1) throw new Error('drop_rate يجب أن يكون بين 0.01 و 1.0');
  if (minQty < 1 || maxQty < minQty) throw new Error('min_qty و max_qty قيم غير صحيحة.');

  const result = await db.query(
    `INSERT INTO loot_tables (source_type, resource_key, min_qty, max_qty, drop_rate)
     VALUES (?, ?, ?, ?, ?)`,
    [sourceType.trim(), key, minQty, maxQty, dropRate]
  );
  return result.insertId;
}

/** Fetch all loot rules for a given source type. */
async function getLootRules(sourceType) {
  return db.query(
    `SELECT lt.*, rr.display_name, rr.emoji
     FROM loot_tables lt
     LEFT JOIN resource_registry rr ON rr.resource_key = lt.resource_key
     WHERE lt.source_type = ?`,
    [sourceType]
  );
}

/**
 * Calculate and return combat loot drops for a given source type.
 * Each loot rule is rolled independently against its drop_rate.
 *
 * @param  {string} sourceType — e.g. 'bot_level_1', 'pvp', 'loot_pvp'
 * @returns {Array<{ resource_key, display_name, emoji, qty }>}
 */
async function getCombatLoot(sourceType) {
  const rules = await getLootRules(sourceType);
  const drops = [];

  for (const rule of rules) {
    if (Math.random() <= rule.drop_rate) {
      const qty = Math.floor(
        Math.random() * (rule.max_qty - rule.min_qty + 1)
      ) + rule.min_qty;
      drops.push({
        resource_key: rule.resource_key,
        display_name: rule.display_name || rule.resource_key,
        emoji:        rule.emoji || '🔹',
        qty,
      });
    }
  }
  return drops;
}

/**
 * Award loot drops to a player's resource bag.
 * Returns the same drops array for display.
 */
async function awardCombatLoot(playerId, drops) {
  for (const drop of drops) {
    await creditResources(playerId, drop.resource_key, drop.qty);
  }
  return drops;
}

// ─────────────────────────────────────────────────────────────────────────────
// Forge Engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a crafting rule for a player.
 * Fully transactional: deducts materials + MG, grants output, logs.
 *
 * @param {number} playerId
 * @param {number} ruleId
 * @returns {{ rule, outputSummary }}
 */
async function executeForge(playerId, ruleId) {
  return db.withTransaction(async (conn) => {
    // ── Load rule ──────────────────────────────────────────────────────────
    const [[ruleRow]] = await conn.execute(
      'SELECT * FROM crafting_rules WHERE id = ? LIMIT 1', [ruleId]
    );
    if (!ruleRow) throw new Error('قاعدة الصنع غير موجودة.');

    const rule         = ruleRow;
    const requirements = parseJson(rule.input_requirements);
    const outputData   = parseJson(rule.output_data);

    // ── Validate player MG ─────────────────────────────────────────────────
    const [[playerRow]] = await conn.execute(
      'SELECT mg_balance FROM players WHERE id = ? FOR UPDATE', [playerId]
    );
    if (!playerRow) throw new Error('اللاعب غير موجود.');
    if (playerRow.mg_balance < rule.mg_cost) {
      throw new Error(`تحتاج ${rule.mg_cost} MG — عندك ${playerRow.mg_balance} MG فقط.`);
    }

    // ── Deduct input resources ────────────────────────────────────────────
    for (const [key, qty] of Object.entries(requirements)) {
      await debitResources(conn, playerId, key, qty);
    }

    // ── Deduct MG ─────────────────────────────────────────────────────────
    if (rule.mg_cost > 0) {
      await conn.execute(
        'UPDATE players SET mg_balance = mg_balance - ? WHERE id = ?',
        [rule.mg_cost, playerId]
      );
    }

    // ── Grant output ──────────────────────────────────────────────────────
    let outputSummary = '';

    if (rule.output_type === 'resource') {
      const { resource_key, quantity = 1 } = outputData;
      await conn.execute(
        `INSERT INTO player_resource_bag (player_id, resource_key, quantity)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
        [playerId, resource_key, quantity, quantity]
      );
      const resRow = await getResource(resource_key);
      outputSummary = `${resRow?.emoji || '🔹'} ${resRow?.display_name || resource_key} ×${quantity}`;

    } else if (rule.output_type === 'item') {
      const { shop_item_id, quantity = 1 } = outputData;
      await conn.execute(
        `INSERT INTO player_inventory (player_id, item_id, quantity)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
        [playerId, shop_item_id, quantity, quantity]
      );
      const [[itemRow]] = await conn.execute(
        'SELECT name FROM shop_items WHERE id = ? LIMIT 1', [shop_item_id]
      );
      outputSummary = `📦 ${itemRow?.name || 'عنصر'} ×${quantity}`;

    } else if (rule.output_type === 'card') {
      // Dynamic card generation — record a stub in forge_log with card stats;
      // actual card creation is delegated to the calling command layer.
      outputSummary = `🃏 بطاقة: ${outputData.name || 'مجهولة'} (${outputData.card_type || 'play'})`;
    }

    // ── Log ───────────────────────────────────────────────────────────────
    await conn.execute(
      `INSERT INTO forge_log (player_id, rule_id, mg_spent, output_type, output_desc)
       VALUES (?, ?, ?, ?, ?)`,
      [playerId, rule.id, rule.mg_cost, rule.output_type, outputSummary]
    );

    return { rule, outputSummary, outputData };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Registry
  addResource,
  listResources,
  getResource,
  deleteResource,
  // Bag
  getPlayerBag,
  creditResources,
  debitResources,
  // Rules
  setRule,
  listRules,
  getRule,
  validateInputKeys,
  // Loot
  addLoot,
  getLootRules,
  getCombatLoot,
  awardCombatLoot,
  // Forge
  executeForge,
};