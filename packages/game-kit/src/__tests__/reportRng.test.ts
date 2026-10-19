import { describe, expect, it } from 'vitest';
import { deriveReportSeed } from '../reportRng.js';

describe('deriveReportSeed', () => {
  it('is deterministic for the same base + salt', () => {
    expect(deriveReportSeed(12345, 'battle_roll')).toBe(deriveReportSeed(12345, 'battle_roll'));
  });

  it('varies with the salt', () => {
    expect(deriveReportSeed(12345, 'a')).not.toBe(deriveReportSeed(12345, 'b'));
  });

  it('varies with the base cursor', () => {
    expect(deriveReportSeed(1, 'x')).not.toBe(deriveReportSeed(2, 'x'));
  });

  it('never returns 0 (mulberry32-derived RNGs degenerate on a zero seed)', () => {
    // Hunt for a (base, salt) that folds to 0 before the guard; the guard must
    // replace it. We can at least assert the guard constant is used when the
    // FNV fold lands on 0 — exercise a spread of inputs and require all non-zero.
    for (let base = 0; base < 500; base++) {
      for (const salt of ['', 'a', 'trade', 'battle_roll', 'reveal:3']) {
        expect(deriveReportSeed(base, salt)).not.toBe(0);
      }
    }
  });

  it('returns a uint32', () => {
    const v = deriveReportSeed(0xffffffff, 'salt');
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(v)).toBe(true);
  });
});
