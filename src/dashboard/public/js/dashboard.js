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
    subKey: null,
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
}

/**
 * Update all metric cards with fresh data from /api/metrics.
 * @param {Object} data — ApiMetricsResponse shape
 */
export function updateMetrics(data) {
  if (!data) return;

  const values = {
    'total-pnl': data.totalPnl,
    'win-rate': data.winRate,
    'total-trades': data.totalTrades,
    'today-pnl': data.todayPnl,
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
}

/* ---- Formatting helpers ---- */

function formatUsd(value) {
  if (value == null || isNaN(value)) return '--';
  const sign = value >= 0 ? '+' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
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
