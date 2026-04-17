// === API Response Types ===

export interface LeaderboardEntry {
  address: string;
  name: string;
  profileImage?: string;
  pnl: number;
  volume: number;
  markets_traded: number;
  positions_value: number;
  rank: number;
}

export interface ActivityEntry {
  id: string;
  timestamp: number;
  address: string;
  type: string; // TRADE, REDEEM, etc.
  action: string; // buy, sell
  market_slug: string;
  title: string;
  description: string;
  token_id: string;
  condition_id: string;
  outcome: string; // Yes / No
  size: number;
  price: number;
  usd_value: number;
  transaction_hash: string;
}

export interface PositionEntry {
  asset: string;
  condition_id: string;
  market_slug: string;
  title: string;
  outcome: string;
  size: number;
  avg_price: number;
  cur_price: number;
  initial_value: number;
  current_value: number;
  pnl: number;
  pnl_percent: number;
  redeemable: boolean;
}

export interface TradeEntry {
  id: string;
  timestamp: number;
  market_slug: string;
  title: string;
  side: string; // buy / sell
  outcome: string;
  size: number;
  price: number;
  status: string;
}

export interface GammaMarket {
  id: string;
  question: string;
  slug: string;
  conditionId: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
  }>;
  orderPriceMinTickSize: number;
  negRisk: boolean;
  negRiskMarketId?: string;
  active: boolean;
  closed: boolean;
  volume: number;
  liquidity: number;
  /** ISO string of market creation time (used for F5 market-age factor). May be absent. */
  createdAt?: string;
  /** End / resolution date of the market (ISO string). */
  endDate?: string;
}

export interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  markets: GammaMarket[];
  negRisk: boolean;
  negRiskMarketID?: string;
}

export interface OrderBookResponse {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  hash: string;
  timestamp: string;
}

// === Domain Types ===

export interface TrackedTrader {
  address: string;
  name: string;
  pnl: number;
  volume: number;
  winRate: number;
  score: number;
  tradesCount: number;
  lastSeenTimestamp: number;
  addedAt: string;
  active: boolean;
  /** When true, tracker still polls this trader, but only SELL signals are copied.
   *  Used when a trader dropped out of top-N or was manually removed while still
   *  holding positions from our portfolio. Auto-cleared to `active=0, exit_only=0`
   *  once no open positions remain that originated from this trader's BUYs. */
  exitOnly: boolean;
  // Strategy fields
  probation: boolean;
  probationTradesLeft: number;
  haltedUntil?: number;
  realizedWinRate?: number | null;
  resolvedTradesCount?: number;
  confidence?: number;
  convictionScalar?: number;
}

export interface DetectedTrade {
  id: string;
  timestamp: number;
  traderAddress: string;
  traderName: string;
  action: 'buy' | 'sell';
  marketSlug: string;
  marketTitle: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  size: number;
  price: number;
  usdValue: number;
  transactionHash: string;
}

export interface TradeResult {
  id: string;
  timestamp: string;
  traderAddress: string;
  traderName: string;
  side: 'BUY' | 'SELL' | 'REDEEM';
  marketSlug: string;
  marketTitle: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  size: number;
  price: number;
  totalUsd: number;
  orderId?: string;
  status: 'filled' | 'partial' | 'failed' | 'skipped' | 'simulated';
  error?: string;
  originalTraderSize: number;
  originalTraderPrice: number;
  isDryRun: boolean;
  commission: number;
  reason?: TradeReason;
}

export interface BotPosition {
  id: number;
  tokenId: string;
  conditionId: string;
  marketSlug: string;
  marketTitle: string;
  outcome: string;
  totalShares: number;
  avgPrice: number;
  totalInvested: number;
  openedAt: string;
  status: 'open' | 'closed' | 'redeemed';
  highPrice?: number | null;
  highPriceUpdatedAt?: number;
  stopLossPrice?: number | null;
  trailingStopPrice?: number | null;
  scaledOut?: boolean;
  currentPrice?: number | null;
  currentPriceUpdatedAt?: number;
}

export interface PnlSnapshot {
  id: number;
  timestamp: string;
  totalPnl: number;
  unrealizedPnl: number;
  realizedPnl: number;
  balanceUsdc: number;
  openPositionsCount: number;
}

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
}

export type BotStatus = 'idle' | 'running' | 'stopped' | 'error';

// === Configuration Types ===

