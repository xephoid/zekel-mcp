// Locks the setup-gauntlet helpers (desync --from-setup): the opening carries
// every fact the model needs, the emulated client-side schema check matches the
// real published zod shape (and its terse LibreChat message), seat verification
// catches the observed 9B mistakes, and kind-order seat mapping is total or null.

import { describe, expect, it } from 'vitest';
import {
  buildSetupOpening,
  checkRecordedSeats,
  clientValidateCreateSession,
  mapSeatsByKind,
  type DesyncPlayer,
} from '../desyncBot.js';

const requested: DesyncPlayer[] = [
  { player_id: 'p1', kind: 'human' },
  { player_id: 'p2', kind: 'ai', difficulty: 'medium' },
];

describe('buildSetupOpening', () => {
  it('states the game, the seat count, the name, and the difficulty', () => {
    const opening = buildSetupOpening('sweetlands-imperium', requested, 'Zeke');
    expect(opening).toContain('sweetlands imperium');
    expect(opening).toContain('my name is Zeke');
    expect(opening).toContain('1 AI opponent');
    expect(opening).toContain('medium difficulty');
  });

  it('lists per-seat difficulties when they differ', () => {
    const opening = buildSetupOpening('cybernoir-2127', [
      { player_id: 'p1', kind: 'human' },
      { player_id: 'p2', kind: 'ai', difficulty: 'easy' },
      { player_id: 'p3', kind: 'ai', difficulty: 'hard' },
    ], 'Ada');
    expect(opening).toContain('in seat order: easy, hard');
  });
});

describe('clientValidateCreateSession (the emulated client check)', () => {
  it('passes the loosened slop the 9B actually sent (post-legibility-fix schema)', () => {
    expect(
      clientValidateCreateSession({
        game_id: 'sweetlands-imperium',
        players: [
          { player_id: 'human_RED', kind: 'ai', name: 'RED (You)', difficulty: '', teaching: false },
          { player_id: 'seat_2', kind: 'ai', difficulty: 'medium' },
        ],
      }),
    ).toBeNull();
  });

  it('still rejects structurally-broken calls with the terse LibreChat message', () => {
    expect(clientValidateCreateSession({ game_id: 'sweetlands-imperium' })).toBe(
      'Error: Received tool input did not match expected schema Please fix your mistakes.',
    );
    expect(clientValidateCreateSession({ game_id: 'x', players: [{ kind: 'human' }] })).toContain(
      'did not match expected schema',
    );
  });
});

describe('checkRecordedSeats', () => {
  it('is empty for a faithful setup', () => {
    expect(
      checkRecordedSeats(
        [
          { player_id: 'a', kind: 'human', name: 'Zeke' },
          { player_id: 'b', kind: 'ai', difficulty: 'medium' },
        ],
        requested,
        'Zeke',
      ),
    ).toEqual([]);
  });

  it('catches the observed mistakes: human seat as ai, wrong difficulty, invented AI name, missing name', () => {
    const out = checkRecordedSeats(
      [
        { player_id: 'a', kind: 'ai', difficulty: 'easy', name: 'RANGR AI' },
        { player_id: 'b', kind: 'ai', difficulty: 'medium' },
      ],
      requested,
      'Zeke',
    );
    expect(out.join('\n')).toContain('asked for 1 human seat(s), the session has 0');
    expect(out.join('\n')).toContain('invented name');
    const out2 = checkRecordedSeats(
      [
        { player_id: 'a', kind: 'human' },
        { player_id: 'b', kind: 'ai', difficulty: 'hard' },
      ],
      requested,
      'Zeke',
    );
    expect(out2.join('\n')).toContain('has no name');
    expect(out2.join('\n')).toContain('difficulty hard but the human asked for medium');
  });
});

describe('mapSeatsByKind', () => {
  it('maps k-th human to k-th human and k-th ai to k-th ai', () => {
    const m = mapSeatsByKind(requested, [
      { player_id: 'frog_ai', kind: 'ai' },
      { player_id: 'me', kind: 'human' },
    ]);
    expect(m).toEqual({
      refToModel: { p1: 'me', p2: 'frog_ai' },
      modelToRef: { me: 'p1', frog_ai: 'p2' },
    });
  });

  it('returns null when counts or kind multisets differ', () => {
    expect(mapSeatsByKind(requested, [{ player_id: 'a', kind: 'human' }])).toBeNull();
    expect(
      mapSeatsByKind(requested, [
        { player_id: 'a', kind: 'ai' },
        { player_id: 'b', kind: 'ai' },
      ]),
    ).toBeNull();
  });
});
