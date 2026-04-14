# Stage B — Grid Search + Walk-Forward Validation

## Problem

Stage E collected 260k trades from 36 active traders across 10.5k resolved markets (12 months). Baseline win rate is 52.5% — barely above coin flip. Simple copy-trading without signal filtering bleeds capital on a small deposit ($500). We need to find the conviction sizing parameters (H6) and time-to-resolution filter (H7) that maximize risk-adjusted return (Calmar = PnL / MaxDrawdown).

## Solution

Three CLI tools operating on read-only Stage E data:

1. **`pnpm grid-search`** — evaluates parameter combinations via Latin Hypercube Sampling (coarse) then local Cartesian grid (fine), stores results in `bt_grid_runs`.
2. **`pnpm walk-forward`** — validates top-20 grid candidates with rolling 6-month train / 1-month test, stores in `bt_walkforward_runs`. Selects top-3 finalists by worst-fold Calmar.
3. **`pnpm report`** — generates static HTML + CSV from result tables (heatmaps, equity curves, fold charts).

## Core Engine: ConvictionSizer

Pure function. Input: trade data + trader state + consensus window + trader score. Output: USD bet size (or 0 = skip).

```
bet_usd = betBase
  × clamp(trader_usd / f1_anchor, 1, f1_max)           -- F1: absolute size signal
  × (1 + w2 × zscore(trader_usd, rolling_50_trades))    -- F2: relative conviction
  × (1 + w3 × traderScore / 100)                        -- F3: trader quality
  × (consensus_count >= 2 ? f4_boost : 1.0)             -- F4: multi-trader agreement
```

Where:
- `trader_usd` = trade's `usd_value` from `bt_trader_activity`
- `rolling_50_trades` = last 50 trades of this trader (for z-score)
- `traderScore` = composite score recomputed on window `[T-windowDays, T)` using `leaderboard.ts:calculateScore` formula
- `consensus_count` = number of distinct tracked traders who bought the same `token_id` within 24h before timestamp T

## Core Engine: Time-Indexed Backtester

Replaces the existing naive `backtest.ts:run()`. For each day T in the simulation period:

1. **Rebuild leaderboard** from `bt_trader_activity` on window `[T-windowDays, T)`:
   - For each address in `bt_universe`, compute PnL, trade count, win rate (ground-truth via `bt_market_resolutions`), volume
   - Score using `leaderboard.ts:calculateScore` (same formula as live bot)
   - Select top-N by score = "active tracked traders" for day T

2. **Simulate trades** from `bt_trader_activity` where `address IN active_set AND timestamp ∈ [T, T+1d)`:
   - **H7 gate:** skip if `bt_markets.end_date - timestamp > maxTtrDays` or `end_date IS NULL`
   - **Conviction sizing:** `ConvictionSizer.compute(...)` → bet_usd; if 0 → skip
   - **Max positions:** skip if open positions >= 20
   - **Costs:** BUY at `price × 1.01` (1% slippage), commission `bet_usd × 0.02`; SELL at `price × 0.99`, same commission
   - **Position tracking:** merge into open position (avg price recalc) or open new

3. **Mark-to-market** at end of day T:
   - Open positions valued at last observed price from `bt_trader_activity` for that token
   - Closed/resolved markets: $1/share if token matches `bt_market_resolutions.winner_token_id`, $0 otherwise
   - Record equity, track max equity for drawdown

4. **Metrics** at end of simulation:
   - `calmar = total_pnl / max_drawdown` (primary)
   - `sharpe = (avg_daily_return / std_daily_return) × sqrt(252)`
   - `win_rate` = closed positions where pnl > 0 / total closed
   - `trade_count`, `avg_ttr_days`

## Grid Search Parameters

| Parameter | Grid Values | Description |
|-----------|-------------|-------------|
| `topN` | 5, 10, 20 | Active traders per day |
| `leaderboardWindowDays` | 14, 30, 60 | Scoring lookback window |
| `f1Anchor` | 20, 100, 500 | USD anchor for F1 normalization |
| `f1Max` | 3, 5 | Max F1 multiplier |
| `w2` | 0, 0.3, 0.6 | F2 z-score weight |
| `w3` | 0, 0.5, 1.0 | F3 trader-score weight |
| `f4Boost` | 1.0, 1.5, 2.0 | F4 consensus multiplier |
| `maxTtrDays` | 3, 7, 14, 30, Infinity | H7 time-to-resolution cap |

