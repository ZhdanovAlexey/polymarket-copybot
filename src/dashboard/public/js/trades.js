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
}

/* ---- Internal rendering ---- */

function renderTable() {
  const tbody = document.getElementById('trade-log-body');
  if (!tbody) return;

  // Expose re-render hook so the shared sort helper in app.js can trigger it.
  if (typeof window !== 'undefined') {
    window.__rerenderTradeLog = renderTable;
  }

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
        t.error,
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
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">No trades found</td></tr>`;
    return;
  }

  // Apply external sort state (set by app.js click handler) if present.
  const sortState = (typeof window !== 'undefined' && window.__sortTradeLog) || null;
  const sorted = sortState ? window.__sortTradeLog(filtered) : filtered;

  tbody.innerHTML = sorted
    .map(
      (t) => `
    <tr>
      <td title="${escapeHtml(t.timestamp)}">${relativeTime(t.timestamp)}</td>
      <td title="${escapeHtml(t.traderAddress)}">${escapeHtml(truncateName(t.traderName || t.traderAddress))}</td>
      <td title="${escapeHtml(t.marketTitle)}">${marketLink(t.marketSlug, t.marketTitle, 40)}</td>
      <td class="${sideClass(t.side)}">${t.side}</td>
      <td>${escapeHtml(t.outcome || '--')}</td>
      <td>$${Number(t.totalUsd || 0).toFixed(2)}</td>
      <td>$${Number(t.commission || 0).toFixed(2)}</td>
      <td><span class="status-pill ${t.status}"${t.error ? ` title="${escapeHtml(t.error)}"` : ''}>${t.status}</span></td>
      <td class="trade-reason" title="${escapeHtml(t.error || '')}">${t.error ? escapeHtml(truncate(t.error, 60)) : '\u2014'}</td>
    </tr>`,
    )
    .join('');
}

/* ---- CSV Export ---- */

function exportCsv() {
  if (allTrades.length === 0) return;

  const header = ['Time', 'Trader', 'Address', 'Market', 'Side', 'Outcome', 'Size', 'Price', 'Total USD', 'Fee', 'Status', 'Reason'];
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
    t.commission || 0,
    t.status,
    `"${(t.error || '').replace(/"/g, '""')}"`,
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

function sideClass(side) {
  if (side === 'BUY') return 'side-buy';
  if (side === 'REDEEM') return 'side-redeem';
  return 'side-sell';
}

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
