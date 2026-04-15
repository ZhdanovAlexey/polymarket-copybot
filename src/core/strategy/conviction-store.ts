import type { ConvictionParamsRow } from '../../types.js';
import * as queries from '../../db/queries.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('conviction-store');

export interface ConvictionParams {
  betBase: number;
  f1Anchor: number;
  f1Max: number;
  w2: number;
  w3: number;
  f4Boost: number;
}

export interface BoundsCheck {
  valid: boolean;
  violations: string[];
}

const BOUNDS: Record<keyof ConvictionParams, [number, number]> = {
  betBase: [0.5, 3.0],
  f1Anchor: [5, 1000],
  f1Max: [2, 10],
  w2: [0, 1.0],
  w3: [0, 1.5],
  f4Boost: [1.0, 3.0],
};

class ConvictionStore {
  private cached: ConvictionParams | null = null;

  getParams(): ConvictionParams {
    if (this.cached) return this.cached;
    const row: ConvictionParamsRow = queries.getConvictionParams();
    this.cached = {
      betBase: row.betBase,
      f1Anchor: row.f1Anchor,
      f1Max: row.f1Max,
      w2: row.w2,
      w3: row.w3,
      f4Boost: row.f4Boost,
    };
    return this.cached;
  }

  validateBounds(params: ConvictionParams): BoundsCheck {
    const violations: string[] = [];
    for (const [key, [min, max]] of Object.entries(BOUNDS) as Array<[keyof ConvictionParams, [number, number]]>) {
      const v = params[key];
      if (v < min || v > max) violations.push(`${key}=${v} not in [${min}, ${max}]`);
    }
    return { valid: violations.length === 0, violations };
  }

  updateParams(
    params: ConvictionParams,
    source: 'manual' | 'optimizer',
    reason?: string,
    sharpeOld?: number,
    sharpeNew?: number,
  ): void {
    const check = this.validateBounds(params);
    if (!check.valid) {
      throw new Error(`Conviction params out of bounds: ${check.violations.join(', ')}`);
    }
    // Atomic: insert history + update singleton + invalidate cache
    queries.insertConvictionHistory({ ...params, source, reason, sharpeOld, sharpeNew });
    queries.updateConvictionParams({ ...params, source });
    this.cached = null; // invalidate
    log.info({ source, reason, params }, 'Conviction params updated');
  }

  invalidate(): void {
    this.cached = null;
  }
}

export const convictionStore = new ConvictionStore();
