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

  // trades indexes for fast per-trader and per-token lookups
  `CREATE INDEX IF NOT EXISTS trades_trader_ts ON trades(trader_address, timestamp DESC)`,
  `CREATE INDEX IF NOT EXISTS trades_token_side ON trades(token_id, side)`,
  `CREATE INDEX IF NOT EXISTS trades_status ON trades(status)`,
  `CREATE INDEX IF NOT EXISTS trades_timestamp ON trades(timestamp DESC)`,

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

  // bt_universe — Stage E: top-N traders by 12m volume (look-ahead-safe ranking)
  `CREATE TABLE IF NOT EXISTS bt_universe (
    address TEXT PRIMARY KEY,
    name TEXT,
    volume_12m REAL NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // bt_trader_activity — Stage E: full historical trade ledger per trader
  `CREATE TABLE IF NOT EXISTS bt_trader_activity (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    token_id TEXT NOT NULL,
    condition_id TEXT NOT NULL,
    action TEXT NOT NULL,
    price REAL NOT NULL,
    size REAL NOT NULL,
    usd_value REAL NOT NULL,
    market_slug TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS bt_trader_activity_addr_ts ON bt_trader_activity(address, timestamp)`,
  `CREATE INDEX IF NOT EXISTS bt_trader_activity_token_ts ON bt_trader_activity(token_id, timestamp)`,
  `CREATE INDEX IF NOT EXISTS bt_trader_activity_cond_ts ON bt_trader_activity(condition_id, timestamp)`,

  // bt_markets — Stage E: cached Gamma metadata (endDate, liquidity, negRisk, closed flag)
  `CREATE TABLE IF NOT EXISTS bt_markets (
    condition_id TEXT PRIMARY KEY,
    question TEXT,
    slug TEXT,
    end_date TEXT,
    volume REAL,
    liquidity REAL,
    neg_risk INTEGER DEFAULT 0,
    closed INTEGER DEFAULT 0,
    token_ids TEXT,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS bt_markets_closed ON bt_markets(closed)`,

  // bt_market_resolutions — Stage E: CLOB tokens[].winner for closed markets
  `CREATE TABLE IF NOT EXISTS bt_market_resolutions (
    condition_id TEXT PRIMARY KEY,
    winner_token_id TEXT,
    resolved_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // bt_grid_runs — Stage B: grid search results
  `CREATE TABLE IF NOT EXISTS bt_grid_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    params_json TEXT NOT NULL,
    calmar REAL,
    pnl REAL,
    max_dd REAL,
    sharpe REAL,
    win_rate REAL,
    trade_count INTEGER,
    avg_ttr_days REAL,
    ran_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS bt_grid_runs_run_id ON bt_grid_runs(run_id)`,
  `CREATE INDEX IF NOT EXISTS bt_grid_runs_calmar ON bt_grid_runs(calmar DESC)`,

  // bt_walkforward_runs — Stage B: walk-forward validation results
  `CREATE TABLE IF NOT EXISTS bt_walkforward_runs (
    id TEXT PRIMARY KEY,
    params_json TEXT NOT NULL,
    median_calmar REAL,
    min_calmar REAL,
    pct_positive_folds REAL,
    folds_json TEXT,
    ran_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
