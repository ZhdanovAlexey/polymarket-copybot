import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { notifyError } from '../notifications/telegram.js';

const log = createLogger('health-checker');

export class HealthChecker {
  private consecutiveAuthFailures = 0;
  private halted = false;
  private lastClobPingOk = true;
  private lastClobPingAt = 0;
  private clobDownSince = 0;

  /**
   * Record outcome of an auth attempt.
   * After authMaxFailures consecutive failures, the bot is halted.
   */
  recordAuthResult(success: boolean): void {
    if (success) {
      this.consecutiveAuthFailures = 0;
    } else {
      this.consecutiveAuthFailures++;
      log.warn({ consecutiveAuthFailures: this.consecutiveAuthFailures }, 'Auth failure recorded');
      if (this.consecutiveAuthFailures >= config.authMaxFailures) {
        this.halt(`Auth failed ${this.consecutiveAuthFailures} consecutive times`);
      }
    }
  }

  isHalted(): boolean {
    return this.halted;
  }

  resume(): void {
    this.halted = false;
    this.consecutiveAuthFailures = 0;
    log.info('HealthChecker: bot resumed manually');
  }

  /**
   * Ping the CLOB /time endpoint to detect connectivity issues.
   * Called by the bot's healthCheckTimer.
   */
  async pingClob(clobHost: string): Promise<void> {
    const url = `${clobHost}/time`;
    this.lastClobPingAt = Date.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.ok) {
        if (!this.lastClobPingOk) {
          log.info({ url }, 'CLOB connectivity restored');
        }
        this.clobDownSince = 0;
        this.lastClobPingOk = true;
      } else {
        log.warn({ url, status: res.status }, 'CLOB ping returned non-OK status');
        this.handleClobDown();
      }
    } catch (err) {
      log.warn({ err, url }, 'CLOB ping failed');
      this.handleClobDown();
    }
  }

  getStatus(): {
    halted: boolean;
    consecutiveAuthFailures: number;
    lastClobPingOk: boolean;
    clobDownMs: number;
  } {
    return {
      halted: this.halted,
      consecutiveAuthFailures: this.consecutiveAuthFailures,
      lastClobPingOk: this.lastClobPingOk,
      clobDownMs: this.clobDownSince > 0 ? Date.now() - this.clobDownSince : 0,
    };
  }

  private handleClobDown(): void {
    this.lastClobPingOk = false;
    const now = Date.now();

    if (this.clobDownSince === 0) {
      this.clobDownSince = now;
      log.warn('CLOB appears down, starting downtime timer');
    }

    const downMs = now - this.clobDownSince;
    if (downMs > config.healthCheckAlertAfterMs) {
      const downSecs = Math.floor(downMs / 1000);
      log.error({ downSecs }, 'CLOB has been down for extended period');
      notifyError(`CLOB connectivity issue: down for ${downSecs}s`).catch(() => {/* ignore */});
    }
  }

  private halt(reason: string): void {
    this.halted = true;
    log.error({ reason }, 'Bot halted by HealthChecker');
    notifyError(`Bot halted: ${reason}`).catch(() => {/* ignore */});
  }
}
