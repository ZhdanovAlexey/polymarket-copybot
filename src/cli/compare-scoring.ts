import { initDb, closeDb } from '../db/database.js';
import { createLogger } from '../utils/logger.js';
import { loadDataset } from '../core/strategy/data-loader.js';
import { runBacktest } from '../core/strategy/backtester.js';
import type { BacktestSimConfig } from '../types.js';

const log = createLogger('compare-scoring');

const BASE_CONFIG: Omit<BacktestSimConfig, 'scoringMode'> = {
  conviction: { betBase: 1, f1Anchor: 20, f1Max: 5, w2: 0.3, w3: 0.5, f4Boost: 1.0 },
  topN: 5,
  leaderboardWindowDays: 30,
  maxTtrDays: 7,
  maxPositions: 20,
  initialCapital: 200,
  slippagePct: 1,
  commissionPct: 0.1,
};

function parseArgs(argv: string[]): { startDate: string; endDate: string } {
  let startDate = '2025-04-14';
  let endDate = '2026-04-13';
  for (const a of argv) {
    if (a.startsWith('--period=')) {
      const [s, e] = a.slice(9).split(':');
      if (s) startDate = s;
      if (e) endDate = e;
    }
  }
  return { startDate, endDate };
}

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startTs = Math.floor(new Date(args.startDate).getTime() / 1000);
  const endTs = Math.floor(new Date(args.endDate).getTime() / 1000);

  log.info({ ...args }, 'Starting A/B scoring comparison');
  initDb();
  const ds = loadDataset();

  // Run OLD (legacy) scoring
  log.info('Running backtest with LEGACY scoring...');
  const legacyResult = runBacktest(ds, { ...BASE_CONFIG, scoringMode: 'legacy' }, startTs, endTs);

  // Run NEW scoring
  log.info('Running backtest with NEW scoring...');
  const newResult = runBacktest(ds, { ...BASE_CONFIG, scoringMode: 'new' }, startTs, endTs);

  const divider = '─'.repeat(55);

  console.log(`\n${divider}`);
  console.log('  A/B Leaderboard Scoring Comparison');
  console.log(`  Period: ${args.startDate} → ${args.endDate}`);
  console.log(divider);

  const header = `${'Metric'.padEnd(20)} ${'LEGACY'.padStart(12)} ${'NEW'.padStart(12)}  ${'Δ'.padStart(10)}`;
  console.log(header);
  console.log('─'.repeat(header.length));

  const rows: [string, string, string][] = [
    ['Calmar', fmt(legacyResult.calmar), fmt(newResult.calmar)],
    ['PnL ($)', fmt(legacyResult.totalPnl), fmt(newResult.totalPnl)],
    ['Max DD (%)', fmt(legacyResult.maxDrawdown, 1), fmt(newResult.maxDrawdown, 1)],
    ['Win Rate (%)', fmt(legacyResult.winRate * 100, 1), fmt(newResult.winRate * 100, 1)],
    ['Trades', String(legacyResult.tradeCount), String(newResult.tradeCount)],
    ['Avg TTR (days)', fmt(legacyResult.avgTtrDays, 1), fmt(newResult.avgTtrDays, 1)],
    ['Sharpe', fmt(legacyResult.sharpe), fmt(newResult.sharpe)],
    ['Final Equity ($)', fmt(legacyResult.totalPnl + BASE_CONFIG.initialCapital), fmt(newResult.totalPnl + BASE_CONFIG.initialCapital)],
  ];

  for (const [label, legacy, newVal] of rows) {
    const legacyNum = parseFloat(legacy);
    const newNum = parseFloat(newVal);
    const delta = isNaN(legacyNum) || isNaN(newNum) ? '' : (newNum - legacyNum >= 0 ? '+' : '') + fmt(newNum - legacyNum);
    console.log(`  ${label.padEnd(20)} ${legacy.padStart(12)} ${newVal.padStart(12)}  ${delta.padStart(10)}`);
  }

  console.log(divider);

  // Verdict
  const betterCalmar = newResult.calmar > legacyResult.calmar;
  const betterPnl = newResult.totalPnl > legacyResult.totalPnl;
  const moreTrades = newResult.tradeCount > legacyResult.tradeCount;

  if (betterCalmar && betterPnl) {
    console.log('  ✓ NEW scoring wins on both Calmar and PnL');
  } else if (betterCalmar) {
    console.log('  ~ NEW scoring better Calmar but lower PnL');
  } else if (betterPnl) {
    console.log('  ~ NEW scoring better PnL but lower Calmar');
  } else {
    console.log('  ✗ LEGACY scoring wins — review new formula');
  }
  if (moreTrades) {
    console.log(`  ✓ NEW generates more signals (${newResult.tradeCount} vs ${legacyResult.tradeCount})`);
  }

  console.log('');
  closeDb();
}

main().catch((err) => {
  log.error({ err: String(err) }, 'Comparison failed');
  closeDb();
  process.exit(1);
});
