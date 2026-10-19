// A made-up two-player game, small enough to read in one go, that shows how a
// game plugs into @zekel/mcp. Players take turns adding 1 or 2 to a shared
// total; whoever brings it to exactly 10 wins.
//
// Run it (after `pnpm build`):  node examples/race-to-ten.mjs
// It speaks MCP over stdio. scripts/smoke.mjs drives a whole game through it.

import { GameError } from '@zekel/game-kit';
import { registerGame, runServer, SERVER_INSTRUCTIONS } from '@zekel/mcp';

const TARGET = 10;

const raceToTen = {
  id: 'race-to-ten',
  name: 'Race to Ten',
  description: 'Take turns adding 1 or 2 to a shared total. Bring it to exactly 10 to win.',
  minPlayers: 2,
  maxPlayers: 2,
  supportsAI: true,
  hasHiddenInformation: false,
  optionsSchema: { type: 'object', properties: {} },
  moveSchema: {
    type: 'object',
    properties: { type: { const: 'add' }, amount: { enum: [1, 2] } },
    required: ['type', 'amount'],
  },
  version: '1.0.0',

  createSession(players) {
    return {
      sessionId: '',
      gameId: 'race-to-ten',
      players,
      activePlayerId: players[0].player_id,
      turnNumber: 1,
      gameState: { total: 0, winner: null },
      moveLog: [],
      createdAt: new Date().toISOString(),
    };
  },

  getLegalMoves(state, playerId) {
    if (state.gameState.winner || playerId !== state.activePlayerId) return [];
    return [1, 2]
      .filter((amount) => state.gameState.total + amount <= TARGET)
      .map((amount) => ({ move_id: `add-${amount}`, description: `Add ${amount}`, move: { type: 'add', amount } }));
  },

  getPublicView(state) {
    return { total: state.gameState.total, target: TARGET, to_move: state.activePlayerId };
  },

  getPlayerView(state) {
    return this.getPublicView(state);
  },

  isGameOver(state) {
    const winner = state.gameState.winner;
    if (!winner) return null;
    const scores = Object.fromEntries(state.players.map((p) => [p.player_id, p.player_id === winner ? 1 : 0]));
    return { game_over: true, winners: [winner], scores, summary: `${winner} reached ${TARGET} and wins.` };
  },

  applyMove(state, playerId, move) {
    if (playerId !== state.activePlayerId) throw new GameError('NOT_YOUR_TURN', `It is ${state.activePlayerId}'s turn`);
    const legal = this.getLegalMoves(state, playerId).some((m) => m.move.amount === move?.amount);
    if (move?.type !== 'add' || !legal) throw new GameError('ILLEGAL_MOVE', 'Add 1 or 2, without going past 10.');
    const total = state.gameState.total + move.amount;
    const winner = total === TARGET ? playerId : null;
    const next = state.players.find((p) => p.player_id !== playerId).player_id;
    return {
      newState: {
        ...state,
        activePlayerId: winner ? playerId : next,
        turnNumber: state.turnNumber + 1,
        gameState: { total, winner },
      },
      summary: `${playerId} adds ${move.amount}; the total is ${total}.${winner ? ` ${playerId} wins.` : ''}`,
    };
  },

  getAIMove(state, playerId) {
    // Always leave the total at a multiple of 3 short of 10 when it can.
    const moves = this.getLegalMoves(state, playerId);
    const best = moves.find((m) => (TARGET - state.gameState.total - m.move.amount) % 3 === 0) ?? moves[0];
    return { move: best.move, narration: best.description };
  },
};

await runServer({
  serverInfo: { name: 'race-to-ten-example', version: '1.0.0' },
  instructions: SERVER_INSTRUCTIONS,
  registerGames: () => registerGame(raceToTen),
});
