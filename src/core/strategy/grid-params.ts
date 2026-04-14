import type { BacktestSimConfig, ConvictionParams } from '../../types.js';

// Grid axis definitions
const AXES = {
  topN: [5, 10, 20],
  leaderboardWindowDays: [14, 30, 60],
  f1Anchor: [20, 100, 500],
  f1Max: [3, 5],
  w2: [0, 0.3, 0.6],
  w3: [0, 0.5, 1.0],
  f4Boost: [1.0, 1.5, 2.0],
  maxTtrDays: [3, 7, 14, 30, Infinity],
} as const;

// Fixed params for all configs
const FIXED = {
  betBase: 2,
  maxPositions: 20,
  initialCapital: 500,
  slippagePct: 1,
  commissionPct: 0.1, // Polymarket CLOB: 0% fees, ~$0.01 gas on Polygon ≈ 0.1% on $10 bet
};

/**
 * Latin Hypercube Sampling: pick N points spread evenly across the grid space.
 * Each axis is divided into N equal strata; one random sample per stratum.
 */
export function generateLHS(n: number): BacktestSimConfig[] {
  const axisKeys = Object.keys(AXES) as Array<keyof typeof AXES>;
  // For each axis, create a shuffled permutation of N indices
  const permutations = axisKeys.map(() => shuffleRange(n));

  const configs: BacktestSimConfig[] = [];
  for (let i = 0; i < n; i++) {
    const picks: Record<string, number> = {};
    for (let a = 0; a < axisKeys.length; a++) {
      const key = axisKeys[a]!;
      const values = AXES[key];
      const stratum = permutations[a]![i]!;
      // Map stratum index → axis value
      const valueIdx = Math.floor((stratum / n) * values.length);
      picks[key] = values[Math.min(valueIdx, values.length - 1)]!;
    }
    configs.push(buildConfig(picks));
  }
  return configs;
}

/**
 * Generate fine-grained grid around a set of winner configs.
 * For each winner, enumerate ±1 step on each axis.
 */
export function generateFineGrid(winners: BacktestSimConfig[]): BacktestSimConfig[] {
  const seen = new Set<string>();
  const configs: BacktestSimConfig[] = [];

  for (const w of winners) {
    const baseValues = extractValues(w);
    const axisKeys = Object.keys(AXES) as Array<keyof typeof AXES>;

    // Generate all single-axis neighbors
    for (const axis of axisKeys) {
      const values = AXES[axis] as readonly number[];
      const currentIdx = values.indexOf(baseValues[axis]!);
      if (currentIdx === -1) continue;

      for (let delta = -1; delta <= 1; delta++) {
        const newIdx = currentIdx + delta;
        if (newIdx < 0 || newIdx >= values.length) continue;
        const picks = { ...baseValues, [axis]: values[newIdx]! };
        const key = JSON.stringify(picks);
        if (!seen.has(key)) {
          seen.add(key);
          configs.push(buildConfig(picks));
        }
      }
    }
  }
  return configs;
}

function buildConfig(picks: Record<string, number>): BacktestSimConfig {
  return {
    conviction: {
      betBase: FIXED.betBase,
      f1Anchor: picks.f1Anchor ?? 100,
      f1Max: picks.f1Max ?? 5,
      w2: picks.w2 ?? 0,
      w3: picks.w3 ?? 0,
      f4Boost: picks.f4Boost ?? 1.0,
    },
    topN: picks.topN ?? 10,
    leaderboardWindowDays: picks.leaderboardWindowDays ?? 30,
    maxTtrDays: picks.maxTtrDays ?? Infinity,
    maxPositions: FIXED.maxPositions,
    initialCapital: FIXED.initialCapital,
    slippagePct: FIXED.slippagePct,
    commissionPct: FIXED.commissionPct,
  };
}

function extractValues(c: BacktestSimConfig): Record<string, number> {
  return {
    topN: c.topN,
    leaderboardWindowDays: c.leaderboardWindowDays,
    f1Anchor: c.conviction.f1Anchor,
    f1Max: c.conviction.f1Max,
    w2: c.conviction.w2,
    w3: c.conviction.w3,
    f4Boost: c.conviction.f4Boost,
    maxTtrDays: c.maxTtrDays,
  };
}

function shuffleRange(n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}
