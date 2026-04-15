import type { ActivityEntry } from '../../types.js';
import type { DataApi } from '../../api/data-api.js';
import * as queries from '../../db/queries.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('correlation');

export interface CorrelationMatrix {
  pairs: Map<string, number>;
}

export class TraderCorrelation {
  constructor(private dataApi: DataApi) {}

  /**
   * Jaccard similarity: |intersection| / |union| over conditionId sets.
   */
  computeJaccard(conditionIdsA: Set<string>, conditionIdsB: Set<string>): number {
    if (conditionIdsA.size === 0 && conditionIdsB.size === 0) return 0;

    const union = new Set<string>([...conditionIdsA]);
    let intersectionSize = 0;
    for (const id of conditionIdsB) {
      union.add(id);
      if (conditionIdsA.has(id)) intersectionSize++;
    }
    if (union.size === 0) return 0;
    return intersectionSize / union.size;
  }

  /**
   * Fetch recent activity for each address, compute pairwise Jaccard similarity,
   * persist to DB, and return the full matrix.
   * Rate-limited to 250 ms between API calls.
   */
  async computeCorrelationMatrix(addresses: string[]): Promise<CorrelationMatrix> {
    const traderConditions = new Map<string, Set<string>>();

    for (const addr of addresses) {
      try {
        const activity: ActivityEntry[] = await this.dataApi.getActivity(addr, {
          type: 'TRADE',
          limit: 100,
        });
        const conds = new Set<string>();
        for (const a of activity) {
          const cid = a.condition_id;
          if (cid) conds.add(cid);
        }
        traderConditions.set(addr, conds);
        log.debug({ addr, conditions: conds.size }, 'Activity fetched for correlation');
      } catch (err) {
        log.warn({ err, addr }, 'Activity fetch failed for correlation — trader excluded');
      }
      // Rate-limit between fetches
      await new Promise<void>((r) => setTimeout(r, 250));
    }

    const pairs = new Map<string, number>();
    const sorted = [...addresses].sort();

    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]!;
        const b = sorted[j]!;
        const corr = this.computeJaccard(
          traderConditions.get(a) ?? new Set(),
          traderConditions.get(b) ?? new Set(),
        );
        pairs.set(`${a}:${b}`, corr);
        queries.upsertTraderCorrelation(a, b, corr);
      }
    }

    log.info({ traders: sorted.length, pairs: pairs.size }, 'Correlation matrix computed');
    return { pairs };
  }

  /**
   * Greedy diversified selection.
   * Iterates candidates (pre-sorted by score DESC) and adds a candidate only
   * if its Jaccard correlation with every already-selected trader is below
   * the configured threshold.
   */
  selectDiversified<T extends { address: string }>(
    candidates: T[],
    maxN: number,
    matrix: CorrelationMatrix,
    threshold: number,
  ): T[] {
    const selected: T[] = [];

    for (const c of candidates) {
      if (selected.length >= maxN) break;

      let ok = true;
      for (const s of selected) {
        // Matrix keys are sorted: min(a,b):max(a,b)
        const [ka, kb] = [c.address, s.address].sort();
        const key = `${ka}:${kb}`;
        const corr = matrix.pairs.get(key) ?? 0;
        if (corr >= threshold) {
          log.info(
            { candidate: c.address, selected: s.address, correlation: corr.toFixed(3), threshold },
            'Skip correlated candidate',
          );
          ok = false;
          break;
        }
      }

      if (ok) selected.push(c);
    }

    return selected;
  }
}
