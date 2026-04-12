import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { DataApi } from '../api/data-api.js';
import * as queries from '../db/queries.js';
import { broadcastEvent } from '../dashboard/routes/sse.js';

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
