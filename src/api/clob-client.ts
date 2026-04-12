import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { fetchWithRetry } from '../utils/retry.js';
import type { OrderBookResponse } from '../types.js';

const log = createLogger('clob-client');

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
