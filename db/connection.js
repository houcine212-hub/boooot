const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

let pool;

async function ensureColumnExists(connection, tableName, columnName, definition) {
  const databaseName = process.env.DB_NAME || 'card';
  const [rows] = await connection.execute(
    `SELECT 1
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [databaseName, tableName, columnName]
  );

  if (rows.length > 0) return false;

  await connection.query(
    `ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`
  );
  console.log(`Added column ${tableName}.${columnName}`);
  return true;
}

async function ensureTableExists(connection, tableName, createSQL) {
  const databaseName = process.env.DB_NAME || 'card';
  const [rows] = await connection.execute(
    `SELECT 1
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = ?
     LIMIT 1`,
    [databaseName, tableName]
  );

  if (rows.length > 0) return false;

  await connection.query(createSQL);
  console.log(`Created table ${tableName}`);
  return true;
}

async function backfillIdentityAvailableStats(connection) {
  await connection.query(
    `UPDATE identity_cards
        SET available_atk = atk,
            available_magic = magic,
            available_def = def,
            available_spd = spd,
            available_accuracy = accuracy`
  );
  console.log('Backfilled identity_cards available_* columns from base stats.');
}

/**
 * Create and return a MySQL connection pool
 */
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'card',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: 'utf8mb4'
    });
  }
  return pool;
}

/**
 * Initialize database: create tables if they don't exist
 */
async function initDatabase() {
  const tempConnection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true
  });

  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await tempConnection.query(schema);

    // --- players columns ---
    await ensureColumnExists(tempConnection, 'players', 'is_admin', 'BOOLEAN NOT NULL DEFAULT FALSE');
    await ensureColumnExists(tempConnection, 'players', 'can_manage_cards', 'BOOLEAN NOT NULL DEFAULT FALSE');
    await ensureColumnExists(tempConnection, 'players', 'rank_points', 'INT NOT NULL DEFAULT 0');
    await ensureColumnExists(tempConnection, 'players', 'title', 'VARCHAR(100) NULL DEFAULT NULL');

    // --- identity_cards columns ---
    await ensureColumnExists(tempConnection, 'identity_cards', 'image_id', 'VARCHAR(255) NULL');
    const addedIdentityAvailableColumns = [
      await ensureColumnExists(tempConnection, 'identity_cards', 'available_atk', 'INT NOT NULL DEFAULT 0'),
      await ensureColumnExists(tempConnection, 'identity_cards', 'available_magic', 'INT NOT NULL DEFAULT 0'),
      await ensureColumnExists(tempConnection, 'identity_cards', 'available_def', 'INT NOT NULL DEFAULT 0'),
      await ensureColumnExists(tempConnection, 'identity_cards', 'available_spd', 'INT NOT NULL DEFAULT 0'),
      await ensureColumnExists(tempConnection, 'identity_cards', 'available_accuracy', 'INT NOT NULL DEFAULT 0')
    ];

    // --- other card image_id columns ---
    await ensureColumnExists(tempConnection, 'play_cards', 'image_id', 'VARCHAR(255) NULL');
    await ensureColumnExists(tempConnection, 'skill_cards', 'image_id', 'VARCHAR(255) NULL');
    await ensureColumnExists(tempConnection, 'weapon_cards', 'image_id', 'VARCHAR(255) NULL');

    if (addedIdentityAvailableColumns.some(Boolean)) {
      await backfillIdentityAvailableStats(tempConnection);
    }

    // --- territory tables ---
    await ensureTableExists(
      tempConnection,
      'kingdoms',
      `CREATE TABLE \`kingdoms\` (
        \`id\`         INT AUTO_INCREMENT PRIMARY KEY,
        \`name\`       VARCHAR(100) NOT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );

    await ensureTableExists(
      tempConnection,
      'cities',
      `CREATE TABLE \`cities\` (
        \`id\`         INT AUTO_INCREMENT PRIMARY KEY,
        \`chat_id\`    BIGINT NOT NULL UNIQUE,
        \`name\`       VARCHAR(100) NOT NULL,
        \`kingdom_id\` INT NOT NULL,
        \`is_capital\` BOOLEAN NOT NULL DEFAULT FALSE,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (\`kingdom_id\`) REFERENCES \`kingdoms\`(\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );

    // --- economy columns ---
    await ensureColumnExists(tempConnection, 'players',  'mg_balance', 'INT NOT NULL DEFAULT 0');
    await ensureColumnExists(tempConnection, 'kingdoms', 'mg_balance', 'INT NOT NULL DEFAULT 0');
    await ensureColumnExists(tempConnection, 'cities',   'mg_balance', 'INT NOT NULL DEFAULT 0');

    // --- master_card (Imperial Treasury) ---
    await ensureTableExists(
      tempConnection,
      'master_card',
      `CREATE TABLE \`master_card\` (
        \`id\`         INT AUTO_INCREMENT PRIMARY KEY,
        \`mg_balance\` INT NOT NULL DEFAULT 0,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    await tempConnection.query(
      `INSERT INTO master_card (mg_balance) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM master_card)`
    );

    // --- mg_transactions ---
    await ensureTableExists(
      tempConnection,
      'mg_transactions',
      `CREATE TABLE \`mg_transactions\` (
        \`id\`          INT AUTO_INCREMENT PRIMARY KEY,
        \`type\`        VARCHAR(50)  NOT NULL,
        \`amount\`      INT          NOT NULL,
        \`source\`      VARCHAR(100) NOT NULL,
        \`target\`      VARCHAR(100) NOT NULL,
        \`description\` TEXT         NULL,
        \`created_at\`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_type\`    (\`type\`),
        INDEX \`idx_source\`  (\`source\`),
        INDEX \`idx_target\`  (\`target\`),
        INDEX \`idx_created\` (\`created_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    await ensureColumnExists(tempConnection, 'players', 'city_id', 'INT NULL DEFAULT NULL');
 
    // --- shop tables ---
    await ensureTableExists(
      tempConnection,
      'shop_items',
      `CREATE TABLE \`shop_items\` (
        \`id\`          INT AUTO_INCREMENT PRIMARY KEY,
        \`name\`        VARCHAR(100) NOT NULL,
        \`description\` TEXT,
        \`item_type\`   ENUM('potion','material','card_pack','special') NOT NULL,
        \`rarity\`      ENUM('common','rare','epic','legendary') NOT NULL DEFAULT 'common',
        \`price\`       INT NOT NULL DEFAULT 0,
        \`store_level\` ENUM('city','kingdom','empire') NOT NULL,
        \`created_at\`  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
 
    await ensureTableExists(
      tempConnection,
      'player_inventory',
      `CREATE TABLE \`player_inventory\` (
        \`id\`        INT AUTO_INCREMENT PRIMARY KEY,
        \`player_id\` INT NOT NULL,
        \`item_id\`   INT NOT NULL,
        \`quantity\`  INT NOT NULL DEFAULT 1,
        UNIQUE KEY \`uq_player_item\` (\`player_id\`, \`item_id\`),
        FOREIGN KEY (\`player_id\`) REFERENCES \`players\`(\`id\`) ON DELETE CASCADE,
        FOREIGN KEY (\`item_id\`)   REFERENCES \`shop_items\`(\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    console.log('Database and tables initialized successfully.');
  } catch (err) {
    console.error('Error initializing database:', err.message);
    throw err;
  } finally {
    await tempConnection.end();
  }
}

/**
 * Execute a query with parameters
 */
async function query(sql, params = []) {
  const pool = getPool();
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/**
 * Get a single row
 */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function withTransaction(work) {
  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  getPool,
  initDatabase,
  query,
  queryOne,
  withTransaction
};