/**
 * settings.js -- Setup Wizard + Settings Modal
 *
 * Setup Wizard (4 steps):
 *   1. Connect wallet (enter private key -> show address + balances)
 *   2. Activate trading (derive API keys, approve USDC, approve CTF)
 *   3. Bot settings (bet size, trader count, poll interval, etc.)
 *   4. Pre-flight check (verify everything works)
 *
 * Settings modal (gear icon):
 *   Same settings form as step 3, with Save button
 */

const API = '';

/* ================================================================
   Wizard state
   ================================================================ */

let wizardStep = 1;
let walletData = null; // { address, usdcBalance, maticBalance }

/* ================================================================
   Wizard HTML
   ================================================================ */

function buildWizardHtml() {
  return `
    <div class="wizard-overlay">
      <div class="wizard-container">
        <div class="wizard-header">
          <h2 class="wizard-title">Setup Wizard</h2>
          <button id="wiz-skip-btn" class="btn btn-secondary btn-small">Skip (Dry Run)</button>
        </div>
        <div class="wizard-steps">
          <div class="wizard-step-indicator" id="step-ind-1">1. Wallet</div>
          <div class="wizard-step-indicator" id="step-ind-2">2. Activate</div>
          <div class="wizard-step-indicator" id="step-ind-3">3. Settings</div>
          <div class="wizard-step-indicator" id="step-ind-4">4. Pre-flight</div>
        </div>

        <!-- Step 1: Connect Wallet -->
        <div class="wizard-panel" id="wizard-step-1">
          <h3>Connect Wallet</h3>
          <p>Enter your Polygon wallet private key. It will be saved securely on the server and never transmitted.</p>
          <div class="form-group">
            <label for="wiz-private-key">Private Key</label>
            <input type="password" id="wiz-private-key" class="input-field"
                   placeholder="0x..." autocomplete="off">
          </div>
          <div id="wiz-wallet-info" class="wizard-info hidden">
            <div><strong>Address:</strong> <span id="wiz-address">--</span></div>
            <div><strong>USDC:</strong> <span id="wiz-usdc">--</span></div>
            <div><strong>MATIC:</strong> <span id="wiz-matic">--</span></div>
          </div>
          <div id="wiz-step1-error" class="wizard-error hidden"></div>
          <div class="wizard-actions">
            <button id="wiz-connect-btn" class="btn btn-primary">Connect Wallet</button>
            <button id="wiz-step1-next" class="btn btn-secondary hidden" disabled>Next</button>
          </div>
        </div>

        <!-- Step 2: Activate Trading -->
        <div class="wizard-panel hidden" id="wizard-step-2">
          <h3>Activate Trading</h3>
          <p>Derive API keys and approve token spending. Each step must complete in order.</p>

          <div class="wizard-activate-step">
            <span class="activate-label">1. Derive API Keys</span>
            <button id="wiz-derive-btn" class="btn btn-primary btn-small">Derive Keys</button>
            <span id="wiz-derive-status" class="activate-status"></span>
          </div>

          <div class="wizard-activate-step">
            <span class="activate-label">2. Approve USDC Spending</span>
            <button id="wiz-approve-usdc-btn" class="btn btn-primary btn-small" disabled>Approve USDC</button>
            <span id="wiz-usdc-status" class="activate-status"></span>
          </div>

          <div class="wizard-activate-step">
            <span class="activate-label">3. Approve CTF Tokens</span>
            <button id="wiz-approve-ctf-btn" class="btn btn-primary btn-small" disabled>Approve CTF</button>
            <span id="wiz-ctf-status" class="activate-status"></span>
          </div>

          <div id="wiz-step2-error" class="wizard-error hidden"></div>
          <div class="wizard-actions">
            <button id="wiz-step2-back" class="btn btn-secondary">Back</button>
            <button id="wiz-step2-next" class="btn btn-primary" disabled>Next</button>
          </div>
        </div>

        <!-- Step 3: Bot Settings -->
        <div class="wizard-panel hidden" id="wizard-step-3">
          <h3>Bot Settings</h3>
          <p>Configure your copy-trading parameters. You can change these later.</p>
          ${buildSettingsFormHtml('wiz')}
          <div class="wizard-actions">
            <button id="wiz-step3-back" class="btn btn-secondary">Back</button>
            <button id="wiz-step3-next" class="btn btn-primary">Next</button>
          </div>
        </div>

        <!-- Step 4: Pre-flight Check -->
        <div class="wizard-panel hidden" id="wizard-step-4">
          <h3>Pre-flight Check</h3>
          <p>Verifying your setup...</p>
          <div id="wiz-preflight-checks" class="preflight-list"></div>
          <div class="wizard-actions">
            <button id="wiz-step4-back" class="btn btn-secondary">Back</button>
            <button id="wiz-recheck-btn" class="btn btn-secondary">Re-check</button>
            <button id="wiz-finish-btn" class="btn btn-success" disabled>Start Bot</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

/* ================================================================
   Settings form (shared between wizard step 3 and modal)
   ================================================================ */

function buildSettingsFormHtml(prefix) {
  return `
    <div class="settings-form" id="${prefix}-settings-form">
      <div class="form-row">
        <div class="form-group">
          <label for="${prefix}-bet-size" title="Base USD size of a single copied BUY. In proportional mode, scaled by multiplier.">Bet Size (USD) <span class="hint">\u24d8</span></label>
          <input type="number" id="${prefix}-bet-size" class="input-field" value="5" min="1" max="1000" step="1">
        </div>
        <div class="form-group">
          <label for="${prefix}-traders-count" title="How many top traders to copy. Bot auto-refreshes this list and manages tracker state.">Top Traders Count <span class="hint">\u24d8</span></label>
          <input type="number" id="${prefix}-traders-count" class="input-field" value="10" min="1" max="50">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="${prefix}-bet-sizing-mode" title="Fixed: always copy the exact Bet Size. Proportional: scale our bet with trader's USD using anchor + min/max caps.">Bet Sizing Mode <span class="hint">\u24d8</span></label>
          <select id="${prefix}-bet-sizing-mode" class="select-filter">
            <option value="fixed">Fixed (always Bet Size)</option>
            <option value="proportional" selected>Proportional to trader USD</option>
          </select>
        </div>
        <div class="form-group">
          <label for="${prefix}-bet-scale-anchor-usd" title="Trader bet size that maps to exactly 1× Bet Size. trader spends = anchor → our bet = Bet Size. Higher anchor = less aggressive scaling.">Scale Anchor (USD) <span class="hint">\u24d8</span></label>
          <input type="number" id="${prefix}-bet-scale-anchor-usd" class="input-field" value="100" min="1" step="10">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="${prefix}-bet-scale-min-mul" title="Floor for the multiplier. If trader's bet is tiny (trader_usd/anchor &lt; this), we still copy min × Bet Size. 1 = never below base.">Min Multiplier <span class="hint">\u24d8</span></label>
          <input type="number" id="${prefix}-bet-scale-min-mul" class="input-field" value="1" min="0.1" step="0.1">
        </div>
        <div class="form-group">
          <label for="${prefix}-bet-scale-max-mul" title="Cap on the multiplier. Protects from whales: trader bets $10k, anchor=$100 → raw 100×, clamped to this max. 5 = never above 5× base.">Max Multiplier <span class="hint">\u24d8</span></label>
          <input type="number" id="${prefix}-bet-scale-max-mul" class="input-field" value="5" min="1" step="0.5">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="${prefix}-period" title="Polymarket leaderboard window. Top traders are ranked by composite score over this period (PnL + winrate + volume).">Leaderboard Period <span class="hint">\u24d8</span></label>
          <select id="${prefix}-period" class="select-filter">
            <option value="DAY">1 Day</option>
            <option value="WEEK" selected>7 Days</option>
            <option value="MONTH">30 Days</option>
            <option value="ALL">All Time</option>
          </select>
        </div>
        <div class="form-group">
          <label for="${prefix}-poll-interval" title="How often tracker polls each tracked trader's activity on Polymarket. Lower = lower latency but more API load.">Poll Interval (seconds) <span class="hint">\u24d8</span></label>
          <input type="number" id="${prefix}-poll-interval" class="input-field" value="30" min="5" max="300">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="${prefix}-slippage" title="Max allowed price slippage between trader's price and current CLOB midpoint. If market moved too much, we skip the BUY.">Max Slippage (%) <span class="hint">\u24d8</span></label>
          <input type="number" id="${prefix}-slippage" class="input-field" value="5" min="0.1" max="50" step="0.1">
        </div>
        <div class="form-group">
          <label for="${prefix}-loss-limit" title="Realized loss today reaches this USD → bot stops copying new BUYs until tomorrow. Exit-only and redeems still execute.">Daily Loss Limit (USD) <span class="hint">\u24d8</span></label>
          <input type="number" id="${prefix}-loss-limit" class="input-field" value="50" min="1" max="10000">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="${prefix}-max-positions" title="Hard cap on concurrent open positions. Over this → BUY skipped. Prevents over-diversification.">Max Open Positions <span class="hint">\u24d8</span></label>
          <input type="number" id="${prefix}-max-positions" class="input-field" value="10" min="1" max="500">
        </div>
        <div class="form-group">
          <label for="${prefix}-min-liquidity" title="Skip markets whose total liquidity is under this USD. Avoids illiquid/thin orderbooks.">Min Market Liquidity (USD) <span class="hint">\u24d8</span></label>
          <input type="number" id="${prefix}-min-liquidity" class="input-field" value="1000" min="0" max="1000000" step="100">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="${prefix}-dry-run" class="checkbox-label" title="Demo mode: no real on-chain trades. Virtual balance + simulated fills. Turn OFF to trade real funds via connected wallet.">
            <input type="checkbox" id="${prefix}-dry-run" checked>
            Dry Run / Demo Mode <span class="hint">\u24d8</span>
          </label>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="${prefix}-demo-balance" title="Starting virtual balance when you reset the demo account. Does not affect current balance until you hit 'Reset Demo Account'.">Demo Initial Balance (USD) <span class="hint">\u24d8</span></label>
          <input type="number" id="${prefix}-demo-balance" class="input-field" value="1000" min="10" max="1000000" step="10">
        </div>
        <div class="form-group">
          <label for="${prefix}-demo-commission" title="Simulated fee in %: applied to every BUY and SELL in demo mode. Approximates Polymarket's taker fee.">Commission Rate (%) <span class="hint">\u24d8</span></label>
          <input type="number" id="${prefix}-demo-commission" class="input-field" value="2" min="0" max="10" step="0.1">
        </div>
      </div>
      <hr class="form-divider">
      <h4>Telegram Notifications (optional)</h4>
      <div class="form-row">
        <div class="form-group">
          <label for="${prefix}-tg-enabled" class="checkbox-label">
            <input type="checkbox" id="${prefix}-tg-enabled">
            Enable Telegram
          </label>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="${prefix}-tg-token">Bot Token</label>
          <input type="text" id="${prefix}-tg-token" class="input-field" placeholder="123456:ABC-DEF...">
        </div>
        <div class="form-group">
          <label for="${prefix}-tg-chat">Chat ID</label>
          <input type="text" id="${prefix}-tg-chat" class="input-field" placeholder="-100123456789">
        </div>
      </div>
    </div>
  `;
}

/* ================================================================
   Settings modal HTML
   ================================================================ */

function buildSettingsModalHtml() {
  return `
    <div class="modal-overlay" id="settings-modal-overlay">
      <div class="modal-content">
        <div class="modal-header">
          <h2>Bot Settings</h2>
          <button id="settings-close-btn" class="btn-close">&times;</button>
        </div>
        <div class="modal-body">
          <!-- Tabs -->
          <div class="settings-tabs">
            <button class="settings-tab active" data-tab="trading">Trading</button>
            <button class="settings-tab" data-tab="wallet">Wallet</button>
          </div>

          <!-- Trading tab -->
          <div class="settings-tab-content" id="tab-trading">
            ${buildSettingsFormHtml('mod')}
          </div>

          <!-- Wallet tab -->
          <div class="settings-tab-content hidden" id="tab-wallet">
            <div id="mod-wallet-status" class="wizard-info" style="margin-bottom:16px">
              <div><strong>Status:</strong> <span id="mod-wallet-status-text">Not connected</span></div>
              <div><strong>Address:</strong> <span id="mod-wallet-addr">--</span></div>
              <div><strong>USDC:</strong> <span id="mod-wallet-usdc">--</span></div>
              <div><strong>MATIC:</strong> <span id="mod-wallet-matic">--</span></div>
            </div>
            <div class="form-group" style="margin-bottom:16px">
              <label for="mod-private-key">Private Key</label>
              <input type="password" id="mod-private-key" class="input-field" placeholder="0x..." autocomplete="off">
            </div>
            <div id="mod-wallet-error" class="wizard-error hidden"></div>
            <div style="display:flex;gap:10px">
              <button id="mod-connect-wallet" class="btn btn-primary">Connect Wallet</button>
              <button id="mod-derive-keys" class="btn btn-secondary" disabled>Derive API Keys</button>
              <button id="mod-approve-usdc" class="btn btn-secondary" disabled>Approve USDC</button>
              <button id="mod-approve-ctf" class="btn btn-secondary" disabled>Approve CTF</button>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button id="settings-reset-demo" class="btn btn-danger btn-small">Reset Demo Account</button>
          <button id="settings-save-btn" class="btn btn-primary">Save Settings</button>
        </div>
      </div>
    </div>
  `;
}

/* ================================================================
   Read / write settings from form
   ================================================================ */

function readSettingsFromForm(prefix) {
  const getVal = (id) => {
    const el = document.getElementById(`${prefix}-${id}`);
    return el ? el.value : '';
  };
  const getChecked = (id) => {
    const el = document.getElementById(`${prefix}-${id}`);
    return el ? el.checked : false;
  };

  return {
    bet_size_usd: getVal('bet-size'),
    bet_sizing_mode: getVal('bet-sizing-mode'),
    bet_scale_anchor_usd: getVal('bet-scale-anchor-usd'),
    bet_scale_min_mul: getVal('bet-scale-min-mul'),
    bet_scale_max_mul: getVal('bet-scale-max-mul'),
    top_traders_count: getVal('traders-count'),
    leaderboard_period: getVal('period'),
    poll_interval_ms: String(parseInt(getVal('poll-interval') || '30', 10) * 1000),
    max_slippage_pct: getVal('slippage'),
    daily_loss_limit_usd: getVal('loss-limit'),
    max_open_positions: getVal('max-positions'),
    min_market_liquidity: getVal('min-liquidity'),
    dry_run: String(getChecked('dry-run')),
    demo_initial_balance: getVal('demo-balance'),
    demo_commission_pct: getVal('demo-commission'),
    telegram_enabled: String(getChecked('tg-enabled')),
    telegram_token: getVal('tg-token'),
    telegram_chat_id: getVal('tg-chat'),
  };
}

function populateSettingsForm(prefix, settings) {
  const setVal = (id, val) => {
    const el = document.getElementById(`${prefix}-${id}`);
    if (el && val !== undefined) el.value = val;
  };
  const setChecked = (id, val) => {
    const el = document.getElementById(`${prefix}-${id}`);
    if (el) el.checked = val === 'true' || val === true;
  };

  setVal('bet-size', settings.bet_size_usd);
  setVal('bet-sizing-mode', settings.bet_sizing_mode);
  setVal('bet-scale-anchor-usd', settings.bet_scale_anchor_usd);
  setVal('bet-scale-min-mul', settings.bet_scale_min_mul);
  setVal('bet-scale-max-mul', settings.bet_scale_max_mul);
  setVal('traders-count', settings.top_traders_count);
  setVal('period', settings.leaderboard_period);
  if (settings.poll_interval_ms) {
    setVal('poll-interval', String(Math.round(parseInt(settings.poll_interval_ms, 10) / 1000)));
  }
  setVal('slippage', settings.max_slippage_pct);
  setVal('loss-limit', settings.daily_loss_limit_usd);
  setVal('max-positions', settings.max_open_positions);
  setVal('min-liquidity', settings.min_market_liquidity);
  setChecked('dry-run', settings.dry_run);
  setVal('demo-balance', settings.demo_initial_balance);
  setVal('demo-commission', settings.demo_commission_pct);
  setChecked('tg-enabled', settings.telegram_enabled);
  setVal('tg-token', settings.telegram_token);
  setVal('tg-chat', settings.telegram_chat_id);
}

/* ================================================================
   API helpers
   ================================================================ */

async function postJson(url, body) {
  const res = await fetch(`${API}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function getJson(url) {
  const res = await fetch(`${API}${url}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ================================================================
   Wizard navigation
   ================================================================ */

function showWizardStep(step) {
  wizardStep = step;
  for (let i = 1; i <= 4; i++) {
    const panel = document.getElementById(`wizard-step-${i}`);
    const ind = document.getElementById(`step-ind-${i}`);
    if (panel) panel.classList.toggle('hidden', i !== step);
    if (ind) {
      ind.classList.toggle('active', i === step);
      ind.classList.toggle('completed', i < step);
    }
  }
}

/* ================================================================
   Wizard Step 1: Connect Wallet
   ================================================================ */

function wireStep1() {
  const connectBtn = document.getElementById('wiz-connect-btn');
  const nextBtn = document.getElementById('wiz-step1-next');

  if (connectBtn) {
    connectBtn.addEventListener('click', async () => {
      const keyInput = document.getElementById('wiz-private-key');
      const privateKey = keyInput ? keyInput.value.trim() : '';
      if (!privateKey) return;

      connectBtn.disabled = true;
      connectBtn.textContent = 'Connecting...';
      hideError('wiz-step1-error');

      try {
        walletData = await postJson('/api/auth/connect-wallet', { privateKey });

        // Clear the private key from the input immediately
        if (keyInput) keyInput.value = '';

        // Show wallet info
        const infoEl = document.getElementById('wiz-wallet-info');
        if (infoEl) infoEl.classList.remove('hidden');
        setText('wiz-address', truncateAddr(walletData.address));
        setText('wiz-usdc', `$${walletData.usdcBalance.toFixed(2)}`);
        setText('wiz-matic', walletData.maticBalance.toFixed(4));

        // Update header
        updateHeaderWallet(walletData);

        connectBtn.textContent = 'Connected';
        connectBtn.className = 'btn btn-success';
        if (nextBtn) {
          nextBtn.classList.remove('hidden');
          nextBtn.disabled = false;
        }
      } catch (err) {
        showError('wiz-step1-error', err.message);
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect Wallet';
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => showWizardStep(2));
  }
}

/* ================================================================
   Wizard Step 2: Activate Trading
   ================================================================ */

function wireStep2() {
  const deriveBtn = document.getElementById('wiz-derive-btn');
  const usdcBtn = document.getElementById('wiz-approve-usdc-btn');
  const ctfBtn = document.getElementById('wiz-approve-ctf-btn');
  const nextBtn = document.getElementById('wiz-step2-next');
  const backBtn = document.getElementById('wiz-step2-back');

  if (backBtn) {
    backBtn.addEventListener('click', () => showWizardStep(1));
  }

  if (deriveBtn) {
    deriveBtn.addEventListener('click', async () => {
      deriveBtn.disabled = true;
      deriveBtn.textContent = 'Deriving...';
      hideError('wiz-step2-error');

      try {
        await postJson('/api/auth/derive-keys', {});
        setText('wiz-derive-status', 'Done');
        deriveBtn.textContent = 'Done';
        deriveBtn.className = 'btn btn-success btn-small';
        if (usdcBtn) usdcBtn.disabled = false;
      } catch (err) {
        showError('wiz-step2-error', err.message);
        deriveBtn.disabled = false;
        deriveBtn.textContent = 'Derive Keys';
      }
    });
  }

  if (usdcBtn) {
    usdcBtn.addEventListener('click', async () => {
      usdcBtn.disabled = true;
      usdcBtn.textContent = 'Approving...';
      hideError('wiz-step2-error');

      try {
        await postJson('/api/auth/approve-usdc', {});
        setText('wiz-usdc-status', 'Done');
        usdcBtn.textContent = 'Done';
        usdcBtn.className = 'btn btn-success btn-small';
        if (ctfBtn) ctfBtn.disabled = false;
      } catch (err) {
        showError('wiz-step2-error', err.message);
        usdcBtn.disabled = false;
        usdcBtn.textContent = 'Approve USDC';
      }
    });
  }

  if (ctfBtn) {
    ctfBtn.addEventListener('click', async () => {
      ctfBtn.disabled = true;
      ctfBtn.textContent = 'Approving...';
      hideError('wiz-step2-error');

      try {
        await postJson('/api/auth/approve-ctf', {});
        setText('wiz-ctf-status', 'Done');
        ctfBtn.textContent = 'Done';
        ctfBtn.className = 'btn btn-success btn-small';
        if (nextBtn) nextBtn.disabled = false;
      } catch (err) {
        showError('wiz-step2-error', err.message);
        ctfBtn.disabled = false;
        ctfBtn.textContent = 'Approve CTF';
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => showWizardStep(3));
  }
}

/* ================================================================
   Wizard Step 3: Bot Settings
   ================================================================ */

function wireStep3() {
  const backBtn = document.getElementById('wiz-step3-back');
  const nextBtn = document.getElementById('wiz-step3-next');

  if (backBtn) {
    backBtn.addEventListener('click', () => showWizardStep(2));
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', async () => {
      // Save settings before proceeding
      try {
        const settings = readSettingsFromForm('wiz');
        await postJson('/api/auth/settings', settings);
        showWizardStep(4);
        runPreflightChecks();
      } catch (err) {
        if (window.__showToast) window.__showToast('error', `Failed to save settings: ${err.message}`);
      }
    });
  }
}

/* ================================================================
   Wizard Step 4: Preflight Check
   ================================================================ */

const PREFLIGHT_LABELS = {
  walletConnected: 'Wallet Connected',
  apiKeysDerived: 'API Keys Derived',
  usdcApproved: 'USDC Approved',
  ctfApproved: 'CTF Approved',
  clobApiReachable: 'CLOB API Reachable',
  dataApiReachable: 'Data API Reachable',
  sufficientUsdc: 'USDC Balance > $0',
  sufficientMatic: 'MATIC Balance > 0.01',
};

async function runPreflightChecks() {
  const container = document.getElementById('wiz-preflight-checks');
  const finishBtn = document.getElementById('wiz-finish-btn');
  if (!container) return;

  container.innerHTML = '<p>Checking...</p>';

  try {
    const data = await getJson('/api/auth/preflight');

    let html = '';
    for (const [key, label] of Object.entries(PREFLIGHT_LABELS)) {
      const ok = data[key] === true;
      const icon = ok ? '<span class="check-pass">PASS</span>' : '<span class="check-fail">FAIL</span>';
      html += `<div class="preflight-row">${icon} ${label}</div>`;
    }
    container.innerHTML = html;

    if (finishBtn) {
      finishBtn.disabled = !data.ready;
    }
  } catch (err) {
    container.innerHTML = `<p class="wizard-error">Failed to run checks: ${err.message}</p>`;
  }
}

function wireStep4() {
  const backBtn = document.getElementById('wiz-step4-back');
  const recheckBtn = document.getElementById('wiz-recheck-btn');
  const finishBtn = document.getElementById('wiz-finish-btn');

  if (backBtn) {
    backBtn.addEventListener('click', () => showWizardStep(3));
  }

  if (recheckBtn) {
    recheckBtn.addEventListener('click', () => runPreflightChecks());
  }

  if (finishBtn) {
    finishBtn.addEventListener('click', () => {
      // Hide wizard, show dashboard
      const wizard = document.getElementById('setup-wizard');
      const dashboard = document.getElementById('dashboard');
      if (wizard) wizard.classList.add('hidden');
      if (dashboard) dashboard.classList.remove('hidden');

      if (window.__showToast) window.__showToast('success', 'Setup complete! Bot is ready.');
    });
  }
}

/* ================================================================
   Settings Modal
   ================================================================ */

function wireSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;

  // Replace modal content
  modal.innerHTML = buildSettingsModalHtml();

  const closeBtn = document.getElementById('settings-close-btn');
  const overlay = document.getElementById('settings-modal-overlay');
  const saveBtn = document.getElementById('settings-save-btn');
  const settingsBtn = document.getElementById('btn-settings');

  if (settingsBtn) {
    settingsBtn.addEventListener('click', async () => {
      modal.classList.remove('hidden');
      // Load current settings
      try {
        const settings = await getJson('/api/auth/settings');
        populateSettingsForm('mod', settings);
      } catch {
        /* ignore, use defaults */
      }
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  }

  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) modal.classList.add('hidden');
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      try {
        const settings = readSettingsFromForm('mod');
        await postJson('/api/auth/settings', settings);
        modal.classList.add('hidden');
        if (window.__showToast) window.__showToast('success', 'Settings saved');
        // Re-sync traders counter target in case top_traders_count changed
        if (typeof window.__refreshTradersTarget === 'function') {
          window.__refreshTradersTarget();
        }
      } catch (err) {
        if (window.__showToast) window.__showToast('error', `Failed: ${err.message}`);
      }
    });
  }

  const resetDemoBtn = document.getElementById('settings-reset-demo');
  if (resetDemoBtn) {
    resetDemoBtn.addEventListener('click', async () => {
      if (!confirm('Reset demo account? All simulated trades and positions will be deleted.')) return;
      try {
        const balanceInput = document.getElementById('mod-demo-balance');
        const balance = balanceInput ? parseFloat(balanceInput.value) : 1000;
        await postJson('/api/demo/reset', { initialBalance: balance });
        modal.classList.add('hidden');
        if (window.__showToast) window.__showToast('success', `Demo account reset to $${balance}`);
      } catch (err) {
        if (window.__showToast) window.__showToast('error', `Failed: ${err.message}`);
      }
    });
  }

  // Tab switching
  const tabs = modal.querySelectorAll('.settings-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      modal.querySelectorAll('.settings-tab-content').forEach((c) => c.classList.add('hidden'));
      const target = document.getElementById(`tab-${tab.dataset.tab}`);
      if (target) target.classList.remove('hidden');
    });
  });

  // Wallet tab — load current status on open
  if (settingsBtn) {
    settingsBtn.addEventListener('click', async () => {
      try {
        const bal = await getJson('/api/auth/balance');
        const addrText = document.getElementById('mod-wallet-addr');
        const usdcText = document.getElementById('mod-wallet-usdc');
        const maticText = document.getElementById('mod-wallet-matic');
        const statusText = document.getElementById('mod-wallet-status-text');
        if (bal.isDemo) {
          if (statusText) statusText.textContent = 'Demo mode (no wallet needed)';
          if (usdcText) usdcText.textContent = `$${bal.usdc.toFixed(2)} (virtual)`;
        } else if (bal.usdc > 0 || bal.matic > 0) {
          if (statusText) statusText.textContent = 'Connected';
        }
        if (maticText && bal.matic != null) maticText.textContent = bal.matic.toFixed(4);
      } catch { /* ignore */ }
    });
  }

  // Connect wallet button
  const connectBtn = document.getElementById('mod-connect-wallet');
  if (connectBtn) {
    connectBtn.addEventListener('click', async () => {
      const keyInput = document.getElementById('mod-private-key');
      const pk = keyInput ? keyInput.value.trim() : '';
      if (!pk) return;

      connectBtn.disabled = true;
      connectBtn.textContent = 'Connecting...';
      const errEl = document.getElementById('mod-wallet-error');
      if (errEl) errEl.classList.add('hidden');

      try {
        const data = await postJson('/api/auth/connect-wallet', { privateKey: pk });
        if (keyInput) keyInput.value = '';
        const addrText = document.getElementById('mod-wallet-addr');
        const usdcText = document.getElementById('mod-wallet-usdc');
        const maticText = document.getElementById('mod-wallet-matic');
        const statusText = document.getElementById('mod-wallet-status-text');
        if (addrText) addrText.textContent = truncateAddr(data.address);
        if (usdcText) usdcText.textContent = `$${data.usdcBalance.toFixed(2)}`;
        if (maticText) maticText.textContent = data.maticBalance.toFixed(4);
        if (statusText) statusText.textContent = 'Connected';
        connectBtn.textContent = 'Connected';
        connectBtn.className = 'btn btn-success';
        updateHeaderWallet(data);
        // Enable next steps
        const deriveBtn = document.getElementById('mod-derive-keys');
        if (deriveBtn) deriveBtn.disabled = false;
      } catch (err) {
        if (errEl) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect Wallet';
      }
    });
  }

  // Derive keys button
  const deriveBtn = document.getElementById('mod-derive-keys');
  if (deriveBtn) {
    deriveBtn.addEventListener('click', async () => {
      deriveBtn.disabled = true;
      deriveBtn.textContent = 'Deriving...';
      try {
        await postJson('/api/auth/derive-keys', {});
        deriveBtn.textContent = 'Done';
        deriveBtn.className = 'btn btn-success';
        const approveBtn = document.getElementById('mod-approve-usdc');
        if (approveBtn) approveBtn.disabled = false;
      } catch (err) {
        if (window.__showToast) window.__showToast('error', err.message);
        deriveBtn.disabled = false;
        deriveBtn.textContent = 'Derive API Keys';
      }
    });
  }

  // Approve USDC button
  const approveUsdcBtn = document.getElementById('mod-approve-usdc');
  if (approveUsdcBtn) {
    approveUsdcBtn.addEventListener('click', async () => {
      approveUsdcBtn.disabled = true;
      approveUsdcBtn.textContent = 'Approving...';
      try {
        await postJson('/api/auth/approve-usdc', {});
        approveUsdcBtn.textContent = 'Done';
        approveUsdcBtn.className = 'btn btn-success';
        const ctfBtn = document.getElementById('mod-approve-ctf');
        if (ctfBtn) ctfBtn.disabled = false;
      } catch (err) {
        if (window.__showToast) window.__showToast('error', err.message);
        approveUsdcBtn.disabled = false;
        approveUsdcBtn.textContent = 'Approve USDC';
      }
    });
  }

  // Approve CTF button
  const approveCtfBtn = document.getElementById('mod-approve-ctf');
  if (approveCtfBtn) {
    approveCtfBtn.addEventListener('click', async () => {
      approveCtfBtn.disabled = true;
      approveCtfBtn.textContent = 'Approving...';
      try {
        await postJson('/api/auth/approve-ctf', {});
        approveCtfBtn.textContent = 'Done';
        approveCtfBtn.className = 'btn btn-success';
        if (window.__showToast) window.__showToast('success', 'Wallet fully activated!');
      } catch (err) {
        if (window.__showToast) window.__showToast('error', err.message);
        approveCtfBtn.disabled = false;
        approveCtfBtn.textContent = 'Approve CTF';
      }
    });
  }
}

/* ================================================================
   Header wallet/balance update
   ================================================================ */

function updateHeaderWallet(data) {
  const addrEl = document.getElementById('wallet-address');
  const usdcEl = document.getElementById('usdc-balance');
  const maticEl = document.getElementById('matic-balance');

  if (addrEl && data.address) addrEl.textContent = truncateAddr(data.address);
  if (usdcEl && data.usdcBalance != null) usdcEl.textContent = `USDC: $${data.usdcBalance.toFixed(2)}`;
  if (usdcEl && data.usdc != null) usdcEl.textContent = `USDC: $${data.usdc.toFixed(2)}`;
  if (maticEl && data.maticBalance != null) maticEl.textContent = `MATIC: ${data.maticBalance.toFixed(4)}`;
  if (maticEl && data.matic != null) maticEl.textContent = `MATIC: ${data.matic.toFixed(4)}`;
}

/* ================================================================
   Helpers
   ================================================================ */

function wireSkipButton() {
  const skipBtn = document.getElementById('wiz-skip-btn');
  if (skipBtn) {
    skipBtn.addEventListener('click', () => {
      const wizard = document.getElementById('setup-wizard');
      const dashboard = document.getElementById('dashboard');
      if (wizard) wizard.classList.add('hidden');
      if (dashboard) dashboard.classList.remove('hidden');
    });
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function showError(id, message) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = message;
    el.classList.remove('hidden');
  }
}

function hideError(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

function truncateAddr(addr) {
  if (!addr || addr.length < 10) return addr || '';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

/* ================================================================
   Exports
   ================================================================ */

export function initSettings() {
  wireSettingsModal();

  // Load header balances
  getJson('/api/auth/balance')
    .then((data) => updateHeaderWallet(data))
    .catch(() => { /* not connected yet */ });
}

export async function checkFirstRun() {
  try {
    const data = await getJson('/api/auth/preflight');

    if (!data.ready) {
      // Show wizard
      const wizard = document.getElementById('setup-wizard');
      const dashboard = document.getElementById('dashboard');

      if (wizard) {
        wizard.innerHTML = buildWizardHtml();
        wizard.classList.remove('hidden');
      }
      if (dashboard) {
        dashboard.classList.add('hidden');
      }

      // Wire up all steps
      wireStep1();
      wireStep2();
      wireStep3();
      wireStep4();
      wireSkipButton();
      showWizardStep(1);
    }
  } catch {
    // If preflight fails, continue showing dashboard
    console.error('Preflight check failed, showing dashboard');
  }
}
