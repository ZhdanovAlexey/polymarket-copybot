# PolyMarket CopyBot PRO v2.0

Autonomous copy-trading bot for PolyMarket with professional web dashboard, strategy intelligence, and Telegram notifications.

## Features

- **Copy Trading** — automatically mirrors trades from top PolyMarket traders
- **Smart Scoring** — composite trader scoring (PnL 40%, win rate 25%, volume 15%, trades 10%, consistency 10%)
- **Risk Management** — daily loss limits, max drawdown, position limits, slippage control
- **Web Dashboard** — real-time dark-theme SPA with Chart.js analytics
- **Setup Wizard** — browser-based wallet setup, no terminal needed
- **Strategy Intelligence** — performance attribution, auto-rotation, backtesting, Kelly Criterion optimizer, anomaly detection
- **Telegram Notifications** — trade alerts, daily summaries, risk warnings
- **Dry Run Mode** — test strategies without real money
- **Auto-Redeem** — automatically claims winnings from resolved markets

## Quick Start

### Prerequisites
- Node.js 18+
- pnpm
- Polygon wallet with MATIC (gas) and USDC.e (trading)

### Installation

```bash
git clone https://github.com/ZhdanovAlexey/polymarket-copybot.git
cd polymarket-copybot
pnpm install
cp .env.example .env
pnpm dev
```

Open http://localhost:3000 — Setup Wizard will guide you through wallet connection.

### Docker

```bash
docker compose up -d
```

---

## Architecture

### High-level overview

```
                    ┌──────────────────────────────────────────────────┐
                    │                  Web Dashboard                    │
                    │  (Express + Vanilla HTML/CSS/JS + Chart.js)      │
                    │                                                   │
                    │  Setup Wizard ─── Settings ─── Trade Log         │
                    │  Metric Cards ─── P&L Chart ─── Positions        │
                    │  Trader Cards ─── Live Feed ─── Backtest UI      │
                    └────────────┬──────────────┬──────────────────────┘
                                 │  REST API     │  SSE (real-time)
                                 ▼              ▼
┌─────────────┐    ┌─────────────────────────────────────────────────┐
│ PolyMarket  │◄──►│                   Bot Core                      │
│ APIs        │    │                                                  │
│             │    │  ┌──────────┐  ┌─────────┐  ┌──────────────┐   │
│ Data API    │◄───│──│Leaderboard│─►│ Tracker │─►│  Executor    │   │
│ Gamma API   │    │  │(scoring)  │  │(polling)│  │(buy/sell)    │   │
│ CLOB API    │◄───│──│           │  │         │  │              │   │
│             │    │  └──────────┘  └────┬────┘  └──────┬───────┘   │
│ Polygon RPC │    │                     │              │            │
└─────────────┘    │              ┌──────▼──────┐ ┌─────▼────────┐  │
                   │              │ Anomaly     │ │ Risk Manager │  │
                   │              │ Detector    │ │ (limits,     │  │
                   │              │ (alerts)    │ │  slippage)   │  │
                   │              └─────────────┘ └──────────────┘  │
                   │                                                 │
                   │  ┌──────────────────────────────────────────┐  │
                   │  │           Strategy Layer                  │  │
                   │  │  Performance ── Rotation ── Optimizer     │  │
                   │  │  Backtester ── Anomaly Detector           │  │
                   │  └──────────────────────────────────────────┘  │
                   │                                                 │
                   │  ┌──────────┐  ┌───────────┐  ┌────────────┐  │
                   │  │Portfolio │  │ Redeemer  │  │  Telegram  │  │
                   │  │(positions)│  │(auto-claim)│  │(notify)    │  │
                   │  └──────┬───┘  └───────────┘  └────────────┘  │
                   └─────────┼──────────────────────────────────────┘
                             │
                    ┌────────▼────────┐
                    │   SQLite (DB)    │
                    │   10 tables      │
                    │   better-sqlite3 │
                    └──────────────────┘
```

### Data flow — trade lifecycle

