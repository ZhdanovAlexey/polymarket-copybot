import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('telegram');

let bot: import('node-telegram-bot-api') | null = null;
let botInitPromise: Promise<import('node-telegram-bot-api') | null> | null = null;

function getBotInstance(): Promise<import('node-telegram-bot-api') | null> {
  if (!config.telegramEnabled || !config.telegramToken || !config.telegramChatId) {
    return Promise.resolve(null);
  }

  if (bot) {
    return Promise.resolve(bot);
  }

  if (!botInitPromise) {
    botInitPromise = (async () => {
      try {
        // Dynamic import — node-telegram-bot-api is a CJS module
        const mod = await import('node-telegram-bot-api');
        const TelegramBot = mod.default;
        bot = new TelegramBot(config.telegramToken, { polling: false });
        log.info('Telegram bot initialized');
        return bot;
      } catch (err) {
        log.error({ err }, 'Failed to initialize Telegram bot');
        botInitPromise = null;
        return null;
      }
    })();
  }

  return botInitPromise;
}

async function sendMessage(text: string): Promise<void> {
  const instance = await getBotInstance();
  if (!instance) return;

  try {
    await instance.sendMessage(config.telegramChatId, text, { parse_mode: 'HTML' });
    log.debug('Telegram message sent');
  } catch (err) {
    log.error({ err }, 'Failed to send Telegram message');
  }
}

// === Notification Templates ===

export async function notifyBotStarted(tradersCount: number, balance: number): Promise<void> {
  if (!config.telegramEnabled) return;

  await sendMessage(
    `🟢 <b>Bot Started</b>\n` +
    `Tracking ${tradersCount} traders | Balance: $${balance.toFixed(2)}\n` +
    `Mode: ${config.dryRun ? '🧪 DRY RUN' : '💰 REAL TRADING'}`,
  );
}

export async function notifyBotStopped(reason?: string): Promise<void> {
  if (!config.telegramEnabled) return;

  await sendMessage(
    `🔴 <b>Bot Stopped</b>${reason ? `\nReason: ${reason}` : ''}`,
  );
}

export async function notifyTradeCopied(trade: {
  traderName: string;
  marketTitle: string;
  side: string;
  outcome: string;
  price: number;
  size: number;
  totalUsd: number;
  status: string;
  isDryRun: boolean;
}): Promise<void> {
  if (!config.telegramEnabled || !config.telegramNotifyTrades) return;

  const emoji = trade.side === 'BUY' ? '📈' : '📉';
  const dryRunLabel = trade.isDryRun ? ' [DRY RUN]' : '';
  const statusEmoji = trade.status === 'filled' || trade.status === 'simulated' ? '✅' : '❌';

  await sendMessage(
    `${emoji} <b>Trade Copied${dryRunLabel}</b>\n` +
    `Trader: ${trade.traderName}\n` +
    `Market: ${trade.marketTitle}\n` +
    `Side: ${trade.side} ${trade.outcome} @ $${trade.price.toFixed(4)}\n` +
    `Size: $${trade.totalUsd.toFixed(2)} (${trade.size.toFixed(2)} shares)\n` +
    `Status: ${statusEmoji} ${trade.status}`,
  );
}

export async function notifyPositionSold(info: {
  marketTitle: string;
  outcome: string;
  price: number;
  pnl: number;
  pnlPercent: number;
}): Promise<void> {
  if (!config.telegramEnabled || !config.telegramNotifyTrades) return;

  const pnlEmoji = info.pnl >= 0 ? '💚' : '💔';
  const pnlSign = info.pnl >= 0 ? '+' : '';

  await sendMessage(
    `📉 <b>Position Sold</b>\n` +
    `Market: ${info.marketTitle}\n` +
    `Side: SELL ${info.outcome} @ $${info.price.toFixed(4)}\n` +
    `P&L: ${pnlEmoji} ${pnlSign}$${info.pnl.toFixed(2)} (${pnlSign}${info.pnlPercent.toFixed(1)}%)`,
  );
}

export async function notifyDailySummary(summary: {
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  winRate: number;
  openPositions: number;
}): Promise<void> {
  if (!config.telegramEnabled || !config.telegramDailySummary) return;

  const pnlSign = summary.pnl >= 0 ? '+' : '';

  await sendMessage(
    `📊 <b>Daily Summary</b>\n` +
    `Trades: ${summary.trades} (${summary.wins} wins, ${summary.losses} losses)\n` +
    `P&L: ${pnlSign}$${summary.pnl.toFixed(2)}\n` +
    `Win Rate: ${(summary.winRate * 100).toFixed(1)}%\n` +
    `Open positions: ${summary.openPositions}`,
  );
}

export async function notifyError(message: string): Promise<void> {
  if (!config.telegramEnabled || !config.telegramNotifyErrors) return;

  await sendMessage(`⚠️ <b>Alert</b>\n${message}`);
}

export async function notifyRiskLimit(limit: string, value: string): Promise<void> {
  if (!config.telegramEnabled || !config.telegramNotifyErrors) return;

  await sendMessage(
    `🔴 <b>Risk Limit Reached</b>\n` +
    `Limit: ${limit}\n` +
    `Value: ${value}\n` +
    `Bot has been stopped.`,
  );
}
