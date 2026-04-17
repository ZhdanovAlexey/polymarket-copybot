# Multi-Bot Runner: Parallel Strategy Testing

## Goal

Run 4-5 demo bots simultaneously, each with different strategy configurations (bet sizing, stop-loss, trader selection, exit strategies). Compare results on a unified dashboard to identify the best strategy for live trading.

## Architecture

Multiprocess: each bot is a separate Node.js process with its own SQLite database. An orchestrator process manages lifecycle and provides a comparison dashboard.

```
orchestrator (:3000)          — comparison dashboard + process management
  ├── bot-aggressive (:3001)  — own DB, own dashboard
  ├── bot-conservative (:3002)
  ├── bot-top10 (:3003)
  ├── bot-mirror (:3004)
  └── bot-wide (:3005)
```

## Components

### 1. Bot Config Profiles (`configs/`)

Each bot is defined by a JSON file with only the settings that differ from defaults.

```
configs/
  aggressive.json
  conservative.json
  top10.json
  mirror.json
```

Example `aggressive.json`:
```json
{
  "name": "aggressive",
  "port": 3001,
  "settings": {
    "bet_size_usd": "5",
    "max_single_bet_usd": "10",
    "stop_loss_mode": "disabled",
    "top_traders_count": "5",
    "max_slippage_pct": "20",
    "sell_mode": "take_profit",
    "take_profit_pct": "40",
    "demo_initial_balance": "200"
  }
}
```

Example `conservative.json`:
```json
{
  "name": "conservative",
  "port": 3002,
  "settings": {
    "bet_size_usd": "2",
    "max_single_bet_usd": "3",
    "stop_loss_mode": "both",
    "stop_loss_pct": "10",
    "trailing_stop_pct": "8",
    "top_traders_count": "3",
    "max_slippage_pct": "10",
    "sell_mode": "mirror",
    "demo_initial_balance": "200"
  }
}
```

### 2. Changes to Existing Bot Code

Minimal modifications so each process knows its identity:

**Environment variables read at startup:**
- `BOT_NAME` — human-readable name (e.g., "aggressive")
- `BOT_PORT` — dashboard port (default: 3000)
- `BOT_DATA_DIR` — path to data directory (default: `data/`)
- `BOT_CONFIG` — path to JSON config override file

**Files changed:**
- `src/config.ts` — read `BOT_PORT`, `BOT_DATA_DIR`, `BOT_CONFIG`; apply JSON overrides to settings on startup
- `src/db/database.ts` — use `BOT_DATA_DIR` for DB path instead of hardcoded `data/copybot.db`
- `src/dashboard/server.ts` — use `BOT_PORT` for listening port
- `src/index.ts` — apply config overrides from JSON file to settings table before starting bot

**No changes to:** bot.ts, executor.ts, portfolio.ts, tracker.ts, redeemer.ts, or any trading logic.

### 3. Orchestrator (`src/orchestrator.ts`)

New entry point. Does NOT run any trading logic.

**Responsibilities:**
- Reads all `configs/*.json` files
- For each, spawns a child process via `child_process.fork('src/index.ts')` with env vars
- Creates data directory per bot (`data/<bot-name>/`)
- Monitors child processes: restart on crash (max 3 restarts, then give up)
- Runs Express on `:3000` with comparison dashboard

**API endpoints:**
- `GET /api/bots` — list of bots with name, port, pid, status (running/stopped/crashed)
- `GET /api/comparison` — aggregated metrics from all bots (fetches `/api/metrics` from each)
- `POST /api/bots/:name/start` — start a bot
- `POST /api/bots/:name/stop` — stop a bot
- `POST /api/bots/:name/restart` — restart a bot
- `GET /api/bots/:name/settings` — proxy to bot's `GET /api/settings`
- `POST /api/bots/:name/settings` — proxy to bot's `POST /api/settings`
- `POST /api/bots/:name/bot/start` — proxy to bot's `POST /api/bot/start` (start trading)
- `POST /api/bots/:name/bot/stop` — proxy to bot's `POST /api/bot/stop` (stop trading)

Orchestrator proxies settings and bot-control requests to the target bot's HTTP API. No direct DB access to bot databases — all interaction through existing APIs.

**Metrics collection:**
Every 30 seconds, fetches `http://localhost:<port>/api/metrics` from each running bot. Caches last result per bot.

