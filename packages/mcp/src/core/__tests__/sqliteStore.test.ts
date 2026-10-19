import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { SqliteSessionStore } from '../store/sqlite.js';
import { runSessionStoreContract, makeContractSession } from './sessionStoreContract.js';
import { luckyTicTacToe } from '../../mcp/__tests__/luckyTicTacToe.js';
import { GameError } from '@zekel/game-kit';

// Runtime builtin load — see the matching comment in store/sqlite.ts (vite 5
// cannot transform a static `import 'node:sqlite'`).
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

// The full behavioral contract, against an in-memory SQLite database.
runSessionStoreContract('SqliteSessionStore', () => new SqliteSessionStore(':memory:'));

// SQLite-only behavior: actual on-disk persistence across store instances
// (i.e. across server restarts) and the schema-version guard.
describe('SqliteSessionStore persistence', () => {
  const tempDirs: string[] = [];
  function tempDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'zekel-sqlite-'));
    tempDirs.push(dir);
    return join(dir, 'sessions.db');
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('sessions and undo snapshots survive close + reopen (server restart)', async () => {
    const dbPath = tempDbPath();
    const store1 = new SqliteSessionStore(dbPath);
    const s = makeContractSession('fake-game', { board: { pieces: ['a', 'b'] }, score: 12 });
    await store1.saveSession(s);
    await store1.pushUndoSnapshot(s.sessionId, { ...s, turnNumber: 1 }, 'human', 50);
    await store1.pushUndoSnapshot(s.sessionId, { ...s, turnNumber: 2 }, 'ai', 50);
    await store1.close();

    const store2 = new SqliteSessionStore(dbPath);
    const loaded = await store2.getSession(s.sessionId);
    expect(loaded).toEqual(s);
    expect(await store2.undoDepth(s.sessionId)).toBe(2);
    const meta = await store2.listUndoMeta(s.sessionId);
    expect(meta.map((m) => m.mover_kind)).toEqual(['human', 'ai']);
    const snap = await store2.getUndoSnapshot(s.sessionId, meta[1]!.position);
    expect(snap!.turnNumber).toBe(2);
    await store2.close();
  });

  it('round-trips a real game state with full fidelity (Lucky Tic-Tac-Toe)', async () => {
    // The deepest persistence risk is a real game state (nested arrays,
    // nulls, the simulated deck order) surviving JSON → disk → JSON intact.
    const session = luckyTicTacToe.createSession(
      [
        { player_id: 'ai-1', kind: 'ai' as const },
        { player_id: 'ai-2', kind: 'ai' as const },
      ],
      { seed: 7 },
    );
    session.sessionId = 'fidelity-test';

    const dbPath = tempDbPath();
    const store1 = new SqliteSessionStore(dbPath);
    await store1.saveSession(session);
    await store1.close();

    const store2 = new SqliteSessionStore(dbPath);
    const loaded = await store2.getSession('fidelity-test');
    expect(loaded).toEqual(session);
    await store2.close();
  });

  it('refuses to open a database written by an unknown schema version', async () => {
    const dbPath = tempDbPath();
    const store1 = new SqliteSessionStore(dbPath);
    await store1.close();

    // Simulate a DB from a future server version.
    const raw = new DatabaseSync(dbPath);
    raw.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run('999', 'schema_version');
    raw.close();

    expect(() => new SqliteSessionStore(dbPath)).toThrowError(GameError);
    expect(() => new SqliteSessionStore(dbPath)).toThrowError(/schema version 999/);
  });

  it('creates the parent directory for the db path if missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zekel-sqlite-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'nested', 'deeper', 'sessions.db');
    const store = new SqliteSessionStore(dbPath);
    const s = makeContractSession();
    await store.saveSession(s);
    expect(await store.getSession(s.sessionId)).toEqual(s);
    await store.close();
  });

  it('getSession returns the SAME object reference across calls (cache semantics)', async () => {
    // The MCP layer was written against Map aliasing semantics; the store
    // must not hand out fresh parsed copies per call within one process.
    const store = new SqliteSessionStore(':memory:');
    const s = makeContractSession();
    await store.saveSession(s);
    const a = await store.getSession(s.sessionId);
    const b = await store.getSession(s.sessionId);
    expect(a).toBe(s); // the saved live object IS the cached object
    expect(b).toBe(a);
    await store.close();
  });
});
