// apply_move can take a move_id (an entry from this player's current
// get_legal_moves) instead of a hand-built move object — so weak models never
// construct a move shape for an enumerable action. The desync harness caught a
// model unable to produce one game's `sell` move shape across many guesses; move_id is
// the structural fix. These lock resolveMoveArg's behaviour.

import { describe, expect, it } from 'vitest';
import { resolveMoveArg } from '../tools.js';
import { GameError } from '@zekel/game-kit';
import type { LegalMove, SessionState } from '@zekel/game-kit';

const LEGAL: LegalMove<unknown>[] = [
  { move_id: '0', description: 'Build Bakery', move: { type: 'build', card_id: 'L1', industry_type: 'bakery' } },
  { move_id: '1', description: 'Sell bread (at the market, with bonus)', move: { type: 'sell', card_id: 'L1', sales: [{ location: 'market', slot_index: 0, use_bonus: true }] } },
];

// Minimal stand-in for the Game surface resolveMoveArg touches.
const game = { getLegalMoves: () => LEGAL } as unknown as Parameters<typeof resolveMoveArg>[0];
const session = {} as SessionState<unknown>;

function err(fn: () => unknown): GameError {
  try {
    fn();
  } catch (e) {
    if (e instanceof GameError) return e;
    throw e;
  }
  throw new Error('expected a throw');
}

describe('resolveMoveArg', () => {
  it('expands a move_id to the full move from the current legal set', () => {
    expect(resolveMoveArg(game, session, 'p1', '1', undefined)).toEqual(LEGAL[1]!.move);
  });

  it('passes a full move object through when no move_id is given', () => {
    const move = { type: 'pass', card_id: 'L9' };
    expect(resolveMoveArg(game, session, 'p1', undefined, move)).toBe(move);
  });

  it('the full move wins when both are supplied (move_id skeleton may be empty)', () => {
    // Load-bearing: a report move passes move_id (skeleton) + the real values.
    const realMove = { type: 'report_draw', drawn_cards: ['bread', 'salt'] };
    expect(resolveMoveArg(game, session, 'p1', '1', realMove)).toBe(realMove);
  });

  it('falls back to move_id when the move object is empty', () => {
    expect(resolveMoveArg(game, session, 'p1', '1', {})).toEqual(LEGAL[1]!.move);
  });

  it('an unknown move_id fails as a recoverable INVALID_MOVE_SHAPE naming the cause', () => {
    const e = err(() => resolveMoveArg(game, session, 'p1', '99', undefined));
    expect(e.error_code).toBe('INVALID_MOVE_SHAPE');
    expect(e.message).toMatch(/move_id/);
  });

  it('neither move_id nor move fails as INVALID_MOVE_SHAPE', () => {
    const e = err(() => resolveMoveArg(game, session, 'p1', undefined, undefined));
    expect(e.error_code).toBe('INVALID_MOVE_SHAPE');
  });

  it('treats an empty-string move_id as absent (falls back to move)', () => {
    const move = { type: 'pass', card_id: 'L9' };
    expect(resolveMoveArg(game, session, 'p1', '', move)).toBe(move);
  });
});
