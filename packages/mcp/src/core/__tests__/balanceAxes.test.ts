// A game's balance-axis declarations (Game.getBalanceAxes) must be well formed:
// a known kind, a recipe, and only real levers. An axis MAY have no levers —
// that marks it "manual / not auto-evaluable" (cosmetic, or a real axis a
// harness can't yet vary). Checked here on the made-up test game.

import { describe, it, expect } from 'vitest';
import type { BalanceAxis } from '@zekel/game-kit';
import { luckyTicTacToe } from '../../mcp/__tests__/luckyTicTacToe.js';

const KINDS = new Set(['identity', 'config', 'scenario', 'cosmetic']);
const LEVERS = new Set(['strategy', 'sweep', 'players', 'difficulty', 'scenario']);

export function assertWellFormed(axes: BalanceAxis[]): void {
  for (const a of axes) {
    expect(a.name).toBeTruthy();
    expect(KINDS.has(a.kind)).toBe(true);
    expect(typeof a.recipe).toBe('string');
    for (const l of a.levers) expect(LEVERS.has(l)).toBe(true);
  }
}

describe('getBalanceAxes declarations', () => {
  it('Lucky Tic-Tac-Toe declares its mark as a cosmetic axis with no lever', () => {
    const axes = luckyTicTacToe.getBalanceAxes!();
    assertWellFormed(axes);
    const mark = axes.find((a) => a.name === 'mark');
    expect(mark?.kind).toBe('cosmetic');
    expect(mark?.levers).toEqual([]);
  });
});
