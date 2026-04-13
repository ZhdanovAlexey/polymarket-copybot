import { createLogger } from '../../utils/logger.js';
import { sleep } from '../../utils/helpers.js';
import {
  conditionIdsMissingFromMarkets,
  upsertMarket,
} from '../../db/bt-queries.js';
import { Progress } from './progress.js';
import type { GammaMarket, BtMarket } from '../../types.js';

const log = createLogger('collect-markets');

export interface MarketsOptions {
  fetchMarket: (conditionId: string) => Promise<GammaMarket | null>;
  ratePauseMs: number;
}

export async function collectMarkets(opts: MarketsOptions): Promise<void> {
  const cids = conditionIdsMissingFromMarkets();
  log.info({ toFetch: cids.length }, 'Fetching missing market metadata');
  const progress = new Progress('markets', cids.length);

  for (const cid of cids) {
    try {
      const m = await opts.fetchMarket(cid);
      if (m !== null) {
        upsertMarket(toBtMarket(m));
      } else {
        log.debug({ cid }, 'Gamma returned null for conditionId');
      }
    } catch (err) {
      log.warn({ cid, err: String(err) }, 'Market fetch failed');
    }
    if (opts.ratePauseMs > 0) await sleep(opts.ratePauseMs);
    progress.tick();
  }
}

function toBtMarket(m: GammaMarket): BtMarket {
  return {
    conditionId: m.conditionId,
    question: m.question,
    slug: m.slug,
    endDate: m.endDate ?? null,
    volume: m.volume,
    liquidity: m.liquidity,
    negRisk: m.negRisk ? 1 : 0,
    closed: m.closed ? 1 : 0,
    tokenIds: JSON.stringify((m.tokens ?? []).map((t) => t.token_id)),
  };
}
