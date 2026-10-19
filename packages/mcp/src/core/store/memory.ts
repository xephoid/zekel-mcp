import type { SessionState } from '@zekel/game-kit';
import type { SessionStore, UndoEntryMeta } from './types.js';

type UndoEntry = {
  position: number;
  mover_kind: string | null;
  snapshot: SessionState<unknown>;
};

// In-memory store — behavior-identical to the original module-level Maps in
// sessions.ts. Used by unit tests, the AI harness, and any run with
// SESSION_STORE=memory. Sessions die with the process.
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionState<unknown>>();
  private readonly undoStacks = new Map<string, UndoEntry[]>();
  // Monotonic per-session position counter; never reset by trims, so
  // positions stay stable for the lifetime of the session.
  private readonly nextPosition = new Map<string, number>();

  async saveSession(state: SessionState<unknown>): Promise<void> {
    this.sessions.set(state.sessionId, state);
  }

  async getSession(sessionId: string): Promise<SessionState<unknown> | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async getSessionsForGame(gameId: string): Promise<SessionState<unknown>[]> {
    return Array.from(this.sessions.values()).filter((s) => s.gameId === gameId);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    this.undoStacks.delete(sessionId);
    this.nextPosition.delete(sessionId);
    return this.sessions.delete(sessionId);
  }

  async pushUndoSnapshot(
    sessionId: string,
    snapshot: SessionState<unknown>,
    moverKind: string | null,
    limit: number,
  ): Promise<void> {
    const stack = this.undoStacks.get(sessionId) ?? [];
    const position = this.nextPosition.get(sessionId) ?? 0;
    this.nextPosition.set(sessionId, position + 1);
    // structuredClone isolates the snapshot from later mutation of the live
    // state object (same as the original recordUndoSnapshot).
    stack.push({ position, mover_kind: moverKind, snapshot: structuredClone(snapshot) });
    while (stack.length > limit) stack.shift();
    this.undoStacks.set(sessionId, stack);
  }

  async listUndoMeta(sessionId: string): Promise<UndoEntryMeta[]> {
    const stack = this.undoStacks.get(sessionId) ?? [];
    return stack.map((e) => ({ position: e.position, mover_kind: e.mover_kind }));
  }

  async getUndoSnapshot(
    sessionId: string,
    position: number,
  ): Promise<SessionState<unknown> | null> {
    const stack = this.undoStacks.get(sessionId) ?? [];
    return stack.find((e) => e.position === position)?.snapshot ?? null;
  }

  async truncateUndoFrom(sessionId: string, fromPosition: number): Promise<void> {
    const stack = this.undoStacks.get(sessionId);
    if (!stack) return;
    const kept = stack.filter((e) => e.position < fromPosition);
    this.undoStacks.set(sessionId, kept);
  }

  async undoDepth(sessionId: string): Promise<number> {
    return this.undoStacks.get(sessionId)?.length ?? 0;
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
