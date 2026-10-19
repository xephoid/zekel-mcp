// SQLite-backed SessionStore using Node's built-in node:sqlite (zero deps,
// Node >= 22.13). Sessions and undo snapshots are stored as JSON TEXT.
//
// PORTABILITY: every SQL statement here sticks to the portable subset —
// TEXT/INTEGER columns, JSON as TEXT, ISO-8601 timestamp strings, upsert via
// INSERT ... ON CONFLICT DO UPDATE, no AUTOINCREMENT / foreign keys / SQLite
// JSON functions / generated columns — so a future adapter for another SQL
// database (e.g. Postgres via `pg`) can reuse the schema and statements
// nearly verbatim; only the PRAGMAs below are SQLite-specific and live
// exclusively in this constructor.
//
// SINGLE-PROCESS OWNERSHIP: getSession keeps a write-through cache that
// returns the SAME live object reference on every call (Map semantics — the
// MCP layer and game modules were written against this; fresh parsed copies
// per call would silently change aliasing behavior). That cache is not
// multi-process coherent: one server process owns the DB file. busy_timeout
// guards availability against an accidental double-launch, not coherence.
//
// CRASH SAFETY: node:sqlite is synchronous, so when an awaited save resolves
// the row is committed — a tool response implies durable state. WAL +
// synchronous=NORMAL means an app/process crash loses nothing and an OS/power
// failure can lose at most the latest commits (never corrupt the DB); for
// board-game bookkeeping where the human can re-state the last move, that
// beats paying a full fsync per move.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { SessionState } from '@zekel/game-kit';
import { GameError } from '@zekel/game-kit';
import { SESSION_SCHEMA_VERSION, type SessionStore, type UndoEntryMeta } from './types.js';

// Load the builtin at runtime: vite 5 (vitest's transform layer) mis-resolves
// a static `import 'node:sqlite'` (it strips the node: prefix and fails on
// bare 'sqlite'). process.getBuiltinModule (Node >= 22.3) sidesteps every
// bundler; the type-only import above is erased at compile time.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

// Persisted-shape version is shared across adapters (types.ts). Bump it and
// add a migration step in migrate() whenever the persisted shape changes —
// that includes changes to SessionState or to any game's state types, not
// just these tables (see CLAUDE.md, "Persisted sessions and schema migration").
const SCHEMA_VERSION = SESSION_SCHEMA_VERSION;
const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  game_id    TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_game_id ON sessions(game_id);

