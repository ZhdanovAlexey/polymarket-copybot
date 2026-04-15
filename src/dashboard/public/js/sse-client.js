// SSE Client Module — auto-connects on module load
let eventSource = null;
let reconnectTimeout = null;

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
    // Add trade to live feed and trade log (no toast — too noisy)
    if (window.__addTrade) window.__addTrade(data);
  });

  eventSource.addEventListener('balance', (e) => {
    const { data } = JSON.parse(e.data);
    const usdcEl = document.getElementById('usdc-balance');
    if (usdcEl && data.usdc != null) usdcEl.textContent = `USDC: $${data.usdc.toFixed(2)}`;
    const maticEl = document.getElementById('matic-balance');
    if (maticEl && data.matic != null) maticEl.textContent = `MATIC: ${data.matic.toFixed(4)}`;
  });

  eventSource.addEventListener('status', (e) => {
    const { data } = JSON.parse(e.data);
    const badge = document.getElementById('bot-status');
    if (!badge) return;
    if (data.running) {
      badge.textContent = '● Running';
      badge.className = 'status-badge running';
    } else {
      badge.textContent = '● Stopped';
      badge.className = 'status-badge stopped';
    }
  });

  eventSource.addEventListener('alert', (e) => {
    // Alerts are logged server-side; no UI toasts.
    const { data } = JSON.parse(e.data);
    console.warn('[alert]', data.severity, data.message);
  });

  eventSource.addEventListener('pnl_update', (e) => {
    const { data } = JSON.parse(e.data);
    // Update chart with new data point
    if (window.__addPnlPoint) window.__addPnlPoint(data);
  });

  eventSource.onerror = () => {
    // EventSource auto-reconnects by default. Only force a new connection
    // if it's in CLOSED state (unrecoverable).
    if (eventSource && eventSource.readyState === EventSource.CLOSED) {
      console.warn('SSE closed, forcing reconnect in 5s...');
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      reconnectTimeout = setTimeout(connect, 5000);
    }
  };
}

export function closeSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

// Auto-connect on module load (ES module top-level executes once)
connect();