### 4. Comparison Dashboard (Frontend)

Single HTML page served by orchestrator on `:3000`.

**Content:**
- **Summary table:** one row per bot with columns:
  - Name, Status (running/stopped), Total PnL, Realized PnL, Unrealized PnL, Win Rate, Open Positions, Balance, Today PnL, Total Trades, Commission
  - Row color: green if PnL > 0, red if < 0
  - Click row → expands bot detail panel (see below)

- **PnL comparison chart:** line chart with one line per bot, showing total PnL over time. Orchestrator fetches `/api/pnl-history?period=24h` from each bot's API and overlays the series on one Chart.js canvas.

- **Bot detail panel** (expands on row click):
  - **Settings editor:** loads bot's current settings via `GET /api/bots/:name/settings`, renders same Settings form as individual dashboard. Save → `POST /api/bots/:name/settings`. Hot-reloads on the bot without restart.
  - **Bot controls:** Start Trading / Stop Trading buttons (proxied to bot's `/api/bot/start` and `/api/bot/stop`)
  - **Quick link:** "Open full dashboard" → opens bot's own dashboard in new tab (`http://localhost:<port>`)

- **Process controls (top bar):**
  - Start/Stop/Restart process buttons per bot (manages the Node.js process itself)
  - "Start All" / "Stop All" buttons

**Auto-refresh:** every 30 seconds via fetch, same as existing dashboard pattern.

### 5. Data Isolation

Each bot stores data in its own directory:
```
data/
  aggressive/
    copybot.db
    copybot.log
  conservative/
    copybot.db
    copybot.log
  ...
```

No shared state. Bots are fully independent.

### 6. Startup Flow

```
pnpm orchestrator
  ↓
  1. Read configs/*.json
  2. For each config:
     a. Create data/<name>/ if not exists
     b. Fork child process with env:
        BOT_NAME=<name>
        BOT_PORT=<port>
        BOT_DATA_DIR=data/<name>/
        BOT_CONFIG=configs/<name>.json
     c. Child process starts normally:
        - Runs migrations on its own DB
        - Applies settings from JSON config
        - Starts dashboard on its port
        - Bot starts in idle mode (needs manual start via UI)
  3. Start orchestrator Express on :3000
```

### 7. CLI Usage

```bash
# Start all bots via orchestrator
pnpm orchestrator

# Or run a single bot with a specific config
BOT_CONFIG=configs/aggressive.json BOT_PORT=3001 BOT_DATA_DIR=data/aggressive pnpm dev
```

## Files to Create

| File | Purpose |
|------|---------|
| `src/orchestrator.ts` | Process manager + comparison API |
| `src/orchestrator-dashboard/` | Comparison dashboard HTML/CSS/JS |
| `configs/aggressive.json` | Example aggressive config |
| `configs/conservative.json` | Example conservative config |
| `configs/top10.json` | Example wide trader pool config |
| `configs/mirror.json` | Example mirror-only config |

## Files to Modify

| File | Change |
|------|--------|
| `src/config.ts` | Read `BOT_CONFIG` env, apply JSON overrides |
| `src/db/database.ts` | Use `BOT_DATA_DIR` env for DB path |
| `src/dashboard/server.ts` | Use `BOT_PORT` env |
| `src/index.ts` | Apply config overrides from JSON before bot start |
| `package.json` | Add `"orchestrator"` script |

## What Does NOT Change

All trading logic remains untouched:
- bot.ts, executor.ts, portfolio.ts, tracker.ts, redeemer.ts
- risk-manager.ts, stop-loss-monitor.ts, leaderboard.ts
- All strategy modules (conviction, rotation, anomaly, etc.)
- Per-bot dashboard (index.html, app.js, trades.js, etc.)

## Error Handling

- Bot crash → orchestrator logs error, waits 5s, restarts (max 3 times)
- Bot unreachable for metrics → show "unreachable" in comparison table
- Orchestrator crash → bots keep running (they're independent processes)
- Orchestrator restart → re-discovers running bots by checking ports

## Testing

1. `npx tsc --noEmit` — 0 errors
2. `pnpm orchestrator` — starts 4 bots + comparison dashboard
3. Each bot dashboard accessible on its port
4. Comparison page on `:3000` shows all bots with live metrics
5. Start/stop individual bots from comparison page
6. Kill a bot process → orchestrator restarts it
7. Each bot trades independently with its own config
