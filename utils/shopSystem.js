'use strict';

const db = require('../db/connection');

// ── shared helper ─────────────────────────────────────────────────────────────

function escMd(text) {
  return String(text || '').replace(/[_*[\]()~`>#+=|{}.!\-\\]/g, '\\$&');
}

// ── shop items ────────────────────────────────────────────────────────────────

/**
 * Fetch visible, non-expired items for a store tier.
 */
async function getActiveItems(tier) {
  return db.query(
    `SELECT * FROM shop_items
     WHERE store_level = ?
       AND show_in_shop = TRUE
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY FIELD(rarity,'legendary','epic','rare','common'), price ASC`,
    [tier]
  );
}

/**
 * Add a new item to the shop.
 * hoursToExpire = 0 means no expiry.
 * @returns {number} inserted item ID
 */
async function addItem(name, price, storeLevel, type, rarity, hoursToExpire = 0) {
  let expiresAt = null;
  if (hoursToExpire > 0) {
    expiresAt = new Date(Date.now() + hoursToExpire * 3_600_000)
      .toISOString().slice(0, 19).replace('T', ' ');
  }
  const result = await db.query(
    `INSERT INTO shop_items (name, price, store_level, item_type, rarity, expires_at, show_in_shop)
     VALUES (?, ?, ?, ?, ?, ?, TRUE)`,
    [name, price, storeLevel, type, rarity, expiresAt]
  );
  return result.insertId;
}

/**
 * Remove an item from the shop.
 * @returns {boolean} true if a row was deleted
 */
async function deleteItem(itemId) {
  const result = await db.query('DELETE FROM shop_items WHERE id = ?', [itemId]);
  return result.affectedRows > 0;
}

// ── buy (transactional) ───────────────────────────────────────────────────────

/**
 * Purchase a shop item.
 *
 * Money flow:
 *   - Player pays totalCost.
 *   - If the player belongs to a city: 5% (floor) goes to city mg_balance,
 *     the remaining 95% goes to the Imperial Treasury (master_card).
 *   - If the player has no city_id: 100% goes to the Treasury.
 *
 * Inventory routing:
 *   - is_crafting_resource = true  -> upsert into player_resource_bag keyed by item name.
 *   - is_crafting_resource = false -> upsert into player_inventory keyed by item id.
 *
 * All writes are inside one transaction.
 *
 * @returns {Object} the shop_items row that was bought
 */
async function buyItem(playerId, itemId, amountToBuy = 1) {
  return db.withTransaction(async (conn) => {
    // ── fetch & validate item ─────────────────────────────────
    const [[item]] = await conn.execute(
      `SELECT * FROM shop_items
       WHERE id = ? AND show_in_shop = TRUE
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [itemId]
    );
    if (!item) throw new Error('العنصر غير متوفر أو انتهت صلاحيته');

    // ── fetch & validate player (include city_id for tax) ─────
    const [[player]] = await conn.execute(
      'SELECT id, mg_balance, city_id FROM players WHERE id = ? LIMIT 1',
      [playerId]
    );
    if (!player) throw new Error('اللاعب غير موجود');

    const totalCost     = item.price * amountToBuy;
    if (player.mg_balance < totalCost) {
      throw new Error(`رصيدك غير كافٍ. تحتاج ${totalCost} MG ولديك ${player.mg_balance} MG`);
    }

    // ── calculate city tax split ──────────────────────────────
    const cityTax       = player.city_id ? Math.floor(totalCost * 0.05) : 0;
    const treasuryShare = totalCost - cityTax;

    // ── deduct from player ────────────────────────────────────
    await conn.execute(
      'UPDATE players SET mg_balance = mg_balance - ? WHERE id = ?',
      [totalCost, playerId]
    );

    // ── 5% to city ────────────────────────────────────────────
    if (cityTax > 0) {
      await conn.execute(
        'UPDATE cities SET mg_balance = mg_balance + ? WHERE id = ?',
        [cityTax, player.city_id]
      );
      await conn.execute(
        `INSERT INTO mg_transactions (type, amount, source, target, description)
         VALUES ('shop_tax', ?, ?, ?, ?)`,
        [cityTax, `player:${playerId}`, `city:${player.city_id}`, `ضريبة مدينة على شراء: ${item.name}`]
      );
    }

    // ── 95% (or 100%) to Imperial Treasury ───────────────────
    await conn.execute(
      'UPDATE master_card SET mg_balance = mg_balance + ? LIMIT 1',
      [treasuryShare]
    );

    // ── main purchase log (full cost for ledger clarity) ──────
    await conn.execute(
      `INSERT INTO mg_transactions (type, amount, source, target, description)
       VALUES ('shop_purchase', ?, ?, 'shop', ?)`,
      [totalCost, `player:${playerId}`, `Bought x${amountToBuy} ${item.name}`]
    );

    // ── inventory routing ─────────────────────────────────────
    if (item.is_crafting_resource) {
      // Crafting resources live in player_resource_bag, keyed by item name
      await conn.execute(
        `INSERT INTO player_resource_bag (player_id, resource_type, quantity)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
        [playerId, item.name, amountToBuy, amountToBuy]
      );
    } else {
      await conn.execute(
        `INSERT INTO player_inventory (player_id, item_id, quantity)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
        [playerId, itemId, amountToBuy, amountToBuy]
      );
    }

    return item;
  });
}

