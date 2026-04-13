import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUsd, formatPercent, nowTimestamp, shortenAddress } from './helpers.js';

test('formatUsd: basic positive number', () => {
  assert.equal(formatUsd(1234.567), '$1,234.57');
});

test('formatPercent: positive has plus sign', () => {
  assert.equal(formatPercent(0.123), '+12.3%');
});

test('formatPercent: negative has minus sign', () => {
  assert.equal(formatPercent(-0.05), '-5.0%');
});

test('nowTimestamp: unix seconds, within 2s of Date.now', () => {
  const jsNow = Math.floor(Date.now() / 1000);
  const ts = nowTimestamp();
  assert.ok(Math.abs(ts - jsNow) <= 2, `ts ${ts} not near jsNow ${jsNow}`);
});

test('shortenAddress: long address collapsed', () => {
  assert.equal(shortenAddress('0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b'), '0x1a2b...9a0b');
});

test('shortenAddress: short returns as-is', () => {
  assert.equal(shortenAddress('0x123'), '0x123');
});
