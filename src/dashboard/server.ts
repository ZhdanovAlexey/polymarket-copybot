import express from 'express';
import compression from 'compression';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { apiRouter } from './routes/api.js';
import { authRouter } from './routes/auth.js';
import { sseRouter } from './routes/sse.js';
import { backtestRouter } from './routes/backtest.js';
import { exportRouter } from './routes/export.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = createLogger('dashboard');

export function createDashboardServer(): express.Express {
  const app = express();

  app.use(compression());
  app.use(express.json());

  // CORS for local dev
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    next();
  });

  // API routes
  app.use('/api', apiRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/sse', sseRouter);
  app.use('/api/backtest', backtestRouter);
  app.use('/api/export', exportRouter);

  // Static files (1h cache for CSS/JS — fingerprinted by browser via ETag)
  const publicDir = resolve(__dirname, 'public');
  app.use(express.static(publicDir, { maxAge: '1h', etag: true }));

  // SPA fallback (Express 5 requires named wildcard)
  app.get('/{*path}', (req, res) => {
    res.sendFile(resolve(publicDir, 'index.html'));
  });

  // JSON error handler
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      log.error({ err }, 'Unhandled error');
      res.status(500).json({ error: err.message ?? 'Internal server error' });
    },
  );

  return app;
}

export function startDashboard(): void {
  const app = createDashboardServer();
  app.listen(config.dashboardPort, () => {
    log.info({ port: config.dashboardPort }, 'Dashboard running');
  });
}
