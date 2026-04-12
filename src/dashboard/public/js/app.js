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

const API_BASE = '';
const REFRESH_INTERVAL_MS = 10_000;

let pnlChart = null;
let refreshTimer = null;
let botStatus = { running: false, uptime: 0, version: '2.0.0' };

/* ================================================================
   Fetch helper
   ================================================================ */

async function fetchJson(url) {
  const res = await fetch(`${API_BASE}${url}`);
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
  initChart();
  wireButtons();
  refreshAll();
  startRefreshLoop();
  startUptimeTicker();
});

/* ================================================================
   Refresh loop
   ================================================================ */

function startRefreshLoop() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAll, REFRESH_INTERVAL_MS);
}

async function refreshAll() {
  await Promise.allSettled([
    refreshStatus(),
    refreshMetrics(),
    refreshTraders(),
    refreshTrades(),
    refreshPositions(),
    refreshChart(),
  ]);
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

  // Update dry run indicator
  if (data.dryRun) {
    const badge2 = document.getElementById('bot-status');
    if (badge2 && data.running) {
      badge2.textContent = '\u25CF Running (DRY)';
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
    updateTraders(data);
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
    const data = await fetchJson('/api/positions');
    renderPositions(data);
  } catch (err) {
    console.error('Failed to fetch positions:', err);
  }
}

function renderPositions(positions) {
  const tbody = document.getElementById('positions-body');
  const totalEl = document.getElementById('positions-total-value');
  if (!tbody) return;

  if (!Array.isArray(positions) || positions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No open positions</td></tr>';
    if (totalEl) totalEl.textContent = 'Total: $0.00';
    return;
  }

  let totalValue = 0;

  tbody.innerHTML = positions
    .map((p) => {
      const currentValue = (p.totalShares || 0) * (p.avgPrice || 0);
      totalValue += p.totalInvested || 0;
      const pnl = currentValue - (p.totalInvested || 0);
      const pnlClass = pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
      const pnlSign = pnl >= 0 ? '+' : '';

      return `
        <tr>
          <td title="${escapeHtml(p.marketTitle)}">${escapeHtml(truncate(p.marketTitle, 45))}</td>
          <td>${escapeHtml(p.outcome || '--')}</td>
          <td>${(p.totalShares || 0).toFixed(2)}</td>
          <td>$${(p.avgPrice || 0).toFixed(4)}</td>
          <td>--</td>
          <td class="${pnlClass}">${pnlSign}$${Math.abs(pnl).toFixed(2)}</td>
        </tr>
      `;
    })
    .join('');

  if (totalEl) {
    totalEl.textContent = `Total: $${totalValue.toFixed(2)}`;
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
          borderColor: '#58a6ff',
          backgroundColor: 'rgba(88, 166, 255, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 8,
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
            label: (ctx) => `P&L: $${ctx.parsed.y.toFixed(2)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(48, 54, 61, 0.5)' },
          ticks: { color: '#8b949e', maxTicksLimit: 10 },
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

  try {
    const snapshots = await fetchJson(`/api/activity?type=pnl_snapshot&limit=200`);

    // If no real snapshot data, try to use pnl_snapshots indirectly or show empty
    // For now, use the activity endpoint which may not have snapshot data yet.
    // We'll gracefully handle empty data.

    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      pnlChart.data.labels = [];
      pnlChart.data.datasets[0].data = [];
      pnlChart.update();
      return;
    }

    // Parse activity entries that have pnl data in their details
    const points = snapshots
      .filter((s) => s.details)
      .map((s) => {
        try {
          const d = JSON.parse(s.details);
          return { time: new Date(s.timestamp), pnl: d.totalPnl ?? 0 };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();

    pnlChart.data.labels = points.map((p) =>
      p.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    );
    pnlChart.data.datasets[0].data = points.map((p) => p.pnl);

    // Color the fill based on final value
    const lastPnl = points.length > 0 ? points[points.length - 1].pnl : 0;
    if (lastPnl >= 0) {
      pnlChart.data.datasets[0].borderColor = '#3fb950';
      pnlChart.data.datasets[0].backgroundColor = 'rgba(63, 185, 80, 0.1)';
    } else {
      pnlChart.data.datasets[0].borderColor = '#f85149';
      pnlChart.data.datasets[0].backgroundColor = 'rgba(248, 81, 73, 0.1)';
    }

    pnlChart.update();
  } catch (err) {
    console.error('Failed to fetch chart data:', err);
  }
}

/* ================================================================
   Button handlers
   ================================================================ */

function wireButtons() {
  const settingsBtn = document.getElementById('btn-settings');
  const toggleBtn = document.getElementById('btn-toggle-bot');

  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      const modal = document.getElementById('settings-modal');
      if (modal) modal.classList.toggle('hidden');
    });
  }

  if (toggleBtn) {
    toggleBtn.addEventListener('click', async () => {
      try {
        // Toggle bot start/stop — will be wired in Stage 10
        showToast('info', 'Bot control will be available in a future update.');
      } catch (err) {
        showToast('error', `Failed: ${err.message}`);
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

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
