import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, closeDb } from '../db/database.js';
import { createLogger } from '../utils/logger.js';
import { topGridRuns, topWalkForwardRuns } from '../db/bt-queries.js';
import type { GridRunResult, BacktestSimConfig } from '../types.js';

const log = createLogger('report');
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPORTS_DIR = resolve(__dirname, '..', '..', 'reports');

function generateGridCsv(runs: GridRunResult[]): string {
  const header = 'id,calmar,pnl,max_dd,sharpe,win_rate,trade_count,avg_ttr,topN,windowDays,f1Anchor,f1Max,w2,w3,f4Boost,maxTtrDays';
  const rows = runs.map((r) => {
    const cfg = JSON.parse(r.paramsJson) as BacktestSimConfig;
    return [
      r.id, r.calmar.toFixed(4), r.pnl.toFixed(2), r.maxDd.toFixed(2),
      r.sharpe.toFixed(4), r.winRate.toFixed(4), r.tradeCount, r.avgTtrDays.toFixed(1),
      cfg.topN, cfg.leaderboardWindowDays, cfg.conviction.f1Anchor, cfg.conviction.f1Max,
      cfg.conviction.w2, cfg.conviction.w3, cfg.conviction.f4Boost, cfg.maxTtrDays,
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

function generateGridHtml(runs: GridRunResult[]): string {
  const tableRows = runs.slice(0, 50).map((r, i) => {
    const cfg = JSON.parse(r.paramsJson) as BacktestSimConfig;
    return `<tr>
      <td>${i + 1}</td><td>${r.calmar.toFixed(2)}</td><td>${r.pnl.toFixed(0)}</td>
      <td>${r.maxDd.toFixed(1)}%</td><td>${r.sharpe.toFixed(2)}</td>
      <td>${(r.winRate * 100).toFixed(1)}%</td><td>${r.tradeCount}</td>
      <td>${cfg.topN}</td><td>${cfg.leaderboardWindowDays}d</td>
      <td>${cfg.conviction.f1Anchor}</td><td>${cfg.conviction.w2}</td>
      <td>${cfg.conviction.w3}</td><td>${cfg.conviction.f4Boost}</td>
      <td>${cfg.maxTtrDays === Infinity || cfg.maxTtrDays > 9000 ? '∞' : cfg.maxTtrDays + 'd'}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Grid Search Results</title>
<style>
  body { font-family: system-ui; background: #1a1a2e; color: #eee; padding: 20px; }
  table { border-collapse: collapse; width: 100%; margin-top: 20px; }
  th, td { border: 1px solid #333; padding: 6px 10px; text-align: right; }
  th { background: #16213e; position: sticky; top: 0; }
  tr:nth-child(even) { background: #0f3460; }
  tr:hover { background: #533483; }
  h1 { color: #e94560; }
</style>
</head><body>
<h1>Grid Search — Top 50 by Calmar</h1>
<p>Total runs: ${runs.length}</p>
<table>
<thead><tr>
  <th>#</th><th>Calmar</th><th>PnL</th><th>MaxDD</th><th>Sharpe</th>
  <th>WinRate</th><th>Trades</th><th>TopN</th><th>Window</th>
  <th>F1Anchor</th><th>W2</th><th>W3</th><th>F4Boost</th><th>MaxTTR</th>
</tr></thead>
<tbody>${tableRows}</tbody>
</table>
</body></html>`;
}

function generateWalkForwardHtml(): string {
  const results = topWalkForwardRuns(20);
  const rows = results.map((r, i) => {
    const cfg = JSON.parse(r.paramsJson) as BacktestSimConfig;
    const folds = JSON.parse(r.foldsJson) as number[];
    const foldsStr = folds.map((f) => f.toFixed(1)).join(', ');
    return `<tr${i < 3 ? ' style="background:#1b4332;font-weight:bold"' : ''}>
      <td>${i + 1}</td><td>${r.minCalmar.toFixed(2)}</td><td>${r.medianCalmar.toFixed(2)}</td>
      <td>${r.pctPositiveFolds.toFixed(0)}%</td><td>${cfg.topN}</td>
      <td>${cfg.maxTtrDays === Infinity || cfg.maxTtrDays > 9000 ? '∞' : cfg.maxTtrDays + 'd'}</td>
      <td style="font-size:0.8em">${foldsStr}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Walk-Forward Results</title>
<style>
  body { font-family: system-ui; background: #1a1a2e; color: #eee; padding: 20px; }
  table { border-collapse: collapse; width: 100%; margin-top: 20px; }
  th, td { border: 1px solid #333; padding: 6px 10px; text-align: right; }
  th { background: #16213e; position: sticky; top: 0; }
  tr:nth-child(even) { background: #0f3460; }
  h1 { color: #e94560; }
  .finalist { color: #52b788; }
</style>
</head><body>
<h1>Walk-Forward Validation — Top 20 by Min Calmar</h1>
<p class="finalist">Top 3 finalists highlighted in green</p>
<table>
<thead><tr>
  <th>#</th><th>Min Calmar</th><th>Median</th><th>Positive</th>
  <th>TopN</th><th>MaxTTR</th><th>Fold Calmars</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>
</body></html>`;
}

async function main(): Promise<void> {
  log.info('Generating reports...');
  initDb();

  mkdirSync(REPORTS_DIR, { recursive: true });

  const allRuns = topGridRuns(10000);
  log.info({ runs: allRuns.length }, 'Grid runs loaded');

  if (allRuns.length > 0) {
    writeFileSync(resolve(REPORTS_DIR, 'grid.csv'), generateGridCsv(allRuns));
    writeFileSync(resolve(REPORTS_DIR, 'grid.html'), generateGridHtml(allRuns));
    log.info('Written: reports/grid.csv, reports/grid.html');
  }

  const wfHtml = generateWalkForwardHtml();
  writeFileSync(resolve(REPORTS_DIR, 'walkforward.html'), wfHtml);
  log.info('Written: reports/walkforward.html');

  closeDb();
  log.info('Reports complete. Open reports/*.html in browser.');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    log.error({ err: String(err) }, 'Report generation failed');
    closeDb();
    process.exit(1);
  });
}
