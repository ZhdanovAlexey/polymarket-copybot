import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { fetchWithRetry } from '../utils/retry.js';
import type { OrderBookResponse } from '../types.js';

export interface ClobMarket {
  condition_id: string;
  question: string;
  market_slug: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  accepting_orders: boolean;
  end_date_iso?: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
    winner: boolean;
  }>;
}

const log = createLogger('clob-client');

/**
 * Derive or create CLOB API keys from the wallet private key.
 * Saves the credentials to .env and returns them.
 */
export async function initClobClientWithAuth(): Promise<{
  apiKey: string;
  secret: string;
  passphrase: string;
} | null> {
  try {
    const { ethers } = await import('ethers');
    const { ClobClient } = await import('@polymarket/clob-client');

    // Read private key from process.env or .env file
    let privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
      privateKey = await readEnvValue('PRIVATE_KEY');
    }
    if (!privateKey) {
      log.error('No PRIVATE_KEY found in environment or .env file');
      return null;
    }

    // Create ethers wallet (v5)
    const wallet = new ethers.Wallet(privateKey);
    const address = wallet.address;

    log.info({ address }, 'Initializing CLOB client for key derivation');

    // Chain ID 137 = Polygon mainnet
    const chainId = 137;

    // Create CLOB client with signer (no creds yet)
    const client = new ClobClient(
      config.clobHost,
      chainId,
      wallet,          // signer (ethers.Wallet implements _signTypedData + getAddress)
      undefined,       // no creds yet
      undefined,       // signatureType (default EOA = 0)
      address,         // funderAddress
    );

    // Derive or create API key
    const creds = await client.createOrDeriveApiKey();

    log.info('API keys derived successfully');

    // Save credentials to .env
    await writeEnvValue('CLOB_API_KEY', creds.key);
    await writeEnvValue('CLOB_SECRET', creds.secret);
    await writeEnvValue('CLOB_PASSPHRASE', creds.passphrase);

    return {
      apiKey: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase,
    };
  } catch (err) {
    log.error({ err }, 'Failed to initialize CLOB client with auth');
    return null;
  }
}

// Helper: read a value from the .env file directly
async function readEnvValue(key: string): Promise<string | undefined> {
  const { readFileSync, existsSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const envPath = resolve(projectRoot, '.env');

  if (!existsSync(envPath)) return undefined;

  const content = readFileSync(envPath, 'utf-8');
  const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match?.[1] || undefined;
}

// Helper: write a value to the .env file
async function writeEnvValue(key: string, value: string): Promise<void> {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const envPath = resolve(projectRoot, '.env');

  let content = '';
  if (existsSync(envPath)) {
    content = readFileSync(envPath, 'utf-8');
  }

  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}`;
  }

  writeFileSync(envPath, content);
}

// Read-only CLOB client for public endpoints
export class ClobClientWrapper {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? config.clobHost;
  }

  async getMidpoint(tokenId: string): Promise<number> {
    const url = `${this.baseUrl}/midpoint?token_id=${encodeURIComponent(tokenId)}`;
    log.debug({ tokenId, url }, 'fetching midpoint');

    try {
      const res = await fetchWithRetry(url);
      if (!res.ok) {
        throw new Error(`CLOB API responded with ${res.status}: ${res.statusText}`);
      }
      const data = (await res.json()) as { mid: string };
      const mid = parseFloat(data.mid);
      log.debug({ tokenId, mid }, 'getMidpoint result');
      return mid;
    } catch (err) {
      log.error({ err, tokenId }, 'failed to fetch midpoint');
      throw err;
    }
  }

  /**
   * Fetch market metadata by condition id, including resolution state.
   * `closed=true` combined with `tokens[].winner` tells us which outcome paid
   * out $1.00 and which settled to $0.00 — needed for demo auto-redeem.
   */
  async getMarketByConditionId(conditionId: string): Promise<ClobMarket | null> {
    const url = `${this.baseUrl}/markets/${encodeURIComponent(conditionId)}`;
    log.debug({ conditionId, url }, 'fetching CLOB market by conditionId');

    try {
      const res = await fetchWithRetry(url);
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`CLOB API responded with ${res.status}: ${res.statusText}`);
      }
      const data = (await res.json()) as ClobMarket;
      return data;
    } catch (err) {
      log.error({ err, conditionId }, 'failed to fetch CLOB market by conditionId');
      throw err;
    }
  }

  /**
   * Return resolution status for a market.
   * Closed markets usually have exactly one token with winner=true.
   * Returns winnerTokenId=null if closed without a declared winner (rare: invalid/refunded markets).
   */
  async getMarketResolution(
    conditionId: string,
  ): Promise<{ closed: boolean; winnerTokenId: string | null }> {
    const url = `${this.baseUrl}/markets/${encodeURIComponent(conditionId)}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) {
      throw new Error(`CLOB markets request failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as {
      closed?: boolean;
      tokens?: Array<{ token_id: string; winner?: boolean }>;
    };
    const closed = Boolean(data.closed);
    const winner = (data.tokens ?? []).find((t) => t.winner === true);
    return {
      closed,
      winnerTokenId: winner?.token_id ?? null,
    };
  }

  async getOrderBook(tokenId: string): Promise<OrderBookResponse> {
    const url = `${this.baseUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
    log.debug({ tokenId, url }, 'fetching order book');

    try {
      const res = await fetchWithRetry(url);
      if (!res.ok) {
        throw new Error(`CLOB API responded with ${res.status}: ${res.statusText}`);
      }
      const data = (await res.json()) as OrderBookResponse;
      log.debug(
        { tokenId, bids: data.bids.length, asks: data.asks.length },
        'getOrderBook result',
      );
      return data;
    } catch (err) {
      log.error({ err, tokenId }, 'failed to fetch order book');
      throw err;
    }
  }

  async getPrice(tokenId: string): Promise<number> {
    const url = `${this.baseUrl}/price?token_id=${encodeURIComponent(tokenId)}&side=buy`;
    log.debug({ tokenId, url }, 'fetching price');

    try {
      const res = await fetchWithRetry(url);
      if (!res.ok) {
        throw new Error(`CLOB API responded with ${res.status}: ${res.statusText}`);
      }
      const data = (await res.json()) as { price: string };
      const price = parseFloat(data.price);
      log.debug({ tokenId, price }, 'getPrice result');
      return price;
    } catch (err) {
      log.error({ err, tokenId }, 'failed to fetch price');
      throw err;
    }
  }

  // Helper: get best bid price from order book
  getBestBid(book: OrderBookResponse): number | null {
    if (book.bids.length === 0) {
      return null;
    }
    return parseFloat(book.bids[0].price);
  }

  // Helper: get best ask price from order book
  getBestAsk(book: OrderBookResponse): number | null {
    if (book.asks.length === 0) {
      return null;
    }
    return parseFloat(book.asks[0].price);
  }
}

// Singleton-like factory
let instance: ClobClientWrapper | null = null;

export function getClobClient(): ClobClientWrapper {
  if (!instance) {
    instance = new ClobClientWrapper();
  }
  return instance;
}
