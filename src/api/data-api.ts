import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { fetchWithRetry } from '../utils/retry.js';
import type { LeaderboardEntry, ActivityEntry, PositionEntry, TradeEntry } from '../types.js';

const log = createLogger('data-api');

export class DataApi {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? config.dataApiHost;
  }

  async getLeaderboard(
    period?: string,
    orderBy?: string,
    limit?: number,
  ): Promise<LeaderboardEntry[]> {
    const params = new URLSearchParams();
    params.set('period', period ?? config.leaderboardPeriod);
    params.set('orderBy', orderBy ?? 'pnl');
    params.set('limit', String(limit ?? config.topTradersCount));

    const url = `${this.baseUrl}/leaderboard?${params}`;
    log.debug({ url }, 'Fetching leaderboard');

    const data = await this.fetchJson<Record<string, unknown>[]>(url);

    return data.map(mapLeaderboardEntry);
  }

  async getActivity(
    address: string,
    opts?: {
      type?: string;
      start?: number;
      sortBy?: string;
      sortDirection?: string;
      limit?: number;
    },
  ): Promise<ActivityEntry[]> {
    const params = new URLSearchParams();
    params.set('user', address);
    if (opts?.type) params.set('type', opts.type);
    if (opts?.start != null) params.set('start', String(opts.start));
    params.set('sortBy', opts?.sortBy ?? 'TIMESTAMP');
    params.set('sortDirection', opts?.sortDirection ?? 'ASC');
    if (opts?.limit != null) params.set('limit', String(opts.limit));

    const url = `${this.baseUrl}/activity?${params}`;
    log.debug({ url, address }, 'Fetching activity');

    const data = await this.fetchJson<Record<string, unknown>[]>(url);

    return data.map(mapActivityEntry);
  }

  async getPositions(address: string): Promise<PositionEntry[]> {
    const params = new URLSearchParams({ user: address });
    const url = `${this.baseUrl}/positions?${params}`;
    log.debug({ url, address }, 'Fetching positions');

    const data = await this.fetchJson<Record<string, unknown>[]>(url);

    return data.map(mapPositionEntry);
  }

  async getTrades(address: string, limit?: number): Promise<TradeEntry[]> {
    const params = new URLSearchParams({ user: address });
    if (limit != null) params.set('limit', String(limit));

    const url = `${this.baseUrl}/trades?${params}`;
    log.debug({ url, address }, 'Fetching trades');

    const data = await this.fetchJson<Record<string, unknown>[]>(url);

    return data.map(mapTradeEntry);
  }

  async getValue(address: string): Promise<number> {
    const params = new URLSearchParams({ user: address });
    const url = `${this.baseUrl}/value?${params}`;
    log.debug({ url, address }, 'Fetching portfolio value');

    const data = await this.fetchJson<Record<string, unknown>>(url);

    return Number(data.value ?? data.portfolio_value ?? 0);
  }

  async getClosedPositions(address: string): Promise<PositionEntry[]> {
    const params = new URLSearchParams({ user: address });
    const url = `${this.baseUrl}/closed-positions?${params}`;
    log.debug({ url, address }, 'Fetching closed positions');

    const data = await this.fetchJson<Record<string, unknown>[]>(url);

    return data.map(mapPositionEntry);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async fetchJson<T>(url: string): Promise<T> {
    try {
      const response = await fetchWithRetry(url);

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const err = new Error(
          `Data API request failed: ${response.status} ${response.statusText} — ${body}`,
        );
        log.error({ url, status: response.status, body }, 'Data API request failed');
        throw err;
      }

      return (await response.json()) as T;
    } catch (error) {
      log.error({ url, error: String(error) }, 'Data API request error');
      throw error;
    }
  }
}

// =============================================================================
// Mapping helpers — convert API snake_case / camelCase responses to our types
// =============================================================================

function num(v: unknown): number {
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

function mapLeaderboardEntry(raw: Record<string, unknown>): LeaderboardEntry {
  return {
    address: str(raw.address ?? raw.userAddress),
    name: str(raw.name ?? raw.username ?? raw.displayName ?? ''),
    profileImage: raw.profileImage != null ? str(raw.profileImage) : undefined,
    pnl: num(raw.pnl ?? raw.profit),
    volume: num(raw.volume),
    markets_traded: num(raw.markets_traded ?? raw.marketsTraded ?? raw.numMarkets),
    positions_value: num(raw.positions_value ?? raw.positionsValue ?? raw.portfolioValue),
    rank: num(raw.rank),
  };
}

function mapActivityEntry(raw: Record<string, unknown>): ActivityEntry {
  return {
    id: str(raw.id),
    timestamp: num(raw.timestamp ?? raw.time),
    address: str(raw.address ?? raw.user ?? raw.userAddress),
    type: str(raw.type),
    action: str(raw.action ?? raw.side),
    market_slug: str(raw.market_slug ?? raw.marketSlug ?? raw.slug),
    title: str(raw.title ?? raw.question ?? raw.marketTitle),
    description: str(raw.description ?? ''),
    token_id: str(raw.token_id ?? raw.tokenId ?? raw.asset),
    condition_id: str(raw.condition_id ?? raw.conditionId),
    outcome: str(raw.outcome),
    size: num(raw.size ?? raw.amount),
    price: num(raw.price),
    usd_value: num(raw.usd_value ?? raw.usdValue ?? raw.value),
    transaction_hash: str(raw.transaction_hash ?? raw.transactionHash ?? raw.txHash),
  };
}

function mapPositionEntry(raw: Record<string, unknown>): PositionEntry {
  return {
    asset: str(raw.asset ?? raw.token_id ?? raw.tokenId),
    condition_id: str(raw.condition_id ?? raw.conditionId),
    market_slug: str(raw.market_slug ?? raw.marketSlug ?? raw.slug),
    title: str(raw.title ?? raw.question ?? raw.marketTitle),
    outcome: str(raw.outcome),
    size: num(raw.size ?? raw.amount),
    avg_price: num(raw.avg_price ?? raw.avgPrice ?? raw.averagePrice),
    cur_price: num(raw.cur_price ?? raw.curPrice ?? raw.currentPrice),
    initial_value: num(raw.initial_value ?? raw.initialValue),
    current_value: num(raw.current_value ?? raw.currentValue),
    pnl: num(raw.pnl ?? raw.profit),
    pnl_percent: num(raw.pnl_percent ?? raw.pnlPercent ?? raw.pnlPct),
    redeemable: Boolean(raw.redeemable ?? false),
  };
}

function mapTradeEntry(raw: Record<string, unknown>): TradeEntry {
  return {
    id: str(raw.id),
    timestamp: num(raw.timestamp ?? raw.time),
    market_slug: str(raw.market_slug ?? raw.marketSlug ?? raw.slug),
    title: str(raw.title ?? raw.question ?? raw.marketTitle),
    side: str(raw.side ?? raw.action),
    outcome: str(raw.outcome),
    size: num(raw.size ?? raw.amount),
    price: num(raw.price),
    status: str(raw.status ?? 'filled'),
  };
}
