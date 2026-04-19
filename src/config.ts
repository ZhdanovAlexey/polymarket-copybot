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
  maxSingleBetUsd: z.coerce.number().default(5),
  betSizingMode: z.enum(['fixed', 'proportional']).default('proportional'),
  betScaleAnchorUsd: z.coerce.number().default(100),
  betScaleMaxMul: z.coerce.number().default(5),
  betScaleMinMul: z.coerce.number().default(1),
  pollIntervalMs: z.coerce.number().default(30000),
  leaderRefreshIntervalMs: z.coerce.number().default(3600000),
  topTradersCount: z.coerce.number().default(10),
  leaderboardPeriod: z.string().default('WEEK'),
  redeemCheckIntervalMs: z.coerce.number().default(300000),
  deadPositionPriceThreshold: z.coerce.number().default(0.01),
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

  // Risk — stop-loss
  stopLossMode: z.enum(['disabled', 'fixed', 'trailing', 'both']).default('disabled'),
  stopLossPct: z.coerce.number().default(20),
  trailingStopPct: z.coerce.number().default(15),
  stopLossAntiCascadeMs: z.coerce.number().default(120000),
  // Risk — rolling drawdown
  rollingDdWindowDays: z.coerce.number().default(7),
  rollingDdPct: z.coerce.number().default(15),
  rollingDdAdaptive: z.coerce.boolean().default(true),
  rollingDdEwmaSpan: z.coerce.number().default(30),
  unpauseAfterHours: z.coerce.number().default(24),
  // Risk — concentration
  maxPositionsPerMarket: z.coerce.number().default(1),
  maxExposurePerTokenPct: z.coerce.number().default(25),
  maxExposurePerEventUsd: z.coerce.number().default(0),
  maxSpreadPct: z.coerce.number().default(3),
  // Risk — anomaly actions
  anomalyActionSize: z.enum(['ignore', 'alert', 'reduce_size', 'skip_trade', 'halt_trader']).default('reduce_size'),
  anomalyActionMarket: z.enum(['ignore', 'alert', 'reduce_size', 'skip_trade', 'halt_trader']).default('skip_trade'),
  anomalyActionFrequency: z.enum(['ignore', 'alert', 'reduce_size', 'skip_trade', 'halt_trader']).default('alert'),
  anomalyReduceFactor: z.coerce.number().default(0.3),
  anomalyHaltDurationHours: z.coerce.number().default(24),
  // Risk — health check
  authMaxFailures: z.coerce.number().default(3),
  healthCheckIntervalMs: z.coerce.number().default(300000),
  healthCheckAlertAfterMs: z.coerce.number().default(60000),

  // Selection — backfill
  backfillConcurrency: z.coerce.number().default(10),
  backfillPendingTtlMs: z.coerce.number().default(3600000),
  // Selection — adaptive weights
  adaptiveWeights: z.coerce.boolean().default(false),
  weightsRecalcDays: z.coerce.number().default(14),
  // Selection — probation / blacklist / correlation
  probationSizeMultiplier: z.coerce.number().default(0.3),
  blacklistDays: z.coerce.number().default(7),
  maxPairwiseCorrelation: z.coerce.number().default(0.7),
  minResolvedTradesForRealWinRate: z.coerce.number().default(10),

  // Market filter — exclude categories by slug/title keywords (comma-separated)
  marketExcludeKeywords: z.string().default(''),

  // Execution — TWAP
  twapThresholdUsd: z.coerce.number().default(50),
  twapSlices: z.coerce.number().default(3),
  twapIntervalSec: z.coerce.number().default(60),
  twapMaxDriftPct: z.coerce.number().default(10),
  // Execution — optimizer
  optimizerIntervalDays: z.coerce.number().default(7),
  optimizerLookbackDays: z.coerce.number().default(30),
  optimizerImprovementThreshold: z.coerce.number().default(1.05),
  // Execution — market age
  marketAgeFactorEnabled: z.coerce.boolean().default(true),
  marketAgeCacheTtlMs: z.coerce.number().default(3600000),
  // Execution — liquidity / depth
  depthSlippagePct: z.coerce.number().default(2),
  depthAdaptivePct: z.coerce.number().default(80),
  // Execution — WebSocket
  useWebSocket: z.coerce.boolean().default(false),
  wsReconnectIntervalMs: z.coerce.number().default(5000),
  wsMaxReconnectAttempts: z.coerce.number().default(10),
  // Execution — sell / exit
  takeProfitPct: z.coerce.number().default(50),
  partialScaleOutPct: z.coerce.number().default(50),
  partialScaleOutThreshold: z.coerce.number().default(50),
  // Execution — queue
  maxConcurrentExecutions: z.coerce.number().default(2),
  tradeQueueStaleMinutes: z.coerce.number().default(5),
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
    maxSingleBetUsd: process.env.MAX_SINGLE_BET_USD,
    betSizingMode: process.env.BET_SIZING_MODE,
    betScaleAnchorUsd: process.env.BET_SCALE_ANCHOR_USD,
    betScaleMaxMul: process.env.BET_SCALE_MAX_MUL,
    betScaleMinMul: process.env.BET_SCALE_MIN_MUL,
    pollIntervalMs: process.env.POLL_INTERVAL_MS,
    leaderRefreshIntervalMs: process.env.LEADER_REFRESH_INTERVAL_MS,
    topTradersCount: process.env.TOP_TRADERS_COUNT,
    leaderboardPeriod: process.env.LEADERBOARD_PERIOD,
    redeemCheckIntervalMs: process.env.REDEEM_CHECK_INTERVAL_MS,
    deadPositionPriceThreshold: process.env.DEAD_POSITION_PRICE_THRESHOLD,
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
    // Phase 1 additions — read from env (all default to schema defaults if not set)
    stopLossMode: process.env.STOP_LOSS_MODE,
    stopLossPct: process.env.STOP_LOSS_PCT,
    trailingStopPct: process.env.TRAILING_STOP_PCT,
    stopLossAntiCascadeMs: process.env.STOP_LOSS_ANTI_CASCADE_MS,
    rollingDdWindowDays: process.env.ROLLING_DD_WINDOW_DAYS,
    rollingDdPct: process.env.ROLLING_DD_PCT,
    rollingDdAdaptive: process.env.ROLLING_DD_ADAPTIVE,
    rollingDdEwmaSpan: process.env.ROLLING_DD_EWMA_SPAN,
    unpauseAfterHours: process.env.UNPAUSE_AFTER_HOURS,
    maxPositionsPerMarket: process.env.MAX_POSITIONS_PER_MARKET,
    maxExposurePerTokenPct: process.env.MAX_EXPOSURE_PER_TOKEN_PCT,
    maxExposurePerEventUsd: process.env.MAX_EXPOSURE_PER_EVENT_USD,
    maxSpreadPct: process.env.MAX_SPREAD_PCT,
    anomalyActionSize: process.env.ANOMALY_ACTION_SIZE,
    anomalyActionMarket: process.env.ANOMALY_ACTION_MARKET,
    anomalyActionFrequency: process.env.ANOMALY_ACTION_FREQUENCY,
    anomalyReduceFactor: process.env.ANOMALY_REDUCE_FACTOR,
    anomalyHaltDurationHours: process.env.ANOMALY_HALT_DURATION_HOURS,
    authMaxFailures: process.env.AUTH_MAX_FAILURES,
    healthCheckIntervalMs: process.env.HEALTH_CHECK_INTERVAL_MS,
    healthCheckAlertAfterMs: process.env.HEALTH_CHECK_ALERT_AFTER_MS,
    backfillConcurrency: process.env.BACKFILL_CONCURRENCY,
    backfillPendingTtlMs: process.env.BACKFILL_PENDING_TTL_MS,
    adaptiveWeights: process.env.ADAPTIVE_WEIGHTS,
    weightsRecalcDays: process.env.WEIGHTS_RECALC_DAYS,
    probationSizeMultiplier: process.env.PROBATION_SIZE_MULTIPLIER,
    blacklistDays: process.env.BLACKLIST_DAYS,
    maxPairwiseCorrelation: process.env.MAX_PAIRWISE_CORRELATION,
    minResolvedTradesForRealWinRate: process.env.MIN_RESOLVED_TRADES_FOR_REAL_WIN_RATE,
    twapThresholdUsd: process.env.TWAP_THRESHOLD_USD,
    twapSlices: process.env.TWAP_SLICES,
    twapIntervalSec: process.env.TWAP_INTERVAL_SEC,
    twapMaxDriftPct: process.env.TWAP_MAX_DRIFT_PCT,
    optimizerIntervalDays: process.env.OPTIMIZER_INTERVAL_DAYS,
    optimizerLookbackDays: process.env.OPTIMIZER_LOOKBACK_DAYS,
    optimizerImprovementThreshold: process.env.OPTIMIZER_IMPROVEMENT_THRESHOLD,
    marketAgeFactorEnabled: process.env.MARKET_AGE_FACTOR_ENABLED,
    marketAgeCacheTtlMs: process.env.MARKET_AGE_CACHE_TTL_MS,
    depthSlippagePct: process.env.DEPTH_SLIPPAGE_PCT,
    depthAdaptivePct: process.env.DEPTH_ADAPTIVE_PCT,
    useWebSocket: process.env.USE_WEB_SOCKET,
    wsReconnectIntervalMs: process.env.WS_RECONNECT_INTERVAL_MS,
    wsMaxReconnectAttempts: process.env.WS_MAX_RECONNECT_ATTEMPTS,
    takeProfitPct: process.env.TAKE_PROFIT_PCT,
    partialScaleOutPct: process.env.PARTIAL_SCALE_OUT_PCT,
    partialScaleOutThreshold: process.env.PARTIAL_SCALE_OUT_THRESHOLD,
    maxConcurrentExecutions: process.env.MAX_CONCURRENT_EXECUTIONS,
    tradeQueueStaleMinutes: process.env.TRADE_QUEUE_STALE_MINUTES,
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
    maxSingleBetUsd: 'max_single_bet_usd',
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
    deadPositionPriceThreshold: 'dead_position_price_threshold',
    demoInitialBalanceUsd: 'demo_initial_balance',
    demoCommissionPct: 'demo_commission_pct',
    // Phase 1 additions
    stopLossPct: 'stop_loss_pct',
    trailingStopPct: 'trailing_stop_pct',
    stopLossAntiCascadeMs: 'stop_loss_anti_cascade_ms',
    rollingDdWindowDays: 'rolling_dd_window_days',
    rollingDdPct: 'rolling_dd_pct',
    rollingDdEwmaSpan: 'rolling_dd_ewma_span',
    unpauseAfterHours: 'unpause_after_hours',
    maxPositionsPerMarket: 'max_positions_per_market',
    maxExposurePerTokenPct: 'max_exposure_per_token_pct',
    maxExposurePerEventUsd: 'max_exposure_per_event_usd',
    maxSpreadPct: 'max_spread_pct',
    anomalyReduceFactor: 'anomaly_reduce_factor',
    anomalyHaltDurationHours: 'anomaly_halt_duration_hours',
    authMaxFailures: 'auth_max_failures',
    healthCheckIntervalMs: 'health_check_interval_ms',
    healthCheckAlertAfterMs: 'health_check_alert_after_ms',
    backfillConcurrency: 'backfill_concurrency',
    backfillPendingTtlMs: 'backfill_pending_ttl_ms',
    weightsRecalcDays: 'weights_recalc_days',
    probationSizeMultiplier: 'probation_size_multiplier',
    blacklistDays: 'blacklist_days',
    maxPairwiseCorrelation: 'max_pairwise_correlation',
    minResolvedTradesForRealWinRate: 'min_resolved_trades_for_real_win_rate',
    twapThresholdUsd: 'twap_threshold_usd',
    twapSlices: 'twap_slices',
    twapIntervalSec: 'twap_interval_sec',
    twapMaxDriftPct: 'twap_max_drift_pct',
    optimizerIntervalDays: 'optimizer_interval_days',
    optimizerLookbackDays: 'optimizer_lookback_days',
    optimizerImprovementThreshold: 'optimizer_improvement_threshold',
    marketAgeCacheTtlMs: 'market_age_cache_ttl_ms',
    depthSlippagePct: 'depth_slippage_pct',
    depthAdaptivePct: 'depth_adaptive_pct',
    wsReconnectIntervalMs: 'ws_reconnect_interval_ms',
    wsMaxReconnectAttempts: 'ws_max_reconnect_attempts',
    takeProfitPct: 'take_profit_pct',
    partialScaleOutPct: 'partial_scale_out_pct',
    partialScaleOutThreshold: 'partial_scale_out_threshold',
    maxConcurrentExecutions: 'max_concurrent_executions',
    tradeQueueStaleMinutes: 'trade_queue_stale_minutes',
  };

  const stringMap: Record<string, string> = {
    leaderboardPeriod: 'leaderboard_period',
    sellMode: 'sell_mode',
    betSizingMode: 'bet_sizing_mode',
    // Phase 1 additions
    stopLossMode: 'stop_loss_mode',
    anomalyActionSize: 'anomaly_action_size',
    anomalyActionMarket: 'anomaly_action_market',
    anomalyActionFrequency: 'anomaly_action_frequency',
    marketExcludeKeywords: 'market_exclude_keywords',
  };

  const boolMap: Record<string, string> = {
    dryRun: 'dry_run',
    // Phase 1 additions
    rollingDdAdaptive: 'rolling_dd_adaptive',
    adaptiveWeights: 'adaptive_weights',
    marketAgeFactorEnabled: 'market_age_factor_enabled',
    useWebSocket: 'use_web_socket',
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
