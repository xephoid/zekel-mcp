// Cross-game undo lives in the session facade (sessions.ts) — the MCP move tools push
// a pre-move snapshot, and the `undo` tool pops it. These tests cover that core logic
// game-agnostically with a minimal fake SessionState, parametrized over every store
// backend so the sweep logic is locked against each (the facade's undo sweep operates
// on store metadata, so a backend bug would surface here).

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { SessionState } from '@zekel/game-kit';
import {
  saveSession,
  getSession,
  deleteSession,
  recordUndoSnapshot,
  undoSession,
  undoDepth,
  setSessionStore,
} from '../sessions.js';
import { MemorySessionStore } from '../store/memory.js';
import { SqliteSessionStore } from '../store/sqlite.js';
import type { SessionStore } from '../store/types.js';

let counter = 0;
function makeSession(activePlayer = 'p1', state: Record<string, unknown> = {}): SessionState<unknown> {
  return {
    sessionId: `test-${counter++}`,
    gameId: 'fake-game',
    players: [
      { player_id: 'p1', kind: 'human' },
      { player_id: 'p2', kind: 'human' },
      { player_id: 'ai1', kind: 'ai' },
    ],
    activePlayerId: activePlayer,
    turnNumber: 0,
    gameState: state,
    moveLog: [],
    createdAt: 'now',
  };
}

const BACKENDS: Array<{ name: string; makeStore: () => SessionStore }> = [
  { name: 'memory', makeStore: () => new MemorySessionStore() },
  { name: 'sqlite', makeStore: () => new SqliteSessionStore(':memory:') },
];

afterAll(() => {
  // Other suites in the same worker share the module singleton — reset it.
  setSessionStore(new MemorySessionStore());
});

describe.each(BACKENDS)('session undo stack ($name store)', ({ makeStore }) => {
  beforeEach(() => {
    setSessionStore(makeStore());
  });

  it('restores the snapshot recorded before a move', async () => {
    const s1 = makeSession('p1', { score: 0 });
    await saveSession(s1);
    await recordUndoSnapshot(s1); // pre-move snapshot

    const s2 = { ...s1, activePlayerId: 'p2', gameState: { score: 5 } };
    await saveSession(s2);
    expect(((await getSession(s1.sessionId)).gameState as { score: number }).score).toBe(5);

    const result = await undoSession(s1.sessionId);
    expect(result).not.toBeNull();
    expect(result!.restored.activePlayerId).toBe('p1');
    expect(result!.reverted).toBe(1);
    expect(((await getSession(s1.sessionId)).gameState as { score: number }).score).toBe(0);
  });

  it('snapshots are isolated — later mutation of the live state does not leak in', async () => {
    const s = makeSession('p1', { items: ['a'] });
    await saveSession(s);
    await recordUndoSnapshot(s);
    (s.gameState as { items: string[] }).items.push('b'); // mutate AFTER snapshot
    await saveSession({ ...s, activePlayerId: 'p2' });

    const restored = (await undoSession(s.sessionId))!.restored;
    expect((restored.gameState as { items: string[] }).items).toEqual(['a']); // not ['a','b']
  });

  it('supports multi-level undo (stack) and reports remaining depth', async () => {
    const a = makeSession('p1', { n: 0 });
    await saveSession(a);
    await recordUndoSnapshot(a);
    await saveSession({ ...a, gameState: { n: 1 } });
    await recordUndoSnapshot(await getSession(a.sessionId));
    await saveSession({ ...a, gameState: { n: 2 } });

    expect(await undoDepth(a.sessionId)).toBe(2);
    expect(((await undoSession(a.sessionId))!.restored.gameState as { n: number }).n).toBe(1);
    expect(await undoDepth(a.sessionId)).toBe(1);
    expect(((await undoSession(a.sessionId))!.restored.gameState as { n: number }).n).toBe(0);
    expect(await undoDepth(a.sessionId)).toBe(0);
  });

  it('ONE undo reverts a human move AND the AI moves that followed it', async () => {
    const s = makeSession('p1', { n: 0 });
    await saveSession(s);
    await recordUndoSnapshot({ ...s, activePlayerId: 'p1', gameState: { n: 0 } }); // pre human move
    await recordUndoSnapshot({ ...s, activePlayerId: 'ai1', gameState: { n: 1 } }); // pre AI move
    await saveSession({ ...s, activePlayerId: 'p1', gameState: { n: 2 } }); // after AI

    const result = (await undoSession(s.sessionId))!;
    expect(result.reverted).toBe(2); // swept the AI move + the human move
    expect(result.restored.activePlayerId).toBe('p1');
    expect((result.restored.gameState as { n: number }).n).toBe(0); // back to before the human move
    expect(await undoDepth(s.sessionId)).toBe(0);
  });

  it('with multiple humans, the sweep reverts only the LAST human turn + its AI moves', async () => {
    // Turn order: p1 plays, p2 plays, then the AI responds to p2. An undo should
    // roll back p2's turn and the AI move it triggered, but PRESERVE p1's turn.
    const s = makeSession('p1', { n: 0 });
    await saveSession(s);
    await recordUndoSnapshot({ ...s, activePlayerId: 'p1', gameState: { n: 0 } }); // pre p1 move
    await recordUndoSnapshot({ ...s, activePlayerId: 'p2', gameState: { n: 1 } }); // pre p2 move
    await recordUndoSnapshot({ ...s, activePlayerId: 'ai1', gameState: { n: 2 } }); // pre AI move
    await saveSession({ ...s, activePlayerId: 'p1', gameState: { n: 3 } }); // after AI

    const result = (await undoSession(s.sessionId))!;
    expect(result.reverted).toBe(2); // p2's move + the AI move — NOT p1's
    expect(result.restored.activePlayerId).toBe('p2'); // anchored on p2's snapshot
    expect((result.restored.gameState as { n: number }).n).toBe(1); // p1's turn (n:0→1) is intact
    expect(await undoDepth(s.sessionId)).toBe(1); // p1's pre-move snapshot remains

    // A second undo then steps back over p1's turn.
    const result2 = (await undoSession(s.sessionId))!;
    expect(result2.reverted).toBe(1);
    expect((result2.restored.gameState as { n: number }).n).toBe(0);
  });

  it('returns null when there is nothing to undo', async () => {
    const s = makeSession();
    await saveSession(s);
    expect(await undoSession(s.sessionId)).toBeNull();
  });

  it('deleting a session clears its undo history', async () => {
    const s = makeSession();
    await saveSession(s);
    await recordUndoSnapshot(s);
    expect(await undoDepth(s.sessionId)).toBe(1);
    await deleteSession(s.sessionId);
    expect(await undoDepth(s.sessionId)).toBe(0);
    expect(await undoSession(s.sessionId)).toBeNull();
  });
});
