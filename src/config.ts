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
  betSizingMode: z.enum(['fixed', 'proportional']).default('proportional'),
  betScaleAnchorUsd: z.coerce.number().default(100),
  betScaleMaxMul: z.coerce.number().default(5),
  betScaleMinMul: z.coerce.number().default(1),
  pollIntervalMs: z.coerce.number().default(30000),
  leaderRefreshIntervalMs: z.coerce.number().default(3600000),
  topTradersCount: z.coerce.number().default(10),
  leaderboardPeriod: z.string().default('WEEK'),
  redeemCheckIntervalMs: z.coerce.number().default(300000),
  maxSlippagePct: z.coerce.number().default(5),
  sellMode: z.string().default('mirror'),
  dryRun: z.coerce.boolean().default(true),
  demoInitialBalanceUsd: z.coerce.number().default(1000),
  demoCommissionPct: z.coerce.number().default(2),

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
    betSizingMode: process.env.BET_SIZING_MODE,
    betScaleAnchorUsd: process.env.BET_SCALE_ANCHOR_USD,
    betScaleMaxMul: process.env.BET_SCALE_MAX_MUL,
    betScaleMinMul: process.env.BET_SCALE_MIN_MUL,
    pollIntervalMs: process.env.POLL_INTERVAL_MS,
    leaderRefreshIntervalMs: process.env.LEADER_REFRESH_INTERVAL_MS,
    topTradersCount: process.env.TOP_TRADERS_COUNT,
    leaderboardPeriod: process.env.LEADERBOARD_PERIOD,
    redeemCheckIntervalMs: process.env.REDEEM_CHECK_INTERVAL_MS,
    maxSlippagePct: process.env.MAX_SLIPPAGE_PCT,
    sellMode: process.env.SELL_MODE,
    dryRun: process.env.DRY_RUN,
    demoInitialBalanceUsd: process.env.DEMO_INITIAL_BALANCE_USD,
    demoCommissionPct: process.env.DEMO_COMMISSION_PCT,
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

/**
 * Reload mutable settings from DB (settings table) at runtime.
 * Called by bot on leaderboard refresh and after settings save.
 * Accepts a getter function to avoid circular imports.
 */
export function reloadConfigFromDb(getSetting: (key: string) => string | undefined): void {
  const numMap: Record<string, string> = {
    betSizeUsd: 'bet_size_usd',
    betScaleAnchorUsd: 'bet_scale_anchor_usd',
    betScaleMaxMul: 'bet_scale_max_mul',
    betScaleMinMul: 'bet_scale_min_mul',
    topTradersCount: 'top_traders_count',
    pollIntervalMs: 'poll_interval_ms',
    maxSlippagePct: 'max_slippage_pct',
    dailyLossLimitUsd: 'daily_loss_limit_usd',
    maxOpenPositions: 'max_open_positions',
    minMarketLiquidity: 'min_market_liquidity',
    redeemCheckIntervalMs: 'redeem_check_interval_ms',
    demoInitialBalanceUsd: 'demo_initial_balance',
    demoCommissionPct: 'demo_commission_pct',
  };

  const stringMap: Record<string, string> = {
    leaderboardPeriod: 'leaderboard_period',
    sellMode: 'sell_mode',
    betSizingMode: 'bet_sizing_mode',
  };

  const boolMap: Record<string, string> = {
    dryRun: 'dry_run',
  };

  for (const [configKey, dbKey] of Object.entries(numMap)) {
    const val = getSetting(dbKey);
    if (val !== undefined && val !== '') {
      (config as unknown as Record<string, unknown>)[configKey] = Number(val);
    }
  }

  for (const [configKey, dbKey] of Object.entries(stringMap)) {
    const val = getSetting(dbKey);
    if (val !== undefined && val !== '') {
      (config as unknown as Record<string, unknown>)[configKey] = val;
    }
  }

  for (const [configKey, dbKey] of Object.entries(boolMap)) {
    const val = getSetting(dbKey);
    if (val !== undefined && val !== '') {
      (config as unknown as Record<string, unknown>)[configKey] = val === 'true';
    }
  }
}
