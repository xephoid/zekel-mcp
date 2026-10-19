import { describe, it, expect } from 'vitest';
import { buildMoveMenu, menuForActivePlayer } from '../moveMenu.js';
import type {
  Game,
  LegalMove,
  MoveMenu,
  MoveMenuEntry,
  SessionState,
} from '@zekel/game-kit';

// A minimal session shell — the builder only reads players (via the helper) and
// passes state through to a game's describeMoveMenu hook, so the gameState is
// irrelevant here.
function session(
  players: SessionState<unknown>['players'],
  activePlayerId: string,
): SessionState<unknown> {
  return {
    sessionId: 's',
    gameId: 'g',
    players,
    activePlayerId,
    turnNumber: 1,
    gameState: {},
    moveLog: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function move(id: string, description: string, move: unknown): LegalMove<unknown> {
  return { move_id: id, description, move };
}

// Walks the menu tree and returns every leaf's move_id in order.
function leafIds(entries: MoveMenuEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.submenu) out.push(...leafIds(e.submenu));
    else if (e.move_id) out.push(e.move_id);
  }
  return out;
}

// Asserts no level lists more than `max` entries — the readability invariant.
function maxLevelWidth(entries: MoveMenuEntry[]): number {
  let max = entries.length;
  for (const e of entries) {
    if (e.submenu) max = Math.max(max, maxLevelWidth(e.submenu));
  }
  return max;
}

describe('buildMoveMenu — flat (small move sets, e.g. Fractured Fist)', () => {
  const moves: LegalMove<unknown>[] = [
    move('play-attack', 'Play Attack', { type: 'play_card', card_id: 'attack' }),
    move('play-block', 'Play Block', { type: 'play_card', card_id: 'block' }),
    move('focus-reload', 'Focus reload', { type: 'focus_reload' }),
    move('advance-phase', 'Advance to Channel phase', { type: 'advance_phase' }),
    move('end-turn', 'End turn', { type: 'end_turn' }),
  ];

  it('lists a small set flat with numbered keys and no collapse', () => {
    const menu = buildMoveMenu(session([], 'p1'), moves)!;
    expect(menu).not.toBeNull();
    expect(menu.collapsed).toBe(false);
    expect(menu.total_moves).toBe(5);
    expect(menu.entries).toHaveLength(5);
    expect(menu.entries.map((e) => e.key)).toEqual(['1', '2', '3', '4', '5']);
    expect(menu.entries[0]).toMatchObject({
      key: '1',
      label: 'Play Attack',
      move_id: 'play-attack',
    });
    // Flat entries are all leaves — no submenus.
    expect(menu.entries.every((e) => e.submenu === undefined)).toBe(true);
  });

  it('returns null when there are no legal moves', () => {
    expect(buildMoveMenu(session([], 'p1'), [])).toBeNull();
  });
});

describe('buildMoveMenu — grouped drill-down (large move sets, e.g. Brass)', () => {
  // Synthesize a Brass-like busy turn: many build variants across cities +
  // industries, plus a handful of other action types.
  const cities = ['birmingham', 'coventry', 'dudley', 'walsall', 'wolverhampton'];
  const industries = ['cotton_mill', 'coal_mine', 'iron_works'];
  const builds: LegalMove<unknown>[] = [];
  for (const location of cities) {
    for (const industry_type of industries) {
      for (let slot_index = 0; slot_index < 4; slot_index++) {
        builds.push(
          move(
            `build-${location}-${industry_type}-${slot_index}`,
            `Build ${industry_type} in ${location} slot ${slot_index}`,
            { type: 'build', location, industry_type, slot_index },
          ),
        );
      }
    }
  }
  const others: LegalMove<unknown>[] = [
    move('loan', 'Take a loan', { type: 'loan', card_id: 'x' }),
    move('scout', 'Scout', { type: 'scout' }),
    move('pass', 'Pass', { type: 'pass', card_id: 'y' }),
  ];
  const all = [...builds, ...others]; // 60 builds + 3 = 63 moves

  const menu = buildMoveMenu(session([], 'p1'), all)!;

  it('collapses a large set into categories by the move discriminant', () => {
    expect(menu.collapsed).toBe(true);
    expect(menu.total_moves).toBe(63);
    // Top level groups by `type`: build (a category) + loan/scout/pass.
    const build = menu.entries.find((e) => e.label.startsWith('Build'));
    expect(build).toBeDefined();
    expect(build!.group_by).toBe('type');
    expect(build!.count).toBe(60);
    expect(build!.submenu).toBeDefined();
  });

  it('collapses single-option categories straight to a leaf (no pointless drill)', () => {
    // loan/scout/pass each have exactly one move → leaf, not a submenu.
    const loan = menu.entries.find((e) => e.move_id === 'loan');
    expect(loan).toBeDefined();
    expect(loan!.submenu).toBeUndefined();
  });

  it('keeps every level readable (no level dumps the whole list)', () => {
    expect(maxLevelWidth(menu.entries)).toBeLessThanOrEqual(12);
  });

  it('preserves every legal move exactly once across the tree', () => {
    const ids = leafIds(menu.entries).sort();
    const expected = all.map((m) => m.move_id).sort();
    expect(ids).toEqual(expected);
  });

  it('drills build by a secondary field once type alone is too broad', () => {
    const build = menu.entries.find((e) => e.label.startsWith('Build'))!;
    // Second level must split further (60 > threshold) by some field, and every
    // sub-level stays within the readable cap.
    expect(build.submenu!.every((e) => e.submenu !== undefined || e.move_id)).toBe(
      true,
    );
    expect(maxLevelWidth(build.submenu!)).toBeLessThanOrEqual(12);
  });
});

