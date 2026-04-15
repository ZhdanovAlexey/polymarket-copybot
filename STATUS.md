# STATUS — PolyMarket CopyBot PRO

> Last updated: 2026-04-15

---

## Code Implementation — DONE

All 12 stages implemented. 40 source files, ~16.5k lines. TypeScript compiles with 0 errors.
`pnpm dev` starts successfully, dashboard serves on :3000, API responds, graceful shutdown works.

---

## Recent Changes

- **Comprehensive strategy upgrade (Phases 1–7, branch `feature/strategy-upgrade`)**: 7-phase upgrade adding production-grade risk management, execution intelligence, and selection quality. Manual testing required. Key additions:
  - **Phase 1 — Foundation**: 10 new DB tables (stop_loss_events, drawdown_events, health_events, backfill_jobs, twap_orders, conviction_scores, exit_signals, rotation_log, trader_metrics, anomaly_events). 35 new config fields. Extended types.ts and queries.ts.
  - **Phase 2 — Market Resolver**: `market-resolver.ts` — computes realized win rate per trader via CLOB market resolution; background backfill on bot start; `rescoreWithRealWinRates` updates leaderboard scores in-place.
  - **Phase 3 — Risk foundation**: `stop-loss-monitor.ts` (fixed + trailing, anti-cascade), `execution/liquidity.ts` (depth fetch, adaptive slippage, spread guard), `health-checker.ts` (CLOB ping, circuit breaker halt/resume), `execution/trade-queue.ts` (concurrency limit, stale TTL, dedup).
  - **Phase 4 — Rotation, probation, concentration, anomaly**: `rotation.ts` extended with probation period + blacklist. `risk-manager.ts` extended with concentration checks (per-market, per-token, per-event). `anomaly.ts` extended with configurable actions (ignore/alert/reduce_size/skip_trade/halt_trader).
  - **Phase 5 — Conviction, exit strategies, TWAP, market age**: `conviction-store.ts` + `conviction.ts` — per-market conviction scoring influencing bet size. `exit-strategy.ts` — take-profit and partial scale-out exit signals via Portfolio events. `execution/twap.ts` — TWAP slicing with drift guard + resume on restart. Market age factor F5 in leaderboard scoring.
  - **Phase 6 — Adaptive weights, rolling drawdown, correlation, auto-optimizer**: `adaptive-weights.ts` — EWMA-based rolling recalculation of leaderboard scoring weights. `drawdown-monitor.ts` — rolling DD window with adaptive threshold and pause/unpause. `correlation.ts` — pairwise correlation filter to avoid correlated position concentration. `auto-optimizer.ts` — periodic parameter optimization with improvement threshold guard.
  - **Phase 7 — WebSocket skeleton**: `src/api/websocket-client.ts` — `PolymarketWsClient` EventEmitter-based WS client with auto-reconnect. NOT wired into trade tracking (Polymarket has no public user-activity WS). `Tracker.startWebSocket()` stub logs notice and falls back to polling. Infrastructure ready for future WS endpoints.

