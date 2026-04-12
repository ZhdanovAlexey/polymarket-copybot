# STATUS — PolyMarket CopyBot PRO

> Last updated: 2026-04-12

---

## Code Implementation — DONE

All 12 stages implemented. 40 source files, ~16.5k lines. TypeScript compiles with 0 errors.
`pnpm dev` starts successfully, dashboard serves on :3000, API responds, graceful shutdown works.

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
- [ ] WebSocket real-time tracking (optional, polling works fine)
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
