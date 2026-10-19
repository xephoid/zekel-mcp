// MongoDB-backed SessionStore (official `mongodb` driver). The DEFAULT
// persistent store: requires a reachable mongod (local by default —
// MONGODB_URI / MONGODB_DB override). connect() fails fast with a clear
// error so a missing database surfaces at server startup, not mid-game.
//
// PAYLOAD ENCODING: session states and undo snapshots are stored as JSON
// STRINGS (state_json / snapshot_json), exactly like the SQLite adapter —
// NOT as native BSON subdocuments. Deliberate: game states are free-form
// JSON whose record keys we don't control (BSON historically restricts
// '$'/'.'-prefixed keys), we only ever load whole sessions (no queries into
// the state), and string round-tripping gives bit-identical fidelity
// guarantees across every adapter. Don't "optimize" this into subdocuments.
//
// SINGLE-PROCESS OWNERSHIP: like the SQLite adapter, getSession keeps a
// write-through cache that returns the SAME live object reference on every
// call (Map semantics — the MCP layer and game modules were written against
// this). One server process owns the data; the cache is not multi-process
// coherent.
//
// DURABILITY: every write is awaited against the server with the driver's
// default write concern (w:1) — when a tool response goes out, mongod has
// acknowledged the write.

import { MongoClient, type Collection, type Db } from 'mongodb';
import type { SessionState } from '@zekel/game-kit';
import { GameError } from '@zekel/game-kit';
import { SESSION_SCHEMA_VERSION, type SessionStore, type UndoEntryMeta } from './types.js';

interface SessionDoc {
  _id: string; // sessionId
  game_id: string;
  state_json: string;
  created_at: string;
  updated_at: string;
}

interface UndoDoc {
  session_id: string;
  position: number;
  mover_kind: string | null;
  snapshot_json: string;
  created_at: string;
}

interface MetaDoc {
  _id: string;
  value: string;
}

export class MongoSessionStore implements SessionStore {
  private readonly client: MongoClient;
  private readonly dbName: string;
  private db!: Db;
  private sessions!: Collection<SessionDoc>;
  private undoSnapshots!: Collection<UndoDoc>;
  private connected = false;
  // Write-through cache: sessionId → the live session object. See header.
  private readonly cache = new Map<string, SessionState<unknown>>();
  private readonly knownMissing = new Set<string>();

