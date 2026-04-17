import { createLogger } from '../utils/logger.js';
import { config, reloadConfigFromDb } from '../config.js';
import { Leaderboard } from './leaderboard.js';
import { Tracker } from './tracker.js';
import { Executor } from './executor.js';
import { Portfolio } from './portfolio.js';
import { RiskManager } from './risk-manager.js';
import { Redeemer } from './redeemer.js';
import { MarketResolver } from './strategy/market-resolver.js';
import { StopLossMonitor } from './stop-loss-monitor.js';
import { HealthChecker } from './health-checker.js';
import { TradeQueue } from './execution/trade-queue.js';
import { TraderRotation } from './strategy/rotation.js';
import { PerformanceTracker } from './strategy/performance.js';
import { DrawdownMonitor } from './drawdown-monitor.js';
import { AutoOptimizer } from './strategy/auto-optimizer.js';
import { ClobClientWrapper } from '../api/clob-client.js';
import { DataApi } from '../api/data-api.js';
import { broadcastEvent } from '../dashboard/routes/sse.js';
import { setBotState } from '../dashboard/routes/api.js';
import * as queries from '../db/queries.js';
import type { BotStatus, DetectedTrade, ExitSignal, TrackedTrader } from '../types.js';

const log = createLogger('bot');

export class Bot {
  private leaderboard: Leaderboard;
  private tracker: Tracker;
  private executor: Executor;
  private portfolio: Portfolio;
  private riskManager: RiskManager;
  private redeemer: Redeemer;
  private marketResolver: MarketResolver;
  private stopLossMonitor: StopLossMonitor;
  private healthChecker: HealthChecker;
  private tradeQueue: TradeQueue;
  private rotation: TraderRotation;

  private drawdownMonitor: DrawdownMonitor;
  private autoOptimizer: AutoOptimizer;

  private status: BotStatus = 'idle';
  private startTime: number | null = null;
  private leaderboardRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private pnlSnapshotTimer: ReturnType<typeof setInterval> | null = null;
  private stopLossQueueTimer: ReturnType<typeof setInterval> | null = null;
  private mtmTimer: ReturnType<typeof setInterval> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private rotationTimer: ReturnType<typeof setInterval> | null = null;
  private weightsRecalcTimer: ReturnType<typeof setInterval> | null = null;
  private convictionScalarTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.leaderboard = new Leaderboard();
    this.tracker = new Tracker();
    this.healthChecker = new HealthChecker();
    this.executor = new Executor(undefined, undefined, this.healthChecker);
    this.portfolio = new Portfolio();
    this.riskManager = new RiskManager();
    this.redeemer = new Redeemer();
    this.marketResolver = new MarketResolver(new ClobClientWrapper(), new DataApi());
    this.stopLossMonitor = new StopLossMonitor();
    this.tradeQueue = new TradeQueue((trade) => this.handleNewTrade(trade));
    this.rotation = new TraderRotation(this.leaderboard, new PerformanceTracker());
    this.drawdownMonitor = new DrawdownMonitor();
    this.autoOptimizer = new AutoOptimizer();

    // Wire tracker events through the trade queue
    this.tracker.on('newTrade', (trade: DetectedTrade) => this.tradeQueue.enqueue(trade));
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

    // Subscribe to price-based exit signals from portfolio (take_profit / scale_out)
    this.portfolio.on('exitSignal', async (signal: ExitSignal) => {
      log.info({ signal }, 'Exit signal triggered');
      try {
        await this.executor.executePriceExit(signal);
        if (signal.triggerSource === 'scale_out') {
          queries.markScaledOut(signal.tokenId);
        }
      } catch (err) {
        log.error({ err, signal }, 'Exit signal execution failed');
      }
    });

