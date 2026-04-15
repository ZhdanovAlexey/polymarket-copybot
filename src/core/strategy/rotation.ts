import { createLogger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { Leaderboard } from '../leaderboard.js';
import { PerformanceTracker } from './performance.js';
import * as queries from '../../db/queries.js';
import type { TrackedTrader, TradeResult } from '../../types.js';

const log = createLogger('rotation');

export class TraderRotation {
  private leaderboard: Leaderboard;
  private performance: PerformanceTracker;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(leaderboard?: Leaderboard, performance?: PerformanceTracker) {
    this.leaderboard = leaderboard ?? new Leaderboard();
    this.performance = performance ?? new PerformanceTracker();
  }

  /**
   * Schedule periodic trader rotation
   */
  start(): void {
    const intervalMs = config.traderRotationIntervalHours * 60 * 60 * 1000;
    log.info({ intervalHours: config.traderRotationIntervalHours }, 'Starting trader rotation');

    this.timer = setInterval(() => {
      this.rotateTraders().catch(err => log.error({ err }, 'Rotation failed'));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info('Trader rotation stopped');
    }
  }

  /**
   * Main rotation logic:
   * 1. Check current traders for underperformance
   * 2. Fetch fresh leaderboard
   * 3. Replace underperforming traders with new top traders
   */
  async rotateTraders(): Promise<{
    dropped: string[];
    added: string[];
  }> {
    log.info('Starting trader rotation...');

    const currentTraders = queries.getActiveTraders();
    const dropped: string[] = [];
    const added: string[] = [];

    // 1. Check for traders that should be dropped
    for (const trader of currentTraders) {
      const { drop, reason } = this.performance.shouldDrop(trader.address);
      if (drop) {
        log.info({ address: trader.address, name: trader.name, reason }, 'Dropping underperforming trader');
        queries.setExitOnly(trader.address);
        dropped.push(trader.address);
        queries.insertRotation(trader.address, null, reason || 'Underperformance');
      }
    }

    // 2. If we dropped anyone, fetch new traders from leaderboard
    if (dropped.length > 0 || currentTraders.length < config.topTradersCount) {
      const freshTraders = await this.leaderboard.fetchAndScore();
      const activeAddresses = new Set(
        queries.getActiveTraders().map(t => t.address)
      );

      const slotsAvailable = config.topTradersCount - activeAddresses.size;

      for (const candidate of freshTraders) {
        if (added.length >= slotsAvailable) break;
        if (activeAddresses.has(candidate.address)) continue;

        // Skip blacklisted candidates
        if (queries.isBlacklisted(candidate.address)) {
          log.info({ candidate: candidate.name }, 'Skipped: trader blacklisted');
          continue;
        }

        // New trader starts in probation
        const probationTrader: TrackedTrader = {
          ...candidate,
          probation: true,
          probationTradesLeft: config.probationTrades,
        };

        queries.upsertTrader(probationTrader);
        added.push(candidate.address);
        queries.insertRotation(null, candidate.address, 'New from leaderboard (probation)');

        log.info({ address: candidate.address, name: candidate.name }, 'New trader added (probation)');
      }
    }

    log.info({ dropped: dropped.length, added: added.length }, 'Rotation complete');
    return { dropped, added };
  }

  /**
   * Handle probation: after N successful trades, graduate to full tracking
   */
  graduateFromProbation(traderAddress: string): boolean {
    const trader = queries.getTraderByAddress(traderAddress);
    if (!trader || !trader.probation) return false;

    const remaining = trader.probationTradesLeft - 1;

    if (remaining <= 0) {
      // Graduate!
      queries.upsertTrader({
        ...trader,
        probation: false,
        probationTradesLeft: 0,
      });
      log.info({ address: traderAddress, name: trader.name }, 'Trader graduated from probation');
      queries.insertRotation(null, traderAddress, 'Graduated from probation');
      return true;
    }

    // Update countdown
    queries.upsertTrader({
      ...trader,
      probationTradesLeft: remaining,
    });

    log.info(
      { address: traderAddress, name: trader.name, remaining },
      'Probation trade counted',
    );

    return false;
  }

  /**
   * Handle probation countdown after a successful BUY trade.
   * Decrements probationTradesLeft; when it reaches 0, evaluates P&L:
   *  - P&L >= 0 → graduate (probation cleared)
   *  - P&L <  0 → exit-only + blacklist for blacklistDays
   */
  handleProbationTrade(traderAddress: string, _result: TradeResult): void {
    const trader = queries.getTraderByAddress(traderAddress);
    if (!trader?.probation) return;

    const remaining = (trader.probationTradesLeft ?? 0) - 1;

    if (remaining > 0) {
      queries.updateTraderProbationTradesLeft(traderAddress, remaining);
      log.info({ trader: trader.name, remaining }, 'Probation trade counted');
      return;
    }

    // Probation period complete — evaluate P&L
    // Use addedAt timestamp (ISO string → unix seconds) if available, else 7 days ago
    const addedAtRaw = trader.addedAt;
    const probationStartTs = addedAtRaw
      ? Math.floor(new Date(addedAtRaw).getTime() / 1000)
      : Math.floor(Date.now() / 1000) - 7 * 86400;

    const stats = this.performance.getTraderStatsSince(traderAddress, probationStartTs)
      ?? this.performance.getTraderStats(traderAddress);
    const totalPnl = stats?.totalPnl ?? 0;

    if (totalPnl >= 0) {
      queries.graduateFromProbation(traderAddress);
      queries.insertActivity(
        'probation',
        `${trader.name} graduated from probation (P&L $${totalPnl.toFixed(2)})`,
      );
      queries.insertRotation(null, traderAddress, `Graduated from probation (P&L $${totalPnl.toFixed(2)})`);
      log.info({ trader: trader.name, pnl: totalPnl }, 'Probation: graduated');
    } else {
      queries.setExitOnly(traderAddress);
      queries.addToBlacklist(traderAddress, 'Failed probation', config.blacklistDays);
      queries.insertActivity(
        'probation',
        `${trader.name} failed probation (P&L $${totalPnl.toFixed(2)}), blacklisted ${config.blacklistDays}d`,
      );
      queries.insertRotation(traderAddress, null, `Failed probation (P&L $${totalPnl.toFixed(2)}), blacklisted ${config.blacklistDays}d`);
      log.warn({ trader: trader.name, pnl: totalPnl }, 'Probation: failed, blacklisted');
    }
  }

  /**
   * Get rotation history
   */
  getHistory(limit = 50) {
    return queries.getRotations(limit);
  }
}
