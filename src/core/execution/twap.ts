import type { DetectedTrade, TwapOrder } from '../../types.js';
import { config } from '../../config.js';
import * as queries from '../../db/queries.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('twap');

export interface TwapPlan {
  parentTradeId: string;
  tokenId: string;
  conditionId: string;
  side: 'BUY' | 'SELL';
  totalUsd: number;
  slices: number;
  intervalMs: number;
  initialPrice: number;
  maxDriftPct: number;
}

export interface TwapResult {
  totalFilled: number;
  totalCancelled: number;
  avgPrice: number;
  slicesExecuted: number;
}

export class TwapExecutor {
  shouldUseTwap(totalUsd: number): boolean {
    return totalUsd > config.twapThresholdUsd && config.twapSlices > 1;
  }

  createPlan(trade: DetectedTrade, totalUsd: number, initialPrice: number): TwapPlan {
    return {
      parentTradeId: `twap-${trade.id}-${Date.now()}`,
      tokenId: trade.tokenId,
      conditionId: trade.conditionId,
      side: trade.action.toUpperCase() as 'BUY' | 'SELL',
      totalUsd,
      slices: config.twapSlices,
      intervalMs: config.twapIntervalSec * 1000,
      initialPrice,
      maxDriftPct: config.twapMaxDriftPct,
    };
  }

  async execute(
    plan: TwapPlan,
    getMidpoint: (tokenId: string) => Promise<number | null>,
    executeSlice: (
      sliceUsd: number,
      price: number,
      sliceNum: number,
    ) => Promise<{ success: boolean; executedPrice?: number; error?: string }>,
  ): Promise<TwapResult> {
    const sliceUsd = plan.totalUsd / plan.slices;

    // Insert pending rows upfront
    const sliceIds: number[] = [];
    for (let i = 0; i < plan.slices; i++) {
      const id = queries.insertTwapSlice({
        parentTradeId: plan.parentTradeId,
        tokenId: plan.tokenId,
        conditionId: plan.conditionId,
        side: plan.side,
        totalSlices: plan.slices,
        sliceNum: i,
        sliceUsd,
        sliceSize: null,
        status: 'pending',
        orderId: null,
        executedPrice: null,
        executedAt: null,
        initialPrice: plan.initialPrice,
        error: null,
      });
      sliceIds.push(id);
    }

    let totalFilled = 0;
    let totalCancelled = 0;
    let avgPriceSum = 0;
    let slicesExecuted = 0;
    let abortRest = false;

    for (let i = 0; i < plan.slices; i++) {
      if (abortRest) {
        queries.updateTwapSlice(sliceIds[i], { status: 'drift_stopped' });
        totalCancelled += sliceUsd;
        continue;
      }

      // Wait between slices (skip wait for first slice)
      if (i > 0) {
        await new Promise<void>((r) => setTimeout(r, plan.intervalMs));
      }

      // Get current midpoint
      const currentPrice = await getMidpoint(plan.tokenId);
      if (currentPrice === null || currentPrice === undefined) {
        queries.updateTwapSlice(sliceIds[i], { status: 'cancelled', error: 'No midpoint' });
        totalCancelled += sliceUsd;
        log.warn({ sliceNum: i, tokenId: plan.tokenId }, 'TWAP: no midpoint, slice cancelled');
        continue;
      }

      // Drift check vs initial price
      const drift = (Math.abs(currentPrice - plan.initialPrice) / plan.initialPrice) * 100;
      if (drift > plan.maxDriftPct) {
        log.warn(
          { drift: drift.toFixed(2), maxDrift: plan.maxDriftPct, sliceNum: i, parentTradeId: plan.parentTradeId },
          'TWAP drift exceeded, aborting remaining slices',
        );
        queries.updateTwapSlice(sliceIds[i], { status: 'drift_stopped', error: `Drift ${drift.toFixed(1)}%` });
        totalCancelled += sliceUsd;
        abortRest = true;
        continue;
      }

      queries.updateTwapSlice(sliceIds[i], { status: 'executing' });
      log.debug({ sliceNum: i, sliceUsd, price: currentPrice, drift: drift.toFixed(2) }, 'TWAP: executing slice');

      const res = await executeSlice(sliceUsd, currentPrice, i);
      if (res.success) {
        const execPrice = res.executedPrice ?? currentPrice;
        queries.updateTwapSlice(sliceIds[i], {
          status: 'filled',
          executedPrice: execPrice,
          executedAt: new Date().toISOString(),
        });
        totalFilled += sliceUsd;
        avgPriceSum += execPrice * sliceUsd;
        slicesExecuted++;
        log.debug({ sliceNum: i, execPrice, totalFilled }, 'TWAP: slice filled');
      } else {
        queries.updateTwapSlice(sliceIds[i], { status: 'cancelled', error: res.error ?? 'execution failed' });
        totalCancelled += sliceUsd;
        log.warn({ sliceNum: i, error: res.error }, 'TWAP: slice cancelled');
      }
    }

    const avgPrice = slicesExecuted > 0 && totalFilled > 0 ? avgPriceSum / totalFilled : 0;

    log.info(
      {
        parentTradeId: plan.parentTradeId,
        totalFilled,
        totalCancelled,
        avgPrice: avgPrice.toFixed(4),
        slicesExecuted,
      },
      'TWAP execution complete',
    );

    return { totalFilled, totalCancelled, avgPrice, slicesExecuted };
  }

  /**
   * On bot startup: cancel any TWAP slices that are still pending/executing
   * from a previous session (stale > 10 min).
   */
  async resumeIncomplete(): Promise<void> {
    const pending = queries.getPendingTwapSlices();
    const now = Date.now();
    const staleMs = 10 * 60 * 1000; // 10 minutes
    for (const slice of pending) {
      const created = new Date(slice.createdAt).getTime();
      if (now - created > staleMs) {
        queries.updateTwapSlice(slice.id, { status: 'cancelled', error: 'Stale after restart' });
        log.info({ sliceId: slice.id, parentTradeId: slice.parentTradeId }, 'TWAP: cancelled stale slice');
      }
    }
  }
}
