# Backtest Stage E — Historical Data Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an idempotent CLI (`pnpm collect-history`) that populates local SQLite with 12 months of trade history for the top-300 Polymarket traders by volume, plus market metadata and resolutions — forming the read-only substrate for later Stage B grid search and Stage C walk-forward validation.

**Architecture:** Four-phase collector. (1) Fetch universe from Data API leaderboard. (2) For each trader, seek-paginate `/activity` by timestamp; resumable on re-run. (3) Backfill Gamma market metadata for every distinct `condition_id`. (4) Backfill CLOB resolutions (`tokens[].winner`) for closed markets. All data lives in four new SQLite tables (`bt_*` prefix) alongside existing production tables, never mixed.

**Tech Stack:** TypeScript ESM (NodeNext), Node.js 18+, better-sqlite3 (synchronous), Polymarket Data API v1, Gamma API, `@polymarket/clob-client` v5, `tsx --test` + `node:assert/strict` for tests (no new runtime deps).

---

## File Structure

**New files:**
- `src/cli/collect-history.ts` — CLI entry point, orchestrates phases
- `src/cli/collect/universe.ts` — Phase 1: top-300 by volume → `bt_universe`
- `src/cli/collect/activity.ts` — Phase 2: per-trader seek-paginated activity fetch with resume
- `src/cli/collect/markets.ts` — Phase 3: distinct condition_ids → Gamma → `bt_markets`
- `src/cli/collect/resolutions.ts` — Phase 4: closed markets → CLOB → `bt_market_resolutions`
- `src/cli/collect/progress.ts` — shared progress bar / phase-timing helper
- `src/db/bt-queries.ts` — all queries for `bt_*` tables (kept separate from `queries.ts` to isolate backtest surface)
- Co-located `*.test.ts` next to each source file above

**Modified files:**
- `src/db/database.ts` — `initDb()` accepts optional path (backward-compatible, needed for test isolation)
- `src/db/migrations.ts` — adds 4 migration strings for `bt_*` tables
- `src/types.ts` — extends `GammaMarket` with `endDate`; adds `BtUniverseEntry`, `BtTradeActivity`, `BtMarket`, `BtMarketResolution`, `CollectHistoryOptions`
- `src/api/gamma-api.ts` — mapper now reads `endDate`
- `src/api/clob-client.ts` — adds `getMarketResolution(conditionId)` helper returning `{closed, winnerTokenId | null}`
- `package.json` — adds `"test": "tsx --test 'src/**/*.test.ts'"` and `"collect-history": "tsx src/cli/collect-history.ts"`

Each task below owns exactly one file or one logical change. Commit after every task.

---

## Task 1: Test infrastructure (`tsx --test` + smoke test)

**Files:**
- Modify: `package.json`
- Create: `src/utils/helpers.test.ts`

- [ ] **Step 1: Add `test` script to package.json**

Modify `package.json`, add under `"scripts"`:

```json
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc && cp -r src/dashboard/public dist/dashboard/public",
    "start": "node dist/index.js",
    "test": "tsx --test 'src/**/*.test.ts'"
  },
```

- [ ] **Step 2: Write the first failing test**

Create `src/utils/helpers.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUsd, formatPercent, nowTimestamp, shortenAddress } from './helpers.js';

test('formatUsd: basic positive number', () => {
  assert.equal(formatUsd(1234.567), '$1,234.57');
});

test('formatPercent: positive has plus sign', () => {
  assert.equal(formatPercent(0.123), '+12.3%');
});

test('formatPercent: negative has minus sign', () => {
  assert.equal(formatPercent(-0.05), '-5.0%');
});

test('nowTimestamp: unix seconds, within 2s of Date.now', () => {
  const jsNow = Math.floor(Date.now() / 1000);
  const ts = nowTimestamp();
  assert.ok(Math.abs(ts - jsNow) <= 2, `ts ${ts} not near jsNow ${jsNow}`);
});

test('shortenAddress: long address collapsed', () => {
  assert.equal(shortenAddress('0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b'), '0x1a2b...9a0b');
});

test('shortenAddress: short returns as-is', () => {
  assert.equal(shortenAddress('0x123'), '0x123');
});
```

- [ ] **Step 3: Run test, expect PASS (no impl needed — `helpers.ts` already exists)**

Run: `pnpm test`

Expected output snippet:
```
# pass 5
# fail 0
```

Purpose: proves the test runner itself works before we build anything on top of it.

- [ ] **Step 4: Commit**

```bash
git add package.json src/utils/helpers.test.ts
git commit -m "test: add node:test runner via tsx --test"
```

---

## Task 2: Make `initDb()` path-injectable for test isolation

**Files:**
- Modify: `src/db/database.ts`
- Create: `src/db/database.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/db/database.test.ts`:

```ts
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, getDb, closeDb } from './database.js';

afterEach(() => closeDb());

test('initDb with :memory: path creates isolated db', () => {
  initDb(':memory:');
  const db = getDb();
  // memory db should have the settings table after migrations run
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'")
    .get();
  assert.ok(row, 'settings table not created');
});

test('initDb() without arg still opens default path', () => {
  // This just proves the default-path branch compiles + runs; we immediately close.
  initDb();
  const db = getDb();
  assert.ok(db, 'getDb returned nothing');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --test-only=false src/db/database.test.ts`

Expected FAIL: `initDb` currently takes no arguments; TypeScript compile error or runtime ignore.

- [ ] **Step 3: Modify `initDb` to accept optional path**

Edit `src/db/database.ts` — replace `export function initDb(): void {` and the body to:

```ts
export function initDb(path?: string): void {
  if (db) {
    log.warn('Database already initialized');
    return;
  }

  const dbPath = path ?? DB_PATH;

  // Only create the data directory for file-backed paths.
  if (dbPath !== ':memory:') {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  log.info({ path: dbPath }, 'Opening database');
  db = new Database(dbPath);

  runMigrations(db);

  log.info('Database initialized successfully');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/db/database.ts src/db/database.test.ts
git commit -m "refactor(db): make initDb path-injectable for test isolation"
```

---

## Task 3: Types — extend `GammaMarket` and add `Bt*` types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Extend `GammaMarket` with `endDate`**

In `src/types.ts`, replace the `GammaMarket` interface (around lines 60-77) with:

```ts
export interface GammaMarket {
  id: string;
  question: string;
  slug: string;
  conditionId: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
  }>;
  orderPriceMinTickSize: number;
  negRisk: boolean;
  negRiskMarketId?: string;
  active: boolean;
  closed: boolean;
  volume: number;
  liquidity: number;
  /** ISO-8601 string, e.g. "2026-05-01T00:00:00Z". May be null/absent for open-ended markets. */
  endDate?: string;
}
```

- [ ] **Step 2: Append backtest-collection types at end of `src/types.ts`**

At the end of `src/types.ts`, append:

```ts
// === Backtest / Collector Types ===

export interface BtUniverseEntry {
  address: string;
  name: string;
  volume12m: number;
  addedAt: string;
}

export interface BtTradeActivity {
  id: string;
  address: string;
  timestamp: number;
  tokenId: string;
  conditionId: string;
  action: 'buy' | 'sell';
  price: number;
  size: number;
  usdValue: number;
  marketSlug: string;
}

export interface BtMarket {
  conditionId: string;
  question: string;
  slug: string;
  endDate: string | null;
  volume: number;
  liquidity: number;
  negRisk: number;
  closed: number;
  tokenIds: string;  // JSON array of token_ids
}

export interface BtMarketResolution {
  conditionId: string;
  winnerTokenId: string | null;
  resolvedAt: string;
}

export interface CollectHistoryOptions {
  universeSize: number;        // default 300
  historyDays: number;         // default 365
  ratePauseMs: number;         // default 250
  phases: Array<'universe' | 'activity' | 'markets' | 'resolutions'>;
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): extend GammaMarket with endDate, add Bt* types"
```

---

## Task 4: Migrations — new `bt_*` tables

**Files:**
- Modify: `src/db/migrations.ts`
- Create: `src/db/migrations.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/db/migrations.test.ts`:

