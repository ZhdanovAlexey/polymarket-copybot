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

  // market_resolutions
  `CREATE TABLE IF NOT EXISTS market_resolutions (
    condition_id TEXT PRIMARY KEY,
    winner_token_id TEXT,
    resolved_at INTEGER,
    market_title TEXT,
    fetched_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
  )`,
  `CREATE INDEX IF NOT EXISTS market_resolutions_status ON market_resolutions(status)`,

  // backfill_jobs
  `CREATE TABLE IF NOT EXISTS backfill_jobs (
    trader_address TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    markets_total INTEGER DEFAULT 0,
    markets_resolved INTEGER DEFAULT 0,
    started_at INTEGER,
    completed_at INTEGER,
    error TEXT
  )`,

  // scoring_weights
  `CREATE TABLE IF NOT EXISTS scoring_weights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    roi_w REAL NOT NULL,
    freq_w REAL NOT NULL,
    wr_w REAL NOT NULL,
    cons_w REAL NOT NULL,
    size_w REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual'
  )`,

  // trader_correlations
  `CREATE TABLE IF NOT EXISTS trader_correlations (
    trader_a TEXT NOT NULL,
    trader_b TEXT NOT NULL,
    correlation REAL NOT NULL,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY (trader_a, trader_b)
  )`,

  // trader_blacklist
  `CREATE TABLE IF NOT EXISTS trader_blacklist (
    address TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    blacklisted_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,

  // equity_snapshots
  `CREATE TABLE IF NOT EXISTS equity_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    equity_usd REAL NOT NULL,
    source TEXT DEFAULT 'auto'
  )`,
  `CREATE INDEX IF NOT EXISTS equity_snapshots_ts ON equity_snapshots(timestamp DESC)`,

  // conviction_params (singleton row id=1)
  `CREATE TABLE IF NOT EXISTS conviction_params (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    bet_base REAL NOT NULL DEFAULT 1.0,
    f1_anchor REAL NOT NULL DEFAULT 20.0,
    f1_max REAL NOT NULL DEFAULT 5.0,
    w2 REAL NOT NULL DEFAULT 0.3,
    w3 REAL NOT NULL DEFAULT 0.5,
    f4_boost REAL NOT NULL DEFAULT 1.0,
    source TEXT NOT NULL DEFAULT 'default',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // conviction_params_history
  `CREATE TABLE IF NOT EXISTS conviction_params_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bet_base REAL NOT NULL,
    f1_anchor REAL NOT NULL,
    f1_max REAL NOT NULL,
    w2 REAL NOT NULL,
    w3 REAL NOT NULL,
    f4_boost REAL NOT NULL,
    source TEXT NOT NULL,
    sharpe_old REAL,
    sharpe_new REAL,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reason TEXT
  )`,

  // twap_orders
  `CREATE TABLE IF NOT EXISTS twap_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_trade_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    condition_id TEXT NOT NULL,
    side TEXT NOT NULL,
    total_slices INTEGER NOT NULL,
    slice_num INTEGER NOT NULL,
    slice_usd REAL NOT NULL,
    slice_size REAL,
    status TEXT NOT NULL DEFAULT 'pending',
    order_id TEXT,
    executed_price REAL,
    executed_at DATETIME,
    initial_price REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    error TEXT,
    UNIQUE(parent_trade_id, slice_num)
  )`,
  `CREATE INDEX IF NOT EXISTS twap_orders_parent ON twap_orders(parent_trade_id)`,
  `CREATE INDEX IF NOT EXISTS twap_orders_status ON twap_orders(status)`,

  // markets_cache
  `CREATE TABLE IF NOT EXISTS markets_cache (
    condition_id TEXT PRIMARY KEY,
    created_at TEXT,
    end_date TEXT,
    volume REAL,
    liquidity REAL,
    cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    // Phase 1 additions
    'ALTER TABLE positions ADD COLUMN high_price REAL',
    'ALTER TABLE positions ADD COLUMN high_price_updated_at INTEGER DEFAULT 0',
    'ALTER TABLE positions ADD COLUMN stop_loss_price REAL',
    'ALTER TABLE positions ADD COLUMN trailing_stop_price REAL',
    'ALTER TABLE positions ADD COLUMN scaled_out INTEGER DEFAULT 0',
    // Phase 3 additions
    'ALTER TABLE positions ADD COLUMN current_price REAL',
    'ALTER TABLE positions ADD COLUMN current_price_updated_at INTEGER DEFAULT 0',
    "ALTER TABLE trades ADD COLUMN reason TEXT DEFAULT 'copy'",
    'ALTER TABLE tracked_traders ADD COLUMN halted_until INTEGER DEFAULT 0',
    'ALTER TABLE tracked_traders ADD COLUMN realized_win_rate REAL',
    'ALTER TABLE tracked_traders ADD COLUMN resolved_trades_count INTEGER DEFAULT 0',
    'ALTER TABLE tracked_traders ADD COLUMN confidence REAL DEFAULT 0',
    // markets_cache: game_start_time
    'ALTER TABLE markets_cache ADD COLUMN game_start_time TEXT',
    // Seed conviction_params singleton row
    `INSERT OR IGNORE INTO conviction_params (id, bet_base, f1_anchor, f1_max, w2, w3, f4_boost, source)
     VALUES (1, 1.0, 20.0, 5.0, 0.3, 0.5, 1.0, 'default')`,
    // Per-trader conviction scalar
    'ALTER TABLE tracked_traders ADD COLUMN conviction_scalar REAL DEFAULT 1.0',
  ];
  for (const sql of schemaUpdates) {
    try { db.exec(sql); } catch { /* column already exists or row already seeded */ }
  }

  // Count tables to verify
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;

  log.info({ tableCount: tables.length, tables: tables.map((t) => t.name) }, 'Migrations complete');
}
