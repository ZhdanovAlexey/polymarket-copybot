<p align="center">
  <h1 align="center">PolyMarket CopyBot PRO</h1>
  <p align="center">
    Autonomous copy-trading bot for <a href="https://polymarket.com">Polymarket</a> prediction markets<br/>
    with a real-time web dashboard, strategy intelligence, and Telegram alerts
  </p>
  <p align="center">
    <a href="#quick-start">Quick Start</a> &bull;
    <a href="#features">Features</a> &bull;
    <a href="#architecture">Architecture</a> &bull;
    <a href="#configuration">Configuration</a> &bull;
    <a href="#api-reference">API</a>
  </p>
  <p align="center">
    <img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg"/>
    <img alt="Node" src="https://img.shields.io/badge/node-18%2B-brightgreen.svg"/>
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-blue.svg"/>
    <img alt="Polygon" src="https://img.shields.io/badge/chain-Polygon-8247e5.svg"/>
  </p>
</p>

---

## What is this?

CopyBot monitors the top-performing traders on Polymarket, scores them with a composite algorithm, and automatically mirrors their trades in real time. It ships with a full-featured dark-theme dashboard for monitoring P&L, managing positions, and tuning strategy parameters — no terminal needed after initial setup.

**Demo mode** is enabled by default: paper-trade with a virtual balance to evaluate the system risk-free before connecting a real wallet.

> **Disclaimer:** This software is provided for educational and research purposes. Trading prediction markets involves financial risk. Use at your own discretion and never trade with funds you cannot afford to lose.

---

## Features

| Category | Details |
|---|---|
| **Copy Trading** | Mirrors BUY/SELL from top-N traders. Proportional or fixed bet sizing. Exit-only mode for dropped traders. |
| **Trader Scoring** | Composite: PnL 40% + Win Rate 25% + Volume 15% + Trades 10% + Consistency 10%. Negative PnL uses signed-log penalty. |
| **Risk Management** | Daily loss limit, max drawdown (EWMA-adaptive), position limits, slippage control, concentration checks, stop-loss (fixed + trailing). |
| **Strategy Layer** | Performance attribution, auto-rotation with probation, backtesting engine, Kelly Criterion optimizer, anomaly detection, adaptive weights, correlation filter. |
| **Web Dashboard** | Real-time SPA: P&L chart, open/closed positions, trader leaderboard, trade log with search/filter, settings modal, setup wizard. |
| **Demo Account** | Virtual balance, simulated commissions, market redemption, full reset — identical UX to live mode. |
| **Auto-Redeem** | Automatically claims winnings when markets resolve (on-chain in live mode, simulated in demo). |
| **Telegram** | Trade alerts, daily P&L summaries, risk warnings, anomaly notifications. |
| **Execution** | TWAP slicing, liquidity depth checks, trade queue with dedup and TTL, adaptive slippage. |

---

## Quick Start

### Prerequisites

- **Node.js 18+** and **pnpm**
- For live trading: a Polygon wallet with MATIC (gas) and USDC.e (trading capital)

### Install & Run

```bash
git clone https://github.com/ZhdanovAlexey/polymarket-copybot.git
cd polymarket-copybot
pnpm install
cp .env.example .env
pnpm dev
```

Open **http://localhost:3000** — the Setup Wizard will guide you through configuration.

Demo mode is on by default (`DRY_RUN=true`). No wallet needed to try it out.

### Docker

```bash
docker compose up -d
```

Dashboard will be available on port 3000. Data persists in `./data/`.

### Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Run in development mode (tsx), dashboard on :3000 |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run compiled JS (production) |

---

## Architecture

### System Overview