    try {
      // 0. Reload settings from DB (in case user changed them via UI)
      reloadConfigFromDb(queries.getSetting);

      // 0a. Resume any stale TWAP slices from previous session
      await this.executor.twapExecutor.resumeIncomplete();

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

      // 1b. Kick off background backfill — non-blocking
      this.startBackfill(traders).catch((err) => log.error({ err }, 'Backfill failed'));

      // 2. Move dropped-out traders to exit-only / fully deactivate those without positions
      this.reconcileDroppedTraders(traders);

      // 2b. Initialize tracker with active + exit-only traders
      // Note: useWebSocket=true requests WS mode, but Polymarket has no public
      // user-activity WS endpoint — polling remains the backbone in all cases.
      if (config.useWebSocket) {
        log.info(
          'WebSocket mode requested — Polymarket does not have a public user-activity WS; using polling',
        );
      }
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

      // 4b. Schedule trader rotation (if configured)
      const rotationMs = config.traderRotationIntervalHours * 3600 * 1000;
      if (rotationMs > 0) {
        this.rotationTimer = setInterval(async () => {
          try {
            const result = await this.rotation.rotateTraders();
            if (result.dropped.length > 0 || result.added.length > 0) {
              this.tracker.initialize(queries.getTrackedForPolling());
              log.info({ dropped: result.dropped.length, added: result.added.length }, 'Rotation cycle done');
            }
          } catch (err) {
            log.error({ err }, 'Rotation failed');
          }
        }, rotationMs);
      }

      // 5. Schedule PnL snapshots (every 5 min)
      this.pnlSnapshotTimer = setInterval(() => {
        this.savePnlSnapshot();
      }, 300_000);

      // 5b. Recalculate per-trader conviction scalars (every 2 hours)
      this.convictionScalarTimer = setInterval(() => {
        this.recalcConvictionScalars();
      }, 7_200_000);

      // 6. Schedule mark-to-market (every 60s) + stop-loss + drawdown checks
      this.mtmTimer = setInterval(async () => {
        try {
          await this.portfolio.markToMarket();

          if (config.stopLossMode !== 'disabled') {
            const positions = this.portfolio.getAllPositions();
            const triggered = this.stopLossMonitor.checkPositions(positions);
            if (triggered.length > 0) {
              log.info({ count: triggered.length }, 'Stop-loss positions detected');
            }
          }

          // Rolling drawdown check
          const positions = this.portfolio.getAllPositions();
          const lockedIn = positions.reduce((s, p) => s + (p.totalInvested ?? 0), 0);
          const balanceUsdc = config.dryRun ? queries.getDemoBalance() : 0;
          const equity = balanceUsdc + lockedIn;
          this.drawdownMonitor.checkDrawdown(equity);
          this.drawdownMonitor.checkUnpause();
        } catch (err) {
          log.error({ err }, 'MTM/stop-loss check failed');
        }
      }, 60_000);

      // 6b. Adaptive weights recalc timer (if enabled)
      if (config.adaptiveWeights) {
        const weightsMs = config.weightsRecalcDays * 86400 * 1000;
        this.weightsRecalcTimer = setInterval(() => {
          try {
            const weights = this.leaderboard.adaptiveWeights.recalculate();
            if (weights) log.info({ weights }, 'Scoring weights recalculated');
          } catch (err) {
            log.error({ err }, 'Weights recalc failed');
          }
        }, weightsMs);
      }

      // 6c. Start auto-optimizer
      this.autoOptimizer.start();

      // 7. Stop-loss queue processor (every 10s)
      this.stopLossQueueTimer = setInterval(() => {
        this.stopLossMonitor.processQueue(
          (tokenId, reason) => this.executor.executeStopLossSell(tokenId, reason).then(() => undefined),
        ).catch((err) => log.error({ err }, 'Stop-loss queue processing failed'));
      }, 10_000);

      // 8. Health check (real mode only)
      if (!config.dryRun) {
        this.healthCheckTimer = setInterval(() => {
          this.healthChecker.pingClob(config.clobHost).catch(
            (err) => log.error({ err }, 'Health check ping failed'),
          );
        }, config.healthCheckIntervalMs);
      }

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
    if (this.convictionScalarTimer) {
      clearInterval(this.convictionScalarTimer);
      this.convictionScalarTimer = null;
    }
    if (this.mtmTimer) {
      clearInterval(this.mtmTimer);
      this.mtmTimer = null;
    }
    if (this.stopLossQueueTimer) {
      clearInterval(this.stopLossQueueTimer);
      this.stopLossQueueTimer = null;
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
    if (this.weightsRecalcTimer) {
      clearInterval(this.weightsRecalcTimer);
      this.weightsRecalcTimer = null;
    }

    this.autoOptimizer.stop();
    this.tradeQueue.drain();

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
    // Health check: skip if bot is halted by circuit breaker
    if (this.healthChecker.isHalted()) {
      log.warn({ tradeId: trade.id, action: trade.action }, 'Bot halted by HealthChecker, skipping trade');
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

      // Probation countdown for successful BUYs
      if (
        trade.action === 'buy' &&
        (result.status === 'simulated' || result.status === 'filled')
      ) {
        this.rotation.handleProbationTrade(trade.traderAddress, result);
      }

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

  /**
   * Background backfill: compute realized win rate for each top-N trader.
   * Runs sequentially (one trader at a time) to keep API load manageable.
   * Non-blocking — called via `.catch(...)` in start().
   */
  private async startBackfill(traders: TrackedTrader[]): Promise<void> {
    log.info({ count: traders.length }, 'Starting background backfill');

    for (const trader of traders) {
      const ts = Math.floor(Date.now() / 1000);
      queries.upsertBackfillJob({
        traderAddress: trader.address,
        status: 'running',
        startedAt: ts,
      });

      try {
        const result = await this.marketResolver.computeRealizedWinRate(trader.address);
        queries.updateTraderRealizedWinRate(
          trader.address,
          result.realizedWinRate,
          result.resolvedTradesCount,
          result.confidence,
        );
        queries.upsertBackfillJob({
          traderAddress: trader.address,
          status: 'done',
          completedAt: Math.floor(Date.now() / 1000),
          marketsResolved: result.resolvedTradesCount,
        });
        log.info(
          {
            trader: trader.name,
            realizedWinRate: result.realizedWinRate,
            resolved: result.resolvedTradesCount,
          },
          'Backfill done for trader',
        );
      } catch (err) {
        queries.upsertBackfillJob({
          traderAddress: trader.address,
          status: 'failed',
          completedAt: Math.floor(Date.now() / 1000),
          error: (err as Error).message,
        });
        log.error({ trader: trader.name, err }, 'Backfill failed for trader');
      }
    }

    log.info({ tradersProcessed: traders.length }, 'Backfill complete');

    // Re-score with real win rates now available
    this.leaderboard.rescoreWithRealWinRates();
    broadcastEvent('backfill_complete', { tradersProcessed: traders.length });
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

      const unrealizedPnl = positions.reduce((s, p) => {
        const mtm =
          p.currentPrice !== null && p.currentPrice !== undefined
            ? p.totalShares * p.currentPrice
            : p.totalInvested;
        return s + (mtm - p.totalInvested);
      }, 0);

      const realizedPnl = config.dryRun
        ? balanceUsdc - initialBalance + lockedInOpen
        : completed
            .filter((t) => t.side === 'SELL')
            .reduce((sum, t) => sum + (t.totalUsd - t.originalTraderPrice * t.size), 0) -
          commission;

      const totalPnl = realizedPnl + unrealizedPnl;

      queries.insertSnapshot({
        totalPnl,
        unrealizedPnl,
        realizedPnl,
        balanceUsdc,
        openPositionsCount: positions.length,
      });

      broadcastEvent('pnl_update', { totalPnl, openPositionsCount: positions.length });
    } catch (err) {
      log.error({ err }, 'PnL snapshot failed');
    }
  }

  /**
   * Recalculate per-trader conviction scalars based on realized win rate.
   * scalar = clamp(0.5 + winRate, 0.3, 2.0)
   * Requires ≥5 closed positions attributed to the trader; otherwise scalar = 1.0.
   */
  private recalcConvictionScalars(): void {
    try {
      const closedPositions = queries.getClosedPositions(10000);
      const traders = queries.getActiveTraders();

      for (const trader of traders) {
        // Find closed positions opened by this trader
        const traderPositions = closedPositions.filter(
          (p) => p.traderAddress === trader.address,
        );

        if (traderPositions.length < 5) {
          queries.setConvictionScalar(trader.address, 1.0);
          continue;
        }

        const wins = traderPositions.filter((p) => p.realizedPnl > 0).length;
        const winRate = wins / traderPositions.length;
        const scalar = Math.min(2.0, Math.max(0.3, 0.5 + winRate));

        queries.setConvictionScalar(trader.address, scalar);
        log.info(
          { trader: trader.name, winRate: winRate.toFixed(2), scalar: scalar.toFixed(2), closedCount: traderPositions.length },
          'Conviction scalar updated',
        );
      }
    } catch (err) {
      log.error({ err }, 'Conviction scalar recalculation failed');
    }
  }
}
