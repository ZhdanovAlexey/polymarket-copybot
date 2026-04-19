/**
 * app.js — Main dashboard application module
 *
 * Orchestrates:
 *   1. Initial data fetch on DOMContentLoaded
 *   2. Periodic refresh every 10 seconds
 *   3. P&L chart (Chart.js)
 *   4. Open positions table
 *   5. Header status / wallet / balances
 *   6. Button handlers (settings, toggle bot)
 *   7. Footer uptime
 */

import { initDashboard, updateMetrics } from './dashboard.js';
import { initTraders, updateTraders } from './traders.js';
import { initTrades, updateTrades, addTrade } from './trades.js';
import { initSettings, checkFirstRun } from './settings.js';

const API_BASE = '';
const REFRESH_INTERVAL_MS = 10_000;

let pnlChart = null;
let refreshTimer = null;
let botStatus = { running: false, uptime: 0, version: '2.0.0' };

// Last-fetched raw arrays for tables — kept so sort-click re-renders without refetch.
let lastOpenPositions = [];
let lastClosedPositions = [];

// Per-table sort state: {key, dir}
const sortState = {
  'positions-table': { key: null, dir: 'asc' },
  'closed-positions-table': { key: 'closedAt', dir: 'desc' },
  'trade-log-table': { key: 'timestamp', dir: 'desc' },
};

/* ================================================================
   Fetch helper
   ================================================================ */

