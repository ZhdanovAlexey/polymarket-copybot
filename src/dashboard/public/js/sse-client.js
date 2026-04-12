// SSE Client Module
let eventSource = null;
let reconnectTimeout = null;

export function initSSE() {
  connect();
}

function connect() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource('/api/sse');

  eventSource.onopen = () => {
    console.log('SSE connected');
    // Clear any reconnect timer
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
  };

  // Listen for specific event types
  eventSource.addEventListener('trade', (e) => {
    const { data } = JSON.parse(e.data);
    // Add trade to live feed and trade log
    if (window.__addTrade) window.__addTrade(data);
    if (window.__showToast) window.__showToast(`Trade: ${data.side} ${data.marketTitle}`, data.status === 'filled' ? 'success' : 'info');
  });

  eventSource.addEventListener('balance', (e) => {
    const { data } = JSON.parse(e.data);
    // Update header balances
    document.getElementById('usdc-balance').textContent = `USDC: $${data.usdc.toFixed(2)}`;
    document.getElementById('matic-balance').textContent = `MATIC: ${data.matic.toFixed(4)}`;
  });

  eventSource.addEventListener('status', (e) => {
    const { data } = JSON.parse(e.data);
    const badge = document.getElementById('bot-status');
    if (data.running) {
      badge.textContent = '● Running';
      badge.className = 'status-badge running';
    } else {
      badge.textContent = '● Stopped';
      badge.className = 'status-badge stopped';
    }
  });

  eventSource.addEventListener('alert', (e) => {
    const { data } = JSON.parse(e.data);
    if (window.__showToast) {
      window.__showToast(data.message, data.severity === 'error' ? 'error' : 'warning');
    }
  });

  eventSource.addEventListener('pnl_update', (e) => {
    const { data } = JSON.parse(e.data);
    // Update chart with new data point
    if (window.__addPnlPoint) window.__addPnlPoint(data);
  });

  eventSource.onerror = () => {
    console.warn('SSE connection lost, reconnecting in 5s...');
    eventSource.close();
    reconnectTimeout = setTimeout(connect, 5000);
  };
}

export function closeSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}
