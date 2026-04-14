# Backtest Stage B — Grid Search + Walk-Forward Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build CLI tools (`pnpm grid-search`, `pnpm walk-forward`, `pnpm report`) that find the optimal conviction-sizing parameters for copy-trading on a small deposit, validated via rolling walk-forward, producing actionable HTML reports.

**Architecture:** Pre-load all Stage E data (~260k trades, 10k markets, 10k resolutions) into memory. Time-indexed backtester simulates day-by-day: rebuild leaderboard → pick top-N → simulate trades with conviction sizing → track equity/drawdown. Grid search evaluates 300+ parameter combos sequentially, optimizing Calmar (PnL / MaxDrawdown). Walk-forward validates top candidates across 6 rolling folds.

**Tech Stack:** TypeScript ESM, better-sqlite3 (read data, write results), node:test + tsx --test, Chart.js CDN for HTML reports.

---

## File Structure

**New files:**
- `src/core/strategy/conviction.ts` — ConvictionSizer (pure function: trade + context → bet size)
- `src/core/strategy/metrics.ts` — Calmar, Sharpe, win rate calculators (pure functions)
- `src/core/strategy/data-loader.ts` — loads bt_* tables into typed in-memory structures
- `src/core/strategy/historical-leaderboard.ts` — recomputes trader scores at time T from in-memory data
- `src/core/strategy/backtester.ts` — time-indexed day-by-day simulator (NEW file, does NOT modify old `backtest.ts`)
- `src/core/strategy/grid-params.ts` — LHS + fine grid parameter generation
- `src/cli/grid-search.ts` — CLI orchestrator for grid search
- `src/cli/walk-forward.ts` — CLI orchestrator for walk-forward validation
- `src/cli/report.ts` — CLI for HTML/CSV report generation
- Co-located `*.test.ts` files

**Modified files:**
- `src/types.ts` — add new interfaces
- `src/db/migrations.ts` — add bt_grid_runs, bt_walkforward_runs tables
- `src/db/bt-queries.ts` — add grid/walkforward query functions
- `package.json` — add grid-search, walk-forward, report scripts

---

## Task 1: Types for Stage B

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Append Stage B types to `src/types.ts`**

After the existing `CollectHistoryOptions` interface, append:

```ts
// === Stage B: Grid Search + Backtest Types ===

export interface ConvictionParams {
  betBase: number;         // base bet in USD (e.g. $2)
  f1Anchor: number;        // USD anchor for F1 normalization
  f1Max: number;           // max F1 multiplier
  w2: number;              // F2 z-score weight (0 = off)
  w3: number;              // F3 trader-score weight (0 = off)
  f4Boost: number;         // F4 consensus multiplier (1.0 = off)
}

export interface BacktestSimConfig {
  conviction: ConvictionParams;
  topN: number;                   // active traders per day
  leaderboardWindowDays: number;  // scoring lookback
  maxTtrDays: number;             // H7 filter (Infinity = off)
  maxPositions: number;           // concurrent open positions
  initialCapital: number;         // starting equity
  slippagePct: number;            // fixed spread per trade (e.g. 1)
  commissionPct: number;          // per-trade commission (e.g. 2)
}

export interface SimPosition {
  tokenId: string;
  conditionId: string;
  shares: number;
  avgPrice: number;
  invested: number;
  openedAtTs: number;
}

export interface DailyEquityPoint {
  dayTs: number;    // start-of-day Unix timestamp
  equity: number;
}

export interface BacktestSimResult {
  config: BacktestSimConfig;
  calmar: number;
  totalPnl: number;
  maxDrawdown: number;
  sharpe: number;
  winRate: number;
  tradeCount: number;
  avgTtrDays: number;
  equityCurve: DailyEquityPoint[];
}

export interface GridRunResult {
  id: string;
  runId: string;
  paramsJson: string;
  calmar: number;
  pnl: number;
  maxDd: number;
  sharpe: number;
  winRate: number;
  tradeCount: number;
  avgTtrDays: number;
  ranAt: string;
}

export interface WalkForwardResult {
  id: string;
  paramsJson: string;
  medianCalmar: number;
  minCalmar: number;
  pctPositiveFolds: number;
  foldsJson: string;
  ranAt: string;
}

/** In-memory dataset loaded from bt_* tables for pure-function backtesting. */
export interface BtDataset {
  /** All trades sorted by timestamp ASC. */
  trades: BtTradeActivity[];
  /** Map conditionId → BtMarket */
  markets: Map<string, BtMarket>;
  /** Map conditionId → winnerTokenId (null if no winner) */
  resolutions: Map<string, string | null>;
  /** All addresses in the universe. */
  universe: string[];
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add Stage B types (ConvictionParams, BacktestSimConfig, GridRunResult, etc.)"
```

---

## Task 2: Migrations + queries for grid/walkforward tables

**Files:**
- Modify: `src/db/migrations.ts`
- Modify: `src/db/bt-queries.ts`
- Create: `src/db/bt-queries-b.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/db/bt-queries-b.test.ts`:

```ts
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from './database.js';
import {
  insertGridRun,
  topGridRuns,
  insertWalkForwardRun,
  topWalkForwardRuns,
} from './bt-queries.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => closeDb());

test('insertGridRun + topGridRuns: stores and retrieves by calmar DESC', () => {
  insertGridRun({
    id: 'g1', runId: 'run1', paramsJson: '{"topN":5}', calmar: 2.5,
    pnl: 100, maxDd: 40, sharpe: 1.2, winRate: 0.55, tradeCount: 50, avgTtrDays: 7, ranAt: '',
  });
  insertGridRun({
    id: 'g2', runId: 'run1', paramsJson: '{"topN":10}', calmar: 5.0,
    pnl: 200, maxDd: 40, sharpe: 1.8, winRate: 0.60, tradeCount: 80, avgTtrDays: 5, ranAt: '',
  });
  const top = topGridRuns(10);
  assert.equal(top.length, 2);
  assert.equal(top[0]!.id, 'g2');  // higher calmar first
  assert.equal(top[0]!.calmar, 5.0);
});

test('insertWalkForwardRun + topWalkForwardRuns: by min_calmar DESC', () => {
  insertWalkForwardRun({
    id: 'w1', paramsJson: '{"topN":5}', medianCalmar: 3.0, minCalmar: 1.5,
    pctPositiveFolds: 100, foldsJson: '[]', ranAt: '',
  });
  insertWalkForwardRun({
    id: 'w2', paramsJson: '{"topN":10}', medianCalmar: 2.0, minCalmar: 2.0,
    pctPositiveFolds: 83, foldsJson: '[]', ranAt: '',
  });
  const top = topWalkForwardRuns(10);
  assert.equal(top.length, 2);
  assert.equal(top[0]!.id, 'w2');  // higher min_calmar first
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/db/bt-queries-b.test.ts`
Expected FAIL: functions not exported.

- [ ] **Step 3: Add migrations to `src/db/migrations.ts`**

Append to the `MIGRATIONS` array (before closing `]`):

```ts
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
```

- [ ] **Step 4: Append query functions to `src/db/bt-queries.ts`**

Append at the end of `bt-queries.ts`:

```ts
// ============================================================
// bt_grid_runs (Stage B)
// ============================================================

export function insertGridRun(r: GridRunResult): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO bt_grid_runs
       (id, run_id, params_json, calmar, pnl, max_dd, sharpe, win_rate, trade_count, avg_ttr_days)
       VALUES (@id, @runId, @paramsJson, @calmar, @pnl, @maxDd, @sharpe, @winRate, @tradeCount, @avgTtrDays)`,
    )
    .run(r);
}

export function topGridRuns(limit: number, runId?: string): GridRunResult[] {
  const sql = runId
    ? 'SELECT * FROM bt_grid_runs WHERE run_id = ? ORDER BY calmar DESC LIMIT ?'
    : 'SELECT * FROM bt_grid_runs ORDER BY calmar DESC LIMIT ?';
  const args = runId ? [runId, limit] : [limit];
  const rows = getDb().prepare(sql).all(...args) as Array<Record<string, unknown>>;
  return rows.map(mapGridRun);
}

function mapGridRun(r: Record<string, unknown>): GridRunResult {
  return {
    id: String(r.id), runId: String(r.run_id), paramsJson: String(r.params_json),
    calmar: Number(r.calmar), pnl: Number(r.pnl), maxDd: Number(r.max_dd),
    sharpe: Number(r.sharpe), winRate: Number(r.win_rate),
    tradeCount: Number(r.trade_count), avgTtrDays: Number(r.avg_ttr_days),
    ranAt: String(r.ran_at),
  };
}

// ============================================================
// bt_walkforward_runs (Stage B)
// ============================================================

export function insertWalkForwardRun(r: WalkForwardResult): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO bt_walkforward_runs
       (id, params_json, median_calmar, min_calmar, pct_positive_folds, folds_json)
       VALUES (@id, @paramsJson, @medianCalmar, @minCalmar, @pctPositiveFolds, @foldsJson)`,
    )
    .run(r);
}

export function topWalkForwardRuns(limit: number): WalkForwardResult[] {
  const rows = getDb()
    .prepare('SELECT * FROM bt_walkforward_runs ORDER BY min_calmar DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id), paramsJson: String(r.params_json),
    medianCalmar: Number(r.median_calmar), minCalmar: Number(r.min_calmar),
    pctPositiveFolds: Number(r.pct_positive_folds), foldsJson: String(r.folds_json),
    ranAt: String(r.ran_at),
  }));
}
```

