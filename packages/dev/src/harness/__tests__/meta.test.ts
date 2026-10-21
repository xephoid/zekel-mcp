import { describe, it, expect } from 'vitest';
import { computeMeta } from '../meta.js';

describe('computeMeta', () => {
  it('rock-paper-scissors: no dominant, uniform Nash, high cyclicity, a cycle', () => {
    // A>B>C>A, each 60%.
    const wr = [
      [0.5, 0.6, 0.4],
      [0.4, 0.5, 0.6],
      [0.6, 0.4, 0.5],
    ];
    const m = computeMeta(['A', 'B', 'C'], wr);
    expect(m.dominant).toBeNull();
    expect(m.viable.sort()).toEqual(['A', 'B', 'C']);
    expect(m.dead).toEqual([]);
    // Symmetric RPS → uniform equilibrium.
    for (const l of ['A', 'B', 'C']) expect(m.nash[l]).toBeCloseTo(1 / 3, 1);
    expect(m.cyclicity).toBeGreaterThan(0.9);
    expect(m.transitivity).toBeLessThan(0.1);
    expect(m.topCycle).not.toBeNull();
  });

  it('dominant strategy: Condorcet winner, pure Nash, ladder (transitive), no cycle', () => {
    // A beats B and C; B beats C. Strict ladder A > B > C.
    const wr = [
      [0.5, 0.6, 0.65],
      [0.4, 0.5, 0.6],
      [0.35, 0.4, 0.5],
    ];
    const m = computeMeta(['A', 'B', 'C'], wr);
    expect(m.dominant).toBe('A');
    expect(m.nash['A']).toBeGreaterThan(0.9); // equilibrium collapses to the dominant strategy
    expect(m.viable).toEqual(['A']);
    expect(m.transitivity).toBeGreaterThan(0.9);
    expect(m.cyclicity).toBeLessThan(0.1);
    expect(m.topCycle).toBeNull();
  });

  it('dead strategy: a loses-to-all faction is dropped from the viable set', () => {
    // A,B,C form RPS; D loses 40% to all three.
    const wr = [
      [0.5, 0.6, 0.4, 0.6],
      [0.4, 0.5, 0.6, 0.6],
      [0.6, 0.4, 0.5, 0.6],
      [0.4, 0.4, 0.4, 0.5],
    ];
    const m = computeMeta(['A', 'B', 'C', 'D'], wr);
    expect(m.dominant).toBeNull();
    expect(m.viable.sort()).toEqual(['A', 'B', 'C']);
    expect(m.dead).toEqual(['D']);
    expect(m.nash['D']).toBeLessThan(0.05);
  });

  it('all-even: no dominant, uniform Nash, no cycle', () => {
    const wr = [
      [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
    ];
    const m = computeMeta(['A', 'B', 'C'], wr);
    expect(m.dominant).toBeNull();
    expect(m.topCycle).toBeNull();
    for (const l of ['A', 'B', 'C']) expect(m.nash[l]).toBeCloseTo(1 / 3, 1);
  });

  it('detects a dominant strategy head-to-head even when draws keep every win rate < 50% (tie-robust)', () => {
    // A beats B and C head-to-head; high draw rates keep all win rates below 50%.
    // An absolute-50% check would wrongly say "no dominant strategy".
    const wr = [
      [0.5, 0.45, 0.48], // A vs B 45 (>40), vs C 48 (>42) → beats both
      [0.4, 0.5, 0.45], // B vs A 40, vs C 45 (>40)
      [0.42, 0.4, 0.5], // C vs A 42, vs B 40 → loses both
    ];
    const m = computeMeta(['A', 'B', 'C'], wr);
    expect(m.dominant).toBe('A');
    expect(m.nash['A']).toBeGreaterThan(0.9);
    expect(m.viable).toEqual(['A']);
    expect(m.dead).toEqual(['C']); // loses every matchup
  });

  it('handles a single strategy', () => {
    const m = computeMeta(['A'], [[0.5]]);
    expect(m.nash['A']).toBe(1);
    expect(m.viable).toEqual(['A']);
  });
});
