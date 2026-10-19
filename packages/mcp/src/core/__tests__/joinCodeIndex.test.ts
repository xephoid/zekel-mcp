// The multi-device join-code index must survive a server restart: the code is
// persisted on SessionState.joinCode, and rebuildJoinCodeIndex repopulates the
// in-memory lookup at startup. These exercise that against a real on-disk SQLite
// store (a genuine "restart" = a fresh store instance over the same file), plus
// the lazy backfill on load and the release on delete.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../store/sqlite.js';
import { makeContractSession } from './sessionStoreContract.js';
import {
  deleteSession,
  getSession,
  rebuildJoinCodeIndex,
  resolveJoinCode,
  setSessionStore,
} from '../sessions.js';

const tempDirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zekel-joincode-'));
  tempDirs.push(dir);
  return join(dir, 'sessions.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('join-code index survives restart', () => {
  it('rebuilds outstanding codes from persisted sessions', async () => {
    const dbPath = tempDbPath();

    // --- "before restart": a session with a join code is persisted. ---
    const store1 = new SqliteSessionStore(dbPath);
    setSessionStore(store1);
    const s = makeContractSession('dragonwood');
    s.sessionId = 'sess-restart';
    s.joinCode = 'ABCD';
    await store1.saveSession(s);
    await store1.close();

    // --- "after restart": a fresh store + an empty index. The code is NOT yet
    // resolvable (the in-memory index started cold)... ---
    const store2 = new SqliteSessionStore(dbPath);
    setSessionStore(store2);
    expect(resolveJoinCode('ABCD')).toBeUndefined();

    // ...until the startup rebuild scans persisted sessions.
    const restored = await rebuildJoinCodeIndex(['dragonwood']);
    expect(restored).toBeGreaterThanOrEqual(1);
    expect(resolveJoinCode('ABCD')).toBe('sess-restart');
    await store2.close();
  });

  it('lazily backfills the index when a coded session is loaded by id', async () => {
    const store = new SqliteSessionStore(tempDbPath());
    setSessionStore(store);
    const s = makeContractSession('dragonwood');
    s.sessionId = 'sess-lazy';
    s.joinCode = 'EFGH';
    await store.saveSession(s);

    expect(resolveJoinCode('EFGH')).toBeUndefined();
    await getSession('sess-lazy');
    expect(resolveJoinCode('EFGH')).toBe('sess-lazy');
    await store.close();
  });

  it('releases the code when its session is deleted', async () => {
    const store = new SqliteSessionStore(tempDbPath());
    setSessionStore(store);
    const s = makeContractSession('dragonwood');
    s.sessionId = 'sess-del';
    s.joinCode = 'JKMN';
    await store.saveSession(s);
    await getSession('sess-del'); // backfills the index

    expect(resolveJoinCode('JKMN')).toBe('sess-del');
    await deleteSession('sess-del');
    expect(resolveJoinCode('JKMN')).toBeUndefined();
    await store.close();
  });
});
