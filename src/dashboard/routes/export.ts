import { Router } from 'express';
import * as queries from '../../db/queries.js';

export const exportRouter: import('express').Router = Router();

// GET /api/export/trades?format=csv
exportRouter.get('/trades', (req, res) => {
  try {
    const trades = queries.getTrades({ limit: 10000 });

    const headers = ['Time', 'Trader', 'Market', 'Side', 'Outcome', 'Shares', 'Price', 'Total USD', 'Status', 'Dry Run'];
    const rows = trades.map(t => [
      t.timestamp,
      t.traderName,
      t.marketTitle,
      t.side,
      t.outcome,
      t.size.toFixed(4),
      t.price.toFixed(4),
      t.totalUsd.toFixed(2),
      t.status,
      t.isDryRun ? 'Yes' : 'No',
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=trades.csv');
    res.send(csv);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});
