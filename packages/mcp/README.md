# @zekel/mcp

An MCP server for turn-based board games, with no games built in. It keeps sessions, seats and moves; runs AI turns; lets a second player join from another device; saves sessions (MongoDB, SQLite or memory); and offers numbered move menus, rules teaching and a web debug page. Every rule lives in the games you register.

```js
import { registerGame, runServer, SERVER_INSTRUCTIONS } from '@zekel/mcp';

await runServer({
  serverInfo: { name: 'my-games', version: '1.0.0' },
  instructions: SERVER_INSTRUCTIONS,
  registerGames: () => registerGame(myGame),
});
```

Games implement `Game` from [`@zekel/game-kit`](https://www.npmjs.com/package/@zekel/game-kit). Settings come from environment variables: `SESSION_STORE` (`mongodb`, the default; `sqlite`; or `memory`), `MONGODB_URI`, `SESSION_DB_PATH`, `MCP_TRANSPORT` (`stdio` or `http`), `PORT` and `MCP_BEARER_TOKEN`.

Source and documentation: https://github.com/xephoid/zekel-mcp. Licensed under Apache 2.0.