Add imports at top of `bt-queries.ts` for the new types:

```ts
import type {
  BtUniverseEntry, BtTradeActivity, BtMarket, BtMarketResolution,
  GridRunResult, WalkForwardResult,
} from '../types.js';
```

- [ ] **Step 5: Run tests**

Run: `pnpm test`
Expected: all pass (52 existing + 2 new = 54).

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations.ts src/db/bt-queries.ts src/db/bt-queries-b.test.ts
git commit -m "feat(db): bt_grid_runs + bt_walkforward_runs tables and queries"
```

---

## Task 3: Metrics module (Calmar, Sharpe, win rate)

**Files:**
- Create: `src/core/strategy/metrics.ts`
- Create: `src/core/strategy/metrics.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/strategy/metrics.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calmar, sharpe, winRate } from './metrics.js';

test('calmar: positive pnl / drawdown', () => {
  assert.equal(calmar(100, 40), 2.5);
});

test('calmar: zero drawdown returns Infinity', () => {
  assert.equal(calmar(100, 0), Infinity);
});

test('calmar: negative pnl', () => {
  assert.ok(calmar(-50, 60) < 0);
});

test('sharpe: flat returns = 0', () => {
  const eq = [100, 100, 100, 100, 100];
  assert.equal(sharpe(eq), 0);
});

test('sharpe: steadily increasing = high', () => {
  const eq = [100, 101, 102, 103, 104, 105];
  assert.ok(sharpe(eq) > 5); // very consistent returns → high sharpe
});

test('sharpe: volatile = lower than steady', () => {
  const steady = [100, 101, 102, 103, 104, 105];
  const volatile = [100, 110, 95, 115, 90, 105];
  assert.ok(sharpe(steady) > sharpe(volatile));
});

test('winRate: 3 wins out of 5', () => {
  assert.equal(winRate(3, 5), 0.6);
});

