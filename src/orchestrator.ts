import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createLogger } from './utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const CONFIGS_DIR = resolve(PROJECT_ROOT, 'configs');
const DATA_ROOT = resolve(PROJECT_ROOT, 'data');

const log = createLogger('orchestrator');

interface BotConfig {
  name: string;
  port: number;
  settings: Record<string, string>;
}

interface BotInstance {
  config: BotConfig;
  process: ChildProcess | null;
  status: 'stopped' | 'running' | 'crashed';
  restartCount: number;
  lastMetrics: Record<string, unknown> | null;
  lastMetricsAt: number;
}

const bots = new Map<string, BotInstance>();
const MAX_RESTARTS = 3;

// --- Process Management ---

function loadConfigs(): BotConfig[] {
  if (!existsSync(CONFIGS_DIR)) {
    log.error({ dir: CONFIGS_DIR }, 'Configs directory not found');
    return [];
  }
  const files = readdirSync(CONFIGS_DIR).filter((f) => f.endsWith('.json'));
  return files.map((f) => {
    const raw = readFileSync(resolve(CONFIGS_DIR, f), 'utf-8');
    return JSON.parse(raw) as BotConfig;
  });
}

function spawnBot(instance: BotInstance): void {
  const { config } = instance;
  const dataDir = resolve(DATA_ROOT, config.name);
  mkdirSync(dataDir, { recursive: true });

  const configPath = resolve(CONFIGS_DIR, `${config.name}.json`);

  const child = fork(resolve(PROJECT_ROOT, 'src/index.ts'), [], {
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env,
      BOT_NAME: config.name,
      BOT_DATA_DIR: dataDir,
      DASHBOARD_PORT: String(config.port),
      BOT_CONFIG: configPath,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  child.stdout?.on('data', (data: Buffer) => {
    process.stdout.write(`[${config.name}] ${data.toString()}`);
  });
  child.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(`[${config.name}:err] ${data.toString()}`);
  });

  child.on('exit', (code) => {
    log.warn({ bot: config.name, code }, 'Bot process exited');
    instance.process = null;
    if (instance.status === 'running') {
      instance.status = 'crashed';
      if (instance.restartCount < MAX_RESTARTS) {
        instance.restartCount++;
        log.info({ bot: config.name, attempt: instance.restartCount }, 'Restarting bot');
        setTimeout(() => spawnBot(instance), 5000);
      } else {
        log.error({ bot: config.name }, 'Max restarts reached, giving up');
      }
    }
  });

  instance.process = child;
  instance.status = 'running';
  log.info({ bot: config.name, port: config.port, pid: child.pid }, 'Bot spawned');
}

function stopBot(instance: BotInstance): void {
  if (instance.process) {
    instance.status = 'stopped';
    instance.process.kill('SIGTERM');
    instance.process = null;
  }
}

// --- Metrics Collection ---

async function fetchBotMetrics(instance: BotInstance): Promise<void> {
  if (instance.status !== 'running') return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`http://localhost:${instance.config.port}/api/metrics`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      instance.lastMetrics = (await res.json()) as Record<string, unknown>;
      instance.lastMetricsAt = Date.now();
    }
  } catch {
    // Bot unreachable — keep stale metrics
  }
}

async function fetchAllMetrics(): Promise<void> {
  await Promise.allSettled([...bots.values()].map(fetchBotMetrics));
}

// --- HTTP API (Orchestrator) ---