```
                    +--------------------------------------------------+
                    |                  Web Dashboard                    |
                    |  Express + Vanilla HTML/CSS/JS + Chart.js        |
                    |                                                   |
                    |  Setup Wizard --- Settings --- Trade Log          |
                    |  Metric Cards --- P&L Chart --- Positions         |
                    |  Trader Board --- Live Feed --- Backtest UI       |
                    +--------+-----------------------+-----------------+
                             |  REST API             |  SSE (real-time)
                             v                       v
+---------------+  +---------------------------------------------------+
| Polymarket    |  |                   Bot Core                        |
| APIs          |  |                                                   |
|               |  |  Leaderboard ---> Tracker ---> Executor           |
| Data API    <-+--+  (scoring)        (polling)    (buy/sell)         |
| Gamma API     |  |                      |              |             |
| CLOB API    <-+--+                      v              v             |
|               |  |              Anomaly Detector  Risk Manager       |
| Polygon RPC   |  |                                                   |
+---------------+  |  Strategy Layer                                   |
                   |    Performance | Rotation | Optimizer | Backtest  |
                   |                                                   |
                   |  Portfolio --- Redeemer --- Telegram               |
                   +----------+------------------------------------+---+
                              |                                    |
                     +--------v--------+              +------------v--+
                     |   SQLite (DB)   |              | Polygon Chain |
                     |   20 tables     |              | (live mode)   |
                     +--+--------------+              +---------------+
```

### Trade Lifecycle

```
1. Leaderboard.refresh()
   +-- Data API: fetch top traders
   +-- Score = PnL*0.4 + WinRate*0.25 + Volume*0.15 + Trades*0.1 + Consistency*0.1
   +-- Save top N to DB

2. Tracker.pollOnce()  (every 30-60s)
   +-- For each tracked trader: fetch recent activity
   +-- Dedup by tx hash
   +-- Emit 'newTrade' event

3. Bot.handleNewTrade()
   +-- Anomaly check (alert only)
   +-- Risk checks (daily limit, max positions, drawdown, concentration)
   +-- Execute via CLOB API (or simulate in demo mode)
   +-- Update portfolio, notify via SSE + Telegram
```

### Project Structure

```
src/
  index.ts                  Entry point
  config.ts                 dotenv + zod validation
  types.ts                  Shared interfaces

  api/
    data-api.ts             Polymarket Data API (public)
    gamma-api.ts            Polymarket Gamma API (public)
    clob-client.ts          CLOB API wrapper + auth

  core/
    bot.ts                  Orchestrator: start/stop, wire subsystems
    leaderboard.ts          Fetch + score + rank traders
    tracker.ts              Poll trader activity, emit events
    executor.ts             Execute BUY/SELL (demo + live)
    risk-manager.ts         Limits, slippage, drawdown checks
    portfolio.ts            Position tracking, mark-to-market
    redeemer.ts             Auto-redeem resolved markets
    stop-loss-monitor.ts    Fixed + trailing stop-loss
    drawdown-monitor.ts     Rolling drawdown with EWMA
    health-checker.ts       CLOB ping, circuit breaker
    execution/
      trade-queue.ts        Concurrency-limited queue with dedup
      twap.ts               TWAP slicing with drift guard
      liquidity.ts          Order-book depth, adaptive slippage
    strategy/
      performance.ts        P&L attribution per trader
      rotation.ts           Periodic trader rotation
      backtest.ts           Historical simulation engine
      optimizer.ts          Kelly Criterion parameter tuning
      anomaly.ts            Unusual trade pattern detection
      adaptive-weights.ts   EWMA-based weight recalculation
      correlation.ts        Pairwise correlation filter
      conviction-store.ts   Conviction-based bet sizing

  dashboard/
    server.ts               Express: compression, static, routes
    routes/
      api.ts                REST endpoints (batch-optimized)
      auth.ts               Wallet setup flow
      sse.ts                Server-Sent Events
      backtest.ts           Async backtest runner
      export.ts             CSV export
    public/                 Vanilla HTML/CSS/JS frontend

  db/
    database.ts             SQLite singleton (better-sqlite3)
    migrations.ts           20 tables, indexed
    queries.ts              Typed query wrappers

  notifications/
    telegram.ts             8 notification templates
```

---

## Configuration

All settings are configurable via `.env`, the web dashboard Settings panel, or the Setup Wizard.

See [`.env.example`](.env.example) for the full list. Key settings:

