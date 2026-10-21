import { describe, it, expect } from 'vitest';
import { segmentTurns, toPlayerGames, analyzeBatch } from '../analysis.js';
import { markDevHooksLoaded } from '../devHooks.js';
import type { GameRecord, MoveRecord } from '../runner.js';

// No game here has dev hooks: every test sees the generic analysis.
markDevHooksLoaded();

function mv(player_id: string, move: unknown): MoveRecord {
  return { turn: 0, player_id, move, narration: '', summary: '' };
}

function game(over: Partial<GameRecord> & { winners: string[]; moves: MoveRecord[] }): GameRecord {
  return {
    game_id: 'fractured-fist',
    seed: over.seed ?? 1,
    players: over.players ?? [
      { player_id: 'ai1', kind: 'ai', difficulty: 'medium' },
      { player_id: 'ai2', kind: 'ai', difficulty: 'medium' },
    ],
    options: over.options,
    moves: over.moves,
    result: { winners: over.winners, scores: {}, summary: '' },
    final_views: {},
    error: over.error,
  };
}

describe('segmentTurns', () => {
  it('splits the move stream at each end_turn and flags dead (empty) turns', () => {
    const g = game({
      winners: ['ai1'],
      moves: [
        // ai1: an active turn — plays a card then ends.
        mv('ai1', { type: 'play_card', card_id: 'attack' }),
        mv('ai1', { type: 'advance_phase' }),
        mv('ai1', { type: 'end_turn' }),
        // ai2: a dead turn — only ends (no play, no buy).
        mv('ai2', { type: 'advance_phase' }),
        mv('ai2', { type: 'end_turn' }),
      ],
    });
    const turns = segmentTurns(g);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ player_id: 'ai1', seat_index: 0, played_count: 1, is_dead: false });
    expect(turns[1]).toMatchObject({ player_id: 'ai2', seat_index: 1, played_count: 0, is_dead: true });
  });

  it('counts a buy as a non-dead turn even with no play', () => {
    const g = game({
      winners: ['ai1'],
      moves: [
        mv('ai1', { type: 'buy_card', card_id: 'momentum' }),
        mv('ai1', { type: 'end_turn' }),
      ],
    });
    const turns = segmentTurns(g);
    expect(turns[0]!.is_dead).toBe(false);
    expect(turns[0]!.bought_count).toBe(1);
  });
});

describe('toPlayerGames availability', () => {
  it('marks loadout cards + any card seen in moves as available', () => {
    const g = game({
      winners: ['ai1'],
      options: { loadout: ['attack', 'grand_finale'] },
      moves: [
        mv('ai1', { type: 'play_card', card_id: 'focus' }),
        mv('ai1', { type: 'end_turn' }),
        mv('ai2', { type: 'end_turn' }),
      ],
    });
    const [pg] = toPlayerGames(g);
    expect(pg!.availableCards.has('attack')).toBe(true); // from loadout
    expect(pg!.availableCards.has('grand_finale')).toBe(true); // from loadout
    expect(pg!.availableCards.has('focus')).toBe(true); // seen in a move
    expect(pg!.availableCards.has('block')).toBe(false); // neither
  });

  it('drops errored games (no trustworthy outcome)', () => {
    const g = game({ winners: [], moves: [], error: { code: 'X', message: 'y' } });
    expect(toPlayerGames(g)).toHaveLength(0);
  });
});

