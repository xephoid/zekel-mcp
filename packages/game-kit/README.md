# @zekel/game-kit

What a game for the [zekel MCP server](https://github.com/xephoid/zekel-mcp) is built against: the `Game` interface, `SessionState`, `GameError`, and the shared helpers a game may use (a seeded random-number helper, an MCTS search, seat names, rules sections, setup choices, the game log). It has no dependencies.

A game implements `Game` from this package and nothing else from the server. See [zekel-games](https://github.com/xephoid/zekel-games) for six complete games, and `examples/race-to-ten.mjs` in zekel-mcp for a tiny one.

Install exactly one copy: the server recognises a game's errors by their type, so a game package should list `@zekel/game-kit` as a peer dependency.

Licensed under Apache 2.0.