// ── inventory ─────────────────────────────────────────────────────────────────

/**
 * Fetch all non-expired inventory rows for a player, ordered by rarity then name.
 */
async function getPlayerInventory(playerId) {
  return db.query(
    `SELECT pi.quantity, si.id, si.name, si.rarity, si.item_type, si.expires_at
     FROM player_inventory pi
     JOIN shop_items si ON si.id = pi.item_id
     WHERE pi.player_id = ?
       AND (si.expires_at IS NULL OR si.expires_at > NOW())
     ORDER BY FIELD(si.rarity,'legendary','epic','rare','common'), si.name ASC`,
    [playerId]
  );
}

// ── crafting resources ────────────────────────────────────────────────────────

/**
 * Fetch all crafting resources owned by a player from player_resource_bag.
 */
async function getPlayerResources(playerId) {
  return db.query(
    `SELECT resource_type, quantity
     FROM player_resource_bag
     WHERE player_id = ?
     ORDER BY resource_type ASC`,
    [playerId]
  );
}

// ── spin / gacha ──────────────────────────────────────────────────────────────

async function getSpinStatus() {
  const row = await db.queryOne(
    "SELECT value FROM system_settings WHERE `key` = 'is_spin_active' LIMIT 1"
  );
  return row ? row.value === 'true' : false;
}

/**
 * Toggle the spin system on/off.
 * @returns {boolean} the new state (true = active)
 */
async function toggleSpin() {
  const current = await getSpinStatus();
  const next = current ? 'false' : 'true';
  await db.query(
    `INSERT INTO system_settings (\`key\`, value) VALUES ('is_spin_active', ?)
     ON DUPLICATE KEY UPDATE value = ?`,
    [next, next]
  );
  return !current;
}

/**
 * Add an item to the gacha pool.
 * Also creates a hidden shop_items entry so player_inventory FK works
 * without the item appearing in any store tier.
 */
async function addSpinItem(name, rarity, dropRate, pricePerSpin = 100) {
  const shopResult = await db.query(
    `INSERT INTO shop_items (name, price, store_level, item_type, rarity, show_in_shop)
     VALUES (?, 0, 'city', 'special', ?, FALSE)`,
    [name, rarity]
  );
  await db.query(
    `INSERT INTO spin_pool (item_name, item_type, rarity, drop_rate, price_per_spin, shop_item_id)
     VALUES (?, 'special', ?, ?, ?, ?)`,
    [name, rarity, dropRate, pricePerSpin, shopResult.insertId]
  );
}

/** Weighted random pick from pool using each item's drop_rate. */
function weightedPick(pool) {
  const total = pool.reduce((s, i) => s + parseFloat(i.drop_rate), 0);
  let r = Math.random() * total;
  for (const item of pool) {
    r -= parseFloat(item.drop_rate);
    if (r <= 0) return item;
  }
  return pool[pool.length - 1]; // float-rounding fallback
}

/**
 * Execute count spins in a single transaction.
 * Deducts MG, logs a 'spin' transaction, and upserts each won item into
 * player_inventory.
 * @returns {{ results: Object[], totalCost: number, costPerSpin: number }}
 */