export interface AppConfig {
  // Wallet
  privateKey: string;
  funderAddress: string;
  signatureType: number;
  // API Credentials
  clobApiKey: string;
  clobSecret: string;
  clobPassphrase: string;
  // Endpoints
  clobHost: string;
  dataApiHost: string;
  gammaApiHost: string;
  polygonRpcUrl: string;
  // Trading
  betSizeUsd: number;
  maxSingleBetUsd: number;
  betSizingMode: 'fixed' | 'proportional';
  betScaleAnchorUsd: number;
  betScaleMaxMul: number;
  betScaleMinMul: number;
  pollIntervalMs: number;
  leaderRefreshIntervalMs: number;
  topTradersCount: number;
  leaderboardPeriod: string;
  redeemCheckIntervalMs: number;
  deadPositionPriceThreshold: number;
  maxSlippagePct: number;
  sellMode: string;
  dryRun: boolean;
  demoInitialBalanceUsd: number;
  demoCommissionPct: number;
  // Risk
  dailyLossLimitUsd: number;
  maxDrawdownPct: number;
  maxOpenPositions: number;
  minMarketLiquidity: number;
  minTraderVolume: number;
  // Dashboard
  dashboardPort: number;
  // Telegram
  telegramToken: string;
  telegramChatId: string;
  telegramEnabled: boolean;
  telegramNotifyTrades: boolean;
  telegramNotifyErrors: boolean;
  telegramDailySummary: boolean;
  // Logging
  logLevel: string;
  // Strategy
  traderRotationIntervalHours: number;
  probationTrades: number;
  autoDropLossThreshold: number;
  anomalySizeMultiplier: number;
  backtestDefaultPeriodDays: number;
  optimizerAutoApply: boolean;
  // Risk — stop-loss
  stopLossMode: 'disabled' | 'fixed' | 'trailing' | 'both';
  stopLossPct: number;
  trailingStopPct: number;
  stopLossAntiCascadeMs: number;
  // Risk — rolling drawdown
  rollingDdWindowDays: number;
  rollingDdPct: number;
  rollingDdAdaptive: boolean;
  rollingDdEwmaSpan: number;
  unpauseAfterHours: number;
  // Risk — concentration
  maxPositionsPerMarket: number;
  maxExposurePerTokenPct: number;
  maxExposurePerEventUsd: number;
  maxSpreadPct: number;
  // Risk — anomaly actions
  anomalyActionSize: AnomalyAction;
  anomalyActionMarket: AnomalyAction;
  anomalyActionFrequency: AnomalyAction;
  anomalyReduceFactor: number;
  anomalyHaltDurationHours: number;
  // Risk — health check
  authMaxFailures: number;
  healthCheckIntervalMs: number;
  healthCheckAlertAfterMs: number;
  // Selection — backfill
  backfillConcurrency: number;
  backfillPendingTtlMs: number;
  // Selection — adaptive weights
  adaptiveWeights: boolean;
  weightsRecalcDays: number;
  // Selection — probation / blacklist / correlation
  probationSizeMultiplier: number;
  blacklistDays: number;
  maxPairwiseCorrelation: number;
  minResolvedTradesForRealWinRate: number;
  // Execution — TWAP
  twapThresholdUsd: number;
  twapSlices: number;
  twapIntervalSec: number;
  twapMaxDriftPct: number;
  // Execution — optimizer
  optimizerIntervalDays: number;
  optimizerLookbackDays: number;
  optimizerImprovementThreshold: number;
  // Execution — market age
  marketAgeFactorEnabled: boolean;
  marketAgeCacheTtlMs: number;
  // Execution — liquidity / depth
  depthSlippagePct: number;
  depthAdaptivePct: number;
  // Execution — WebSocket
  useWebSocket: boolean;
  wsReconnectIntervalMs: number;
  wsMaxReconnectAttempts: number;
  // Execution — sell / exit
  takeProfitPct: number;
  partialScaleOutPct: number;
  partialScaleOutThreshold: number;
  // Execution — queue
  maxConcurrentExecutions: number;
  tradeQueueStaleMinutes: number;
}

// === Dashboard API Types ===

export interface ApiStatusResponse {
  running: boolean;
  status: BotStatus;
  uptime: number;
  version: string;
  tradersCount: number;
  dryRun: boolean;
}

export interface ApiMetricsResponse {
  totalPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  winRate: number;
  totalTrades: number;
  failedTrades: number;
  todayPnl: number;
  todayTrades: number;
  openPositions: number;
}

// === SSE Event Types ===

export interface SseTradeEvent {
  type: 'trade';
  data: TradeResult;
}

export interface SseBalanceEvent {
  type: 'balance';
  data: { usdc: number; matic: number };
}

export interface SseStatusEvent {
  type: 'status';
  data: { running: boolean; tradersCount: number; uptime: number };
}

export interface SseAlertEvent {
  type: 'alert';
  data: { alertType: string; message: string; severity: 'info' | 'warning' | 'error' };
}

export interface SsePnlEvent {
  type: 'pnl_update';
  data: PnlSnapshot;
}

export type SseEvent = SseTradeEvent | SseBalanceEvent | SseStatusEvent | SseAlertEvent | SsePnlEvent;

// === Strategy Types ===

export interface TraderPerformance {
  traderId: string;
  copiedTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  avgReturn: number;
  sharpe: number;
  slippageAvg: number;
  lastUpdated: string;
}

export interface RotationEvent {
  id: number;
  oldTrader: string;
  newTrader: string;
  reason: string;
  timestamp: string;
}

