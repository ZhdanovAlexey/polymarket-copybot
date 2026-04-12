/**
 * trades.js — Trade log table management
 *
 * Exports:
 *   initTrades()            — wire up search, filter, export
 *   updateTrades(trades)    — full replacement of trade list
 *   addTrade(trade)         — prepend a single new trade (for SSE)
 */

let allTrades = [];
let currentSearch = '';
let currentFilter = 'all';

/**
 * Initialise event listeners for search, filter dropdown, and CSV export.
 */
export function initTrades() {
  const searchInput = document.getElementById('trade-search');
  const filterSelect = document.getElementById('trade-filter');
  const exportBtn = document.getElementById('btn-export-csv');

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      currentSearch = e.target.value.toLowerCase().trim();
      renderTable();
    });
  }

  if (filterSelect) {
    filterSelect.addEventListener('change', (e) => {
      currentFilter = e.target.value;
      renderTable();
    });
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', exportCsv);
  }
}

/**
 * Replace the full trade list and re-render.
 * @param {Array} trades — array of TradeResult objects from /api/trades
 */
export function updateTrades(trades) {
  if (!Array.isArray(trades)) return;
  allTrades = trades;
  renderTable();
}

/**
 * Prepend a single trade to the top of the list (used by SSE live updates).
 * @param {Object} trade — single TradeResult
 */
export function addTrade(trade) {
  if (!trade) return;
  allTrades.unshift(trade);
  // Keep a reasonable in-memory cap
  if (allTrades.length > 500) {
    allTrades = allTrades.slice(0, 500);
  }
  renderTable();
  addToLiveFeed(trade);
}

/* ---- Internal rendering ---- */

function renderTable() {
  const tbody = document.getElementById('trade-log-body');
  if (!tbody) return;

  const filtered = allTrades.filter((t) => {
    // Status filter
    if (currentFilter !== 'all' && t.status !== currentFilter) {
      return false;
    }
    // Text search
    if (currentSearch) {
      const haystack = [
        t.traderName,
        t.traderAddress,
        t.marketTitle,
        t.marketSlug,
        t.outcome,
        t.side,
        t.status,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(currentSearch)) {
        return false;
      }
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No trades found</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map(
      (t) => `
    <tr>
      <td title="${escapeHtml(t.timestamp)}">${relativeTime(t.timestamp)}</td>
      <td title="${escapeHtml(t.traderAddress)}">${escapeHtml(truncateName(t.traderName || t.traderAddress))}</td>
      <td title="${escapeHtml(t.marketTitle)}">${escapeHtml(truncate(t.marketTitle, 40))}</td>
      <td class="${t.side === 'BUY' ? 'side-buy' : 'side-sell'}">${t.side}</td>
      <td>${escapeHtml(t.outcome || '--')}</td>
      <td>$${Number(t.totalUsd || 0).toFixed(2)}</td>
      <td><span class="status-pill ${t.status}">${t.status}</span></td>
    </tr>`,
    )
    .join('');
}

function addToLiveFeed(trade) {
  const feed = document.getElementById('live-feed');
  if (!feed) return;

  // Remove empty state if present
  const empty = feed.querySelector('.empty-state');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'feed-item';
  item.innerHTML = `
    <span class="feed-time">${formatTime(trade.timestamp)}</span>
    <span class="feed-side ${trade.side === 'BUY' ? 'buy' : 'sell'}">${trade.side}</span>
    <span class="feed-details">
      <strong>${escapeHtml(truncateName(trade.traderName))}</strong>
      ${escapeHtml(truncate(trade.marketTitle, 35))}
      &middot; $${Number(trade.totalUsd || 0).toFixed(2)}
    </span>
  `;

  feed.prepend(item);

  // Limit feed items
  const items = feed.querySelectorAll('.feed-item');
  if (items.length > 50) {
    items[items.length - 1].remove();
  }
}

/* ---- CSV Export ---- */

function exportCsv() {
  if (allTrades.length === 0) return;

  const header = ['Time', 'Trader', 'Address', 'Market', 'Side', 'Outcome', 'Size', 'Price', 'Total USD', 'Status'];
  const rows = allTrades.map((t) => [
    t.timestamp,
    t.traderName,
    t.traderAddress,
    `"${(t.marketTitle || '').replace(/"/g, '""')}"`,
    t.side,
    t.outcome,
    t.size,
    t.price,
    t.totalUsd,
    t.status,
  ]);

  const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `copybot-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---- Formatting helpers ---- */

function relativeTime(timestamp) {
  if (!timestamp) return '--';
  const date = new Date(timestamp);
  const now = Date.now();
  const diffMs = now - date.getTime();

  if (isNaN(diffMs)) return '--';
  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return date.toLocaleDateString();
}

function formatTime(timestamp) {
  if (!timestamp) return '--';
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return '--';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

function truncateName(name) {
  if (!name) return 'Unknown';
  if (name.length <= 16) return name;
  // If it looks like an address, show first 6 + last 4
  if (name.startsWith('0x') && name.length > 20) {
    return name.slice(0, 6) + '\u2026' + name.slice(-4);
  }
  return name.slice(0, 14) + '\u2026';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
