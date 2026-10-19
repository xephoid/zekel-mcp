import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoSessionStore } from '../store/mongo.js';
import { runSessionStoreContract, makeContractSession } from './sessionStoreContract.js';
import { luckyTicTacToe } from '../../mcp/__tests__/luckyTicTacToe.js';
import { GameError } from '@zekel/game-kit';

const URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';

// Each store gets its own throwaway database so tests are isolated and a
// dropped DB is the whole cleanup. Dropping happens in close(), which the
// shared contract suite already calls in its afterEach.
function testDbName(): string {
  return `zekel_test_${randomUUID().replaceAll('-', '')}`;
}

class TestMongoStore extends MongoSessionStore {
  override async close(): Promise<void> {
    try {
      await this.dropDatabaseForTests();
    } catch {
      // already closed / never connected — nothing to drop
    }
    await super.close();
  }
}

async function makeTestStore(): Promise<TestMongoStore> {
  const store = new TestMongoStore(URI, testDbName());
  await store.connect();
  return store;
}

// These tests need a reachable mongod (the production DEFAULT store). Probe
// once and skip the whole file gracefully when absent rather than failing —
// the contract itself is also locked by the memory/sqlite suites.
async function mongoAvailable(): Promise<boolean> {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 1500 });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}
const available = await mongoAvailable();

if (!available) {
  describe.skip(`MongoSessionStore (SKIPPED: no mongod reachable at ${URI})`, () => {
    it('skipped', () => {});
  });
} else {
  // The full behavioral contract, against a throwaway database.
  runSessionStoreContract('MongoSessionStore', makeTestStore);

  describe('MongoSessionStore persistence', () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const fn of cleanups.splice(0)) await fn();
    });

    it('sessions and undo snapshots survive close + reconnect (server restart)', async () => {
      const dbName = testDbName();
      const store1 = new MongoSessionStore(URI, dbName);
      await store1.connect();
      const s = makeContractSession('fake-game', { board: { pieces: ['a', 'b'] }, score: 12 });
      await store1.saveSession(s);
      await store1.pushUndoSnapshot(s.sessionId, { ...s, turnNumber: 1 }, 'human', 50);
      await store1.pushUndoSnapshot(s.sessionId, { ...s, turnNumber: 2 }, 'ai', 50);
      await store1.close();

      const store2 = new MongoSessionStore(URI, dbName);
      await store2.connect();
      cleanups.push(async () => {
        await store2.dropDatabaseForTests();
        await store2.close();
      });
      const loaded = await store2.getSession(s.sessionId);
      expect(loaded).toEqual(s);
      expect(await store2.undoDepth(s.sessionId)).toBe(2);
      const meta = await store2.listUndoMeta(s.sessionId);
      expect(meta.map((m) => m.mover_kind)).toEqual(['human', 'ai']);
      const snap = await store2.getUndoSnapshot(s.sessionId, meta[1]!.position);
      expect(snap!.turnNumber).toBe(2);
    });

    it('round-trips a real game state with full fidelity (Lucky Tic-Tac-Toe)', async () => {
      const session = luckyTicTacToe.createSession(
        [
          { player_id: 'ai-1', kind: 'ai' as const },
          { player_id: 'ai-2', kind: 'ai' as const },
        ],
        { seed: 7 },
      );
      session.sessionId = 'fidelity-test';

      const dbName = testDbName();
      const store1 = new MongoSessionStore(URI, dbName);
      await store1.connect();
      await store1.saveSession(session);
      await store1.close();

      const store2 = new MongoSessionStore(URI, dbName);
      await store2.connect();
      cleanups.push(async () => {
        await store2.dropDatabaseForTests();
        await store2.close();
      });
      const loaded = await store2.getSession('fidelity-test');
      expect(loaded).toEqual(session);
    });

    it('refuses to open a database written by an unknown schema version', async () => {
      const dbName = testDbName();
      const store1 = new MongoSessionStore(URI, dbName);
      await store1.connect();
      await store1.close();

      // Simulate a DB from a future server version.
      const raw = new MongoClient(URI);
      await raw.connect();
      await raw
        .db(dbName)
        .collection('schema_meta')
        .updateOne({ _id: 'schema_version' as never }, { $set: { value: '999' } });
      cleanups.push(async () => {
        await raw.db(dbName).dropDatabase();
        await raw.close();
      });

      const store2 = new MongoSessionStore(URI, dbName);
      await expect(store2.connect()).rejects.toThrowError(GameError);
      await store2.close();
      const store3 = new MongoSessionStore(URI, dbName);
      await expect(store3.connect()).rejects.toThrowError(/schema version 999/);
      await store3.close();
    });

    it('getSession returns the SAME object reference across calls (cache semantics)', async () => {
      const store = await makeTestStore();
      cleanups.push(() => store.close());
      const s = makeContractSession();
      await store.saveSession(s);
      const a = await store.getSession(s.sessionId);
      const b = await store.getSession(s.sessionId);
      expect(a).toBe(s); // the saved live object IS the cached object
      expect(b).toBe(a);
    });

    it('connect() fails fast with STORAGE_ERROR when no mongod is reachable', async () => {
      // Port 1 is never a mongod; serverSelectionTimeoutMS caps the wait.
      const store = new MongoSessionStore('mongodb://localhost:1', testDbName());
      await expect(store.connect()).rejects.toThrowError(GameError);
      await expect(
        new MongoSessionStore('mongodb://localhost:1', testDbName()).connect(),
      ).rejects.toThrowError(/SESSION_STORE=sqlite\|memory/);
    }, 15000);
  });
}
