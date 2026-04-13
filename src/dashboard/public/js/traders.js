/**
 * traders.js — Tracked trader cards
 *
 * Exports:
 *   initTraders()            — wire delegated click handlers
 *   updateTraders(traders)   — render the full traders list
 */

const POLYMARKET_PROFILE_URL = 'https://polymarket.com/profile/';

// Inline trash icon (SVG) — stroked, inherits currentColor so CSS can style it.
const TRASH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path></svg>`;

// Target count (top_traders_count) + leaderboard period — fetched from
// /api/settings on init and refreshed after manual refresh / settings save.
// Falls back to current list length / empty label if unknown.
let targetCount = 0;
let periodLabel = '';

const PERIOD_LABELS = { DAY: '1d', WEEK: '7d', MONTH: '30d', ALL: 'all' };

async function fetchTargetCount() {
  try {
    const s = await fetch('/api/settings').then((r) => r.json());
    const n = Number(s?.topTradersCount ?? s?.top_traders_count ?? 0);
    if (Number.isFinite(n) && n > 0) targetCount = n;
    const period = String(s?.leaderboardPeriod ?? s?.leaderboard_period ?? '').toUpperCase();
    periodLabel = PERIOD_LABELS[period] ?? '';
  } catch {
    /* ignore — counter falls back to list length */
  }
}

// Expose so settings.js can re-sync target after Save.
if (typeof window !== 'undefined') {
  window.__refreshTradersTarget = fetchTargetCount;
}

/**
 * Wire event delegation for Remove (×) buttons on trader cards and the
 * Refresh Leaderboard button.
 */
export function initTraders() {
  const container = document.getElementById('traders-list');
  if (!container) return;

  // Kick off target fetch (non-blocking)
  fetchTargetCount();

  // Manual leaderboard refresh
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
        await fetchTargetCount();
        const refreshed = await fetch('/api/traders').then((r) => r.json());
        updateTraders(refreshed);
      } catch (err) {
        if (window.__showToast) window.__showToast('error', `Refresh failed: ${err.message}`);
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.innerHTML = originalLabel;
      }
    });
  }

  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('.trader-remove-btn');
    if (!btn) return;

    const address = btn.dataset.address;
    const name = btn.dataset.name;
    const openCount = parseInt(btn.dataset.openPositions || '0', 10);

    const msg = openCount > 0
      ? `Remove ${name}?\n\n${openCount} open position${openCount === 1 ? '' : 's'} linked to this trader. The bot will keep watching them for SELL signals only, then auto-remove once all positions close.`
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

      // Trigger an immediate refresh by re-fetching /api/traders
      const refreshed = await fetch('/api/traders').then((r) => r.json());
      updateTraders(refreshed);
    } catch (err) {
      if (window.__showToast) window.__showToast('error', `Remove failed: ${err.message}`);
      btn.disabled = false;
    }
  });
}

/**
 * Render the tracked traders list.
 * @param {Array} traders — array of TrackedTrader objects (with openPositionsCount)
 */
export function updateTraders(traders) {
  const container = document.getElementById('traders-list');
  const countEl = document.getElementById('traders-count');
  if (!container) return;

  const safeList = Array.isArray(traders) ? traders : [];
  if (countEl) {
    const target = targetCount > 0 ? targetCount : safeList.length;
    countEl.textContent = `(${safeList.length}/${target})`;
    const latest = safeList.reduce(
      (max, t) => Math.max(max, Number(t.lastSeenTimestamp || 0)),
      0,
    );
    countEl.title = latest
      ? `Last refreshed ${relativeTime(latest)}`
      : '';
  }

  if (safeList.length === 0) {
    container.innerHTML = '<p class="empty-state">No tracked traders</p>';
    return;
  }

  container.innerHTML = safeList.map(renderTraderCard).join('');
}

/* ---- Internal rendering ---- */

function renderTraderCard(trader) {
  const pnlClass = trader.pnl >= 0 ? 'text-green' : 'text-red';
  const pnlSign = trader.pnl >= 0 ? '+' : '-';

  let badge;
  if (trader.exitOnly) {
    badge = '<span class="trader-badge exit-only" title="Bot copies SELL signals only; auto-removes when all positions close">Exit-only</span>';
  } else if (trader.probation) {
    badge = '<span class="trader-badge probation">Probation</span>';
  } else {
    badge = '<span class="trader-badge active">Active</span>';
  }

  const shortAddr = trader.address
    ? trader.address.slice(0, 6) + '\u2026' + trader.address.slice(-4)
    : '';

  const lastActive = trader.lastSeenTimestamp
    ? relativeTime(trader.lastSeenTimestamp)
    : 'never';

  const openPositions = Number(trader.openPositionsCount || 0);
  const profileUrl = POLYMARKET_PROFILE_URL + encodeURIComponent(trader.address);

  return `
    <div class="trader-card" data-address="${escapeAttr(trader.address)}">
      <div class="trader-info">
        <span class="trader-name" title="${escapeAttr(trader.name || trader.address || '')}">${escapeHtml(trader.name || shortAddr)}</span>
        <span class="trader-address">${shortAddr}</span>
        <span class="text-muted" style="font-size:0.72rem;">Last active: ${lastActive}</span>
      </div>
      <div class="trader-stats">
        <div class="trader-stat">
          <div class="trader-stat-label">P&amp;L${periodLabel ? ` (${periodLabel})` : ''}</div>
          <div class="trader-stat-value ${pnlClass}">${pnlSign}$${formatIntWithCommas(Math.abs(trader.pnl || 0))}</div>
        </div>
        <div class="trader-stat">
          <div class="trader-stat-label">Score</div>
          <div class="trader-stat-value">${(trader.score || 0).toFixed(1)}</div>
        </div>
        <div class="trader-stat" title="Number of recent trades fetched from Polymarket used for scoring (capped at 100)">
          <div class="trader-stat-label">Trades</div>
          <div class="trader-stat-value">${trader.tradesCount || 0}</div>
        </div>
        <div class="trader-stat" title="Open positions in our bot that were opened by copying this trader's BUYs">
          <div class="trader-stat-label">Open pos.</div>
          <div class="trader-stat-value">${openPositions}</div>
        </div>
        <div class="trader-actions">
          ${badge}
          <a class="trader-link" href="${profileUrl}" target="_blank" rel="noopener noreferrer" title="Open profile on Polymarket">\u2197</a>
          <button
            class="trader-remove-btn"
            title="Remove trader"
            data-address="${escapeAttr(trader.address)}"
            data-name="${escapeAttr(trader.name || shortAddr)}"
            data-open-positions="${openPositions}"
            aria-label="Remove trader"
          >${TRASH_ICON_SVG}</button>
        </div>
      </div>
    </div>
  `;
}

/* ---- Helpers ---- */

function formatIntWithCommas(n) {
  const v = Number.isFinite(n) ? n : 0;
  return Math.round(v).toLocaleString('en-US');
}

function relativeTime(ts) {
  if (!ts) return '--';
  // Handle both epoch-ms and epoch-seconds
  const epoch = ts > 1e12 ? ts : ts * 1000;
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

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  if (!str) return '';
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
