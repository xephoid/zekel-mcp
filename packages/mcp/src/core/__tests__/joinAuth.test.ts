// Locks the multi-device join primitives: the 4-char code, claim/host tokens,
// the setup-window join gate, open-seat selection, and the seat-auth check that
// keeps a remote player's seat (and hidden info) theirs alone.

import { describe, expect, it } from 'vitest';
import { GameError } from '@zekel/game-kit';
import type { Game, SessionState } from '@zekel/game-kit';
import {
  JOIN_CODE_LENGTH,
  generateJoinCode,
  generateToken,
  hashToken,
  isJoinable,
  isMultiDevice,
  normalizeJoinCode,
  openSeats,
  verifyHostAuth,
  verifyReleaseAuth,
  verifySeatAuth,
} from '../joinAuth.js';

function session(over: Partial<SessionState<unknown>> = {}): SessionState<unknown> {
  return {
    sessionId: 's1',
    gameId: 'g',
    players: [
      { player_id: 'p1', kind: 'human' },
      { player_id: 'p2', kind: 'human' },
      { player_id: 'p3', kind: 'ai' },
    ],
    activePlayerId: 'p1',
    turnNumber: 1,
    gameState: {},
    moveLog: [],
    createdAt: 'now',
    hostPlayerId: 'p1',
    ...over,
  };
}

// A minimal Game surface for isJoinable: checklist length + game-over.
function fakeGame(opts: { setupSteps?: number; over?: boolean }): Pick<
  Game<unknown, unknown, unknown>,
  'getSetupChecklist' | 'isGameOver'
> {
  return {
    getSetupChecklist: () =>
      Array.from({ length: opts.setupSteps ?? 0 }, () => ({
        move_type: 'x',
        count: 1,
        description: '',
        ask_human_for: '',
      })),
    isGameOver: () =>
      opts.over ? { game_over: true, winners: [], scores: {}, summary: '' } : null,
  };
}

function caught(fn: () => unknown): GameError {
  try {
    fn();
  } catch (e) {
    if (e instanceof GameError) return e;
    throw e;
  }
  throw new Error('expected a throw');
}

describe('join codes', () => {
  it('generates codes of the right length from the unambiguous alphabet', () => {
    const code = generateJoinCode(() => false);
    expect(code).toHaveLength(JOIN_CODE_LENGTH);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
    // No ambiguous characters.
    expect(code).not.toMatch(/[01OIL]/);
  });

  it('retries until it finds a code the taken-predicate accepts', () => {
    const taken = new Set<string>();
    const first = generateJoinCode((c) => taken.has(c));
    taken.add(first);
    // Force a collision on the first attempt by claiming whatever it would pick;
    // since generation is random we just assert a distinct code comes back.
    const second = generateJoinCode((c) => taken.has(c));
    expect(second).not.toBe(first);
  });

  it('normalizes case and whitespace', () => {
    expect(normalizeJoinCode(' ab cd ')).toBe('ABCD');
    expect(normalizeJoinCode('wxyz')).toBe('WXYZ');
  });
});

describe('tokens', () => {
  it('hashes deterministically and distinctly', () => {
    const t = generateToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toBe(hashToken(generateToken()));
    expect(hashToken(t)).not.toBe(t); // hash, not plaintext
  });
});

describe('isMultiDevice', () => {
  it('is false until a seat is claimed', () => {
    expect(isMultiDevice(session())).toBe(false);
    expect(isMultiDevice(session({ seatClaims: {} }))).toBe(false);
    expect(
      isMultiDevice(session({ seatClaims: { p2: { tokenHash: 'h', claimedAt: 'now' } } })),
    ).toBe(true);
  });
});

describe('isJoinable', () => {
  it('is joinable while still in setup', () => {
    expect(isJoinable(session({ moveLog: [{} as never] }), fakeGame({ setupSteps: 2 }))).toBe(true);
  });

  it('is joinable before any move even with no setup checklist', () => {
    expect(isJoinable(session({ moveLog: [] }), fakeGame({ setupSteps: 0 }))).toBe(true);
  });

  it('closes once real play has begun (moves applied, setup complete)', () => {
    expect(
      isJoinable(session({ moveLog: [{} as never] }), fakeGame({ setupSteps: 0 })),
    ).toBe(false);
  });

  it('is never joinable once the game is over', () => {
    expect(isJoinable(session({ moveLog: [] }), fakeGame({ over: true }))).toBe(false);
  });
});

