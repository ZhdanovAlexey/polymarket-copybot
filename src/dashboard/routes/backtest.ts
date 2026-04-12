import { Router } from 'express';
import { createLogger } from '../../utils/logger.js';
import { Backtester } from '../../core/strategy/backtest.js';
import type { BacktestConfig } from '../../types.js';

const log = createLogger('backtest-api');
export const backtestRouter: import('express').Router = Router();

const backtester = new Backtester();

// Track running backtests
const runningTests: Map<string, { progress: number; status: string; result?: unknown }> =
  new Map();

// POST /api/backtest/run
backtestRouter.post('/run', (req, res) => {
  try {
    const cfg: BacktestConfig = req.body as BacktestConfig;

    if (!cfg.traders || cfg.traders.length === 0) {
      res.status(400).json({ error: 'traders array required' });
      return;
    }

    // Set defaults
    cfg.periodDays = cfg.periodDays || 30;
    cfg.betSize = cfg.betSize || 5;
    cfg.maxSlippage = cfg.maxSlippage || 5;
    cfg.maxPositions = cfg.maxPositions || 10;

    const testId = `bt_${Date.now()}`;
    runningTests.set(testId, { progress: 0, status: 'running' });

    // Run async
    backtester
      .run(cfg, (pct) => {
        const entry = runningTests.get(testId);
        if (entry) entry.progress = pct;
      })
      .then((result) => {
        const entry = runningTests.get(testId);
        if (entry) {
          entry.status = 'complete';
          entry.result = result;
        }
      })
      .catch((err: unknown) => {
        log.error({ err }, 'Backtest failed');
        const entry = runningTests.get(testId);
        if (entry) entry.status = 'failed';
      });

    res.json({ testId, status: 'started' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

// GET /api/backtest/status?id=...
backtestRouter.get('/status', (req, res) => {
  const id = req.query.id as string;
  if (!id) {
    res.status(400).json({ error: 'id required' });
    return;
  }

  const entry = runningTests.get(id);
  if (!entry) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  res.json({ id, ...entry });
});

// GET /api/backtest/results
backtestRouter.get('/results', (req, res) => {
  const limit = parseInt(req.query.limit as string, 10) || 20;
  const results = backtester.listResults(limit);
  res.json(results);
});

// GET /api/backtest/result/:id
backtestRouter.get('/result/:id', (req, res) => {
  const result = backtester.getResult(req.params.id);
  if (!result) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json(result);
});
