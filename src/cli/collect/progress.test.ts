import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Progress } from './progress.js';

test('Progress: tick increments completed count', () => {
  const p = new Progress('phase1', 10);
  p.tick();
  p.tick();
  assert.equal(p.snapshot().completed, 2);
  assert.equal(p.snapshot().total, 10);
});

test('Progress: tick(n) increments by n', () => {
  const p = new Progress('phase1', 100);
  p.tick(25);
  assert.equal(p.snapshot().completed, 25);
});

test('Progress: percent is 0..100', () => {
  const p = new Progress('phase1', 4);
  p.tick(); p.tick();
  assert.equal(p.snapshot().percent, 50);
});

test('Progress: percent is 0 when total=0 (guards divide-by-zero)', () => {
  const p = new Progress('phase1', 0);
  assert.equal(p.snapshot().percent, 0);
});