```
1. Leaderboard.refresh()
   ├── Data API: GET /leaderboard → top traders
   ├── Data API: GET /trades/{addr} → win rate per trader
   ├── Score = PnL×0.4 + WinRate×0.25 + Volume×0.15 + Trades×0.1 + Consistency×0.1
   └── Save top N to DB (tracked_traders table)

2. Tracker.pollOnce() — every POLL_INTERVAL_MS (default 30s)
   ├── For each tracked trader:
   │   └── Data API: GET /activity?user={addr}&type=TRADE&start={lastTs}
   ├── Deduplicate by tx hash (Set + DB check)
   ├── Emit 'newTrade' event (DetectedTrade)
   └── Update lastSeenTimestamp in DB

3. Bot.handleNewTrade(trade)
   ├── AnomalyDetector.analyze(trade) → alert only (Telegram + SSE)
   ├── RiskManager.canTrade(trade)
   │   ├── Daily P&L limit check
   │   ├── Max open positions check
   │   └── Min trade size check
   ├── Executor.executeBuy/Sell(trade)
   │   ├── CLOB API: GET /midpoint → current price
   │   ├── RiskManager.checkSlippage(current, trader price)
   │   ├── If DRY_RUN: simulate, status='simulated'
   │   └── If REAL: ClobClient.createAndPostOrder() → poll status
   ├── Portfolio.updateAfterBuy/Sell(result)
   ├── DB: insertTrade(result)
   ├── SSE: broadcastEvent('trade', result)
   └── Telegram: notifyTradeCopied(result)
```

### Module structure

```
polymarket-copybot/
├── src/
│   ├── index.ts                         # Entry point: init DB, start dashboard, create Bot
│   ├── config.ts                        # dotenv + zod validation → AppConfig
│   ├── types.ts                         # ALL shared interfaces (contract for all modules)
│   │
│   ├── api/                             # External API wrappers
│   │   ├── data-api.ts                  # DataApi: leaderboard, activity, positions, trades
│   │   ├── gamma-api.ts                 # GammaApi: market metadata, events
│   │   └── clob-client.ts              # ClobClientWrapper (public) + initClobClientWithAuth()
│   │
│   ├── core/                            # Business logic
│   │   ├── bot.ts                       # Bot orchestrator: start/stop, wire all subsystems
│   │   ├── leaderboard.ts              # Fetch + score + filter traders
│   │   ├── tracker.ts                  # Poll trader activity, emit newTrade events
│   │   ├── executor.ts                 # Execute BUY/SELL (dry-run + real via CLOB)
│   │   ├── risk-manager.ts            # Daily limit, max positions, slippage, liquidity
│   │   ├── portfolio.ts               # Track positions, update after trades
│   │   ├── redeemer.ts                # Auto-redeem resolved markets via CTF contract
│   │   └── strategy/                   # Strategy intelligence
│   │       ├── performance.ts          # P&L attribution per trader, auto-drop
│   │       ├── rotation.ts            # Periodic trader rotation with probation
│   │       ├── backtest.ts            # Historical simulation engine
│   │       ├── optimizer.ts           # Kelly Criterion, adaptive slippage, drawdown scaling
│   │       └── anomaly.ts            # Detect unusual trade patterns (alerts only)
│   │
│   ├── dashboard/                       # Web UI
│   │   ├── server.ts                   # Express app: static files, route mounting
│   │   ├── routes/
│   │   │   ├── api.ts                  # REST: status, traders, trades, metrics, settings, bot control
│   │   │   ├── auth.ts                # Wallet connect, derive keys, approve, preflight
│   │   │   ├── sse.ts                 # Server-Sent Events: broadcastEvent()
│   │   │   ├── backtest.ts           # Async backtest run + status + results
│   │   │   └── export.ts             # CSV export
│   │   └── public/
│   │       ├── index.html             # SPA with all sections
│   │       ├── css/styles.css         # Dark theme (CSS vars)
│   │       └── js/
│   │           ├── app.js             # Main: init, refresh loop, positions
│   │           ├── dashboard.js       # 4 metric cards
│   │           ├── traders.js         # Trader cards
│   │           ├── trades.js          # Trade log table with search/filter
│   │           ├── charts.js          # Chart.js P&L timeline
│   │           ├── sse-client.js      # EventSource with auto-reconnect
│   │           └── settings.js        # Setup Wizard (4 steps) + settings modal
│   │
│   ├── db/                              # SQLite layer
│   │   ├── database.ts                 # Singleton, init, close
│   │   ├── migrations.ts              # 10 tables (CREATE IF NOT EXISTS)
│   │   └── queries.ts                 # Typed wrappers for all tables
│   │
│   ├── notifications/
│   │   └── telegram.ts                # 8 notification templates (HTML format)
│   │
│   └── utils/
│       ├── logger.ts                   # pino: console + file, child logger factory
│       ├── retry.ts                    # Exponential backoff with 429/5xx handling
│       └── helpers.ts                  # formatUsd, sleep, generateId, shortenAddress
│
├── scripts/
│   └── check-balance.ts                # CLI: show wallet MATIC + USDC balances
├── data/                                # Runtime: copybot.db, copybot.log (gitignored)
├── Dockerfile
├── docker-compose.yml
└── POLYMARKET_COPYBOT_TZ.md           # Original specification (v2.0)
```

