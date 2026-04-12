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
  side: 'BUY' | 'SELL';
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
  pollIntervalMs: number;
  leaderRefreshIntervalMs: number;
  topTradersCount: number;
  leaderboardPeriod: string;
  redeemCheckIntervalMs: number;
  maxSlippagePct: number;
  sellMode: string;
  dryRun: boolean;
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
