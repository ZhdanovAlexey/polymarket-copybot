import { readFileSync, existsSync } from 'node:fs';
import { config } from './config.js';
import { reloadConfigFromDb } from './config.js';
import { initDb, closeDb } from './db/database.js';
import { createLogger } from './utils/logger.js';
import { Bot } from './core/bot.js';
import { startDashboard } from './dashboard/server.js';
import { setBot } from './dashboard/routes/api.js';
import { setBot as setAuthBot } from './dashboard/routes/auth.js';
import * as queries from './db/queries.js';

const log = createLogger('main');

// Singleton bot instance
let bot: Bot | null = null;
let isShuttingDown = false;

async function main(): Promise<void> {
  log.info('=== PolyMarket CopyBot PRO ===');
  log.info(
    {
      dryRun: config.dryRun,
      betSize: config.betSizeUsd,
      topTraders: config.topTradersCount,
      pollInterval: config.pollIntervalMs,
      dashboardPort: config.dashboardPort,
    },
    'Configuration loaded',
  );

  // Initialize database
  initDb();

  // Apply config overrides from BOT_CONFIG JSON (for multi-bot runner)
  const configPath = process.env.BOT_CONFIG;
  if (configPath && existsSync(configPath)) {
    const overrides = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (overrides.settings) {
      for (const [key, value] of Object.entries(overrides.settings)) {
        queries.setSetting(key, String(value));
      }
      log.info({ config: configPath, keys: Object.keys(overrides.settings) }, 'Applied config overrides from JSON');
    }
  }

  // Always reload config from DB to pick up persisted settings
  reloadConfigFromDb(queries.getSetting);

  // Create Bot instance
  bot = new Bot();

  // Make bot accessible to API routes
  setBot(bot);
  setAuthBot(bot);

  // Start dashboard
  startDashboard();

  log.info('Startup complete. Dashboard running. Bot is idle — start via UI or API.');
}

async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info('Shutting down gracefully...');

  if (bot) {
    try {
      await bot.stop();
    } catch (err) {
      log.error({ err }, 'Error stopping bot');
    }
  }

  closeDb();
  log.info('Shutdown complete.');
  process.exit(0);
}

// Graceful shutdown handlers
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });

// Error boundaries — log and continue, don't crash
process.on('uncaughtException', (err) => {
  log.error({ err }, 'Uncaught exception');
});

process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'Unhandled rejection');
});

main().catch((err) => {
  log.fatal({ err }, 'Fatal error during startup');
  closeDb();
  process.exit(1);
});
