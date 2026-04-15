import type { DetectedTrade, TradeResult } from '../../types.js';
import * as queries from '../../db/queries.js';
import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('trade-queue');

interface QueuedTrade {
  trade: DetectedTrade;
  priority: 1 | 2 | 3;
  enqueuedAt: number;
}

export class TradeQueue {
  private queue: QueuedTrade[] = [];
  private activeCount = 0;
  private draining = false;
  private droppedStale = 0;

  constructor(private processor: (trade: DetectedTrade) => Promise<TradeResult | void>) {}

  /**
   * Enqueue a new trade for execution.
   * Ignored when draining (bot stopping).
   */
  enqueue(trade: DetectedTrade): void {
    if (this.draining) {
      log.debug({ tradeId: trade.id }, 'Queue draining, ignoring new trade');
      return;
    }

    const priority = this.computePriority(trade);

    this.queue.push({ trade, priority, enqueuedAt: Date.now() });

    // Sort by priority ASC (1 = highest), then by enqueuedAt ASC (FIFO within priority)
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.enqueuedAt - b.enqueuedAt;
    });

    log.debug(
      { tradeId: trade.id, action: trade.action, priority, queueLength: this.queue.length },
      'Trade enqueued',
    );

    this.processNext();
  }

  /**
   * Stop accepting new trades; let active ones finish.
   */
  drain(): void {
    this.draining = true;
    log.info({ activeCount: this.activeCount, queueLength: this.queue.length }, 'Trade queue draining');
  }

  getStats(): { queueLength: number; activeCount: number; droppedStale: number } {
    return {
      queueLength: this.queue.length,
      activeCount: this.activeCount,
      droppedStale: this.droppedStale,
    };
  }

  private computePriority(trade: DetectedTrade): 1 | 2 | 3 {
    // SELL always gets highest priority (exit positions ASAP)
    if (trade.action === 'sell') return 1;

    // BUY: look up trader metadata
    const trader = queries.getTraderByAddress(trade.traderAddress);
    if (!trader) return 3; // unknown trader → low priority

    if (trader.probation) return 3;
    if (trader.score > 70) return 1;
    return 2;
  }

  private processNext(): void {
    if (this.activeCount >= config.maxConcurrentExecutions) return;

    // Drop stale trades
    const now = Date.now();
    const staleMs = config.tradeQueueStaleMinutes * 60_000;
    const beforeLen = this.queue.length;
    this.queue = this.queue.filter((item) => {
      const stale = now - item.enqueuedAt > staleMs;
      if (stale) {
        this.droppedStale++;
        log.warn(
          { tradeId: item.trade.id, ageMs: now - item.enqueuedAt },
          'Trade dropped: stale in queue',
        );
      }
      return !stale;
    });
    if (this.queue.length < beforeLen) {
      log.debug({ dropped: beforeLen - this.queue.length }, 'Stale trades dropped from queue');
    }

    if (this.queue.length === 0) return;

    const item = this.queue.shift()!;
    this.activeCount++;

    this.processor(item.trade)
      .finally(() => {
        this.activeCount--;
        this.processNext();
      });
  }
}