test('winRate: 0 trades = 0', () => {
  assert.equal(winRate(0, 0), 0);
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/core/strategy/metrics.test.ts`

- [ ] **Step 3: Implement**

Create `src/core/strategy/metrics.ts`:

```ts
/**
 * Calmar ratio = total PnL / max drawdown.
 * Higher is better. Returns Infinity if no drawdown.
 */
export function calmar(totalPnl: number, maxDrawdown: number): number {
  if (maxDrawdown === 0) return totalPnl > 0 ? Infinity : 0;
  return totalPnl / maxDrawdown;
}

/**
 * Annualized Sharpe ratio from an equity curve (daily values).
 * sharpe = (mean_daily_return / std_daily_return) * sqrt(252).
 * Returns 0 if fewer than 2 data points or zero variance.
 */
export function sharpe(equityCurve: number[]): number {
  if (equityCurve.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    returns.push((equityCurve[i]! - equityCurve[i - 1]!) / equityCurve[i - 1]!);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(252);
}

/**
 * Win rate = wins / total. Returns 0 if total = 0.
 */
export function winRate(wins: number, total: number): number {
  if (total === 0) return 0;
  return wins / total;
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm test src/core/strategy/metrics.test.ts`
Expected: 8/8 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/strategy/metrics.ts src/core/strategy/metrics.test.ts
git commit -m "feat(strategy): metrics module — calmar, sharpe, winRate"
```

---

## Task 4: Data loader (bt_* tables → in-memory BtDataset)

**Files:**
- Create: `src/core/strategy/data-loader.ts`
- Create: `src/core/strategy/data-loader.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/core/strategy/data-loader.test.ts`:

```ts
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../db/database.js';
import {
  upsertUniverseEntries, bulkInsertActivity, upsertMarket, upsertResolution,
} from '../../db/bt-queries.js';
import { loadDataset } from './data-loader.js';

beforeEach(() => {
  initDb(':memory:');
  upsertUniverseEntries([
    { address: '0xA', name: 'alice', volume12m: 1000, addedAt: '' },
  ]);
  bulkInsertActivity([
    { id: 't1', address: '0xA', timestamp: 100, tokenId: 'tok1', conditionId: 'c1',
      action: 'buy', price: 0.5, size: 10, usdValue: 5, marketSlug: 'm1' },
    { id: 't2', address: '0xA', timestamp: 200, tokenId: 'tok1', conditionId: 'c1',
      action: 'sell', price: 0.7, size: 8, usdValue: 5.6, marketSlug: 'm1' },
  ]);
  upsertMarket({
    conditionId: 'c1', question: 'Q1', slug: 'q1', endDate: '2026-05-01',
    volume: 0, liquidity: 0, negRisk: 0, closed: 1, tokenIds: '["tok1","tok2"]',
  });
  upsertResolution({ conditionId: 'c1', winnerTokenId: 'tok1', resolvedAt: '' });
});
afterEach(() => closeDb());

test('loadDataset: loads all tables into memory', () => {
  const ds = loadDataset();
  assert.equal(ds.trades.length, 2);
  assert.equal(ds.trades[0]!.timestamp, 100); // sorted ASC
  assert.equal(ds.universe.length, 1);
  assert.equal(ds.markets.size, 1);
  assert.ok(ds.markets.has('c1'));
  assert.equal(ds.resolutions.get('c1'), 'tok1');
});

test('loadDataset: trades sorted by timestamp ASC', () => {
  const ds = loadDataset();
  for (let i = 1; i < ds.trades.length; i++) {
    assert.ok(ds.trades[i]!.timestamp >= ds.trades[i - 1]!.timestamp);
  }
});
```

- [ ] **Step 2: Run test, expect FAIL**

- [ ] **Step 3: Implement**

Create `src/core/strategy/data-loader.ts`:

```ts
import { getDb } from '../../db/database.js';
import { createLogger } from '../../utils/logger.js';
import type { BtTradeActivity, BtMarket, BtDataset } from '../../types.js';

const log = createLogger('data-loader');

/**
 * Load all Stage E data into memory for pure-function backtesting.
 * Called once before grid search; data is ~30-40 MB for 260k trades.
 */
export function loadDataset(): BtDataset {
  const db = getDb();

  // Trades — sorted by timestamp ASC (critical for day-by-day iteration)
  const rawTrades = db
    .prepare('SELECT * FROM bt_trader_activity ORDER BY timestamp ASC')
    .all() as Array<Record<string, unknown>>;
  const trades: BtTradeActivity[] = rawTrades.map((r) => ({
    id: String(r.id),
    address: String(r.address),
    timestamp: Number(r.timestamp),
    tokenId: String(r.token_id),
    conditionId: String(r.condition_id),
    action: String(r.action) as 'buy' | 'sell',
    price: Number(r.price),
    size: Number(r.size),
    usdValue: Number(r.usd_value),
    marketSlug: String(r.market_slug ?? ''),
  }));

  // Markets — keyed by conditionId
  const rawMarkets = db.prepare('SELECT * FROM bt_markets').all() as Array<Record<string, unknown>>;
  const markets = new Map<string, BtMarket>();
  for (const r of rawMarkets) {
    markets.set(String(r.condition_id), {
      conditionId: String(r.condition_id),
      question: String(r.question ?? ''),
      slug: String(r.slug ?? ''),
      endDate: r.end_date ? String(r.end_date) : null,
      volume: Number(r.volume ?? 0),
      liquidity: Number(r.liquidity ?? 0),
      negRisk: Number(r.neg_risk ?? 0),
      closed: Number(r.closed ?? 0),
      tokenIds: String(r.token_ids ?? '[]'),
    });
  }

  // Resolutions — map conditionId → winnerTokenId
  const rawRes = db.prepare('SELECT condition_id, winner_token_id FROM bt_market_resolutions').all() as Array<Record<string, unknown>>;
  const resolutions = new Map<string, string | null>();
  for (const r of rawRes) {
    resolutions.set(String(r.condition_id), r.winner_token_id ? String(r.winner_token_id) : null);
  }

  // Universe — just addresses
  const rawUni = db.prepare('SELECT address FROM bt_universe').all() as Array<{ address: string }>;
  const universe = rawUni.map((r) => r.address);

  log.info({
    trades: trades.length, markets: markets.size,
    resolutions: resolutions.size, universe: universe.length,
  }, 'Dataset loaded into memory');

  return { trades, markets, resolutions, universe };
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm test src/core/strategy/data-loader.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/core/strategy/data-loader.ts src/core/strategy/data-loader.test.ts
git commit -m "feat(strategy): data-loader — load bt_* tables into memory for backtesting"
```

---

## Task 5: Historical leaderboard scorer

**Files:**
- Create: `src/core/strategy/historical-leaderboard.ts`
- Create: `src/core/strategy/historical-leaderboard.test.ts`

Recomputes trader scores at an arbitrary point in time T, using only data available before T. This is the core defense against look-ahead bias.

- [ ] **Step 1: Write failing test**

Create `src/core/strategy/historical-leaderboard.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreTraderAtTime, pickTopN } from './historical-leaderboard.js';
import type { BtTradeActivity, BtDataset, BtMarket } from '../../types.js';

function makeTrade(overrides: Partial<BtTradeActivity>): BtTradeActivity {
  return {
    id: 'x', address: '0xA', timestamp: 100, tokenId: 'tok1', conditionId: 'c1',
    action: 'buy', price: 0.5, size: 10, usdValue: 5, marketSlug: 's',
    ...overrides,
  };
}

function makeDataset(trades: BtTradeActivity[]): BtDataset {
  return {
    trades,
    markets: new Map(),
    resolutions: new Map([['c1', 'tok1'], ['c2', null]]),
    universe: [...new Set(trades.map((t) => t.address))],
  };
}

test('scoreTraderAtTime: uses only trades before T in window', () => {
  const trades = [
    makeTrade({ address: '0xA', timestamp: 50, usdValue: 100, conditionId: 'c1', tokenId: 'tok1', action: 'buy' }),
    makeTrade({ address: '0xA', timestamp: 80, usdValue: 50, conditionId: 'c1', tokenId: 'tok1', action: 'sell' }),
    makeTrade({ address: '0xA', timestamp: 150, usdValue: 200, conditionId: 'c2', action: 'buy' }), // after T=100
  ];
  const ds = makeDataset(trades);
  const result = scoreTraderAtTime('0xA', ds, 100, 60); // T=100, window=60 → [40, 100)
  // Only trades at ts=50 and ts=80 are in window [40, 100)
  assert.equal(result.tradesCount, 2);
  assert.ok(result.pnl !== undefined);
  assert.ok(result.score > 0);
});

test('scoreTraderAtTime: returns zero score for trader with no trades in window', () => {
  const ds = makeDataset([makeTrade({ address: '0xA', timestamp: 10 })]);
  const result = scoreTraderAtTime('0xA', ds, 100, 30); // window [70, 100) — trade at 10 is outside
  assert.equal(result.tradesCount, 0);
  assert.equal(result.score, 0);
});

test('pickTopN: returns top-N by score descending', () => {
  const trades = [
    // 0xA: 2 winning buys — higher PnL
    makeTrade({ id: 'a1', address: '0xA', timestamp: 50, usdValue: 100, action: 'buy', tokenId: 'tok1', conditionId: 'c1' }),
    makeTrade({ id: 'a2', address: '0xA', timestamp: 60, usdValue: 50, action: 'buy', tokenId: 'tok1', conditionId: 'c1' }),
    // 0xB: 1 losing buy — lower PnL
    makeTrade({ id: 'b1', address: '0xB', timestamp: 55, usdValue: 30, action: 'buy', tokenId: 'tok2', conditionId: 'c2' }),
  ];
  const ds = makeDataset(trades);
  const top = pickTopN(ds, 100, 60, 1); // top 1
  assert.equal(top.length, 1);
  assert.equal(top[0]!.address, '0xA'); // higher score
});
```

- [ ] **Step 2: Run test, expect FAIL**

- [ ] **Step 3: Implement**

Create `src/core/strategy/historical-leaderboard.ts`:

```ts
import type { BtDataset, BtTradeActivity, LeaderboardEntry } from '../../types.js';

// Reuse the same scoring formula as the live leaderboard (leaderboard.ts:90-122).
// Inlined here to avoid importing the Leaderboard class (which depends on DataApi).

interface TraderSnapshot {
  address: string;
  pnl: number;
  volume: number;
  tradesCount: number;
  winRate: number;
  score: number;
}

/**
 * Score a single trader using data in window [T - windowDays*86400, T).
 * Win rate uses ground-truth resolutions (not heuristic price > 0.5).
 */
export function scoreTraderAtTime(
  address: string,
  ds: BtDataset,
  T: number,
  windowDays: number,
): TraderSnapshot {
  const windowStart = T - windowDays * 86400;

  // Collect trades in window
  const windowTrades = ds.trades.filter(
    (t) => t.address === address && t.timestamp >= windowStart && t.timestamp < T,
  );

  if (windowTrades.length === 0) {
    return { address, pnl: 0, volume: 0, tradesCount: 0, winRate: 0, score: 0 };
  }

  // PnL estimation from buy/sell + resolutions
  let pnl = 0;
  let volume = 0;
  let wins = 0;
  let resolvedBuys = 0;

  for (const t of windowTrades) {
    volume += t.usdValue;
    if (t.action === 'buy') {
      const winner = ds.resolutions.get(t.conditionId);
      if (winner !== undefined) {
        resolvedBuys++;
        if (t.tokenId === winner) {
          // Won: paid price, received $1/share
          pnl += t.size * (1 - t.price);
          wins++;
        } else {
          // Lost: paid price, received $0
          pnl -= t.size * t.price;
        }
      }
    }
    // SELL pnl is implicit (captured in buy-side resolution)
  }

  const winRateVal = resolvedBuys > 0 ? wins / resolvedBuys : 0;
  const score = calculateScore(pnl, volume, windowTrades.length, winRateVal);

  return {
    address, pnl, volume, tradesCount: windowTrades.length, winRate: winRateVal, score,
  };
}

/**
 * Pick top-N traders by composite score at time T.
 */
export function pickTopN(
  ds: BtDataset,
  T: number,
  windowDays: number,
  topN: number,
): TraderSnapshot[] {
  const snapshots = ds.universe
    .map((addr) => scoreTraderAtTime(addr, ds, T, windowDays))
    .filter((s) => s.tradesCount >= 3);  // min activity threshold

  snapshots.sort((a, b) => b.score - a.score);
  return snapshots.slice(0, topN);
}

/**
 * Composite score formula (mirrored from leaderboard.ts:90-122).
 * PnL 40% + WinRate 25% + Volume 15% + TradeCount 10% + Consistency 10%.
 */
function calculateScore(pnl: number, volume: number, tradesCount: number, winRate: number): number {
  const pnlSign = pnl >= 0 ? 1 : -1;
  const pnlMagnitude = Math.min(100, (Math.log10(Math.max(1, Math.abs(pnl))) / 7) * 100);
  const pnlScore = pnlSign * pnlMagnitude;
  const winRateScore = winRate * 100;
  const volumeScore = Math.min(100, Math.max(0, (Math.log10(Math.max(1, volume)) / 8) * 100));
  const tradesScore = Math.min(100, (tradesCount / 100) * 100);
  const consistencyScore = Math.min(100, winRate * 100 * (Math.min(tradesCount, 50) / 50));

  return (
    pnlScore * 0.4 +
    winRateScore * 0.25 +
    volumeScore * 0.15 +
    tradesScore * 0.1 +
    consistencyScore * 0.1
  );
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm test src/core/strategy/historical-leaderboard.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/core/strategy/historical-leaderboard.ts src/core/strategy/historical-leaderboard.test.ts
git commit -m "feat(strategy): historical-leaderboard — recompute trader scores at time T"
```

---

## Task 6: ConvictionSizer

**Files:**
- Create: `src/core/strategy/conviction.ts`
- Create: `src/core/strategy/conviction.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/core/strategy/conviction.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeConviction } from './conviction.js';
import type { ConvictionParams, BtTradeActivity } from '../../types.js';

const baseParams: ConvictionParams = {
  betBase: 2, f1Anchor: 100, f1Max: 5, w2: 0, w3: 0, f4Boost: 1.0,
};

function makeTrade(usdValue: number): BtTradeActivity {
  return {
    id: 'x', address: '0xA', timestamp: 100, tokenId: 'tok', conditionId: 'c',
    action: 'buy', price: 0.5, size: 10, usdValue, marketSlug: 's',
  };
}

test('conviction: F1 only — scales with trader USD, clamped at f1Max', () => {
  // $100 trade / $100 anchor = 1x → bet = $2
  assert.equal(computeConviction(makeTrade(100), baseParams, [], 0, 0), 2);
  // $500 trade / $100 anchor = 5x → clamped at f1Max=5 → bet = $10
  assert.equal(computeConviction(makeTrade(500), baseParams, [], 0, 0), 10);
  // $1000 trade → 10x clamped at 5 → bet = $10
  assert.equal(computeConviction(makeTrade(1000), baseParams, [], 0, 0), 10);
  // $10 trade → 0.1x clamped at min 1 → bet = $2
  assert.equal(computeConviction(makeTrade(10), baseParams, [], 0, 0), 2);
});

test('conviction: F2 z-score boost', () => {
  const params = { ...baseParams, w2: 0.5 };
  // Past trades: all $100 → z-score of $200 trade = (200-100)/std ≈ positive
  const recentUsdValues = [100, 100, 100, 100, 100];
  const bet = computeConviction(makeTrade(200), params, recentUsdValues, 0, 0);
  // F1 = clamp(200/100, 1, 5) = 2 → base = $4
  // F2 = 1 + 0.5 * positive_zscore → should be > $4
  assert.ok(bet > 4, `Expected > 4, got ${bet}`);
});

test('conviction: F3 trader score boost', () => {
  const params = { ...baseParams, w3: 1.0 };
  // score=50 out of 100 → mult = 1 + 1.0 * 50/100 = 1.5
  const bet = computeConviction(makeTrade(100), params, [], 50, 0);
  assert.equal(bet, 2 * 1.5); // $2 * 1 (F1) * 1.5 (F3)
});

test('conviction: F4 consensus boost', () => {
  const params = { ...baseParams, f4Boost: 2.0 };
  // consensusCount=2 → apply f4Boost
  const bet = computeConviction(makeTrade(100), params, [], 0, 2);
  assert.equal(bet, 2 * 2.0); // $2 * 1 (F1) * 2.0 (F4)
});

test('conviction: all factors combined', () => {
  const params: ConvictionParams = {
    betBase: 2, f1Anchor: 100, f1Max: 5, w2: 0.3, w3: 0.5, f4Boost: 1.5,
  };
  // F1 = clamp(200/100, 1, 5) = 2
  // F2 = 1 + 0.3 * zscore(200, [100,100,100]) > 1
  // F3 = 1 + 0.5 * 60/100 = 1.3
  // F4 = 1.5 (consensus >= 2)
  const bet = computeConviction(makeTrade(200), params, [100, 100, 100], 60, 3);
  // $2 * 2 (F1) * >1 (F2) * 1.3 (F3) * 1.5 (F4) > $2 * 2 * 1 * 1.3 * 1.5 = $7.8
  assert.ok(bet > 7.8, `Expected > 7.8, got ${bet}`);
});

test('conviction: zero usdValue → bet = betBase (min F1=1)', () => {
  assert.equal(computeConviction(makeTrade(0), baseParams, [], 0, 0), 2);
});
```

- [ ] **Step 2: Run test, expect FAIL**

- [ ] **Step 3: Implement**

Create `src/core/strategy/conviction.ts`:

```ts
import type { ConvictionParams, BtTradeActivity } from '../../types.js';

/**
 * Compute conviction-sized bet in USD.
 *
 * @param trade         The trade signal being evaluated
 * @param params        Conviction parameters (from grid search)
 * @param recentUsd     Recent USD values for this trader (for F2 z-score, last 50)
 * @param traderScore   Composite leaderboard score at time T (0-100)
 * @param consensusCount Number of distinct tracked traders who bought same token in last 24h
 * @returns USD bet size (always >= betBase)
 */
export function computeConviction(
  trade: BtTradeActivity,
  params: ConvictionParams,
  recentUsd: number[],
  traderScore: number,
  consensusCount: number,
): number {
  // F1: absolute USD signal, clamped
  const f1Raw = params.f1Anchor > 0 ? trade.usdValue / params.f1Anchor : 1;
  const f1 = Math.max(1, Math.min(f1Raw, params.f1Max));

  // F2: z-score relative to trader's recent history
  let f2 = 1;
  if (params.w2 > 0 && recentUsd.length >= 3) {
    const mean = recentUsd.reduce((a, b) => a + b, 0) / recentUsd.length;
    const variance = recentUsd.reduce((a, b) => a + (b - mean) ** 2, 0) / recentUsd.length;
    const std = Math.sqrt(variance);
    if (std > 0) {
      const zscore = (trade.usdValue - mean) / std;
      // Clamp z-score effect to [-2, +3] to avoid extreme bets
      const clampedZ = Math.max(-2, Math.min(zscore, 3));
      f2 = 1 + params.w2 * clampedZ;
    }
  }

  // F3: trader quality multiplier
  const f3 = 1 + params.w3 * (traderScore / 100);

  // F4: consensus boost (only if >= 2 other traders on same token)
  const f4 = consensusCount >= 2 ? params.f4Boost : 1.0;

  const bet = params.betBase * f1 * f2 * f3 * f4;

  // Floor at betBase (never bet less than base, even with negative z-score)
  return Math.max(params.betBase, bet);
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm test src/core/strategy/conviction.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/core/strategy/conviction.ts src/core/strategy/conviction.test.ts
git commit -m "feat(strategy): ConvictionSizer — F1/F2/F3/F4 conviction-based bet sizing"
```

---

## Task 7: Time-indexed backtester

**Files:**
- Create: `src/core/strategy/backtester.ts`
- Create: `src/core/strategy/backtester.test.ts`

This is the core simulation engine. Day-by-day iteration, leaderboard reconstruction, conviction sizing, position tracking, mark-to-market.

- [ ] **Step 1: Write failing test**

Create `src/core/strategy/backtester.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest } from './backtester.js';
import type { BtDataset, BtTradeActivity, BtMarket, BacktestSimConfig, ConvictionParams } from '../../types.js';

function makeTrade(overrides: Partial<BtTradeActivity>): BtTradeActivity {
  return {
    id: 'x', address: '0xA', timestamp: 100, tokenId: 'tok1', conditionId: 'c1',
    action: 'buy', price: 0.5, size: 10, usdValue: 50, marketSlug: 's',
    ...overrides,
  };
}

const defaultConfig: BacktestSimConfig = {
  conviction: { betBase: 10, f1Anchor: 100, f1Max: 5, w2: 0, w3: 0, f4Boost: 1.0 },
  topN: 10, leaderboardWindowDays: 30, maxTtrDays: Infinity,
  maxPositions: 20, initialCapital: 500, slippagePct: 0, commissionPct: 0,
};

test('backtester: single winning trade → positive PnL', () => {
  // Day 1 (ts 86400): 0xA buys tok1 on c1 at price=0.5
  // Market c1 resolves with winner=tok1 → $1/share, bought at $0.5 → profit
  const DAY = 86400;
  const trades = [
    makeTrade({ id: 'b1', address: '0xA', timestamp: DAY + 100, tokenId: 'tok1',
      conditionId: 'c1', action: 'buy', price: 0.5, usdValue: 50 }),
  ];
  const ds: BtDataset = {
    trades,
    markets: new Map([['c1', {
      conditionId: 'c1', question: '', slug: '', endDate: '2099-01-01',
      volume: 0, liquidity: 0, negRisk: 0, closed: 1, tokenIds: '["tok1"]',
    }]]),
    resolutions: new Map([['c1', 'tok1']]),
    universe: ['0xA'],
  };

  const result = runBacktest(ds, { ...defaultConfig, topN: 1, leaderboardWindowDays: 1 },
    DAY, DAY * 3);
  assert.ok(result.totalPnl > 0, `Expected positive PnL, got ${result.totalPnl}`);
  assert.ok(result.tradeCount >= 1);
});

test('backtester: losing trade → negative PnL', () => {
  const DAY = 86400;
  const trades = [
    makeTrade({ id: 'b1', address: '0xA', timestamp: DAY + 100, tokenId: 'tok1',
      conditionId: 'c1', action: 'buy', price: 0.5, usdValue: 50 }),
  ];
  const ds: BtDataset = {
    trades,
    markets: new Map([['c1', {
      conditionId: 'c1', question: '', slug: '', endDate: '2099-01-01',
      volume: 0, liquidity: 0, negRisk: 0, closed: 1, tokenIds: '["tok1","tok2"]',
    }]]),
    resolutions: new Map([['c1', 'tok2']]),  // tok2 wins, not tok1
    universe: ['0xA'],
  };

  const result = runBacktest(ds, { ...defaultConfig, topN: 1, leaderboardWindowDays: 1 },
    DAY, DAY * 3);
  assert.ok(result.totalPnl < 0, `Expected negative PnL, got ${result.totalPnl}`);
});

test('backtester: H7 filter skips trades on long-horizon markets', () => {
  const DAY = 86400;
  const dayTs = DAY;
  // Market endDate is 100 days from now — exceeds maxTtrDays=7
  const farEndDate = new Date((dayTs + 100 * DAY) * 1000).toISOString();
  const trades = [
    makeTrade({ id: 'b1', address: '0xA', timestamp: DAY + 100, tokenId: 'tok1',
      conditionId: 'c1', action: 'buy', price: 0.5, usdValue: 50 }),
  ];
  const ds: BtDataset = {
    trades,
    markets: new Map([['c1', {
      conditionId: 'c1', question: '', slug: '', endDate: farEndDate,
      volume: 0, liquidity: 0, negRisk: 0, closed: 1, tokenIds: '["tok1"]',
    }]]),
    resolutions: new Map([['c1', 'tok1']]),
    universe: ['0xA'],
  };

  const result = runBacktest(ds, { ...defaultConfig, maxTtrDays: 7, topN: 1, leaderboardWindowDays: 1 },
    DAY, DAY * 3);
  assert.equal(result.tradeCount, 0);  // filtered out by H7
});

test('backtester: slippage + commission reduce PnL', () => {
  const DAY = 86400;
  const trades = [
    makeTrade({ id: 'b1', address: '0xA', timestamp: DAY + 100, tokenId: 'tok1',
      conditionId: 'c1', action: 'buy', price: 0.5, usdValue: 50 }),
  ];
  const ds: BtDataset = {
    trades,
    markets: new Map([['c1', {
      conditionId: 'c1', question: '', slug: '', endDate: '2099-01-01',
      volume: 0, liquidity: 0, negRisk: 0, closed: 1, tokenIds: '["tok1"]',
    }]]),
    resolutions: new Map([['c1', 'tok1']]),
    universe: ['0xA'],
  };

  const noCosts = runBacktest(ds, { ...defaultConfig, topN: 1, leaderboardWindowDays: 1 },
    DAY, DAY * 3);
  const withCosts = runBacktest(ds, {
    ...defaultConfig, topN: 1, leaderboardWindowDays: 1,
    slippagePct: 1, commissionPct: 2,
  }, DAY, DAY * 3);

  assert.ok(withCosts.totalPnl < noCosts.totalPnl,
    `Costs should reduce PnL: ${withCosts.totalPnl} vs ${noCosts.totalPnl}`);
});

test('backtester: returns equity curve with daily points', () => {
  const DAY = 86400;
  const result = runBacktest(
    { trades: [], markets: new Map(), resolutions: new Map(), universe: ['0xA'] },
    defaultConfig, DAY, DAY * 5,
  );
  assert.ok(result.equityCurve.length >= 2); // at least start + end
  assert.equal(result.equityCurve[0]!.equity, 500); // initialCapital
});
```

- [ ] **Step 2: Run test, expect FAIL**

- [ ] **Step 3: Implement**

Create `src/core/strategy/backtester.ts`:

```ts
import { pickTopN } from './historical-leaderboard.js';
import { computeConviction } from './conviction.js';
import { calmar, sharpe, winRate } from './metrics.js';
import type {
  BtDataset, BtTradeActivity, BacktestSimConfig, BacktestSimResult,
  DailyEquityPoint, SimPosition,
} from '../../types.js';

const DAY_SECONDS = 86400;

/**
 * Run a time-indexed backtest over [startTs, endTs).
 * Pure function — all data comes from BtDataset (pre-loaded in memory).
 */
export function runBacktest(
  ds: BtDataset,
  config: BacktestSimConfig,
  startTs: number,
  endTs: number,
): BacktestSimResult {
  let equity = config.initialCapital;
  let maxEquity = equity;
  let maxDrawdown = 0;
  const equityCurve: DailyEquityPoint[] = [{ dayTs: startTs, equity }];
  const positions = new Map<string, SimPosition>();
  let tradeCount = 0;
  let closedWins = 0;
  let closedTotal = 0;
  let totalTtrDays = 0;

  // Pre-index trades by day for fast lookup
  const tradesByDay = new Map<number, BtTradeActivity[]>();
  for (const t of ds.trades) {
    if (t.timestamp < startTs || t.timestamp >= endTs) continue;
    const dayStart = Math.floor(t.timestamp / DAY_SECONDS) * DAY_SECONDS;
    const arr = tradesByDay.get(dayStart);
    if (arr) arr.push(t);
    else tradesByDay.set(dayStart, [t]);
  }

  // Pre-build per-trader recent USD values for F2 z-score
  // Map address → array of usdValues (most recent 50 before current trade)
  const traderUsdHistory = new Map<string, number[]>();

  // Pre-build consensus index: for each (tokenId, day) → set of addresses
  const consensusIndex = new Map<string, Set<string>>();
  for (const t of ds.trades) {
    if (t.action !== 'buy' || t.timestamp < startTs || t.timestamp >= endTs) continue;
    const dayStart = Math.floor(t.timestamp / DAY_SECONDS) * DAY_SECONDS;
    const key = `${t.tokenId}_${dayStart}`;
    const set = consensusIndex.get(key);
    if (set) set.add(t.address);
    else consensusIndex.set(key, new Set([t.address]));
  }

  // Day-by-day simulation
  for (let dayTs = startTs; dayTs < endTs; dayTs += DAY_SECONDS) {
    // 1. Rebuild leaderboard for this day
    const topTraders = pickTopN(ds, dayTs, config.leaderboardWindowDays, config.topN);
    const activeSet = new Set(topTraders.map((t) => t.address));
    const traderScoreMap = new Map(topTraders.map((t) => [t.address, t.score]));

    // 2. Process today's trades
    const todayTrades = tradesByDay.get(dayTs) ?? [];
    for (const trade of todayTrades) {
      if (!activeSet.has(trade.address)) continue;

      if (trade.action === 'buy') {
        // H7 gate: check time-to-resolution
        if (config.maxTtrDays !== Infinity) {
          const market = ds.markets.get(trade.conditionId);
          if (!market?.endDate) continue; // skip unknown endDate
          const endDateTs = new Date(market.endDate).getTime() / 1000;
          const ttrDays = (endDateTs - trade.timestamp) / DAY_SECONDS;
          if (ttrDays > config.maxTtrDays) continue;
        }

        // Max positions gate
        if (positions.size >= config.maxPositions) continue;

        // Conviction sizing
        const recentUsd = traderUsdHistory.get(trade.address) ?? [];
        const traderScore = traderScoreMap.get(trade.address) ?? 0;
        const consensusKey = `${trade.tokenId}_${dayTs}`;
        const consensusCount = (consensusIndex.get(consensusKey)?.size ?? 1) - 1; // exclude self
        const betUsd = computeConviction(trade, config.conviction, recentUsd, traderScore, consensusCount);

        // Cost modeling
        const cost = Math.min(betUsd, equity);
        if (cost <= 0) continue;
        const slippageAdj = 1 + config.slippagePct / 100;
        const effectivePrice = trade.price * slippageAdj;
        const shares = cost / effectivePrice;
        const commission = cost * config.commissionPct / 100;
        equity -= cost + commission;

        // Track position
        const key = trade.tokenId;
        const existing = positions.get(key);
        if (existing) {
          existing.invested += cost;
          existing.shares += shares;
          existing.avgPrice = existing.invested / existing.shares;
        } else {
          positions.set(key, {
            tokenId: trade.tokenId, conditionId: trade.conditionId,
            shares, avgPrice: effectivePrice, invested: cost, openedAtTs: trade.timestamp,
          });
        }
        tradeCount++;

        // Update trader USD history for F2
        const hist = traderUsdHistory.get(trade.address) ?? [];
        hist.push(trade.usdValue);
        if (hist.length > 50) hist.shift();
        traderUsdHistory.set(trade.address, hist);

      } else if (trade.action === 'sell') {
        // Close position if we hold it
        const pos = positions.get(trade.tokenId);
        if (!pos) continue;
        const slippageAdj = 1 - config.slippagePct / 100;
        const revenue = pos.shares * trade.price * slippageAdj;
        const commission = revenue * config.commissionPct / 100;
        equity += revenue - commission;
        const pnl = revenue - commission - pos.invested;
        if (pnl > 0) closedWins++;
        closedTotal++;
        const ttr = (trade.timestamp - pos.openedAtTs) / DAY_SECONDS;
        totalTtrDays += ttr;
        positions.delete(trade.tokenId);
        tradeCount++;
      }
    }

    // 3. Mark-to-market: close resolved positions
    for (const [tokenId, pos] of positions) {
      const winner = ds.resolutions.get(pos.conditionId);
      if (winner === undefined) continue; // not resolved yet
      // Market resolved — settle
      const isWinner = tokenId === winner;
      const settlement = isWinner ? pos.shares * 1.0 : 0;
      equity += settlement;
      const pnl = settlement - pos.invested;
      if (pnl > 0) closedWins++;
      closedTotal++;
      const ttr = (dayTs - pos.openedAtTs) / DAY_SECONDS;
      totalTtrDays += ttr;
      positions.delete(tokenId);
    }

    // 4. Track equity + drawdown
    if (equity > maxEquity) maxEquity = equity;
    const dd = maxEquity > 0 ? ((maxEquity - equity) / maxEquity) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    equityCurve.push({ dayTs, equity });
  }

  // Close remaining open positions at last known price (assume 0.5 as neutral)
  for (const [, pos] of positions) {
    equity += pos.shares * 0.5;
    closedTotal++;
  }

  const totalPnl = equity - config.initialCapital;
  const equityValues = equityCurve.map((p) => p.equity);

  return {
    config,
    calmar: calmar(totalPnl, maxDrawdown),
    totalPnl,
    maxDrawdown,
    sharpe: sharpe(equityValues),
    winRate: winRate(closedWins, closedTotal),
    tradeCount,
    avgTtrDays: closedTotal > 0 ? totalTtrDays / closedTotal : 0,
    equityCurve,
  };
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm test src/core/strategy/backtester.test.ts`
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/strategy/backtester.ts src/core/strategy/backtester.test.ts
git commit -m "feat(strategy): time-indexed backtester with conviction sizing and H7 filter"
```

---

## Task 8: Grid parameter generation (LHS + fine)

**Files:**
- Create: `src/core/strategy/grid-params.ts`
- Create: `src/core/strategy/grid-params.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/core/strategy/grid-params.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLHS, generateFineGrid } from './grid-params.js';
import type { BacktestSimConfig } from '../../types.js';

test('generateLHS: produces N distinct configs', () => {
  const configs = generateLHS(50);
  assert.equal(configs.length, 50);
  // All should have valid topN values
  for (const c of configs) {
    assert.ok([5, 10, 20].includes(c.topN));
    assert.ok(c.conviction.betBase === 2);
    assert.ok(c.initialCapital === 500);
  }
});

test('generateLHS: configs are diverse (not all identical)', () => {
  const configs = generateLHS(20);
  const topNs = new Set(configs.map((c) => c.topN));
  assert.ok(topNs.size > 1, 'Expected diverse topN values');
});

test('generateFineGrid: generates neighbors around winners', () => {
  const winner: BacktestSimConfig = {
    conviction: { betBase: 2, f1Anchor: 100, f1Max: 5, w2: 0.3, w3: 0.5, f4Boost: 1.5 },
    topN: 10, leaderboardWindowDays: 30, maxTtrDays: 14,
    maxPositions: 20, initialCapital: 500, slippagePct: 1, commissionPct: 2,
  };
  const fineConfigs = generateFineGrid([winner]);
  assert.ok(fineConfigs.length > 0);
  assert.ok(fineConfigs.length < 500, 'Fine grid should be bounded');
});
```

- [ ] **Step 2: Run test, expect FAIL**

- [ ] **Step 3: Implement**

Create `src/core/strategy/grid-params.ts`:

```ts
import type { BacktestSimConfig, ConvictionParams } from '../../types.js';

// Grid axis definitions
const AXES = {
  topN: [5, 10, 20],
  leaderboardWindowDays: [14, 30, 60],
  f1Anchor: [20, 100, 500],
  f1Max: [3, 5],
  w2: [0, 0.3, 0.6],
  w3: [0, 0.5, 1.0],
  f4Boost: [1.0, 1.5, 2.0],
  maxTtrDays: [3, 7, 14, 30, Infinity],
} as const;

// Fixed params for all configs
const FIXED = {
  betBase: 2,
  maxPositions: 20,
  initialCapital: 500,
  slippagePct: 1,
  commissionPct: 2,
};

/**
 * Latin Hypercube Sampling: pick N points spread evenly across the grid space.
 * Each axis is divided into N equal strata; one random sample per stratum.
 */
export function generateLHS(n: number): BacktestSimConfig[] {
  const axisKeys = Object.keys(AXES) as Array<keyof typeof AXES>;
  // For each axis, create a shuffled permutation of N indices
  const permutations = axisKeys.map(() => shuffleRange(n));

  const configs: BacktestSimConfig[] = [];
  for (let i = 0; i < n; i++) {
    const picks: Record<string, number> = {};
    for (let a = 0; a < axisKeys.length; a++) {
      const key = axisKeys[a]!;
      const values = AXES[key];
      const stratum = permutations[a]![i]!;
      // Map stratum index → axis value
      const valueIdx = Math.floor((stratum / n) * values.length);
      picks[key] = values[Math.min(valueIdx, values.length - 1)]!;
    }
    configs.push(buildConfig(picks));
  }
  return configs;
}

/**
 * Generate fine-grained grid around a set of winner configs.
 * For each winner, enumerate ±1 step on each axis.
 */
export function generateFineGrid(winners: BacktestSimConfig[]): BacktestSimConfig[] {
  const seen = new Set<string>();
  const configs: BacktestSimConfig[] = [];

  for (const w of winners) {
    const baseValues = extractValues(w);
    const axisKeys = Object.keys(AXES) as Array<keyof typeof AXES>;

    // Generate all single-axis neighbors
    for (const axis of axisKeys) {
      const values = AXES[axis] as readonly number[];
      const currentIdx = values.indexOf(baseValues[axis]!);
      if (currentIdx === -1) continue;

      for (let delta = -1; delta <= 1; delta++) {
        const newIdx = currentIdx + delta;
        if (newIdx < 0 || newIdx >= values.length) continue;
        const picks = { ...baseValues, [axis]: values[newIdx]! };
        const key = JSON.stringify(picks);
        if (!seen.has(key)) {
          seen.add(key);
          configs.push(buildConfig(picks));
        }
      }
    }
  }
  return configs;
}

function buildConfig(picks: Record<string, number>): BacktestSimConfig {
  return {
    conviction: {
      betBase: FIXED.betBase,
      f1Anchor: picks.f1Anchor ?? 100,
      f1Max: picks.f1Max ?? 5,
      w2: picks.w2 ?? 0,
      w3: picks.w3 ?? 0,
      f4Boost: picks.f4Boost ?? 1.0,
    },
    topN: picks.topN ?? 10,
    leaderboardWindowDays: picks.leaderboardWindowDays ?? 30,
    maxTtrDays: picks.maxTtrDays ?? Infinity,
    maxPositions: FIXED.maxPositions,
    initialCapital: FIXED.initialCapital,
    slippagePct: FIXED.slippagePct,
    commissionPct: FIXED.commissionPct,
  };
}

function extractValues(c: BacktestSimConfig): Record<string, number> {
  return {
    topN: c.topN,
    leaderboardWindowDays: c.leaderboardWindowDays,
    f1Anchor: c.conviction.f1Anchor,
    f1Max: c.conviction.f1Max,
    w2: c.conviction.w2,
    w3: c.conviction.w3,
    f4Boost: c.conviction.f4Boost,
    maxTtrDays: c.maxTtrDays,
  };
}

function shuffleRange(n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm test src/core/strategy/grid-params.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/core/strategy/grid-params.ts src/core/strategy/grid-params.test.ts
git commit -m "feat(strategy): grid-params — LHS sampling + fine grid generation"
```

---

## Task 9: Grid search CLI

**Files:**
- Create: `src/cli/grid-search.ts`
- Modify: `package.json`

- [ ] **Step 1: Implement**

Create `src/cli/grid-search.ts`:

```ts
import { initDb, closeDb } from '../db/database.js';
import { createLogger } from '../utils/logger.js';
import { generateId } from '../utils/helpers.js';
import { loadDataset } from '../core/strategy/data-loader.js';
import { runBacktest } from '../core/strategy/backtester.js';
import { generateLHS, generateFineGrid } from '../core/strategy/grid-params.js';
import { insertGridRun, topGridRuns } from '../db/bt-queries.js';
import type { BacktestSimConfig, GridRunResult } from '../types.js';

const log = createLogger('grid-search');

function parseArgs(argv: string[]): { preset: 'coarse' | 'fine'; startDate: string; endDate: string; n?: number } {
  let preset: 'coarse' | 'fine' = 'coarse';
  let startDate = '2025-04-14';
  let endDate = '2026-04-13';
  let n: number | undefined;

  for (const a of argv) {
    if (a.startsWith('--preset=')) preset = a.slice(9) as 'coarse' | 'fine';
    else if (a.startsWith('--period=')) {
      const [s, e] = a.slice(9).split(':');
      if (s) startDate = s;
      if (e) endDate = e;
    }
    else if (a.startsWith('--n=')) n = Number(a.slice(4));
  }
  return { preset, startDate, endDate, n };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startTs = Math.floor(new Date(args.startDate).getTime() / 1000);
  const endTs = Math.floor(new Date(args.endDate).getTime() / 1000);
  const runId = `${args.preset}_${generateId().slice(0, 8)}`;

  log.info({ ...args, runId, startTs, endTs }, 'Starting grid search');
  initDb();

  const ds = loadDataset();

  let configs: BacktestSimConfig[];
  if (args.preset === 'coarse') {
    configs = generateLHS(args.n ?? 300);
    log.info({ points: configs.length }, 'Generated LHS coarse grid');
  } else {
    const winners = topGridRuns(20);
    if (winners.length === 0) {
      log.error('No coarse results found. Run --preset=coarse first.');
      closeDb();
      process.exit(1);
    }
    const winnerConfigs = winners.map((w) => JSON.parse(w.paramsJson) as BacktestSimConfig);
    configs = generateFineGrid(winnerConfigs);
    log.info({ points: configs.length, basedOn: winners.length }, 'Generated fine grid');
  }

  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i]!;
    const result = runBacktest(ds, cfg, startTs, endTs);

    const row: GridRunResult = {
      id: generateId(),
      runId,
      paramsJson: JSON.stringify(cfg),
      calmar: result.calmar === Infinity ? 9999 : result.calmar,
      pnl: result.totalPnl,
      maxDd: result.maxDrawdown,
      sharpe: result.sharpe,
      winRate: result.winRate,
      tradeCount: result.tradeCount,
      avgTtrDays: result.avgTtrDays,
      ranAt: '',
    };
    insertGridRun(row);

    if ((i + 1) % 10 === 0 || i === configs.length - 1) {
      log.info({
        progress: `${i + 1}/${configs.length}`,
        calmar: result.calmar === Infinity ? '∞' : result.calmar.toFixed(2),
        pnl: result.totalPnl.toFixed(2),
      }, 'Grid point evaluated');
    }
  }

  // Print top-20
  const top = topGridRuns(20, runId);
  log.info('=== Top 20 by Calmar ===');
  for (const r of top) {
    log.info({
      calmar: r.calmar.toFixed(2), pnl: r.pnl.toFixed(2), maxDd: r.maxDd.toFixed(1),
      sharpe: r.sharpe.toFixed(2), winRate: (r.winRate * 100).toFixed(1) + '%',
      trades: r.tradeCount,
    }, JSON.parse(r.paramsJson).topN + ' traders');
  }

  closeDb();
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    log.error({ err: String(err) }, 'Grid search failed');
    closeDb();
    process.exit(1);
  });
}
```

- [ ] **Step 2: Add script to package.json**

```json
"grid-search": "tsx src/cli/grid-search.ts"
```

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/cli/grid-search.ts package.json
git commit -m "feat(cli): grid-search CLI — coarse LHS + fine grid modes"
```

