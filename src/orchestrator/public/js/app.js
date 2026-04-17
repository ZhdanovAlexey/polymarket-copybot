const REFRESH_MS = 30_000;
let selectedBot = null;
let pnlChart = null;

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// --- Bots Table ---

async function refreshBots() {
  try {
    const bots = await fetchJson('/api/comparison');
    const tbody = document.getElementById('bots-tbody');
    tbody.innerHTML = '';

    for (const bot of bots) {
      const pnl = bot.totalPnl ?? 0;
      const pnlClass = pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
      const pnlSign = pnl >= 0 ? '+' : '';
      const wr = bot.winRate != null ? (bot.winRate * 100).toFixed(1) + '%' : '--';
      const statusClass = bot.status === 'running' ? 'status-running' : bot.status === 'crashed' ? 'status-crashed' : 'status-stopped';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <a href="/bots/${bot.name}/" class="bot-link" title="Open ${bot.name} dashboard">${bot.name}</a>
        </td>
        <td><span class="badge ${statusClass}">${bot.status}</span></td>
        <td class="${pnlClass}">${pnlSign}$${pnl.toFixed(2)}</td>
        <td>${wr}</td>
        <td>${bot.totalTrades ?? 0}</td>
        <td>${bot.openPositions ?? 0}</td>
        <td>$${(bot.demoBalance ?? 0).toFixed(2)}</td>
        <td class="${(bot.todayPnl ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}">${(bot.todayPnl ?? 0) >= 0 ? '+' : ''}$${(bot.todayPnl ?? 0).toFixed(2)}</td>
        <td class="actions-cell">
          <button class="icon-btn" onclick="startTrading('${bot.name}')" title="Start trading">&#9654;</button>
          <button class="icon-btn" onclick="stopTrading('${bot.name}')" title="Stop trading">&#9724;</button>
          <button class="icon-btn" onclick="openSettings('${bot.name}')" title="Settings">&#9881;</button>
          <a href="/bots/${bot.name}/" class="icon-btn" title="Open dashboard">&#128279;</a>
        </td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    console.error('Failed to refresh bots:', err);
  }
}

// --- Trading Control (via proxy to bot's /api/bot/start|stop) ---

async function startTrading(name) {
  try {
    await fetchJson(`/api/bots/${name}/proxy/bot/start`, { method: 'POST' });
  } catch (err) {
    console.error(`Failed to start trading for ${name}:`, err);
  }
  await refreshBots();
}

async function stopTrading(name) {
  try {
    await fetchJson(`/api/bots/${name}/proxy/bot/stop`, { method: 'POST' });
  } catch (err) {
    console.error(`Failed to stop trading for ${name}:`, err);
  }
  await refreshBots();
}

// --- Start All / Stop All (process + trading) ---

document.getElementById('btn-start-all')?.addEventListener('click', async () => {
  const bots = await fetchJson('/api/bots');
  for (const bot of bots) {
    // Start process if not running
    if (bot.status !== 'running') {
      await fetchJson(`/api/bots/${bot.name}/start`, { method: 'POST' });
      // Wait for bot to boot up
      await new Promise(r => setTimeout(r, 3000));
    }
    // Start trading
    try {
      await fetchJson(`/api/bots/${bot.name}/proxy/bot/start`, { method: 'POST' });
    } catch { /* bot may still be booting */ }
  }
  await refreshBots();
});

document.getElementById('btn-stop-all')?.addEventListener('click', async () => {
  const bots = await fetchJson('/api/bots');
  for (const bot of bots) {
    if (bot.status === 'running') {
      // Stop trading first
      try {
        await fetchJson(`/api/bots/${bot.name}/proxy/bot/stop`, { method: 'POST' });
      } catch { /* ignore */ }
    }
  }
  await refreshBots();
});

// --- Settings Modal ---

async function openSettings(name) {
  selectedBot = name;
  document.getElementById('modal-bot-name').textContent = name;
  document.getElementById('settings-modal').classList.remove('hidden');
  document.getElementById('modal-settings-body').innerHTML = '<p class="loading">Loading settings...</p>';

  try {
    const settings = await fetchJson(`/api/bots/${name}/proxy/auth/settings`);
    renderSettingsModal(settings);
  } catch (err) {
    document.getElementById('modal-settings-body').innerHTML =
      `<p class="error">Failed to load settings: ${err.message}</p>`;
  }
}

function renderSettingsModal(settings) {
  const container = document.getElementById('modal-settings-body');
  const keys = Object.keys(settings).sort();
  container.innerHTML = '<div class="settings-grid">' + keys.map(key =>
    `<div class="setting-row">
      <label class="setting-key">${key}</label>
      <input type="text" class="setting-input" data-key="${key}" value="${settings[key] ?? ''}">
    </div>`
  ).join('') + '</div>';
}

function closeModal() {
  document.getElementById('settings-modal').classList.add('hidden');
  selectedBot = null;
}

document.getElementById('modal-close')?.addEventListener('click', closeModal);
document.getElementById('btn-modal-cancel')?.addEventListener('click', closeModal);

// Close modal on overlay click
document.getElementById('settings-modal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});

document.getElementById('btn-modal-save')?.addEventListener('click', async () => {
  if (!selectedBot) return;
  const inputs = document.querySelectorAll('#modal-settings-body .setting-input');
  const body = {};
  inputs.forEach(input => { body[input.dataset.key] = input.value; });
  try {
    await fetchJson(`/api/bots/${selectedBot}/proxy/auth/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    closeModal();
  } catch (err) {
    alert('Failed to save: ' + err.message);
  }
});

// --- PnL Chart ---

async function refreshChart() {
  try {
    const bots = await fetchJson('/api/bots');
    const datasets = [];
    const colors = ['#3fb950', '#f85149', '#58a6ff', '#d2a8ff', '#f0883e'];

    let idx = 0;
    for (const bot of bots) {
      if (bot.status !== 'running') { idx++; continue; }
      try {
        const history = await fetchJson(`/api/bots/${bot.name}/proxy/pnl-history?period=24h`);
        if (history && history.length > 0) {
          datasets.push({
            label: bot.name,
            data: history.map(s => ({ x: new Date(s.timestamp), y: s.totalPnl ?? s.total_pnl ?? 0 })),
            borderColor: colors[idx % colors.length],
            tension: 0.3,
            pointRadius: 0,
          });
        }
      } catch { /* bot unreachable */ }
      idx++;
    }

    const ctx = document.getElementById('pnl-chart');
    if (pnlChart) pnlChart.destroy();
    pnlChart = new Chart(ctx, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        scales: {
          x: { type: 'time', time: { unit: 'hour' }, ticks: { color: '#8b949e' }, grid: { color: '#21262d' } },
          y: { title: { display: true, text: 'PnL ($)', color: '#8b949e' }, ticks: { color: '#8b949e' }, grid: { color: '#21262d' } },
        },
        plugins: { legend: { position: 'top', labels: { color: '#c9d1d9' } } },
      },
    });
  } catch (err) {
    console.error('Failed to refresh chart:', err);
  }
}

// Make functions available globally for onclick handlers
window.startTrading = startTrading;
window.stopTrading = stopTrading;
window.openSettings = openSettings;

// --- Init ---

async function init() {
  await refreshBots();
  await refreshChart();
  setInterval(async () => {
    await refreshBots();
    await refreshChart();
  }, REFRESH_MS);
}

init().catch(console.error);
