// Charts Module
let pnlChart = null;

export function initCharts() {
  const ctx = document.getElementById('pnl-chart');
  if (!ctx) return;

  pnlChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'P&L ($)',
        data: [],
        borderColor: '#3fb950',
        backgroundColor: 'rgba(63, 185, 80, 0.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: (ctx) => `P&L: $${ctx.parsed.y.toFixed(2)}`,
          }
        }
      },
      scales: {
        x: {
          grid: { color: '#21262d' },
          ticks: { color: '#8b949e', maxTicksLimit: 10 },
        },
        y: {
          grid: { color: '#21262d' },
          ticks: {
            color: '#8b949e',
            callback: (val) => '$' + val,
          },
          beginAtZero: false,
        }
      },
      interaction: {
        mode: 'nearest',
        axis: 'x',
        intersect: false,
      }
    }
  });

  // Wire up period toggles
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      await loadPnlData(btn.dataset.period);
    });
  });

  // Load initial data
  loadPnlData('24h');
}

async function loadPnlData(period) {
  try {
    const res = await fetch(`/api/pnl-history?period=${period}`);
    const snapshots = await res.json();

    updateChart(snapshots);
  } catch (err) {
    console.error('Failed to load P&L data:', err);
  }
}

function updateChart(snapshots) {
  if (!pnlChart) return;

  // Sort chronologically
  snapshots.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  pnlChart.data.labels = snapshots.map(s => {
    const d = new Date(s.timestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });

  pnlChart.data.datasets[0].data = snapshots.map(s => s.totalPnl);

  // Color based on last value
  const lastPnl = snapshots.length > 0 ? snapshots[snapshots.length - 1].totalPnl : 0;
  const color = lastPnl >= 0 ? '#3fb950' : '#f85149';
  pnlChart.data.datasets[0].borderColor = color;
  pnlChart.data.datasets[0].backgroundColor = lastPnl >= 0 ? 'rgba(63,185,80,0.1)' : 'rgba(248,81,73,0.1)';

  pnlChart.update();
}

// Called from SSE to add a new point
export function addPnlPoint(snapshot) {
  if (!pnlChart) return;

  const d = new Date(snapshot.timestamp);
  const label = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  pnlChart.data.labels.push(label);
  pnlChart.data.datasets[0].data.push(snapshot.totalPnl);

  // Keep max 200 points
  if (pnlChart.data.labels.length > 200) {
    pnlChart.data.labels.shift();
    pnlChart.data.datasets[0].data.shift();
  }

  pnlChart.update();
}

// Expose for SSE
window.__addPnlPoint = addPnlPoint;
