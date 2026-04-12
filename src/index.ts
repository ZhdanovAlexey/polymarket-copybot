import { config } from './config.js';
import { initDb, closeDb } from './db/database.js';
import { createLogger } from './utils/logger.js';
import { Bot } from './core/bot.js';
import { startDashboard } from './dashboard/server.js';
import { setBot } from './dashboard/routes/api.js';

const log = createLogger('main');

// Singleton bot instance
let bot: Bot | null = null;

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

  // Create Bot instance
  bot = new Bot();

  // Make bot accessible to API routes
  setBot(bot);

  // Start dashboard
  startDashboard();

  log.info('Startup complete. Dashboard running. Bot is idle — start via UI or API.');
}

async function shutdown(): Promise<void> {
  log.info('Graceful shutdown initiated...');

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

main().catch((err) => {
  log.fatal({ err }, 'Fatal error during startup');
  closeDb();
  process.exit(1);
});