async function performSpin(playerId, count = 1) {
  const pool = await db.query('SELECT * FROM spin_pool');
  if (!pool.length) throw new Error('مجمع السحب فارغ حالياً');

  const costPerSpin = pool[0].price_per_spin;
  const totalCost   = costPerSpin * count;

  return db.withTransaction(async (conn) => {
    const [[player]] = await conn.execute(
      'SELECT mg_balance FROM players WHERE id = ? LIMIT 1',
      [playerId]
    );
    if (!player) throw new Error('اللاعب غير موجود');
    if (player.mg_balance < totalCost) {
      throw new Error(`رصيدك غير كافٍ. تحتاج ${totalCost} MG ولديك ${player.mg_balance} MG`);
    }

    await conn.execute(
      'UPDATE players SET mg_balance = mg_balance - ? WHERE id = ?',
      [totalCost, playerId]
    );

    await conn.execute(
      `INSERT INTO mg_transactions (type, amount, source, target, description)
       VALUES ('spin', ?, ?, 'spin_pool', ?)`,
      [totalCost, `player:${playerId}`, `Spin x${count}`]
    );

    const results = [];
    for (let i = 0; i < count; i++) {
      const won = weightedPick(pool);
      results.push(won);
      if (won.shop_item_id) {
        await conn.execute(
          `INSERT INTO player_inventory (player_id, item_id, quantity)
           VALUES (?, ?, 1)
           ON DUPLICATE KEY UPDATE quantity = quantity + 1`,
          [playerId, won.shop_item_id]
        );
      }
    }

    return { results, totalCost, costPerSpin };
  });
}

// ── legendary announcement ────────────────────────────────────────────────────

/**
 * Broadcast a legendary-drop alert scoped by storeLevel.
 * Spin wins should pass storeLevel = 'empire' to broadcast everywhere.
 */
async function announceLegendaryDrop(bot, playerId, itemName, storeLevel) {
  const player = await db.queryOne(
    'SELECT character_name, city_id FROM players WHERE id = ? LIMIT 1',
    [playerId]
  );
  if (!player) return;

  let chatIds = [];

  if (storeLevel === 'city') {
    if (!player.city_id) return;
    const city = await db.queryOne('SELECT chat_id FROM cities WHERE id = ? LIMIT 1', [player.city_id]);
    if (city) chatIds = [city.chat_id];

  } else if (storeLevel === 'kingdom') {
    if (!player.city_id) return;
    const playerCity = await db.queryOne('SELECT kingdom_id FROM cities WHERE id = ? LIMIT 1', [player.city_id]);
    if (playerCity) {
      const cities = await db.query('SELECT chat_id FROM cities WHERE kingdom_id = ?', [playerCity.kingdom_id]);
      chatIds = cities.map(c => c.chat_id);
    }

  } else { // empire — also used for spin wins
    const cities = await db.query('SELECT chat_id FROM cities');
    chatIds = cities.map(c => c.chat_id);
  }

  if (!chatIds.length) return;

  const storeLabelAr = {
    city: 'المدينة', kingdom: 'المملكة', empire: 'الإمبراطورية',
  }[storeLevel] || 'الإمبراطورية';

  const text = [
    `🚨 *ＳＹＳＴＥＭ ＡＬＥＲＴ* 🚨`,
    `> 🔴 *لاعب قد كسر الحدود\\!*`,
    `> 👤 الكيان: *${escMd(player.character_name)}* حصل للتو على العنصر الأسطوري *${escMd(itemName)}* من *${escMd(storeLabelAr)}*\\!`,
  ].join('\n');

  for (const chatId of chatIds) {
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' });
    } catch (err) {
      console.error(`announceLegendaryDrop chat ${chatId}:`, err.message);
    }
  }
}

/**
 * useItem(playerId, itemName, targetCardId?)
 *
 * Applies a shop item's effect and deducts 1 from the player's stock.
 */
