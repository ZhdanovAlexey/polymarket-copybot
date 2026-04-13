import { Router, type Router as RouterType } from 'express';
import { createLogger } from '../../utils/logger.js';
import { config, reloadConfigFromDb } from '../../config.js';
import * as queries from '../../db/queries.js';
import type { Bot } from '../../core/bot.js';

const log = createLogger('auth');
export const authRouter: RouterType = Router();

// Bot instance reference — set from index.ts via setBot().
let bot: Bot | null = null;

export function setBot(b: Bot): void {
  bot = b;
}

// POST /api/auth/connect-wallet
// Body: { privateKey: string }
// Returns: { address, usdcBalance, maticBalance }
// SECURITY: Save private key to .env file on server, NEVER return it
authRouter.post('/connect-wallet', async (req, res) => {
  try {
    const { privateKey } = req.body as { privateKey?: string };
    if (!privateKey) {
      res.status(400).json({ error: 'Private key required' });
      return;
    }

    // Use ethers to create wallet and get address
    const { ethers } = await import('ethers');
    const wallet = new ethers.Wallet(privateKey);
    const address = wallet.address;

    // Get balances from Polygon RPC
    const provider = new ethers.providers.JsonRpcProvider(config.polygonRpcUrl);
    const maticBalance = parseFloat(ethers.utils.formatEther(await provider.getBalance(address)));

    // USDC.e balance
    const usdcAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const erc20Abi = ['function balanceOf(address) view returns (uint256)'];
    const usdc = new ethers.Contract(usdcAddress, erc20Abi, provider);
    const usdcRaw = await usdc.balanceOf(address);
    const usdcBalance = parseFloat(ethers.utils.formatUnits(usdcRaw, 6));

    // Save private key to .env (server-side only!)
    await saveToEnv('PRIVATE_KEY', privateKey);
    await saveToEnv('FUNDER_ADDRESS', address);

    // Save to settings DB
    queries.setSetting('wallet_address', address);
    queries.setSetting('wallet_connected', 'true');

    log.info({ address }, 'Wallet connected');

    res.json({ address, usdcBalance, maticBalance });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error({ err }, 'Connect wallet failed');
    res.status(500).json({ error: message });
  }
});

