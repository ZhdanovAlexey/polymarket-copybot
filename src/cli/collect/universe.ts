import { createLogger } from '../../utils/logger.js';
import { upsertUniverseEntries } from '../../db/bt-queries.js';
import type { LeaderboardEntry, BtUniverseEntry } from '../../types.js';

const log = createLogger('collect-universe');

export interface UniverseOptions {
  /** Injected fetcher — production passes `dataApi.getLeaderboard.bind(dataApi)`. */
  fetchLeaderboard: (
    period?: string,
    orderBy?: string,
    limit?: number,
  ) => Promise<LeaderboardEntry[]>;
  size: number;
}

export async function collectUniverse(opts: UniverseOptions): Promise<void> {
  log.info({ size: opts.size }, 'Fetching universe (top-N by PnL, all-time)');

  const raw = await opts.fetchLeaderboard('all', 'pnl', opts.size);
  log.info({ received: raw.length }, 'Universe leaderboard response');

  const entries: BtUniverseEntry[] = raw.map((e) => ({
    address: e.address,
    name: e.name || 'Unknown',
    volume12m: e.volume,
    addedAt: '',
  }));

  upsertUniverseEntries(entries);
  log.info({ inserted: entries.length }, 'Universe saved');
}