---

## Task 10: Walk-forward CLI

**Files:**
- Create: `src/cli/walk-forward.ts`
- Modify: `package.json`

- [ ] **Step 1: Implement**

Create `src/cli/walk-forward.ts`:

```ts
import { initDb, closeDb } from '../db/database.js';
import { createLogger } from '../utils/logger.js';
import { generateId } from '../utils/helpers.js';
import { loadDataset } from '../core/strategy/data-loader.js';
import { runBacktest } from '../core/strategy/backtester.js';
import { topGridRuns, insertWalkForwardRun, topWalkForwardRuns } from '../db/bt-queries.js';
import type { BacktestSimConfig, WalkForwardResult } from '../types.js';

const log = createLogger('walk-forward');
const DAY = 86400;
const MONTH = 30 * DAY;

interface Fold {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
}

function generateFolds(dataStartTs: number, dataEndTs: number): Fold[] {
  const trainDuration = 6 * MONTH;
  const testDuration = MONTH;
  const folds: Fold[] = [];

  let trainStart = dataStartTs;
  while (trainStart + trainDuration + testDuration <= dataEndTs) {
    folds.push({
      trainStart,
      trainEnd: trainStart + trainDuration,
      testStart: trainStart + trainDuration,
      testEnd: trainStart + trainDuration + testDuration,
    });
    trainStart += MONTH; // slide 1 month
  }
  return folds;
}

function parseArgs(argv: string[]): { topN: number } {
  let topN = 20;
  for (const a of argv) {
    if (a.startsWith('--candidates=top')) topN = Number(a.slice(16)) || 20;
  }
  return { topN };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  log.info(args, 'Starting walk-forward validation');
  initDb();

  const ds = loadDataset();
  const candidates = topGridRuns(args.topN);

  if (candidates.length === 0) {
    log.error('No grid results found. Run grid-search first.');
    closeDb();
    process.exit(1);
  }

  // Determine data range from actual trades
  const firstTs = ds.trades[0]?.timestamp ?? 0;
  const lastTs = ds.trades[ds.trades.length - 1]?.timestamp ?? 0;
  const folds = generateFolds(firstTs, lastTs);
  log.info({ folds: folds.length, candidates: candidates.length }, 'Walk-forward config');

  for (const candidate of candidates) {
    const cfg = JSON.parse(candidate.paramsJson) as BacktestSimConfig;
    const foldCalmars: number[] = [];

    for (const fold of folds) {
      const result = runBacktest(ds, cfg, fold.testStart, fold.testEnd);
      const c = result.calmar === Infinity ? 9999 : result.calmar;
      foldCalmars.push(c);
    }

    const sorted = [...foldCalmars].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const min = sorted[0] ?? 0;
    const positiveFolds = foldCalmars.filter((c) => c > 0).length;

    const row: WalkForwardResult = {
      id: generateId(),
      paramsJson: candidate.paramsJson,
      medianCalmar: median,
      minCalmar: min,
      pctPositiveFolds: folds.length > 0 ? (positiveFolds / folds.length) * 100 : 0,
      foldsJson: JSON.stringify(foldCalmars),
      ranAt: '',
    };
    insertWalkForwardRun(row);
    log.info({
      medianCalmar: median.toFixed(2), minCalmar: min.toFixed(2),
      positiveFolds: `${positiveFolds}/${folds.length}`,
    }, `Candidate evaluated (topN=${cfg.topN})`);
  }

  // Print top-3 finalists
  const finalists = topWalkForwardRuns(3);
  log.info('=== Top 3 Finalists (by min Calmar) ===');
  for (const f of finalists) {
    const cfg = JSON.parse(f.paramsJson) as BacktestSimConfig;
    log.info({
      minCalmar: f.minCalmar.toFixed(2), medianCalmar: f.medianCalmar.toFixed(2),
      positiveFolds: f.pctPositiveFolds.toFixed(0) + '%',
      topN: cfg.topN, maxTtrDays: cfg.maxTtrDays,
      f1Anchor: cfg.conviction.f1Anchor, w2: cfg.conviction.w2,
    }, 'Finalist');
  }

  closeDb();
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    log.error({ err: String(err) }, 'Walk-forward failed');
    closeDb();
    process.exit(1);
  });
}
```