describe('analyzeBatch', () => {
  it('computes seat win rate, tie rate, dead-turn rate, and feature lift', () => {
    // Two games. In both, the player who buys grand_finale wins; the other
    // never buys it but it was available. Seat 0 wins both.
    const mkGame = (seed: number): GameRecord =>
      game({
        seed,
        winners: ['ai1'],
        options: { loadout: ['grand_finale', 'attack'] },
        players: [
          { player_id: 'ai1', kind: 'ai', difficulty: 'medium' },
          { player_id: 'ai2', kind: 'ai', difficulty: 'easy' },
        ],
        moves: [
          mv('ai1', { type: 'buy_card', card_id: 'grand_finale' }),
          mv('ai1', { type: 'end_turn' }),
          mv('ai2', { type: 'end_turn' }), // dead turn
        ],
      });
    const a = analyzeBatch([mkGame(1), mkGame(2)]);

    expect(a.games_scored).toBe(2);
    expect(a.tie_rate).toBe(0);
    // Seat 0 won both, seat 1 won neither.
    expect(a.seat_outcomes.find((s) => s.seat_index === 0)!.win_rate).toBe(1);
    expect(a.seat_outcomes.find((s) => s.seat_index === 1)!.win_rate).toBe(0);
    // Half of all turns are dead (ai2's empty turn each game).
    expect(a.dead_turn_rate).toBeCloseTo(0.5, 5);
    expect(a.dead_turn_rate_by_difficulty['easy']).toBe(1); // ai2 always dead
    expect(a.dead_turn_rate_by_difficulty['medium']).toBe(0); // ai1 never dead

    // buy:grand_finale: used by the winner, available-but-unused for the loser.
    const lift = a.feature_lift.find((f) => f.feature === 'buy:grand_finale')!;
    expect(lift.n_available).toBe(4); // 2 players * 2 games
    expect(lift.n_used).toBe(2); // only ai1, both games
    expect(lift.win_rate_used).toBe(1);
    expect(lift.win_rate_not_used).toBe(0);
    expect(lift.lift).toBe(1);
  });

  it('attaches a Wilson CI to seat win rate and a Newcombe CI to lift', () => {
    const a = analyzeBatch([
      game({
        seed: 1,
        winners: ['ai1'],
        options: { loadout: ['grand_finale'] },
        moves: [
          mv('ai1', { type: 'buy_card', card_id: 'grand_finale' }),
          mv('ai1', { type: 'end_turn' }),
          mv('ai2', { type: 'end_turn' }),
        ],
      }),
    ]);
    const seat0 = a.seat_outcomes.find((s) => s.seat_index === 0)!;
    // 1/1 wins → Wilson lower bound < 1 (real uncertainty), high clamped to 1.
    expect(seat0.win_rate_ci.high).toBe(1);
    expect(seat0.win_rate_ci.low).toBeLessThan(1);
    const lift = a.feature_lift.find((f) => f.feature === 'buy:grand_finale')!;
    expect(lift.lift_ci.low).toBeLessThanOrEqual(lift.lift);
    expect(lift.lift_ci.high).toBeGreaterThanOrEqual(lift.lift);
    // Single game: lift CI must include 0 (not significant).
    expect(lift.lift_ci.low).toBeLessThan(0);
  });

  it('builds a skill matchup matrix from the per-seat difficulty (Run B)', () => {
    // 4 games, easy vs hard, hard wins 3 of 4. Seats rotate.
    const mk = (seed: number, winner: string, easyFirst: boolean): GameRecord =>
      game({
        seed,
        winners: [winner],
        players: easyFirst
          ? [
              { player_id: 'ai1', kind: 'ai', difficulty: 'easy' },
              { player_id: 'ai2', kind: 'ai', difficulty: 'hard' },
            ]
          : [
              { player_id: 'ai1', kind: 'ai', difficulty: 'hard' },
              { player_id: 'ai2', kind: 'ai', difficulty: 'easy' },
            ],
        moves: [mv('ai1', { type: 'end_turn' }), mv('ai2', { type: 'end_turn' })],
      });
    const a = analyzeBatch([
      mk(1, 'ai2', true), // hard wins
      mk(2, 'ai2', true), // hard wins
      mk(3, 'ai1', false), // hard wins
      mk(4, 'ai1', true), // easy wins
    ]);
    const skill = a.matchups.find((m) => m.dimension === 'difficulty')!;
    expect(skill.categories).toEqual(['easy', 'hard']);
    // hard vs easy: 3 wins / 4 games.
    expect(skill.cells['hard']!['easy']!.games).toBe(4);
    expect(skill.cells['hard']!['easy']!.win_rate).toBeCloseTo(0.75, 5);
    // easy vs hard: the complement, 1/4.
    expect(skill.cells['easy']!['hard']!.win_rate).toBeCloseTo(0.25, 5);
  });

  it('emits no matchup matrix for a symmetric single-difficulty batch', () => {
    const a = analyzeBatch([
      game({ winners: ['ai1'], moves: [mv('ai1', { type: 'end_turn' }), mv('ai2', { type: 'end_turn' })] }),
    ]);
    // Only one difficulty present → no dimension has ≥2 categories.
    expect(a.matchups).toEqual([]);
  });

  it('summarizes the game-length distribution (quartiles + histogram), not just the mean', () => {
    // Three games of clearly different lengths so the distribution has spread.
    const short = game({ seed: 1, winners: ['ai1'], moves: [mv('ai1', { type: 'end_turn' }), mv('ai2', { type: 'end_turn' })] });
    const mid = game({
      seed: 2,
      winners: ['ai1'],
      moves: [
        mv('ai1', { type: 'play_card', card_id: 'attack' }),
        mv('ai1', { type: 'end_turn' }),
        mv('ai2', { type: 'end_turn' }),
        mv('ai1', { type: 'end_turn' }),
      ],
    });
    const long = game({
      seed: 3,
      winners: ['ai1'],
      moves: Array.from({ length: 8 }, (_, i) => mv(i % 2 === 0 ? 'ai1' : 'ai2', { type: 'end_turn' })),
    });
    const a = analyzeBatch([short, mid, long]);
    expect(a.game_length.n).toBe(3);
    expect(a.game_length.min).toBe(2); // the short game = 2 player-turns
    expect(a.game_length.max).toBe(8); // the long game = 8 player-turns
    expect(a.game_length.median).toBe(3); // the mid game = 3 player-turns (play+end, end, end)
    // The histogram covers every game.
    expect(a.game_length.histogram.reduce((s, b) => s + b.count, 0)).toBe(3);
  });

  it('computes margin-of-victory shares (nail-biter vs rout) from final scores', () => {
    const withScores = (seed: number, winnerScore: number, loserScore: number): GameRecord => ({
      ...game({ seed, winners: ['ai1'], moves: [mv('ai1', { type: 'end_turn' }), mv('ai2', { type: 'end_turn' })] }),
      result: { winners: ['ai1'], scores: { ai1: winnerScore, ai2: loserScore }, summary: '' },
    });
    // One blowout (10 vs 1 → normalized 0.9 ≥ 0.5 rout) and one squeaker (10 vs 9 → 0.1 ≤ 0.1 nail-biter).
    const a = analyzeBatch([withScores(1, 10, 1), withScores(2, 10, 9)]);
    expect(a.margin.distribution.n).toBe(2);
    expect(a.margin.distribution.min).toBe(1); // the 10-9 gap
    expect(a.margin.distribution.max).toBe(9); // the 10-1 gap
    expect(a.margin.rout_share).toBeCloseTo(0.5, 5); // 1 of 2 is a rout
    expect(a.margin.nail_biter_share).toBeCloseTo(0.5, 5); // 1 of 2 is a nail-biter
  });

  it('excludes stalemate (timeout) games from the margin distribution', () => {
    const decisive: GameRecord = {
      ...game({ seed: 1, winners: ['ai1'], moves: [mv('ai1', { type: 'end_turn' })] }),
      result: { winners: ['ai1'], scores: { ai1: 10, ai2: 2 }, summary: '' },
    };
    const stale: GameRecord = {
      ...game({ seed: 2, winners: [], moves: [mv('ai1', { type: 'end_turn' })] }),
      result: { winners: [], scores: { ai1: 0, ai2: 0 }, summary: '' },
    };
    stale.timeout = true;
    const a = analyzeBatch([decisive, stale]);
    // Only the decisive game contributes to the margin distribution.
    expect(a.margin.distribution.n).toBe(1);
    expect(a.margin.distribution.max).toBe(8);
  });

  it('respects custom nail-biter / rout thresholds', () => {
    const g: GameRecord = {
      ...game({ seed: 1, winners: ['ai1'], moves: [mv('ai1', { type: 'end_turn' })] }),
      result: { winners: ['ai1'], scores: { ai1: 10, ai2: 7 }, summary: '' }, // normalized margin 0.3
    };
    // Default: 0.3 is neither nail-biter (≤0.1) nor rout (≥0.5).
    expect(analyzeBatch([g]).margin.rout_share).toBe(0);
    // With routMin lowered to 0.25, the same game is now a rout.
    expect(analyzeBatch([g], { routMin: 0.25 }).margin.rout_share).toBe(1);
  });

  it('omits §4 temporal when there is no score trace', () => {
    const g: GameRecord = {
      game_id: 'dragonwood',
      seed: 1,
      players: [
        { player_id: 'p0', kind: 'ai', difficulty: 'medium' },
        { player_id: 'p1', kind: 'ai', difficulty: 'medium' },
      ],
      moves: [],
      result: { winners: ['p0'], scores: { p0: 5, p1: 3 }, summary: '' },
      final_views: {},
    };
    expect(analyzeBatch([g]).temporal).toBeUndefined();
  });

  it('computes §3.3 acquire-to-play per bought card', () => {
    // grand_finale: bought 2×, played 1× (a2p 0.5 — half the buys went unplayed).
    // momentum: bought 1×, played 3× (a2p 3 — reused).
    const g = (seed: number): GameRecord =>
      game({
        seed,
        winners: ['ai1'],
        moves: [
          mv('ai1', { type: 'buy_card', card_id: 'grand_finale' }),
          mv('ai1', { type: 'buy_card', card_id: 'grand_finale' }),
          mv('ai1', { type: 'play_card', card_id: 'grand_finale' }),
          mv('ai1', { type: 'buy_card', card_id: 'momentum' }),
          mv('ai1', { type: 'play_card', card_id: 'momentum' }),
          mv('ai1', { type: 'play_card', card_id: 'momentum' }),
          mv('ai1', { type: 'play_card', card_id: 'momentum' }),
          mv('ai1', { type: 'end_turn' }),
        ],
      });
    const a = analyzeBatch([g(1)]);
    const gf = a.acquire_to_play.find((x) => x.card === 'grand_finale')!;
    expect(gf).toMatchObject({ acquired: 2, played: 1, a2p: 0.5 });
    const mo = a.acquire_to_play.find((x) => x.card === 'momentum')!;
    expect(mo).toMatchObject({ acquired: 1, played: 3, a2p: 3 });
    // Sorted lowest-a2p first (the dead-purchase end).
    expect(a.acquire_to_play[0]!.card).toBe('grand_finale');
  });

  it('attaches a bootstrap median CI to distributions', () => {
    const mk = (seed: number, turns: number): GameRecord =>
      game({ seed, winners: ['ai1'], moves: Array.from({ length: turns }, (_, i) => mv(i % 2 === 0 ? 'ai1' : 'ai2', { type: 'end_turn' })) });
    const a = analyzeBatch([mk(1, 2), mk(2, 4), mk(3, 6), mk(4, 8)]);
    expect(a.game_length.median_ci.low).toBeLessThanOrEqual(a.game_length.median);
    expect(a.game_length.median_ci.high).toBeGreaterThanOrEqual(a.game_length.median);
  });

  it('builds a strategy matchup matrix from per-seat strategy tags (§0)', () => {
    // aggro (ai1) vs control (ai2); control wins 2 of 3.
    const mk = (seed: number, winner: string): GameRecord => ({
      ...game({ seed, winners: [winner], moves: [mv('ai1', { type: 'end_turn' }), mv('ai2', { type: 'end_turn' })] }),
      players: [
        { player_id: 'ai1', kind: 'ai', difficulty: 'medium', strategy: 'aggro' },
        { player_id: 'ai2', kind: 'ai', difficulty: 'medium', strategy: 'control' },
      ],
    });
    const a = analyzeBatch([mk(1, 'ai2'), mk(2, 'ai2'), mk(3, 'ai1')]);
    const strat = a.matchups.find((m) => m.dimension === 'strategy')!;
    expect(strat).toBeDefined();
    expect(strat.categories).toEqual(['aggro', 'control']);
    expect(strat.cells['control']!['aggro']!.win_rate).toBeCloseTo(2 / 3, 5);
    expect(strat.cells['aggro']!['control']!.win_rate).toBeCloseTo(1 / 3, 5);
    // And the strategy also appears as a lift feature (its win rate vs the field).
    const liftKeys = a.feature_lift.map((f) => f.feature);
    expect(liftKeys).toContain('strategy:aggro');
    expect(liftKeys).toContain('strategy:control');
  });

  it('counts round-cap timeouts as ties and as a stalemate rate', () => {
    const normal = game({ winners: ['ai1'], moves: [mv('ai1', { type: 'end_turn' }), mv('ai2', { type: 'end_turn' })] });
    const stale = game({ winners: [], moves: [mv('ai1', { type: 'end_turn' }), mv('ai2', { type: 'end_turn' })] });
    stale.timeout = true;
    const a = analyzeBatch([normal, stale]);
    expect(a.tie_rate).toBeCloseTo(0.5, 5); // the stalemate is a tie
    expect(a.stalemate_rate).toBeCloseTo(0.5, 5); // ...and specifically a stalemate
  });
});

