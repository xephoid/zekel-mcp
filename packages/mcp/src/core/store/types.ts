import type { SessionState } from '@zekel/game-kit';

// Version of the PERSISTED SHAPE (SessionState + every game's state types),
// shared by all persistent adapters (mongo, sqlite, future SQL adapters).
// Bump it and add a migration step in each adapter's migrate()/connect()
// whenever that shape changes — see CLAUDE.md, "Persisted sessions and
// schema migration".
//
// 2 (2026-09-29): Adventurer Olympics' state was rewritten after an
// implementation review — the per-seat `deckOrders` map, the `Set` hexes, and
// the old pending/ending/tie fields were replaced by the canonical shared
// decks, a JSON hex map, and the new pending kinds. Old-format AO rows are
// geometrically incompatible (no faithful conversion exists). The 1 → 2 step
// in both adapters keeps every row and just moves the version on; an old AO
// session is refused by itself when loaded (adventurer-olympics/index.ts
// assertCurrentFormat) — it never stops the database opening for other games.
export const SESSION_SCHEMA_VERSION = '2';

// Cheap per-snapshot metadata so undoSession's sweep (sessions.ts) can find
// its restore target without parsing snapshot bodies. `position` is
// monotonically increasing per session and stable across trims — entries are
// never renumbered, so a position fetched from listUndoMeta() can always be
// passed to getUndoSnapshot()/truncateUndoFrom().
export interface UndoEntryMeta {
  position: number;
  // kind of the seat matching snapshot.activePlayerId ('human' | 'ai'), or
  // null if no seat matched. Computed once by the sessions.ts facade at push
  // time — the snapshot's content is frozen, so this can never go stale.
  mover_kind: string | null;
}

// Pluggable persistence backend for sessions + their undo stacks. The
// interface is async even though the local SQLite driver is synchronous,
// because adapters for client/server SQL databases (Postgres via `pg`,
// MySQL, ...) are async-only — an adapter implements these same methods
// against its driver and nothing above this layer changes.
//
// Contract notes for implementers:
// - getSession returns null when not found; the sessions.ts facade maps null
//   to GameError('SESSION_NOT_FOUND'). Store methods themselves should throw
//   GameError('STORAGE_ERROR', ...) for backend failures.
// - pushUndoSnapshot owns snapshot ISOLATION: the caller may keep mutating
//   the live state object after the call, and the stored snapshot must not
//   change. (Memory store: structuredClone. SQL stores: serialization is the
//   isolation.) It also owns trimming the OLDEST entries past `limit`.
// - Repeated getSession calls for the same id within one process SHOULD
//   return the same object reference (write-through cache). The MCP layer and
//   game modules were written against Map semantics, where the stored session
//   and the object in hand alias each other; returning fresh parsed copies
//   would silently change that. See SqliteSessionStore.
export interface SessionStore {
  saveSession(state: SessionState<unknown>): Promise<void>;
  getSession(sessionId: string): Promise<SessionState<unknown> | null>;
  getSessionsForGame(gameId: string): Promise<SessionState<unknown>[]>;
  deleteSession(sessionId: string): Promise<boolean>;

  // --- undo-stack primitives; the sweep LOGIC stays in sessions.ts ---
  pushUndoSnapshot(
    sessionId: string,
    snapshot: SessionState<unknown>,
    moverKind: string | null,
    limit: number,
  ): Promise<void>;
  // Bottom→top (oldest first) metadata only — no snapshot bodies.
  listUndoMeta(sessionId: string): Promise<UndoEntryMeta[]>;
  getUndoSnapshot(sessionId: string, position: number): Promise<SessionState<unknown> | null>;
  // Delete every snapshot with position >= fromPosition.
  truncateUndoFrom(sessionId: string, fromPosition: number): Promise<void>;
  undoDepth(sessionId: string): Promise<number>;

  close(): Promise<void>;
}
