// Shared game-log helpers + the auto-delta path.
//
// Locks the framework-level log infrastructure: diffStats / diffScoreboardRow /
// render helpers, and an end-to-end check that a game implementing
// getScoreboard yields "spent/gained" deltas across a real move — the cheap
// reporting path any game gets without authoring its own rich log.

import { describe, expect, it } from 'vitest';
import { diffScoreboardRow, diffStats, pushLogEntry, renderLogEntries, renderLogLine } from '@zekel/game-kit';
import type { GameLogEntry, PlayerConfig } from '@zekel/game-kit';
import type { AnyGame } from '../registry.js';
import { luckyTicTacToe } from '../../mcp/__tests__/luckyTicTacToe.js';

/** Drive an all-AI session via getAIMove and report whether any move produced a
 *  non-empty scoreboard delta for the acting player — the exact computation the
 *  framework's appendMoveLogWithDeltas performs. */
async function sawAutoDelta(game: AnyGame, players: PlayerConfig[], maxMoves: number): Promise<boolean> {
  let session = game.createSession(players);
  for (let i = 0; i < maxMoves && !game.isGameOver(session); i++) {
    const actor = session.activePlayerId;
    const before = game.getScoreboard!(session);
    const pick = await game.getAIMove(session, actor);
    const next = game.applyMove(session, actor, pick.move).newState;
    const after = game.getScoreboard!(next);
    if (diffScoreboardRow(before, after, actor)) return true;
    session = next;
  }
  return false;
}

const twoAI: PlayerConfig[] = [
  { player_id: 'p1', kind: 'ai' },
  { player_id: 'p2', kind: 'ai' },
];

describe('diffStats', () => {
  it('splits a before→after change into spent (down) and gained (up)', () => {
    const { spent, gained } = diffStats({ credits: 7, prestige: 0 }, { credits: 0, prestige: 2 });
    expect(spent).toEqual([{ resource: 'credits', amount: 7 }]);
    expect(gained).toEqual([{ resource: 'prestige', amount: 2 }]);
  });

  it('honours the exclude list', () => {
    const { spent } = diffStats({ actionCube: 3, credits: 5 }, { actionCube: 2, credits: 5 }, ['actionCube']);
    expect(spent).toEqual([]);
  });
});

describe('diffScoreboardRow', () => {
  const before = { p1: { stamina: 5, spirit: 0 }, p2: { stamina: 5, spirit: 0 } };
  const after = { p1: { stamina: 3, spirit: 2 }, p2: { stamina: 5, spirit: 0 } };

  it('returns the acting player row delta', () => {
    expect(diffScoreboardRow(before, after, 'p1')).toEqual({
      spent: [{ resource: 'stamina', amount: 2 }],
      gained: [{ resource: 'spirit', amount: 2 }],
    });
  });

  it('returns null when nothing changed for that player', () => {
    expect(diffScoreboardRow(before, after, 'p2')).toBeNull();
    expect(diffScoreboardRow(undefined, after, 'p1')).toBeNull();
  });
});

describe('render helpers', () => {
  it('renders a line with deltas and joins entries', () => {
    const e: GameLogEntry = {
      seq: 1,
      turn: 1,
      actor: 'p1',
      category: 'action',
      summary: 'P1 traded.',
      spent: [{ resource: 'credits', amount: 7 }],
      gained: [{ resource: 'prestige', amount: 2 }],
    };
    expect(renderLogLine(e)).toBe('P1 traded. (spent 7 credits) (gained 2 prestige)');
    expect(renderLogEntries([e, { ...e, seq: 2, summary: 'P1 passed.', spent: undefined, gained: undefined }])).toBe(
      'P1 traded. (spent 7 credits) (gained 2 prestige)\nP1 passed.',
    );
  });

  it('pushLogEntry stamps a 1-based contiguous seq', () => {
    const log: GameLogEntry[] = [];
    pushLogEntry(log, { turn: 1, actor: null, category: 'phase', summary: 'a' });
    pushLogEntry(log, { turn: 1, actor: null, category: 'phase', summary: 'b' });
    expect(log.map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe('the auto-delta path on a real game', () => {
  it('getScoreboard returns numeric public counters per player', () => {
    const board = luckyTicTacToe.getScoreboard!(luckyTicTacToe.createSession(twoAI, { seed: 1 }));
    expect(Object.keys(board).sort()).toEqual(['p1', 'p2']);
    expect(typeof board.p1!.marks_placed).toBe('number');
  });

  it('produces a non-empty delta across real moves', async () => {
    expect(await sawAutoDelta(luckyTicTacToe as unknown as AnyGame, twoAI, 9)).toBe(true);
  });
});