describe('computePace (§5.1, via analyzeBatch)', () => {
  // 12 fast games (2 player-turns) won with "rush"; 28 long games (20
  // player-turns) where both sides lean on "staller". Fast threshold lands at
  // 2 turns, long at 20, so the groups are exact.
  function fastGame(seed: number): GameRecord {
    return game({
      seed,
      winners: ['ai1'],
      moves: [
        mv('ai1', { type: 'play_card', card_id: 'rush' }),
        mv('ai1', { type: 'end_turn' }),
        mv('ai2', { type: 'play_card', card_id: 'attack' }),
        mv('ai2', { type: 'end_turn' }),
      ],
    });
  }
  function longGame(seed: number): GameRecord {
    const moves: MoveRecord[] = [];
    for (let t = 0; t < 10; t++) {
      moves.push(mv('ai1', { type: 'play_card', card_id: 'staller' }), mv('ai1', { type: 'end_turn' }));
      moves.push(mv('ai2', { type: 'play_card', card_id: 'staller' }), mv('ai2', { type: 'end_turn' }));
    }
    return game({ seed, winners: ['ai2'], moves });
  }
  const records = [
    ...Array.from({ length: 12 }, (_, i) => fastGame(i + 1)),
    ...Array.from({ length: 28 }, (_, i) => longGame(i + 100)),
  ];
  const a = analyzeBatch(records);

  it('splits fast/long at the observed quartiles', () => {
    expect(a.pace.fast_max_turns).toBe(2);
    expect(a.pace.n_fast).toBe(12);
    expect(a.pace.long_min_turns).toBe(20);
    expect(a.pace.n_long).toBe(28);
  });

  it('flags the fast-win card as a fast finisher', () => {
    const rush = a.pace.fast_finishers.find((f) => f.feature === 'play:rush');
    expect(rush).toBeDefined();
    expect(rush!.rate_group).toBe(1);
    expect(rush!.rate_rest).toBe(0);
    expect(rush!.diff_ci.low).toBeGreaterThan(0);
  });

  it('flags the long-game card as a drag suspect', () => {
    const staller = a.pace.drag_features.find((f) => f.feature === 'play:staller');
    expect(staller).toBeDefined();
    expect(staller!.rate_group).toBe(1);
    expect(staller!.diff_ci.low).toBeGreaterThan(0);
  });

  it('does not flag features common to both groups', () => {
    expect(a.pace.fast_finishers.find((f) => f.feature === 'action:end_turn')).toBeUndefined();
    expect(a.pace.drag_features.find((f) => f.feature === 'action:end_turn')).toBeUndefined();
  });
});

