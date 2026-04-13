import { createLogger } from '../../utils/logger.js';
import { sleep } from '../../utils/helpers.js';
import {
  closedConditionIdsMissingResolution,
  upsertResolution,
} from '../../db/bt-queries.js';
import { Progress } from './progress.js';

const log = createLogger('collect-resolutions');

export interface ResolutionsOptions {
  fetchResolution: (
    conditionId: string,
  ) => Promise<{ closed: boolean; winnerTokenId: string | null }>;
  ratePauseMs: number;
}

export async function collectResolutions(opts: ResolutionsOptions): Promise<void> {
  const cids = closedConditionIdsMissingResolution();
  log.info({ toFetch: cids.length }, 'Fetching resolutions for closed markets');
  const progress = new Progress('resolutions', cids.length);

  for (const cid of cids) {
    try {
      const res = await opts.fetchResolution(cid);
      if (res.closed) {
        upsertResolution({
          conditionId: cid,
          winnerTokenId: res.winnerTokenId,
          resolvedAt: '',
        });
      } else {
        log.warn({ cid }, 'Market marked closed in bt_markets but CLOB says still open — skipping');
      }
    } catch (err) {
      log.warn({ cid, err: String(err) }, 'Resolution fetch failed');
    }
    if (opts.ratePauseMs > 0) await sleep(opts.ratePauseMs);
    progress.tick();
  }
}
