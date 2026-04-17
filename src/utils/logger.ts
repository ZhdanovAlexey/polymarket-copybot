import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const DATA_DIR = process.env.BOT_DATA_DIR
  ? resolve(process.env.BOT_DATA_DIR)
  : resolve(PROJECT_ROOT, 'data');
const LOG_FILE = resolve(DATA_DIR, 'copybot.log');

// Ensure data directory exists
mkdirSync(DATA_DIR, { recursive: true });

// Determine log level from env (can't import config here to avoid circular deps)
const logLevel = process.env.LOG_LEVEL || 'info';

const transports = pino.transport({
  targets: [
    {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
      level: logLevel,
    },
    {
      target: 'pino/file',
      options: { destination: LOG_FILE, mkdir: true },
      level: logLevel,
    },
  ],
});

export const logger = pino({ level: logLevel }, transports);

/**
 * Create a child logger for a specific module.
 */
export function createLogger(module: string): pino.Logger {
  return logger.child({ module });
}
