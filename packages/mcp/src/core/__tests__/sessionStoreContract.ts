// Shared behavioral contract for SessionStore implementations. NOT a test file
// itself (no .test.ts suffix, so vitest's include skips it) — memoryStore.test.ts
// and sqliteStore.test.ts each run it against their backend. Any future adapter
// (e.g. Postgres) should pass this suite unchanged.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SessionState } from '@zekel/game-kit';
import type { SessionStore } from '../store/types.js';

let counter = 0;
export function makeContractSession(
  gameId = 'fake-game',
  state: Record<string, unknown> = {},
): SessionState<unknown> {
  return {
    sessionId: `contract-${counter++}`,
    gameId,
    players: [
      { player_id: 'p1', kind: 'human' },
      { player_id: 'ai1', kind: 'ai' },
    ],
    activePlayerId: 'p1',
    turnNumber: 1,
    gameState: state,
    moveLog: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

export function runSessionStoreContract(
  name: string,
  makeStore: () => SessionStore | Promise<SessionStore>,
): void {
  describe(`SessionStore contract: ${name}`, () => {
    let store: SessionStore;

    beforeEach(async () => {
      store = await makeStore();
    });

    afterEach(async () => {
      await store.close();
    });

    it('save/get round-trips a session', async () => {
      const s = makeContractSession('fake-game', { nested: { deck: [1, 2, 3], flag: true } });
      await store.saveSession(s);
      const loaded = await store.getSession(s.sessionId);
      expect(loaded).not.toBeNull();
      expect(loaded).toEqual(s);
    });

    it('getSession returns null for an unknown id', async () => {
      expect(await store.getSession('no-such-session')).toBeNull();
    });

    it('repeated saves overwrite (upsert), not duplicate', async () => {
      const s = makeContractSession();
      await store.saveSession(s);
      await store.saveSession({ ...s, turnNumber: 7 });
      const loaded = await store.getSession(s.sessionId);
      expect(loaded!.turnNumber).toBe(7);
      const all = await store.getSessionsForGame(s.gameId);
      expect(all.filter((x) => x.sessionId === s.sessionId)).toHaveLength(1);
    });

    it('getSessionsForGame filters by game id', async () => {
      const a = makeContractSession('game-a');
      const b = makeContractSession('game-b');
      const a2 = makeContractSession('game-a');
      await store.saveSession(a);
      await store.saveSession(b);
      await store.saveSession(a2);
      const forA = await store.getSessionsForGame('game-a');
      expect(forA.map((s) => s.sessionId).sort()).toEqual([a.sessionId, a2.sessionId].sort());
      expect(await store.getSessionsForGame('game-c')).toEqual([]);
    });

    it('deleteSession removes the session AND its undo history', async () => {
      const s = makeContractSession();
      await store.saveSession(s);
      await store.pushUndoSnapshot(s.sessionId, s, 'human', 50);
      expect(await store.deleteSession(s.sessionId)).toBe(true);
      expect(await store.getSession(s.sessionId)).toBeNull();
      expect(await store.undoDepth(s.sessionId)).toBe(0);
      expect(await store.listUndoMeta(s.sessionId)).toEqual([]);
      // Deleting again reports false.
      expect(await store.deleteSession(s.sessionId)).toBe(false);
    });

    it('undo snapshots: push/list/get/depth semantics, oldest-first order', async () => {
      const s = makeContractSession();
      await store.pushUndoSnapshot(s.sessionId, { ...s, turnNumber: 1 }, 'human', 50);
      await store.pushUndoSnapshot(s.sessionId, { ...s, turnNumber: 2 }, 'ai', 50);
      await store.pushUndoSnapshot(s.sessionId, { ...s, turnNumber: 3 }, null, 50);

      expect(await store.undoDepth(s.sessionId)).toBe(3);
      const meta = await store.listUndoMeta(s.sessionId);
      expect(meta).toHaveLength(3);
      expect(meta.map((m) => m.mover_kind)).toEqual(['human', 'ai', null]);
      // Positions strictly increase bottom→top.
      expect(meta[0]!.position).toBeLessThan(meta[1]!.position);
      expect(meta[1]!.position).toBeLessThan(meta[2]!.position);

      const body = await store.getUndoSnapshot(s.sessionId, meta[1]!.position);
      expect(body!.turnNumber).toBe(2);
      expect(await store.getUndoSnapshot(s.sessionId, 999_999)).toBeNull();
    });

    it('truncateUndoFrom deletes the given position and everything after it', async () => {
      const s = makeContractSession();
      await store.pushUndoSnapshot(s.sessionId, { ...s, turnNumber: 1 }, 'human', 50);
      await store.pushUndoSnapshot(s.sessionId, { ...s, turnNumber: 2 }, 'ai', 50);
      await store.pushUndoSnapshot(s.sessionId, { ...s, turnNumber: 3 }, 'ai', 50);
      const meta = await store.listUndoMeta(s.sessionId);

      await store.truncateUndoFrom(s.sessionId, meta[1]!.position);
      const after = await store.listUndoMeta(s.sessionId);
      expect(after).toHaveLength(1);
      expect(after[0]!.position).toBe(meta[0]!.position);
      const body = await store.getUndoSnapshot(s.sessionId, meta[0]!.position);
      expect(body!.turnNumber).toBe(1);
    });

    it('positions stay stable across trims (never renumbered)', async () => {
      const s = makeContractSession();
      // Limit 2: pushing a third entry trims the oldest, but the survivors
      // keep their original positions.
      await store.pushUndoSnapshot(s.sessionId, { ...s, turnNumber: 1 }, 'human', 2);
      await store.pushUndoSnapshot(s.sessionId, { ...s, turnNumber: 2 }, 'human', 2);
      const before = await store.listUndoMeta(s.sessionId);
      await store.pushUndoSnapshot(s.sessionId, { ...s, turnNumber: 3 }, 'human', 2);

      const after = await store.listUndoMeta(s.sessionId);
      expect(after).toHaveLength(2);
      expect(after[0]!.position).toBe(before[1]!.position); // survivor unchanged
      expect(after[1]!.position).toBeGreaterThan(after[0]!.position);
      expect((await store.getUndoSnapshot(s.sessionId, after[0]!.position))!.turnNumber).toBe(2);
      expect((await store.getUndoSnapshot(s.sessionId, after[1]!.position))!.turnNumber).toBe(3);
    });

    it('trim at the limit drops the OLDEST entries', async () => {
      const s = makeContractSession();
      for (let i = 1; i <= 55; i++) {
        await store.pushUndoSnapshot(s.sessionId, { ...s, turnNumber: i }, 'human', 50);
      }
      expect(await store.undoDepth(s.sessionId)).toBe(50);
      const meta = await store.listUndoMeta(s.sessionId);
      const bottom = await store.getUndoSnapshot(s.sessionId, meta[0]!.position);
      const top = await store.getUndoSnapshot(s.sessionId, meta[meta.length - 1]!.position);
      expect(bottom!.turnNumber).toBe(6); // 1..5 trimmed
      expect(top!.turnNumber).toBe(55);
    });

    it('snapshot isolation: mutating the live state after push does not change the snapshot', async () => {
      const s = makeContractSession('fake-game', { items: ['a'] });
      await store.pushUndoSnapshot(s.sessionId, s, 'human', 50);
      (s.gameState as { items: string[] }).items.push('b');
      s.turnNumber = 99;

      const meta = await store.listUndoMeta(s.sessionId);
      const snap = await store.getUndoSnapshot(s.sessionId, meta[0]!.position);
      expect((snap!.gameState as { items: string[] }).items).toEqual(['a']);
      expect(snap!.turnNumber).toBe(1);
    });

    it('undo state is per-session — sessions do not interfere', async () => {
      const a = makeContractSession();
      const b = makeContractSession();
      await store.pushUndoSnapshot(a.sessionId, a, 'human', 50);
      await store.pushUndoSnapshot(b.sessionId, b, 'ai', 50);
      await store.pushUndoSnapshot(b.sessionId, b, 'ai', 50);
      expect(await store.undoDepth(a.sessionId)).toBe(1);
      expect(await store.undoDepth(b.sessionId)).toBe(2);
      await store.truncateUndoFrom(b.sessionId, 0);
      expect(await store.undoDepth(a.sessionId)).toBe(1);
    });
  });
}