  constructor(uri: string, dbName: string) {
    this.dbName = dbName;
    // Short selection timeout so a missing mongod fails the startup ping in
    // seconds, not the driver's 30s default.
    this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 4000 });
  }

  /** Connect, ping, ensure indexes, and enforce the schema-version guard.
   *  Must be awaited (fromEnv does) before the store is used. */
  async connect(): Promise<void> {
    try {
      await this.client.connect();
      this.db = this.client.db(this.dbName);
      await this.db.command({ ping: 1 });
      this.sessions = this.db.collection<SessionDoc>('sessions');
      this.undoSnapshots = this.db.collection<UndoDoc>('undo_snapshots');
      await this.sessions.createIndex({ game_id: 1 });
      await this.undoSnapshots.createIndex({ session_id: 1, position: 1 }, { unique: true });
      await this.migrate();
      this.connected = true;
    } catch (e) {
      if (e instanceof GameError) throw e;
      throw new GameError(
        'STORAGE_ERROR',
        `Failed to connect to MongoDB (db "${this.dbName}"): ` +
          `${e instanceof Error ? e.message : String(e)}. ` +
          `Is mongod running? Set MONGODB_URI, or use SESSION_STORE=sqlite|memory to opt out of MongoDB.`,
      );
    }
  }

  private async migrate(): Promise<void> {
    const meta = this.db.collection<MetaDoc>('schema_meta');
    const row = await meta.findOne({ _id: 'schema_version' });
    if (row === null) {
      await meta.insertOne({ _id: 'schema_version', value: SESSION_SCHEMA_VERSION });
      return;
    }
    if (row.value === '1' && SESSION_SCHEMA_VERSION === '2') {
      // 1 → 2: only Adventurer Olympics' state changed shape, and its old
      // documents cannot be converted (see types.ts). Every document —
      // sessions and undo snapshots alike — is kept as-is: other games'
      // documents are unchanged by this version, and an old Adventurer
      // Olympics document is refused on its own when loaded
      // (adventurer-olympics/index.ts assertCurrentFormat), so it never blocks
      // the rest of the database.
      await meta.updateOne({ _id: 'schema_version' }, { $set: { value: '2' } });
      return;
    }
    if (row.value !== SESSION_SCHEMA_VERSION) {
      // Refuse rather than misread documents written by an unknown version.
      // When the persisted shape changes, add the old → new step above.
      throw new GameError(
        'STORAGE_ERROR',
        `Session database schema version ${row.value} is not supported by this server ` +
          `(expected ${SESSION_SCHEMA_VERSION}). Use a matching server version or a fresh MONGODB_DB.`,
      );
    }
  }

  // Wrap a DB operation so backend failures surface as
  // GameError('STORAGE_ERROR') with context instead of raw driver errors.
  private async run<T>(what: string, fn: () => Promise<T>): Promise<T> {
    if (!this.connected) {
      throw new GameError('STORAGE_ERROR', `Session store used before connect() (${what})`);
    }
    try {
      return await fn();
    } catch (e) {
      if (e instanceof GameError) throw e;
      throw new GameError(
        'STORAGE_ERROR',
        `Session store failure (${what}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async saveSession(state: SessionState<unknown>): Promise<void> {
    await this.run('save session', () =>
      this.sessions.updateOne(
        { _id: state.sessionId },
        {
          $set: {
            game_id: state.gameId,
            state_json: JSON.stringify(state),
            updated_at: new Date().toISOString(),
          },
          $setOnInsert: { created_at: state.createdAt },
        },
        { upsert: true },
      ),
    );
    this.cache.set(state.sessionId, state);
    this.knownMissing.delete(state.sessionId);
  }

  async getSession(sessionId: string): Promise<SessionState<unknown> | null> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    if (this.knownMissing.has(sessionId)) return null;
    const doc = await this.run('get session', () => this.sessions.findOne({ _id: sessionId }));
    if (doc === null) {
      this.knownMissing.add(sessionId);
      return null;
    }
    const state = JSON.parse(doc.state_json) as SessionState<unknown>;
    // Cache the parsed object so every later getSession returns this same
    // reference (restores Map aliasing semantics after the cache miss).
    this.cache.set(sessionId, state);
    return state;
  }

  async getSessionsForGame(gameId: string): Promise<SessionState<unknown>[]> {
    const docs = await this.run('list sessions', () =>
      this.sessions.find({ game_id: gameId }).sort({ created_at: 1 }).toArray(),
    );
    return docs.map((doc) => {
      // Cache wins (same-object semantics); seed the cache for misses.
      const cached = this.cache.get(doc._id);
      if (cached) return cached;
      const state = JSON.parse(doc.state_json) as SessionState<unknown>;
      this.cache.set(doc._id, state);
      return state;
    });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const existed = await this.run('delete session', async () => {
      await this.undoSnapshots.deleteMany({ session_id: sessionId });
      const res = await this.sessions.deleteOne({ _id: sessionId });
      return res.deletedCount > 0;
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
    await this.run('push undo snapshot', async () => {
      const top = await this.undoSnapshots
        .find({ session_id: sessionId })
        .sort({ position: -1 })
        .limit(1)
        .toArray();
      const position = (top[0]?.position ?? -1) + 1;
      await this.undoSnapshots.insertOne({
        session_id: sessionId,
        position,
        mover_kind: moverKind,
        snapshot_json: JSON.stringify(snapshot),
        created_at: new Date().toISOString(),
      });
      // Trim the OLDEST entries past the limit.
      const count = await this.undoSnapshots.countDocuments({ session_id: sessionId });
      if (count > limit) {
        const excess = await this.undoSnapshots
          .find({ session_id: sessionId })
          .sort({ position: 1 })
          .limit(count - limit)
          .project({ position: 1 })
          .toArray();
        const cutoff = excess[excess.length - 1]!.position as number;
        await this.undoSnapshots.deleteMany({
          session_id: sessionId,
          position: { $lte: cutoff },
        });
      }
    });
  }

  async listUndoMeta(sessionId: string): Promise<UndoEntryMeta[]> {
    const docs = await this.run('list undo meta', () =>
      this.undoSnapshots
        .find({ session_id: sessionId })
        .sort({ position: 1 })
        .project<{ position: number; mover_kind: string | null }>({
          _id: 0,
          position: 1,
          mover_kind: 1,
        })
        .toArray(),
    );
    return docs.map((d) => ({ position: d.position, mover_kind: d.mover_kind ?? null }));
  }

  async getUndoSnapshot(
    sessionId: string,
    position: number,
  ): Promise<SessionState<unknown> | null> {
    const doc = await this.run('get undo snapshot', () =>
      this.undoSnapshots.findOne({ session_id: sessionId, position }),
    );
    if (doc === null) return null;
    return JSON.parse(doc.snapshot_json) as SessionState<unknown>;
  }

  async truncateUndoFrom(sessionId: string, fromPosition: number): Promise<void> {
    await this.run('truncate undo', async () => {
      await this.undoSnapshots.deleteMany({
        session_id: sessionId,
        position: { $gte: fromPosition },
      });
    });
  }

  async undoDepth(sessionId: string): Promise<number> {
    return this.run('undo depth', () =>
      this.undoSnapshots.countDocuments({ session_id: sessionId }),
    );
  }

  /** TEST SUPPORT ONLY: drop the whole database (used by the test suite to
   *  clean up its per-run databases). Never called by production code. */
  async dropDatabaseForTests(): Promise<void> {
    await this.run('drop database', () => this.db.dropDatabase());
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } catch (e) {
      throw new GameError(
        'STORAGE_ERROR',
        `Session store failure (close): ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.connected = false;
      this.cache.clear();
      this.knownMissing.clear();
    }
  }
}