async function useItem(playerId, itemName, targetCardId = null) {
  return db.withTransaction(async (conn) => {

    // ── 1. Fetch item details ────────────────────────────────────────────────
    const [[item]] = await conn.execute(
      'SELECT * FROM shop_items WHERE name = ? LIMIT 1',
      [itemName]
    );
    if (!item) throw new Error(`العنصر "${itemName}" غير موجود في المتجر.`);

    // ── 2. Check player stock ────────────────────────────────────────────────
    let currentQty;
    if (item.is_crafting_resource) {
      const [[resRow]] = await conn.execute(
        'SELECT quantity FROM player_resource_bag WHERE player_id = ? AND resource_type = ? LIMIT 1',
        [playerId, item.name]
      );
      currentQty = resRow ? resRow.quantity : 0;
    } else {
      const [[invRow]] = await conn.execute(
        'SELECT quantity FROM player_inventory WHERE player_id = ? AND item_id = ? LIMIT 1',
        [playerId, item.id]
      );
      currentQty = invRow ? invRow.quantity : 0;
    }

    if (currentQty <= 0) {
      throw new Error(`لا تملك "${itemName}" في حقيبتك.`);
    }

    // ── 3. Apply effect ──────────────────────────────────────────────────────
    const { target_type, boost_value } = item;

    if (target_type === 'stats') {
      // Boost HP on the player's first identity card
      await conn.execute(
        `UPDATE identity_cards
            SET hp = hp + ?
          WHERE player_id = ?
          ORDER BY id ASC
          LIMIT 1`,
        [boost_value, playerId]
      );

    } else if (['poison', 'reflect', 'almighty', 'stun', 'weapon'].includes(target_type)) {
      if (!targetCardId) throw new Error('يرجى تحديد ID البطاقة المراد تطويرها.');

      if (target_type === 'weapon') {
        // Verify ownership and apply to weapon_cards.boost_percent
        const [[weaponCard]] = await conn.execute(
          'SELECT id FROM weapon_cards WHERE card_id = ? AND player_id = ? LIMIT 1',
          [targetCardId, playerId]
        );
        if (!weaponCard) throw new Error(`بطاقة السلاح "${targetCardId}" غير موجودة أو لا تعود لك.`);

        await conn.execute(
          'UPDATE weapon_cards SET boost_percent = boost_percent + ? WHERE id = ?',
          [boost_value, weaponCard.id]
        );

      } else if (target_type === 'poison') {
        // Verify ownership and apply to skill_cards.poison_percent
        const [[poisonCard]] = await conn.execute(
          'SELECT id FROM skill_cards WHERE card_id = ? AND player_id = ? LIMIT 1',
          [targetCardId, playerId]
        );
        if (!poisonCard) throw new Error(`بطاقة المهارة "${targetCardId}" غير موجودة أو لا تعود لك.`);

        await conn.execute(
          'UPDATE skill_cards SET poison_percent = poison_percent + ? WHERE id = ?',
          [boost_value, poisonCard.id]
        );

      } else {
        // reflect | almighty | stun  →  skill_cards.effect_points
        const [[skillCard]] = await conn.execute(
          'SELECT id FROM skill_cards WHERE card_id = ? AND player_id = ? LIMIT 1',
          [targetCardId, playerId]
        );
        if (!skillCard) throw new Error(`بطاقة المهارة "${targetCardId}" غير موجودة أو لا تعود لك.`);

        await conn.execute(
          'UPDATE skill_cards SET effect_points = effect_points + ? WHERE id = ?',
          [boost_value, skillCard.id]
        );
      }
    }

    // ── 4. Deduct 1 from inventory ───────────────────────────────────────────
    if (item.is_crafting_resource) {
      if (currentQty === 1) {
        await conn.execute(
          'DELETE FROM player_resource_bag WHERE player_id = ? AND resource_type = ?',
          [playerId, item.name]
        );
      } else {
        await conn.execute(
          'UPDATE player_resource_bag SET quantity = quantity - 1 WHERE player_id = ? AND resource_type = ?',
          [playerId, item.name]
        );
      }
    } else {
      if (currentQty === 1) {
        await conn.execute(
          'DELETE FROM player_inventory WHERE player_id = ? AND item_id = ?',
          [playerId, item.id]
        );
      } else {
        await conn.execute(
          'UPDATE player_inventory SET quantity = quantity - 1 WHERE player_id = ? AND item_id = ?',
          [playerId, item.id]
        );
      }
    }

    // ── 5. Return result ─────────────────────────────────────────────────────
    const cardPart = targetCardId ? ` على البطاقة ${targetCardId}` : '';
    return {
      message:    `تم استخدام ${item.name} بنجاح${cardPart}.`,
      boostValue: item.boost_value,
    };
  });
}
// ── loot fight stake transfer ─────────────────────────────────────────────────

/**
 * Transfer stakes from all losers to the winner after a FFA Loot Fight.
 *
 * winnerPlayerId  – DB player id of the winner.
 * loserIdsArray   – Array of DB player ids of all losers (1-vs-1 passes a single-element array).
 * stakes          – { mg: number, items: [{ qty: number, name: string }] }
 *                   `mg` is the per-loser MG amount; each loser pays this individually.
 *
 * Item routing mirrors buyItem: crafting resources → player_resource_bag,
 * everything else → player_inventory.
 * The winner receives the combined total from every loser in one transaction.
 */