**Fixed:** `betBase=$2`, `initialCapital=$500`, `slippage=1%`, `commission=2%`, `maxPositions=20`.

**Full Cartesian:** 7,290 combinations. Strategy:
1. **Coarse:** Latin Hypercube Sampling, 300 points uniformly across parameter space.
2. **Fine:** Local Cartesian grid around top-20 coarse winners, ~500 additional points.

## Walk-Forward Validation

- **Scheme:** Rolling 6-month train / 1-month test
- **Data:** April 2025 → March 2026 (12 months)
- **Folds:** 6 total
  - Fold 1: train=[Apr-Sep 2025], test=[Oct 2025]
  - Fold 2: train=[May-Oct 2025], test=[Nov 2025]
  - ...
  - Fold 6: train=[Sep 2025-Feb 2026], test=[Mar 2026]
- **Per fold:** Run backtester with candidate's fixed parameters on the test month only; compute Calmar.
- **Selection metric:** `min_calmar` across all 6 folds (worst-case protection against overfit).
- **Output:** Top-3 candidates by `min_calmar` → Stage D forward-test.

## Database Schema (new tables)

```sql
CREATE TABLE IF NOT EXISTS bt_grid_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,        -- groups coarse/fine runs
  params_json TEXT NOT NULL,
  calmar REAL,
  pnl REAL,
  max_dd REAL,
  sharpe REAL,
  win_rate REAL,
  trade_count INTEGER,
  avg_ttr_days REAL,
  ran_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS bt_grid_runs_run_id ON bt_grid_runs(run_id);
CREATE INDEX IF NOT EXISTS bt_grid_runs_calmar ON bt_grid_runs(calmar DESC);

CREATE TABLE IF NOT EXISTS bt_walkforward_runs (
  id TEXT PRIMARY KEY,
  params_json TEXT NOT NULL,
  median_calmar REAL,
  min_calmar REAL,
  pct_positive_folds REAL,
  folds_json TEXT,
  ran_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## CLI Interface

```bash
# Coarse grid search (300 LHS points, full 12-month period)
pnpm grid-search --preset=coarse --period=2025-04-14:2026-04-13

# Fine grid around top-20 coarse winners
pnpm grid-search --preset=fine

# Walk-forward top-20 grid candidates
pnpm walk-forward --candidates=top20

# Generate HTML/CSV reports
pnpm report
```

## Reports

### grid.html
- Calmar heatmap (selectable axis pairs: topN × maxTtrDays, w2 × f4Boost, etc.)
- Top-20 sortable table (all metrics)
- Equity curve of best candidate

### walkforward.html
- Fold-by-fold Calmar bar chart per candidate (top-20)
- Top-3 finalists highlighted
- Min/median/max Calmar summary table

### grid.csv
- All grid run rows, one per line, for external analysis

## Data Dependencies

All read-only from Stage E:
- `bt_universe` — trader addresses
- `bt_trader_activity` — trade history (address, timestamp, token_id, condition_id, action, price, size, usd_value)
- `bt_markets` — market metadata (condition_id, end_date, closed)
- `bt_market_resolutions` — ground-truth winners (condition_id, winner_token_id)

## Key Assumptions

1. **Universe = 36 active traders** (50 in bt_universe, 14 with 0 trades). Daily top-N rotates within this pool. If rotation is <10 unique traders across 12 months, results have limited generalizability.
2. **10k trade cap per trader** — capped traders' scoring may undercount their true activity. Accepted trade-off for collection speed.
3. **No liquidity data** — CLOB doesn't return volume/liquidity. Fixed 1% slippage is conservative for $2-10 trade sizes.
4. **Slippage model is symmetric** — both BUY and SELL get 1% adverse spread.
5. **Commission = 2%** — matches demo mode setting; real Polymarket has 0% maker/taker fees but gas costs on Polygon (~$0.01).
