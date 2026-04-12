import { config } from './config.js';
import { initDb, closeDb } from './db/database.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('main');

function main(): void {
  log.info('=== PolyMarket CopyBot PRO ===');
  log.info(
    {
      dryRun: config.dryRun,
      betSize: config.betSizeUsd,
      topTraders: config.topTradersCount,
      pollInterval: config.pollIntervalMs,
      dashboardPort: config.dashboardPort,
    },
    'Configuration loaded'
  );

  // Initialize database
  initDb();

  log.info('Startup complete. All systems initialized.');

  // Clean shutdown
  closeDb();
  log.info('Shutdown complete.');
}

try {
  main();
} catch (err) {
  log.fatal({ err }, 'Fatal error during startup');
  closeDb();
  process.exit(1);
}
