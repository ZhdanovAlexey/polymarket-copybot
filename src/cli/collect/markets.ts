import { createLogger } from '../../utils/logger.js';
import { sleep } from '../../utils/helpers.js';
import {
  conditionIdsMissingFromMarkets,
  upsertMarket,
  upsertResolution,
} from '../../db/bt-queries.js';
import { Progress } from './progress.js';
import type { BtMarket } from '../../types.js';

const log = createLogger('collect-markets');

/**
 * Raw shape returned by CLOB `/markets/{conditionId}`.
 * Only the fields we care about.
 */
export interface ClobMarketRaw {
  condition_id: string;
  question: string;
  market_slug: string;
  end_date_iso?: string;
  closed: boolean;
  neg_risk: boolean;
  tokens: Array<{ token_id: string; outcome: string; winner: boolean }>;
}

export interface MarketsOptions {
  /** Fetcher returning raw CLOB market shape, or null if not found. */
  fetchMarket: (conditionId: string) => Promise<ClobMarketRaw | null>;
  ratePauseMs: number;
}

/**
 * Phase 3+4 combined: for each missing conditionId, fetch from CLOB
 * and write both bt_markets metadata AND bt_market_resolutions (if closed+winner).
 */
export async function collectMarkets(opts: MarketsOptions): Promise<void> {
  const cids = conditionIdsMissingFromMarkets();
  log.info({ toFetch: cids.length }, 'Fetching missing market metadata from CLOB');
  const progress = new Progress('markets', cids.length);

  for (const cid of cids) {
    try {
      const raw = await opts.fetchMarket(cid);
      if (raw !== null) {
        upsertMarket(toBtMarket(raw));

        // Also write resolution if market is closed and has a winner
        if (raw.closed) {
          const winner = (raw.tokens ?? []).find((t) => t.winner === true);
          upsertResolution({
            conditionId: cid,
            winnerTokenId: winner?.token_id ?? null,
            resolvedAt: '',
          });
        }
      } else {
        log.debug({ cid }, 'CLOB returned null for conditionId');
      }
    } catch (err) {
      log.warn({ cid, err: String(err) }, 'Market fetch failed');
    }
    if (opts.ratePauseMs > 0) await sleep(opts.ratePauseMs);
    progress.tick();
  }
}

function toBtMarket(raw: ClobMarketRaw): BtMarket {
  return {
    conditionId: raw.condition_id,
    question: raw.question,
    slug: raw.market_slug,
    endDate: raw.end_date_iso ?? null,
    volume: 0,    // CLOB doesn't return volume; 0 placeholder
    liquidity: 0, // CLOB doesn't return liquidity; 0 placeholder
    negRisk: raw.neg_risk ? 1 : 0,
    closed: raw.closed ? 1 : 0,
    tokenIds: JSON.stringify((raw.tokens ?? []).map((t) => t.token_id)),
  };
}
