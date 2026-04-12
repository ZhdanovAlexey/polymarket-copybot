/**
 * traders.js — Tracked trader cards
 *
 * Exports:
 *   initTraders()            — initial setup (no-op for now, placeholder for future)
 *   updateTraders(traders)   — render the full traders list
 */

/**
 * Initialise traders section. Currently a no-op; can be used for
 * future features like drag-to-reorder or context menus.
 */
export function initTraders() {
  // Placeholder for future initialisation
}

/**
 * Render the tracked traders list.
 * @param {Array} traders — array of TrackedTrader objects from /api/traders
 */
export function updateTraders(traders) {
  const container = document.getElementById('traders-list');
  if (!container) return;

  if (!Array.isArray(traders) || traders.length === 0) {
    container.innerHTML = '<p class="empty-state">No tracked traders</p>';
    return;
  }

  container.innerHTML = traders.map(renderTraderCard).join('');
}

/* ---- Internal rendering ---- */

function renderTraderCard(trader) {
  const pnlClass = trader.pnl >= 0 ? 'text-green' : 'text-red';
  const pnlSign = trader.pnl >= 0 ? '+' : '';
  const badge = trader.probation
    ? '<span class="trader-badge probation">Probation</span>'
    : '<span class="trader-badge active">Active</span>';

  const shortAddr = trader.address
    ? trader.address.slice(0, 6) + '\u2026' + trader.address.slice(-4)
    : '';

  const lastActive = trader.lastSeenTimestamp
    ? relativeTime(trader.lastSeenTimestamp)
    : 'never';

  return `
    <div class="trader-card" data-address="${escapeAttr(trader.address)}">
      <div class="trader-info">
        <span class="trader-name">${escapeHtml(trader.name || shortAddr)}</span>
        <span class="trader-address">${shortAddr}</span>
        <span class="text-muted" style="font-size:0.72rem;">Last active: ${lastActive}</span>
      </div>
      <div class="trader-stats">
        <div class="trader-stat">
          <div class="trader-stat-label">P&amp;L</div>
          <div class="trader-stat-value ${pnlClass}">${pnlSign}$${Math.abs(trader.pnl || 0).toFixed(2)}</div>
        </div>
        <div class="trader-stat">
          <div class="trader-stat-label">Score</div>
          <div class="trader-stat-value">${(trader.score || 0).toFixed(1)}</div>
        </div>
        <div class="trader-stat">
          <div class="trader-stat-label">Trades</div>
          <div class="trader-stat-value">${trader.tradesCount || 0}</div>
        </div>
        <div style="display:flex;align-items:center;">
          ${badge}
        </div>
      </div>
    </div>
  `;
}

/* ---- Helpers ---- */

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
