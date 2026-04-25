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
  // First connect without database to create it if needed
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
    await ensureColumnExists(tempConnection, 'players', 'is_admin', 'BOOLEAN NOT NULL DEFAULT FALSE');
    await ensureColumnExists(tempConnection, 'players', 'can_manage_cards', 'BOOLEAN NOT NULL DEFAULT FALSE');
    await ensureColumnExists(tempConnection, 'identity_cards', 'image_id', 'VARCHAR(255) NULL');
    const addedIdentityAvailableColumns = [
      await ensureColumnExists(tempConnection, 'identity_cards', 'available_atk', 'INT NOT NULL DEFAULT 0'),
      await ensureColumnExists(tempConnection, 'identity_cards', 'available_magic', 'INT NOT NULL DEFAULT 0'),
      await ensureColumnExists(tempConnection, 'identity_cards', 'available_def', 'INT NOT NULL DEFAULT 0'),
      await ensureColumnExists(tempConnection, 'identity_cards', 'available_spd', 'INT NOT NULL DEFAULT 0'),
      await ensureColumnExists(tempConnection, 'identity_cards', 'available_accuracy', 'INT NOT NULL DEFAULT 0')
    ];
    await ensureColumnExists(tempConnection, 'play_cards', 'image_id', 'VARCHAR(255) NULL');
    await ensureColumnExists(tempConnection, 'skill_cards', 'image_id', 'VARCHAR(255) NULL');
    await ensureColumnExists(tempConnection, 'weapon_cards', 'image_id', 'VARCHAR(255) NULL');
    if (addedIdentityAvailableColumns.some(Boolean)) {
      await backfillIdentityAvailableStats(tempConnection);
    }
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