CREATE TABLE IF NOT EXISTS undo_snapshots (
  session_id    TEXT    NOT NULL,
  position      INTEGER NOT NULL,
  mover_kind    TEXT,
  snapshot_json TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  PRIMARY KEY (session_id, position)
);
`;

export class SqliteSessionStore implements SessionStore {
  private readonly db: DatabaseSyncType;
  // Write-through cache: sessionId → the live session object. See header.
  private readonly cache = new Map<string, SessionState<unknown>>();
  // Ids known to be absent so repeated misses (e.g. failMove re-fetch after
  // SESSION_NOT_FOUND) don't re-query. Cleared on save.
  private readonly knownMissing = new Set<string>();

  constructor(dbPath: string) {
    let opened: DatabaseSyncType | undefined;
    try {
      if (dbPath !== ':memory:') {
        mkdirSync(dirname(dbPath), { recursive: true });
      }
      this.db = opened = new DatabaseSync(dbPath);
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
      this.migrate();
    } catch (e) {
      // A throwing constructor must not leak the open file handle. The common
      // throw here is the schema-version guard in migrate(), which runs AFTER the
      // handle is open; on Windows a leaked WAL-mode handle keeps the db file
      // locked, so a later rmSync/unlink fails with EPERM. Close before re-throwing.
      try {
        opened?.close();
      } catch {
        /* handle never opened, or already closed — nothing to release */
      }
      if (e instanceof GameError) throw e;
      throw new GameError(
        'STORAGE_ERROR',
        `Failed to open session database at ${dbPath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private migrate(): void {
    this.db.exec(CREATE_SQL);
    const row = this.db
      .prepare('SELECT value FROM schema_meta WHERE key = ?')
      .get('schema_version') as { value: string } | undefined;
    if (row === undefined) {
      this.db
        .prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)')
        .run('schema_version', SCHEMA_VERSION);
      return;
    }
    if (row.value === '1' && SCHEMA_VERSION === '2') {
      // 1 → 2: only Adventurer Olympics' state changed shape, and its old rows
      // cannot be converted (see types.ts). Every row — sessions and undo
      // snapshots alike — is kept as-is: other games' rows are unchanged by
      // this version, and an old Adventurer Olympics row is refused on its own
      // when loaded (adventurer-olympics/index.ts assertCurrentFormat), so it
      // never blocks the rest of the database.
      this.db.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run('2', 'schema_version');
      return;
    }
    if (row.value !== SCHEMA_VERSION) {
      // Refuse rather than misread rows written by an unknown version. When the
      // persisted shape changes, add the old-version → new-version step above.
      throw new GameError(
        'STORAGE_ERROR',
        `Session database schema version ${row.value} is not supported by this server ` +
          `(expected ${SCHEMA_VERSION}). Use a matching server version or a fresh SESSION_DB_PATH.`,
      );
    }
  }

  // Wrap a synchronous DB operation so backend failures surface as
  // GameError('STORAGE_ERROR') with context instead of raw driver errors.
  private run<T>(what: string, fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof GameError) throw e;
      throw new GameError(
        'STORAGE_ERROR',
        `Session store failure (${what}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async saveSession(state: SessionState<unknown>): Promise<void> {
    this.run('save session', () => {
      this.db
        .prepare(
          `INSERT INTO sessions (session_id, game_id, state_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             game_id = excluded.game_id,
             state_json = excluded.state_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          state.sessionId,
          state.gameId,
          JSON.stringify(state),
          state.createdAt,
          new Date().toISOString(),
        );
    });
    this.cache.set(state.sessionId, state);
    this.knownMissing.delete(state.sessionId);
  }

  async getSession(sessionId: string): Promise<SessionState<unknown> | null> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    if (this.knownMissing.has(sessionId)) return null;
    const row = this.run('get session', () =>
      this.db.prepare('SELECT state_json FROM sessions WHERE session_id = ?').get(sessionId),
    ) as { state_json: string } | undefined;
    if (row === undefined) {
      this.knownMissing.add(sessionId);
      return null;
    }
    const state = JSON.parse(row.state_json) as SessionState<unknown>;
    // Cache the parsed object so every later getSession returns this same
    // reference (restores Map aliasing semantics after the cache miss).
    this.cache.set(sessionId, state);
    return state;
  }

  async getSessionsForGame(gameId: string): Promise<SessionState<unknown>[]> {
    const rows = this.run('list sessions', () =>
      this.db
        .prepare('SELECT session_id, state_json FROM sessions WHERE game_id = ? ORDER BY created_at')
        .all(gameId),
    ) as Array<{ session_id: string; state_json: string }>;
    return rows.map((row) => {
      // Cache wins: if a live object exists, return it (it may be ahead of
      // the row if a save is somehow in flight; same-object semantics matter
      // more). Seed the cache for misses.
      const cached = this.cache.get(row.session_id);
      if (cached) return cached;
      const state = JSON.parse(row.state_json) as SessionState<unknown>;
      this.cache.set(row.session_id, state);
      return state;
    });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const existed = this.run('delete session', () => {
      this.db.prepare('DELETE FROM undo_snapshots WHERE session_id = ?').run(sessionId);
      const res = this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
      return res.changes > 0;
    });
    this.cache.delete(sessionId);
    this.knownMissing.add(sessionId);
    return existed;
  }

  async pushUndoSnapshot(
    sessionId: string,
    snapshot: SessionState<unknown>,
    moverKind: string | null,
    limit: number,
  ): Promise<void> {
    this.run('push undo snapshot', () => {
      const next = this.db
        .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM undo_snapshots WHERE session_id = ?')
        .get(sessionId) as { next: number };
      this.db
        .prepare(
          `INSERT INTO undo_snapshots (session_id, position, mover_kind, snapshot_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(sessionId, next.next, moverKind, JSON.stringify(snapshot), new Date().toISOString());
      // Trim the OLDEST entries past the limit. Portable (no SQLite-specific
      // DELETE ... ORDER BY): subselect the excess oldest positions.
      const count = this.db
        .prepare('SELECT COUNT(*) AS n FROM undo_snapshots WHERE session_id = ?')
        .get(sessionId) as { n: number };
      if (count.n > limit) {
        this.db
          .prepare(
            `DELETE FROM undo_snapshots
             WHERE session_id = ? AND position IN (
               SELECT position FROM undo_snapshots
               WHERE session_id = ? ORDER BY position ASC LIMIT ?
             )`,
          )
          .run(sessionId, sessionId, count.n - limit);
      }
    });
  }

  async listUndoMeta(sessionId: string): Promise<UndoEntryMeta[]> {
    const rows = this.run('list undo meta', () =>
      this.db
        .prepare(
          'SELECT position, mover_kind FROM undo_snapshots WHERE session_id = ? ORDER BY position ASC',
        )
        .all(sessionId),
    ) as Array<{ position: number; mover_kind: string | null }>;
    return rows;
  }

  async getUndoSnapshot(
    sessionId: string,
    position: number,
  ): Promise<SessionState<unknown> | null> {
    const row = this.run('get undo snapshot', () =>
      this.db
        .prepare('SELECT snapshot_json FROM undo_snapshots WHERE session_id = ? AND position = ?')
        .get(sessionId, position),
    ) as { snapshot_json: string } | undefined;
    if (row === undefined) return null;
    return JSON.parse(row.snapshot_json) as SessionState<unknown>;
  }

  async truncateUndoFrom(sessionId: string, fromPosition: number): Promise<void> {
    this.run('truncate undo', () => {
      this.db
        .prepare('DELETE FROM undo_snapshots WHERE session_id = ? AND position >= ?')
        .run(sessionId, fromPosition);
    });
  }

  async undoDepth(sessionId: string): Promise<number> {
    const row = this.run('undo depth', () =>
      this.db.prepare('SELECT COUNT(*) AS n FROM undo_snapshots WHERE session_id = ?').get(sessionId),
    ) as { n: number };
    return row.n;
  }

  async close(): Promise<void> {
    this.run('close', () => this.db.close());
    this.cache.clear();
    this.knownMissing.clear();
  }
}
