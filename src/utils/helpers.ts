import { randomBytes } from 'node:crypto';

/**
 * Format a number as USD currency string.
 * Example: 1234.567 -> "$1,234.57"
 */
export function formatUsd(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Format a number as a percentage string with sign.
 * Example: 0.123 -> "+12.3%", -0.05 -> "-5.0%"
 */
export function formatPercent(value: number): string {
  const pct = value * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

/**
 * Sleep for the given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get current Unix timestamp in seconds.
 */
export function nowTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Generate a random ID string for trades and other entities.
 */
export function generateId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Shorten an Ethereum address for display.
 * Example: "0x1a2b3c4d5e6f..." -> "0x1a2b...6f7e"
 */
export function shortenAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
