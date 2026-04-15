import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { DataApi } from '../api/data-api.js';
import { ClobClientWrapper } from '../api/clob-client.js';
import * as queries from '../db/queries.js';
import { broadcastEvent } from '../dashboard/routes/sse.js';
import { sleep } from '../utils/helpers.js';
import type { BotPosition, TradeResult } from '../types.js';

const log = createLogger('redeemer');

// Contract addresses
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

export class Redeemer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private dataApi: DataApi;

  constructor() {
    this.dataApi = new DataApi();
  }

  start(): void {
    if (this.timer) return;

    log.info({ intervalMs: config.redeemCheckIntervalMs }, 'Starting auto-redeemer');

    // Run immediately, then on interval
    this.checkAndRedeem().catch(err => log.error({ err }, 'Initial redeem check failed'));

    this.timer = setInterval(() => {
      this.checkAndRedeem().catch(err => log.error({ err }, 'Redeem check failed'));
    }, config.redeemCheckIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info('Auto-redeemer stopped');
    }
  }

  private async checkAndRedeem(): Promise<void> {
    // Demo mode uses a different pipeline: we don't have on-chain positions,
    // so instead we inspect our local open positions and check each market's
    // resolution status via Gamma + CLOB midpoint.
    if (config.dryRun) {
      await this.checkAndRedeemDemo();
      return;
    }

    try {
      const address = queries.getSetting('wallet_address');
      if (!address) {
        log.debug('No wallet address, skipping redeem check');
        return;
      }

      // Get positions that are redeemable
      const positions = await this.dataApi.getPositions(address);
      const redeemable = positions.filter(p => p.redeemable);

      if (redeemable.length === 0) {
        log.debug('No redeemable positions');
        return;
      }

      log.info({ count: redeemable.length }, 'Found redeemable positions');

      // Try to redeem each
      for (const pos of redeemable) {
        try {
          await this.redeemPosition(pos.condition_id);

          queries.insertActivity('redeem', `Redeemed: ${pos.title} (${pos.outcome})`);
          broadcastEvent('trade', {
            side: 'REDEEM',
            marketTitle: pos.title,
            outcome: pos.outcome,
            status: 'filled',
          });

          log.info({ market: pos.title, outcome: pos.outcome }, 'Position redeemed');
        } catch (err) {
          log.error({ err, conditionId: pos.condition_id }, 'Redeem failed');
        }
      }
    } catch (err) {
      log.error({ err }, 'Redeem check failed');
    }
  }

  /**
   * Demo-mode redeem: scan our open positions, ask the CLOB whether the
   * underlying market has resolved, and credit the demo balance accordingly.
   *
   * Uses CLOB `/markets/{conditionId}`, which returns `closed: boolean` and
   * `tokens[].winner: boolean` — authoritative for resolution, no midpoint
   * heuristic required. `tokens[].price` settles to 1.0 (winner) or 0.0.
   */
  private async checkAndRedeemDemo(): Promise<void> {
    const open = queries.getAllOpenPositions();
    if (open.length === 0) return;

    const clob = new ClobClientWrapper();

    log.info({ count: open.length }, 'Demo auto-redeem: scanning open positions');

    let redeemedCount = 0;
    for (const pos of open) {
      try {
        if (!pos.conditionId) continue;

        // --- Cache-first: check market_resolutions before hitting CLOB API ---
        const cached = queries.getMarketResolution(pos.conditionId);
        if (cached?.status === 'resolved') {
          const isWinner = pos.tokenId === cached.winnerTokenId;
          const payout = isWinner ? pos.totalShares * 1.0 : 0;
          this.applyDemoRedeem(pos, payout, isWinner);
          redeemedCount++;
          continue; // skip CLOB API call
        }

        const market = await clob.getMarketByConditionId(pos.conditionId);
        if (!market || !market.closed) continue;

        const ourToken = market.tokens.find((t) => t.token_id === pos.tokenId);
        if (!ourToken) {
          log.warn({ tokenId: pos.tokenId, conditionId: pos.conditionId }, 'Our token not found in resolved market');
          continue;
        }

        const isWinner = ourToken.winner === true;

        // --- Warm the cache for future redeem checks / backfill ---
        const winnerToken = market.tokens.find((t) => t.winner === true);
        const now = Math.floor(Date.now() / 1000);
        queries.upsertMarketResolution({
          conditionId: pos.conditionId,
          winnerTokenId: winnerToken?.token_id ?? null,
          resolvedAt: now,
          marketTitle: market.question,
          fetchedAt: now,
          status: winnerToken ? 'resolved' : 'closed_not_resolved',
        });

        const payout = isWinner ? pos.totalShares * 1.0 : 0;
        this.applyDemoRedeem(pos, payout, isWinner);
        redeemedCount += 1;
      } catch (err) {
        log.warn({ err, tokenId: pos.tokenId }, 'Demo redeem check failed for position');
      }
      await sleep(100); // rate-limit CLOB
    }

    if (redeemedCount > 0) {
      log.info({ count: redeemedCount }, 'Demo auto-redeem: positions redeemed');
    }
  }

  private applyDemoRedeem(pos: BotPosition, payout: number, isWinner: boolean): void {
    const newBalance = queries.getDemoBalance() + payout;
    queries.setDemoBalance(newBalance);

    queries.markPositionRedeemed(pos.tokenId);

    // Attribute the redeem to the trader whose BUY opened this position (FK
    // constraint on trades.trader_address requires a real tracked trader).
    const opener = queries.getOpeningTraderForToken(pos.tokenId);

    const id = `redeem-${Date.now()}-${pos.tokenId.slice(0, 8)}`;
    const result: TradeResult = {
      id,
      timestamp: new Date().toISOString(),
      traderAddress: opener?.address ?? '',
      traderName: opener?.name ?? 'Auto-Redeem',
      side: 'REDEEM',
      marketSlug: pos.marketSlug ?? '',
      marketTitle: pos.marketTitle ?? '',
      conditionId: pos.conditionId ?? '',
      tokenId: pos.tokenId,
      outcome: pos.outcome ?? '',
      size: pos.totalShares,
      price: isWinner ? 1 : 0,
      totalUsd: payout,
      status: 'simulated',
      error: isWinner ? 'Market resolved (won)' : 'Market resolved (lost)',
      originalTraderSize: pos.totalShares,
      originalTraderPrice: pos.avgPrice,
      isDryRun: true,
      commission: 0,
    };
    // Only persist the trade row when we have a known opener — trades table
    // has a FK on trader_address. Without one we still credit balance + mark
    // the position + activity-log the redeem, so no value is lost.
    if (opener?.address) {
      queries.insertTrade(result);
      broadcastEvent('trade', result);
    }

    queries.insertActivity(
      'redeem',
      `Redeemed: ${pos.marketTitle || pos.tokenId} (${pos.outcome || '?'}) — payout $${payout.toFixed(2)}`,
    );

    log.info(
      {
        market: pos.marketTitle,
        outcome: pos.outcome,
        shares: pos.totalShares,
        payout,
        winner: isWinner,
      },
      'Demo position redeemed',
    );
  }

  private async redeemPosition(conditionId: string): Promise<string> {
    const { ethers } = await import('ethers');

    const privateKey = config.privateKey;
    if (!privateKey) throw new Error('No private key configured');

    const provider = new ethers.providers.JsonRpcProvider(config.polygonRpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);

    const ctfAbi = [
      'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    ];
    const ctf = new ethers.Contract(CTF_ADDRESS, ctfAbi, wallet);

    const tx = await ctf.redeemPositions(
      USDC_ADDRESS,
      ethers.constants.HashZero,
      conditionId,
      [1, 2],
    );

    const receipt = await tx.wait();
    log.info({ txHash: receipt.transactionHash }, 'Redeem transaction confirmed');

    return receipt.transactionHash as string;
  }
}
