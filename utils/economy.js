'use strict';

const db = require('../db/connection');

// ─── Internal helpers ─────────────────────────────────────────────────────────

function playerLabel(player) {
  return `player:${player.player_code}`;
}

async function getTreasury(conn) {
  const [rows] = await conn.execute('SELECT id, mg_balance FROM master_card LIMIT 1');
  if (rows.length > 0) return rows[0];
  await conn.query('INSERT INTO master_card (mg_balance) VALUES (0)');
  const [newRows] = await conn.execute('SELECT id, mg_balance FROM master_card LIMIT 1');
  return newRows[0];
}

async function logTx(conn, { type, amount, source, target, description }) {
  await conn.query(
    `INSERT INTO mg_transactions (type, amount, source, target, description)
     VALUES (?, ?, ?, ?, ?)`,
    [type, amount, source, target, description ?? null]
  );
}

// ─── Existing: mint / treasury transfers ──────────────────────────────────────

async function mintToTreasury(amount, actorLabel) {
  return db.withTransaction(async (conn) => {
    const treasury = await getTreasury(conn);
    await conn.query('UPDATE master_card SET mg_balance = mg_balance + ? WHERE id = ?', [amount, treasury.id]);
    await logTx(conn, {
      type: 'mint', amount,
      source: 'system', target: 'master_card',
      description: `خُلق ${amount} MG بواسطة ${actorLabel}`,
    });
    const [updated] = await conn.execute('SELECT mg_balance FROM master_card WHERE id = ?', [treasury.id]);
    return updated[0].mg_balance;
  });
}

async function treasuryToKingdom(kingdomId, amount, actorLabel) {
  return db.withTransaction(async (conn) => {
    const treasury = await getTreasury(conn);
    if (treasury.mg_balance < amount) throw new Error(`رصيد الخزينة غير كافٍ (${treasury.mg_balance} MG متاح)`);
    const [kingdoms] = await conn.execute('SELECT id, name FROM kingdoms WHERE id = ? FOR UPDATE', [kingdomId]);
    if (kingdoms.length === 0) throw new Error('المملكة غير موجودة');
    const kingdom = kingdoms[0];
    await conn.query('UPDATE master_card SET mg_balance = mg_balance - ? WHERE id = ?', [amount, treasury.id]);
    await conn.query('UPDATE kingdoms SET mg_balance = mg_balance + ? WHERE id = ?', [amount, kingdomId]);
    await logTx(conn, {
      type: 'treasury_to_kingdom', amount,
      source: 'master_card', target: `kingdom:${kingdomId}`,
      description: `${actorLabel} → مملكة ${kingdom.name}`,
    });
    const [updated] = await conn.execute('SELECT mg_balance FROM kingdoms WHERE id = ?', [kingdomId]);
    return { newKingdomBalance: updated[0].mg_balance, newTreasuryBalance: treasury.mg_balance - amount };
  });
}

async function treasuryToCity(cityId, amount, actorLabel) {
  return db.withTransaction(async (conn) => {
    const treasury = await getTreasury(conn);
    if (treasury.mg_balance < amount) throw new Error(`رصيد الخزينة غير كافٍ (${treasury.mg_balance} MG متاح)`);
    const [cities] = await conn.execute('SELECT id, name FROM cities WHERE id = ? FOR UPDATE', [cityId]);
    if (cities.length === 0) throw new Error('المدينة غير موجودة');
    const city = cities[0];
    await conn.query('UPDATE master_card SET mg_balance = mg_balance - ? WHERE id = ?', [amount, treasury.id]);
    await conn.query('UPDATE cities SET mg_balance = mg_balance + ? WHERE id = ?', [amount, cityId]);
    await logTx(conn, {
      type: 'treasury_to_city', amount,
      source: 'master_card', target: `city:${cityId}`,
      description: `${actorLabel} → مدينة ${city.name}`,
    });
    const [updated] = await conn.execute('SELECT mg_balance FROM cities WHERE id = ?', [cityId]);
    return { newCityBalance: updated[0].mg_balance, newTreasuryBalance: treasury.mg_balance - amount };
  });
}

async function treasuryToPlayer(playerId, amount, actorLabel) {
  return db.withTransaction(async (conn) => {
    const treasury = await getTreasury(conn);
    if (treasury.mg_balance < amount) throw new Error(`رصيد الخزينة غير كافٍ (${treasury.mg_balance} MG متاح)`);
    const [players] = await conn.execute('SELECT id, player_code FROM players WHERE id = ? FOR UPDATE', [playerId]);
    if (players.length === 0) throw new Error('اللاعب غير موجود');
    const player = players[0];
    await conn.query('UPDATE master_card SET mg_balance = mg_balance - ? WHERE id = ?', [amount, treasury.id]);
    await conn.query('UPDATE players SET mg_balance = mg_balance + ? WHERE id = ?', [amount, playerId]);
    await logTx(conn, {
      type: 'treasury_to_player', amount,
      source: 'master_card', target: playerLabel(player),
      description: `${actorLabel} (giveEmpir)`,
    });
    const [updated] = await conn.execute('SELECT mg_balance FROM players WHERE id = ?', [playerId]);
    return { newPlayerBalance: updated[0].mg_balance, newTreasuryBalance: treasury.mg_balance - amount };
  });
}

