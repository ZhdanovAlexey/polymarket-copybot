import { createLogger } from '../../utils/logger.js';

const log = createLogger('collect-progress');

export interface ProgressSnapshot {
  phase: string;
  completed: number;
  total: number;
  percent: number;
  elapsedMs: number;
}

export class Progress {
  private completed = 0;
  private readonly startedAt = Date.now();
  private lastLoggedPercent = -1;

  constructor(
    private readonly phase: string,
    private readonly total: number,
  ) {}

  tick(n = 1): void {
    this.completed += n;
    const snap = this.snapshot();
    // Log every 5% change (avoid log spam for 10k-item loops).
    if (snap.percent - this.lastLoggedPercent >= 5 || snap.completed === this.total) {
      this.lastLoggedPercent = snap.percent;
      log.info(snap, `${this.phase} progress`);
    }
  }

  snapshot(): ProgressSnapshot {
    const percent = this.total > 0 ? Math.floor((this.completed / this.total) * 100) : 0;
    return {
      phase: this.phase,
      completed: this.completed,
      total: this.total,
      percent,
      elapsedMs: Date.now() - this.startedAt,
    };
  }
}
