/**
 * dashboard.js — Metric cards for the dashboard header row
 *
 * Exports:
 *   initDashboard()        — creates the 4 metric card DOM nodes
 *   updateMetrics(data)    — updates values from ApiMetricsResponse
 */

const METRIC_DEFS = [
  {
    id: 'total-pnl',
    label: 'Total P&L',
    format: formatUsd,
    colorize: true,
    subKey: null,
  },
  {
    id: 'win-rate',
    label: 'Win Rate',
    format: formatPercent,
    colorize: false,
    subKey: 'winLoss',
    subFormat: (v) => v || '&nbsp;',
  },
  {
    id: 'total-trades',
    label: 'Trades',
    format: formatInt,
    colorize: false,
    subKey: 'failedTrades',
    subFormat: (v) => `${v} failed`,
  },
  {
    id: 'today-pnl',
    label: 'Today P&L',
    format: formatUsd,
    colorize: true,
    subKey: 'todayTrades',
    subFormat: (v) => `${v} trades today`,
  },
  {
    id: 'unrealized-pnl',
    label: 'Unrealized P&L',
    format: formatUsd,
    colorize: true,
    subKey: 'openPositions',
    subFormat: (v) => `${v} open position${v === 1 ? '' : 's'}`,
  },
  {
    id: 'locked-in',
    label: 'Locked in positions',
    format: formatUsdUnsigned,
    colorize: false,
    subKey: null,
  },
];

/**
 * Build the 4 metric cards inside #metrics-row.
 */
export function initDashboard() {
  const container = document.getElementById('metrics-row');
  if (!container) return;

  container.innerHTML = '';

  for (const def of METRIC_DEFS) {
    const card = document.createElement('div');
    card.className = 'metric-card';
    card.innerHTML = `
      <span class="metric-label">${def.label}</span>
      <span class="metric-value neutral" id="mv-${def.id}">--</span>
      <span class="metric-sub" id="ms-${def.id}">&nbsp;</span>
    `;
    container.appendChild(card);
  }

  // Demo balance card (hidden until data confirms demo mode)
  const demoCard = document.createElement('div');
  demoCard.className = 'metric-card';
  demoCard.id = 'demo-balance-card';
  demoCard.style.display = 'none';
  demoCard.innerHTML = `
    <span class="metric-label">Demo Balance</span>
    <span class="metric-value neutral" id="mv-demo-balance">--</span>
    <span class="metric-sub" id="ms-demo-commission">&nbsp;</span>
  `;
  container.appendChild(demoCard);
}

/**
 * Update all metric cards with fresh data from /api/metrics.
 * @param {Object} data — ApiMetricsResponse shape
 */
export function updateMetrics(data) {
  if (!data) return;

  const wins = Number(data.wins || 0);
  const losses = Number(data.losses || 0);
  data.winLoss = (wins + losses) > 0 ? `${wins}W / ${losses}L` : 'No closed trades yet';

  const values = {
    'total-pnl': data.totalPnl,
    'win-rate': data.winRate,
    'total-trades': data.totalTrades,
    'today-pnl': data.todayPnl,
    'unrealized-pnl': data.unrealizedPnl,
    'locked-in': data.lockedInOpen,
  };

  for (const def of METRIC_DEFS) {
    const valEl = document.getElementById(`mv-${def.id}`);
    const subEl = document.getElementById(`ms-${def.id}`);
    if (!valEl) continue;

    const raw = values[def.id];
    valEl.textContent = def.format(raw);

    if (def.colorize) {
      valEl.className = 'metric-value ' + pnlClass(raw);
    }

    if (def.subKey && subEl && data[def.subKey] !== undefined) {
      subEl.textContent = def.subFormat(data[def.subKey]);
    }
  }

  // Demo balance card
  const demoCard = document.getElementById('demo-balance-card');
  if (demoCard && data.demoBalance != null) {
    demoCard.style.display = '';
    const valEl = document.getElementById('mv-demo-balance');
    const subEl = document.getElementById('ms-demo-commission');
    if (valEl) valEl.textContent = `$${data.demoBalance.toFixed(2)}`;
    if (subEl && data.demoTotalCommission != null) {
      subEl.textContent = `Commission: $${data.demoTotalCommission.toFixed(2)}`;
    }
  }
}

/* ---- Formatting helpers ---- */

function formatUsd(value) {
  if (value == null || isNaN(value)) return '--';
  const sign = value >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatUsdUnsigned(value) {
  if (value == null || isNaN(value)) return '--';
  return `$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function formatPercent(value) {
  if (value == null || isNaN(value)) return '--';
  return `${(value * 100).toFixed(1)}%`;
}

function formatInt(value) {
  if (value == null || isNaN(value)) return '--';
  return String(Math.round(value));
}

function pnlClass(value) {
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'neutral';
}
