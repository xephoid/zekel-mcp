// Confidence-interval helpers for the balance harness (BALANCE-METRIC-DEFINITIONS
// §6.2: "Confidence intervals are mandatory, not decorative"). Every rate the
// harness reports — win rate, seat advantage, matchup cell, lift — is an estimate
// from a finite sample; these put a noise floor on it so a designer doesn't chase
// a 2pp wiggle that is sampling noise.
//
// Closed-form only (no bootstrap/resampling): a Wilson score interval for a single
// proportion, and the Newcombe method for the DIFFERENCE of two independent
// proportions (used for lift, which is win_rate_used − win_rate_unused). Newcombe's
// square-and-add of the two Wilson intervals is the recommended difference interval
// when a bootstrap is unavailable — it stays inside [-1, 1] and behaves well on the
// thin cells that matchup/strategy slices produce, which a naive Wald interval does
// not.

export interface Interval {
  low: number;
  high: number;
}

// z for a two-sided 95% interval. Exposed so callers can widen (e.g. 99%) if they
// want, but 95% is the harness default and what every caption claims.
export const Z_95 = 1.959963984540054;

// Wilson score interval for a binomial proportion k/n. Strongly preferred over the
// normal-approximation (Wald) interval at the small n and extreme p (0% / 100%
// win rates) that balance cells routinely hit — Wald produces impossible bounds
// outside [0,1] and a zero-width interval at p=0 or p=1, both of which lie.
// n = 0 → maximally uncertain [0, 1] (no evidence either way).
export function wilsonInterval(successes: number, n: number, z: number = Z_95): Interval {
  if (n <= 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

// Newcombe (1998) method 10 for the difference d = p1 − p2 of two INDEPENDENT
// proportions, built from their Wilson intervals (l1,u1) and (l2,u2):
//   lower = d − sqrt((p1−l1)² + (u2−p2)²)
//   upper = d + sqrt((u1−p1)² + (p2−l2)²)
// Independence holds here: the "used" and "available-but-unused" populations are
// disjoint sets of player-games. Result is clamped to [-1, 1].
export function newcombeDiffInterval(
  successes1: number,
  n1: number,
  successes2: number,
  n2: number,
  z: number = Z_95,
): Interval {
  if (n1 <= 0 || n2 <= 0) return { low: -1, high: 1 };
  const p1 = successes1 / n1;
  const p2 = successes2 / n2;
  const w1 = wilsonInterval(successes1, n1, z);
  const w2 = wilsonInterval(successes2, n2, z);
  const d = p1 - p2;
  const lower = d - Math.sqrt((p1 - w1.low) ** 2 + (w2.high - p2) ** 2);
  const upper = d + Math.sqrt((w1.high - p1) ** 2 + (p2 - w2.low) ** 2);
  return { low: Math.max(-1, lower), high: Math.min(1, upper) };
}

// Whether two intervals are disjoint (do not overlap). The §6.2 significance test
// for a diff/compare view: "a change between two builds is only real if the
// intervals separate."
export function intervalsSeparate(a: Interval, b: Interval): boolean {
  return a.high < b.low || b.high < a.low;
}

// Seeded PRNG (mulberry32) so the bootstrap below is deterministic — the same
// sample always yields the same interval, which keeps batch output reproducible.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sortedPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

// Bootstrap percentile CI for a statistic of a sample that has no closed-form
// interval — here the MEDIAN of a distribution (§5 game length / margin). Resamples
// the values with replacement `iterations` times, recomputes the statistic, and
// takes the empirical 2.5/97.5 percentiles. §6.2 calls for exactly this where a
// proportion's Wilson interval doesn't apply. Deterministic via a fixed seed.
export function bootstrapMedianCI(values: number[], iterations = 1000, seed = 0x5eed): Interval {
  const n = values.length;
  if (n === 0) return { low: 0, high: 0 };
  if (n === 1) return { low: values[0]!, high: values[0]! };
  const rng = mulberry32(seed);
  const medians: number[] = [];
  const buf = new Array<number>(n);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) buf[i] = values[Math.floor(rng() * n)]!;
    buf.sort((a, b) => a - b);
    medians.push(sortedPercentile(buf, 0.5));
  }
  medians.sort((a, b) => a - b);
  return { low: sortedPercentile(medians, 0.025), high: sortedPercentile(medians, 0.975) };
}

// Compact "±half-width" rendering of a symmetric-ish interval around a point
// estimate, in percentage points. Uses the larger of the two half-widths so the
// figure never understates the uncertainty. e.g. ci95Pct(0.52, {low:.46,high:.58})
// → "6.0".
export function halfWidthPct(point: number, ci: Interval): string {
  const half = Math.max(ci.high - point, point - ci.low) * 100;
  return half.toFixed(1);
}
