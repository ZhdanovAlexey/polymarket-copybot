import { createLogger } from './logger.js';

const log = createLogger('retry');

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;
const DEFAULT_TIMEOUT_MS = 15000; // 15s per request — prevents hanging on network stalls

export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  retryOpts?: RetryOptions,
): Promise<Response> {
  const maxRetries = retryOpts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = retryOpts?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = retryOpts?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const timeoutMs = retryOpts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Hard timeout: AbortSignal.timeout aborts the fetch if no response in timeoutMs.
      // Prevents tracker/poll loops from hanging indefinitely on silent network stalls.
      const signal = options?.signal ?? AbortSignal.timeout(timeoutMs);
      const response = await fetch(url, { ...options, signal });

      if (response.ok) {
        return response;
      }

      // Rate limited — respect Retry-After header
      if (response.status === 429) {
        if (attempt >= maxRetries) {
          return response;
        }
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter
          ? parseRetryAfter(retryAfter)
          : computeBackoff(attempt, baseDelayMs, maxDelayMs);
        log.warn({ attempt: attempt + 1, maxRetries, waitMs, url }, 'Rate limited (429), waiting before retry');
        await sleep(waitMs);
        continue;
      }

      // Server error — retry with exponential backoff
      if (response.status >= 500) {
        if (attempt >= maxRetries) {
          return response;
        }
        const waitMs = computeBackoff(attempt, baseDelayMs, maxDelayMs);
        log.warn(
          { attempt: attempt + 1, maxRetries, status: response.status, waitMs, url },
          'Server error, retrying with backoff',
        );
        await sleep(waitMs);
        continue;
      }

      // Client error (4xx except 429) — don't retry, return as-is
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries) {
        break;
      }
      const waitMs = computeBackoff(attempt, baseDelayMs, maxDelayMs);
      log.warn(
        { attempt: attempt + 1, maxRetries, waitMs, url, error: String(error) },
        'Network error, retrying with backoff',
      );
      await sleep(waitMs);
    }
  }

  throw lastError;
}

function computeBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

function parseRetryAfter(header: string): number {
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) {
    return seconds * 1000;
  }
  // Try parsing as HTTP date
  const date = new Date(header);
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }
  // Fallback: 1 second
  return 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
