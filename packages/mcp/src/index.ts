// @zekel/mcp: a bare MCP server for turn-based board games. It holds sessions,
// seats and moves and runs AI turns, and knows no game rules: a program that
// depends on this package registers games (anything implementing Game from
// @zekel/game-kit) and starts the server.
//
//   import { runServer, registerGame, SERVER_INSTRUCTIONS } from '@zekel/mcp';
//   await runServer({
//     serverInfo: { name: 'my-games', version: '1.0.0' },
//     instructions: SERVER_INSTRUCTIONS,
//     registerGames: () => { registerGame(myGame); },
//   });

export { runServer, buildMcpServer, type RunServerOptions } from './server/bootstrap.js';
export { registerGame, getGame, listRegisteredGames, type AnyGame } from './core/registry.js';
export { registerAIPlugin, listAIPlugins, type AIMovePlugin } from './core/aiPlugins.js';
export { SERVER_INSTRUCTIONS, ORCHESTRATED_SERVER_INSTRUCTIONS } from './mcp/serverInstructions.js';
