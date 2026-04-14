import { initDb, closeDb } from '../db/database.js';
import { createLogger } from '../utils/logger.js';
import { generateId } from '../utils/helpers.js';
import { loadDataset } from '../core/strategy/data-loader.js';
import { runBacktest } from '../core/strategy/backtester.js';
import { generateLHS, generateFineGrid } from '../core/strategy/grid-params.js';
import { insertGridRun, topGridRuns } from '../db/bt-queries.js';
import type { BacktestSimConfig, GridRunResult } from '../types.js';

const log = createLogger('grid-search');

function parseArgs(argv: string[]): { preset: 'coarse' | 'fine'; startDate: string; endDate: string; n?: number } {
  let preset: 'coarse' | 'fine' = 'coarse';
  let startDate = '2025-04-14';
  let endDate = '2026-04-13';
  let n: number | undefined;

  for (const a of argv) {
    if (a.startsWith('--preset=')) preset = a.slice(9) as 'coarse' | 'fine';
    else if (a.startsWith('--period=')) {
      const [s, e] = a.slice(9).split(':');
      if (s) startDate = s;
      if (e) endDate = e;
    }
    else if (a.startsWith('--n=')) n = Number(a.slice(4));
  }
  return { preset, startDate, endDate, n };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startTs = Math.floor(new Date(args.startDate).getTime() / 1000);
  const endTs = Math.floor(new Date(args.endDate).getTime() / 1000);
  const runId = `${args.preset}_${generateId().slice(0, 8)}`;

  log.info({ ...args, runId, startTs, endTs }, 'Starting grid search');
  initDb();

  const ds = loadDataset();

  let configs: BacktestSimConfig[];
  if (args.preset === 'coarse') {
    configs = generateLHS(args.n ?? 300);
    log.info({ points: configs.length }, 'Generated LHS coarse grid');
  } else {
    const winners = topGridRuns(20);
    if (winners.length === 0) {
      log.error('No coarse results found. Run --preset=coarse first.');
      closeDb();
      process.exit(1);
    }
    const winnerConfigs = winners.map((w) => JSON.parse(w.paramsJson) as BacktestSimConfig);
    configs = generateFineGrid(winnerConfigs);
    log.info({ points: configs.length, basedOn: winners.length }, 'Generated fine grid');
  }

  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i]!;
    const result = runBacktest(ds, cfg, startTs, endTs);

    const row: GridRunResult = {
      id: generateId(),
      runId,
      paramsJson: JSON.stringify(cfg),
      calmar: result.calmar === Infinity ? 9999 : result.calmar,
      pnl: result.totalPnl,
      maxDd: result.maxDrawdown,
      sharpe: result.sharpe,
      winRate: result.winRate,
      tradeCount: result.tradeCount,
      avgTtrDays: result.avgTtrDays,
      ranAt: '',
    };
    insertGridRun(row);

    if ((i + 1) % 10 === 0 || i === configs.length - 1) {
      log.info({
        progress: `${i + 1}/${configs.length}`,
        calmar: result.calmar === Infinity ? '∞' : result.calmar.toFixed(2),
        pnl: result.totalPnl.toFixed(2),
      }, 'Grid point evaluated');
    }
  }

  // Print top-20
  const top = topGridRuns(20, runId);
  log.info('=== Top 20 by Calmar ===');
  for (const r of top) {
    log.info({
      calmar: r.calmar.toFixed(2), pnl: r.pnl.toFixed(2), maxDd: r.maxDd.toFixed(1),
      sharpe: r.sharpe.toFixed(2), winRate: (r.winRate * 100).toFixed(1) + '%',
      trades: r.tradeCount,
    }, JSON.parse(r.paramsJson).topN + ' traders');
  }

  closeDb();
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    log.error({ err: String(err) }, 'Grid search failed');
    closeDb();
    process.exit(1);
  });
}