async function transferStakes(winnerPlayerId, loserIdsArray, stakes) {
  const losers = Array.isArray(loserIdsArray) ? loserIdsArray : [loserIdsArray];

  return db.withTransaction(async (conn) => {

    // ── MG: deduct from each loser, credit winner once ────────────────────────
    if (stakes.mg > 0) {
      let totalMg = 0;

      for (const loserId of losers) {
        const [[loser]] = await conn.execute(
          'SELECT mg_balance FROM players WHERE id = ? LIMIT 1', [loserId]
        );
        if (!loser || loser.mg_balance < stakes.mg) {
          throw new Error(`رصيد اللاعب ${loserId} غير كافٍ لنقل الرهان (${loser?.mg_balance ?? 0} / ${stakes.mg} MG).`);
        }

        await conn.execute(
          'UPDATE players SET mg_balance = mg_balance - ? WHERE id = ?',
          [stakes.mg, loserId]
        );
        await conn.execute(
          `INSERT INTO mg_transactions (type, amount, source, target, description)
           VALUES ('loot_fight', ?, ?, ?, ?)`,
          [stakes.mg, `player:${loserId}`, `player:${winnerPlayerId}`, 'نزال النهب — نقل MG']
        );

        totalMg += stakes.mg;
      }

      await conn.execute(
        'UPDATE players SET mg_balance = mg_balance + ? WHERE id = ?',
        [totalMg, winnerPlayerId]
      );
    }

    // ── Items: deduct per loser, credit winner the combined total ─────────────
    for (const { qty, name } of stakes.items) {
      const [[shopItem]] = await conn.execute(
        'SELECT id, is_crafting_resource FROM shop_items WHERE name = ? LIMIT 1', [name]
      );
      if (!shopItem) continue; // unknown item — skip silently

      let totalQty = 0;

      for (const loserId of losers) {
        if (shopItem.is_crafting_resource) {
          const [[loserRow]] = await conn.execute(
            'SELECT quantity FROM player_resource_bag WHERE player_id = ? AND resource_type = ? LIMIT 1',
            [loserId, name]
          );
          const loserQty = loserRow ? loserRow.quantity : 0;
          if (loserQty < qty) {
            throw new Error(`اللاعب ${loserId} لا يملك كميةً كافية من "${name}" لنقل الرهان.`);
          }

          if (loserQty === qty) {
            await conn.execute(
              'DELETE FROM player_resource_bag WHERE player_id = ? AND resource_type = ?',
              [loserId, name]
            );
          } else {
            await conn.execute(
              'UPDATE player_resource_bag SET quantity = quantity - ? WHERE player_id = ? AND resource_type = ?',
              [qty, loserId, name]
            );
          }

        } else {
          const [[loserRow]] = await conn.execute(
            'SELECT quantity FROM player_inventory WHERE player_id = ? AND item_id = ? LIMIT 1',
            [loserId, shopItem.id]
          );
          const loserQty = loserRow ? loserRow.quantity : 0;
          if (loserQty < qty) {
            throw new Error(`اللاعب ${loserId} لا يملك كميةً كافية من "${name}" لنقل الرهان.`);
          }

          if (loserQty === qty) {
            await conn.execute(
              'DELETE FROM player_inventory WHERE player_id = ? AND item_id = ?',
              [loserId, shopItem.id]
            );
          } else {
            await conn.execute(
              'UPDATE player_inventory SET quantity = quantity - ? WHERE player_id = ? AND item_id = ?',
              [qty, loserId, shopItem.id]
            );
          }
        }

        totalQty += qty;
      }

      // Credit winner with the combined quantity from all losers
      if (totalQty > 0) {
        if (shopItem.is_crafting_resource) {
          await conn.execute(
            `INSERT INTO player_resource_bag (player_id, resource_type, quantity)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
            [winnerPlayerId, name, totalQty, totalQty]
          );
        } else {
          await conn.execute(
            `INSERT INTO player_inventory (player_id, item_id, quantity)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
            [winnerPlayerId, shopItem.id, totalQty, totalQty]
          );
        }
      }
    }
  });
}
/**
 * Transfers stakes from a pooled eliminated player to the final winner.
 */
async function transferStakesFromPool(winnerPlayerId, pooledPlayerId, stakes) {
  // هاد الدالة هي نفس منطق transferStakes ولكن للاعب واحد فقط من الـ Pool
  return transferStakes(winnerPlayerId, [pooledPlayerId], stakes);
}
// ── exports ───────────────────────────────────────────────────────────────────

module.exports = {
  getActiveItems,
  addItem,
  deleteItem,
  getPlayerInventory,
  getPlayerResources,
  buyItem,
  getSpinStatus,
  toggleSpin,
  addSpinItem,
  performSpin,
  announceLegendaryDrop,
  useItem,
  transferStakes,
  transferStakesFromPool   
};