describe('computeCombos (§3.5, via analyzeBatch)', () => {
  // alpha+beta together always win; either alone always loses; "neither"
  // wins 40/70. The pair's interaction contrast is strongly positive.
  const loadout = ['alpha', 'beta'];
  function comboGame(seed: number, ai1Cards: string[], winner: string): GameRecord {
    return game({
      seed,
      winners: [winner],
      options: { loadout },
      moves: [
        ...ai1Cards.map((c) => mv('ai1', { type: 'play_card', card_id: c })),
        mv('ai1', { type: 'end_turn' }),
        mv('ai2', { type: 'end_turn' }),
      ],
    });
  }
  const records = [
    ...Array.from({ length: 30 }, (_, i) => comboGame(i + 1, ['alpha', 'beta'], 'ai1')),
    ...Array.from({ length: 20 }, (_, i) => comboGame(i + 200, ['alpha'], 'ai2')),
    ...Array.from({ length: 20 }, (_, i) => comboGame(i + 400, ['beta'], 'ai2')),
  ];
  const a = analyzeBatch(records);

  it('finds the super-additive pair with correct cell counts', () => {
    const combo = a.combos.find(
      (c) =>
        (c.feature_a === 'play:alpha' && c.feature_b === 'play:beta') ||
        (c.feature_a === 'play:beta' && c.feature_b === 'play:alpha'),
    );
    expect(combo).toBeDefined();
    expect(combo!.n_both).toBe(30);
    expect(combo!.wr_both).toBe(1);
    expect(combo!.wr_a_only).toBe(0);
    expect(combo!.wr_b_only).toBe(0);
    expect(combo!.interaction).toBeGreaterThan(0);
    expect(combo!.interaction_ci.low).toBeGreaterThan(0);
  });

  it('never pairs a card with itself across buy:/play:', () => {
    for (const c of a.combos) {
      const cardA = c.feature_a.slice(c.feature_a.indexOf(':') + 1);
      const cardB = c.feature_b.slice(c.feature_b.indexOf(':') + 1);
      const bothCards = c.feature_a.includes('play:') || c.feature_a.includes('buy:');
      if (bothCards) expect(cardA === cardB && c.feature_a !== c.feature_b).toBe(false);
    }
  });
});
