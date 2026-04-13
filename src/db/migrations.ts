import type Database from 'better-sqlite3';
import { createLogger } from '../utils/logger.js';

const log = createLogger('migrations');

const MIGRATIONS: string[] = [
  // settings
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // tracked_traders
  `CREATE TABLE IF NOT EXISTS tracked_traders (
    address TEXT PRIMARY KEY,
    name TEXT,
    pnl REAL,
    volume REAL,
    win_rate REAL,
    score REAL,
    trades_count INTEGER,
    last_seen_timestamp INTEGER NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    active INTEGER DEFAULT 1,
    probation INTEGER DEFAULT 0,
    probation_trades_left INTEGER DEFAULT 0
  )`,

  // trades
  `CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    trader_address TEXT NOT NULL,
    trader_name TEXT,
    side TEXT NOT NULL,
    market_slug TEXT,
    market_title TEXT,
    condition_id TEXT,
    token_id TEXT,
    outcome TEXT,
    size REAL,
    price REAL,
    total_usd REAL,
    order_id TEXT,
    status TEXT NOT NULL,
    error TEXT,
    original_trader_size REAL,
    original_trader_price REAL,
    is_dry_run INTEGER DEFAULT 0,
    FOREIGN KEY (trader_address) REFERENCES tracked_traders(address)
  )`,

  // positions
  `CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id TEXT NOT NULL UNIQUE,
    condition_id TEXT,
    market_slug TEXT,
    market_title TEXT,
    outcome TEXT,
    total_shares REAL NOT NULL,
    avg_price REAL NOT NULL,
    total_invested REAL NOT NULL,
    opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'open'
  )`,

  // pnl_snapshots
  `CREATE TABLE IF NOT EXISTS pnl_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    total_pnl REAL,
    unrealized_pnl REAL,
    realized_pnl REAL,
    balance_usdc REAL,
    open_positions_count INTEGER
  )`,

  // activity_log
  `CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    details TEXT
  )`,

  // trader_performance
  `CREATE TABLE IF NOT EXISTS trader_performance (
    trader_address TEXT NOT NULL,
    date TEXT NOT NULL,
    copied_trades INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    total_pnl REAL DEFAULT 0,
    avg_return REAL DEFAULT 0,
    slippage_avg REAL DEFAULT 0,
    PRIMARY KEY (trader_address, date)
  )`,

  // rotation_log
  `CREATE TABLE IF NOT EXISTS rotation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    old_trader TEXT,
    new_trader TEXT,
    reason TEXT NOT NULL
  )`,

  // backtest_results
  `CREATE TABLE IF NOT EXISTS backtest_results (
    id TEXT PRIMARY KEY,
    config TEXT NOT NULL,
    total_pnl REAL,
    win_rate REAL,
    max_drawdown REAL,
    sharpe REAL,
    trade_count INTEGER,
    equity_curve TEXT,
    trader_breakdown TEXT,
    ran_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // anomaly_log
  `CREATE TABLE IF NOT EXISTS anomaly_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    trader_address TEXT NOT NULL,
    trade_id TEXT,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL
  )`,
];

export function runMigrations(db: Database.Database): void {
  log.info('Running database migrations...');

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const migrate = db.transaction(() => {
    for (const sql of MIGRATIONS) {
      db.exec(sql);
    }
  });

  migrate();

  // Schema updates (ALTER TABLE — wrapped in try/catch for idempotency)
  const schemaUpdates = [
    'ALTER TABLE trades ADD COLUMN commission REAL DEFAULT 0',
    'ALTER TABLE tracked_traders ADD COLUMN exit_only INTEGER DEFAULT 0',
  ];
  for (const sql of schemaUpdates) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  // Count tables to verify
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;

  log.info({ tableCount: tables.length, tables: tables.map((t) => t.name) }, 'Migrations complete');
}