// ─── Existing: distributeCityFunds ───────────────────────────────────────────

async function distributeCityFunds(cityName, actorLabel) {
  return db.withTransaction(async (conn) => {
    const [cities] = await conn.execute(
      'SELECT id, name, mg_balance FROM cities WHERE name = ? FOR UPDATE', [cityName]
    );
    if (cities.length === 0) throw new Error(`لم يُعثر على مدينة باسم: ${cityName}`);
    const city = cities[0];
    if (city.mg_balance <= 0) throw new Error(`رصيد مدينة ${city.name} فارغ — لا يوجد ما يُوزَّع`);

    const totalFund = city.mg_balance;

    const [rulers]   = await conn.execute("SELECT id, player_code, character_name FROM players WHERE system_rank = 'city_ruler' AND city_id = ? FOR UPDATE", [city.id]);
    const [deputies] = await conn.execute("SELECT id, player_code, character_name FROM players WHERE system_rank = 'deputy' AND city_id = ? FOR UPDATE", [city.id]);
    const [advisors] = await conn.execute("SELECT id, player_code, character_name FROM players WHERE system_rank = 'advisor' AND city_id = ? FOR UPDATE", [city.id]);

    const rulerShare   = rulers.length   > 0 ? Math.floor(totalFund * 0.35) : 0;
    const deputyShare  = deputies.length > 0 ? Math.floor(totalFund * 0.15) : 0;
    const advisorShare = advisors.length > 0 ? Math.floor(totalFund * 0.10) : 0;
    const totalDistributed = rulerShare + deputyShare + advisorShare;
    const cityKeeps        = totalFund - totalDistributed;

    const perRuler   = rulers.length   > 0 ? Math.floor(rulerShare   / rulers.length)   : 0;
    const perDeputy  = deputies.length > 0 ? Math.floor(deputyShare  / deputies.length) : 0;
    const perAdvisor = advisors.length > 0 ? Math.floor(advisorShare / advisors.length) : 0;

    for (const ruler of rulers) {
      await conn.query('UPDATE players SET mg_balance = mg_balance + ? WHERE id = ?', [perRuler, ruler.id]);
      await logTx(conn, { type: 'city_distribution', amount: perRuler, source: `city:${city.id}`, target: `player:${ruler.player_code}`, description: `توزيع ${city.name} → حاكم: ${ruler.character_name} (35%)` });
    }
    for (const deputy of deputies) {
      await conn.query('UPDATE players SET mg_balance = mg_balance + ? WHERE id = ?', [perDeputy, deputy.id]);
      await logTx(conn, { type: 'city_distribution', amount: perDeputy, source: `city:${city.id}`, target: `player:${deputy.player_code}`, description: `توزيع ${city.name} → نائب: ${deputy.character_name} (15%)` });
    }
    for (const advisor of advisors) {
      await conn.query('UPDATE players SET mg_balance = mg_balance + ? WHERE id = ?', [perAdvisor, advisor.id]);
      await logTx(conn, { type: 'city_distribution', amount: perAdvisor, source: `city:${city.id}`, target: `player:${advisor.player_code}`, description: `توزيع ${city.name} → مستشار: ${advisor.character_name} (10%)` });
    }

    await conn.query('UPDATE cities SET mg_balance = mg_balance - ? WHERE id = ?', [totalDistributed, city.id]);

    if (cityKeeps > 0) {
      await logTx(conn, { type: 'city_distribution', amount: cityKeeps, source: `city:${city.id}`, target: `city:${city.id}`, description: `احتياطي ${city.name} (40%+ أدوار فارغة)` });
    }

    return { cityName: city.name, totalFund, rulerShare, perRuler, rulers, deputyShare, perDeputy, deputies, advisorShare, perAdvisor, advisors, totalDistributed, cityKeeps };
  });
}

// ─── Existing: playerToPlayerTransfer ────────────────────────────────────────

async function playerToPlayerTransfer(senderTelegramId, targetPlayerCode, amount) {
  if (!amount || amount <= 0) throw new Error('المبلغ يجب أن يكون رقم موجب');
  return db.withTransaction(async (conn) => {
    const [senders] = await conn.execute(
      'SELECT id, player_code, character_name, mg_balance FROM players WHERE telegram_id = ? FOR UPDATE',
      [senderTelegramId]
    );
    if (senders.length === 0) throw new Error('لم يُعثر على حسابك. استخدم $login أولاً.');
    const sender = senders[0];
    if (sender.mg_balance < amount) throw new Error(`رصيدك غير كافٍ — عندك ${sender.mg_balance} MG فقط`);

    const [targets] = await conn.execute(
      'SELECT id, player_code, character_name FROM players WHERE player_code = ? FOR UPDATE',
      [targetPlayerCode.toUpperCase()]
    );
    if (targets.length === 0) throw new Error(`لم يُعثر على لاعب بكود: ${targetPlayerCode}`);
    const target = targets[0];
    if (sender.id === target.id) throw new Error('ما تقدرش تحول لنفسك');

    await conn.query('UPDATE players SET mg_balance = mg_balance - ? WHERE id = ?', [amount, sender.id]);
    await conn.query('UPDATE players SET mg_balance = mg_balance + ? WHERE id = ?', [amount, target.id]);
    await logTx(conn, { type: 'p2p_transfer', amount, source: `player:${sender.player_code}`, target: `player:${target.player_code}`, description: `${sender.character_name} → ${target.character_name}` });

    const [updatedSender] = await conn.execute('SELECT mg_balance FROM players WHERE id = ?', [sender.id]);
    return { senderName: sender.character_name, senderCode: sender.player_code, targetName: target.character_name, targetCode: target.player_code, amount, senderNewBalance: updatedSender[0].mg_balance };
  });
}

