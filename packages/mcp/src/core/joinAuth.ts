import { createHash, randomBytes } from 'node:crypto';
import { GameError } from '@zekel/game-kit';
import type { Game, SessionState } from '@zekel/game-kit';

// ===========================================================================
// Multi-device join support: the 4-character join code, the per-seat claim
// tokens, the host token, and the seat-access check that ties them together.
//
// The whole point is letting a SECOND human, on a SEPARATE device, own a seat
// so they can report their secret information (drawn cards, etc.) WITHOUT the
// host seeing it. Both devices talk to one shared HTTP server process, so the
// store singleton is the single source of truth they coordinate through.
//
// Trust model — a session is "single-device" until the first seat is claimed
// via join_session, and "multi-device" thereafter:
//   - single-device  → NO auth is enforced. Hot-seat and solo-vs-AI play work
//     exactly as before; the host drives every seat with no token.
//   - multi-device    → every player-scoped call must carry an auth_token:
//       * a CLAIMED (remote) seat requires that seat's claim_token;
//       * EVERY other seat (AI, unclaimed hot-seat humans, the host's own seat)
//         requires the host_token.
//     This is what enforces "only the host may progress the game except on a
//     remote player's own turn": a remote joiner holds only their claim token,
//     so they cannot drive AI/host turns; the host holds only the host token,
//     so they cannot act as — or peek at the private view of — the remote seat.
// ===========================================================================

// Crockford-ish alphabet: uppercase, no 0/O/1/I/L to avoid read-aloud
// ambiguity (the host typically reads the code to the other player).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const JOIN_CODE_LENGTH = 4;

/** Generate a random 4-char join code, retrying until `isTaken` returns false
 *  so codes are unique across live sessions. */
export function generateJoinCode(isTaken: (code: string) => boolean): string {
  // 31^4 ≈ 924k combinations; collisions are rare but we still guard.
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const bytes = randomBytes(JOIN_CODE_LENGTH);
    let code = '';
    for (let i = 0; i < JOIN_CODE_LENGTH; i += 1) {
      code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    }
    if (!isTaken(code)) return code;
  }
  throw new GameError('STORAGE_ERROR', 'Could not allocate a unique join code');
}

/** Normalize human-typed codes so "ab cd", "ABCD", "abcd" all match. */
export function normalizeJoinCode(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/** A long, URL-safe secret handed to a client exactly once. */
export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A session is multi-device once at least one seat has been claimed remotely. */
export function isMultiDevice(session: SessionState<unknown>): boolean {
  return Object.keys(session.seatClaims ?? {}).length > 0;
}

/** A session may still be JOINED while it is in setup (per-game setup checklist
 *  not yet exhausted) or before any move at all has been applied — i.e. before
 *  real play has begun. Game-over sessions are never joinable. */
export function isJoinable(
  session: SessionState<unknown>,
  game: Pick<Game<unknown, unknown, unknown>, 'getSetupChecklist' | 'isGameOver'>,
): boolean {
  if (game.isGameOver(session) !== null) return false;
  const inSetup = (game.getSetupChecklist?.(session)?.length ?? 0) > 0;
  return inSetup || session.moveLog.length === 0;
}

/** Human seats that a remote device may still claim: kind=human, not the host's
 *  own seat, and not already claimed. Returned in player-array order so
 *  auto-pick is deterministic. */
export function openSeats(session: SessionState<unknown>): string[] {
  const claimed = session.seatClaims ?? {};
  return session.players
    .filter(
      (p) =>
        p.kind === 'human' &&
        p.player_id !== session.hostPlayerId &&
        claimed[p.player_id] === undefined,
    )
    .map((p) => p.player_id);
}

/** Throw unless `authToken` authorizes acting on / reading the private view of
 *  `playerId` in this session. A no-op for single-device sessions (no auth yet).
 *  On a multi-device session:
 *    - a claimed seat needs its own claim_token;
 *    - any other seat needs the host_token.
 *  Either way the caller passes whichever single token it holds as auth_token;
 *  it only validates against the seats that token owns. */
export function verifySeatAuth(
  session: SessionState<unknown>,
  playerId: string,
  authToken: string | undefined,
): void {
  if (!isMultiDevice(session)) return;
  const claim = session.seatClaims?.[playerId];
  const expectedHash = claim ? claim.tokenHash : session.hostTokenHash;
  // Defensive: a multi-device session always has a host token hash (set when the
  // join code was issued). If somehow absent, fail closed.
  if (!expectedHash) {
    throw new GameError(
      'INVALID_SEAT_AUTH',
      'This session is in multi-device mode but has no host credential; cannot authorize.',
    );
  }
  const who = claim
    ? `the remote player on seat ${playerId} (use their claim_token)`
    : `the host (use the host_token from create_session)`;
  if (authToken === undefined || authToken === '') {
    throw new GameError(
      'SEAT_AUTH_REQUIRED',
      `This session has a remote player, so acting on or reading seat ${playerId} requires an auth_token. ` +
        `Only ${who} may do this. Pass auth_token with the call.`,
    );
  }
  if (hashToken(authToken) !== expectedHash) {
    throw new GameError(
      'INVALID_SEAT_AUTH',
      `The auth_token does not authorize seat ${playerId}. That seat belongs to ${who}.`,
    );
  }
}

/** Throw unless `authToken` authorizes RELEASING / REASSIGNING seat `playerId` —
 *  i.e. it is EITHER that seat's own claim_token (the remote player acting on
 *  themselves) OR the host_token (the host recovering an abandoned seat or
 *  vouching for a reconnecting player). The caller must confirm the seat is
 *  actually claimed first (SEAT_NOT_CLAIMED otherwise). Unlike verifySeatAuth,
 *  this DELIBERATELY accepts the host for a claimed seat. */
export function verifyReleaseAuth(
  session: SessionState<unknown>,
  playerId: string,
  authToken: string | undefined,
): void {
  const claimHash = session.seatClaims?.[playerId]?.tokenHash;
  const hostHash = session.hostTokenHash;
  if (authToken === undefined || authToken === '') {
    throw new GameError(
      'SEAT_AUTH_REQUIRED',
      `Releasing or reassigning seat ${playerId} requires an auth_token: that seat's own claim_token, or the host_token.`,
    );
  }
  const provided = hashToken(authToken);
  if ((claimHash && provided === claimHash) || (hostHash && provided === hostHash)) return;
  throw new GameError(
    'INVALID_SEAT_AUTH',
    `The auth_token does not authorize seat ${playerId}. Use that seat's claim_token (if you are the remote player) or the host_token (if you are the host).`,
  );
}

/** Throw unless `authToken` is the host token. Used for game-progressing actions
 *  that are not scoped to one seat (e.g. undo). No-op on single-device sessions. */
export function verifyHostAuth(
  session: SessionState<unknown>,
  authToken: string | undefined,
): void {
  if (!isMultiDevice(session)) return;
  if (!session.hostTokenHash) {
    throw new GameError(
      'INVALID_SEAT_AUTH',
      'This session is in multi-device mode but has no host credential; cannot authorize.',
    );
  }
  if (authToken === undefined || authToken === '') {
    throw new GameError(
      'SEAT_AUTH_REQUIRED',
      'This session has a remote player; only the host may do this. Pass the host_token as auth_token.',
    );
  }
  if (hashToken(authToken) !== session.hostTokenHash) {
    throw new GameError(
      'INVALID_SEAT_AUTH',
      'The auth_token is not the host_token; only the host may do this.',
    );
  }
}