// POST /api/auth/derive-keys
// Derives CLOB API keys from wallet signature
authRouter.post('/derive-keys', async (req, res) => {
  try {
    const { initClobClientWithAuth } = await import('../../api/clob-client.js');
    const credentials = await initClobClientWithAuth();

    if (credentials) {
      queries.setSetting('api_keys_derived', 'true');
      log.info('API keys derived successfully');
      res.json({ success: true, message: 'API keys derived' });
    } else {
      res.status(500).json({ error: 'Failed to derive keys' });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error({ err }, 'Derive keys failed');
    res.status(500).json({ error: message });
  }
});

// POST /api/auth/approve-usdc
// Approve CTF Exchange to spend our USDC
authRouter.post('/approve-usdc', async (req, res) => {
  try {
    const { ethers } = await import('ethers');
    const privateKey = await getEnvValue('PRIVATE_KEY');
    if (!privateKey) {
      res.status(400).json({ error: 'Wallet not connected' });
      return;
    }

    const provider = new ethers.providers.JsonRpcProvider(config.polygonRpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);

    const usdcAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const ctfExchange = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
    const negRiskExchange = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
    const erc20Abi = ['function approve(address spender, uint256 amount) returns (bool)'];
    const usdcContract = new ethers.Contract(usdcAddress, erc20Abi, wallet);

    const maxApproval = ethers.constants.MaxUint256;

    // Approve both exchanges
    const tx1 = await usdcContract.approve(ctfExchange, maxApproval);
    await tx1.wait();

    const tx2 = await usdcContract.approve(negRiskExchange, maxApproval);
    await tx2.wait();

    queries.setSetting('usdc_approved', 'true');
    log.info({ txHash1: tx1.hash as string, txHash2: tx2.hash as string }, 'USDC approved');

    res.json({ success: true, txHash: tx1.hash });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error({ err }, 'Approve USDC failed');
    res.status(500).json({ error: message });
  }
});

// POST /api/auth/approve-ctf
// Approve CTF tokens (setApprovalForAll)
authRouter.post('/approve-ctf', async (req, res) => {
  try {
    const { ethers } = await import('ethers');
    const privateKey = await getEnvValue('PRIVATE_KEY');
    if (!privateKey) {
      res.status(400).json({ error: 'Wallet not connected' });
      return;
    }

    const provider = new ethers.providers.JsonRpcProvider(config.polygonRpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);

    const ctfAddress = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
    const ctfExchange = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
    const negRiskExchange = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
    const negRiskAdapter = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

    const ctfAbi = ['function setApprovalForAll(address operator, bool approved)'];
    const ctf = new ethers.Contract(ctfAddress, ctfAbi, wallet);

    const tx1 = await ctf.setApprovalForAll(ctfExchange, true);
    await tx1.wait();
    const tx2 = await ctf.setApprovalForAll(negRiskExchange, true);
    await tx2.wait();
    const tx3 = await ctf.setApprovalForAll(negRiskAdapter, true);
    await tx3.wait();

    queries.setSetting('ctf_approved', 'true');
    log.info('CTF tokens approved');

    res.json({ success: true, txHash: tx1.hash });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error({ err }, 'Approve CTF failed');
    res.status(500).json({ error: message });
  }
});

// GET /api/auth/preflight
// Check everything is set up correctly. In demo mode, skip wallet checks.
authRouter.get('/preflight', async (_req, res) => {
  // In demo/dry-run mode, wallet setup is not needed
  if (config.dryRun) {
    res.json({
      walletConnected: true,
      apiKeysDerived: true,
      usdcApproved: true,
      ctfApproved: true,
      clobApiReachable: true,
      dataApiReachable: true,
      sufficientUsdc: true,
      sufficientMatic: true,
      ready: true,
      demoMode: true,
    });
    return;
  }

  const checks = {
    walletConnected: queries.getSetting('wallet_connected') === 'true',
    apiKeysDerived: queries.getSetting('api_keys_derived') === 'true',
    usdcApproved: queries.getSetting('usdc_approved') === 'true',
    ctfApproved: queries.getSetting('ctf_approved') === 'true',
    clobApiReachable: false,
    dataApiReachable: false,
    sufficientUsdc: false,
    sufficientMatic: false,
  };

  try {
    const clobRes = await fetch(`${config.clobHost}/time`);
    checks.clobApiReachable = clobRes.ok;
  } catch { /* ignore */ }

  try {
    const dataRes = await fetch(`${config.dataApiHost}/v1/leaderboard?limit=1`);
    checks.dataApiReachable = dataRes.ok;
  } catch { /* ignore */ }

  try {
    const { ethers } = await import('ethers');
    const addr = queries.getSetting('wallet_address');
    if (addr) {
      const provider = new ethers.providers.JsonRpcProvider(config.polygonRpcUrl);
      const matic = parseFloat(ethers.utils.formatEther(await provider.getBalance(addr)));
      checks.sufficientMatic = matic > 0.01;

      const usdcAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
      const erc20Abi = ['function balanceOf(address) view returns (uint256)'];
      const usdcContract = new ethers.Contract(usdcAddress, erc20Abi, provider);
      const usdcBal = parseFloat(ethers.utils.formatUnits(await usdcContract.balanceOf(addr), 6));
      checks.sufficientUsdc = usdcBal > 0;
    }
  } catch { /* ignore */ }

  const allGood = Object.values(checks).every((v) => v === true);
  res.json({ ...checks, ready: allGood });
});

// GET /api/auth/balance
authRouter.get('/balance', async (_req, res) => {
  try {
    if (config.dryRun) {
      res.json({ usdc: queries.getDemoBalance(), matic: 0, isDemo: true });
      return;
    }

    const { ethers } = await import('ethers');
    const addr = queries.getSetting('wallet_address');
    if (!addr) {
      res.json({ usdc: 0, matic: 0 });
      return;
    }

    const provider = new ethers.providers.JsonRpcProvider(config.polygonRpcUrl);
    const matic = parseFloat(ethers.utils.formatEther(await provider.getBalance(addr)));

    const usdcAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const erc20Abi = ['function balanceOf(address) view returns (uint256)'];
    const usdcContract = new ethers.Contract(usdcAddress, erc20Abi, provider);
    const usdcBal = parseFloat(ethers.utils.formatUnits(await usdcContract.balanceOf(addr), 6));

    res.json({ usdc: usdcBal, matic });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// POST /api/settings
// Save bot settings to DB
authRouter.post('/settings', async (req, res) => {
  try {
    const settings = req.body as Record<string, string>;
    const savedKeys: string[] = [];
    for (const [key, value] of Object.entries(settings)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        queries.setSetting(key, String(value));
        savedKeys.push(key);
      }
    }
    reloadConfigFromDb(queries.getSetting);

    // If user changed knobs that shape leaderboard selection, refresh now
    // (instead of waiting for the next hourly tick).
    const leaderboardKeys = ['top_traders_count', 'leaderboard_period', 'min_trader_volume'];
    const changedLeaderboardKey = savedKeys.some((k) => leaderboardKeys.includes(k));
    if (changedLeaderboardKey && bot?.getStatus().running) {
      bot
        .refreshLeaderboardNow()
        .catch((e) => log.error({ err: e }, 'Auto-refresh after settings save failed'));
    }

    log.info({ saved: savedKeys, autoRefresh: changedLeaderboardKey }, 'Settings saved and applied to runtime');
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error({ err }, 'Save settings failed');
    res.status(500).json({ error: message });
  }
});

// GET /api/settings
// Get all bot settings from DB
authRouter.get('/settings', (_req, res) => {
  try {
    const keys = [
      'bet_size_usd',
      'bet_sizing_mode',
      'bet_scale_anchor_usd',
      'bet_scale_max_mul',
      'bet_scale_min_mul',
      'top_traders_count',
      'leaderboard_period',
      'poll_interval_ms',
      'max_slippage_pct',
      'daily_loss_limit_usd',
      'max_open_positions',
      'min_market_liquidity',
      'sell_mode',
      'dry_run',
      'telegram_enabled',
      'telegram_token',
      'telegram_chat_id',
      'demo_initial_balance',
      'demo_commission_pct',
    ];
    const result: Record<string, string> = {};
    for (const key of keys) {
      const val = queries.getSetting(key);
      if (val !== undefined) result[key] = val;
    }
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// Helper: save value to .env file
async function saveToEnv(key: string, value: string): Promise<void> {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const envPath = resolve(projectRoot, '.env');

  let content = '';
  if (existsSync(envPath)) {
    content = readFileSync(envPath, 'utf-8');
  }

  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}`;
  }

  writeFileSync(envPath, content);
}

// Helper: get value from .env file
async function getEnvValue(key: string): Promise<string | undefined> {
  const { readFileSync, existsSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const envPath = resolve(projectRoot, '.env');

  if (!existsSync(envPath)) return undefined;

  const content = readFileSync(envPath, 'utf-8');
  const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match?.[1] || undefined;
}
