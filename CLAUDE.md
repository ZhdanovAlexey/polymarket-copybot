# CLAUDE.md — PolyMarket CopyBot PRO

## Project Status
All code is implemented (12 stages, 40 source files, ~16.5k lines TS/JS). TypeScript compiles with 0 errors.
**What remains:** manual testing and verification. See `STATUS.md` for the full TODO checklist.
Demo account (paper trading) mode implemented: virtual balance, commission tracking, reset, live prices.
Settings hot-reload without server restart. Polymarket API v1 migration complete.
Known improvements: backtest frontend page, WebSocket support, unit tests.

## How to start working
1. Read `STATUS.md` — it has a TODO checklist of what needs testing/fixing
2. Run `pnpm dev` — starts dashboard on :3000 + bot in idle mode
3. The spec is `POLYMARKET_COPYBOT_TZ.md` — source of truth for all requirements
4. TypeScript check: `npx tsc --noEmit` — should always be 0 errors

## Commands
```bash
pnpm dev          # Run via tsx (dev mode), dashboard on :3000
pnpm build        # Compile TypeScript to dist/
pnpm start        # Run compiled JS (production)
```

## Tech stack
- TypeScript ESM (`"type": "module"`, `.js` extensions in imports, `NodeNext` module resolution)
- Node.js 18+, pnpm
- Express 5 (note: wildcard routes use `/{*path}` not `*`)
- SQLite via better-sqlite3 (synchronous API, singleton via `getDb()`)
- ethers v5 for Polygon wallet/contract interactions
- @polymarket/clob-client v5 for CLOB API trading
- pino logger with child loggers per module (`createLogger('module-name')`)
- dotenv + zod validation for config (`src/config.ts`)
- Vanilla HTML/CSS/JS frontend (no React), Chart.js via CDN, dark theme
- Server-Sent Events for real-time dashboard updates
- node-telegram-bot-api for notifications

## Architecture — key files

**Entry point:** `src/index.ts` — inits DB, starts dashboard, creates Bot (idle until started via UI/API)

**Bot orchestrator:** `src/core/bot.ts` — `start()` fetches leaderboard, initializes tracker polling, starts redeemer, schedules PnL snapshots. `stop()` cleans up all timers. Wires: Leaderboard → Tracker → Executor → Portfolio.

**Trade pipeline:**
- `src/core/leaderboard.ts` — composite scoring (PnL 40% + WinRate 25% + Volume 15% + Trades 10% + Consistency 10%); negative PnL uses signed-log so losing traders are penalised (not floored to 0). Fetches `max(30, topN*3)` to absorb enrichment failures + activity-filter dropouts, sorts by `score DESC`, slices top N. Manual refresh via `bot.refreshLeaderboardNow()` / `POST /api/bot/refresh-leaderboard`; auto-triggered when user changes `top_traders_count`/`leaderboard_period`/`min_trader_volume` in Settings.
- `src/core/tracker.ts` — EventEmitter, polls Data API per trader (active + exit-only), emits `newTrade`
- `src/core/executor.ts` — BUY/SELL with dry-run (demo account with virtual balance + commission) and real modes, lazy auth ClobClient. Ignores BUY from exit-only traders. BUY size can be proportional to trader's USD: when `bet_sizing_mode = proportional`, `our_usd = betSize × clamp(trader_usd / anchor, min, max)` (defaults: anchor $100, min 1×, max 5×). Falls back to fixed `betSizeUsd` when mode=fixed or trader usdValue missing.
- `src/core/redeemer.ts` — auto-redeems resolved markets on `config.redeemCheckIntervalMs` cadence. Real mode: `ctf.redeemPositions` on-chain via ethers v5. Demo mode: polls CLOB `/markets/{conditionId}`, uses `tokens[].winner` flag to credit demo balance ($1/share for winner, $0 for loser), marks position `status='redeemed'`, writes a `side='REDEEM'` entry to trades. Demo-redeem attributes each trade to the opener trader (`queries.getOpeningTraderForToken`) to satisfy `trades.trader_address` FK.
- `src/core/risk-manager.ts` — daily limit, max positions, slippage, liquidity checks
- `src/core/portfolio.ts` — position tracking, avg price recalculation

**Trader states** (`tracked_traders.active`, `tracked_traders.exit_only`):
- `active=1, exit_only=0` — normal: copies BUY + SELL (top-N after leaderboard refresh)
- `active=0, exit_only=1` — exit-only: tracker polls, only SELL signals executed (trader dropped out of top-N or manually removed while holding linked positions)
- `active=0, exit_only=0` — not tracked. Traders auto-transition from exit-only to this state once all positions opened via their BUYs are closed (see `bot.ts:cleanupExitOnlyIfEmpty` and `bot.ts:reconcileDroppedTraders`).

**API wrappers:**
- `src/api/data-api.ts` — DataApi class (public, no auth)
- `src/api/gamma-api.ts` — GammaApi class (public, no auth)
- `src/api/clob-client.ts` — ClobClientWrapper (public) + `initClobClientWithAuth()` (ethers v5 wallet → ClobClient)

**Strategy:** `src/core/strategy/` — performance.ts, rotation.ts, backtest.ts, optimizer.ts, anomaly.ts

**Dashboard:** `src/dashboard/server.ts` → routes: api.ts, auth.ts, sse.ts, backtest.ts, export.ts. Frontend: `public/` with index.html + CSS + 7 JS modules.

**DB:** `src/db/` — database.ts (singleton), migrations.ts (10 tables), queries.ts (typed wrappers for all tables)

## Conventions
- ESM: `import`/`export`, `.js` extensions in all TS imports
- Logging: `createLogger('module')` → pino child logger. Debug for details, info for actions, warn for skips, error for failures.
- Config: all settings in `src/config.ts` (zod-validated). Wallet credentials default to empty (set via Setup Wizard).
- DB: snake_case in SQL, camelCase in TypeScript. Mapper functions in queries.ts.
- Private keys: NEVER logged, NEVER in DB, NEVER sent to frontend. Only in `.env`.
- All monetary values in USD, prediction market prices in 0-1 range.
- `src/types.ts` — shared contract with ALL interfaces. Modify when adding new cross-module types.

## Smart Contracts (Polygon mainnet, chain ID 137)
- CTF Exchange: `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
- Neg Risk Exchange: `0xC5d563A36AE78145C45a50134d48A1215220f80a`
- CTF (Conditional Tokens): `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`
- USDC.e: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`
- Neg Risk Adapter: `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`

## Git
- Repo: `github.com/ZhdanovAlexey/polymarket-copybot` (private)
- 11 commits, all on `main`
- Commit convention: `feat: stage N — description`
