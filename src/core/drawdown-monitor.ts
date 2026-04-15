import * as queries from '../db/queries.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('drawdown-monitor');

export interface DrawdownCheckResult {
  equity: number;
  peak: number;
  drawdownPct: number;
  threshold: number;
  paused: boolean;
  pausedAt?: string;
}

export class DrawdownMonitor {
  /**
   * Record the current equity snapshot and check if rolling drawdown
   * exceeds the configured threshold (adaptive or fixed).
   * Call this on every MTM tick (~60s).
   */
  checkDrawdown(currentEquity: number): DrawdownCheckResult {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    // Persist snapshot
    queries.insertEquitySnapshot(currentEquity, 'auto');

    // Rolling window: peak over last rollingDdWindowDays
    const windowStartSec = nowSec - config.rollingDdWindowDays * 86400;
    // getEquityPeakSince expects unix ms in the current schema
    const windowStartMs = windowStartSec * 1000;
    const peak = queries.getEquityPeakSince(windowStartMs);
    const effectivePeak = Math.max(peak, currentEquity);

    const dd = effectivePeak > 0 ? ((effectivePeak - currentEquity) / effectivePeak) * 100 : 0;

    let threshold = config.rollingDdPct;
    if (config.rollingDdAdaptive) {
      threshold = this.computeAdaptiveThreshold(currentEquity);
    }

    const alreadyPaused = this.isPaused();

    if (!alreadyPaused && dd > threshold) {
      this.pause(dd, threshold, currentEquity);
      return {
        equity: currentEquity,
        peak: effectivePeak,
        drawdownPct: dd,
        threshold,
        paused: true,
        pausedAt: new Date().toISOString(),
      };
    }

    return { equity: currentEquity, peak: effectivePeak, drawdownPct: dd, threshold, paused: alreadyPaused };
  }

  /**
   * Check if the auto-unpause time has arrived and unpause if so.
   * Returns true if an unpause actually happened.
   */
  checkUnpause(): boolean {
    if (!this.isPaused()) return false;
    const unpauseAtStr = queries.getSetting('drawdown_unpause_at');
    if (!unpauseAtStr) return false;
    const unpauseAt = new Date(unpauseAtStr).getTime();
    if (Date.now() > unpauseAt) {
      this.unpause('Auto-unpause: unpause time reached');
      return true;
    }
    return false;
  }

  /**
   * Compute EWMA-based adaptive threshold.
   * Baseline = rollingDdPct; expands by up to 50% of baseline when
   * equity volatility (std dev) is high.
   */
  private computeAdaptiveThreshold(currentEquity: number): number {
    const nowSec = Math.floor(Date.now() / 1000);
    const lookbackStartMs = (nowSec - config.rollingDdEwmaSpan * 86400) * 1000;
    const snapshots = queries.getEquitySnapshotsSince(lookbackStartMs);

    if (snapshots.length < 10) return config.rollingDdPct;

    const alpha = 2 / (config.rollingDdEwmaSpan + 1);
    let mean = snapshots[0]!.equityUsd;
    let varEwma = 0;

    for (let i = 1; i < snapshots.length; i++) {
      const delta = snapshots[i]!.equityUsd - mean;
      mean = mean + alpha * delta;
      varEwma = (1 - alpha) * (varEwma + alpha * delta * delta);
    }

    const std = Math.sqrt(varEwma);
    const volPct = currentEquity > 0 ? (std / currentEquity) * 100 : 0;
    const extra = Math.min(config.rollingDdPct * 0.5, volPct);
    return config.rollingDdPct + extra;
  }

  private pause(dd: number, threshold: number, equity: number): void {
    const pausedAt = new Date().toISOString();
    const unpauseAt = new Date(Date.now() + config.unpauseAfterHours * 3600 * 1000).toISOString();
    queries.setSetting('drawdown_paused', 'true');
    queries.setSetting('drawdown_paused_at', pausedAt);
    queries.setSetting('drawdown_unpause_at', unpauseAt);
    log.warn(
      {
        drawdownPct: dd.toFixed(2),
        threshold: threshold.toFixed(2),
        equity: equity.toFixed(2),
        pausedAt,
        unpauseAt,
      },
      'DRAWDOWN PAUSE: new buys blocked',
    );
  }

  unpause(reason: string): void {
    queries.setSetting('drawdown_paused', 'false');
    queries.setSetting('drawdown_paused_at', '');
    queries.setSetting('drawdown_unpause_at', '');
    log.info({ reason }, 'DRAWDOWN UNPAUSE: trading resumed');
  }

  isPaused(): boolean {
    return queries.getSetting('drawdown_paused') === 'true';
  }
}
