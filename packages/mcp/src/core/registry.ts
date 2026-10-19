import type { Game } from '@zekel/game-kit';
import { GameError } from '@zekel/game-kit';

export type AnyGame = Game<unknown, unknown, Record<string, unknown>>;

const registry = new Map<string, AnyGame>();

export function registerGame<S, M, O>(game: Game<S, M, O>): void {
  registry.set(game.id, game as unknown as AnyGame);
}

export function getGame(gameId: string): AnyGame {
  const g = registry.get(gameId);
  if (!g) {
    throw new GameError('GAME_NOT_FOUND', `Unknown game_id: ${gameId}`);
  }
  return g;
}

export function listRegisteredGames(): AnyGame[] {
  return Array.from(registry.values());
}
