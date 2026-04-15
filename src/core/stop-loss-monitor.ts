import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import type { BotPosition, StopLossTriggered } from '../types.js';

const log = createLogger('stop-loss-monitor');

interface QueuedSell {
  tokenId: string;
  reason: 'stop_loss' | 'trailing_stop';
  scheduledAt: number;
}

export class StopLossMonitor {
  private sellQueue: QueuedSell[] = [];
  private sellsThisHour: number[] = []; // timestamps for rate limit
  private lastStopLossSellAt = 0;

  constructor() {
    // no side effects
  }

  /**
   * Check all open positions for stop-loss or trailing stop triggers.
   * Call this after MTM price update.
   */
  checkPositions(positions: BotPosition[]): StopLossTriggered[] {
    const triggered: StopLossTriggered[] = [];
    const mode = config.stopLossMode;

    if (mode === 'disabled') {
      return triggered;
    }

    const now = Date.now();
    const staleCutoff = now - 5 * 60 * 1000; // 5 minutes

    for (const p of positions) {
      if (p.status !== 'open') continue;

      // Guard: current price must be fresh (updated within last 5 min)
      const currentPrice = p.currentPrice;
      const priceUpdatedAt = p.currentPriceUpdatedAt ?? 0;

      if (currentPrice === null || currentPrice === undefined || currentPrice <= 0) {
        continue; // no price data yet
      }

      if (priceUpdatedAt < staleCutoff) {
        log.debug(
          { tokenId: p.tokenId, ageMs: now - priceUpdatedAt },
          'Skipping stop-loss: stale price (> 5 min)',
        );
        continue;
      }

      // Skip if already queued
      const alreadyQueued = this.sellQueue.some((q) => q.tokenId === p.tokenId);
      if (alreadyQueued) continue;

      // Fixed stop-loss check
      if (mode === 'fixed' || mode === 'both') {
        const threshold = p.avgPrice * (1 - config.stopLossPct / 100);
        if (currentPrice < threshold) {
          log.info(
            { tokenId: p.tokenId, currentPrice, threshold, avgPrice: p.avgPrice },
            '[STOP-LOSS] Fixed stop triggered',
          );
          triggered.push({
            tokenId: p.tokenId,
            conditionId: p.conditionId,
            reason: 'stop_loss',
            currentPrice,
            threshold,
          });
          this.enqueueStopLoss(p.tokenId, 'stop_loss');
          continue; // don't double-trigger trailing as well
        }
      }

      // Trailing stop check
      if (mode === 'trailing' || mode === 'both') {
        if (p.highPrice === null || p.highPrice === undefined || p.highPrice <= 0) continue;
        const threshold = p.highPrice * (1 - config.trailingStopPct / 100);
        if (currentPrice < threshold) {
          log.info(
            { tokenId: p.tokenId, currentPrice, threshold, highPrice: p.highPrice },
            '[TRAILING-STOP] Trailing stop triggered',
          );
          triggered.push({
            tokenId: p.tokenId,
            conditionId: p.conditionId,
            reason: 'trailing_stop',
            currentPrice,
            threshold,
          });
          this.enqueueStopLoss(p.tokenId, 'trailing_stop');
        }
      }
    }

    return triggered;
  }

  /**
   * Add a stop-loss sell to the anti-cascade queue.
   */
  enqueueStopLoss(tokenId: string, reason: 'stop_loss' | 'trailing_stop'): void {
    // Avoid duplicates
    if (this.sellQueue.some((q) => q.tokenId === tokenId)) {
      log.debug({ tokenId }, 'Already in stop-loss queue, skipping');
      return;
    }

    const now = Date.now();
    const queueLen = Math.max(1, this.sellQueue.length);
    // Anti-cascade: spread sells with minimum 30s gap, accounting for queue length
    const scheduledAt = Math.max(
      now + 5000,
      this.lastStopLossSellAt + Math.floor(config.stopLossAntiCascadeMs / queueLen),
    );

    this.sellQueue.push({ tokenId, reason, scheduledAt });
    log.info({ tokenId, reason, scheduledAt, queueLength: this.sellQueue.length }, 'Stop-loss sell enqueued');
  }

  /**
   * Process one sell from the queue per call (rate control).
   * Called by the bot's 10s timer.
   */
  async processQueue(
    executeSell: (tokenId: string, reason: 'stop_loss' | 'trailing_stop') => Promise<void>,
  ): Promise<void> {
    const now = Date.now();

    // Clean up stale hourly timestamps
    this.sellsThisHour = this.sellsThisHour.filter((ts) => now - ts < 3_600_000);

    if (this.sellsThisHour.length >= 5) {
      log.warn({ sellsThisHour: this.sellsThisHour.length }, 'Stop-loss rate limit reached (max 5/hour), skipping');
      return;
    }

    if (this.sellQueue.length === 0) return;

    // Sort by scheduledAt ASC
    this.sellQueue.sort((a, b) => a.scheduledAt - b.scheduledAt);

    const next = this.sellQueue[0];
    if (next.scheduledAt > now) {
      log.debug({ tokenId: next.tokenId, delayMs: next.scheduledAt - now }, 'Stop-loss sell not yet due');
      return;
    }

    // Remove from queue and execute
    this.sellQueue.shift();
    this.lastStopLossSellAt = now;
    this.sellsThisHour.push(now);

    log.info({ tokenId: next.tokenId, reason: next.reason }, 'Processing stop-loss sell from queue');

    try {
      await executeSell(next.tokenId, next.reason);
    } catch (err) {
      log.error({ err, tokenId: next.tokenId }, 'Stop-loss sell execution failed');
    }
  }

  getStats(): { queueLength: number; sellsThisHour: number } {
    const now = Date.now();
    const validSells = this.sellsThisHour.filter((ts) => now - ts < 3_600_000);
    return {
      queueLength: this.sellQueue.length,
      sellsThisHour: validSells.length,
    };
  }
}
