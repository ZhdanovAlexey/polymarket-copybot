import { Router, type Router as RouterType } from 'express';
import { createLogger } from '../../utils/logger.js';
import { config } from '../../config.js';
import * as queries from '../../db/queries.js';
import type { ApiStatusResponse, ApiMetricsResponse } from '../../types.js';
import type { Bot } from '../../core/bot.js';

const log = createLogger('api');
export const apiRouter: RouterType = Router();

// Bot instance reference — set from index.ts via setBot()
let bot: Bot | null = null;

export function setBot(b: Bot): void {
  bot = b;
}

// Track bot state (will be wired to Bot class in stage 10)
let botStartTime: number | null = null;
let botRunning = false;

export function setBotState(running: boolean): void {
  botRunning = running;
  if (running) botStartTime = Date.now();
  else botStartTime = null;
}

// GET /api/status
apiRouter.get('/status', (_req, res) => {
  try {
    const response: ApiStatusResponse = {
      running: botRunning,
      status: botRunning ? 'running' : 'idle',
      uptime: botStartTime ? Math.floor((Date.now() - botStartTime) / 1000) : 0,
      version: '2.0.0',
      tradersCount: queries.getActiveTraders().length,
      dryRun: true, // Will read from config when bot is wired
    };
    res.json(response);
  } catch (err) {
    log.error({ err }, 'Failed to get status');
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/traders
apiRouter.get('/traders', (_req, res) => {
  try {
    const traders = queries.getActiveTraders();
    res.json(traders);
  } catch (err) {
    log.error({ err }, 'Failed to get traders');
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/trades?limit=50&offset=0&status=all
apiRouter.get('/trades', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as string;

    const trades = queries.getTrades({
      limit,
      offset,
      status: status && status !== 'all' ? status : undefined,
    });
    res.json(trades);
  } catch (err) {
    log.error({ err }, 'Failed to get trades');
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/metrics
apiRouter.get('/metrics', (_req, res) => {
  try {
    const allTrades = queries.getTrades({ limit: 10000 });
    const todayTrades = queries.getTodayTrades();
    const positions = queries.getAllOpenPositions();

    const wins = allTrades.filter(
      (t) => t.status === 'filled' && t.side === 'SELL' && t.price > 0,
    ).length;
    const totalCompleted = allTrades.filter((t) => t.status === 'filled').length;

    // Calculate realized P&L from sell trades
    const realizedPnl = allTrades
      .filter((t) => t.side === 'SELL' && t.status === 'filled')
      .reduce((sum, t) => sum + (t.totalUsd - t.originalTraderPrice * t.size), 0);

    // Calculate unrealized P&L (simplified)
    const unrealizedPnl = 0; // Will be calculated with real prices later

    const todayPnl = todayTrades
      .filter((t) => t.side === 'SELL' && t.status === 'filled')
      .reduce((sum, t) => sum + (t.totalUsd - t.originalTraderPrice * t.size), 0);

    const response: ApiMetricsResponse = {
      totalPnl: realizedPnl + unrealizedPnl,
      realizedPnl,
      unrealizedPnl,
      winRate: totalCompleted > 0 ? wins / totalCompleted : 0,
      totalTrades: allTrades.length,
      failedTrades: allTrades.filter((t) => t.status === 'failed').length,
      todayPnl,
      todayTrades: todayTrades.length,
      openPositions: positions.length,
    };
    res.json(response);
  } catch (err) {
    log.error({ err }, 'Failed to get metrics');
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/positions
apiRouter.get('/positions', (_req, res) => {
  try {
    const positions = queries.getAllOpenPositions();
    res.json(positions);
  } catch (err) {
    log.error({ err }, 'Failed to get positions');
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/pnl-history?period=24h
apiRouter.get('/pnl-history', (req, res) => {
  try {
    const period = (req.query.period as string) || '24h';
    const snapshots = queries.getSnapshots({ period });
    res.json(snapshots);
  } catch (err) {
    log.error({ err }, 'Failed to get P&L history');
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/activity?type=trade&limit=50
apiRouter.get('/activity', (req, res) => {
  try {
    const type = req.query.type as string;
    const limit = parseInt(req.query.limit as string) || 50;
    const activities = queries.getActivities({ type, limit });
    res.json(activities);
  } catch (err) {
    log.error({ err }, 'Failed to get activity');
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/bot/start
apiRouter.post('/bot/start', async (_req, res) => {
  try {
    if (!bot) {
      res.status(500).json({ error: 'Bot not initialized' });
      return;
    }

    const status = bot.getStatus();
    if (status.running) {
      res.json({ ok: true, message: 'Bot already running', ...status });
      return;
    }

    await bot.start();
    res.json({ ok: true, message: 'Bot started', ...bot.getStatus() });
  } catch (err) {
    log.error({ err }, 'Failed to start bot');
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/bot/stop
apiRouter.post('/bot/stop', async (_req, res) => {
  try {
    if (!bot) {
      res.status(500).json({ error: 'Bot not initialized' });
      return;
    }

    const status = bot.getStatus();
    if (!status.running) {
      res.json({ ok: true, message: 'Bot already stopped', ...status });
      return;
    }

    await bot.stop();
    res.json({ ok: true, message: 'Bot stopped', ...bot.getStatus() });
  } catch (err) {
    log.error({ err }, 'Failed to stop bot');
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/settings
apiRouter.get('/settings', (_req, res) => {
  try {
    res.json({
      dryRun: config.dryRun,
      betSizeUsd: config.betSizeUsd,
      maxSlippagePct: config.maxSlippagePct,
      pollIntervalMs: config.pollIntervalMs,
      topTradersCount: config.topTradersCount,
      leaderRefreshIntervalMs: config.leaderRefreshIntervalMs,
      dailyLossLimitUsd: config.dailyLossLimitUsd,
      maxOpenPositions: config.maxOpenPositions,
      minMarketLiquidity: config.minMarketLiquidity,
      redeemCheckIntervalMs: config.redeemCheckIntervalMs,
      sellMode: config.sellMode,
    });
  } catch (err) {
    log.error({ err }, 'Failed to get settings');
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/settings
apiRouter.post('/settings', (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const saved: string[] = [];

    for (const [key, value] of Object.entries(body)) {
      if (value != null) {
        queries.setSetting(key, String(value));
        saved.push(key);
      }
    }

    log.info({ saved }, 'Settings updated');
    res.json({ ok: true, saved });
  } catch (err) {
    log.error({ err }, 'Failed to save settings');
    res.status(500).json({ error: (err as Error).message });
  }
});

// === Strategy endpoints ===

// GET /api/strategy/recommendations
apiRouter.get('/strategy/recommendations', async (_req, res) => {
  try {
    const { ParameterOptimizer } = await import('../../core/strategy/optimizer.js');
    const optimizer = new ParameterOptimizer();
    const recs = optimizer.getRecommendations();
    res.json(recs);
  } catch (err) {
    log.error({ err }, 'Failed to get strategy recommendations');
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/strategy/anomalies?limit=50&severity=...&trader=...
apiRouter.get('/strategy/anomalies', async (req, res) => {
  try {
    const { AnomalyDetector } = await import('../../core/strategy/anomaly.js');
    const detector = new AnomalyDetector();
    const limit = parseInt(req.query.limit as string) || 50;
    const severity = req.query.severity as string | undefined;
    const traderAddress = req.query.trader as string | undefined;

    const alerts = detector.getAlerts({ limit, severity, traderAddress });
    res.json(alerts);
  } catch (err) {
    log.error({ err }, 'Failed to get anomaly alerts');
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/strategy/performance
apiRouter.get('/strategy/performance', (_req, res) => {
  try {
    const allPerf = queries.getAllPerformance();
    res.json(allPerf);
  } catch (err) {
    log.error({ err }, 'Failed to get strategy performance');
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/strategy/rotations?limit=50
apiRouter.get('/strategy/rotations', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const rotations = queries.getRotations(limit);
    res.json(rotations);
  } catch (err) {
    log.error({ err }, 'Failed to get rotations');
    res.status(500).json({ error: (err as Error).message });
  }
});
