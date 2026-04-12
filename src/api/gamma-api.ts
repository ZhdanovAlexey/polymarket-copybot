import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { fetchWithRetry } from '../utils/retry.js';
import type { GammaMarket, GammaEvent } from '../types.js';

const log = createLogger('gamma-api');

export class GammaApi {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? config.gammaApiHost;
  }

  async getMarket(slug: string): Promise<GammaMarket | null> {
    const url = `${this.baseUrl}/markets?slug=${encodeURIComponent(slug)}`;
    log.debug({ slug, url }, 'fetching market by slug');

    try {
      const res = await fetchWithRetry(url);
      if (!res.ok) {
        throw new Error(`Gamma API responded with ${res.status}: ${res.statusText}`);
      }
      const data: GammaMarket[] = await res.json() as GammaMarket[];
      const market = data[0] ?? null;
      log.debug({ slug, found: market !== null }, 'getMarket result');
      return market;
    } catch (err) {
      log.error({ err, slug }, 'failed to fetch market by slug');
      throw err;
    }
  }

  async getMarketByConditionId(conditionId: string): Promise<GammaMarket | null> {
    const url = `${this.baseUrl}/markets?condition_id=${encodeURIComponent(conditionId)}`;
    log.debug({ conditionId, url }, 'fetching market by conditionId');

    try {
      const res = await fetchWithRetry(url);
      if (!res.ok) {
        throw new Error(`Gamma API responded with ${res.status}: ${res.statusText}`);
      }
      const data: GammaMarket[] = await res.json() as GammaMarket[];
      const market = data[0] ?? null;
      log.debug({ conditionId, found: market !== null }, 'getMarketByConditionId result');
      return market;
    } catch (err) {
      log.error({ err, conditionId }, 'failed to fetch market by conditionId');
      throw err;
    }
  }

  async getEvents(slug: string): Promise<GammaEvent | null> {
    const url = `${this.baseUrl}/events?slug=${encodeURIComponent(slug)}`;
    log.debug({ slug, url }, 'fetching event by slug');

    try {
      const res = await fetchWithRetry(url);
      if (!res.ok) {
        throw new Error(`Gamma API responded with ${res.status}: ${res.statusText}`);
      }
      const data: GammaEvent[] = await res.json() as GammaEvent[];
      const event = data[0] ?? null;
      log.debug({ slug, found: event !== null }, 'getEvents result');
      return event;
    } catch (err) {
      log.error({ err, slug }, 'failed to fetch event by slug');
      throw err;
    }
  }

  async getMarketById(id: string): Promise<GammaMarket | null> {
    const url = `${this.baseUrl}/markets/${encodeURIComponent(id)}`;
    log.debug({ id, url }, 'fetching market by id');

    try {
      const res = await fetchWithRetry(url);
      if (!res.ok) {
        if (res.status === 404) {
          log.debug({ id }, 'market not found by id');
          return null;
        }
        throw new Error(`Gamma API responded with ${res.status}: ${res.statusText}`);
      }
      const market: GammaMarket = await res.json() as GammaMarket;
      log.debug({ id, found: true }, 'getMarketById result');
      return market;
    } catch (err) {
      log.error({ err, id }, 'failed to fetch market by id');
      throw err;
    }
  }
}
