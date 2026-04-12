import dotenv from 'dotenv';
import { z } from 'zod';
import type { AppConfig } from './types.js';

dotenv.config();

const configSchema = z.object({
  // Wallet
  privateKey: z.string().default(''),
  funderAddress: z.string().default(''),
  signatureType: z.coerce.number().default(0),

  // API Credentials
  clobApiKey: z.string().default(''),
  clobSecret: z.string().default(''),
  clobPassphrase: z.string().default(''),

  // Endpoints
  clobHost: z.string().default('https://clob.polymarket.com'),
  dataApiHost: z.string().default('https://data-api.polymarket.com'),
  gammaApiHost: z.string().default('https://gamma-api.polymarket.com'),
  polygonRpcUrl: z.string().default('https://polygon-rpc.com'),

  // Trading
  betSizeUsd: z.coerce.number().default(5),
  pollIntervalMs: z.coerce.number().default(30000),
  leaderRefreshIntervalMs: z.coerce.number().default(3600000),
  topTradersCount: z.coerce.number().default(10),
  leaderboardPeriod: z.string().default('7d'),
  redeemCheckIntervalMs: z.coerce.number().default(300000),
  maxSlippagePct: z.coerce.number().default(5),
  sellMode: z.string().default('mirror'),
  dryRun: z.coerce.boolean().default(true),

  // Risk
  dailyLossLimitUsd: z.coerce.number().default(50),
  maxDrawdownPct: z.coerce.number().default(20),
  maxOpenPositions: z.coerce.number().default(10),
  minMarketLiquidity: z.coerce.number().default(1000),
  minTraderVolume: z.coerce.number().default(0),

  // Dashboard
  dashboardPort: z.coerce.number().default(3000),

  // Telegram
  telegramToken: z.string().default(''),
  telegramChatId: z.string().default(''),
  telegramEnabled: z.coerce.boolean().default(false),
  telegramNotifyTrades: z.coerce.boolean().default(true),
  telegramNotifyErrors: z.coerce.boolean().default(true),
  telegramDailySummary: z.coerce.boolean().default(true),

  // Logging
  logLevel: z.string().default('info'),

  // Strategy
  traderRotationIntervalHours: z.coerce.number().default(6),
  probationTrades: z.coerce.number().default(5),
  autoDropLossThreshold: z.coerce.number().default(-10),
  anomalySizeMultiplier: z.coerce.number().default(3),
  backtestDefaultPeriodDays: z.coerce.number().default(30),
  optimizerAutoApply: z.coerce.boolean().default(false),
});

function loadConfig(): AppConfig {
  const env = {
    privateKey: process.env.PRIVATE_KEY,
    funderAddress: process.env.FUNDER_ADDRESS,
    signatureType: process.env.SIGNATURE_TYPE,
    clobApiKey: process.env.CLOB_API_KEY,
    clobSecret: process.env.CLOB_SECRET,
    clobPassphrase: process.env.CLOB_PASSPHRASE,
    clobHost: process.env.CLOB_HOST,
    dataApiHost: process.env.DATA_API_HOST,
    gammaApiHost: process.env.GAMMA_API_HOST,
    polygonRpcUrl: process.env.POLYGON_RPC_URL,
    betSizeUsd: process.env.BET_SIZE_USD,
    pollIntervalMs: process.env.POLL_INTERVAL_MS,
    leaderRefreshIntervalMs: process.env.LEADER_REFRESH_INTERVAL_MS,
    topTradersCount: process.env.TOP_TRADERS_COUNT,
    leaderboardPeriod: process.env.LEADERBOARD_PERIOD,
    redeemCheckIntervalMs: process.env.REDEEM_CHECK_INTERVAL_MS,
    maxSlippagePct: process.env.MAX_SLIPPAGE_PCT,
    sellMode: process.env.SELL_MODE,
    dryRun: process.env.DRY_RUN,
    dailyLossLimitUsd: process.env.DAILY_LOSS_LIMIT_USD,
    maxDrawdownPct: process.env.MAX_DRAWDOWN_PCT,
    maxOpenPositions: process.env.MAX_OPEN_POSITIONS,
    minMarketLiquidity: process.env.MIN_MARKET_LIQUIDITY,
    minTraderVolume: process.env.MIN_TRADER_VOLUME,
    dashboardPort: process.env.DASHBOARD_PORT,
    telegramToken: process.env.TELEGRAM_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    telegramEnabled: process.env.TELEGRAM_ENABLED,
    telegramNotifyTrades: process.env.TELEGRAM_NOTIFY_TRADES,
    telegramNotifyErrors: process.env.TELEGRAM_NOTIFY_ERRORS,
    telegramDailySummary: process.env.TELEGRAM_DAILY_SUMMARY,
    logLevel: process.env.LOG_LEVEL,
    traderRotationIntervalHours: process.env.TRADER_ROTATION_INTERVAL_HOURS,
    probationTrades: process.env.PROBATION_TRADES,
    autoDropLossThreshold: process.env.AUTO_DROP_LOSS_THRESHOLD,
    anomalySizeMultiplier: process.env.ANOMALY_SIZE_MULTIPLIER,
    backtestDefaultPeriodDays: process.env.BACKTEST_DEFAULT_PERIOD_DAYS,
    optimizerAutoApply: process.env.OPTIMIZER_AUTO_APPLY,
  };

  const result = configSchema.safeParse(env);
  if (!result.success) {
    console.error('Invalid configuration:', result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
