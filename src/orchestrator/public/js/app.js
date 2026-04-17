const API = '';
const REFRESH_MS = 30_000;
let selectedBot = null;
let pnlChart = null;

async function fetchJson(url, opts) {
  const res = await fetch(`${API}${url}`, { signal: AbortSignal.timeout(10_000), ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// --- Bots Table ---

async function refreshBots() {
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
    tr.className = 'bot-row';
    tr.dataset.bot = bot.name;
    tr.innerHTML = `
      <td><strong>${bot.name}</strong></td>
      <td><span class="badge ${statusClass}">${bot.status}</span></td>
      <td class="${pnlClass}">${pnlSign}$${pnl.toFixed(2)}</td>
      <td>${wr}</td>
      <td>${bot.totalTrades ?? 0}</td>
      <td>${bot.openPositions ?? 0}</td>
      <td>$${(bot.demoBalance ?? 0).toFixed(2)}</td>
      <td class="${(bot.todayPnl ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}">${(bot.todayPnl ?? 0) >= 0 ? '+' : ''}$${(bot.todayPnl ?? 0).toFixed(2)}</td>
      <td class="actions-cell">
        <button class="btn-sm btn-green" onclick="controlBot('${bot.name}', 'start')">Start</button>
        <button class="btn-sm btn-red" onclick="controlBot('${bot.name}', 'stop')">Stop</button>
        <button class="btn-sm btn-outline" onclick="selectBot('${bot.name}', ${bot.port})">Settings</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

// --- Bot Control ---

async function controlBot(name, action) {
  await fetchJson(`/api/bots/${name}/${action}`, { method: 'POST' });
  await refreshBots();
}

// --- Bot Detail / Settings ---

async function selectBot(name, port) {
  selectedBot = { name, port };
  document.getElementById('bot-detail').classList.remove('hidden');
  document.getElementById('detail-bot-name').textContent = name;
  document.getElementById('link-full-dashboard').href = `http://localhost:${port}`;

  try {
    const settings = await fetchJson(`/api/bots/${name}/proxy/auth/settings`);
    renderSettings(settings);
  } catch (err) {
    document.getElementById('detail-settings').innerHTML = '<p class="error">Failed to load settings</p>';
  }
}

function renderSettings(settings) {
  const container = document.getElementById('detail-settings');
  const keys = Object.keys(settings).sort();
  container.innerHTML = '<div class="settings-grid">' + keys.map(key =>
    `<label class="setting-row">
      <span class="setting-key">${key}</span>
      <input type="text" class="setting-input" data-key="${key}" value="${settings[key] ?? ''}">
    </label>`
  ).join('') + '</div>';
}

document.getElementById('btn-save-settings')?.addEventListener('click', async () => {
  if (!selectedBot) return;
  const inputs = document.querySelectorAll('#detail-settings .setting-input');
  const body = {};
  inputs.forEach(input => { body[input.dataset.key] = input.value; });
  await fetchJson(`/api/bots/${selectedBot.name}/proxy/auth/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  alert('Settings saved');
});

document.getElementById('btn-bot-start-trading')?.addEventListener('click', async () => {
  if (!selectedBot) return;
  await fetchJson(`/api/bots/${selectedBot.name}/proxy/bot/start`, { method: 'POST' });
  await refreshBots();
});

document.getElementById('btn-bot-stop-trading')?.addEventListener('click', async () => {
  if (!selectedBot) return;
  await fetchJson(`/api/bots/${selectedBot.name}/proxy/bot/stop`, { method: 'POST' });
  await refreshBots();
});

// --- Start All / Stop All ---

document.getElementById('btn-start-all')?.addEventListener('click', async () => {
  const bots = await fetchJson('/api/bots');
  for (const bot of bots) {
    if (bot.status !== 'running') await controlBot(bot.name, 'start');
  }
});

document.getElementById('btn-stop-all')?.addEventListener('click', async () => {
  const bots = await fetchJson('/api/bots');
  for (const bot of bots) {
    if (bot.status === 'running') await controlBot(bot.name, 'stop');
  }
});

// --- PnL Chart ---

async function refreshChart() {
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
}

// Make functions available globally for onclick handlers
window.controlBot = controlBot;
window.selectBot = selectBot;

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
