import { createLogger } from '../utils/logger.js';
import { config, reloadConfigFromDb } from '../config.js';
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
      // 0. Reload settings from DB (in case user changed them via UI)
      reloadConfigFromDb(queries.getSetting);

      // 0b. Initialize demo balance if needed
      if (config.dryRun) {
        const existing = queries.getSetting('demo_balance');
        if (existing === undefined) {
          queries.setSetting('demo_balance', String(config.demoInitialBalanceUsd));
          queries.setSetting('demo_initial_balance', String(config.demoInitialBalanceUsd));
          queries.setSetting('demo_total_commission', '0');
          log.info({ initialBalance: config.demoInitialBalanceUsd }, 'Demo account initialized');
        }
      }

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

      // 2. Move dropped-out traders to exit-only / fully deactivate those without positions
      this.reconcileDroppedTraders(traders);

      // 2b. Initialize tracker with active + exit-only traders
      try {
        this.tracker.initialize(queries.getTrackedForPolling());
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
          reloadConfigFromDb(queries.getSetting);
          const updated = await this.leaderboard.refresh();
          this.reconcileDroppedTraders(updated);
          this.tracker.initialize(queries.getTrackedForPolling());
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

  /**
   * Public hook for the API to re-sync the tracker's in-memory trader map
   * with DB state after a manual add/remove.
   */
  refreshTracker(): void {
    this.tracker.initialize(queries.getTrackedForPolling());
    log.info('Tracker refreshed from DB');
  }

  /**
   * On-demand leaderboard refresh: re-reads settings, re-fetches/re-scores
   * the leaderboard, reconciles dropouts, and re-initializes the tracker.
   * Mirrors the hourly setInterval body in start().
   */
  async refreshLeaderboardNow(): Promise<{ count: number }> {
    reloadConfigFromDb(queries.getSetting);
    const updated = await this.leaderboard.refresh();
    this.reconcileDroppedTraders(updated);
    this.tracker.initialize(queries.getTrackedForPolling());
    log.info({ count: updated.length }, 'Leaderboard refreshed (on demand)');
    return { count: updated.length };
  }

  /**
   * Compares the current DB-active traders against the new top-N list and
   * transitions dropouts to either exit-only (if they still have open
   * positions opened via their BUY) or fully deactivates them.
   */
  private reconcileDroppedTraders(
    newTopN: import('../types.js').TrackedTrader[],
  ): void {
    const topSet = new Set(newTopN.map((t) => t.address.toLowerCase()));
    const currentActive = queries.getActiveTraders();

    for (const t of currentActive) {
      if (topSet.has(t.address.toLowerCase())) continue;
      const openCount = queries.countOpenPositionsFromTrader(t.address);
      if (openCount > 0) {
        queries.setExitOnly(t.address);
        log.info(
          { trader: t.name, address: t.address, openPositions: openCount },
          'Trader dropped out of top-N → moved to exit-only',
        );
      } else {
        queries.deactivateTraderFully(t.address);
        log.info(
          { trader: t.name, address: t.address },
          'Trader dropped out of top-N → fully deactivated (no open positions)',
        );
      }
    }
  }

  /**
   * If the given trader is in exit-only and has no remaining open positions
   * originating from their BUYs, fully deactivate and drop from the tracker.
   */
  private cleanupExitOnlyIfEmpty(address: string): void {
    const t = queries.getTraderByAddress(address);
    if (!t || !t.exitOnly) return;
    const openCount = queries.countOpenPositionsFromTrader(address);
    if (openCount === 0) {
      queries.deactivateTraderFully(address);
      this.tracker.initialize(queries.getTrackedForPolling());
      log.info(
        { trader: t.name, address },
        'Exit-only trader fully deactivated (all positions closed)',
      );
    }
  }

  private async handleNewTrade(trade: DetectedTrade): Promise<void> {
    // Monthly stop-loss: skip BUY signals when stopped (SELL still processed)
    if (trade.action === 'buy' && this.executor.checkMonthlyStop()) {
      log.debug({ market: trade.marketTitle }, 'Monthly stop active — skipping BUY');
      return;
    }

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

      // If this was a SELL from an exit-only trader, they may now have zero
      // open positions remaining — fully deactivate and drop from polling.
      if (result.side === 'SELL' && (result.status === 'simulated' || result.status === 'filled')) {
        this.cleanupExitOnlyIfEmpty(trade.traderAddress);
      }
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
          commission: 0,
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
      const trades = queries.getTrades({ limit: 100000 });
      const completed = trades.filter(
        (t) => t.status === 'filled' || t.status === 'simulated',
      );

      // Realized P&L = SELL revenue - commissions (on closed flow).
      // Demo balance already captures BUY outflows + commissions, so we derive
      // realized from balance delta minus locked-in invested:
      //   realized = (balance - initial) + totalInvested(open)
      const commission = completed.reduce((sum, t) => sum + (t.commission ?? 0), 0);

      const balanceUsdc = config.dryRun ? queries.getDemoBalance() : 0;
      const initialBalance = config.dryRun
        ? parseFloat(
            queries.getSetting('demo_initial_balance') ?? String(config.demoInitialBalanceUsd),
          )
        : 0;
      const lockedInOpen = positions.reduce((s, p) => s + (p.totalInvested ?? 0), 0);

      const realizedPnl = config.dryRun
        ? balanceUsdc - initialBalance + lockedInOpen
        : completed
            .filter((t) => t.side === 'SELL')
            .reduce((sum, t) => sum + (t.totalUsd - t.originalTraderPrice * t.size), 0) -
          commission;

      queries.insertSnapshot({
        totalPnl: realizedPnl,
        unrealizedPnl: 0,
        realizedPnl,
        balanceUsdc,
        openPositionsCount: positions.length,
      });

      broadcastEvent('pnl_update', { totalPnl: realizedPnl, openPositionsCount: positions.length });
    } catch (err) {
      log.error({ err }, 'PnL snapshot failed');
    }
  }
}
