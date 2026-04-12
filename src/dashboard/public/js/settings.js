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
        <h2 class="wizard-title">Setup Wizard</h2>
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
          <label for="${prefix}-bet-size">Bet Size (USD)</label>
          <input type="number" id="${prefix}-bet-size" class="input-field" value="5" min="1" max="1000" step="1">
        </div>
        <div class="form-group">
          <label for="${prefix}-traders-count">Top Traders Count</label>
          <input type="number" id="${prefix}-traders-count" class="input-field" value="10" min="1" max="50">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="${prefix}-period">Leaderboard Period</label>
          <select id="${prefix}-period" class="select-filter">
            <option value="1d">1 Day</option>
            <option value="7d" selected>7 Days</option>
            <option value="30d">30 Days</option>
          </select>
        </div>
        <div class="form-group">
          <label for="${prefix}-poll-interval">Poll Interval (seconds)</label>
          <input type="number" id="${prefix}-poll-interval" class="input-field" value="30" min="5" max="300">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="${prefix}-slippage">Max Slippage (%)</label>
          <input type="number" id="${prefix}-slippage" class="input-field" value="5" min="0.1" max="50" step="0.1">
        </div>
        <div class="form-group">
          <label for="${prefix}-loss-limit">Daily Loss Limit (USD)</label>
          <input type="number" id="${prefix}-loss-limit" class="input-field" value="50" min="1" max="10000">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="${prefix}-dry-run" class="checkbox-label">
            <input type="checkbox" id="${prefix}-dry-run" checked>
            Dry Run (simulate trades)
          </label>
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
          ${buildSettingsFormHtml('mod')}
        </div>
        <div class="modal-footer">
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
    top_traders_count: getVal('traders-count'),
    leaderboard_period: getVal('period'),
    poll_interval_ms: String(parseInt(getVal('poll-interval') || '30', 10) * 1000),
    max_slippage_pct: getVal('slippage'),
    daily_loss_limit_usd: getVal('loss-limit'),
    dry_run: String(getChecked('dry-run')),
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
  setVal('traders-count', settings.top_traders_count);
  setVal('period', settings.leaderboard_period);
  if (settings.poll_interval_ms) {
    setVal('poll-interval', String(Math.round(parseInt(settings.poll_interval_ms, 10) / 1000)));
  }
  setVal('slippage', settings.max_slippage_pct);
  setVal('loss-limit', settings.daily_loss_limit_usd);
  setChecked('dry-run', settings.dry_run);
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
      } catch (err) {
        if (window.__showToast) window.__showToast('error', `Failed: ${err.message}`);
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
      showWizardStep(1);
    }
  } catch {
    // If preflight fails, continue showing dashboard
    console.error('Preflight check failed, showing dashboard');
  }
}
