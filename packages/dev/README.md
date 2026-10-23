# @zekel/dev

Tools for building and checking a game for the [Zekel MCP server](https://www.npmjs.com/package/@zekel/mcp):

| Command | What it does |
|---|---|
| `ai-harness` | Plays batches of AI-vs-AI games through the real server and writes per-game records, metrics and a balance analysis. Any error in a game is a bug to look at. |
| `balance-dashboard` | Turns harness records into one self-contained HTML page. |
| `engine-bot` | Plays a human seat with the engine's own legal moves, checking what the server tells that seat. |
| `human-seat-sweep` | Runs the engine bot over several games and player counts. |
| `desync-bot` | Plays a game through a small language model that keeps its own copy of the board, and measures how long it goes wrong without noticing. |
| `assistant-bot`, `llm-bot` | A language model as the player's assistant, or as the player. |
| `relay-bot` | Checks that a model's spoken account of an AI turn is enough for a person to make the same moves on a real table. |
| `integration-bot` | Plays a whole game as the human through a real chat client. |
| `verify-hunt`, `verify-lint` | The rules checker: plays games against a second, independent statement of the rules and reports where they disagree; checks that statement against the rulebook text. |
| `check-summaries` | Checks every move's spoken summary (no seat ids, printed names, nothing hidden). |
| `choice-catalog` | Prints a game's list of player decisions as a table. |

Commands that play through the server start your built server: the `serverPath` you pass to `runDevCommand`, else `dist/index.js` in the current folder (`ai-harness --server=<file>` overrides both for one run). The bots that use a language model need [Ollama](https://ollama.com): they look for it at `OLLAMA_BASE_URL` if set, else `http://localhost:11434` (`--base-url` overrides). `integration-bot` needs LibreChat; its addresses default to this machine and are set with `LIBRECHAT_URL`, `ZEKEL_MCP_URL` and `PLAYER_BASE_URL`.

## Using it

A game can give the tools extra parts: its own balance-analysis settings, extra metrics, sweeps over its options, a rules-checker adapter, wording for the desync bot. These are its **dev hooks** (`GameDevHooks`). Register them, then run a command:

```ts
// scripts/dev.ts
import { registerDevHooks, markDevHooksLoaded, runDevCommand } from '@zekel/dev';
import { myGame } from '../src/my-game/index.js';

registerDevHooks('my-game', { /* optional parts */ });
markDevHooksLoaded(); // needed only when no game registered any

const [name, ...args] = process.argv.slice(2);
await runDevCommand(name!, args, { games: [myGame] });
```

```
tsx scripts/dev.ts ai-harness --game=my-game --n=50 --players=2
```

## The runbooks

The `docs/` folder holds the step-by-step guides for taking a game from its rulebook to finished: planning, building, the post-port check, the AI, the desync, relay, balance and integration checks, and drawing the board. They say when to run each tool and what its output means. Start at [docs/README.md](./docs/README.md). They ship inside the package, so `node_modules/@zekel/dev/docs/` holds the guides that match the tools you installed.

The tools' inner files can be imported as `@zekel/dev/<path>` (for example `@zekel/dev/harness/analysis`) for writing dev hooks; anything beyond the main entry point may change in any release.

Source: https://github.com/xephoid/zekel-mcp. Licensed under Apache 2.0.
