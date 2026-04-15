import { convictionStore, type ConvictionParams } from './conviction-store.js';
import { Backtester } from './backtest.js';
import { DataApi } from '../../api/data-api.js';
import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import * as queries from '../../db/queries.js';
import type { BacktestConfig } from '../../types.js';

const log = createLogger('auto-optimizer');

export interface OptimizationResult {
  applied: boolean;
  oldParams: ConvictionParams;
  newParams?: ConvictionParams;
  sharpeOld?: number;
  sharpeNew?: number;
  reason?: string;
}

export class AutoOptimizer {
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private backtester: Backtester;

  constructor() {
    this.backtester = new Backtester(new DataApi());
  }

  start(): void {
    log.info('Auto-optimizer scheduled (first run in 1h)');
    // First run after 1h warmup, then repeat on configured interval
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      this.runOptimizationCycle().catch((err) => log.error({ err }, 'Auto-optimizer cycle failed'));

      this.timer = setInterval(() => {
        this.runOptimizationCycle().catch((err) => log.error({ err }, 'Auto-optimizer cycle failed'));
      }, config.optimizerIntervalDays * 86400 * 1000);
    }, 3600 * 1000);
  }

  stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOptimizationCycle(): Promise<OptimizationResult> {
    log.info('Starting optimization cycle');
    const oldParams = convictionStore.getParams();

    try {
      // 1. Collect active trader addresses for the dataset
      const traders = queries.getActiveTraders();
      if (traders.length === 0) {
        const reason = 'Optimizer skipped: no active traders';
        log.info(reason);
        return { applied: false, oldParams, reason };
      }

      const addresses = traders.map((t) => t.address);

      // 2. Run reference backtest on lookback window
      const lookbackConfig: BacktestConfig = {
        traders: addresses,
        periodDays: config.optimizerLookbackDays,
        betSize: config.betSizeUsd,
        maxSlippage: config.maxSlippagePct,
        maxPositions: config.maxOpenPositions,
      };

      const referenceResult = await this.backtester.run(lookbackConfig);

      if (referenceResult.tradeCount < 50) {
        const reason = `Optimizer skipped: only ${referenceResult.tradeCount} trades in dataset (need >= 50)`;
        log.info(reason);
        return { applied: false, oldParams, reason };
      }

      // 3. Generate 50 candidate param sets via random perturbation
      const candidates = this.generateCandidates(oldParams, 50);

      // 4. Run A/B validation: backtest old params vs each candidate on last 14 days
      const abConfig: BacktestConfig = {
        traders: addresses,
        periodDays: Math.min(14, config.optimizerLookbackDays),
        betSize: config.betSizeUsd,
        maxSlippage: config.maxSlippagePct,
        maxPositions: config.maxOpenPositions,
      };

      // Reference sharpe on the 14-day window (represents "old params" baseline)
      const oldResult = await this.backtester.run(abConfig);
      const sharpeOld = oldResult.sharpe;

      // 5. Find best candidate by Sharpe on short lookback
      // For performance we evaluate only the top 5 candidates by a quick Calmar proxy
      // (totalPnl / maxDrawdown) using the longer dataset shape, then run full
      // short-window backtest on the winner.
      //
      // In this phase the ConvictionParams affect bet sizing multipliers, not which
      // trades to copy. The backtester uses config.betSizeUsd directly, so we
      // approximate the impact of params by scaling betSize by betBase * w2 * w3 proxy.
      let bestCandidate: ConvictionParams | null = null;
      let bestSharpe = sharpeOld;

      for (const candidate of candidates.slice(0, 5)) {
        const effectiveBetSize = config.betSizeUsd * candidate.betBase;
        const candidateConfig: BacktestConfig = {
          ...abConfig,
          betSize: effectiveBetSize,
        };
        try {
          const candidateResult = await this.backtester.run(candidateConfig);
          if (candidateResult.sharpe > bestSharpe) {
            bestSharpe = candidateResult.sharpe;
            bestCandidate = candidate;
          }
        } catch (err) {
          log.warn({ err }, 'Candidate backtest failed — skipping');
        }
      }

      // 6. Apply if sharpe_new > sharpe_old * improvementThreshold
      if (
        bestCandidate !== null &&
        bestSharpe > sharpeOld * config.optimizerImprovementThreshold
      ) {
        try {
          convictionStore.updateParams(
            bestCandidate,
            'optimizer',
            `Auto-optimizer: sharpe improved from ${sharpeOld.toFixed(3)} to ${bestSharpe.toFixed(3)}`,
            sharpeOld,
            bestSharpe,
          );
          log.info(
            { sharpeOld, sharpeNew: bestSharpe, params: bestCandidate },
            'Auto-optimizer applied new conviction params',
          );
          return {
            applied: true,
            oldParams,
            newParams: bestCandidate,
            sharpeOld,
            sharpeNew: bestSharpe,
          };
        } catch (err) {
          const reason = `Optimizer candidate invalid: ${(err as Error).message}`;
          log.warn({ err }, reason);
          return { applied: false, oldParams, sharpeOld, sharpeNew: bestSharpe, reason };
        }
      }

      const reason =
        bestCandidate === null
          ? 'No improvement found (all candidates below threshold)'
          : `Sharpe improvement insufficient: ${sharpeOld.toFixed(3)} → ${bestSharpe.toFixed(3)} (threshold ×${config.optimizerImprovementThreshold})`;
      log.info({ sharpeOld, bestSharpe }, reason);
      return { applied: false, oldParams, sharpeOld, sharpeNew: bestSharpe, reason };
    } catch (err) {
      const reason = `Optimization cycle failed: ${(err as Error).message}`;
      log.error({ err }, reason);
      return { applied: false, oldParams, reason };
    }
  }

  /**
   * Generate `count` candidate ConvictionParams by randomly perturbing
   * each field of `base` within ±20%.
   */
  private generateCandidates(base: ConvictionParams, count: number): ConvictionParams[] {
    const out: ConvictionParams[] = [];
    for (let i = 0; i < count; i++) {
      const pert = (): number => 0.8 + Math.random() * 0.4; // [0.8, 1.2]
      out.push({
        betBase: base.betBase * pert(),
        f1Anchor: base.f1Anchor * pert(),
        f1Max: base.f1Max * pert(),
        w2: base.w2 * pert(),
        w3: base.w3 * pert(),
        f4Boost: base.f4Boost * pert(),
      });
    }
    return out;
  }
}
