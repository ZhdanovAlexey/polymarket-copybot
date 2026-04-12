# STATUS — PolyMarket CopyBot PRO

> Last updated: 2026-04-12

## Phase 0: Bootstrap
- [x] git init
- [x] GitHub private repo created
- [x] CLAUDE.md
- [x] STATUS.md
- [x] .gitignore, .env.example
- [ ] Initial commit + push

## Stage 1: Project Skeleton
- [ ] package.json + pnpm install
- [ ] tsconfig.json
- [ ] src/types.ts — all interfaces
- [ ] src/config.ts — zod schema
- [ ] src/utils/logger.ts — pino
- [ ] src/utils/helpers.ts
- [ ] src/db/database.ts — SQLite init
- [ ] src/db/migrations.ts — 6 tables
- [ ] src/db/queries.ts — typed wrappers
- [ ] src/index.ts — entry point
- [ ] Verify: `pnpm dev` works, DB has 6 tables

## Stage 2: API Wrappers
- [ ] src/utils/retry.ts — exponential backoff
- [ ] src/api/data-api.ts — DataApi class
- [ ] src/api/gamma-api.ts — GammaApi class
- [ ] src/api/clob-client.ts — CLOB stub (read-only)
- [ ] Verify: real API data returned

## Stage 3: Leaderboard & Scoring
- [ ] src/core/leaderboard.ts — composite scoring
- [ ] DB queries for tracked_traders
- [ ] Verify: top-10 with scores in SQLite

## Stage 4: Trade Tracker
- [ ] src/core/tracker.ts — polling + EventEmitter
- [ ] DB queries for activity_log
- [ ] Verify: polling detects trades

## Stage 5: Read-only Dashboard
- [ ] src/dashboard/server.ts — Express
- [ ] src/dashboard/routes/api.ts — REST endpoints
- [ ] src/dashboard/public/index.html — SPA layout
- [ ] src/dashboard/public/css/styles.css — dark theme
- [ ] src/dashboard/public/js/app.js
- [ ] src/dashboard/public/js/dashboard.js — metrics
- [ ] src/dashboard/public/js/trades.js — trade log
- [ ] src/dashboard/public/js/traders.js — trader cards
- [ ] Verify: dashboard opens, API responds

## Stage 6: Setup Wizard & Wallet Auth
- [ ] src/dashboard/routes/auth.ts — auth endpoints
- [ ] src/dashboard/public/js/settings.js — wizard UI
- [ ] src/api/clob-client.ts — full auth
- [ ] Verify: wizard flow works end-to-end

## Stage 7: Order Execution (Dry Run)
- [ ] src/core/executor.ts — buy/sell (dry run)
- [ ] src/core/risk-manager.ts — canTrade, slippage, limits
- [ ] src/core/portfolio.ts — positions tracking
- [ ] DB queries for trades, positions
- [ ] Integration: Tracker → Risk → Executor → Portfolio
- [ ] Verify: DRY_RUN trades in DB and dashboard

## Stage 8: Real Trading
- [ ] executor.ts — real order placement
- [ ] Order status checking + retry
- [ ] Partial fills / rejections handling
- [ ] Verify: real $1 order placed and filled

## Stage 9: SSE + Live Feed + Charts
- [ ] src/dashboard/routes/sse.ts — SSE endpoint
- [ ] src/dashboard/public/js/sse-client.js
- [ ] src/dashboard/public/js/charts.js — Chart.js
- [ ] PnL snapshot saving (5 min)
- [ ] GET /api/pnl-history
- [ ] Verify: 2 tabs update simultaneously

## Stage 10: Bot Lifecycle + Redeem + Telegram
- [ ] src/core/bot.ts — orchestrator
- [ ] src/core/redeemer.ts — auto-redeem
- [ ] src/notifications/telegram.ts
- [ ] Dashboard: Start/Stop, Settings page
- [ ] Verify: start/stop, Telegram, redeem

## Stage 11: Strategy Intelligence
- [ ] src/core/strategy/performance.ts — P&L attribution, auto-drop
- [ ] src/core/strategy/rotation.ts — trader rotation, probation
- [ ] src/core/strategy/backtest.ts — backtesting engine
- [ ] src/core/strategy/optimizer.ts — Kelly Criterion, adaptive params
- [ ] src/core/strategy/anomaly.ts — anomaly detection (alerts only)
- [ ] Dashboard: backtest UI, recommendations, anomaly alerts
- [ ] DB: trader_performance, rotation_log, backtest_results, anomaly_log
- [ ] Verify: backtest runs, recommendations work, anomaly alerts fire

## Stage 12: Production Polish
- [ ] Error boundaries everywhere
- [ ] Graceful shutdown (SIGTERM/SIGINT)
- [ ] CSV export
- [ ] README.md
- [ ] scripts/check-balance.ts
- [ ] Dockerfile + docker-compose.yml
- [ ] Final acceptance test (19 criteria + strategy)

---

## Deferred
- WebSocket real-time tracking (optional, polling is primary)
- Unit/integration tests (vitest)

## Next Steps
Starting Stage 1...