async function fetchJson(url) {
  // Hard timeout (10s) — prevents UI freeze when backend endpoint stalls.
  // AbortSignal.timeout throws AbortError, handled by caller's try/catch.
  const res = await fetch(`${API_BASE}${url}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/* ================================================================
   Initialisation
   ================================================================ */

document.addEventListener('DOMContentLoaded', () => {
  initDashboard();
  initTraders();
  initTrades();
  initSettings();
  initChart();
  wireButtons();
  initTableSorting();
  wireManualCloseHandlers();
  wirePositionRowExpand();
  refreshAll();
  startRefreshLoop();
  startUptimeTicker();
  checkFirstRun();
});

/* ================================================================
   Refresh loop
   ================================================================ */

function startRefreshLoop() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAll, REFRESH_INTERVAL_MS);
}

let _refreshInFlight = false;
async function refreshAll() {
  // Guard against overlapping refreshes — if previous refresh hasn't finished,
  // skip this tick. Prevents pileup of stalled fetches freezing the UI.
  if (_refreshInFlight) return;
  _refreshInFlight = true;
  try {
    // All endpoints are now DB-only (no external API calls), run in parallel.
    // Positions settles first so refreshTraders can use lastOpenPositions.
    await Promise.allSettled([
      refreshPositions(),
      refreshStatus(),
      refreshMetrics(),
      refreshTrades(),
      refreshClosedPositions(),
      refreshChart(),
    ]);
    // Traders depends on lastOpenPositions (set by refreshPositions)
    await refreshTraders();
  } finally {
    _refreshInFlight = false;
  }
}

/* ---- Status ---- */

async function refreshStatus() {
  try {
    const data = await fetchJson('/api/status');
    botStatus = data;
    renderStatus(data);
  } catch (err) {
    console.error('Failed to fetch status:', err);
  }
}

function renderStatus(data) {
  const badge = document.getElementById('bot-status');
  if (badge) {
    const statusText = data.running ? 'Running' : data.status === 'error' ? 'Error' : 'Idle';
    badge.textContent = '\u25CF ' + statusText;
    badge.className = 'status-badge ' + (data.running ? 'running' : data.status || 'idle');
  }

  const toggleBtn = document.getElementById('btn-toggle-bot');
  if (toggleBtn) {
    if (data.running) {
      toggleBtn.textContent = '\u25A0 Stop';
      toggleBtn.className = 'btn btn-danger';
    } else {
      toggleBtn.textContent = '\u25B6 Start';
      toggleBtn.className = 'btn btn-success';
    }
  }

  // Update dry run indicator and demo balance
  if (data.dryRun) {
    const badge2 = document.getElementById('bot-status');
    if (badge2 && data.running) {
      badge2.textContent = '\u25CF Running (DEMO)';
    }
    if (data.demoBalance != null) {
      const usdcEl = document.getElementById('usdc-balance');
      if (usdcEl) usdcEl.textContent = `Demo: $${data.demoBalance.toFixed(2)}`;
    }
  }
}

/* ---- Metrics ---- */

async function refreshMetrics() {
  try {
    const data = await fetchJson('/api/metrics');
    updateMetrics(data);
  } catch (err) {
    console.error('Failed to fetch metrics:', err);
  }
}

/* ---- Traders ---- */

async function refreshTraders() {
  try {
    const data = await fetchJson('/api/traders');
    updateTraders(data, lastOpenPositions);
  } catch (err) {
    console.error('Failed to fetch traders:', err);
  }
}

/* ---- Trades ---- */

async function refreshTrades() {
  try {
    const data = await fetchJson('/api/trades?limit=100');
    updateTrades(data);
  } catch (err) {
    console.error('Failed to fetch trades:', err);
  }
}

/* ---- Positions ---- */

async function refreshPositions() {
  try {
    _posTradeCache.clear();
    const data = await fetchJson('/api/positions');
    renderPositions(data);
  } catch (err) {
    console.error('Failed to fetch positions:', err);
  }
}

function renderPositions(positions) {
  const tbody = document.getElementById('positions-body');
  const totalEl = document.getElementById('positions-total-value');
  const countEl = document.getElementById('open-positions-count');
  if (!tbody) return;

  if (Array.isArray(positions)) lastOpenPositions = positions;
  const list = sortRows(lastOpenPositions, 'positions-table');
  if (countEl) countEl.textContent = `(${list.length})`;

  // Totals: invested (cost basis) + current value (mark-to-market) + unrealized P&L
  let totalInvested = 0;
  let totalCurrent = 0;
  let totalPnl = 0;
  let hasCurrent = false;
  for (const p of list) {
    totalInvested += Number(p.totalInvested || 0);
    if (p.currentValue != null) {
      totalCurrent += Number(p.currentValue || 0);
      totalPnl += Number(p.pnl || 0);
      hasCurrent = true;
    }
  }

  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state">No open positions</td></tr>';
    if (totalEl) totalEl.textContent = '--';
    return;
  }

  tbody.innerHTML = list
    .map((p) => {
      const curPrice = p.curPrice != null ? p.curPrice : null;
      const pnl = p.pnl != null ? p.pnl : 0;
      const pnlClass = pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
      const pnlSign = pnl >= 0 ? '+' : '-';
      const curPriceStr = curPrice != null ? `$${curPrice.toFixed(4)}` : '--';
      const traderLabel = p.traderName || (p.traderAddress ? p.traderAddress.slice(0, 6) + '\u2026' + p.traderAddress.slice(-4) : '--');

      return `
        <tr data-token-id="${escapeHtml(p.tokenId)}" data-trader-address="${escapeHtml(p.traderAddress || '')}">
          <td title="${p.openedAt ? relativeTime(p.openedAt) : ''}">${p.openedAt ? formatOpenedTime(p.openedAt) : '--'}</td>
          <td title="${escapeHtml(p.traderAddress || '')}">${escapeHtml(truncate(traderLabel, 14))}</td>
          <td title="${escapeHtml(p.marketTitle)}">${marketLink(p.marketSlug, p.marketTitle, 45)}</td>
          <td>${escapeHtml(p.outcome || '--')}</td>
          <td title="${escapeHtml(p.gameStartTime || p.endDate || '')}">${formatEventTime(p.gameStartTime, p.endDate)}</td>
          <td>${(p.totalShares || 0).toFixed(2)}</td>
          <td>$${(p.avgPrice || 0).toFixed(4)}</td>
          <td>${curPriceStr}</td>
          <td>$${(p.totalInvested || 0).toFixed(2)}</td>
          <td class="${pnlClass}">${pnlSign}$${Math.abs(pnl).toFixed(2)}</td>
          <td><button class="btn btn-small btn-close-position" data-token-id="${escapeHtml(p.tokenId)}" title="Close this position at current midpoint (demo)">Close</button></td>
        </tr>
      `;
    })
    .join('');

  if (totalEl) {
    const pnlClass = totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative';
    const sign = totalPnl >= 0 ? '+' : '-';
    const currentPart = hasCurrent
      ? ` &middot; Current: <strong>$${totalCurrent.toFixed(2)}</strong> &middot; Unrealized: <span class="${pnlClass}">${sign}$${Math.abs(totalPnl).toFixed(2)}</span>`
      : '';
    totalEl.innerHTML = `Invested: <strong>$${totalInvested.toFixed(2)}</strong>${currentPart}`;
  }
}

/* ---- Closed Positions (round-trip) ---- */

async function refreshClosedPositions() {
  try {
    const data = await fetchJson('/api/positions/closed?limit=200');
    renderClosedPositions(data);
  } catch (err) {
    console.error('Failed to fetch closed positions:', err);
  }
}

function renderClosedPositions(rows) {
  const tbody = document.getElementById('closed-positions-body');
  const countEl = document.getElementById('closed-positions-count');
  const totalEl = document.getElementById('closed-positions-total');
  if (!tbody) return;

  if (Array.isArray(rows)) lastClosedPositions = rows;
  const list = sortRows(lastClosedPositions, 'closed-positions-table');
  if (countEl) countEl.textContent = `(${list.length})`;

  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state">No closed positions yet</td></tr>';
    if (totalEl) totalEl.textContent = 'Realized P&L: $0.00';
    return;
  }

  let totalPnl = 0;

  tbody.innerHTML = list
    .map((p) => {
      const pnl = Number(p.realizedPnl || 0);
      totalPnl += pnl;
      const pnlClass = pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
      const pnlSign = pnl >= 0 ? '+' : '-';

      let statusBadge;
      if (p.status === 'redeemed') {
        const won = p.closeAvgPrice >= 0.99;
        statusBadge = won
          ? '<span class="status-pill simulated" title="Market resolved — won">redeemed (won)</span>'
          : '<span class="status-pill failed" title="Market resolved — lost">redeemed (lost)</span>';
      } else {
        statusBadge = '<span class="status-pill filled">closed</span>';
      }

      const closedAt = p.closedAt ? relativeTime(p.closedAt) : '--';
      const traderLabel = p.traderName || (p.traderAddress ? p.traderAddress.slice(0, 6) + '\u2026' + p.traderAddress.slice(-4) : '--');

      return `
        <tr>
          <td title="${escapeHtml(p.traderAddress || '')}">${escapeHtml(truncate(traderLabel, 14))}</td>
          <td title="${escapeHtml(p.marketTitle)}">${marketLink(p.marketSlug, p.marketTitle, 40)}</td>
          <td>${escapeHtml(p.outcome || '--')}</td>
          <td>${Number(p.totalShares || 0).toFixed(2)}</td>
          <td>$${Number(p.avgPrice || 0).toFixed(4)}</td>
          <td>$${Number(p.closeAvgPrice || 0).toFixed(4)}</td>
          <td>$${Number(p.totalInvested || 0).toFixed(2)}</td>
          <td>$${Number(p.closeUsd || 0).toFixed(2)}</td>
          <td class="${pnlClass}">${pnlSign}$${Math.abs(pnl).toFixed(2)}</td>
          <td>${statusBadge}</td>
          <td title="${escapeHtml(p.closedAt || '')}">${closedAt}</td>
        </tr>
      `;
    })
    .join('');

  if (totalEl) {
    const sign = totalPnl >= 0 ? '+' : '-';
    const cls = totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative';
    totalEl.innerHTML = `Realized P&L: <span class="${cls}">${sign}$${Math.abs(totalPnl).toFixed(2)}</span>`;
  }
}

/* ================================================================
   P&L Chart
   ================================================================ */

let currentPeriod = '24h';

function initChart() {
  const canvas = document.getElementById('pnl-chart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  pnlChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'P&L',
          data: [],
          borderWidth: 2,
          fill: 'origin',
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 8,
          segment: {
            borderColor: (ctx) => {
              // Color each segment based on the values at its endpoints
              const p0 = ctx.p0.parsed.y;
              const p1 = ctx.p1.parsed.y;
              if (p0 >= 0 && p1 >= 0) return '#3fb950';
              if (p0 < 0 && p1 < 0) return '#f85149';
              // Crossing zero — blend (use the endpoint color)
              return p1 >= 0 ? '#3fb950' : '#f85149';
            },
            backgroundColor: (ctx) => {
              const p0 = ctx.p0.parsed.y;
              const p1 = ctx.p1.parsed.y;
              if (p0 >= 0 && p1 >= 0) return 'rgba(63, 185, 80, 0.15)';
              if (p0 < 0 && p1 < 0) return 'rgba(248, 81, 73, 0.15)';
              return p1 >= 0 ? 'rgba(63, 185, 80, 0.15)' : 'rgba(248, 81, 73, 0.15)';
            },
          },
          // Fallback colors (used for legend / tooltip swatch)
          borderColor: '#3fb950',
          backgroundColor: 'rgba(63, 185, 80, 0.15)',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#161b22',
          borderColor: '#30363d',
          borderWidth: 1,
          titleColor: '#e6edf3',
          bodyColor: '#8b949e',
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              const sign = v >= 0 ? '+' : '-';
              return `P&L: ${sign}$${Math.abs(v).toFixed(2)}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(48, 54, 61, 0.5)' },
          ticks: {
            color: '#8b949e',
            autoSkip: false,
            maxRotation: 0,
          },
        },
        y: {
          grid: { color: 'rgba(48, 54, 61, 0.5)' },
          ticks: {
            color: '#8b949e',
            callback: (v) => '$' + v.toFixed(2),
          },
        },
      },
    },
  });

  // Wire period toggle buttons
  const buttons = document.querySelectorAll('.period-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentPeriod = btn.dataset.period;
      refreshChart();
    });
  });
}

