// Which seats get a per-move player-view snapshot in run_ai_turn
// (docs/digital-mode.md, "AI turns come back as a list of snapshots").
//
// Every DIGITAL HUMAN seat gets its own view, keyed by player_id, so a client
// with two people at the table can play the AI's turn back for each of them.
// Physical seats get none: their table is the real one. AI seats get none:
// nobody is watching from their chair.
//
// Privacy: a player view is that seat's PRIVATE view (its own hand). On a
// multi-device session the caller only holds one credential, so a seat is
// included only when that credential authorizes reading it — the same rule
// get_state enforces. In practice the host (who must hold the host_token to
// drive AI turns at all) gets every unclaimed digital seat, and a claimed
// remote seat's view is left out for that player to fetch themselves.
// Single-device sessions have no seat auth, so every digital seat is included.

import type { SessionState } from '@zekel/game-kit';
import { verifySeatAuth } from '../core/joinAuth.js';

export function snapshotSeats(session: SessionState<unknown>, authToken: string | undefined): string[] {
  const out: string[] = [];
  for (const p of session.players) {
    if (p.kind !== 'human' || p.table !== 'digital') continue;
    try {
      verifySeatAuth(session, p.player_id, authToken);
      out.push(p.player_id);
    } catch {
      // Not this caller's seat to read — leave its view out.
    }
  }
  return out;
}
