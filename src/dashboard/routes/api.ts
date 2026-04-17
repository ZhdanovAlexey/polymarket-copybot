import { Router, type Router as RouterType } from 'express';
import { createLogger } from '../../utils/logger.js';
import { config, reloadConfigFromDb } from '../../config.js';
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
    const response: Record<string, unknown> = {
      running: botRunning,
      status: botRunning ? 'running' : 'idle',
      uptime: botStartTime ? Math.floor((Date.now() - botStartTime) / 1000) : 0,
      version: '2.0.0',
      tradersCount: queries.getActiveTraders().length,
      dryRun: config.dryRun,
    };
    if (config.dryRun) {
      response.demoBalance = queries.getDemoBalance();
      response.demoInitialBalance = parseFloat(queries.getSetting('demo_initial_balance') ?? String(config.demoInitialBalanceUsd));
    }
    res.json(response);
  } catch (err) {
    log.error({ err }, 'Failed to get status');
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/traders — returns active + exit-only traders, enriched with open positions count
apiRouter.get('/traders', (_req, res) => {
  try {
    const traders = queries.getTrackedForPolling();
    const enriched = traders.map((t) => ({
      ...t,
      openPositionsCount: queries.countOpenPositionsFromTrader(t.address),
    }));
    res.json(enriched);
  } catch (err) {
    log.error({ err }, 'Failed to get traders');
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/traders/analytics — per-trader stats for "My Leaderboard"
// Fast: DB-only, no live price fetching (unrealized PnL computed on frontend
// using already-loaded position data from /api/positions).
// IMPORTANT: must be before /traders/:address to avoid Express path collision.
apiRouter.get('/traders/analytics', (_req, res) => {
  try {
    const rows = queries.getTraderAnalytics();
    const enriched = rows.map((row) => {
      const total = row.wins + row.losses;
      return {
        ...row,
        winRate: total > 0 ? row.wins / total : 0,
      };
    });
    res.json(enriched);
  } catch (err) {
    log.error({ err }, 'Failed to get trader analytics');
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/traders/:address/pause — pause (exit-only) or resume a trader
apiRouter.post('/traders/:address/pause', (req, res) => {
  try {
    const address = req.params.address;
    const trader = queries.getTraderByAddress(address);
    if (!trader) {
      res.status(404).json({ error: 'Trader not found' });
      return;
    }
    if (trader.active) {
      queries.setExitOnly(address);
      res.json({ status: 'paused' });
    } else {
      queries.reactivateTrader(address);
      res.json({ status: 'active' });
    }
  } catch (err) {
    log.error({ err }, 'Failed to toggle trader pause');
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/traders/:address/positions — open + closed positions attributed to this trader
apiRouter.get('/traders/:address/positions', (req, res) => {
  try {
    const address = req.params.address;

    // Open positions for this trader
    const openTokenIds = queries.getOpenTokenIdsByTrader(address);
    const allOpen = queries.getAllOpenPositions();
    const openPositions = allOpen
      .filter((p) => openTokenIds.includes(p.tokenId))
      .map((p) => ({ ...p, status: 'open' as const, realizedPnl: 0, closedAt: null }));

    // Closed positions for this trader
    const allClosed = queries.getClosedPositions(10000);
    const closedPositions = allClosed.filter((p) => p.traderAddress === address);

    res.json({ open: openPositions, closed: closedPositions });
  } catch (err) {
    log.error({ err }, 'Failed to get trader positions');
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/traders/:address — remove a trader manually.
// If they have open positions opened via their BUYs, move to exit-only
// (keep polling for SELL signals). Otherwise fully deactivate.
apiRouter.delete('/traders/:address', (req, res) => {
  try {
    const address = req.params.address;
    const trader = queries.getTraderByAddress(address);
    if (!trader) {
      res.status(404).json({ error: 'Trader not found' });
      return;
    }

    const openCount = queries.countOpenPositionsFromTrader(address);
    if (openCount > 0) {
      queries.setExitOnly(address);
      log.info({ address, openPositions: openCount }, 'Trader moved to exit-only via API');
    } else {
      queries.deactivateTraderFully(address);
      log.info({ address }, 'Trader fully deactivated via API');
    }

    bot?.refreshTracker();

    res.json({
      ok: true,
      mode: openCount > 0 ? 'exit_only' : 'removed',
      openPositions: openCount,
    });
  } catch (err) {
    log.error({ err }, 'Failed to delete trader');
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
    const totalTradesCount = queries.getTradesCount();
    const failedTradesCount = queries.getTradesCount('failed');
    const totalCommission = queries.getTotalCommission();
    const todayTrades = queries.getTodayTrades();
    const positions = queries.getAllOpenPositions();

    // Round-trip win rate: one "trade" = one closed/redeemed position.
    // Win iff received USD (sells + redeems) > invested USD. This beats a
    // per-SELL heuristic because it (a) uses our actual cost basis rather
    // than trader's original price, (b) counts REDEEM outcomes, (c) handles
    // positions with multiple partial sells correctly.
    const closedRoundTrips = queries.getClosedPositions(10000);
    const wins = closedRoundTrips.filter((p) => p.realizedPnl > 0).length;
    const losses = closedRoundTrips.filter((p) => p.realizedPnl <= 0).length;
    const totalClosedCount = closedRoundTrips.length;

    // Realized P&L across all closed round-trips (matches the Closed
    // Positions table total).
    const realizedPnl = closedRoundTrips.reduce((s, p) => s + p.realizedPnl, 0);

    // In demo mode derive total P&L from balance delta - locked-in invested
    // (matches the pnl_snapshots series driving the chart)
    const lockedInOpen = positions.reduce((s, p) => s + (p.totalInvested ?? 0), 0);
    const demoInitial = parseFloat(
      queries.getSetting('demo_initial_balance') ?? String(config.demoInitialBalanceUsd),
    );
    const totalPnlDemo = config.dryRun
      ? queries.getDemoBalance() - demoInitial + lockedInOpen
      : realizedPnl - totalCommission;

    // Today P&L = currentTotalPnl − firstSnapshot-of-today.totalPnl.
    // Matches the chart (snapshots use the same formula). If no snapshot
    // exists yet for today, fall back to 0 (bot just started).
    const todayBaseline = queries.getTodayBaselineSnapshot();
    const todayPnl = todayBaseline ? totalPnlDemo - todayBaseline.totalPnl : 0;

    const response: Record<string, unknown> = {
      totalPnl: totalPnlDemo,
      realizedPnl,
      unrealizedPnl: 0,
      lockedInOpen,
      winRate: totalClosedCount > 0 ? wins / totalClosedCount : 0,
      wins,
      losses,
      closedCount: totalClosedCount,
      totalTrades: totalTradesCount,
      failedTrades: failedTradesCount,
      todayPnl,
      todayTrades: todayTrades.length,
      openPositions: positions.length,
    };
    if (config.dryRun) {
      response.demoBalance = queries.getDemoBalance();
      response.demoTotalCommission = totalCommission;
    }
    res.json(response);
  } catch (err) {
    log.error({ err }, 'Failed to get metrics');
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/positions (enriched with current prices + market dates)
apiRouter.get('/positions', async (_req, res) => {
  try {
    const positions = queries.getAllOpenPositions();

    // Fetch current prices in parallel
    const { ClobClientWrapper } = await import('../../api/clob-client.js');
    const clob = new ClobClientWrapper();
    const enriched = await Promise.all(
      positions.map(async (p) => {
        const opener = queries.getOpeningTraderForToken(p.tokenId);
        const traderAddress = opener?.address ?? '';
        const traderName = opener?.name ?? '';

        // Market dates from cache (lazy-fill from CLOB if missing)
        let endDate: string | null = null;
        let gameStartTime: string | null = null;
        if (p.conditionId) {
          const cache = queries.getMarketCache(p.conditionId);
          endDate = cache?.endDate ?? null;
          gameStartTime = cache?.gameStartTime ?? null;
          // If game_start_time is missing, fetch from CLOB and cache
          if (!gameStartTime) {
            try {
              const mkt = await clob.getMarketByConditionId(p.conditionId);
              if (mkt) {
                endDate = mkt.end_date_iso ?? endDate;
                gameStartTime = mkt.game_start_time ?? null;
                queries.upsertMarketCache({
                  conditionId: p.conditionId,
                  endDate,
                  gameStartTime,
                });
              }
            } catch { /* non-fatal */ }
          }
        }

        try {
          const curPrice = await clob.getMidpoint(p.tokenId);
          // Persist MTM price so executor budget calc uses fresh data
          queries.setPositionPrice(p.tokenId, curPrice, Math.floor(Date.now() / 1000));
          const currentValue = p.totalShares * curPrice;
          const pnl = currentValue - p.totalInvested;
          return { ...p, curPrice, currentValue, pnl, traderAddress, traderName, endDate, gameStartTime };
        } catch {
          return { ...p, curPrice: null, currentValue: null, pnl: null, traderAddress, traderName, endDate, gameStartTime };
        }
      }),
    );

    res.json(enriched);
  } catch (err) {
    log.error({ err }, 'Failed to get positions');
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/positions/:tokenId/close — manual close (demo mode: simulate SELL at mid)
apiRouter.post('/positions/:tokenId/close', async (req, res) => {
  try {
    const tokenId = req.params.tokenId;
    const position = queries.getPositionByTokenId(tokenId);
    if (!position || position.status !== 'open') {
      res.status(404).json({ error: 'Open position not found' });
      return;
    }

    if (!config.dryRun) {
      res.status(501).json({ error: 'Manual close via UI is only supported in demo mode' });
      return;
    }

    const { ClobClientWrapper } = await import('../../api/clob-client.js');
    const clob = new ClobClientWrapper();
    const mid = await clob.getMidpoint(tokenId);
    if (!(mid > 0)) {
      res.status(422).json({ error: 'No midpoint available (market illiquid?)' });
      return;
    }

    const opener = queries.getOpeningTraderForToken(tokenId);
    if (!opener?.address) {
      res.status(409).json({ error: 'Cannot attribute close (no opening BUY trade found)' });
      return;
    }

    const size = position.totalShares;
    const totalUsd = size * mid;
    const commission = totalUsd * (config.demoCommissionPct / 100);
    const netPayout = totalUsd - commission;

    queries.setDemoBalance(queries.getDemoBalance() + netPayout);
    queries.closePosition(tokenId);

    const result = {
      id: `manual-close-${Date.now()}-${tokenId.slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      traderAddress: opener.address,
      traderName: opener.name,
      side: 'SELL' as const,
      marketSlug: position.marketSlug,
      marketTitle: position.marketTitle,
      conditionId: position.conditionId,
      tokenId,
      outcome: position.outcome,
      size,
      price: mid,
      totalUsd,
      status: 'simulated' as const,
      error: 'Manual close via dashboard',
      originalTraderSize: size,
      originalTraderPrice: position.avgPrice,
      isDryRun: true,
      commission,
    };
    queries.insertTrade(result);
    queries.insertActivity(
      'trade',
      `Manual close: ${position.marketTitle} — ${size.toFixed(2)} @ $${mid.toFixed(4)} (net $${netPayout.toFixed(2)}, P&L $${(totalUsd - position.totalInvested).toFixed(2)})`,
    );

    log.info(
      { tokenId, shares: size, price: mid, netPayout, pnl: totalUsd - position.totalInvested },
      'Manual close executed',
    );
    res.json({ ok: true, netPayout, pnl: totalUsd - position.totalInvested });
  } catch (err) {
    log.error({ err }, 'Manual close failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/positions/closed — round-trip view (closed + redeemed)
apiRouter.get('/positions/closed', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 200;
    const rows = queries.getClosedPositions(limit);
    res.json(rows);
  } catch (err) {
    log.error({ err }, 'Failed to get closed positions');
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/positions/:tokenId/trades — individual trades that built (or reduced) a position
apiRouter.get('/positions/:tokenId/trades', (_req, res) => {
  try {
    const trades = queries.getTradesByTokenId(_req.params.tokenId);
    res.json(trades);
  } catch (err) {
    log.error({ err }, 'Failed to get trades for token');
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

// POST /api/bot/refresh-leaderboard — manual leaderboard refresh
apiRouter.post('/bot/refresh-leaderboard', async (_req, res) => {
  try {
    if (!bot) {
      res.status(500).json({ error: 'Bot not initialized' });
      return;
    }
    if (!bot.getStatus().running) {
      res.status(409).json({ error: 'Bot not running' });
      return;
    }
    const result = await bot.refreshLeaderboardNow();
    res.json({ ok: true, ...result });
  } catch (err) {
    log.error({ err }, 'Manual leaderboard refresh failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/demo/reset
apiRouter.post('/demo/reset', (req, res) => {
  try {
    const initialBalance = req.body?.initialBalance ?? config.demoInitialBalanceUsd;
    queries.resetDemoAccount(initialBalance);
    log.info({ initialBalance }, 'Demo account reset');
    res.json({ ok: true, balance: initialBalance });
  } catch (err) {
    log.error({ err }, 'Failed to reset demo account');
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

    // Re-apply in-memory config so changes take effect without restart.
    reloadConfigFromDb(queries.getSetting);

    // If user changed knobs that shape leaderboard selection, refresh now
    // (instead of waiting for the hourly tick).
    const leaderboardKeys = ['top_traders_count', 'leaderboard_period', 'min_trader_volume'];
    const changedLeaderboardKey = saved.some((k) => leaderboardKeys.includes(k));
    if (changedLeaderboardKey && bot?.getStatus().running) {
      bot
        .refreshLeaderboardNow()
        .catch((e) => log.error({ err: e }, 'Auto-refresh after settings save failed'));
    }

    log.info({ saved, autoRefresh: changedLeaderboardKey }, 'Settings updated');
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

// ============================================================
// Conviction Params API
// ============================================================

// GET /api/conviction-params
apiRouter.get('/conviction-params', (_req, res) => {
  try {
    const params = queries.getConvictionParams();
    res.json(params);
  } catch (err) {
    log.error({ err }, 'Failed to get conviction params');
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/conviction-params
apiRouter.post('/conviction-params', async (req, res) => {
  try {
    const { convictionStore } = await import('../../core/strategy/conviction-store.js');
    const body = req.body as Record<string, unknown>;
    const params = {
      betBase: Number(body.betBase),
      f1Anchor: Number(body.f1Anchor),
      f1Max: Number(body.f1Max),
      w2: Number(body.w2),
      w3: Number(body.w3),
      f4Boost: Number(body.f4Boost),
    };
    if (Object.values(params).some((v) => isNaN(v))) {
      res.status(400).json({ error: 'All params must be numeric' });
      return;
    }
    convictionStore.updateParams(params, 'manual', 'Manual override via API');
    res.json({ ok: true, params });
  } catch (err) {
    log.error({ err }, 'Failed to update conviction params');
    res.status(400).json({ error: (err as Error).message });
  }
});

// GET /api/conviction-params/history?limit=50
apiRouter.get('/conviction-params/history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const history = queries.getConvictionHistory(limit);
    res.json(history);
  } catch (err) {
    log.error({ err }, 'Failed to get conviction params history');
    res.status(500).json({ error: (err as Error).message });
  }
});
