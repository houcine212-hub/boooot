const PLAY_CARD_RESOURCE_COLUMNS = {
  attack: {
    atk: 'available_atk',
    accuracy: 'available_accuracy'
  },
  defense: {
    def: 'available_def',
    spd: 'available_spd'
  },
  magic: {
    magic: 'available_magic',
    accuracy: 'available_accuracy'
  }
};

function buildReservationEntries(type, stats) {
  const columns = PLAY_CARD_RESOURCE_COLUMNS[type];
  if (!columns) {
    throw new Error(`Unsupported play card type: ${type}`);
  }

  return Object.entries(columns)
    .map(([statKey, columnName]) => ({
      statKey,
      columnName,
      amount: Number.parseInt(stats[statKey] || 0, 10)
    }))
    .filter((entry) => entry.amount > 0);
}

async function reservePlayCardResources(connection, identityCardId, type, stats) {
  const entries = buildReservationEntries(type, stats);

  if (entries.length === 0) {
    return false;
  }

  const setClause = entries
    .map(({ columnName }) => `\`${columnName}\` = \`${columnName}\` - ?`)
    .join(', ');
  const whereClause = entries
    .map(({ columnName }) => `\`${columnName}\` >= ?`)
    .join(' AND ');
  const params = [
    ...entries.map(({ amount }) => amount),
    identityCardId,
    ...entries.map(({ amount }) => amount)
  ];

  const [result] = await connection.execute(
    `UPDATE identity_cards
        SET ${setClause}
      WHERE id = ?
        AND ${whereClause}`,
    params
  );

  return result.affectedRows === 1;
}

async function getAvailablePlayCardBalances(connection, identityCardId) {
  const [rows] = await connection.execute(
    `SELECT available_atk, available_magic, available_def, available_spd, available_accuracy
       FROM identity_cards
      WHERE id = ?
      LIMIT 1`,
    [identityCardId]
  );

  return rows[0] || null;
}

module.exports = {
  PLAY_CARD_RESOURCE_COLUMNS,
  reservePlayCardResources,
  getAvailablePlayCardBalances
};