describe('openSeats', () => {
  it('offers human seats that are not the host and not yet claimed', () => {
    expect(openSeats(session())).toEqual(['p2']);
  });

  it('excludes claimed seats', () => {
    expect(
      openSeats(session({ seatClaims: { p2: { tokenHash: 'h', claimedAt: 'now' } } })),
    ).toEqual([]);
  });

  it('never offers AI seats or the host seat', () => {
    const s = session({
      players: [
        { player_id: 'host', kind: 'human' },
        { player_id: 'ai1', kind: 'ai' },
        { player_id: 'guest1', kind: 'human' },
        { player_id: 'guest2', kind: 'human' },
      ],
      hostPlayerId: 'host',
    });
    expect(openSeats(s)).toEqual(['guest1', 'guest2']);
  });
});

describe('verifySeatAuth', () => {
  const claimToken = 'claim-secret';
  const hostToken = 'host-secret';
  const multi = () =>
    session({
      hostTokenHash: hashToken(hostToken),
      seatClaims: { p2: { tokenHash: hashToken(claimToken), claimedAt: 'now' } },
    });

  it('is a no-op for single-device sessions (no token needed)', () => {
    expect(() => verifySeatAuth(session(), 'p1', undefined)).not.toThrow();
    expect(() => verifySeatAuth(session(), 'p2', undefined)).not.toThrow();
  });

  it('lets the remote claim_token act on its own seat', () => {
    expect(() => verifySeatAuth(multi(), 'p2', claimToken)).not.toThrow();
  });

  it('lets the host_token act on non-remote seats (own seat + AI)', () => {
    expect(() => verifySeatAuth(multi(), 'p1', hostToken)).not.toThrow();
    expect(() => verifySeatAuth(multi(), 'p3', hostToken)).not.toThrow();
  });

  it('blocks the host from acting on the remote seat', () => {
    expect(caught(() => verifySeatAuth(multi(), 'p2', hostToken)).error_code).toBe('INVALID_SEAT_AUTH');
  });

  it('blocks the remote from acting on host/AI seats', () => {
    expect(caught(() => verifySeatAuth(multi(), 'p1', claimToken)).error_code).toBe('INVALID_SEAT_AUTH');
    expect(caught(() => verifySeatAuth(multi(), 'p3', claimToken)).error_code).toBe('INVALID_SEAT_AUTH');
  });

  it('requires a token once multi-device', () => {
    expect(caught(() => verifySeatAuth(multi(), 'p2', undefined)).error_code).toBe('SEAT_AUTH_REQUIRED');
  });
});

describe('verifyReleaseAuth', () => {
  const claimToken = 'claim-secret';
  const hostToken = 'host-secret';
  const multi = () =>
    session({
      hostTokenHash: hashToken(hostToken),
      seatClaims: { p2: { tokenHash: hashToken(claimToken), claimedAt: 'now' } },
    });

  it('accepts the seat owner (claim_token) OR the host (host_token)', () => {
    expect(() => verifyReleaseAuth(multi(), 'p2', claimToken)).not.toThrow();
    expect(() => verifyReleaseAuth(multi(), 'p2', hostToken)).not.toThrow();
  });

  it('rejects an unrelated token and a missing token', () => {
    expect(caught(() => verifyReleaseAuth(multi(), 'p2', 'nope')).error_code).toBe('INVALID_SEAT_AUTH');
    expect(caught(() => verifyReleaseAuth(multi(), 'p2', undefined)).error_code).toBe('SEAT_AUTH_REQUIRED');
  });
});

describe('verifyHostAuth', () => {
  const hostToken = 'host-secret';
  const multi = () =>
    session({
      hostTokenHash: hashToken(hostToken),
      seatClaims: { p2: { tokenHash: hashToken('other'), claimedAt: 'now' } },
    });

  it('is a no-op single-device', () => {
    expect(() => verifyHostAuth(session(), undefined)).not.toThrow();
  });

  it('accepts the host token and rejects anything else', () => {
    expect(() => verifyHostAuth(multi(), hostToken)).not.toThrow();
    expect(caught(() => verifyHostAuth(multi(), 'other')).error_code).toBe('INVALID_SEAT_AUTH');
    expect(caught(() => verifyHostAuth(multi(), undefined)).error_code).toBe('SEAT_AUTH_REQUIRED');
  });
});
