/**
 * traders.js — My Leaderboard (per-trader analytics table)
 *
 * Exports:
 *   initTraders()            — wire event handlers + initial fetch
 *   updateTraders(traders)   — render from /api/traders (legacy compat, triggers analytics fetch)
 */

const POLYMARKET_PROFILE_URL = 'https://polymarket.com/profile/';

const TRASH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path></svg>`;

let lastAnalytics = [];
let sortState = { key: 'totalPnl', dir: 'desc' };

/* ---- Init ---- */

export function initTraders() {
  const section = document.getElementById('traders-section');
  if (!section) return;

  // Sort by clicking column headers
  section.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      if (sortState.key === key) {
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState = { key, dir: 'desc' };
      }
      renderTable(lastAnalytics);
      return;
    }

    // Remove button
    const removeBtn = e.target.closest('.trader-remove-btn');
    if (removeBtn) {
      handleRemove(removeBtn);
      return;
    }

    // Pause/resume button
    const pauseBtn = e.target.closest('.trader-pause-btn');
    if (pauseBtn) {
      handlePause(pauseBtn);
      return;
    }

    // Expand row detail (skip only action buttons)
    const row = e.target.closest('tr[data-address]');
    if (row && !e.target.closest('.trader-pause-btn, .trader-remove-btn')) {
      // Prevent navigation if clicked on the trader name link
      const link = e.target.closest('a.trader-name-cell');
      if (link) e.preventDefault();
      toggleDetail(row);
    }
  });

  // Refresh leaderboard button
  const refreshBtn = document.getElementById('btn-refresh-traders');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      const originalLabel = refreshBtn.innerHTML;
      refreshBtn.innerHTML = '\u21bb Refreshing\u2026';
      try {
        const res = await fetch('/api/bot/refresh-leaderboard', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (window.__showToast) window.__showToast('success', `Refreshed: ${data.count} traders`);
        await refreshAnalytics();
      } catch (err) {
        if (window.__showToast) window.__showToast('error', `Refresh failed: ${err.message}`);
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.innerHTML = originalLabel;
      }
    });
  }

  // Initial fetch
  refreshAnalytics();
}

/* ---- Data fetching ---- */

async function refreshAnalytics() {
  try {
    const [analytics, positions] = await Promise.all([
      fetch('/api/traders/analytics').then((r) => r.json()),
      fetch('/api/positions').then((r) => r.json()),
    ]);
    if (Array.isArray(analytics)) {
      // Compute unrealized PnL per trader from positions data
      const posArr = Array.isArray(positions) ? positions : [];
      const traderUnrealized = {};
      for (const p of posArr) {
        const addr = p.traderAddress;
        if (!addr || p.pnl == null) continue;
        traderUnrealized[addr] = (traderUnrealized[addr] || 0) + p.pnl;
      }
      for (const t of analytics) {
        t.unrealizedPnl = traderUnrealized[t.address] || 0;
      }
      lastAnalytics = analytics;
      renderTable(analytics);
    }
  } catch (err) {
    console.error('Failed to fetch trader analytics:', err);
  }
}

/**
 * Legacy compat — called from app.js polling. Triggers analytics refresh.
 */
export function updateTraders(_traders) {
  refreshAnalytics();
}

/* ---- Rendering ---- */

function renderTable(traders) {
  const tbody = document.getElementById('traders-body');
  const countEl = document.getElementById('traders-count');
  if (!tbody) return;

  const list = Array.isArray(traders) ? traders : [];
  if (countEl) countEl.textContent = `(${list.length})`;

  // Update sort indicators
  const thead = tbody.closest('table')?.querySelector('thead');
  if (thead) {
    for (const th of thead.querySelectorAll('th[data-sort]')) {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.sort === sortState.key) {
        th.classList.add(sortState.dir === 'asc' ? 'sort-asc' : 'sort-desc');
      }
    }
  }

  const sorted = [...list].sort((a, b) => {
    let va = a[sortState.key] ?? '';
    let vb = b[sortState.key] ?? '';
    if (sortState.key === 'status') {
      va = statusLabel(a);
      vb = statusLabel(b);
    }
    if (typeof va === 'string') {
      const cmp = va.localeCompare(vb);
      return sortState.dir === 'asc' ? cmp : -cmp;
    }
    return sortState.dir === 'asc' ? va - vb : vb - va;
  });

  if (sorted.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No tracked traders</td></tr>';
    return;
  }

  tbody.innerHTML = sorted.map(renderRow).join('');
}

const PAUSE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
const PLAY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;

function renderRow(t) {
  const shortAddr = t.address ? t.address.slice(0, 6) + '\u2026' + t.address.slice(-4) : '';
  const displayName = t.name || shortAddr;
  const profileUrl = POLYMARKET_PROFILE_URL + encodeURIComponent(t.address);
  const status = statusLabel(t);
  const statusClass = t.exitOnly ? 'exit-only' : t.probation ? 'probation' : 'active';
  const isPaused = t.exitOnly && !t.active;

  const pnlClass = (v) => v >= 0 ? 'pnl-positive' : 'pnl-negative';
  const pnlStr = (v) => {
    const sign = v >= 0 ? '+' : '-';
    return `${sign}$${Math.abs(v).toFixed(2)}`;
  };

  const winRate = t.winRate != null && (t.wins + t.losses) > 0 ? (t.winRate * 100).toFixed(1) + '%' : '--';
  const slippage = t.slippageAvg != null && t.copiedTrades > 0 ? t.slippageAvg.toFixed(2) + '%' : '--';

  return `
    <tr data-address="${escapeAttr(t.address)}" style="cursor:pointer;" title="Click to expand trades">
      <td>
        <span class="trader-name-cell" title="${escapeAttr(t.name || t.address || '')}">${escapeHtml(displayName)}</span>
        <a href="${profileUrl}" target="_blank" rel="noopener noreferrer" class="trader-profile-link" title="Open on Polymarket" onclick="event.stopPropagation();">\u2197</a>
        <span class="text-muted" style="font-size:0.7rem;display:block;">${shortAddr}</span>
      </td>
      <td><span class="trader-badge ${statusClass}">${status}</span></td>
      <td>${t.copiedTrades || 0}</td>
      <td>${winRate}</td>
      <td class="${pnlClass(t.totalPnl)}">${pnlStr(t.totalPnl || 0)}</td>
      <td class="${pnlClass(t.unrealizedPnl)}">${pnlStr(t.unrealizedPnl || 0)}</td>
      <td>${t.openPositions || 0}</td>
      <td>${slippage}</td>
      <td style="white-space:nowrap;">
        <button class="trader-pause-btn" title="${isPaused ? 'Resume copying' : 'Pause copying'}"
          data-address="${escapeAttr(t.address)}"
          aria-label="${isPaused ? 'Resume' : 'Pause'}">${isPaused ? PLAY_ICON : PAUSE_ICON}</button>
        <button class="trader-remove-btn" title="Remove trader"
          data-address="${escapeAttr(t.address)}"
          data-name="${escapeAttr(displayName)}"
          data-open-positions="${t.openPositions || 0}"
          aria-label="Remove trader">${TRASH_ICON_SVG}</button>
      </td>
    </tr>
  `;
}

function statusLabel(t) {
  if (t.exitOnly) return 'Exit-only';
  if (t.probation) return 'Probation';
  return 'Active';
}

/* ---- Expandable detail row ---- */

async function toggleDetail(row) {
  const address = row.dataset.address;
  const existingDetail = row.nextElementSibling;
  if (existingDetail?.classList.contains('trader-detail-row')) {
    existingDetail.remove();
    return;
  }

  // Remove any other open detail rows
  for (const el of document.querySelectorAll('.trader-detail-row')) el.remove();

  const colSpan = row.children.length;
  const detailRow = document.createElement('tr');
  detailRow.className = 'trader-detail-row';
  detailRow.innerHTML = `<td colspan="${colSpan}" style="padding:0.5rem 1rem;"><em class="text-muted">Loading trades\u2026</em></td>`;
  row.after(detailRow);

  try {
    const trades = await fetch(`/api/traders/${encodeURIComponent(address)}/trades`).then((r) => r.json());
    if (!Array.isArray(trades) || trades.length === 0) {
      detailRow.innerHTML = `<td colspan="${colSpan}" style="padding:0.5rem 1rem;"><em class="text-muted">No trades found for this trader</em></td>`;
      return;
    }

    const rows = trades.map((t) => {
      const sideClass = t.side === 'BUY' ? 'text-green' : t.side === 'SELL' ? 'text-red' : '';
      const statusCls = t.status === 'skipped' ? 'text-muted' : '';
      return `<tr>
        <td>${relativeTime(t.timestamp)}</td>
        <td title="${escapeHtml(t.marketTitle || '')}">${escapeHtml(truncate(t.marketTitle || '--', 35))}</td>
        <td>${escapeHtml(t.outcome || '--')}</td>
        <td class="${sideClass}">${t.side}</td>
        <td>$${Number(t.totalUsd || 0).toFixed(2)}</td>
        <td class="${statusCls}">${t.status}</td>
      </tr>`;
    }).join('');

    detailRow.innerHTML = `<td colspan="${colSpan}" style="padding:0.25rem 0.5rem;">
      <table class="detail-subtable" style="width:100%;font-size:0.82rem;">
        <thead><tr>
          <th>Time</th><th>Market</th><th>Outcome</th><th>Side</th><th>Amount</th><th>Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </td>`;
  } catch (err) {
    detailRow.innerHTML = `<td colspan="${colSpan}" style="padding:0.5rem 1rem;"><em class="text-red">Failed to load trades</em></td>`;
  }
}

/* ---- Remove handler ---- */

async function handleRemove(btn) {
  const address = btn.dataset.address;
  const name = btn.dataset.name;
  const openCount = parseInt(btn.dataset.openPositions || '0', 10);

  const msg = openCount > 0
    ? `Remove ${name}?\n\n${openCount} open position${openCount === 1 ? '' : 's'} linked to this trader. The bot will keep watching for SELL signals only.`
    : `Remove ${name}?`;

  if (!confirm(msg)) return;

  try {
    btn.disabled = true;
    const res = await fetch(`/api/traders/${encodeURIComponent(address)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const toastMsg = data.mode === 'exit_only'
      ? `Moved to exit-only (${data.openPositions} position${data.openPositions === 1 ? '' : 's'} pending)`
      : 'Trader removed';
    if (window.__showToast) window.__showToast('success', toastMsg);
    await refreshAnalytics();
  } catch (err) {
    if (window.__showToast) window.__showToast('error', `Remove failed: ${err.message}`);
    btn.disabled = false;
  }
}

/* ---- Pause/Resume handler ---- */

async function handlePause(btn) {
  const address = btn.dataset.address;
  try {
    btn.disabled = true;
    const res = await fetch(`/api/traders/${encodeURIComponent(address)}/pause`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const msg = data.status === 'paused' ? 'Trader paused (exit-only)' : 'Trader resumed';
    if (window.__showToast) window.__showToast('success', msg);
    await refreshAnalytics();
  } catch (err) {
    if (window.__showToast) window.__showToast('error', `Failed: ${err.message}`);
    btn.disabled = false;
  }
}

/* ---- Helpers ---- */

function relativeTime(ts) {
  if (!ts) return '--';
  const epoch = typeof ts === 'string' ? new Date(ts).getTime() : (ts > 1e12 ? ts : ts * 1000);
  const diffMs = Date.now() - epoch;
  if (isNaN(diffMs) || diffMs < 0) return 'just now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncate(str, max) {
  if (!str || str.length <= max) return str || '';
  return str.slice(0, max - 1) + '\u2026';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  if (!str) return '';
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
