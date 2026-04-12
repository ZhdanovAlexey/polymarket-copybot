# CLAUDE.md — PolyMarket CopyBot PRO

## Project
Autonomous copy-trading bot for PolyMarket with professional web dashboard.
TypeScript + Node.js 18+ ESM. Spec: `POLYMARKET_COPYBOT_TZ.md`.

## Commands
```
pnpm dev          # Run via tsx (dev mode)
pnpm build        # Compile TypeScript
pnpm start        # Run compiled JS
pnpm lint         # ESLint
pnpm format       # Prettier
```

## Architecture

### Module layers
1. `src/api/` — External API wrappers (Data API, Gamma API, CLOB client)
2. `src/core/` — Business logic (leaderboard, tracker, executor, risk-manager, portfolio, redeemer, bot)
3. `src/core/strategy/` — Strategy intelligence (performance, rotation, backtest, optimizer, anomaly)
4. `src/dashboard/` — Express server, routes (api, auth, sse, backtest), public static files
5. `src/db/` — SQLite database, migrations, queries
6. `src/notifications/` — Telegram
7. `src/utils/` — Logger (pino), retry, helpers

### Data flow
```
Leaderboard → Tracker (polling) → AnomalyDetector → RiskManager → Executor → Portfolio → DB → Dashboard (SSE)
                                                                                    ↓
                                                              PerformanceTracker → Rotation → Optimizer
```

## Conventions
- ESM (`"type": "module"` in package.json), use `.js` extensions in imports
- Module system: NodeNext (tsconfig)
- Logging: pino with child loggers per module
- Config: dotenv + zod validation (`src/config.ts`)
- DB: SQLite via better-sqlite3, synchronous API
- API: ethers v5 Wallet for signing, @polymarket/clob-client v5 for CLOB
- Frontend: Vanilla HTML/CSS/JS, Chart.js via CDN, dark theme
- Private keys: NEVER logged, NEVER sent to frontend, stored only in `.env`
- All monetary values in USD, prices 0-1 range
- Shared types contract: `src/types.ts` — all interfaces for cross-module communication

## Key API Details
- Data API: `https://data-api.polymarket.com` — leaderboard, activity, positions, trades
- Gamma API: `https://gamma-api.polymarket.com` — market metadata
- CLOB API: `https://clob.polymarket.com` — trading, `GET /book` returns `tick_size` and `neg_risk`
- CLOB client accepts ethers Wallet as ClobSigner

## Smart Contracts (Polygon)
- CTF Exchange: `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
- Neg Risk Exchange: `0xC5d563A36AE78145C45a50134d48A1215220f80a`
- CTF (Conditional Tokens): `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`
- USDC.e: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`
- Neg Risk Adapter: `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`
