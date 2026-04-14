import { initDb, closeDb } from '../db/database.js';
import { DataApi } from '../api/data-api.js';
import { GammaApi } from '../api/gamma-api.js';
import { ClobClientWrapper } from '../api/clob-client.js';
import { createLogger } from '../utils/logger.js';
import { collectUniverse } from './collect/universe.js';
import { collectActivity } from './collect/activity.js';
import { collectMarkets } from './collect/markets.js';
import { collectResolutions } from './collect/resolutions.js';
import type { CollectHistoryOptions } from '../types.js';

const log = createLogger('collect-history');

const VALID_PHASES = ['universe', 'activity', 'markets', 'resolutions'] as const;
type Phase = typeof VALID_PHASES[number];

export function parseArgs(argv: string[]): CollectHistoryOptions {
  let size = 300;
  let days = 365;
  let rate = 250;
  let maxTrades = 10000;
  let phases: Phase[] = [...VALID_PHASES];

  for (const a of argv) {
    if (a.startsWith('--size=')) size = Number(a.slice(7));
    else if (a.startsWith('--days=')) days = Number(a.slice(7));
    else if (a.startsWith('--rate=')) rate = Number(a.slice(7));
    else if (a.startsWith('--max-trades=')) maxTrades = Number(a.slice(13));
    else if (a.startsWith('--phase=')) {
      const requested = a.slice(8).split(',').map((s) => s.trim());
      for (const p of requested) {
        if (!VALID_PHASES.includes(p as Phase)) {
          throw new Error(`unknown phase: ${p}. Valid: ${VALID_PHASES.join(',')}`);
        }
      }
      phases = requested as Phase[];
    }
  }

  return { universeSize: size, historyDays: days, ratePauseMs: rate, maxTradesPerTrader: maxTrades, phases };
}

export async function runCollectHistory(opts: CollectHistoryOptions): Promise<void> {
  const dataApi = new DataApi();
  const gammaApi = new GammaApi();
  const clob = new ClobClientWrapper();

  const historyStartTs =
    Math.floor(Date.now() / 1000) - opts.historyDays * 24 * 60 * 60;

  if (opts.phases.includes('universe')) {
    log.info('--- Phase 1: universe ---');
    await collectUniverse({
      fetchLeaderboard: dataApi.getLeaderboard.bind(dataApi),
      size: opts.universeSize,
    });
  }

  if (opts.phases.includes('activity')) {
    log.info('--- Phase 2: activity ---');
    await collectActivity({
      fetchActivity: dataApi.getActivity.bind(dataApi),
      historyStartTs,
      pageLimit: 500,
      ratePauseMs: opts.ratePauseMs,
      maxTradesPerTrader: opts.maxTradesPerTrader,
    });
  }

  if (opts.phases.includes('markets')) {
    log.info('--- Phase 3: markets + resolutions (via CLOB) ---');
    await collectMarkets({
      fetchMarket: clob.getMarketFull.bind(clob),
      ratePauseMs: opts.ratePauseMs,
    });
  }

  if (opts.phases.includes('resolutions')) {
    // Phase 4 is now a no-op for fresh runs (Phase 3 writes resolutions too).
    // Kept for backward compat: picks up any closed markets whose resolution
    // was missed (e.g., market closed AFTER Phase 3 ran).
    log.info('--- Phase 4: resolutions (catch-up) ---');
    await collectResolutions({
      fetchResolution: clob.getMarketResolution.bind(clob),
      ratePauseMs: opts.ratePauseMs,
    });
  }
}

// Entry point (executed when run via `tsx src/cli/collect-history.ts`)
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  log.info(opts, 'Starting collect-history');
  initDb();
  runCollectHistory(opts)
    .then(() => {
      log.info('collect-history complete');
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      log.error({ err: String(err) }, 'collect-history failed');
      closeDb();
      process.exit(1);
    });
}
