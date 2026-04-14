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
  /** ISO-8601 string, e.g. "2026-05-01T00:00:00Z". May be null/absent for open-ended markets. */
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
  betSizingMode: 'fixed' | 'proportional';
  betScaleAnchorUsd: number;
  betScaleMaxMul: number;
  betScaleMinMul: number;
  pollIntervalMs: number;
  leaderRefreshIntervalMs: number;
  topTradersCount: number;
  leaderboardPeriod: string;
  redeemCheckIntervalMs: number;
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

// === Backtest / Collector Types ===

export interface BtUniverseEntry {
  address: string;
  name: string;
  volume12m: number;
  addedAt: string;
}

export interface BtTradeActivity {
  id: string;
  address: string;
  timestamp: number;
  tokenId: string;
  conditionId: string;
  action: 'buy' | 'sell';
  price: number;
  size: number;
  usdValue: number;
  marketSlug: string;
}

export interface BtMarket {
  conditionId: string;
  question: string;
  slug: string;
  endDate: string | null;
  volume: number;
  liquidity: number;
  negRisk: number;
  closed: number;
  tokenIds: string;  // JSON array of token_ids
}

export interface BtMarketResolution {
  conditionId: string;
  winnerTokenId: string | null;
  resolvedAt: string;
}

export interface CollectHistoryOptions {
  universeSize: number;           // default 300
  historyDays: number;            // default 365
  ratePauseMs: number;            // default 250
  maxTradesPerTrader: number;     // default 10000 (0 = unlimited)
  phases: Array<'universe' | 'activity' | 'markets' | 'resolutions'>;
}

// === Stage B: Grid Search + Backtest Types ===

export interface ConvictionParams {
  betBase: number;         // base bet in USD (e.g. $2)
  f1Anchor: number;        // USD anchor for F1 normalization
  f1Max: number;           // max F1 multiplier
  w2: number;              // F2 z-score weight (0 = off)
  w3: number;              // F3 trader-score weight (0 = off)
  f4Boost: number;         // F4 consensus multiplier (1.0 = off)
}

export interface BacktestSimConfig {
  conviction: ConvictionParams;
  topN: number;                   // active traders per day
  leaderboardWindowDays: number;  // scoring lookback
  maxTtrDays: number;             // H7 filter (Infinity = off)
  maxPositions: number;           // concurrent open positions
  initialCapital: number;         // starting equity
  slippagePct: number;            // fixed spread per trade (e.g. 1)
  commissionPct: number;          // per-trade commission (e.g. 2)
}

export interface SimPosition {
  tokenId: string;
  conditionId: string;
  shares: number;
  avgPrice: number;
  invested: number;
  openedAtTs: number;
}

export interface DailyEquityPoint {
  dayTs: number;    // start-of-day Unix timestamp
  equity: number;
}

export interface BacktestSimResult {
  config: BacktestSimConfig;
  calmar: number;
  totalPnl: number;
  maxDrawdown: number;
  sharpe: number;
  winRate: number;
  tradeCount: number;
  avgTtrDays: number;
  equityCurve: DailyEquityPoint[];
}

export interface GridRunResult {
  id: string;
  runId: string;
  paramsJson: string;
  calmar: number;
  pnl: number;
  maxDd: number;
  sharpe: number;
  winRate: number;
  tradeCount: number;
  avgTtrDays: number;
  ranAt: string;
}

export interface WalkForwardResult {
  id: string;
  paramsJson: string;
  medianCalmar: number;
  minCalmar: number;
  pctPositiveFolds: number;
  foldsJson: string;
  ranAt: string;
}

/** In-memory dataset loaded from bt_* tables for pure-function backtesting. */
export interface BtDataset {
  /** All trades sorted by timestamp ASC. */
  trades: BtTradeActivity[];
  /** Trades indexed by address for O(1) trader lookup. */
  tradesByAddress: Map<string, BtTradeActivity[]>;
  /** Map conditionId → BtMarket */
  markets: Map<string, BtMarket>;
  /** Map conditionId → winnerTokenId (null if no winner) */
  resolutions: Map<string, string | null>;
  /** All addresses in the universe. */
  universe: string[];
}
