import { EventEmitter } from 'node:events';
import { DataApi } from '../api/data-api.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';
import * as queries from '../db/queries.js';
import type { TrackedTrader, DetectedTrade, ActivityEntry } from '../types.js';

const log = createLogger('tracker');

export interface TrackerEvents {
  newTrade: (trade: DetectedTrade) => void;
  error: (error: Error) => void;
  pollComplete: (stats: { checked: number; newTrades: number }) => void;
}

export class Tracker extends EventEmitter {
  private dataApi: DataApi;
  private traders: Map<string, TrackedTrader> = new Map();
  private seenTxHashes: Set<string> = new Set();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;

  constructor(dataApi?: DataApi) {
    super();
    this.dataApi = dataApi ?? new DataApi();
  }

  /**
   * Initialize tracker with list of traders
   */
  initialize(traders: TrackedTrader[]): void {
    this.traders.clear();
    for (const trader of traders) {
      this.traders.set(trader.address, trader);
    }
    log.info({ count: traders.length }, 'Tracker initialized');
  }

  /**
   * Add a trader to tracking
   */
  addTrader(trader: TrackedTrader): void {
    this.traders.set(trader.address, trader);
    log.info({ address: trader.address, name: trader.name }, 'Trader added to tracking');
  }

  /**
   * Remove a trader from tracking
   */
  removeTrader(address: string): void {
    this.traders.delete(address);
    log.info({ address }, 'Trader removed from tracking');
  }

  /**
   * Single poll cycle: check all traders for new activity
   */
  async pollOnce(): Promise<{ checked: number; newTrades: number }> {
    if (this.isPolling) {
      log.warn('Poll already in progress, skipping');
      return { checked: 0, newTrades: 0 };
    }

    this.isPolling = true;
    let totalNewTrades = 0;
    let checked = 0;

    try {
      for (const [address, trader] of this.traders) {
        try {
          const activities = await this.dataApi.getActivity(address, {
            type: 'TRADE',
            start: trader.lastSeenTimestamp + 1,
            sortBy: 'TIMESTAMP',
            sortDirection: 'ASC',
          });

          for (const activity of activities) {
            // Deduplication
            if (this.seenTxHashes.has(activity.transaction_hash)) continue;
            if (activity.timestamp <= trader.lastSeenTimestamp) continue;

            this.seenTxHashes.add(activity.transaction_hash);

            const detected: DetectedTrade = {
              id: activity.id,
              timestamp: activity.timestamp,
              traderAddress: address,
              traderName: trader.name,
              action: activity.action === 'sell' ? 'sell' : 'buy',
              marketSlug: activity.market_slug,
              marketTitle: activity.title,
              conditionId: activity.condition_id,
              tokenId: activity.token_id,
              outcome: activity.outcome,
              size: activity.size,
              price: activity.price,
              usdValue: activity.usd_value,
              transactionHash: activity.transaction_hash,
            };

            log.info({
              trader: trader.name,
              action: detected.action,
              market: detected.marketTitle,
              price: detected.price,
              size: detected.size,
            }, 'New trade detected');

            this.emit('newTrade', detected);
            totalNewTrades++;
          }

          // Update last-seen timestamp
          if (activities.length > 0) {
            const latestTs = Math.max(...activities.map(a => a.timestamp));
            trader.lastSeenTimestamp = latestTs;
            // Persist to DB
            queries.upsertTrader(trader);
          }

          checked++;

          // Small delay between traders to respect rate limits
          await sleep(500);

        } catch (err) {
          log.error({ address, err }, 'Error polling trader activity');
          this.emit('error', err instanceof Error ? err : new Error(String(err)));
        }
      }

      log.debug({ checked, newTrades: totalNewTrades }, 'Poll cycle complete');
      this.emit('pollComplete', { checked, newTrades: totalNewTrades });
    } finally {
      this.isPolling = false;
    }

    // Trim seen hashes set to prevent memory leak (keep last 5000)
    if (this.seenTxHashes.size > 10000) {
      const arr = [...this.seenTxHashes];
      this.seenTxHashes = new Set(arr.slice(-5000));
    }

    return { checked, newTrades: totalNewTrades };
  }

  /**
   * Start continuous polling
   */
  startPolling(): void {
    if (this.pollTimer) {
      log.warn('Polling already running');
      return;
    }

    log.info({ intervalMs: config.pollIntervalMs }, 'Starting trade polling');

    // Run immediately
    this.pollOnce().catch(err => {
      log.error({ err }, 'Initial poll failed');
    });

    // Then on interval
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch(err => {
        log.error({ err }, 'Poll cycle failed');
      });
    }, config.pollIntervalMs);
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      log.info('Polling stopped');
    }
  }

  /**
   * Get current tracker state
   */
  getState(): { tradersCount: number; isPolling: boolean; seenCount: number } {
    return {
      tradersCount: this.traders.size,
      isPolling: this.pollTimer !== null,
      seenCount: this.seenTxHashes.size,
    };
  }

  /**
   * Get list of currently tracked traders
   */
  getTrackedTraders(): TrackedTrader[] {
    return Array.from(this.traders.values());
  }
}
