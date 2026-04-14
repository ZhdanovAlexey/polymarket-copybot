import { initDb, closeDb } from '../db/database.js';
import { createLogger } from '../utils/logger.js';
import { generateId } from '../utils/helpers.js';
import { loadDataset } from '../core/strategy/data-loader.js';
import { runBacktest } from '../core/strategy/backtester.js';
import { topGridRuns, insertWalkForwardRun, topWalkForwardRuns } from '../db/bt-queries.js';
import type { BacktestSimConfig, WalkForwardResult } from '../types.js';

const log = createLogger('walk-forward');
const DAY = 86400;
const MONTH = 30 * DAY;

interface Fold {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
}

function generateFolds(dataStartTs: number, dataEndTs: number): Fold[] {
  const trainDuration = 6 * MONTH;
  const testDuration = MONTH;
  const folds: Fold[] = [];

  let trainStart = dataStartTs;
  while (trainStart + trainDuration + testDuration <= dataEndTs) {
    folds.push({
      trainStart,
      trainEnd: trainStart + trainDuration,
      testStart: trainStart + trainDuration,
      testEnd: trainStart + trainDuration + testDuration,
    });
    trainStart += MONTH; // slide 1 month
  }
  return folds;
}

function parseArgs(argv: string[]): { topN: number } {
  let topN = 20;
  for (const a of argv) {
    if (a.startsWith('--candidates=top')) topN = Number(a.slice(16)) || 20;
  }
  return { topN };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  log.info(args, 'Starting walk-forward validation');
  initDb();

  const ds = loadDataset();
  const candidates = topGridRuns(args.topN);

  if (candidates.length === 0) {
    log.error('No grid results found. Run grid-search first.');
    closeDb();
    process.exit(1);
  }

  // Determine data range from actual trades
  const firstTs = ds.trades[0]?.timestamp ?? 0;
  const lastTs = ds.trades[ds.trades.length - 1]?.timestamp ?? 0;
  const folds = generateFolds(firstTs, lastTs);
  log.info({ folds: folds.length, candidates: candidates.length }, 'Walk-forward config');

  for (const candidate of candidates) {
    const cfg = JSON.parse(candidate.paramsJson) as BacktestSimConfig;
    const foldCalmars: number[] = [];

    for (const fold of folds) {
      const result = runBacktest(ds, cfg, fold.testStart, fold.testEnd);
      const c = result.calmar === Infinity ? 9999 : result.calmar;
      foldCalmars.push(c);
    }

    const sorted = [...foldCalmars].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const min = sorted[0] ?? 0;
    const positiveFolds = foldCalmars.filter((c) => c > 0).length;

    const row: WalkForwardResult = {
      id: generateId(),
      paramsJson: candidate.paramsJson,
      medianCalmar: median,
      minCalmar: min,
      pctPositiveFolds: folds.length > 0 ? (positiveFolds / folds.length) * 100 : 0,
      foldsJson: JSON.stringify(foldCalmars),
      ranAt: '',
    };
    insertWalkForwardRun(row);
    log.info({
      medianCalmar: median.toFixed(2), minCalmar: min.toFixed(2),
      positiveFolds: `${positiveFolds}/${folds.length}`,
    }, `Candidate evaluated (topN=${cfg.topN})`);
  }

  // Print top-3 finalists
  const finalists = topWalkForwardRuns(3);
  log.info('=== Top 3 Finalists (by min Calmar) ===');
  for (const f of finalists) {
    const cfg = JSON.parse(f.paramsJson) as BacktestSimConfig;
    log.info({
      minCalmar: f.minCalmar.toFixed(2), medianCalmar: f.medianCalmar.toFixed(2),
      positiveFolds: f.pctPositiveFolds.toFixed(0) + '%',
      topN: cfg.topN, maxTtrDays: cfg.maxTtrDays,
      f1Anchor: cfg.conviction.f1Anchor, w2: cfg.conviction.w2,
    }, 'Finalist');
  }

  closeDb();
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    log.error({ err: String(err) }, 'Walk-forward failed');
    closeDb();
    process.exit(1);
  });
}