describe('buildMoveMenu — pagination fallback (unsplittable large set)', () => {
  // 30 moves that share one identical shape: no field splits them, so the
  // builder must page them rather than dump 30 at once.
  const moves: LegalMove<unknown>[] = Array.from({ length: 30 }, (_, i) =>
    move(`m${i}`, `Identical option ${i}`, { type: 'pick' }),
  );

  it('pages an unsplittable list into readable chunks', () => {
    const menu = buildMoveMenu(session([], 'p1'), moves)!;
    expect(menu.collapsed).toBe(true);
    expect(maxLevelWidth(menu.entries)).toBeLessThanOrEqual(12);
    expect(leafIds(menu.entries)).toHaveLength(30);
    // Every top entry is a page node.
    expect(menu.entries.every((e) => e.submenu !== undefined)).toBe(true);
    expect(menu.entries[0]!.label).toMatch(/^Options 1–/);
  });
});

describe('buildMoveMenu — describeMoveMenu override', () => {
  it('uses the game hook when it returns a menu', () => {
    const custom: MoveMenu = {
      prompt: 'custom',
      entries: [{ key: '1', label: 'only', move_id: 'm0' }],
      total_moves: 1,
      collapsed: false,
      free_text_hint: 'fh',
      how_to_use: 'h',
    };
    const game = { describeMoveMenu: () => custom } as Pick<
      Game<unknown, unknown, unknown>,
      'describeMoveMenu'
    >;
    const moves = [move('m0', 'x', { type: 'a' }), move('m1', 'y', { type: 'b' })];
    expect(buildMoveMenu(session([], 'p1'), moves, game)).toBe(custom);
  });

  it('falls back to the generic builder when the hook returns null', () => {
    const game = { describeMoveMenu: () => null } as Pick<
      Game<unknown, unknown, unknown>,
      'describeMoveMenu'
    >;
    const moves = [move('m0', 'x', { type: 'a' })];
    const menu = buildMoveMenu(session([], 'p1'), moves, game)!;
    expect(menu.prompt).toBe('Your move — pick a number:');
  });
});

describe('menuForActivePlayer — only a human on the clock gets a menu', () => {
  const players = [
    { player_id: 'human', kind: 'human' as const },
    { player_id: 'bot', kind: 'ai' as const },
  ];
  const moves = [move('m0', 'x', { type: 'a' })];
  const game = {
    getLegalMoves: () => moves,
  } as unknown as Pick<
    Game<unknown, unknown, unknown>,
    'getLegalMoves' | 'describeMoveMenu'
  >;

  it('builds a menu when a human is to move', () => {
    const menu = menuForActivePlayer(game, session(players, 'human'), {
      status: 'human_to_move',
      active_player_id: 'human',
      instruction: '',
    });
    expect(menu).toBeDefined();
    expect(menu!.entries[0]!.move_id).toBe('m0');
  });

  it('returns undefined when an AI is to move', () => {
    const menu = menuForActivePlayer(game, session(players, 'bot'), {
      status: 'ai_to_move',
      active_player_id: 'bot',
      instruction: '',
    });
    expect(menu).toBeUndefined();
  });

  it('returns undefined when the game is over', () => {
    const menu = menuForActivePlayer(game, session(players, 'human'), {
      status: 'game_over',
      active_player_id: null,
      instruction: '',
    });
    expect(menu).toBeUndefined();
  });
});
