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
  /** tokenIds with a SELL currently being executed — prevents race-condition duplicates */
  private sellInFlight = new Set<string>();
  /** tokenIds with a BUY currently being executed — prevents concurrent duplicate copies */
  private buyInFlight = new Set<string>();

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

    // Dedup: only one SELL per tokenId at a time (in-flight or queued).
    // Tracker may emit multiple SELL events for the same token within
    // milliseconds (trader's partial fills). Without this guard, concurrent
    // execution sells the full position N times, inflating realized P&L.
    if (trade.action === 'sell' && trade.tokenId) {
      if (this.sellInFlight.has(trade.tokenId)) {
        log.info({ tokenId: trade.tokenId, tradeId: trade.id }, 'SELL already in-flight, dropping duplicate');
        return;
      }
      if (this.queue.some((q) => q.trade.action === 'sell' && q.trade.tokenId === trade.tokenId)) {
        log.info({ tokenId: trade.tokenId, tradeId: trade.id }, 'SELL already queued, dropping duplicate');
        return;
      }
    }

    // Dedup BUYs the same way: a trader's single action can produce
    // multiple Data API entries (partial fills). With concurrent execution
    // both copies pass the executor's 60s cooldown simultaneously.
    if (trade.action === 'buy' && trade.tokenId) {
      if (this.buyInFlight.has(trade.tokenId)) {
        log.info({ tokenId: trade.tokenId, tradeId: trade.id }, 'BUY already in-flight, dropping duplicate');
        return;
      }
      if (this.queue.some((q) => q.trade.action === 'buy' && q.trade.tokenId === trade.tokenId)) {
        log.info({ tokenId: trade.tokenId, tradeId: trade.id }, 'BUY already queued, dropping duplicate');
        return;
      }
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

    // Track in-flight trades to prevent concurrent duplicate execution
    const isSell = item.trade.action === 'sell' && !!item.trade.tokenId;
    const isBuy = item.trade.action === 'buy' && !!item.trade.tokenId;
    if (isSell) {
      this.sellInFlight.add(item.trade.tokenId);
    }
    if (isBuy) {
      this.buyInFlight.add(item.trade.tokenId);
    }

    this.processor(item.trade)
      .finally(() => {
        if (isSell) {
          this.sellInFlight.delete(item.trade.tokenId);
        }
        if (isBuy) {
          this.buyInFlight.delete(item.trade.tokenId);
        }
        this.activeCount--;
        this.processNext();
      });
  }
}
