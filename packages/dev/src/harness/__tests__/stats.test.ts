import { describe, it, expect } from 'vitest';
import {
  wilsonInterval,
  newcombeDiffInterval,
  bootstrapMedianCI,
  intervalsSeparate,
  halfWidthPct,
  Z_95,
} from '../stats.js';

describe('wilsonInterval', () => {
  it('brackets the point estimate and stays inside [0,1]', () => {
    const ci = wilsonInterval(50, 100);
    expect(ci.low).toBeGreaterThan(0);
    expect(ci.high).toBeLessThan(1);
    expect(ci.low).toBeLessThan(0.5);
    expect(ci.high).toBeGreaterThan(0.5);
  });

  it('matches the known Wilson value for 50/100 at 95%', () => {
    // Textbook value: 0.5 with n=100 → ~[0.404, 0.596].
    const ci = wilsonInterval(50, 100, Z_95);
    expect(ci.low).toBeCloseTo(0.4038, 3);
    expect(ci.high).toBeCloseTo(0.5962, 3);
  });

  it('does NOT collapse to a zero-width interval at p=0 or p=1 (the Wald failure)', () => {
    const allWins = wilsonInterval(20, 20);
    expect(allWins.high).toBe(1); // clamped
    expect(allWins.low).toBeLessThan(1); // but lower bound is < 1 — real uncertainty
    expect(allWins.low).toBeGreaterThan(0.8);
    const noWins = wilsonInterval(0, 20);
    expect(noWins.low).toBe(0);
    expect(noWins.high).toBeGreaterThan(0); // > 0 — not a fake-certain 0
  });

  it('is wider for small n than large n', () => {
    const small = wilsonInterval(5, 10);
    const large = wilsonInterval(500, 1000);
    expect(small.high - small.low).toBeGreaterThan(large.high - large.low);
  });

  it('returns maximal uncertainty for n=0', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe('newcombeDiffInterval', () => {
  it('excludes 0 when the two proportions are clearly different', () => {
    // 80/100 vs 30/100 — a large, well-sampled gap.
    const ci = newcombeDiffInterval(80, 100, 30, 100);
    expect(ci.low).toBeGreaterThan(0); // whole interval positive → significant
    expect(ci.high).toBeLessThan(1);
  });

  it('includes 0 when the proportions are equal', () => {
    const ci = newcombeDiffInterval(50, 100, 50, 100);
    expect(ci.low).toBeLessThan(0);
    expect(ci.high).toBeGreaterThan(0);
  });

  it('includes 0 on a tiny sample with a modest raw gap', () => {
    // 2/3 vs 1/3 — raw lift +33% but only 3 games each side: noise, includes 0.
    const ci = newcombeDiffInterval(2, 3, 1, 3);
    expect(ci.low).toBeLessThan(0);
    expect(ci.high).toBeGreaterThan(0);
  });

  it('narrows enough to exclude 0 once the same gap is well-sampled', () => {
    // The SAME ~20pp gap (60/100 vs 40/100) IS significant at n=100 each.
    const ci = newcombeDiffInterval(60, 100, 40, 100);
    expect(ci.low).toBeGreaterThan(0);
  });

  it('stays within [-1, 1]', () => {
    const ci = newcombeDiffInterval(20, 20, 0, 20);
    expect(ci.low).toBeGreaterThanOrEqual(-1);
    expect(ci.high).toBeLessThanOrEqual(1);
  });
});

describe('bootstrapMedianCI', () => {
  it('brackets the median and is deterministic for a fixed sample', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const a = bootstrapMedianCI(values);
    const b = bootstrapMedianCI(values);
    expect(a).toEqual(b); // deterministic (seeded)
    expect(a.low).toBeLessThanOrEqual(6); // median is 6
    expect(a.high).toBeGreaterThanOrEqual(6);
  });

  it('narrows as the sample grows around the same center', () => {
    const small = Array.from({ length: 11 }, (_, i) => i); // 0..10
    const large = Array.from({ length: 1001 }, (_, i) => (i % 11)); // same support, 100x data
    const wSmall = bootstrapMedianCI(small);
    const wLarge = bootstrapMedianCI(large);
    expect(wLarge.high - wLarge.low).toBeLessThan(wSmall.high - wSmall.low);
  });

  it('collapses to the value for degenerate samples', () => {
    expect(bootstrapMedianCI([])).toEqual({ low: 0, high: 0 });
    expect(bootstrapMedianCI([7])).toEqual({ low: 7, high: 7 });
  });
});

describe('intervalsSeparate', () => {
  it('is true for disjoint intervals and false for overlapping', () => {
    expect(intervalsSeparate({ low: 0.1, high: 0.2 }, { low: 0.3, high: 0.4 })).toBe(true);
    expect(intervalsSeparate({ low: 0.1, high: 0.35 }, { low: 0.3, high: 0.4 })).toBe(false);
  });
});

describe('halfWidthPct', () => {
  it('reports the larger half-width in percentage points', () => {
    expect(halfWidthPct(0.5, { low: 0.44, high: 0.56 })).toBe('6.0');
    // Asymmetric: takes the larger side.
    expect(halfWidthPct(0.9, { low: 0.8, high: 0.95 })).toBe('10.0');
  });
});
