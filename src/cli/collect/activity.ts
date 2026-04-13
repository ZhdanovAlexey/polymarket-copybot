import { createLogger } from '../../utils/logger.js';
import { sleep } from '../../utils/helpers.js';
import {
  listUniverse,
  bulkInsertActivity,
  maxActivityTimestamp,
} from '../../db/bt-queries.js';
import { Progress } from './progress.js';
import type { ActivityEntry, BtTradeActivity } from '../../types.js';

const log = createLogger('collect-activity');

type FetchActivityFn = (
  address: string,
  opts?: {
    type?: string;
    start?: number;
    sortBy?: string;
    sortDirection?: string;
    limit?: number;
  },
) => Promise<ActivityEntry[]>;

export interface ActivityOptions {
  fetchActivity: FetchActivityFn;
  historyStartTs: number;  // earliest timestamp to fetch if no resume row exists
  pageLimit: number;       // e.g. 500
  ratePauseMs: number;     // delay between API calls
}

export async function collectActivity(opts: ActivityOptions): Promise<void> {
  const universe = listUniverse();
  log.info({ traders: universe.length }, 'Starting activity collection');
  const progress = new Progress('activity', universe.length);

  for (const entry of universe) {
    try {
      await collectOne(entry.address, opts);
    } catch (err) {
      log.warn({ address: entry.address, err: String(err) }, 'Activity collection failed for trader');
    }
    progress.tick();
  }
}

async function collectOne(address: string, opts: ActivityOptions): Promise<void> {
  const resumeFrom = maxActivityTimestamp(address);
  let start = resumeFrom !== null ? resumeFrom + 1 : opts.historyStartTs;

  while (true) {
    const page = await opts.fetchActivity(address, {
      type: 'TRADE',
      start,
      sortBy: 'TIMESTAMP',
      sortDirection: 'ASC',
      limit: opts.pageLimit,
    });

    if (opts.ratePauseMs > 0) await sleep(opts.ratePauseMs);

    if (page.length === 0) break;

    const rows: BtTradeActivity[] = [];
    let maxTs = start;
    for (const a of page) {
      if (a.type !== 'TRADE') continue;
      const action = a.action?.toLowerCase();
      if (action !== 'buy' && action !== 'sell') continue;
      rows.push({
        id: a.id,
        address,
        timestamp: a.timestamp,
        tokenId: a.token_id,
        conditionId: a.condition_id,
        action,
        price: a.price,
        size: a.size,
        usdValue: a.usd_value,
        marketSlug: a.market_slug,
      });
      if (a.timestamp > maxTs) maxTs = a.timestamp;
    }

    if (rows.length > 0) bulkInsertActivity(rows);
    log.debug({ address, pageSize: page.length, inserted: rows.length, start }, 'Activity page processed');

    // If page was not full, we've reached the end.
    if (page.length < opts.pageLimit) break;

    // Seek forward.
    start = maxTs + 1;
  }
}
