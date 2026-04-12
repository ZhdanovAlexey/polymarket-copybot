import { createLogger } from '../utils/logger.js';
import { config } from '../config.js';
import { Leaderboard } from './leaderboard.js';
import { Tracker } from './tracker.js';
import { Executor } from './executor.js';
import { Portfolio } from './portfolio.js';
import { RiskManager } from './risk-manager.js';
import { Redeemer } from './redeemer.js';
import { broadcastEvent } from '../dashboard/routes/sse.js';
import { setBotState } from '../dashboard/routes/api.js';
import * as queries from '../db/queries.js';
import type { BotStatus, DetectedTrade } from '../types.js';

const log = createLogger('bot');

export class Bot {
  private leaderboard: Leaderboard;
  private tracker: Tracker;
  private executor: Executor;
  private portfolio: Portfolio;
  private riskManager: RiskManager;
  private redeemer: Redeemer;

  private status: BotStatus = 'idle';
  private startTime: number | null = null;
  private leaderboardRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private pnlSnapshotTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.leaderboard = new Leaderboard();
    this.tracker = new Tracker();
    this.executor = new Executor();
    this.portfolio = new Portfolio();
    this.riskManager = new RiskManager();
    this.redeemer = new Redeemer();

    // Wire tracker events to executor
    this.tracker.on('newTrade', (trade: DetectedTrade) => this.handleNewTrade(trade));
    this.tracker.on('error', (err: Error) => {
      log.error({ err }, 'Tracker error');
      broadcastEvent('alert', { alertType: 'tracker_error', message: err.message, severity: 'warning' });
    });
  }

  async start(): Promise<void> {
    if (this.status === 'running') {
      log.warn('Bot already running');
      return;
    }

    log.info('Starting bot...');
    this.status = 'running';
    this.startTime = Date.now();
    setBotState(true);

    try {
      // 1. Refresh leaderboard (fall back to cached traders on failure)
      let traders: import('../types.js').TrackedTrader[];
      try {
        traders = await this.leaderboard.refresh();
        log.info({ count: traders.length }, 'Traders loaded from API');
      } catch (err) {
        log.error({ err }, 'Leaderboard refresh failed, falling back to cached traders');
        broadcastEvent('alert', { alertType: 'leaderboard_error', message: 'Using cached traders', severity: 'warning' });
        traders = this.leaderboard.loadFromDb();
        if (traders.length === 0) {
          throw new Error('No cached traders available and leaderboard refresh failed');
        }
        log.info({ count: traders.length }, 'Loaded cached traders from DB');
      }

      // 2. Initialize tracker
      try {
        this.tracker.initialize(traders);
        this.tracker.startPolling();
      } catch (err) {
        log.error({ err }, 'Tracker initialization failed');
        broadcastEvent('alert', { alertType: 'tracker_error', message: 'Tracker failed to start', severity: 'error' });
        this.status = 'error';
        setBotState(false);
        return;
      }

      // 3. Start redeemer
      this.redeemer.start();

      // 4. Schedule leaderboard refresh
      this.leaderboardRefreshTimer = setInterval(async () => {
        try {
          const updated = await this.leaderboard.refresh();
          this.tracker.initialize(updated);
          log.info({ count: updated.length }, 'Leaderboard refreshed');
        } catch (err) {
          log.error({ err }, 'Leaderboard refresh failed');
        }
      }, config.leaderRefreshIntervalMs);

      // 5. Schedule PnL snapshots (every 5 min)
      this.pnlSnapshotTimer = setInterval(() => {
        this.savePnlSnapshot();
      }, 300_000);

      queries.insertActivity('start', 'Bot started');
      broadcastEvent('status', { running: true, tradersCount: traders.length, uptime: 0 });

      log.info({ dryRun: config.dryRun, traders: traders.length }, 'Bot started successfully');
    } catch (err) {
      this.status = 'error';
      setBotState(false);
      log.error({ err }, 'Bot start failed');
      throw err;
    }
  }

  async stop(): Promise<void> {
    log.info('Stopping bot...');

    this.tracker.stopPolling();
    this.redeemer.stop();

    if (this.leaderboardRefreshTimer) {
      clearInterval(this.leaderboardRefreshTimer);
      this.leaderboardRefreshTimer = null;
    }
    if (this.pnlSnapshotTimer) {
      clearInterval(this.pnlSnapshotTimer);
      this.pnlSnapshotTimer = null;
    }

    this.status = 'stopped';
    this.startTime = null;
    setBotState(false);

    queries.insertActivity('stop', 'Bot stopped');
    broadcastEvent('status', { running: false, tradersCount: 0, uptime: 0 });

    log.info('Bot stopped');
  }

  getStatus() {
    return {
      status: this.status,
      running: this.status === 'running',
      uptime: this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
      tradersCount: this.tracker.getTrackedTraders().length,
      openPositions: this.portfolio.getAllPositions().length,
      dryRun: config.dryRun,
    };
  }

  private async handleNewTrade(trade: DetectedTrade): Promise<void> {
    try {
      const result = await this.executor.processTrade(trade);

      // Broadcast via SSE
      broadcastEvent('trade', result);

      log.info({
        side: result.side,
        market: result.marketTitle,
        status: result.status,
        price: result.price,
        size: result.size,
      }, 'Trade processed');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, trade }, 'Failed to process trade');

      // Record the failed trade so it shows up in the dashboard
      try {
        queries.insertTrade({
          id: `failed-${Date.now()}-${trade.traderAddress.slice(0, 8)}`,
          timestamp: new Date().toISOString(),
          traderAddress: trade.traderAddress,
          traderName: trade.traderName,
          side: trade.action === 'buy' ? 'BUY' : 'SELL',
          marketSlug: trade.marketSlug,
          marketTitle: trade.marketTitle,
          conditionId: trade.conditionId,
          tokenId: trade.tokenId,
          outcome: trade.outcome,
          size: 0,
          price: trade.price,
          totalUsd: 0,
          status: 'failed',
          error: message,
          originalTraderSize: trade.size,
          originalTraderPrice: trade.price,
          isDryRun: config.dryRun,
        });
      } catch (dbErr) {
        log.error({ err: dbErr }, 'Failed to record failed trade to DB');
      }

      broadcastEvent('alert', {
        alertType: 'executor_error',
        message: `Trade execution failed: ${message}`,
        severity: 'warning',
      });
    }
  }

  private savePnlSnapshot(): void {
    try {
      const positions = this.portfolio.getAllPositions();
      const trades = queries.getTodayTrades();

      const realizedPnl = trades
        .filter(t => t.side === 'SELL' && (t.status === 'filled' || t.status === 'simulated'))
        .reduce((sum, t) => sum + t.totalUsd, 0)
        - trades
          .filter(t => t.side === 'BUY' && (t.status === 'filled' || t.status === 'simulated'))
          .reduce((sum, t) => sum + t.totalUsd, 0);

      queries.insertSnapshot({
        totalPnl: realizedPnl,
        unrealizedPnl: 0,
        realizedPnl,
        balanceUsdc: 0, // Will be fetched from chain in later stage
        openPositionsCount: positions.length,
      });

      broadcastEvent('pnl_update', { totalPnl: realizedPnl, openPositionsCount: positions.length });
    } catch (err) {
      log.error({ err }, 'PnL snapshot failed');
    }
  }
}