- **Proportional bet sizing**: `executor.executeBuy` теперь не всегда копирует фиксированный `betSizeUsd`, а масштабирует под размер ставки трейдера: `our_usd = betSize × clamp(trader_usd / anchor, minMul, maxMul)`. Новые настройки `bet_sizing_mode` (`fixed` | `proportional`, дефолт proportional), `bet_scale_anchor_usd` (100), `bet_scale_min_mul` (1), `bet_scale_max_mul` (5). При mode=fixed или если `usdValue` API не вернул — фолбэк на базовую сумму. В DRY RUN log'ах добавлены поля `traderUsd` и `mul` для прозрачности. UI-поля в Settings → Trading. Top-up'ы трейдера продолжают копироваться каждый по своей логике sizing'а (сознательное решение: top-up = сигнал уверенности).
- **Demo Auto-Redeem for resolved markets**: раньше в demo-mode позиции резолвнутых маркетов висели бесконечно — `redeemer.ts` читал `wallet_address` из settings, а в demo он не ставится → early return. Теперь `Redeemer.checkAndRedeem()` ветвится: в dry-run вызывает новый `checkAndRedeemDemo()`, который для каждой open-позиции бьёт в CLOB `/markets/{conditionId}`. Если `closed=true` — берём `tokens[].winner` флаг для нашего `tokenId`: winner → `payout = shares * $1` в демо-баланс + позиция `status='redeemed'` + запись в Trade Log `side='REDEEM'` / `status='simulated'` + activity-log + SSE-broadcast. Новый `queries.markPositionRedeemed` + `queries.getOpeningTraderForToken` (для атрибуции redeem-трейда к FK tracked_traders). UI: бирюзовый цвет для `REDEEM` в trade log и live feed. Первый скан на 184 позиции закрыл 44 (demo balance +$3,631).
- **Tracked Traders — composite ranking with signed-log PnL, count transparency, on-demand refresh**: composite score is kept as the ranking signal, but `calculateScore` now uses a signed-log PnL component so traders with negative PnL get a negative pnl-score (was floored to 0 — let losers rank high via volume/winrate). Fetch buffer widened to `max(30, topN*3)` so enrichment failures + activity filter still leave ≥ N valid traders. Header shows `Tracked Traders (N/target)` with "Last refreshed Xm ago" tooltip. `↻ Refresh` button triggers immediate leaderboard refresh + reconcile. Settings save auto-triggers refresh when `top_traders_count` / `leaderboard_period` / `min_trader_volume` change (no more waiting for the hourly tick). New `POST /api/bot/refresh-leaderboard`.
- **Tracked Traders — exit-only mode**: trader dropout (auto via leaderboard refresh or manual via × button) no longer silently loses SELL-signals for their open positions. Trader is moved to `exit_only` state — still polled, but only SELL executed. Auto-deactivates once no linked positions remain. `DELETE /api/traders/:address` endpoint, UI: Remove button, profile link (polymarket.com/profile/X), Open pos. column, traders count in header, EXIT-ONLY badge. New columns: `tracked_traders.exit_only`.
- **Skipped trades persisted**: previously skipped results (risk check failed, slippage, max positions, etc.) were not saved to DB, so the dashboard didn't show why signals were being ignored. Now persisted with `error` field, tooltip on status-pill shows the reason.
- **Settings hot-reload expanded**: `reloadConfigFromDb` now covers `maxOpenPositions`, `minMarketLiquidity`, `redeemCheckIntervalMs`, `sellMode`. Settings form has new Max Open Positions & Min Market Liquidity fields.
- **P&L Chart fix**: snapshots now compute all-time P&L (was only today's); period axis uses hours/days properly (1H was effectively 24H before); x-axis ticks aligned to round times.
- **Demo Account mode**: dry-run upgraded to paper trading with virtual balance ($1000 default), 2% commission per trade, balance validation, `POST /api/demo/reset`, dashboard Demo Balance card, Fee column in Trade Log, Reset Demo button in Settings.
- **Polymarket API v1**: leaderboard endpoint migrated to `/v1/leaderboard` with updated params (`timePeriod`, `proxyWallet`, `vol`). Activity API: `usdcSize` field mapping fix that was blocking all trades.
- **Settings hot-reload**: `reloadConfigFromDb()` — UI settings (bet size, trader count, commission, dry run) now apply at runtime without server restart. Called on Save, bot start, and leaderboard refresh.
- **Wizard UX**: preflight returns `ready=true` in demo mode, wizard no longer blocks dashboard. Settings modal now has Trading/Wallet tabs — wallet connection accessible anytime.
- **Tracker fix**: `action` field case-sensitivity (`"SELL"` vs `"sell"`) corrected.
- **Positions: current prices**: `/api/positions` fetches live midpoint from CLOB API, calculates unrealized P&L per position.
- **P&L Chart**: switched from broken `/api/activity` source to `/api/pnl-history` (pnl_snapshots table).
- **Metrics fix**: P&L, win rate, and commission now include `simulated` trades (not just `filled`). Negative P&L sign displayed correctly.
- **Live Trade Feed**: populates with last 20 trades on page load (not only via SSE).
- **UI fixes**: bot start/stop button wired, form/wizard dark theme styles, chart infinite scroll fix.

---

## TODO — Manual Testing & Verification

### Smoke test (no wallet needed)
- [ ] `pnpm dev` → open http://localhost:3000
- [ ] Dashboard loads with dark theme
- [ ] Metric cards show zeros (no data yet)
- [ ] `curl localhost:3000/api/status` → returns JSON
- [ ] `curl localhost:3000/api/metrics` → returns JSON
- [ ] `curl localhost:3000/api/traders` → returns empty array
- [ ] Settings gear icon opens settings modal

### API wrappers (no wallet needed)
- [ ] Data API: leaderboard returns real trader data
- [ ] Data API: activity returns trade history for a trader
- [ ] Gamma API: market metadata returns correctly
- [ ] CLOB API: midpoint returns current price for a token

### Leaderboard & Tracker (no wallet needed)
- [ ] Start bot via `POST /api/bot/start` → leaderboard fetches top traders
- [ ] Traders appear in DB (`tracked_traders` table)
- [ ] Traders appear on dashboard
- [ ] Tracker polls and detects new trades in logs
- [ ] Trades appear in live feed (SSE)

### Dry Run mode (no wallet needed)
- [ ] Set `DRY_RUN=true` (default)
- [ ] When trader makes a trade → bot logs "DRY RUN: Would BUY..."
- [ ] Simulated trades appear in DB with `status=simulated`
- [ ] Simulated trades appear on dashboard trade log
- [ ] Positions appear (simulated)
- [ ] Metrics update (P&L, win rate, trade count)
- [ ] Risk manager blocks trades when daily limit exceeded

### SSE & Real-time (no wallet needed)
- [ ] Open dashboard in 2 browser tabs
- [ ] When trade occurs → both tabs update without refresh
- [ ] Balance in header updates via SSE
- [ ] P&L chart renders with period toggles (1H/24H/7D/30D/ALL)
- [ ] Live feed shows new trades in real-time

### Setup Wizard (needs wallet)
- [ ] First visit shows Setup Wizard
- [ ] Step 1: Enter private key → shows address + USDC/MATIC balances
- [ ] Step 2: Derive API Keys → "OK"
- [ ] Step 2: Approve USDC → tx hash shown
- [ ] Step 2: Approve CTF → tx hash shown
- [ ] Step 4: Preflight → all checks green
- [ ] Private key saved in `.env`, NOT accessible from browser
- [ ] Refresh page → wizard skipped, dashboard shown

### Real Trading (needs wallet + funds)
- [ ] Set `DRY_RUN=false`, `BET_SIZE_USD=1`
- [ ] Wait for trader trade → real order placed
- [ ] Order status: filled in logs
- [ ] Position visible on polymarket.com
- [ ] SELL works when trader sells

### Bot Lifecycle
- [ ] Click Stop → bot stops, indicator red
- [ ] Click Start → bot starts, indicator green
- [ ] Change BET_SIZE in Settings → applies without restart
- [ ] Ctrl+C → graceful shutdown, clean logs

### Telegram (needs bot token)
- [ ] Set `TELEGRAM_ENABLED=true`, token, chat ID
- [ ] Bot start → receive "Bot Started" message
- [ ] Trade copied → receive notification
- [ ] Bot stop → receive "Bot Stopped"

### Auto-Redeem (needs resolved positions)
- [ ] Bot checks for redeemable positions every 5 min
- [ ] If resolved market → auto-redeem tx sent
- [ ] Activity log shows redeem event

### Strategy Intelligence
- [ ] `curl localhost:3000/api/strategy/recommendations` → JSON
- [ ] `curl localhost:3000/api/strategy/performance` → JSON (empty until trades)
- [ ] `curl localhost:3000/api/strategy/anomalies` → JSON
- [ ] `curl localhost:3000/api/strategy/rotations` → JSON
- [ ] POST /api/backtest/run with traders → returns testId
- [ ] GET /api/backtest/status?id=... → shows progress
- [ ] GET /api/backtest/results → lists saved results
- [ ] Trader auto-rotation: underperforming dropped, new ones added with probation
- [ ] Anomaly: unusual trade size → Telegram alert (no auto-stop)

### Export
- [ ] `curl localhost:3000/api/export/trades` → downloads CSV
- [ ] CSV export button in dashboard trade log works

### Production
- [ ] `docker compose up` → bot starts in container
- [ ] Fresh install test: `git clone && pnpm install && cp .env.example .env && pnpm dev`
- [ ] 24h dry-run stability test: no crashes, no memory leaks
- [ ] Kill + restart: bot resumes from saved state (lastSeenTimestamp from DB)

---

## TODO — Known Improvements

- [ ] Frontend: backtest.js page (form + results UI) — API exists, no dedicated frontend page
- [x] WebSocket client skeleton implemented (`src/api/websocket-client.ts`); full user-activity WS blocked by Polymarket API limitations
- [ ] Unit/integration tests (vitest)
- [ ] Data API response field mapping validation (field names may differ from spec)
- [ ] Rate limiting tuning for Data API polling (currently 500ms between traders)

---

## Completed Stages (reference)

| Stage | Description | Commit |
|-------|-------------|--------|
| 0 | Bootstrap: repo, CLAUDE.md, .gitignore | `2820f7d` |
| 1 | Skeleton: types, config, DB (10 tables), logger | `dd23733` |
| 2 | API wrappers: Data API, Gamma API, CLOB | `39c7943` |
| 3+4 | Leaderboard scoring + Trade tracker | `128f6ec` |
| 5+7 | Dashboard (backend+frontend) + Executor (dry run) | `2c5117d` |
| 6+9 | Setup Wizard + SSE + Charts | `318c0da` |
| 8 | Real trading via CLOB API | `2db0aee` |
| 10 | Bot lifecycle + Auto-redeem + Telegram | `c071b88` |
| 11 | Strategy Intelligence (5 modules) | `0c5c0fe` |
| 12 | Error handling, Docker, README | `3a9bfa1` |
| fix | Express 5 wildcard route | `ef05834` |