function createOrchestratorServer(): express.Express {
  const app = express();
  app.use(express.json());

  app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    next();
  });

  // List all bots
  app.get('/api/bots', (_req: express.Request, res: express.Response) => {
    const list = [...bots.entries()].map(([name, inst]) => ({
      name,
      port: inst.config.port,
      status: inst.status,
      pid: inst.process?.pid ?? null,
      restartCount: inst.restartCount,
      metrics: inst.lastMetrics,
      metricsAge: inst.lastMetricsAt ? Date.now() - inst.lastMetricsAt : null,
    }));
    res.json(list);
  });

  // Comparison: all metrics in one response
  app.get('/api/comparison', async (_req: express.Request, res: express.Response) => {
    await fetchAllMetrics();
    const comparison = [...bots.entries()].map(([name, inst]) => ({
      name,
      port: inst.config.port,
      status: inst.status,
      ...(inst.lastMetrics ?? {}),
    }));
    res.json(comparison);
  });

  // Bot process control
  app.post('/api/bots/:name/start', (req: express.Request, res: express.Response) => {
    const name = String(req.params.name);
    const inst = bots.get(name);
    if (!inst) return void res.status(404).json({ error: 'Bot not found' });
    if (inst.status === 'running') return void res.json({ ok: true, message: 'Already running' });
    inst.restartCount = 0;
    spawnBot(inst);
    res.json({ ok: true, message: `Bot ${name} started` });
  });

  app.post('/api/bots/:name/stop', (req: express.Request, res: express.Response) => {
    const name = String(req.params.name);
    const inst = bots.get(name);
    if (!inst) return void res.status(404).json({ error: 'Bot not found' });
    stopBot(inst);
    res.json({ ok: true, message: `Bot ${name} stopped` });
  });

  app.post('/api/bots/:name/restart', (req: express.Request, res: express.Response) => {
    const name = String(req.params.name);
    const inst = bots.get(name);
    if (!inst) return void res.status(404).json({ error: 'Bot not found' });
    stopBot(inst);
    inst.restartCount = 0;
    setTimeout(() => spawnBot(inst), 1000);
    res.json({ ok: true, message: `Bot ${name} restarting` });
  });

  // Proxy to bot APIs (settings, bot control, pnl-history)
  app.all('/api/bots/:name/proxy/{*path}', async (req: express.Request, res: express.Response) => {
    const inst = bots.get(String(req.params.name));
    if (!inst) return void res.status(404).json({ error: 'Bot not found' });
    if (inst.status !== 'running') return void res.status(503).json({ error: 'Bot not running' });

    const targetPath = (req.params as Record<string, string>).path ?? '';
    const url = `http://localhost:${inst.config.port}/api/${targetPath}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const fetchOpts: RequestInit = {
        method: req.method,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        fetchOpts.body = JSON.stringify(req.body);
      }
      const proxyRes = await fetch(url, fetchOpts);
      clearTimeout(timeout);
      const data = await proxyRes.json();
      res.status(proxyRes.status).json(data);
    } catch (err) {
      res.status(502).json({ error: 'Bot unreachable', detail: String(err) });
    }
  });

  // Static files for orchestrator dashboard
  const publicDir = resolve(__dirname, 'orchestrator/public');
  app.use(express.static(publicDir));
  app.get('/{*path}', (_req: express.Request, res: express.Response) => {
    res.sendFile(resolve(publicDir, 'index.html'));
  });

  return app;
}

// --- Main ---

async function main(): Promise<void> {
  log.info('=== PolyMarket CopyBot Orchestrator ===');

  const configs = loadConfigs();
  if (configs.length === 0) {
    log.error('No bot configs found in configs/');
    process.exit(1);
  }

  log.info({ count: configs.length, bots: configs.map((c) => c.name) }, 'Loaded bot configs');

  // Initialize bot instances
  for (const cfg of configs) {
    bots.set(cfg.name, {
      config: cfg,
      process: null,
      status: 'stopped',
      restartCount: 0,
      lastMetrics: null,
      lastMetricsAt: 0,
    });
  }

  // Spawn all bots
  for (const inst of bots.values()) {
    spawnBot(inst);
    // Stagger spawns by 2 seconds to avoid API rate limits
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Start metrics polling
  setInterval(() => {
    fetchAllMetrics().catch(() => {});
  }, 30_000);

  // Start orchestrator dashboard
  const app = createOrchestratorServer();
  const port = parseInt(process.env.ORCHESTRATOR_PORT ?? '3000');
  app.listen(port, () => {
    log.info({ port, bots: configs.length }, 'Orchestrator dashboard running');
  });
}

process.on('SIGTERM', () => {
  for (const inst of bots.values()) stopBot(inst);
  process.exit(0);
});
process.on('SIGINT', () => {
  for (const inst of bots.values()) stopBot(inst);
  process.exit(0);
});

main().catch((err) => {
  log.error({ err }, 'Orchestrator startup failed');
  process.exit(1);
});