```ts
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, getDb, closeDb } from './database.js';

afterEach(() => closeDb());

function tables(): string[] {
  return (
    getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function indexes(table: string): string[] {
  return (
    getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ?")
      .all(table) as Array<{ name: string }>
  ).map((r) => r.name);
}

test('migration creates bt_universe', () => {
  initDb(':memory:');
  assert.ok(tables().includes('bt_universe'));
});

test('migration creates bt_trader_activity with required indexes', () => {
  initDb(':memory:');
  assert.ok(tables().includes('bt_trader_activity'));
  const idx = indexes('bt_trader_activity');
  assert.ok(idx.some((n) => n.includes('addr_ts')), 'expected addr_ts index');
  assert.ok(idx.some((n) => n.includes('token_ts')), 'expected token_ts index');
  assert.ok(idx.some((n) => n.includes('cond_ts')), 'expected cond_ts index');
});

test('migration creates bt_markets', () => {
  initDb(':memory:');
  assert.ok(tables().includes('bt_markets'));
});

test('migration creates bt_market_resolutions', () => {
  initDb(':memory:');
  assert.ok(tables().includes('bt_market_resolutions'));
});

test('running initDb twice is idempotent (no exception)', () => {
  initDb(':memory:');
  closeDb();
  initDb(':memory:');
  assert.ok(tables().includes('bt_universe'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/db/migrations.test.ts`

Expected FAIL: `bt_*` tables not present.

- [ ] **Step 3: Add migrations**

In `src/db/migrations.ts`, append four new entries to the `MIGRATIONS` array (before the closing `]`):

```ts
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

  // bt_market_resolutions — Stage E: CLOB tokens[].winner for closed markets
  `CREATE TABLE IF NOT EXISTS bt_market_resolutions (
    condition_id TEXT PRIMARY KEY,
    winner_token_id TEXT,
    resolved_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/db/migrations.test.ts`

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.ts src/db/migrations.test.ts
git commit -m "feat(db): add bt_universe, bt_trader_activity, bt_markets, bt_market_resolutions tables"
```

---

## Task 5: Queries for `bt_universe` and `bt_trader_activity`

**Files:**
- Create: `src/db/bt-queries.ts`
- Create: `src/db/bt-queries.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/db/bt-queries.test.ts`:

```ts
import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from './database.js';
import {
  upsertUniverseEntries,
  listUniverse,
  bulkInsertActivity,
  maxActivityTimestamp,
  countActivityForAddress,
} from './bt-queries.js';
import type { BtUniverseEntry, BtTradeActivity } from '../types.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => closeDb());

test('upsertUniverseEntries + listUniverse: roundtrip 2 entries', () => {
  const entries: BtUniverseEntry[] = [
    { address: '0xA', name: 'alice', volume12m: 10000, addedAt: '' },
    { address: '0xB', name: 'bob', volume12m: 5000, addedAt: '' },
  ];
  upsertUniverseEntries(entries);
  const loaded = listUniverse();
  assert.equal(loaded.length, 2);
  assert.ok(loaded.find((e) => e.address === '0xA' && e.volume12m === 10000));
});

test('upsertUniverseEntries: upsert updates volume on conflict', () => {
  upsertUniverseEntries([{ address: '0xA', name: 'alice', volume12m: 100, addedAt: '' }]);
  upsertUniverseEntries([{ address: '0xA', name: 'alice-new', volume12m: 200, addedAt: '' }]);
  const loaded = listUniverse();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.volume12m, 200);
  assert.equal(loaded[0]!.name, 'alice-new');
});

test('bulkInsertActivity + countActivityForAddress + maxActivityTimestamp', () => {
  const rows: BtTradeActivity[] = [
    {
      id: 't1', address: '0xA', timestamp: 1000, tokenId: 'tok1', conditionId: 'c1',
      action: 'buy', price: 0.5, size: 10, usdValue: 5, marketSlug: 's',
    },
    {
      id: 't2', address: '0xA', timestamp: 2000, tokenId: 'tok2', conditionId: 'c2',
      action: 'sell', price: 0.6, size: 8, usdValue: 4.8, marketSlug: 's',
    },
    {
      id: 't3', address: '0xB', timestamp: 1500, tokenId: 'tok1', conditionId: 'c1',
      action: 'buy', price: 0.55, size: 20, usdValue: 11, marketSlug: 's',
    },
  ];
  bulkInsertActivity(rows);
  assert.equal(countActivityForAddress('0xA'), 2);
  assert.equal(countActivityForAddress('0xB'), 1);
  assert.equal(maxActivityTimestamp('0xA'), 2000);
  assert.equal(maxActivityTimestamp('0xB'), 1500);
  assert.equal(maxActivityTimestamp('0xC'), null);
});

test('bulkInsertActivity: duplicate id ignored (INSERT OR IGNORE)', () => {
  const row: BtTradeActivity = {
    id: 't1', address: '0xA', timestamp: 1000, tokenId: 'tok1', conditionId: 'c1',
    action: 'buy', price: 0.5, size: 10, usdValue: 5, marketSlug: 's',
  };
  bulkInsertActivity([row]);
  bulkInsertActivity([row]);  // should not throw
  assert.equal(countActivityForAddress('0xA'), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/db/bt-queries.test.ts`

Expected FAIL: `bt-queries.ts` module not found.

- [ ] **Step 3: Implement `bt-queries.ts` (universe + activity portions)**

Create `src/db/bt-queries.ts`:

```ts
import { getDb } from './database.js';
import type {
  BtUniverseEntry,
  BtTradeActivity,
  BtMarket,
  BtMarketResolution,
} from '../types.js';

// ============================================================
// bt_universe
// ============================================================

export function upsertUniverseEntries(entries: BtUniverseEntry[]): void {
  if (entries.length === 0) return;
  const stmt = getDb().prepare(
    `INSERT INTO bt_universe (address, name, volume_12m)
     VALUES (@address, @name, @volume12m)
     ON CONFLICT(address) DO UPDATE SET
       name = excluded.name,
       volume_12m = excluded.volume_12m`,
  );
  const tx = getDb().transaction((rows: BtUniverseEntry[]) => {
    for (const r of rows) {
      stmt.run({ address: r.address, name: r.name, volume12m: r.volume12m });
    }
  });
  tx(entries);
}

export function listUniverse(): BtUniverseEntry[] {
  const rows = getDb()
    .prepare('SELECT address, name, volume_12m, added_at FROM bt_universe ORDER BY volume_12m DESC')
    .all() as Array<{ address: string; name: string; volume_12m: number; added_at: string }>;
  return rows.map((r) => ({
    address: r.address,
    name: r.name,
    volume12m: r.volume_12m,
    addedAt: r.added_at,
  }));
}

// ============================================================
// bt_trader_activity
// ============================================================

export function bulkInsertActivity(rows: BtTradeActivity[]): void {
  if (rows.length === 0) return;
  const stmt = getDb().prepare(
    `INSERT OR IGNORE INTO bt_trader_activity
     (id, address, timestamp, token_id, condition_id, action, price, size, usd_value, market_slug)
     VALUES (@id, @address, @timestamp, @tokenId, @conditionId, @action, @price, @size, @usdValue, @marketSlug)`,
  );
  const tx = getDb().transaction((items: BtTradeActivity[]) => {
    for (const r of items) stmt.run(r);
  });
  tx(rows);
}

export function maxActivityTimestamp(address: string): number | null {
  const row = getDb()
    .prepare('SELECT MAX(timestamp) AS m FROM bt_trader_activity WHERE address = ?')
    .get(address) as { m: number | null };
  return row.m;
}

export function countActivityForAddress(address: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM bt_trader_activity WHERE address = ?')
    .get(address) as { c: number };
  return row.c;
}

export function distinctConditionIds(): string[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT condition_id FROM bt_trader_activity')
    .all() as Array<{ condition_id: string }>;
  return rows.map((r) => r.condition_id);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/db/bt-queries.test.ts`

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/db/bt-queries.ts src/db/bt-queries.test.ts
git commit -m "feat(db): bt-queries for universe and trader_activity"
```

---

## Task 6: Queries for `bt_markets` and `bt_market_resolutions`

**Files:**
- Modify: `src/db/bt-queries.ts`
- Modify: `src/db/bt-queries.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `src/db/bt-queries.test.ts`:

```ts
import {
  upsertMarket,
  getMarket,
  conditionIdsMissingFromMarkets,
  closedConditionIdsMissingResolution,
  upsertResolution,
  getResolution,
} from './bt-queries.js';
import type { BtMarket, BtMarketResolution } from '../types.js';

test('upsertMarket + getMarket + conditionIdsMissingFromMarkets', () => {
  const m: BtMarket = {
    conditionId: 'c1', question: 'Will X?', slug: 'will-x',
    endDate: '2026-05-01', volume: 1000, liquidity: 500,
    negRisk: 0, closed: 1, tokenIds: '["tokA","tokB"]',
  };
  upsertMarket(m);
  const loaded = getMarket('c1');
  assert.ok(loaded);
  assert.equal(loaded!.question, 'Will X?');
  assert.equal(loaded!.closed, 1);

  // c2 is referenced in activity but not in bt_markets
  bulkInsertActivity([{
    id: 'tX', address: '0xA', timestamp: 100, tokenId: 'tokC', conditionId: 'c2',
    action: 'buy', price: 0.5, size: 1, usdValue: 0.5, marketSlug: '',
  }]);
  const missing = conditionIdsMissingFromMarkets();
  assert.ok(missing.includes('c2'));
  assert.ok(!missing.includes('c1'), 'c1 already in bt_markets');
});

test('closedConditionIdsMissingResolution: closed=1 AND no resolution row', () => {
  upsertMarket({
    conditionId: 'cClosed', question: '', slug: '',
    endDate: null, volume: 0, liquidity: 0,
    negRisk: 0, closed: 1, tokenIds: '[]',
  });
  upsertMarket({
    conditionId: 'cOpen', question: '', slug: '',
    endDate: null, volume: 0, liquidity: 0,
    negRisk: 0, closed: 0, tokenIds: '[]',
  });
  const missing = closedConditionIdsMissingResolution();
  assert.ok(missing.includes('cClosed'));
  assert.ok(!missing.includes('cOpen'));

  upsertResolution({ conditionId: 'cClosed', winnerTokenId: 'tokA', resolvedAt: '' });
  const afterUpsert = closedConditionIdsMissingResolution();
  assert.ok(!afterUpsert.includes('cClosed'));

  const res = getResolution('cClosed');
  assert.ok(res);
  assert.equal(res!.winnerTokenId, 'tokA');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/db/bt-queries.test.ts`

Expected FAIL: `upsertMarket` and friends not exported.

- [ ] **Step 3: Append implementation to `src/db/bt-queries.ts`**

Append to `src/db/bt-queries.ts`:

```ts
// ============================================================
// bt_markets
// ============================================================

export function upsertMarket(m: BtMarket): void {
  getDb()
    .prepare(
      `INSERT INTO bt_markets
         (condition_id, question, slug, end_date, volume, liquidity, neg_risk, closed, token_ids)
       VALUES (@conditionId, @question, @slug, @endDate, @volume, @liquidity, @negRisk, @closed, @tokenIds)
       ON CONFLICT(condition_id) DO UPDATE SET
         question = excluded.question,
         slug = excluded.slug,
         end_date = excluded.end_date,
         volume = excluded.volume,
         liquidity = excluded.liquidity,
         neg_risk = excluded.neg_risk,
         closed = excluded.closed,
         token_ids = excluded.token_ids,
         fetched_at = CURRENT_TIMESTAMP`,
    )
    .run(m);
}

export function getMarket(conditionId: string): BtMarket | null {
  const row = getDb()
    .prepare(
      `SELECT condition_id, question, slug, end_date, volume, liquidity, neg_risk, closed, token_ids
       FROM bt_markets WHERE condition_id = ?`,
    )
    .get(conditionId) as
    | {
        condition_id: string;
        question: string;
        slug: string;
        end_date: string | null;
        volume: number;
        liquidity: number;
        neg_risk: number;
        closed: number;
        token_ids: string;
      }
    | undefined;
  if (!row) return null;
  return {
    conditionId: row.condition_id,
    question: row.question,
    slug: row.slug,
    endDate: row.end_date,
    volume: row.volume,
    liquidity: row.liquidity,
    negRisk: row.neg_risk,
    closed: row.closed,
    tokenIds: row.token_ids,
  };
}

export function conditionIdsMissingFromMarkets(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT a.condition_id
       FROM bt_trader_activity a
       LEFT JOIN bt_markets m ON m.condition_id = a.condition_id
       WHERE m.condition_id IS NULL`,
    )
    .all() as Array<{ condition_id: string }>;
  return rows.map((r) => r.condition_id);
}

