import { resolve } from 'node:path';
import { MemorySessionStore } from './memory.js';
import { MongoSessionStore } from './mongo.js';
import { SqliteSessionStore } from './sqlite.js';
import type { SessionStore } from './types.js';

export const DEFAULT_DB_PATH = './data/sessions.db';
export const DEFAULT_MONGODB_URI = 'mongodb://localhost:27017';
export const DEFAULT_MONGODB_DB = 'zekel';

// Pick the session store from the environment. Persistence is the DEFAULT —
// sessions survive server restarts unless explicitly opted out:
//   SESSION_STORE   'mongodb' (default) | 'sqlite' | 'memory'
//   MONGODB_URI     connection string, default mongodb://localhost:27017
//   MONGODB_DB      database name, default 'zekel'
//   SESSION_DB_PATH sqlite file path, default ./data/sessions.db (cwd-relative)
// The mongodb default FAILS FAST at startup if no mongod is reachable —
// deliberate, so a missing database surfaces immediately instead of mid-game;
// SESSION_STORE=sqlite gives a zero-dependency embedded fallback.
// The harness, smoke test, and unit tests run with the memory store so AI
// batches never pollute the persistent DB.
export async function createSessionStoreFromEnv(): Promise<{
  store: SessionStore;
  description: string;
}> {
  const kind = (process.env.SESSION_STORE ?? 'mongodb').toLowerCase();
  switch (kind) {
    case 'mongodb': {
      const uri = process.env.MONGODB_URI ?? DEFAULT_MONGODB_URI;
      const dbName = process.env.MONGODB_DB ?? DEFAULT_MONGODB_DB;
      const store = new MongoSessionStore(uri, dbName);
      await store.connect(); // fail fast: ping + indexes + schema-version guard
      return { store, description: `mongodb (${uri}, db: ${dbName})` };
    }
    case 'sqlite': {
      const dbPath = resolve(process.env.SESSION_DB_PATH ?? DEFAULT_DB_PATH);
      return { store: new SqliteSessionStore(dbPath), description: `sqlite (${dbPath})` };
    }
    case 'memory':
      return { store: new MemorySessionStore(), description: 'memory' };
    default:
      throw new Error(`Unknown SESSION_STORE="${kind}". Expected "mongodb", "sqlite", or "memory".`);
  }
}