async function refreshChart() {
  if (!pnlChart) return;

  // Map period buttons to API query params
  const periodMap = { '1h': '1h', '24h': '24h', '7d': '7d', '30d': '30d', all: '365d' };
  const period = periodMap[currentPeriod] || '24h';

  const metaEl = document.getElementById('chart-meta');

  try {
    const snapshots = await fetchJson(`/api/pnl-history?period=${period}`);

    if (metaEl) {
      const label = currentPeriod === 'all' ? 'all time' : currentPeriod.toUpperCase();
      metaEl.textContent = `${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'} · ${label}`;
    }

    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      pnlChart.data.labels = [];
      pnlChart.data.datasets[0].data = [];
      pnlChart.update();
      return;
    }

    // pnl-history returns newest-first, reverse for chronological order
    const points = snapshots
      .map((s) => ({ time: new Date(s.timestamp + 'Z'), pnl: s.totalPnl ?? 0 }))
      .reverse();

    // Compute labels, rounding to nearest 5 min, then keep only "round" ticks based on span.
    // Aim for ~8-12 visible labels across the whole chart.
    const spanMs =
      points.length > 1 ? points[points.length - 1].time - points[0].time : 0;
    // Pick a step that gives <=12 labels: 5m, 15m, 30m, 1h, 2h, 4h, 12h, 1d
    const candidateSteps = [5, 15, 30, 60, 120, 240, 720, 1440];
    const targetCount = 10;
    const stepMin =
      candidateSteps.find((s) => spanMs / (s * 60 * 1000) <= targetCount) ?? 1440;

    const ms5 = 5 * 60 * 1000;
    pnlChart.data.labels = points.map((p) => {
      const rounded = new Date(Math.round(p.time.getTime() / ms5) * ms5);
      const totalMinutesOfDay = rounded.getHours() * 60 + rounded.getMinutes();
      // Show label only if aligned to stepMin; otherwise empty string (point still plotted)
      if (totalMinutesOfDay % stepMin !== 0) return '';
      return rounded.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });
    pnlChart.data.datasets[0].data = points.map((p) => p.pnl);

    pnlChart.update();
  } catch (err) {
    console.error('Failed to fetch chart data:', err);
  }
}