export interface BacktestConfig {
  traders: string[];
  periodDays: number;
  betSize: number;
  maxSlippage: number;
  maxPositions: number;
}

export interface BacktestResult {
  id: string;
  config: BacktestConfig;
  totalPnl: number;
  winRate: number;
  maxDrawdown: number;
  sharpe: number;
  tradeCount: number;
  equityCurve: Array<{ timestamp: number; equity: number }>;
  traderBreakdown: Array<{ address: string; name: string; pnl: number; trades: number }>;
  ranAt: string;
}

export interface StrategyRecommendation {
  param: string;
  currentValue: number;
  recommendedValue: number;
  confidence: number;
  reason: string;
}

export interface AnomalyAlert {
  id: number;
  traderId: string;
  tradeId?: string;
  type: 'size' | 'market' | 'frequency';
  severity: 'low' | 'medium' | 'high';
  message: string;
  timestamp: string;
}

// === Phase 1 Foundation Types ===

// Trade reason
export type TradeReason = 'copy' | 'stop_loss' | 'trailing_stop' | 'anomaly' | 'manual' | 'redeem' | 'take_profit' | 'scale_out';

// Market resolution
export interface MarketResolution {
  conditionId: string;
  winnerTokenId: string | null;
  resolvedAt: number | null;
  marketTitle: string;
  fetchedAt: number;
  status: 'resolved' | 'pending' | 'closed_not_resolved';
}

export interface RealizedWinRateResult {
  realizedWinRate: number;
  realizedRoi: number;
  resolvedTradesCount: number;
  totalPnl: number;
  confidence: number;
}

export interface BackfillJob {
  traderAddress: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  marketsTotal: number;
  marketsResolved: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
}

// Scoring weights
export interface ScoringWeights {
  roi: number;
  frequency: number;
  winRate: number;
  consistency: number;
  sizeProximity: number;
}

export interface ScoringWeightsRow extends ScoringWeights {
  id: number;
  timestamp: string;
  source: 'manual' | 'auto' | 'default';
}

// Conviction
export interface ConvictionParamsRow {
  id: number;
  betBase: number;
  f1Anchor: number;
  f1Max: number;
  w2: number;
  w3: number;
  f4Boost: number;
  source: 'default' | 'manual' | 'optimizer';
  updatedAt: string;
}

// TWAP
export interface TwapOrder {
  id: number;
  parentTradeId: string;
  tokenId: string;
  conditionId: string;
  side: 'BUY' | 'SELL';
  totalSlices: number;
  sliceNum: number;
  sliceUsd: number;
  sliceSize: number | null;
  status: 'pending' | 'executing' | 'filled' | 'partial' | 'cancelled' | 'drift_stopped';
  orderId: string | null;
  executedPrice: number | null;
  executedAt: string | null;
  initialPrice: number;
  createdAt: string;
  error: string | null;
}

// Market cache
export interface MarketCache {
  conditionId: string;
  createdAt: string | null;
  endDate: string | null;
  gameStartTime: string | null;
  volume: number | null;
  liquidity: number | null;
  cachedAt: string;
}

// Liquidity
export interface LiquidityMetrics {
  bid: number;
  ask: number;
  midpoint: number;
  spreadPct: number;
  depthAt2pct: number;
}

export interface LiquidityCheckResult {
  allowed: boolean;
  reason?: string;
  adjustedBetUsd?: number;
}

// Exit strategy
export type SellMode = 'mirror' | 'proportional' | 'take_profit' | 'partial_scale_out';

export interface ExitSignal {
  tokenId: string;
  conditionId: string;
  sellPct: number;
  reason: string;
  triggerSource: 'trader_mirror' | 'trader_proportional' | 'take_profit' | 'scale_out';
}

// Anomaly actions
export type AnomalyAction = 'ignore' | 'alert' | 'reduce_size' | 'skip_trade' | 'halt_trader';

// Stop-loss
export type StopLossMode = 'disabled' | 'fixed' | 'trailing' | 'both';

export interface StopLossTriggered {
  tokenId: string;
  conditionId: string;
  reason: 'stop_loss' | 'trailing_stop';
  currentPrice: number;
  threshold: number;
}

// Equity snapshot
export interface EquitySnapshot {
  id: number;
  timestamp: number;
  equityUsd: number;
  source: string;
}

// Trader correlation
export interface TraderCorrelation {
  traderA: string;
  traderB: string;
  correlation: number;
  computedAt: number;
}

// Trader blacklist
export interface TraderBlacklistEntry {
  address: string;
  reason: string;
  blacklistedAt: number;
  expiresAt: number;
}

// Trader Analytics (My Leaderboard)
export interface TraderAnalyticsRow {
  address: string;
  name: string;
  active: boolean;
  exitOnly: boolean;
  probation: boolean;
  score: number;
  addedAt: string;
  copiedTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  avgReturn: number;
  slippageAvg: number;
  openPositions: number;
  closedPositions: number;
  openInvested: number;
}