| Variable | Default | Description |
|---|---|---|
| `DRY_RUN` | `true` | Demo mode (paper trading) |
| `BET_SIZE_USD` | `5` | Amount per copied trade |
| `TOP_TRADERS_COUNT` | `10` | Number of traders to track |
| `POLL_INTERVAL_MS` | `30000` | Trade check interval (ms) |
| `MAX_SLIPPAGE_PCT` | `5` | Max allowed slippage % |
| `DAILY_LOSS_LIMIT_USD` | `50` | Daily loss limit |
| `MAX_OPEN_POSITIONS` | `10` | Position limit |
| `DASHBOARD_PORT` | `3000` | Web UI port |
| `TELEGRAM_ENABLED` | `false` | Enable Telegram notifications |

---

## API Reference

All endpoints are prefixed with `/api`.

### Bot Control

| Endpoint | Method | Description |
|---|---|---|
| `/status` | GET | Bot status, uptime, version, demo balance |
| `/bot/start` | POST | Start the bot |
| `/bot/stop` | POST | Stop the bot |
| `/bot/refresh-leaderboard` | POST | Force leaderboard refresh |
| `/demo/reset` | POST | Reset demo account |

### Data

| Endpoint | Method | Description |
|---|---|---|
| `/traders` | GET | Active + exit-only traders |
| `/traders/analytics` | GET | Per-trader stats (My Leaderboard) |
| `/trades?limit=&offset=&status=` | GET | Trade history with filters |
| `/metrics` | GET | P&L, win rate, trade counts |
| `/positions` | GET | Open positions (cached prices) |
| `/positions/closed?limit=` | GET | Closed position round-trips |
| `/pnl-history?period=` | GET | P&L snapshots for chart |
| `/activity?type=&limit=` | GET | Activity log |

### Wallet Setup

| Endpoint | Method | Description |
|---|---|---|
| `/auth/connect-wallet` | POST | Submit private key |
| `/auth/derive-keys` | POST | Derive CLOB API credentials |
| `/auth/approve-usdc` | POST | Approve USDC spending |
| `/auth/approve-ctf` | POST | Approve CTF transfers |
| `/auth/preflight` | GET | Pre-launch readiness check |
| `/auth/balance` | GET | Wallet balances |

### Strategy

| Endpoint | Method | Description |
|---|---|---|
| `/strategy/recommendations` | GET | Optimizer suggestions |
| `/strategy/anomalies` | GET | Anomaly alerts |
| `/strategy/performance` | GET | Per-trader performance |
| `/strategy/rotations` | GET | Rotation history |
| `/conviction-params` | GET/POST | Conviction scoring parameters |

### Other

| Endpoint | Method | Description |
|---|---|---|
| `/settings` | GET/POST | Read/write bot settings |
| `/sse` | GET | Server-Sent Events stream |
| `/backtest/run` | POST | Start async backtest |
| `/backtest/results` | GET | Saved backtest results |
| `/export/trades` | GET | CSV download |

---

## Tech Stack

| Component | Technology |
|---|---|
| Language | TypeScript (ESM, strict mode) |
| Runtime | Node.js 18+ |
| Web Server | Express 5 |
| Database | SQLite via better-sqlite3 |
| Frontend | Vanilla HTML/CSS/JS, Chart.js |
| Real-time | Server-Sent Events (SSE) |
| Trading | @polymarket/clob-client + ethers v5 |
| Chain | Polygon (MATIC) |
| Notifications | Telegram (node-telegram-bot-api) |
| Config | dotenv + zod validation |
| Logging | pino |

---

## Database

20 tables in SQLite. Key ones:

| Table | Purpose |
|---|---|
| `settings` | Key-value config store |
| `tracked_traders` | Monitored traders with scores |
| `trades` | All executed/simulated trades |
| `positions` | Open + closed positions |
| `pnl_snapshots` | Periodic snapshots for P&L chart |
| `trader_performance` | Per-trader daily P&L attribution |
| `rotation_log` | Trader swap history |
| `anomaly_log` | Detected anomalies |
| `markets_cache` | Cached market metadata |
| `conviction_params` | Conviction scoring state |

---

## Smart Contracts (Polygon Mainnet)

| Contract | Address |
|---|---|
| CTF Exchange | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` |
| Neg Risk Exchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |
| Conditional Tokens | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| Neg Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` |

---

## License

[MIT](LICENSE)
