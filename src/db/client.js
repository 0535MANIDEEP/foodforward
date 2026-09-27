import mysql from 'mysql2/promise';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/**
 * MySQL access.
 *
 * mysql2/promise throughout, no ORM. A schema this small does not need one, and
 * an ORM would put a translation layer between the CHECK constraints and the
 * tests that are supposed to prove they fire.
 *
 * The pool is a real connection pool to a real server, so a transaction is a
 * real transaction and a row lock is a real row lock.
 */

export function createPool(config = {}) {
  const {
    host = process.env.MYSQL_HOST ?? '127.0.0.1',
    port = Number(process.env.MYSQL_PORT ?? 3306),
    user = process.env.MYSQL_USER ?? 'root',
    password = process.env.MYSQL_PASSWORD ?? 'root',
    database = process.env.MYSQL_DATABASE ?? 'foodforward',
    connectionLimit = Number(process.env.MYSQL_POOL_SIZE ?? 10),
  } = config;

  return mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    connectionLimit,
    // Trust the server's timezone rather than the machine's, so a DATETIME
    // written here means the same thing on a Render host in another region.
    timezone: 'Z',
    // DECIMAL arrives as a string by default, which is correct for money and
    // weight but makes arithmetic surprising. Cast the two that get summed.
    decimalNumbers: true,
    namedPlaceholders: true,
  });
}

/**
 * Split a multi statement schema file and run it one statement at a time.
 *
 * The mysql2 driver refuses several statements in one prepared statement, so a
 * naive `query(schemaSql)` fails on the second CREATE TABLE. Splitting on the
 * statement terminator is safe here because the schema contains no procedure
 * bodies or semicolons inside string literals.
 */
export async function migrate(pool, { schemaPath = SCHEMA_PATH } = {}) {
  const sql = await fs.readFile(schemaPath, 'utf8');
  const statements = sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => s.length > 0);

  const connection = await pool.getConnection();
  try {
    for (const statement of statements) {
      await connection.query(statement);
    }
  } finally {
    connection.release();
  }
  return { statements: statements.length, schemaPath };
}

/** Drop and recreate every table. Test and local setup only. */
export async function reset(pool) {
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of ['collections', 'assignments', 'surplus', 'hubs', 'suppliers']) {
    await pool.query(`DROP TABLE IF EXISTS \`${table}\``);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  await migrate(pool);
}

/** True when the connection actually works, for the health endpoint. */
export async function ping(pool) {
  const [rows] = await pool.query('SELECT 1 AS ok');
  return rows?.[0]?.ok === 1;
}

/**
 * Run a function inside a transaction, rolling back on any throw.
 *
 * The assignment path depends on this: the hub commitment and the assignment row
 * have to move together, or a crash between them leaves a hub permanently
 * down a meal of capacity that no lot will ever fill.
 */
export async function withTransaction(pool, fn) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (err) {
    try {
      await connection.rollback();
    } catch {
      // A rollback failure must not mask the original error, which is the one
      // that explains what went wrong.
    }
    throw err;
  } finally {
    connection.release();
  }
}

/** Create the database if it is not there, so first run is not a manual step. */
export async function ensureDatabase(config = {}) {
  const {
    host = process.env.MYSQL_HOST ?? '127.0.0.1',
    port = Number(process.env.MYSQL_PORT ?? 3306),
    user = process.env.MYSQL_USER ?? 'root',
    password = process.env.MYSQL_PASSWORD ?? 'root',
    database = process.env.MYSQL_DATABASE ?? 'foodforward',
  } = config;

  const admin = await mysql.createConnection({ host, port, user, password, multipleStatements: false });
  try {
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await admin.end();
  }
  return database;
}
