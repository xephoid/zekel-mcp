# zekel-mcp

An MCP server for turn-based board games, with no games built in.

It keeps track of sessions, seats and moves. It runs AI turns, lets a second player join from another device, saves sessions (MongoDB, SQLite or memory), and offers numbered move menus, rules teaching and a web debug page. It knows no game rules: you register games, and every rule lives in them.

## The two packages

| Package | What it is |
|---|---|
| `@zekel/game-kit` (`packages/game-kit`) | What a game is built against: the `Game` interface, `SessionState`, `GameError`, and shared helpers (a seeded random-number helper, an MCTS search, seat names, rules sections, setup choices, the game log). It depends on nothing. |
| `@zekel/mcp` (`packages/mcp`) | The server. It depends on `@zekel/game-kit` and the MCP SDK. |

A game imports only `@zekel/game-kit`. A program that serves games depends on `@zekel/mcp`, registers its games and starts the server:

```js
import { registerGame, runServer, SERVER_INSTRUCTIONS } from '@zekel/mcp';

await runServer({
  serverInfo: { name: 'my-games', version: '1.0.0' },
  instructions: SERVER_INSTRUCTIONS,
  registerGames: () => registerGame(myGame),
});
```

`examples/race-to-ten.mjs` is a complete, tiny game (two players take turns adding 1 or 2; whoever reaches exactly 10 wins), written so it can be read in one sitting.

## Running it

Needs Node 22.13 or later and pnpm.

```
pnpm install
pnpm build      # builds both packages
pnpm test       # the unit tests
pnpm smoke      # plays a whole game of the example through the real MCP tools
```

Settings come from environment variables: `SESSION_STORE` (`mongodb`, the default; `sqlite`; or `memory`), `MONGODB_URI`, `SESSION_DB_PATH`, `MCP_TRANSPORT` (`stdio`, the default, or `http`), `PORT` and `MCP_BEARER_TOKEN`.

## What a game can add

Beyond the required methods, a game can add its own MCP tools and resources (`getExtraTools`, `getExtraResources`), a board drawing for the web debug page (`webAssetsDir`), a rules-teaching outline, setup checklists, a move-menu layout and more. These are the optional fields of `Game` in `packages/game-kit/src/game.ts`.

## Not done yet

- Some of the server's own tests still live in the repo this code came from, because they use real games as test subjects (creating sessions, the output schemas, joining from a second device, the SQLite and MongoDB stores). They need a small made-up game here first.
- The server's instructions text and some code comments still use real games as examples.
- Saved sessions carry one version number for the whole server. When a game changes the shape of its saved state, that number has to change for everyone. Each game should version its own state.
- Only one copy of `@zekel/game-kit` may be installed: the server recognises a game's errors by their type. Game packages should list it as a peer dependency.
