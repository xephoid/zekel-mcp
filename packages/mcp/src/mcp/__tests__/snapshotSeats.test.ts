import { describe, expect, it } from 'vitest';
import type { PlayerConfig, SessionState } from '@zekel/game-kit';
import { hashToken } from '../../core/joinAuth.js';
import { snapshotSeats } from '../snapshotSeats.js';

// docs/digital-mode.md: run_ai_turn hands back one player-view snapshot per
// move for EVERY digital human seat the caller may read — not just the first.

function session(players: PlayerConfig[], extra: Partial<SessionState<unknown>> = {}): SessionState<unknown> {
  return {
    sessionId: 's',
    gameId: 'g',
    players,
    activePlayerId: players[0]!.player_id,
    turnNumber: 1,
    gameState: {},
    moveLog: [],
    createdAt: 'now',
    ...extra,
  };
}

describe('snapshotSeats', () => {
  it('a physical session gets no snapshots at all', () => {
    const s = session([
      { player_id: 'h1', kind: 'human' },
      { player_id: 'h2', kind: 'human', table: 'physical' },
      { player_id: 'ai', kind: 'ai' },
    ]);
    expect(snapshotSeats(s, undefined)).toEqual([]);
  });

  it('every digital human seat is included, in seat order; AI and physical seats are not', () => {
    const s = session([
      { player_id: 'h1', kind: 'human', table: 'digital' },
      { player_id: 'ai', kind: 'ai' },
      { player_id: 'h2', kind: 'human' },
      { player_id: 'h3', kind: 'human', table: 'digital' },
    ]);
    expect(snapshotSeats(s, undefined)).toEqual(['h1', 'h3']);
  });

  it('multi-device: the host gets every unclaimed digital seat but not a remote player\'s claimed seat', () => {
    const hostToken = 'host-secret';
    const claimToken = 'remote-secret';
    const s = session(
      [
        { player_id: 'h1', kind: 'human', table: 'digital' },
        { player_id: 'h2', kind: 'human', table: 'digital' },
        { player_id: 'ai', kind: 'ai' },
      ],
      {
        hostPlayerId: 'h1',
        hostTokenHash: hashToken(hostToken),
        seatClaims: { h2: { tokenHash: hashToken(claimToken), claimedAt: 'now' } },
      },
    );
    expect(snapshotSeats(s, hostToken)).toEqual(['h1']);
    // The remote player's own credential reads only their own seat.
    expect(snapshotSeats(s, claimToken)).toEqual(['h2']);
    // No credential on a multi-device session reads nothing.
    expect(snapshotSeats(s, undefined)).toEqual([]);
  });
});