/* ================================================================
   Button handlers
   ================================================================ */

function wireButtons() {
  // Settings button is handled by settings.js (initSettings/wireSettingsModal)
  const toggleBtn = document.getElementById('btn-toggle-bot');

  if (toggleBtn) {
    toggleBtn.addEventListener('click', async () => {
      try {
        const action = botStatus.running ? 'stop' : 'start';
        toggleBtn.disabled = true;
        const res = await fetch(`${API_BASE}/api/bot/${action}`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        showToast('success', data.message || `Bot ${action}ed`);
        await refreshStatus();
      } catch (err) {
        showToast('error', `Failed: ${err.message}`);
      } finally {
        toggleBtn.disabled = false;
      }
    });
  }
}

/* ================================================================
   Footer uptime ticker
   ================================================================ */

function startUptimeTicker() {
  setInterval(() => {
    const el = document.getElementById('uptime');
    if (!el) return;

    if (!botStatus.running || !botStatus.uptime) {
      el.textContent = 'Uptime: --';
      return;
    }

    // botStatus.uptime is the uptime in seconds at the time of last /api/status fetch
    // We approximate by adding elapsed time since last refresh
    const totalSeconds = botStatus.uptime;
    el.textContent = `Uptime: ${formatDuration(totalSeconds)}`;
  }, 1000);
}

function formatDuration(totalSeconds) {
  if (!totalSeconds || totalSeconds < 0) return '--';

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/* ================================================================
   Toast notifications
   ================================================================ */

function showToast(type, message, durationMs = 4000) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'fadeOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, durationMs);
}

// Expose showToast globally for other modules / SSE handler
window.__showToast = showToast;
// Expose addTrade for SSE handler
window.__addTrade = addTrade;

/* ================================================================
   Helpers
   ================================================================ */

function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

function marketLink(slug, title, maxLen) {
  const text = escapeHtml(truncate(title || slug || '--', maxLen));
  if (!slug) return text;
  const url = `https://polymarket.com/event/${encodeURIComponent(slug)}`;
  return `<a class="market-link" href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generic click-to-sort helper. Tables marked `class="sortable"` with
 * `<th data-sort="key">` headers use this. Clicking a header cycles
 * asc → desc → asc for that column.
 */
function initTableSorting() {
  const tables = document.querySelectorAll('table.sortable');
  tables.forEach((table) => {
    const id = table.id;
    if (!id) return;
    if (!sortState[id]) sortState[id] = { key: null, dir: 'asc' };

    const ths = table.querySelectorAll('thead th[data-sort]');
    ths.forEach((th) => {
      th.style.cursor = 'pointer';
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        const cur = sortState[id];
        if (cur.key === key) {
          cur.dir = cur.dir === 'asc' ? 'desc' : 'asc';
        } else {
          cur.key = key;
          cur.dir = 'asc';
        }
        updateSortIndicators(table);
        reRenderTable(id);
      });
    });
    updateSortIndicators(table);
  });
}

function updateSortIndicators(table) {
  const state = sortState[table.id];
  table.querySelectorAll('thead th[data-sort]').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (state && th.dataset.sort === state.key) {
      th.classList.add(state.dir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

/** Apply current sort state to a row array. Returns a new array. */
function sortRows(rows, tableId) {
  const state = sortState[tableId];
  if (!state?.key || !Array.isArray(rows)) return rows ?? [];
  const { key, dir } = state;
  const mul = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a?.[key];
    const bv = b?.[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul;
    return String(av).localeCompare(String(bv)) * mul;
  });
}

function reRenderTable(tableId) {
  if (tableId === 'positions-table') renderPositions(null);
  else if (tableId === 'closed-positions-table') renderClosedPositions(null);
  else if (tableId === 'trade-log-table' && window.__rerenderTradeLog) {
    window.__rerenderTradeLog();
  }
}

// Expose a trade-log-specific sort bound to the shared sortState bucket.
window.__sortTradeLog = (rows) => sortRows(rows, 'trade-log-table');

/** Manual position close — delegated click on .btn-close-position */
function wireManualCloseHandlers() {
  const tbody = document.getElementById('positions-body');
  if (!tbody) return;
  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-close-position');
    if (!btn) return;
    const tokenId = btn.dataset.tokenId;
    if (!tokenId) return;
    if (!confirm('Close this position at current midpoint?')) return;

    btn.disabled = true;
    btn.textContent = '...';
    try {
      const res = await fetch(`/api/positions/${encodeURIComponent(tokenId)}/close`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (window.__showToast) {
        const pnlStr = data.pnl >= 0 ? `+$${data.pnl.toFixed(2)}` : `-$${Math.abs(data.pnl).toFixed(2)}`;
        window.__showToast('success', `Closed. Net: $${data.netPayout.toFixed(2)} (P&L ${pnlStr})`);
      }
      refreshAll();
    } catch (err) {
      if (window.__showToast) window.__showToast('error', `Close failed: ${err.message}`);
      btn.disabled = false;
      btn.textContent = 'Close';
    }
  });
}

function relativeTime(timestamp) {
  if (!timestamp) return '--';
  const t = new Date(timestamp).getTime();
  if (isNaN(t)) return '--';
  const diffMs = Date.now() - t;
  if (diffMs < 0) return 'just now';
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Format timestamp as "HH:MM" (today) or "Apr 13 16:05" (other days) */
function formatOpenedTime(timestamp) {
  if (!timestamp) return '--';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return '--';
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
}

/**
 * Format event/resolution time for Open Positions "Event" column.
 * Shows relative time until the event (e.g. "in 3h", "Tomorrow 18:15").
 * Prefers gameStartTime (when the match starts) over endDate (when market closes).
 */
function formatEventTime(gameStartTime, endDate) {
  const raw = gameStartTime || endDate;
  if (!raw) return '--';
  const d = new Date(raw);
  if (isNaN(d.getTime())) return '--';

  const now = new Date();
  const diffMs = d.getTime() - now.getTime();

  // Already past
  if (diffMs < 0) {
    const agoH = Math.floor(-diffMs / 3_600_000);
    if (agoH < 1) return 'Live';
    if (agoH < 24) return `${agoH}h ago`;
    return 'Ended';
  }

  const diffH = Math.floor(diffMs / 3_600_000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  if (diffH < 1) return `in ${Math.max(1, Math.floor(diffMs / 60_000))}m`;
  if (d.toDateString() === now.toDateString()) return `Today ${hh}:${mm}`;

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `Tmrw ${hh}:${mm}`;

  if (diffH < 168) return `${months[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

/* ---- Expandable position detail rows ---- */
const _posTradeCache = new Map();

function wirePositionRowExpand() {
  const tbody = document.getElementById('positions-body');
  if (!tbody) return;
  tbody.addEventListener('click', async (e) => {
    // Don't expand when clicking the Close button
    if (e.target.closest('.btn-close-position')) return;
    const row = e.target.closest('tr[data-token-id]');
    if (!row) return;
    const tokenId = row.dataset.tokenId;
    const ownerAddress = row.dataset.traderAddress || '';
    if (!tokenId) return;

    // Toggle: if next sibling is a detail row, remove it
    const next = row.nextElementSibling;
    if (next && next.classList.contains('position-detail-row')) {
      next.remove();
      row.classList.remove('expanded');
      return;
    }

    // Create detail row
    const detailRow = document.createElement('tr');
    detailRow.classList.add('position-detail-row');
    const td = document.createElement('td');
    td.colSpan = 10;
    td.innerHTML = '<span class="text-muted">Loading\u2026</span>';
    detailRow.appendChild(td);
    row.after(detailRow);
    row.classList.add('expanded');

    try {
      let trades = _posTradeCache.get(tokenId);
      if (!trades) {
        const res = await fetch(`/api/positions/${encodeURIComponent(tokenId)}/trades`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        trades = await res.json();
        _posTradeCache.set(tokenId, trades);
      }

      // Filter to only show trades from the position's owner trader
      if (ownerAddress) {
        trades = trades.filter(t => (t.traderAddress || '') === ownerAddress);
      }

      if (!trades.length) {
        td.innerHTML = '<span class="text-muted">No trade records</span>';
        return;
      }

      let html = '<table class="detail-subtable"><thead><tr>' +
        '<th>Time</th><th>Trader</th><th>Side</th><th>Shares</th><th>Price</th><th>USD</th><th>Comm.</th>' +
        '</tr></thead><tbody>';
      for (const t of trades) {
        const sideClass = t.side === 'BUY' ? 'pnl-positive' : (t.side === 'SELL' ? 'pnl-negative' : '');
        const traderLabel = t.traderName || (t.traderAddress ? t.traderAddress.slice(0, 6) + '\u2026' + t.traderAddress.slice(-4) : '--');
        html += `<tr>
          <td>${formatOpenedTime(t.timestamp)}</td>
          <td title="${escapeHtml(t.traderAddress || '')}">${escapeHtml(traderLabel)}</td>
          <td class="${sideClass}">${t.side}</td>
          <td>${(t.size || 0).toFixed(2)}</td>
          <td>$${(t.price || 0).toFixed(4)}</td>
          <td>$${(t.totalUsd || 0).toFixed(2)}</td>
          <td>$${(t.commission || 0).toFixed(3)}</td>
        </tr>`;
      }
      html += '</tbody></table>';
      td.innerHTML = html;
    } catch (err) {
      td.innerHTML = `<span class="text-muted">Failed to load trades: ${escapeHtml(err.message)}</span>`;
    }
  });
}