// ============================================================
// bt_market_resolutions
// ============================================================

export function upsertResolution(r: BtMarketResolution): void {
  getDb()
    .prepare(
      `INSERT INTO bt_market_resolutions (condition_id, winner_token_id)
       VALUES (@conditionId, @winnerTokenId)
       ON CONFLICT(condition_id) DO UPDATE SET
         winner_token_id = excluded.winner_token_id,
         resolved_at = CURRENT_TIMESTAMP`,
    )
    .run({ conditionId: r.conditionId, winnerTokenId: r.winnerTokenId });
}

export function getResolution(conditionId: string): BtMarketResolution | null {
  const row = getDb()
    .prepare(
      `SELECT condition_id, winner_token_id, resolved_at
       FROM bt_market_resolutions WHERE condition_id = ?`,
    )
    .get(conditionId) as
    | { condition_id: string; winner_token_id: string | null; resolved_at: string }
    | undefined;
  if (!row) return null;
  return {
    conditionId: row.condition_id,
    winnerTokenId: row.winner_token_id,
    resolvedAt: row.resolved_at,
  };
}

export function closedConditionIdsMissingResolution(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT m.condition_id
       FROM bt_markets m
       LEFT JOIN bt_market_resolutions r ON r.condition_id = m.condition_id
       WHERE m.closed = 1 AND r.condition_id IS NULL`,
    )
    .all() as Array<{ condition_id: string }>;
  return rows.map((r) => r.condition_id);
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `pnpm test src/db/bt-queries.test.ts`

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/db/bt-queries.ts src/db/bt-queries.test.ts
git commit -m "feat(db): bt-queries for markets and resolutions"
```

---

## Task 7: `GammaApi` — expose `endDate` through mapper

**Files:**
- Modify: `src/api/gamma-api.ts`

- [ ] **Step 1: Write the test**

Create `src/api/gamma-api.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GammaApi } from './gamma-api.js';

test('GammaApi.mapRaw: endDate field extracted from raw response', async () => {
  // Minimal stub via global.fetch mock
  const raw = [{
    id: '1',
    question: 'Will X?',
    slug: 'will-x',
    conditionId: '0xCOND',
    tokens: [],
    orderPriceMinTickSize: 0.01,
    negRisk: false,
    active: true,
    closed: false,
    volume: 1000,
    liquidity: 500,
    endDate: '2026-05-01T00:00:00Z',
  }];

  const originalFetch = global.fetch;
  // @ts-ignore — minimal mock just for this test
  global.fetch = async () => ({
    ok: true, status: 200, statusText: 'OK',
    headers: new Map(), json: async () => raw, text: async () => JSON.stringify(raw),
  });

  try {
    const api = new GammaApi('http://stub.test');
    const market = await api.getMarketByConditionId('0xCOND');
    assert.ok(market);
    assert.equal(market!.endDate, '2026-05-01T00:00:00Z');
  } finally {
    global.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/api/gamma-api.test.ts`

Expected FAIL: `endDate` is undefined — current code spreads raw JSON directly into the typed return, relying on TS duck typing; any field not in the interface is unreachable via typed access. We need the type extension from Task 3 to propagate *and* we need to confirm nothing strips the field. The `data[0] as GammaMarket` cast in `gamma-api.ts:25` preserves the runtime shape, so the test may actually PASS on the runtime level. Run it and check.

If it passes: great, the Task 3 type extension is sufficient and no code change needed here. If it fails (because TS transpilation or mapper drops fields), proceed to Step 3.

- [ ] **Step 3: If needed — explicit mapping (likely unnecessary, but safe)**

If the test failed, add a normalization pass in `gamma-api.ts:getMarketByConditionId` (and `getMarket`), replacing `const market = data[0] ?? null;` with:

```ts
const raw = data[0];
const market: GammaMarket | null = raw
  ? { ...raw, endDate: (raw as unknown as { endDate?: string }).endDate }
  : null;
```

This guarantees the field is preserved regardless of upstream type gymnastics.

- [ ] **Step 4: Re-run, expect PASS**

Run: `pnpm test src/api/gamma-api.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/api/gamma-api.ts src/api/gamma-api.test.ts
git commit -m "feat(gamma-api): surface endDate field"
```

---

## Task 8: `ClobClient` — add `getMarketResolution()` helper

**Files:**
- Modify: `src/api/clob-client.ts`
- Create: `src/api/clob-client.test.ts`

**Context:** CLOB's `/markets/{conditionId}` endpoint returns JSON with `tokens` array, each containing `{token_id, outcome, price, winner: boolean}`. We need a thin helper returning `{closed, winnerTokenId | null}` suitable for `bt_market_resolutions`.

- [ ] **Step 1: Write failing test**

Create `src/api/clob-client.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClobClientWrapper } from './clob-client.js';

test('getMarketResolution: closed with winner token', async () => {
  const raw = {
    condition_id: '0xCOND',
    closed: true,
    tokens: [
      { token_id: 'tokA', outcome: 'Yes', price: 1.0, winner: true },
      { token_id: 'tokB', outcome: 'No', price: 0.0, winner: false },
    ],
  };
  const orig = global.fetch;
  // @ts-ignore
  global.fetch = async () => ({
    ok: true, status: 200, statusText: 'OK',
    headers: new Map(), json: async () => raw, text: async () => JSON.stringify(raw),
  });

  try {
    const c = new ClobClientWrapper('http://stub.test');
    const res = await c.getMarketResolution('0xCOND');
    assert.equal(res.closed, true);
    assert.equal(res.winnerTokenId, 'tokA');
  } finally {
    global.fetch = orig;
  }
});

test('getMarketResolution: closed with no winner declared', async () => {
  const raw = {
    condition_id: '0xCOND',
    closed: true,
    tokens: [
      { token_id: 'tokA', outcome: 'Yes', price: 0.5, winner: false },
      { token_id: 'tokB', outcome: 'No', price: 0.5, winner: false },
    ],
  };
  const orig = global.fetch;
  // @ts-ignore
  global.fetch = async () => ({
    ok: true, status: 200, statusText: 'OK',
    headers: new Map(), json: async () => raw, text: async () => JSON.stringify(raw),
  });

  try {
    const c = new ClobClientWrapper('http://stub.test');
    const res = await c.getMarketResolution('0xCOND');
    assert.equal(res.closed, true);
    assert.equal(res.winnerTokenId, null);
  } finally {
    global.fetch = orig;
  }
});

test('getMarketResolution: still open returns closed=false', async () => {
  const raw = {
    condition_id: '0xCOND',
    closed: false,
    tokens: [
      { token_id: 'tokA', outcome: 'Yes', price: 0.6, winner: false },
      { token_id: 'tokB', outcome: 'No', price: 0.4, winner: false },
    ],
  };
  const orig = global.fetch;
  // @ts-ignore
  global.fetch = async () => ({
    ok: true, status: 200, statusText: 'OK',
    headers: new Map(), json: async () => raw, text: async () => JSON.stringify(raw),
  });

  try {
    const c = new ClobClientWrapper('http://stub.test');
    const res = await c.getMarketResolution('0xCOND');
    assert.equal(res.closed, false);
    assert.equal(res.winnerTokenId, null);
  } finally {
    global.fetch = orig;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/api/clob-client.test.ts`

Expected FAIL: `getMarketResolution` does not exist.

- [ ] **Step 3: Implement helper**

In `src/api/clob-client.ts`, find the `ClobClientWrapper` class and add a new method (place it near the existing `getMarketByConditionId` method):

```ts
/**
 * Return resolution status for a market.
 * Closed markets usually have exactly one token with winner=true.
 * Returns winnerTokenId=null if closed without a declared winner (rare: invalid/refunded markets).
 */
async getMarketResolution(
  conditionId: string,
): Promise<{ closed: boolean; winnerTokenId: string | null }> {
  const url = `${this.baseUrl}/markets/${encodeURIComponent(conditionId)}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) {
    throw new Error(`CLOB markets request failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    closed?: boolean;
    tokens?: Array<{ token_id: string; winner?: boolean }>;
  };
  const closed = Boolean(data.closed);
  const winner = (data.tokens ?? []).find((t) => t.winner === true);
  return {
    closed,
    winnerTokenId: winner?.token_id ?? null,
  };
}
```

If `fetchWithRetry` is not already imported at top of `clob-client.ts`, add:
```ts
import { fetchWithRetry } from '../utils/retry.js';
```

If `ClobClientWrapper` constructor does not already accept a `baseUrl` with fallback, make sure it does (follow the pattern from `gamma-api.ts:11-14`). Adjust if needed; the test passes `'http://stub.test'` so the constructor must accept that.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/api/clob-client.test.ts`

Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/clob-client.ts src/api/clob-client.test.ts
git commit -m "feat(clob): add getMarketResolution helper for bt stage"
```

---

## Task 9: Progress helper

**Files:**
- Create: `src/cli/collect/progress.ts`
- Create: `src/cli/collect/progress.test.ts`

**Purpose:** A tiny headless progress logger used by all 4 collector phases. Not a fancy bar — just periodic structured log lines so the user can see progress via `pino-pretty`.

- [ ] **Step 1: Write failing test**

Create `src/cli/collect/progress.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Progress } from './progress.js';

test('Progress: tick increments completed count', () => {
  const p = new Progress('phase1', 10);
  p.tick();
  p.tick();
  assert.equal(p.snapshot().completed, 2);
  assert.equal(p.snapshot().total, 10);
});

test('Progress: tick(n) increments by n', () => {
  const p = new Progress('phase1', 100);
  p.tick(25);
  assert.equal(p.snapshot().completed, 25);
});

test('Progress: percent is 0..100', () => {
  const p = new Progress('phase1', 4);
  p.tick(); p.tick();
  assert.equal(p.snapshot().percent, 50);
});

test('Progress: percent is 0 when total=0 (guards divide-by-zero)', () => {
  const p = new Progress('phase1', 0);
  assert.equal(p.snapshot().percent, 0);
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/cli/collect/progress.test.ts`

Expected FAIL: module not found.

- [ ] **Step 3: Implement**

Create `src/cli/collect/progress.ts`:

```ts
import { createLogger } from '../../utils/logger.js';

const log = createLogger('collect-progress');

export interface ProgressSnapshot {
  phase: string;
  completed: number;
  total: number;
  percent: number;
  elapsedMs: number;
}

export class Progress {
  private completed = 0;
  private readonly startedAt = Date.now();
  private lastLoggedPercent = -1;

  constructor(
    private readonly phase: string,
    private readonly total: number,
  ) {}

  tick(n = 1): void {
    this.completed += n;
    const snap = this.snapshot();
    // Log every 5% change (avoid log spam for 10k-item loops).
    if (snap.percent - this.lastLoggedPercent >= 5 || snap.completed === this.total) {
      this.lastLoggedPercent = snap.percent;
      log.info(snap, `${this.phase} progress`);
    }
  }

  snapshot(): ProgressSnapshot {
    const percent = this.total > 0 ? Math.floor((this.completed / this.total) * 100) : 0;
    return {
      phase: this.phase,
      completed: this.completed,
      total: this.total,
      percent,
      elapsedMs: Date.now() - this.startedAt,
    };
  }
}
```

- [ ] **Step 4: Verify tests pass**

Run: `pnpm test src/cli/collect/progress.test.ts`

Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/collect/progress.ts src/cli/collect/progress.test.ts
git commit -m "feat(cli): add Progress logger for collect-history phases"
```

---

## Task 10: Phase 1 — universe collector

**Files:**
- Create: `src/cli/collect/universe.ts`
- Create: `src/cli/collect/universe.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/cli/collect/universe.test.ts`:

```ts
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../db/database.js';
import { listUniverse } from '../../db/bt-queries.js';
import { collectUniverse } from './universe.js';
import type { LeaderboardEntry } from '../../types.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => closeDb());

test('collectUniverse: writes top-N by volume into bt_universe', async () => {
  const stubLeaderboard = async (
    _period?: string,
    _orderBy?: string,
    _limit?: number,
  ): Promise<LeaderboardEntry[]> => [
    { address: '0xA', name: 'alice', profileImage: undefined, pnl: 100, volume: 10000, markets_traded: 5, positions_value: 0, rank: 1 },
    { address: '0xB', name: 'bob',   profileImage: undefined, pnl: 200, volume: 5000,  markets_traded: 3, positions_value: 0, rank: 2 },
    { address: '0xC', name: '',      profileImage: undefined, pnl: 50,  volume: 0,     markets_traded: 1, positions_value: 0, rank: 3 },
  ];

  await collectUniverse({ fetchLeaderboard: stubLeaderboard, size: 3 });

  const loaded = listUniverse();
  assert.equal(loaded.length, 3);
  // sorted DESC by volume
  assert.equal(loaded[0]!.address, '0xA');
  assert.equal(loaded[1]!.address, '0xB');
  assert.equal(loaded[2]!.address, '0xC');
});

test('collectUniverse: requests correct leaderboard params', async () => {
  let capturedArgs: unknown[] = [];
  const stubLeaderboard = async (...args: unknown[]): Promise<LeaderboardEntry[]> => {
    capturedArgs = args;
    return [];
  };
  await collectUniverse({ fetchLeaderboard: stubLeaderboard, size: 300 });
  assert.deepEqual(capturedArgs, ['ALL_TIME', 'volume', 300]);
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/cli/collect/universe.test.ts`

Expected FAIL: module not found.

- [ ] **Step 3: Implement**

Create `src/cli/collect/universe.ts`:

```ts
import { createLogger } from '../../utils/logger.js';
import { upsertUniverseEntries } from '../../db/bt-queries.js';
import type { LeaderboardEntry, BtUniverseEntry } from '../../types.js';

const log = createLogger('collect-universe');

export interface UniverseOptions {
  /** Injected fetcher — production passes `dataApi.getLeaderboard.bind(dataApi)`. */
  fetchLeaderboard: (
    period?: string,
    orderBy?: string,
    limit?: number,
  ) => Promise<LeaderboardEntry[]>;
  size: number;
}

export async function collectUniverse(opts: UniverseOptions): Promise<void> {
  log.info({ size: opts.size }, 'Fetching universe (top-N by volume, ALL_TIME)');

  const raw = await opts.fetchLeaderboard('ALL_TIME', 'volume', opts.size);
  log.info({ received: raw.length }, 'Universe leaderboard response');

  const entries: BtUniverseEntry[] = raw.map((e) => ({
    address: e.address,
    name: e.name || 'Unknown',
    volume12m: e.volume,
    addedAt: '',
  }));

  upsertUniverseEntries(entries);
  log.info({ inserted: entries.length }, 'Universe saved');
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm test src/cli/collect/universe.test.ts`

Expected: 2/2 pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/collect/universe.ts src/cli/collect/universe.test.ts
git commit -m "feat(cli): Stage E Phase 1 — universe collector"
```

---

## Task 11: Phase 2 — activity collector with seek pagination and resume

**Files:**
- Create: `src/cli/collect/activity.ts`
- Create: `src/cli/collect/activity.test.ts`

**Pagination strategy:** Polymarket Data API `/activity` supports `start` (timestamp, inclusive) + `limit` but no `offset`. We seek-paginate: fetch with `start=T`, `limit=500`, `sortDirection=ASC`; next call uses `start = lastReceivedTimestamp + 1`. Stop when response has fewer than `limit` rows or we hit the configured cutoff. Resume on rerun: read `maxActivityTimestamp(addr)` from DB, start there.

- [ ] **Step 1: Write failing test**

Create `src/cli/collect/activity.test.ts`:

```ts
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../db/database.js';
import {
  upsertUniverseEntries,
  bulkInsertActivity,
  countActivityForAddress,
  maxActivityTimestamp,
} from '../../db/bt-queries.js';
import { collectActivity } from './activity.js';
import type { ActivityEntry } from '../../types.js';

beforeEach(() => {
  initDb(':memory:');
  upsertUniverseEntries([
    { address: '0xA', name: 'alice', volume12m: 1000, addedAt: '' },
    { address: '0xB', name: 'bob', volume12m: 500, addedAt: '' },
  ]);
});
afterEach(() => closeDb());

function makeActivity(overrides: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: 'x', timestamp: 1000, address: '0xA', type: 'TRADE', action: 'buy',
    market_slug: 's', title: '', description: '', token_id: 'tok', condition_id: 'c',
    outcome: 'Yes', size: 10, price: 0.5, usd_value: 5, transaction_hash: '',
    ...overrides,
  };
}

test('collectActivity: single page, inserts rows', async () => {
  const calls: Array<{ address: string; start?: number }> = [];
  const stub = async (
    address: string,
    opts?: { start?: number; limit?: number },
  ): Promise<ActivityEntry[]> => {
    calls.push({ address, start: opts?.start });
    if (address === '0xA') {
      return [
        makeActivity({ id: 'a1', timestamp: 100, action: 'buy' }),
        makeActivity({ id: 'a2', timestamp: 200, action: 'sell' }),
      ];
    }
    return [];
  };

  await collectActivity({
    fetchActivity: stub,
    historyStartTs: 0,
    pageLimit: 500,
    ratePauseMs: 0,
  });

  assert.equal(countActivityForAddress('0xA'), 2);
  assert.equal(countActivityForAddress('0xB'), 0);
});

test('collectActivity: paginates via seek when page is full', async () => {
  const starts: Array<number | undefined> = [];
  const stub = async (
    address: string,
    opts?: { start?: number; limit?: number },
  ): Promise<ActivityEntry[]> => {
    starts.push(opts?.start);
    if (address !== '0xA') return [];
    const lim = opts?.limit ?? 500;
    // First call: full page (timestamps 100..104). Second call: one remaining (105). Third: empty.
    if (starts.length === 1) {
      return Array.from({ length: lim }, (_, i) =>
        makeActivity({ id: `a${i}`, timestamp: 100 + i }),
      );
    }
    if (starts.length === 2) {
      return [makeActivity({ id: 'alast', timestamp: 999 })];
    }
    return [];
  };

  await collectActivity({
    fetchActivity: stub,
    historyStartTs: 0,
    pageLimit: 5,
    ratePauseMs: 0,
  });

  assert.equal(countActivityForAddress('0xA'), 6);
  // second call's `start` should be 1 greater than the last ts of the first page
  assert.equal(starts[0], 0);
  assert.equal(starts[1], 105);  // 100 + 5 (page) - 1 + 1 = 105
});

test('collectActivity: resume uses maxActivityTimestamp when row exists', async () => {
  // Pre-seed DB with a row for 0xA at ts=500
  bulkInsertActivity([{
    id: 'old', address: '0xA', timestamp: 500, tokenId: 'tok', conditionId: 'c',
    action: 'buy', price: 0.5, size: 1, usdValue: 0.5, marketSlug: '',
  }]);
  assert.equal(maxActivityTimestamp('0xA'), 500);

  const seenStarts: Array<number | undefined> = [];
  const stub = async (
    address: string,
    opts?: { start?: number; limit?: number },
  ): Promise<ActivityEntry[]> => {
    if (address === '0xA') seenStarts.push(opts?.start);
    return [];
  };

  await collectActivity({
    fetchActivity: stub,
    historyStartTs: 0,
    pageLimit: 500,
    ratePauseMs: 0,
  });

  assert.equal(seenStarts[0], 501);  // resume from 500 + 1
});

test('collectActivity: skips non-TRADE or non-buy/sell actions', async () => {
  const stub = async (address: string): Promise<ActivityEntry[]> => {
    if (address !== '0xA') return [];
    return [
      makeActivity({ id: 'r1', type: 'REDEEM', action: 'redeem', timestamp: 100 }),
      makeActivity({ id: 't1', type: 'TRADE', action: 'buy', timestamp: 200 }),
      makeActivity({ id: 't2', type: 'TRADE', action: 'sell', timestamp: 300 }),
    ];
  };

  await collectActivity({
    fetchActivity: stub,
    historyStartTs: 0,
    pageLimit: 500,
    ratePauseMs: 0,
  });

  assert.equal(countActivityForAddress('0xA'), 2);
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/cli/collect/activity.test.ts`

Expected FAIL: module not found.

- [ ] **Step 3: Implement**

Create `src/cli/collect/activity.ts`:

```ts
import { createLogger } from '../../utils/logger.js';
import { sleep } from '../../utils/helpers.js';
import {
  listUniverse,
  bulkInsertActivity,
  maxActivityTimestamp,
} from '../../db/bt-queries.js';
import { Progress } from './progress.js';
import type { ActivityEntry, BtTradeActivity } from '../../types.js';

const log = createLogger('collect-activity');

type FetchActivityFn = (
  address: string,
  opts?: {
    type?: string;
    start?: number;
    sortBy?: string;
    sortDirection?: string;
    limit?: number;
  },
) => Promise<ActivityEntry[]>;

export interface ActivityOptions {
  fetchActivity: FetchActivityFn;
  historyStartTs: number;  // earliest timestamp to fetch if no resume row exists
  pageLimit: number;       // e.g. 500
  ratePauseMs: number;     // delay between API calls
}

export async function collectActivity(opts: ActivityOptions): Promise<void> {
  const universe = listUniverse();
  log.info({ traders: universe.length }, 'Starting activity collection');
  const progress = new Progress('activity', universe.length);

  for (const entry of universe) {
    try {
      await collectOne(entry.address, opts);
    } catch (err) {
      log.warn({ address: entry.address, err: String(err) }, 'Activity collection failed for trader');
    }
    progress.tick();
  }
}

async function collectOne(address: string, opts: ActivityOptions): Promise<void> {
  const resumeFrom = maxActivityTimestamp(address);
  let start = resumeFrom !== null ? resumeFrom + 1 : opts.historyStartTs;

  while (true) {
    const page = await opts.fetchActivity(address, {
      type: 'TRADE',
      start,
      sortBy: 'TIMESTAMP',
      sortDirection: 'ASC',
      limit: opts.pageLimit,
    });

    if (opts.ratePauseMs > 0) await sleep(opts.ratePauseMs);

    if (page.length === 0) break;

    const rows: BtTradeActivity[] = [];
    let maxTs = start;
    for (const a of page) {
      if (a.type !== 'TRADE') continue;
      const action = a.action?.toLowerCase();
      if (action !== 'buy' && action !== 'sell') continue;
      rows.push({
        id: a.id,
        address,
        timestamp: a.timestamp,
        tokenId: a.token_id,
        conditionId: a.condition_id,
        action,
        price: a.price,
        size: a.size,
        usdValue: a.usd_value,
        marketSlug: a.market_slug,
      });
      if (a.timestamp > maxTs) maxTs = a.timestamp;
    }

    if (rows.length > 0) bulkInsertActivity(rows);
    log.debug({ address, pageSize: page.length, inserted: rows.length, start }, 'Activity page processed');

    // If page was not full, we've reached the end.
    if (page.length < opts.pageLimit) break;

    // Seek forward.
    start = maxTs + 1;
  }
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm test src/cli/collect/activity.test.ts`

Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/collect/activity.ts src/cli/collect/activity.test.ts
git commit -m "feat(cli): Stage E Phase 2 — activity collector with seek pagination and resume"
```

---

## Task 12: Phase 3 — markets metadata collector

**Files:**
- Create: `src/cli/collect/markets.ts`
- Create: `src/cli/collect/markets.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/cli/collect/markets.test.ts`:

```ts
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../db/database.js';
import {
  bulkInsertActivity,
  getMarket,
  conditionIdsMissingFromMarkets,
} from '../../db/bt-queries.js';
import { collectMarkets } from './markets.js';
import type { GammaMarket } from '../../types.js';

beforeEach(() => {
  initDb(':memory:');
  // Seed activity so markets collector has condition_ids to chase
  bulkInsertActivity([
    { id: 't1', address: '0xA', timestamp: 100, tokenId: 'tA', conditionId: 'c1',
      action: 'buy', price: 0.5, size: 1, usdValue: 0.5, marketSlug: 'm1' },
    { id: 't2', address: '0xA', timestamp: 200, tokenId: 'tB', conditionId: 'c2',
      action: 'sell', price: 0.5, size: 1, usdValue: 0.5, marketSlug: 'm2' },
  ]);
});
afterEach(() => closeDb());

function fakeMarket(conditionId: string, overrides: Partial<GammaMarket> = {}): GammaMarket {
  return {
    id: 'id-' + conditionId,
    question: 'Question for ' + conditionId,
    slug: 'slug-' + conditionId,
    conditionId,
    tokens: [
      { token_id: 'tA', outcome: 'Yes', price: 0.5 },
      { token_id: 'tB', outcome: 'No', price: 0.5 },
    ],
    orderPriceMinTickSize: 0.01,
    negRisk: false,
    active: true,
    closed: false,
    volume: 100,
    liquidity: 50,
    endDate: '2026-05-01',
    ...overrides,
  };
}

test('collectMarkets: fetches only missing conditionIds', async () => {
  const fetched: string[] = [];
  const stubFetch = async (cid: string): Promise<GammaMarket | null> => {
    fetched.push(cid);
    return fakeMarket(cid);
  };

  assert.deepEqual(conditionIdsMissingFromMarkets().sort(), ['c1', 'c2']);

  await collectMarkets({ fetchMarket: stubFetch, ratePauseMs: 0 });

  assert.deepEqual(fetched.sort(), ['c1', 'c2']);
  assert.ok(getMarket('c1'));
  assert.ok(getMarket('c2'));

  // Second run: nothing to fetch.
  fetched.length = 0;
  await collectMarkets({ fetchMarket: stubFetch, ratePauseMs: 0 });
  assert.deepEqual(fetched, []);
});

test('collectMarkets: persists endDate and closed flag', async () => {
  const stubFetch = async (cid: string): Promise<GammaMarket | null> => {
    return fakeMarket(cid, { closed: true, endDate: '2026-04-01T00:00:00Z' });
  };
  await collectMarkets({ fetchMarket: stubFetch, ratePauseMs: 0 });
  const m = getMarket('c1');
  assert.ok(m);
  assert.equal(m!.closed, 1);
  assert.equal(m!.endDate, '2026-04-01T00:00:00Z');
});

test('collectMarkets: skips null response (market not found in Gamma)', async () => {
  const stubFetch = async (): Promise<GammaMarket | null> => null;
  await collectMarkets({ fetchMarket: stubFetch, ratePauseMs: 0 });
  // c1, c2 still missing since Gamma returned null
  assert.equal(getMarket('c1'), null);
  assert.equal(getMarket('c2'), null);
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/cli/collect/markets.test.ts`

Expected FAIL: module not found.

- [ ] **Step 3: Implement**

Create `src/cli/collect/markets.ts`:

```ts
import { createLogger } from '../../utils/logger.js';
import { sleep } from '../../utils/helpers.js';
import {
  conditionIdsMissingFromMarkets,
  upsertMarket,
} from '../../db/bt-queries.js';
import { Progress } from './progress.js';
import type { GammaMarket, BtMarket } from '../../types.js';

const log = createLogger('collect-markets');

export interface MarketsOptions {
  fetchMarket: (conditionId: string) => Promise<GammaMarket | null>;
  ratePauseMs: number;
}

export async function collectMarkets(opts: MarketsOptions): Promise<void> {
  const cids = conditionIdsMissingFromMarkets();
  log.info({ toFetch: cids.length }, 'Fetching missing market metadata');
  const progress = new Progress('markets', cids.length);

  for (const cid of cids) {
    try {
      const m = await opts.fetchMarket(cid);
      if (m !== null) {
        upsertMarket(toBtMarket(m));
      } else {
        log.debug({ cid }, 'Gamma returned null for conditionId');
      }
    } catch (err) {
      log.warn({ cid, err: String(err) }, 'Market fetch failed');
    }
    if (opts.ratePauseMs > 0) await sleep(opts.ratePauseMs);
    progress.tick();
  }
}

function toBtMarket(m: GammaMarket): BtMarket {
  return {
    conditionId: m.conditionId,
    question: m.question,
    slug: m.slug,
    endDate: m.endDate ?? null,
    volume: m.volume,
    liquidity: m.liquidity,
    negRisk: m.negRisk ? 1 : 0,
    closed: m.closed ? 1 : 0,
    tokenIds: JSON.stringify((m.tokens ?? []).map((t) => t.token_id)),
  };
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm test src/cli/collect/markets.test.ts`

Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/collect/markets.ts src/cli/collect/markets.test.ts
git commit -m "feat(cli): Stage E Phase 3 — markets metadata collector"
```

---

## Task 13: Phase 4 — resolutions collector

**Files:**
- Create: `src/cli/collect/resolutions.ts`
- Create: `src/cli/collect/resolutions.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/cli/collect/resolutions.test.ts`:

```ts
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../db/database.js';
import {
  upsertMarket,
  getResolution,
  closedConditionIdsMissingResolution,
} from '../../db/bt-queries.js';
import { collectResolutions } from './resolutions.js';

beforeEach(() => {
  initDb(':memory:');
  upsertMarket({
    conditionId: 'cClosed1', question: '', slug: '', endDate: null,
    volume: 0, liquidity: 0, negRisk: 0, closed: 1, tokenIds: '["tA","tB"]',
  });
  upsertMarket({
    conditionId: 'cClosed2', question: '', slug: '', endDate: null,
    volume: 0, liquidity: 0, negRisk: 0, closed: 1, tokenIds: '["tX","tY"]',
  });
  upsertMarket({
    conditionId: 'cOpen', question: '', slug: '', endDate: null,
    volume: 0, liquidity: 0, negRisk: 0, closed: 0, tokenIds: '[]',
  });
});
afterEach(() => closeDb());

test('collectResolutions: fetches only closed markets without resolution', async () => {
  const requested: string[] = [];
  const stub = async (cid: string) => {
    requested.push(cid);
    return { closed: true, winnerTokenId: cid === 'cClosed1' ? 'tA' : 'tX' };
  };

  await collectResolutions({ fetchResolution: stub, ratePauseMs: 0 });

  assert.deepEqual(requested.sort(), ['cClosed1', 'cClosed2']);
  assert.equal(getResolution('cClosed1')!.winnerTokenId, 'tA');
  assert.equal(getResolution('cClosed2')!.winnerTokenId, 'tX');
  assert.equal(getResolution('cOpen'), null);
});

test('collectResolutions: idempotent (second run fetches nothing)', async () => {
  const stub = async (cid: string) => ({ closed: true, winnerTokenId: 'tA' });
  await collectResolutions({ fetchResolution: stub, ratePauseMs: 0 });
  assert.deepEqual(closedConditionIdsMissingResolution(), []);

  const secondRun: string[] = [];
  const stub2 = async (cid: string) => {
    secondRun.push(cid);
    return { closed: true, winnerTokenId: 'tA' };
  };
  await collectResolutions({ fetchResolution: stub2, ratePauseMs: 0 });
  assert.deepEqual(secondRun, []);
});

test('collectResolutions: stores winnerTokenId=null if no winner declared', async () => {
  const stub = async () => ({ closed: true, winnerTokenId: null });
  await collectResolutions({ fetchResolution: stub, ratePauseMs: 0 });
  const r = getResolution('cClosed1');
  assert.ok(r);
  assert.equal(r!.winnerTokenId, null);
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/cli/collect/resolutions.test.ts`

Expected FAIL: module not found.

- [ ] **Step 3: Implement**

Create `src/cli/collect/resolutions.ts`:

```ts
import { createLogger } from '../../utils/logger.js';
import { sleep } from '../../utils/helpers.js';
import {
  closedConditionIdsMissingResolution,
  upsertResolution,
} from '../../db/bt-queries.js';
import { Progress } from './progress.js';

const log = createLogger('collect-resolutions');

export interface ResolutionsOptions {
  fetchResolution: (
    conditionId: string,
  ) => Promise<{ closed: boolean; winnerTokenId: string | null }>;
  ratePauseMs: number;
}

export async function collectResolutions(opts: ResolutionsOptions): Promise<void> {
  const cids = closedConditionIdsMissingResolution();
  log.info({ toFetch: cids.length }, 'Fetching resolutions for closed markets');
  const progress = new Progress('resolutions', cids.length);

  for (const cid of cids) {
    try {
      const res = await opts.fetchResolution(cid);
      if (res.closed) {
        upsertResolution({
          conditionId: cid,
          winnerTokenId: res.winnerTokenId,
          resolvedAt: '',
        });
      } else {
        log.warn({ cid }, 'Market marked closed in bt_markets but CLOB says still open — skipping');
      }
    } catch (err) {
      log.warn({ cid, err: String(err) }, 'Resolution fetch failed');
    }
    if (opts.ratePauseMs > 0) await sleep(opts.ratePauseMs);
    progress.tick();
  }
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm test src/cli/collect/resolutions.test.ts`

Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/collect/resolutions.ts src/cli/collect/resolutions.test.ts
git commit -m "feat(cli): Stage E Phase 4 — resolutions collector"
```

---

## Task 14: CLI orchestrator (`collect-history.ts`)

**Files:**
- Create: `src/cli/collect-history.ts`
- Create: `src/cli/collect-history.test.ts`

**CLI contract:**
- `pnpm collect-history` — runs all 4 phases with defaults (size=300, history=365d, rate=250ms)
- `pnpm collect-history --phase=universe` — single phase
- `pnpm collect-history --size=100 --days=180` — custom parameters
- On failure in one phase, subsequent phases still run (they have work to do even on partial data).

- [ ] **Step 1: Write failing test for arg parsing**

Create `src/cli/collect-history.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './collect-history.js';

test('parseArgs: defaults when no flags', () => {
  const opts = parseArgs([]);
  assert.equal(opts.universeSize, 300);
  assert.equal(opts.historyDays, 365);
  assert.equal(opts.ratePauseMs, 250);
  assert.deepEqual(opts.phases, ['universe', 'activity', 'markets', 'resolutions']);
});

test('parseArgs: --size overrides universeSize', () => {
  const opts = parseArgs(['--size=50']);
  assert.equal(opts.universeSize, 50);
});

test('parseArgs: --days overrides historyDays', () => {
  const opts = parseArgs(['--days=90']);
  assert.equal(opts.historyDays, 90);
});

test('parseArgs: --phase=activity runs only that phase', () => {
  const opts = parseArgs(['--phase=activity']);
  assert.deepEqual(opts.phases, ['activity']);
});

test('parseArgs: --phase=universe,markets runs subset', () => {
  const opts = parseArgs(['--phase=universe,markets']);
  assert.deepEqual(opts.phases, ['universe', 'markets']);
});

test('parseArgs: throws on unknown phase', () => {
  assert.throws(() => parseArgs(['--phase=bogus']), /unknown phase/);
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm test src/cli/collect-history.test.ts`

Expected FAIL: module not found.

- [ ] **Step 3: Implement**

Create `src/cli/collect-history.ts`:

```ts
import { initDb, closeDb } from '../db/database.js';
import { DataApi } from '../api/data-api.js';
import { GammaApi } from '../api/gamma-api.js';
import { ClobClientWrapper } from '../api/clob-client.js';
import { createLogger } from '../utils/logger.js';
import { collectUniverse } from './collect/universe.js';
import { collectActivity } from './collect/activity.js';
import { collectMarkets } from './collect/markets.js';
import { collectResolutions } from './collect/resolutions.js';
import type { CollectHistoryOptions } from '../types.js';

const log = createLogger('collect-history');

const VALID_PHASES = ['universe', 'activity', 'markets', 'resolutions'] as const;
type Phase = typeof VALID_PHASES[number];

export function parseArgs(argv: string[]): CollectHistoryOptions {
  let size = 300;
  let days = 365;
  let rate = 250;
  let phases: Phase[] = [...VALID_PHASES];

  for (const a of argv) {
    if (a.startsWith('--size=')) size = Number(a.slice(7));
    else if (a.startsWith('--days=')) days = Number(a.slice(7));
    else if (a.startsWith('--rate=')) rate = Number(a.slice(7));
    else if (a.startsWith('--phase=')) {
      const requested = a.slice(8).split(',').map((s) => s.trim());
      for (const p of requested) {
        if (!VALID_PHASES.includes(p as Phase)) {
          throw new Error(`unknown phase: ${p}. Valid: ${VALID_PHASES.join(',')}`);
        }
      }
      phases = requested as Phase[];
    }
  }

  return { universeSize: size, historyDays: days, ratePauseMs: rate, phases };
}

export async function runCollectHistory(opts: CollectHistoryOptions): Promise<void> {
  const dataApi = new DataApi();
  const gammaApi = new GammaApi();
  const clob = new ClobClientWrapper();

  const historyStartTs =
    Math.floor(Date.now() / 1000) - opts.historyDays * 24 * 60 * 60;

  if (opts.phases.includes('universe')) {
    log.info('--- Phase 1: universe ---');
    await collectUniverse({
      fetchLeaderboard: dataApi.getLeaderboard.bind(dataApi),
      size: opts.universeSize,
    });
  }

  if (opts.phases.includes('activity')) {
    log.info('--- Phase 2: activity ---');
    await collectActivity({
      fetchActivity: dataApi.getActivity.bind(dataApi),
      historyStartTs,
      pageLimit: 500,
      ratePauseMs: opts.ratePauseMs,
    });
  }

  if (opts.phases.includes('markets')) {
    log.info('--- Phase 3: markets ---');
    await collectMarkets({
      fetchMarket: gammaApi.getMarketByConditionId.bind(gammaApi),
      ratePauseMs: opts.ratePauseMs,
    });
  }

  if (opts.phases.includes('resolutions')) {
    log.info('--- Phase 4: resolutions ---');
    await collectResolutions({
      fetchResolution: clob.getMarketResolution.bind(clob),
      ratePauseMs: opts.ratePauseMs,
    });
  }
}

// Entry point (executed when run via `tsx src/cli/collect-history.ts`)
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  log.info(opts, 'Starting collect-history');
  initDb();
  runCollectHistory(opts)
    .then(() => {
      log.info('collect-history complete');
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      log.error({ err: String(err) }, 'collect-history failed');
      closeDb();
      process.exit(1);
    });
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm test src/cli/collect-history.test.ts`

Expected: 6/6 pass.

- [ ] **Step 5: Verify typecheck**

Run: `npx tsc --noEmit`

Expected: 0 errors.

- [ ] **Step 6: Add `collect-history` script to package.json**

Modify `package.json` `scripts`:

```json
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc && cp -r src/dashboard/public dist/dashboard/public",
    "start": "node dist/index.js",
    "test": "tsx --test 'src/**/*.test.ts'",
    "collect-history": "tsx src/cli/collect-history.ts"
  },
```

- [ ] **Step 7: Commit**

```bash
git add src/cli/collect-history.ts src/cli/collect-history.test.ts package.json
git commit -m "feat(cli): add collect-history orchestrator and pnpm script"
```

---

## Task 15: End-to-end smoke test

**Files:**
- Create: `src/cli/collect-history.e2e.test.ts`

- [ ] **Step 1: Write full-pipeline smoke test with all deps stubbed**

Create `src/cli/collect-history.e2e.test.ts`:

```ts
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../db/database.js';
import { collectUniverse } from './collect/universe.js';
import { collectActivity } from './collect/activity.js';
import { collectMarkets } from './collect/markets.js';
import { collectResolutions } from './collect/resolutions.js';
import type { ActivityEntry, GammaMarket, LeaderboardEntry } from '../types.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => closeDb());

test('end-to-end: 2 traders → 3 trades → 2 markets → 1 resolution', async () => {
  const stubLb = async (): Promise<LeaderboardEntry[]> => [
    { address: '0xA', name: 'alice', profileImage: undefined, pnl: 0, volume: 1000, markets_traded: 2, positions_value: 0, rank: 1 },
    { address: '0xB', name: 'bob', profileImage: undefined, pnl: 0, volume: 500, markets_traded: 1, positions_value: 0, rank: 2 },
  ];

  const activityMap: Record<string, ActivityEntry[]> = {
    '0xA': [
      { id: 'a1', timestamp: 100, address: '0xA', type: 'TRADE', action: 'buy',
        market_slug: 'm1', title: '', description: '', token_id: 'tA1', condition_id: 'c1',
        outcome: 'Yes', size: 10, price: 0.5, usd_value: 5, transaction_hash: '' },
      { id: 'a2', timestamp: 200, address: '0xA', type: 'TRADE', action: 'sell',
        market_slug: 'm1', title: '', description: '', token_id: 'tA1', condition_id: 'c1',
        outcome: 'Yes', size: 8, price: 0.7, usd_value: 5.6, transaction_hash: '' },
    ],
    '0xB': [
      { id: 'b1', timestamp: 150, address: '0xB', type: 'TRADE', action: 'buy',
        market_slug: 'm2', title: '', description: '', token_id: 'tB1', condition_id: 'c2',
        outcome: 'Yes', size: 5, price: 0.4, usd_value: 2, transaction_hash: '' },
    ],
  };
  const stubActivity = async (addr: string): Promise<ActivityEntry[]> =>
    activityMap[addr] ?? [];

  const marketsMap: Record<string, GammaMarket> = {
    c1: {
      id: 'id1', question: 'Q1', slug: 'q1', conditionId: 'c1',
      tokens: [{ token_id: 'tA1', outcome: 'Yes', price: 0.5 }],
      orderPriceMinTickSize: 0.01, negRisk: false, active: false, closed: true,
      volume: 100, liquidity: 50, endDate: '2026-03-01',
    },
    c2: {
      id: 'id2', question: 'Q2', slug: 'q2', conditionId: 'c2',
      tokens: [{ token_id: 'tB1', outcome: 'Yes', price: 0.5 }],
      orderPriceMinTickSize: 0.01, negRisk: false, active: true, closed: false,
      volume: 200, liquidity: 75, endDate: '2027-01-01',
    },
  };
  const stubGamma = async (cid: string): Promise<GammaMarket | null> =>
    marketsMap[cid] ?? null;

  const stubClob = async (cid: string) => ({
    closed: true,
    winnerTokenId: cid === 'c1' ? 'tA1' : null,
  });

  await collectUniverse({ fetchLeaderboard: stubLb, size: 2 });
  await collectActivity({ fetchActivity: stubActivity, historyStartTs: 0, pageLimit: 500, ratePauseMs: 0 });
  await collectMarkets({ fetchMarket: stubGamma, ratePauseMs: 0 });
  await collectResolutions({ fetchResolution: stubClob, ratePauseMs: 0 });

  // Sanity: counts
  const counts = (table: string) =>
    (getDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

  assert.equal(counts('bt_universe'), 2);
  assert.equal(counts('bt_trader_activity'), 3);
  assert.equal(counts('bt_markets'), 2);
  assert.equal(counts('bt_market_resolutions'), 1);

  // Sanity: end_date persisted and queryable
  const m1 = getDb().prepare('SELECT end_date, closed FROM bt_markets WHERE condition_id = ?').get('c1') as { end_date: string; closed: number };
  assert.equal(m1.end_date, '2026-03-01');
  assert.equal(m1.closed, 1);

  // Sanity: the open market did not get a resolution row
  const r2 = getDb().prepare('SELECT * FROM bt_market_resolutions WHERE condition_id = ?').get('c2');
  assert.equal(r2, undefined);
});
```

- [ ] **Step 2: Run test, expect PASS**

Run: `pnpm test src/cli/collect-history.e2e.test.ts`

Expected: 1/1 pass. This validates all four phases wire together correctly against the SQLite schema.

- [ ] **Step 3: Full test suite sanity**

Run: `pnpm test`

Expected: every test file from Tasks 1-15 passes, 0 failures.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/cli/collect-history.e2e.test.ts
git commit -m "test: end-to-end smoke test for Stage E collect-history pipeline"
```

---

## Manual verification (for user, after implementation completes)

After all 15 tasks are committed, the user runs:

```bash
# 1. Quick dry-run with tiny universe to validate against live APIs
pnpm collect-history --size=5 --days=30

# 2. Inspect DB
sqlite3 data/copybot.db <<'SQL'
.headers on
SELECT COUNT(DISTINCT address) AS traders FROM bt_trader_activity;
SELECT MIN(timestamp), MAX(timestamp) FROM bt_trader_activity;
SELECT COUNT(*) AS markets FROM bt_markets;
SELECT COUNT(*) AS closed_markets FROM bt_markets WHERE closed = 1;
SELECT COUNT(*) AS resolutions FROM bt_market_resolutions;
SELECT COUNT(*) AS null_endDate FROM bt_markets WHERE end_date IS NULL;
SQL
```

Expected for `--size=5 --days=30`:
- `traders` = 5 (or fewer if some wallets had no trades in the window)
- `timestamp` range approximately last 30 days in Unix seconds
- `markets` > 0, typically 5-50
- `resolutions` rows only for closed markets
- `null_endDate` ideally < 10% of total markets

```bash
# 3. Full production run (expect 3-6 hours)
pnpm collect-history
```

Expected final state:
- `bt_universe` = 300 rows
- `bt_trader_activity` = 300k–1.5M rows
- `bt_markets` = 5k–20k rows
- `bt_market_resolutions` > 0 (only for closed markets)

```bash
# 4. Idempotency verification: re-run immediately, should complete quickly with near-zero new rows
pnpm collect-history
```

Expected: second run finishes in under a minute (resume skips already-collected data), no new rows added beyond trades that arrived between the two runs.

---

## Self-Review

**Spec coverage check** (against approved design `iterative-stargazing-catmull.md` Stage E):
- ✅ Universe U2 (top-300 by volume): Task 10
- ✅ Ranking by volume, not PnL: Task 10 (`getLeaderboard('ALL_TIME', 'volume', ...)`)
- ✅ SQLite schema (4 new tables): Task 4
- ✅ `bt_trader_activity` indexes on `(address, ts)`, `(token_id, ts)`, `(condition_id, ts)`: Task 4
- ✅ Idempotent resume by `maxActivityTimestamp`: Task 11
- ✅ Rate limiting via `ratePauseMs` (defaults 250ms, matching `leaderboard.ts:11`): Task 14
- ✅ `fetchWithRetry` reused via existing API wrappers: Tasks 7, 8
- ✅ `GammaMarket.endDate` surfaced: Tasks 3, 7
- ✅ CLOB `tokens[].winner` → `bt_market_resolutions`: Task 8, 13
- ✅ `createLogger('...')` pattern: every task

**Placeholder scan:** None. All steps contain complete code.

**Type consistency check:**
- `BtTradeActivity.action` typed as `'buy' | 'sell'` — `activity.ts` normalizes with `.toLowerCase()` before insert ✅
- `BtMarket.closed` and `negRisk` are `number` (SQLite bool idiom 0/1) — `markets.ts` converts with ternaries ✅
- `upsertResolution` input takes `resolvedAt: string` but column uses `CURRENT_TIMESTAMP` default — the query deliberately ignores `resolvedAt` param (passing empty is fine) ✅
- Function names: `collectUniverse`, `collectActivity`, `collectMarkets`, `collectResolutions` — consistent across files and CLI ✅

Plan is internally consistent and fully covers Stage E of the approved design.
