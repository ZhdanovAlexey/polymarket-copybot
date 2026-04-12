import { Router, Request, Response } from 'express';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('sse');
export const sseRouter: import('express').Router = Router();

// Connected clients
const clients: Set<Response> = new Set();

// GET /api/sse — persistent SSE connection
sseRouter.get('/', (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  clients.add(res);
  log.debug({ clientCount: clients.size }, 'SSE client connected');

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    log.debug({ clientCount: clients.size }, 'SSE client disconnected');
  });
});

/**
 * Broadcast an event to all connected SSE clients
 */
export function broadcastEvent(eventType: string, data: unknown): void {
  const payload = JSON.stringify({ type: eventType, data });
  const message = `event: ${eventType}\ndata: ${payload}\n\n`;

  for (const client of clients) {
    try {
      client.write(message);
    } catch {
      clients.delete(client);
    }
  }
}

/**
 * Get count of connected clients
 */
export function getClientCount(): number {
  return clients.size;
}
