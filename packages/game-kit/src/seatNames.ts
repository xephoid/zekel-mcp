// Seat display names for spoken and shown text (docs/spoken-narration.md).
// Move summaries must name seats the way the table does, never by raw seat id:
// the name the human gave at create_session, else the AI's generic label, else
// "Player N" by seat position. Games whose seats carry an identity (a colour, a
// faction, a character) should prefer that identity where they have it.

import type { PlayerConfig } from './game.js';

/** Resolves a seat id to the name a player hears. */
export type NameOf = (playerId: string) => string;

/** Display name for one seat: PlayerConfig.name if given; an unnamed AI is
 *  "the AI" (or "AI 1", "AI 2", … when several AI seats are unnamed); an
 *  unnamed human is "Player N" by seat position. An id not in the list is
 *  returned unchanged. */
export function seatDisplayName(players: PlayerConfig[], playerId: string): string {
  const idx = players.findIndex((p) => p.player_id === playerId);
  const seat = players[idx];
  if (!seat) return playerId;
  const given = seat.name?.trim();
  // A name that equals the seat id is the harness's unnamed fallback (a game's
  // createSession does name: player.name ?? player_id), NOT a real name — skip
  // it so the AI/Player-N fallback fires instead of leaking the id ("p1 rolls 6+4").
  if (given && given !== playerId) return given;
  if (seat.kind === 'ai') {
    const unnamedAIs = players.filter((p) => p.kind === 'ai' && !p.name?.trim());
    return unnamedAIs.length <= 1 ? 'the AI' : `AI ${unnamedAIs.indexOf(seat) + 1}`;
  }
  return `Player ${idx + 1}`;
}

/** A NameOf bound to one session's seat list. */
export function seatNamer(players: PlayerConfig[]): NameOf {
  return (id) => seatDisplayName(players, id);
}
