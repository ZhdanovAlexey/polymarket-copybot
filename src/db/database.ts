import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createLogger } from '../utils/logger.js';
import { runMigrations } from './migrations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const DATA_DIR = resolve(PROJECT_ROOT, 'data');
const DB_PATH = resolve(DATA_DIR, 'copybot.db');

const log = createLogger('database');

let db: Database.Database | null = null;

/**
 * Get the singleton database instance.
 * Throws if the database has not been initialized.
 */
export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

/**
 * Initialize the SQLite database:
 * - Creates data directory if needed
 * - Opens the database file
 * - Runs all migrations
 */
export function initDb(): void {
  if (db) {
    log.warn('Database already initialized');
    return;
  }

  mkdirSync(DATA_DIR, { recursive: true });

  log.info({ path: DB_PATH }, 'Opening database');
  db = new Database(DB_PATH);

  runMigrations(db);

  log.info('Database initialized successfully');
}

/**
 * Close the database connection.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    log.info('Database connection closed');
  }
}
