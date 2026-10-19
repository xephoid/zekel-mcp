// Outside AI plug-ins: a way for a program outside the server to pick an AI
// seat's moves, without the server knowing which program or which games.
//
// A plug-in claims one or more difficulty names (e.g. 'hyperon', the learned
// external brain in src/ai/brain.ts). A seat created with a claimed difficulty
// gets its moves from the plug-in; every other seat gets the game's own
// getAIMove. The entry point (src/index.ts) registers plug-ins at startup, the
// same way it registers games, so the MCP layer never imports one.
//
// Failure policy (unchanged from the brain it was cut out of): a seat whose
// difficulty is neither built in nor claimed by a registered plug-in FAILS the
// tool call with AI_BACKEND_UNAVAILABLE. It never quietly falls back to the
// game's own AI, because a game's getAIMove would treat an unknown difficulty
// as some default and play on as if nothing were wrong.

import { GameError } from '@zekel/game-kit';
import type { AIMoveResult, Game, PlayerConfig, SessionState } from '@zekel/game-kit';

type AnyGame = Game<unknown, unknown, unknown>;
type SeatConfig = Pick<PlayerConfig, 'difficulty' | 'strategy'>;

export interface AIMovePlugin {
  /** Short name for logs and error messages. */
  name: string;
  /** The difficulty names this plug-in answers for. */
  difficulties: readonly string[];
  /** Pick the move for a seat whose difficulty this plug-in claims. */
  pickMove(game: AnyGame, session: SessionState<unknown>, playerId: string, cfg: SeatConfig): Promise<AIMoveResult<unknown>>;
  /** Told about every applied move, by any seat (so a plug-in can learn what
   *  happened between its own moves). Optional. */
  noteAppliedMove?(
    game: AnyGame,
    before: SessionState<unknown>,
    after: SessionState<unknown>,
    playerId: string,
    move: unknown,
  ): Promise<void>;
  /** The session was rewound (undo): drop anything remembered about it. Optional. */
  forgetSession?(sessionId: string): void;
}

/** Difficulties every game handles itself through getAIMove. */
export const BUILT_IN_DIFFICULTIES: readonly string[] = ['random', 'easy', 'medium', 'hard', 'mcts'];

const plugins: AIMovePlugin[] = [];

export function registerAIPlugin(plugin: AIMovePlugin): void {
  for (const difficulty of plugin.difficulties) {
    if (BUILT_IN_DIFFICULTIES.includes(difficulty)) {
      throw new Error(`AI plug-in ${plugin.name} cannot claim the built-in difficulty "${difficulty}"`);
    }
    const holder = plugins.find((p) => p !== plugin && p.difficulties.includes(difficulty));
    if (holder) {
      throw new Error(`AI plug-ins ${holder.name} and ${plugin.name} both claim difficulty "${difficulty}"`);
    }
  }
  if (!plugins.includes(plugin)) plugins.push(plugin);
}

/** Test helper: forget every registered plug-in. */
export function clearAIPlugins(): void {
  plugins.length = 0;
}

export function listAIPlugins(): readonly AIMovePlugin[] {
  return plugins;
}

/** Compute the AI move for a seat. Every MCP call site that computes an AI
 *  move (get_ai_move, suggest_move's fallback, run_ai_turn) goes through here. */
export async function pickAIMove(
  game: AnyGame,
  session: SessionState<unknown>,
  playerId: string,
  cfg: SeatConfig | undefined,
): Promise<AIMoveResult<unknown>> {
  const difficulty = cfg?.difficulty;
  if (difficulty === undefined || BUILT_IN_DIFFICULTIES.includes(difficulty)) {
    return game.getAIMove(session, playerId, difficulty, cfg?.strategy);
  }
  const plugin = plugins.find((p) => p.difficulties.includes(difficulty));
  if (!plugin) {
    throw new GameError(
      'AI_BACKEND_UNAVAILABLE',
      `difficulty "${difficulty}" needs an outside AI that this server was not started with`,
    );
  }
  return plugin.pickMove(game, session, playerId, cfg!);
}

/** Tell every plug-in about one applied move. Call right after game.applyMove
 *  at every site that applies a move. */
export async function noteAppliedMove(
  game: AnyGame,
  before: SessionState<unknown>,
  after: SessionState<unknown>,
  playerId: string,
  move: unknown,
): Promise<void> {
  for (const plugin of plugins) {
    await plugin.noteAppliedMove?.(game, before, after, playerId, move);
  }
}

/** A session was rewound: every plug-in drops what it remembered about it. */
export function forgetSessionInAIPlugins(sessionId: string): void {
  for (const plugin of plugins) plugin.forgetSession?.(sessionId);
}
