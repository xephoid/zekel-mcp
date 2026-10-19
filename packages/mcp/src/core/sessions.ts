import type { SessionState } from '@zekel/game-kit';
import { GameError } from '@zekel/game-kit';
import { MemorySessionStore } from './store/memory.js';
import type { SessionStore } from './store/types.js';

// Facade over a pluggable SessionStore (src/core/store/). The store backend
// is a module-level singleton (mirrors registry.ts): it defaults to the
// in-memory store so unit tests and direct importers never touch disk —
// only index.ts main() swaps in the env-selected persistent store
// (createSessionStoreFromEnv) before serving.
let store: SessionStore = new MemorySessionStore();

export function setSessionStore(s: SessionStore): void {
  store = s;
}

export function getSessionStore(): SessionStore {
  return store;
}

// Per-session undo history: a bounded stack of isolated prior-state snapshots.
// The MCP move tools push the pre-move snapshot here so a mis-applied move
// (e.g. one the model made without the human actually choosing it) can be
// reverted. Game-agnostic — every game keeps SessionState JSON/structured-
// clone safe. Snapshot isolation is owned by the store (memory: structured-
// Clone; SQL: serialization).
const UNDO_LIMIT = 50;

export async function saveSession<S>(state: SessionState<S>): Promise<void> {
  await store.saveSession(state as SessionState<unknown>);
}

// Record a snapshot of `prior` (the state BEFORE a move) so it can be undone.
// Call this just before saving the post-move state. Oldest entries drop past
// UNDO_LIMIT. The mover's kind ('human' | 'ai') is captured here, at push
// time, so undoSession's sweep can read it from cheap metadata without
// loading snapshot bodies.
export async function recordUndoSnapshot<S>(prior: SessionState<S>): Promise<void> {
  const moverKind =
    prior.players.find((p) => p.player_id === prior.activePlayerId)?.kind ?? null;
  await store.pushUndoSnapshot(
    prior.sessionId,
    prior as SessionState<unknown>,
    moverKind,
    UNDO_LIMIT,
  );
}

// Undo the last HUMAN-initiated action and any AI moves that followed it, in one
// step — so "I took my turn, then the AI went" reverts as a unit, not two undos.
// Logic: if the most recent move was an AI move, sweep back through the trailing AI
// moves to (and including) the human move that triggered them; otherwise revert just
// that one move. (An all-AI history has no human anchor, so it reverts a single move.)
// Returns the restored state + how many actions were reverted, or null if nothing to
// undo. NOTE: a human "report" mid-AI-turn (e.g. a Detective deciding a block) is itself a
// human action, so the sweep stops there — a second undo continues further back.
export async function undoSession(
  sessionId: string,
): Promise<{ restored: SessionState<unknown>; reverted: number } | null> {
  const meta = await store.listUndoMeta(sessionId);
  if (meta.length === 0) return null;

  let target = meta.length - 1;
  if (meta[target]!.mover_kind !== 'human') {
    // Sweep back over trailing AI moves to the human move that caused them.
    while (target > 0 && meta[target]!.mover_kind === 'ai') target--;
    if (meta[target]!.mover_kind !== 'human') target = meta.length - 1; // no human anchor → single undo
  }
  const restored = await store.getUndoSnapshot(sessionId, meta[target]!.position);
  if (!restored) return null; // defensive; meta and bodies are written together
  const reverted = meta.length - target;
  // Preferences SURVIVE undo (docs/rules-teaching.md): a preference is not a
  // game event, so "I turned teaching off, undid a move, and it came back" is a
  // bug. taughtSections deliberately stays with the snapshot — undoing back
  // into a situation replays its lesson.
  const current = await store.getSession(sessionId);
  if (current) {
    if (current.seatPreferences !== undefined) restored.seatPreferences = current.seatPreferences;
    else delete restored.seatPreferences;
  }
  // Drop the restored snapshot and everything after it.
  await store.truncateUndoFrom(sessionId, meta[target]!.position);
  await store.saveSession(restored);
  return { restored, reverted };
}

export async function undoDepth(sessionId: string): Promise<number> {
  return store.undoDepth(sessionId);
}

export async function getSession(sessionId: string): Promise<SessionState<unknown>> {
  const s = await store.getSession(sessionId);
  if (!s) {
    throw new GameError('SESSION_NOT_FOUND', `No session with id ${sessionId}`);
  }
  // Lazy backfill: if this session carries a join code that isn't indexed yet
  // (e.g. it was created before a restart and is only now being loaded by id),
  // re-register it so join_session can still resolve it. See the index notes
  // below; startup rebuild covers the cold case, this covers any gaps.
  if (s.joinCode && !joinCodeIndex.has(s.joinCode)) {
    joinCodeIndex.set(s.joinCode, s.sessionId);
  }
  return s;
}

export async function getSessionsForGame(gameId: string): Promise<SessionState<unknown>[]> {
  return store.getSessionsForGame(gameId);
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  // Drop the join-code mapping so a deleted session's code can't resolve (and
  // frees the code's slot in the namespace).
  const existing = await store.getSession(sessionId);
  if (existing?.joinCode) releaseJoinCode(existing.joinCode);
  return store.deleteSession(sessionId);
}

export function newSessionId(): string {
  // Crypto-randomUUID is in node:crypto / globalThis.crypto on Node 20+
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Join-code index: maps a session's 4-character join_code -> session_id so a
// second human can resolve a session from the code alone. Kept in-memory and
// process-wide, which matches the supported deployment for multi-device play:
// both devices connect to ONE shared HTTP server process (see index.ts /
// startHttp), so this one process owns the index for the lifetime of the live
// game. The code is also persisted on SessionState.joinCode, but lookup BY code
// (no session_id in hand) only needs to work during the brief setup window in
// which a join happens — well within a single server lifetime. A server restart
// mid-setup drops outstanding codes; the host re-shares a freshly created game.
const joinCodeIndex = new Map<string, string>();

export function registerJoinCode(code: string, sessionId: string): void {
  joinCodeIndex.set(code, sessionId);
}

export function isJoinCodeTaken(code: string): boolean {
  return joinCodeIndex.has(code);
}

export function resolveJoinCode(code: string): string | undefined {
  return joinCodeIndex.get(code);
}

export function releaseJoinCode(code: string): void {
  joinCodeIndex.delete(code);
}

// Rebuild the join-code index from persisted sessions so codes survive a server
// restart. The code is stored on SessionState.joinCode (the persistent stores
// serialize the whole state), so a one-time scan of every game's sessions at
// startup repopulates the in-memory index. Called from index.ts main() after
// the store is selected and games are registered; a no-op for the memory store
// (nothing persisted) and cheap for the SQL/Mongo stores (one query per game).
export async function rebuildJoinCodeIndex(gameIds: string[]): Promise<number> {
  let restored = 0;
  for (const gameId of gameIds) {
    for (const s of await store.getSessionsForGame(gameId)) {
      if (s.joinCode) {
        joinCodeIndex.set(s.joinCode, s.sessionId);
        restored += 1;
      }
    }
  }
  return restored;
}
