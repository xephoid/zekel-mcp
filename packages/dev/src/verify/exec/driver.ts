// The driver + differ: imports a game module directly (the mcts.ts idiom —
// the MCP layer would make hundreds of thousands of games crawl), plays whole
// games with a pluggable move policy, and after every applied move runs the
// oracle rules over the (previous, event, next) projection. Divergence reports
// carry seed, move index, rule id, cited sentence, and both values.

import type { Game, LegalMove, SessionState } from '@zekel/game-kit';
import type { Divergence, OracleRule, VerifyEvent } from './types.js';

/** Deterministic rng (mulberry32) — scripts must be replayable from the seed. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A move policy: given the projected state and the engine's legal moves,
 * return the index of the move to play. `rng` is the policy's only allowed
 * randomness source. Generic over the game's comparison shape. */
export type MovePolicy<V = unknown> = (view: V, legal: LegalMove<unknown>[], rng: () => number) => number;

/** Per-game glue bundle: how to create/project/annotate one game's sessions,
 * plus the hunter's vocabulary for this game (sensors over the comparison
 * shape, their plausible maxima for threshold generation, and the move types
 * a strategy leaf may express preferences over). */
export interface VerifyAdapter<GS, V = unknown> {
  gameId: string;
  game: Game<GS, unknown, unknown>;
  createSession(seed: number): SessionState<GS>;
  project(gameState: GS): V;
  toEvent(gameState: GS, playerId: string, move: unknown, moveIndex: number): VerifyEvent;
  /** Attach observed id-deltas the rules need (e.g. arrest target). */
  annotate(event: VerifyEvent, prev: GS, next: GS): void;
  rules: OracleRule<V>[];
  sensors: Record<string, (view: V) => number>;
  sensorMax: Record<string, number>;
  moveTypes: readonly string[];
}

export interface GameRunResult {
  seed: number;
  moves: number;
  divergences: Divergence[];
  winners: string[];
  /** An applyMove throw or an empty legal-move list — a driver/glue problem
   * (or a real engine crash), never silently swallowed. */
  error: string | null;
}

export function runGame<GS, V>(
  adapter: VerifyAdapter<GS, V>,
  policy: MovePolicy<V>,
  seed: number,
  maxMoves = 600,
): GameRunResult {
  const rng = makeRng(seed ^ 0x9e3779b9);
  let session = adapter.createSession(seed);
  const divergences: Divergence[] = [];
  let moveIndex = 0;

  while (moveIndex < maxMoves) {
    const over = adapter.game.isGameOver(session);
    if (over?.game_over) {
      return { seed, moves: moveIndex, divergences, winners: over.winners, error: null };
    }
    const active = (session.gameState as { activePlayerId: string }).activePlayerId;
    const legal = adapter.game.getLegalMoves(session, active);
    if (legal.length === 0) {
      return { seed, moves: moveIndex, divergences, winners: [], error: `no legal moves for ${active}` };
    }
    const prevGS = session.gameState;
    const prevProj = adapter.project(prevGS);
    const pickedIndex = policy(prevProj, legal as LegalMove<unknown>[], rng);
    const picked = legal[Math.min(Math.max(pickedIndex, 0), legal.length - 1)]!;

    let nextSession: SessionState<GS>;
    try {
      nextSession = adapter.game.applyMove(session, active, picked.move).newState;
    } catch (error) {
      return {
        seed,
        moves: moveIndex,
        divergences,
        winners: [],
        error: `applyMove rejected an offered legal move (${JSON.stringify(picked.move)}): ${String(error)}`,
      };
    }

    const nextProj = adapter.project(nextSession.gameState);
    const event = adapter.toEvent(prevGS, active, picked.move, moveIndex);
    adapter.annotate(event, prevGS, nextSession.gameState);
    for (const rule of adapter.rules) {
      if (rule.on !== '*' && !rule.on.includes(event.moveType)) continue;
      for (const violation of rule.check(prevProj, event, nextProj)) {
        divergences.push({
          seed,
          moveIndex,
          ruleId: rule.id,
          field: violation.field,
          citation: rule.citation,
          predicted: violation.predicted,
          actual: violation.actual,
          moveType: event.moveType,
          actor: event.actor,
        });
      }
    }

    session = nextSession;
    moveIndex += 1;
  }
  return { seed, moves: moveIndex, divergences, winners: [], error: `hit the ${maxMoves}-move cap` };
}

/** Uniform-random move policy — the control the hunter must beat. */
export const randomPolicy: MovePolicy<unknown> = (_view, legal, rng) => Math.floor(rng() * legal.length);

/** Versus mode: one seat is driven by a policy under evolution, the others by
 * the game's own AI at a difficulty tier (`getAIMove`, hence async). The
 * oracle rules still run on every transition — sparring doubles as a rules
 * check on the AI's own play. Mirrors runGame's loop; the two stay small
 * enough that sharing a core wasn't worth the indirection. */
export async function runVersusGame<GS, V>(
  adapter: VerifyAdapter<GS, V>,
  policySeatId: string,
  policy: MovePolicy<V>,
  aiDifficulty: string,
  seed: number,
  maxMoves = 600,
): Promise<GameRunResult> {
  const rng = makeRng(seed ^ 0x9e3779b9);
  let session = adapter.createSession(seed);
  const divergences: Divergence[] = [];
  let moveIndex = 0;

  while (moveIndex < maxMoves) {
    const over = adapter.game.isGameOver(session);
    if (over?.game_over) {
      return { seed, moves: moveIndex, divergences, winners: over.winners, error: null };
    }
    const active = (session.gameState as { activePlayerId: string }).activePlayerId;
    const prevGS = session.gameState;
    let move: unknown;
    if (active === policySeatId) {
      const legal = adapter.game.getLegalMoves(session, active);
      if (legal.length === 0) {
        return { seed, moves: moveIndex, divergences, winners: [], error: `no legal moves for ${active}` };
      }
      const pickedIndex = policy(adapter.project(prevGS), legal as LegalMove<unknown>[], rng);
      move = legal[Math.min(Math.max(pickedIndex, 0), legal.length - 1)]!.move;
    } else {
      move = (await adapter.game.getAIMove(session, active, aiDifficulty)).move;
    }

    let nextSession: SessionState<GS>;
    try {
      nextSession = adapter.game.applyMove(session, active, move).newState;
    } catch (error) {
      return {
        seed,
        moves: moveIndex,
        divergences,
        winners: [],
        error: `applyMove rejected ${active}'s move (${JSON.stringify(move)}): ${String(error)}`,
      };
    }

    const prevProj = adapter.project(prevGS);
    const nextProj = adapter.project(nextSession.gameState);
    const event = adapter.toEvent(prevGS, active, move, moveIndex);
    adapter.annotate(event, prevGS, nextSession.gameState);
    for (const rule of adapter.rules) {
      if (rule.on !== '*' && !rule.on.includes(event.moveType)) continue;
      for (const violation of rule.check(prevProj, event, nextProj)) {
        divergences.push({
          seed,
          moveIndex,
          ruleId: rule.id,
          field: violation.field,
          citation: rule.citation,
          predicted: violation.predicted,
          actual: violation.actual,
          moveType: event.moveType,
          actor: event.actor,
        });
      }
    }

    session = nextSession;
    moveIndex += 1;
  }
  return { seed, moves: moveIndex, divergences, winners: [], error: `hit the ${maxMoves}-move cap` };
}