### Database schema (SQLite, 10 tables)

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `settings` | Key-value config store | key, value |
| `tracked_traders` | Monitored traders + scores | address, score, pnl, win_rate, probation |
| `trades` | All bot trades | side, status (filled/simulated/failed/skipped), is_dry_run |
| `positions` | Open positions | token_id, total_shares, avg_price, status |
| `pnl_snapshots` | Periodic P&L for charts | total_pnl, realized, unrealized |
| `activity_log` | Audit trail | type (trade/redeem/start/stop/error), message |
| `trader_performance` | P&L attribution per trader per day | wins, losses, total_pnl, slippage_avg |
| `rotation_log` | Trader swap history | old_trader, new_trader, reason |
| `backtest_results` | Saved backtest runs | config (JSON), equity_curve (JSON), sharpe |
| `anomaly_log` | Detected anomalies | type (size/market/frequency), severity |

### API endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Bot status, uptime, version |
| `/api/traders` | GET | Active tracked traders |
| `/api/trades?limit=&offset=&status=` | GET | Trade history with filters |
| `/api/metrics` | GET | P&L, win rate, trade counts |
| `/api/positions` | GET | Open positions |
| `/api/pnl-history?period=` | GET | P&L snapshots for chart |
| `/api/activity?type=&limit=` | GET | Activity log |
| `/api/bot/start` | POST | Start the bot |
| `/api/bot/stop` | POST | Stop the bot |
| `/api/settings` | GET/POST | Read/write bot settings |
| `/api/auth/connect-wallet` | POST | Submit private key, get address + balances |
| `/api/auth/derive-keys` | POST | Derive CLOB API credentials |
| `/api/auth/approve-usdc` | POST | Approve USDC spending |
| `/api/auth/approve-ctf` | POST | Approve CTF token transfers |
| `/api/auth/preflight` | GET | Pre-launch readiness check |
| `/api/auth/balance` | GET | Current USDC + MATIC balances |
| `/api/sse` | GET | Server-Sent Events stream |
| `/api/backtest/run` | POST | Start async backtest |
| `/api/backtest/status?id=` | GET | Backtest progress |
| `/api/backtest/results` | GET | List saved backtests |
| `/api/backtest/result/:id` | GET | Single backtest result |
| `/api/strategy/recommendations` | GET | Optimizer suggestions |
| `/api/strategy/anomalies` | GET | Anomaly alerts |
| `/api/strategy/performance` | GET | Per-trader performance |
| `/api/strategy/rotations` | GET | Trader rotation history |
| `/api/export/trades` | GET | CSV download |

### Technology stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (ESM, strict) |
| Runtime | Node.js 18+ |
| Package manager | pnpm |
| Trading SDK | @polymarket/clob-client + ethers v5 |
| Web server | Express 5 |
| Real-time | Server-Sent Events (SSE) |
| Frontend | Vanilla HTML/CSS/JS (no framework) |
| Charts | Chart.js (CDN) |
| Database | SQLite via better-sqlite3 |
| Logging | pino + pino-pretty |
| Config | dotenv + zod validation |
| Notifications | node-telegram-bot-api |

### Smart contracts (Polygon)

| Contract | Address |
|----------|---------|
| CTF Exchange | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` |
| Neg Risk Exchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |
| CTF (Conditional Tokens) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| Neg Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` |

---

## Configuration

See `.env.example` for all options. Key settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `DRY_RUN` | `true` | Simulate trades without money |
| `BET_SIZE_USD` | `5` | Amount per copied trade |
| `TOP_TRADERS_COUNT` | `10` | How many traders to track |
| `POLL_INTERVAL_MS` | `30000` | How often to check for new trades |
| `MAX_SLIPPAGE_PCT` | `5` | Max allowed slippage % |
| `DAILY_LOSS_LIMIT_USD` | `50` | Stop bot if daily loss exceeds |
| `MAX_OPEN_POSITIONS` | `10` | Position limit |
| `DASHBOARD_PORT` | `3000` | Web UI port |

## License

MIT
