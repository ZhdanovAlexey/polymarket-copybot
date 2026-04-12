# PolyMarket CopyBot PRO v2.0

Autonomous copy-trading bot for PolyMarket with professional web dashboard, strategy intelligence, and Telegram notifications.

## Features

- **Copy Trading**: Automatically mirrors trades from top PolyMarket traders
- **Smart Scoring**: Composite trader scoring (PnL, win rate, volume, consistency)
- **Risk Management**: Daily loss limits, max drawdown, position limits, slippage control
- **Web Dashboard**: Real-time dark-theme UI with Chart.js analytics
- **Setup Wizard**: Browser-based wallet setup (no terminal needed)
- **Strategy Intelligence**:
  - Performance attribution per trader
  - Auto-rotation of underperforming traders
  - Historical backtesting engine
  - Parameter optimization (Kelly Criterion)
  - Anomaly detection with alerts
- **Telegram Notifications**: Trade alerts, daily summaries, risk warnings
- **Dry Run Mode**: Test strategies without real money
- **Auto-Redeem**: Automatically claims winnings from resolved markets

## Quick Start

### Prerequisites
- Node.js 18+
- pnpm
- A Polygon wallet with MATIC (for gas) and USDC.e (for trading)

### Installation

```bash
git clone https://github.com/ZhdanovAlexey/polymarket-copybot.git
cd polymarket-copybot
pnpm install
cp .env.example .env
```

### Running

```bash
# Development mode
pnpm dev

# Production
pnpm build && pnpm start
```

Open http://localhost:3000 — the Setup Wizard will guide you through wallet connection and configuration.

### Docker

```bash
docker compose up -d
```

## Architecture

```
src/
├── api/        — API wrappers (Data, Gamma, CLOB)
├── core/       — Business logic (bot, leaderboard, tracker, executor, portfolio, risk manager)
│   └── strategy/ — Strategy intelligence (performance, rotation, backtest, optimizer, anomaly)
├── dashboard/  — Express server + vanilla HTML/CSS/JS frontend
├── db/         — SQLite database layer
├── notifications/ — Telegram
└── utils/      — Logger, retry, helpers
```

## Configuration

See `.env.example` for all available options. Key settings:
- `DRY_RUN=true` — Start in simulation mode (recommended)
- `BET_SIZE_USD=5` — Amount per trade
- `TOP_TRADERS_COUNT=10` — Number of traders to track
- `DAILY_LOSS_LIMIT_USD=50` — Stop bot if daily loss exceeds this

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Bot status |
| `/api/traders` | GET | Tracked traders |
| `/api/trades` | GET | Trade history |
| `/api/metrics` | GET | P&L metrics |
| `/api/positions` | GET | Open positions |
| `/api/bot/start` | POST | Start bot |
| `/api/bot/stop` | POST | Stop bot |
| `/api/settings` | GET/POST | Bot settings |
| `/api/backtest/run` | POST | Run backtest |
| `/api/strategy/recommendations` | GET | Optimizer recommendations |
| `/api/strategy/anomalies` | GET | Anomaly alerts |
| `/api/export/trades` | GET | CSV export |

## License

MIT
