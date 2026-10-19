// A real zekel server (buildMcpServer, the same wiring a program using
// @zekel/mcp gets) on an in-memory MCP connection, for tests that need the
// whole tool surface. Its games are the made-up Lucky Tic-Tac-Toe
// (luckyTicTacToe.ts) and a plain copy of it that answers no questions.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { listRegisteredGames, registerGame } from '../../core/registry.js';
import { buildMcpServer } from '../../server/bootstrap.js';
import { ORCHESTRATED_SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS } from '../serverInstructions.js';
import { luckyTicTacToe, makeLuckyTicTacToe } from './luckyTicTacToe.js';

export const TEST_GAMES = [luckyTicTacToe, makeLuckyTicTacToe({ id: 'plain-tic-tac-toe', withoutQuery: true })];

export function registerTestGamesOnce(): void {
  const have = new Set(listRegisteredGames().map((g) => g.id));
  for (const g of TEST_GAMES) if (!have.has(g.id)) registerGame(g);
}

/** Connects a client declaring `capabilities` (e.g. the orchestrated mode). */
export async function connect(capabilities: Record<string, unknown> = {}): Promise<Client> {
  registerTestGamesOnce();
  const server = buildMcpServer({
    serverInfo: { name: 'zekel-board-game-mcp', version: '0.1.0' },
    instructions: SERVER_INSTRUCTIONS,
    orchestratedInstructions: ORCHESTRATED_SERVER_INSTRUCTIONS,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' }, { capabilities });
  await client.connect(b);
  return client;
}

export const ORCHESTRATED_CAPABILITIES = { experimental: { zekel: { mode: 'orchestrated' } } };
