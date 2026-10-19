// The made-up test game must itself play correctly, or every test built on it
// proves nothing. These check its own rules directly (no server).

import { describe, expect, it } from 'vitest';
import { GameError, type PlayerConfig, type SessionState } from '@zekel/game-kit';
import { luckyTicTacToe as game, SQUARES, type LuckyMove, type LuckyState } from './luckyTicTacToe.js';

type S = SessionState<LuckyState>;
const humanVsAi: PlayerConfig[] = [{ player_id: 'p1', kind: 'human', name: 'Ada' }, { player_id: 'p2', kind: 'ai' }];
const apply = (s: S, pid: string, move: LuckyMove) => game.applyMove(s, pid, move);

function throughSetup(players: PlayerConfig[], lucky: Record<string, string>): S {
  let s = game.createSession(players, { seed: 1 });
  s = apply(s, 'p1', { type: 'assign_setup_choices', selections: { p1: 'X', p2: 'O' } }).newState;
  for (const p of players) if (p.kind === 'human' && p.table !== 'digital') s = apply(s, p.player_id, { type: 'report_lucky_card', square: lucky[p.player_id]! }).newState;
  return s;
}

describe('Lucky Tic-Tac-Toe', () => {
  it('all-AI sessions skip setup: marks by seat order, cards dealt, play starts with X', () => {
    const s = game.createSession([{ player_id: 'a', kind: 'ai' }, { player_id: 'b', kind: 'ai' }], { seed: 3 });
    expect(s.gameState.phase).toBe('play');
    expect(s.gameState.marks).toEqual({ a: 'X', b: 'O' });
    expect(Object.keys(s.gameState.lucky).sort()).toEqual(['a', 'b']);
    expect(s.activePlayerId).toBe('a');
  });

  it('a human reports their card; the AI is dealt a different one; it stays secret', () => {
    const s = throughSetup(humanVsAi, { p1: 'b2' });
    expect(s.gameState.lucky.p1).toBe('B2');
    expect(s.gameState.lucky.p2).toBeDefined();
    expect(s.gameState.lucky.p2).not.toBe('B2');
    expect((game.getPublicView(s) as { lucky_squares: Record<string, string> }).lucky_squares).toEqual({ p1: 'hidden', p2: 'hidden' });
    expect((game.getPlayerView(s, 'p1') as { your_lucky_square: string }).your_lucky_square).toBe('B2');
  });

  it('a human on screen is dealt a card, revealed only to them', () => {
    let s = game.createSession([{ player_id: 'p1', kind: 'human', table: 'digital' }, { player_id: 'p2', kind: 'ai' }], { seed: 2 });
    s = apply(s, 'p1', { type: 'assign_setup_choices', selections: { p1: 'X', p2: 'O' } }).newState;
    const drawn = apply(s, 'p1', { type: 'draw_lucky_card' });
    expect(drawn.privateReveals).toEqual([{ player_id: 'p1', text: `Your lucky square is ${drawn.newState.gameState.lucky.p1}.` }]);
    expect(drawn.summary).not.toContain(drawn.newState.gameState.lucky.p1!);
  });

  it('three in a row wins', () => {
    let s = throughSetup(humanVsAi, { p1: 'C3' });
    for (const [pid, sq] of [['p1', 'A1'], ['p2', 'A2'], ['p1', 'B1'], ['p2', 'B2'], ['p1', 'C1']] as const) {
      s = apply(s, pid, { type: 'place', square: sq }).newState;
    }
    expect(game.isGameOver(s)).toMatchObject({ game_over: true, winners: ['p1'] });
  });

  it('a full board goes to the one player holding their own lucky square', () => {
    // X: A1 B1 C2 A3 B3 · O: C1 A2 B2 C3 — no line. p1 (X) holds A1; p2 (O) does not hold theirs.
    let s = throughSetup(humanVsAi, { p1: 'A1' });
    s.gameState.lucky.p2 = 'A3';
    for (const [pid, sq] of [['p1', 'A1'], ['p2', 'C1'], ['p1', 'B1'], ['p2', 'A2'], ['p1', 'C2'], ['p2', 'B2'], ['p1', 'A3'], ['p2', 'C3'], ['p1', 'B3']] as const) {
      s = apply(s, pid, { type: 'place', square: sq }).newState;
    }
    expect(game.isGameOver(s)).toMatchObject({ winners: ['p1'] });
    expect((game.getPublicView(s) as { lucky_squares: Record<string, string> }).lucky_squares).toEqual({ p1: 'A1', p2: 'A3' });
  });

  it('refuses a taken square, an out-of-turn move and a card already drawn', () => {
    const s = throughSetup(humanVsAi, { p1: 'A1' });
    const after = apply(s, 'p1', { type: 'place', square: 'B2' }).newState;
    expect(() => apply(after, 'p2', { type: 'place', square: 'B2' })).toThrow(GameError);
    expect(() => apply(after, 'p1', { type: 'place', square: 'C3' })).toThrow(/turn/);
    let two = game.createSession([{ player_id: 'p1', kind: 'human' }, { player_id: 'p2', kind: 'human' }], { seed: 1 });
    two = apply(two, 'p1', { type: 'assign_setup_choices', selections: { p1: 'X', p2: 'O' } }).newState;
    two = apply(two, 'p1', { type: 'report_lucky_card', square: 'A1' }).newState;
    expect(() => apply(two, 'p2', { type: 'report_lucky_card', square: 'A1' })).toThrow(/already drawn/);
  });

  it('the AI plays a whole game against itself without error, the same way every time', async () => {
    const play = async () => {
      let s = game.createSession([{ player_id: 'a', kind: 'ai' }, { player_id: 'b', kind: 'ai' }], { seed: 9 });
      const moves: string[] = [];
      while (!game.isGameOver(s)) {
        const { move } = await game.getAIMove(s, s.activePlayerId);
        moves.push((move as { square: string }).square);
        s = game.applyMove(s, s.activePlayerId, move).newState;
      }
      return moves;
    };
    const first = await play();
    expect(first.length).toBeGreaterThan(4);
    expect(first.every((sq) => (SQUARES as readonly string[]).includes(sq))).toBe(true);
    expect(await play()).toEqual(first);
  });
});