// ─── Existing: rewardPlayerFromCity ──────────────────────────────────────────

async function rewardPlayerFromCity(playerId, chatId, idealAmount, description) {
  return db.withTransaction(async (conn) => {
    const [cityRows] = await conn.execute(
      'SELECT id, name, mg_balance FROM cities WHERE chat_id = ? FOR UPDATE',
      [chatId]
    );
    if (cityRows.length === 0) return 0;
    const city = cityRows[0];

    if (city.mg_balance <= 0) return 0;

    const actualReward = Math.min(idealAmount, city.mg_balance);

    const [playerRows] = await conn.execute(
      'SELECT id, player_code FROM players WHERE id = ? FOR UPDATE',
      [playerId]
    );
    if (playerRows.length === 0) return 0;
    const player = playerRows[0];

    await conn.query('UPDATE cities   SET mg_balance = mg_balance - ? WHERE id = ?', [actualReward, city.id]);
    await conn.query('UPDATE players  SET mg_balance = mg_balance + ? WHERE id = ?', [actualReward, playerId]);

    await logTx(conn, {
      type:        'combat_reward',
      amount:      actualReward,
      source:      `city:${city.id}`,
      target:      `player:${player.player_code}`,
      description: `${description} — مدينة ${city.name}`,
    });

    return actualReward;
  });
}

// ─── NEW: treasuryToOfficial ──────────────────────────────────────────────────

/**
 * Pays MG to a High Official (governor / sage / prince) from the Imperial Treasury.
 *
 * Caller is responsible for verifying the target's rank before calling this.
 *
 * @param {number} playerId    - players.id of the target official
 * @param {number} amount      - MG to transfer
 * @param {string} actorLabel  - human-readable label of the actor (for the log)
 * @returns {{ newPlayerBalance: number, newTreasuryBalance: number }}
 */
async function treasuryToOfficial(playerId, amount, actorLabel) {
  return db.withTransaction(async (conn) => {
    const treasury = await getTreasury(conn);
    if (treasury.mg_balance < amount)
      throw new Error(`رصيد الخزينة غير كافٍ (${treasury.mg_balance} MG متاح)`);

    const [players] = await conn.execute(
      'SELECT id, player_code, character_name FROM players WHERE id = ? FOR UPDATE',
      [playerId]
    );
    if (players.length === 0) throw new Error('اللاعب غير موجود');
    const player = players[0];

    await conn.query('UPDATE master_card SET mg_balance = mg_balance - ? WHERE id = ?', [amount, treasury.id]);
    await conn.query('UPDATE players SET mg_balance = mg_balance + ? WHERE id = ?', [amount, playerId]);

    await logTx(conn, {
      type:        'official_payout',
      amount,
      source:      'master_card',
      target:      playerLabel(player),
      description: `${actorLabel} → مسؤول: ${player.character_name} (${player.player_code})`,
    });

    const [updated] = await conn.execute('SELECT mg_balance FROM players WHERE id = ?', [playerId]);
    return {
      newPlayerBalance:   updated[0].mg_balance,
      newTreasuryBalance: treasury.mg_balance - amount,
    };
  });
}

// ─── Read-only helpers ────────────────────────────────────────────────────────

async function getTreasuryBalance() {
  const row = await db.queryOne('SELECT mg_balance FROM master_card LIMIT 1');
  return row ? row.mg_balance : 0;
}

async function getRecentTransactions(limit = 10) {
  return db.query(
    `SELECT type, amount, source, target, description, created_at
       FROM mg_transactions
      ORDER BY id DESC
      LIMIT ?`,
    [limit]
  );
}

async function getTotals() {
  return db.query(
    `SELECT type, SUM(amount) AS total_amount, COUNT(*) AS tx_count
       FROM mg_transactions
      GROUP BY type
      ORDER BY total_amount DESC`
  );
}

module.exports = {
  mintToTreasury,
  treasuryToKingdom,
  treasuryToCity,
  treasuryToPlayer,
  distributeCityFunds,
  playerToPlayerTransfer,
  rewardPlayerFromCity,
  treasuryToOfficial,
  getTreasuryBalance,
  getRecentTransactions,
  getTotals,
};