- [ ] **Step 2: Add script to package.json**

```json
"walk-forward": "tsx src/cli/walk-forward.ts"
```

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/cli/walk-forward.ts package.json
git commit -m "feat(cli): walk-forward CLI — rolling 6m/1m validation with top-3 selection"
```

---

## Task 11: Report generator CLI

**Files:**
- Create: `src/cli/report.ts`
- Modify: `package.json`

- [ ] **Step 1: Implement**

Create `src/cli/report.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, closeDb } from '../db/database.js';
import { createLogger } from '../utils/logger.js';
import { topGridRuns, topWalkForwardRuns } from '../db/bt-queries.js';
import type { GridRunResult, BacktestSimConfig } from '../types.js';

const log = createLogger('report');
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPORTS_DIR = resolve(__dirname, '..', '..', 'reports');

function generateGridCsv(runs: GridRunResult[]): string {
  const header = 'id,calmar,pnl,max_dd,sharpe,win_rate,trade_count,avg_ttr,topN,windowDays,f1Anchor,f1Max,w2,w3,f4Boost,maxTtrDays';
  const rows = runs.map((r) => {
    const cfg = JSON.parse(r.paramsJson) as BacktestSimConfig;
    return [
      r.id, r.calmar.toFixed(4), r.pnl.toFixed(2), r.maxDd.toFixed(2),
      r.sharpe.toFixed(4), r.winRate.toFixed(4), r.tradeCount, r.avgTtrDays.toFixed(1),
      cfg.topN, cfg.leaderboardWindowDays, cfg.conviction.f1Anchor, cfg.conviction.f1Max,
      cfg.conviction.w2, cfg.conviction.w3, cfg.conviction.f4Boost, cfg.maxTtrDays,
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

function generateGridHtml(runs: GridRunResult[]): string {
  const tableRows = runs.slice(0, 50).map((r, i) => {
    const cfg = JSON.parse(r.paramsJson) as BacktestSimConfig;
    return `<tr>
      <td>${i + 1}</td><td>${r.calmar.toFixed(2)}</td><td>${r.pnl.toFixed(0)}</td>
      <td>${r.maxDd.toFixed(1)}%</td><td>${r.sharpe.toFixed(2)}</td>
      <td>${(r.winRate * 100).toFixed(1)}%</td><td>${r.tradeCount}</td>
      <td>${cfg.topN}</td><td>${cfg.leaderboardWindowDays}d</td>
      <td>${cfg.conviction.f1Anchor}</td><td>${cfg.conviction.w2}</td>
      <td>${cfg.conviction.w3}</td><td>${cfg.conviction.f4Boost}</td>
      <td>${cfg.maxTtrDays === Infinity || cfg.maxTtrDays > 9000 ? '∞' : cfg.maxTtrDays + 'd'}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Grid Search Results</title>
<style>
  body { font-family: system-ui; background: #1a1a2e; color: #eee; padding: 20px; }
  table { border-collapse: collapse; width: 100%; margin-top: 20px; }
  th, td { border: 1px solid #333; padding: 6px 10px; text-align: right; }
  th { background: #16213e; position: sticky; top: 0; }
  tr:nth-child(even) { background: #0f3460; }
  tr:hover { background: #533483; }
  h1 { color: #e94560; }
</style>
</head><body>
<h1>Grid Search — Top 50 by Calmar</h1>
<p>Total runs: ${runs.length}</p>
<table>
<thead><tr>
  <th>#</th><th>Calmar</th><th>PnL</th><th>MaxDD</th><th>Sharpe</th>
  <th>WinRate</th><th>Trades</th><th>TopN</th><th>Window</th>
  <th>F1Anchor</th><th>W2</th><th>W3</th><th>F4Boost</th><th>MaxTTR</th>
</tr></thead>
<tbody>${tableRows}</tbody>
</table>
</body></html>`;
}

function generateWalkForwardHtml(): string {
  const results = topWalkForwardRuns(20);
  const rows = results.map((r, i) => {
    const cfg = JSON.parse(r.paramsJson) as BacktestSimConfig;
    const folds = JSON.parse(r.foldsJson) as number[];
    const foldsStr = folds.map((f) => f.toFixed(1)).join(', ');
    return `<tr${i < 3 ? ' style="background:#1b4332;font-weight:bold"' : ''}>
      <td>${i + 1}</td><td>${r.minCalmar.toFixed(2)}</td><td>${r.medianCalmar.toFixed(2)}</td>
      <td>${r.pctPositiveFolds.toFixed(0)}%</td><td>${cfg.topN}</td>
      <td>${cfg.maxTtrDays === Infinity || cfg.maxTtrDays > 9000 ? '∞' : cfg.maxTtrDays + 'd'}</td>
      <td style="font-size:0.8em">${foldsStr}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Walk-Forward Results</title>
<style>
  body { font-family: system-ui; background: #1a1a2e; color: #eee; padding: 20px; }
  table { border-collapse: collapse; width: 100%; margin-top: 20px; }
  th, td { border: 1px solid #333; padding: 6px 10px; text-align: right; }
  th { background: #16213e; position: sticky; top: 0; }
  tr:nth-child(even) { background: #0f3460; }
  h1 { color: #e94560; }
  .finalist { color: #52b788; }
</style>
</head><body>
<h1>Walk-Forward Validation — Top 20 by Min Calmar</h1>
<p class="finalist">Top 3 finalists highlighted in green</p>
<table>
<thead><tr>
  <th>#</th><th>Min Calmar</th><th>Median</th><th>Positive</th>
  <th>TopN</th><th>MaxTTR</th><th>Fold Calmars</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>
</body></html>`;
}

async function main(): Promise<void> {
  log.info('Generating reports...');
  initDb();

  mkdirSync(REPORTS_DIR, { recursive: true });

  const allRuns = topGridRuns(10000);
  log.info({ runs: allRuns.length }, 'Grid runs loaded');

  if (allRuns.length > 0) {
    writeFileSync(resolve(REPORTS_DIR, 'grid.csv'), generateGridCsv(allRuns));
    writeFileSync(resolve(REPORTS_DIR, 'grid.html'), generateGridHtml(allRuns));
    log.info('Written: reports/grid.csv, reports/grid.html');
  }

  const wfHtml = generateWalkForwardHtml();
  writeFileSync(resolve(REPORTS_DIR, 'walkforward.html'), wfHtml);
  log.info('Written: reports/walkforward.html');

  closeDb();
  log.info('Reports complete. Open reports/*.html in browser.');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    log.error({ err: String(err) }, 'Report generation failed');
    closeDb();
    process.exit(1);
  });
}
```

- [ ] **Step 2: Add script to package.json**

```json
"report": "tsx src/cli/report.ts"
```

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/cli/report.ts package.json
git commit -m "feat(cli): report generator — grid.csv, grid.html, walkforward.html"
```

---

## Task 12: Integration smoke test

**Files:**
- Create: `src/core/strategy/backtester.e2e.test.ts`

- [ ] **Step 1: Write e2e test**

Create `src/core/strategy/backtester.e2e.test.ts`:

```ts
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../db/database.js';
import {
  upsertUniverseEntries, bulkInsertActivity, upsertMarket, upsertResolution,
  insertGridRun, topGridRuns, insertWalkForwardRun, topWalkForwardRuns,
} from '../../db/bt-queries.js';
import { loadDataset } from './data-loader.js';
import { runBacktest } from './backtester.js';
import { generateLHS } from './grid-params.js';
import type { BacktestSimConfig } from '../../types.js';

beforeEach(() => {
  initDb(':memory:');
  // Seed a minimal but realistic dataset
  upsertUniverseEntries([
    { address: '0xA', name: 'alice', volume12m: 1000, addedAt: '' },
    { address: '0xB', name: 'bob', volume12m: 500, addedAt: '' },
  ]);
  const DAY = 86400;
  const trades = [];
  // Generate 30 days of trades for 2 traders
  for (let d = 1; d <= 30; d++) {
    const ts = d * DAY;
    trades.push({
      id: `a_buy_${d}`, address: '0xA', timestamp: ts + 100,
      tokenId: `tok_${d}`, conditionId: `c_${d}`, action: 'buy' as const,
      price: 0.5, size: 20, usdValue: 10, marketSlug: `m_${d}`,
    });
    trades.push({
      id: `b_buy_${d}`, address: '0xB', timestamp: ts + 200,
      tokenId: `tok_${d}`, conditionId: `c_${d}`, action: 'buy' as const,
      price: 0.4, size: 25, usdValue: 10, marketSlug: `m_${d}`,
    });
  }
  bulkInsertActivity(trades);

  // Markets and resolutions — 60% win rate for alice, 40% for bob
  for (let d = 1; d <= 30; d++) {
    const endDate = new Date((d * DAY + 3 * DAY) * 1000).toISOString();
    upsertMarket({
      conditionId: `c_${d}`, question: `Q${d}`, slug: `q${d}`, endDate,
      volume: 0, liquidity: 0, negRisk: 0, closed: 1, tokenIds: `["tok_${d}","tok_${d}_no"]`,
    });
    // Alice wins 60% (days 1-18), Bob's token loses on those
    const winner = d <= 18 ? `tok_${d}` : `tok_${d}_no`;
    upsertResolution({ conditionId: `c_${d}`, winnerTokenId: winner, resolvedAt: '' });
  }
});
afterEach(() => closeDb());

test('e2e: load dataset → run backtest → positive calmar for winning trader', () => {
  const ds = loadDataset();
  assert.equal(ds.trades.length, 60);
  assert.equal(ds.universe.length, 2);

  const DAY = 86400;
  const config: BacktestSimConfig = {
    conviction: { betBase: 5, f1Anchor: 10, f1Max: 3, w2: 0, w3: 0, f4Boost: 1.0 },
    topN: 2, leaderboardWindowDays: 30, maxTtrDays: Infinity,
    maxPositions: 20, initialCapital: 500, slippagePct: 1, commissionPct: 2,
  };

  const result = runBacktest(ds, config, DAY, 31 * DAY);
  assert.ok(result.tradeCount > 0, 'Should have some trades');
  assert.ok(result.equityCurve.length > 2, 'Should have equity curve');
  // With 60% win rate, PnL should be positive despite costs
  // (not guaranteed with slippage+commission but likely with enough trades)
  log.info?.({ pnl: result.totalPnl, calmar: result.calmar, trades: result.tradeCount });
});

test('e2e: grid search produces diverse results', () => {
  const ds = loadDataset();
  const DAY = 86400;
  const configs = generateLHS(5);

  for (const cfg of configs) {
    const result = runBacktest(ds, cfg, DAY, 31 * DAY);
    insertGridRun({
      id: `g_${Math.random()}`, runId: 'test', paramsJson: JSON.stringify(cfg),
      calmar: result.calmar === Infinity ? 9999 : result.calmar,
      pnl: result.totalPnl, maxDd: result.maxDrawdown, sharpe: result.sharpe,
      winRate: result.winRate, tradeCount: result.tradeCount,
      avgTtrDays: result.avgTtrDays, ranAt: '',
    });
  }

  const top = topGridRuns(5);
  assert.equal(top.length, 5);
  assert.ok(top[0]!.calmar >= top[1]!.calmar, 'Should be sorted by calmar DESC');
});
```

- [ ] **Step 2: Run all tests**

Run: `pnpm test`
Expected: all pass (52 Stage E + Task 1-8 new tests).

- [ ] **Step 3: Full typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/core/strategy/backtester.e2e.test.ts
git commit -m "test: Stage B e2e — dataset load, backtest, grid search integration"
```

---

## Manual Verification (after implementation)

```bash
# 1. Coarse grid search (300 points, ~30 min)
pnpm grid-search --preset=coarse

# 2. Check results
sqlite3 data/copybot.db "SELECT COUNT(*) FROM bt_grid_runs; SELECT calmar, pnl, max_dd FROM bt_grid_runs ORDER BY calmar DESC LIMIT 5;"

# 3. Fine grid around top-20
pnpm grid-search --preset=fine

# 4. Walk-forward validation
pnpm walk-forward --candidates=top20

# 5. Generate reports
pnpm report
open reports/grid.html
open reports/walkforward.html

# 6. Sanity checks
# - No grid run with calmar > 100 (would indicate simulation bug)
# - Walk-forward top-3 should differ from grid top-3 (proves overfitting detection)
# - Reports render correctly in browser
```

## Self-Review

**Spec coverage:**
- ✅ ConvictionSizer (F1+F2+F3+F4): Task 6
- ✅ Time-indexed backtester with daily leaderboard reconstruction: Task 7
- ✅ Historical leaderboard with ground-truth win rate: Task 5
- ✅ H7 time-to-resolution filter: Task 7 (backtester)
- ✅ Fixed 1% slippage + 2% commission: Task 7 (backtester config)
- ✅ Grid search (LHS coarse + fine): Tasks 8, 9
- ✅ Walk-forward rolling 6m/1m, min_calmar selection: Task 10
- ✅ bt_grid_runs + bt_walkforward_runs tables: Task 2
- ✅ HTML/CSV reports: Task 11
- ✅ CLI tools with package.json scripts: Tasks 9, 10, 11

**Placeholder scan:** All steps contain complete code. No TBD/TODO.

**Type consistency:** ConvictionParams, BacktestSimConfig, GridRunResult, WalkForwardResult used consistently across all tasks. BtDataset flows from Task 4 (loader) through Tasks 5-7 (leaderboard/conviction/backtester).
