import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ws-client');

export interface WsClientConfig {
  url: string;
  reconnectIntervalMs: number;
  maxReconnectAttempts: number;
}

export class PolymarketWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectCount = 0;
  private subscriptions = new Set<string>();
  private connected = false;
  private disposed = false;

  constructor(private wsConfig: WsClientConfig) {
    super();
  }

  connect(): void {
    if (this.disposed) return;
    try {
      this.ws = new WebSocket(this.wsConfig.url);
      this.ws.on('open', () => {
        this.connected = true;
        this.reconnectCount = 0;
        log.info({ url: this.wsConfig.url }, 'WS connected');
        this.emit('connected');
        // Resubscribe to all channels after reconnect
        for (const sub of this.subscriptions) this.sendSubscribe(sub);
      });
      this.ws.on('message', (data) => this.handleMessage(data));
      this.ws.on('close', () => {
        this.connected = false;
        this.emit('disconnected', {
          willReconnect: this.reconnectCount < this.wsConfig.maxReconnectAttempts,
        });
        this.scheduleReconnect();
      });
      this.ws.on('error', (err) => {
        log.warn({ err: err.message }, 'WS error');
        this.emit('error', err);
      });
    } catch (err) {
      log.error({ err }, 'Failed to create WebSocket');
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.disposed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Subscribe to price/book updates for a token.
   * Queued if not yet connected — will be sent on next 'open'.
   */
  subscribePriceUpdates(tokenId: string): void {
    const key = `price:${tokenId}`;
    this.subscriptions.add(key);
    if (this.connected) this.sendSubscribe(key);
  }

  unsubscribe(id: string): void {
    this.subscriptions.delete(id);
  }

  private sendSubscribe(subscription: string): void {
    if (!this.ws || !this.connected) return;
    try {
      this.ws.send(JSON.stringify({ type: 'subscribe', channel: subscription }));
    } catch (err) {
      log.warn({ err, subscription }, 'Failed to send subscribe');
    }
  }

  private handleMessage(data: WebSocket.RawData): void {
    try {
      const raw = data instanceof Buffer ? data.toString() : String(data);
      const msg = JSON.parse(raw) as Record<string, unknown>;
      // Emit raw message for debugging / future consumers
      this.emit('message', msg);
      if (msg['type'] === 'price') this.emit('price', msg);
      if (msg['type'] === 'trade') this.emit('trade', msg);
    } catch (err) {
      log.debug({ err }, 'Failed to parse WS message');
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectCount >= this.wsConfig.maxReconnectAttempts) {
      log.error('WS reconnect attempts exhausted');
      this.emit('fatal', new Error('Max reconnect attempts reached'));
      return;
    }
    this.reconnectCount++;
    log.info(
      { attempt: this.reconnectCount, maxAttempts: this.wsConfig.maxReconnectAttempts },
      'Scheduling WS reconnect',
    );
    setTimeout(() => this.connect(), this.wsConfig.reconnectIntervalMs);
  }
}
