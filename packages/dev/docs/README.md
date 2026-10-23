# Building and checking a game: the runbooks

These guides take a board or card game from its rulebook to a finished game
on the Zekel MCP server. Each runbook is one step. It says what to do, how to
tell when you're done, and how the step usually goes wrong.

Start with **[building-a-game.md](./building-a-game.md)**: the rules every
game follows. The runbooks check them.

The commands the runbooks use come from `@zekel/dev` (this package). They are
written the way [zekel-games](https://github.com/xephoid/zekel-games) runs
them, for example `pnpm harness -- --game=<id> --n=50 --players=2`. The
[package README](../README.md) shows how to wire them into your own project.

## The order

Run the steps in order. A later step run before an earlier one is finished
mostly reports problems the earlier step would have fixed.

```
port-planning ──▶ port ──▶ post-port ──▶ ai-development ──▶ ┌─ desync ─┐
  the plan       build    │  rules          AI quality      ├─ relay ──┴─▶ integration
                          │                                 └─ balance
                          └─▶ viz (optional)
```

| Step | Runbook | What it checks | The game's record |
|---|---|---|---|
| Plan | [port-planning-runbook.md](./port-planning-runbook.md) | Every feature in the rulebook is listed, with a build plan, before any code | `PORT-PLAN.md` |
| Build | [port-runbook.md](./port-runbook.md) | The game is built from the plan, faithful to the rules | `PORT-NOTES.md` |
| Post-port | [post-port-runbook.md](./post-port-runbook.md) | The game is fully playable: every rule, every choice the player owns, every fact the player may see | `POST-PORT.md` |
| AI | [ai-development-runbook.md](./ai-development-runbook.md) | The AI plays at three skill levels, with settings the balance step can measure | `AI-NOTES.md` |
| Desync | [desync-harness-runbook.md](./desync-harness-runbook.md) | A weak language model can keep the server in step with the table through a whole game | a line in your status table |
| Relay | [relay-harness-runbook.md](./relay-harness-runbook.md) | A model's prose describing an AI turn carries enough for a human to carry it out | `RELAY-NOTES.md` |
| Balance | [balance-harness-runbook.md](./balance-harness-runbook.md) | Seats, factions, options: is anything too strong? (metrics: [balance-metric-definitions.md](./balance-metric-definitions.md)) | `BALANCE.md` |
| Integration | [integration-runbook.md](./integration-runbook.md) | A whole game played as the human through a real chat client | `INTEGRATION-NOTES.md` |
| Viz (optional) | [viz-runbook.md](./viz-runbook.md) | The table drawn in the web debug page, checked by eye | `VIZ-NOTES.md` |

A game's records live in its own folder, for example
`packages/<game>/POST-PORT.md`. zekel-games' 8-bit Demon Hunter has public
`PORT-PLAN.md` and `POST-PORT.md` files to look at. A game is done when every
step except the optional one has passed.

## Background the runbooks lean on

- [view-completeness-audit.md](./view-completeness-audit.md): every fact a
  player may see must be readable from the game's views.
- [rules-teaching.md](./rules-teaching.md): rules in sections, and saying why
  a move isn't available.
- [rules-verification.md](./rules-verification.md): a second, machine-checked
  statement of the rules, written from the rulebook alone, and a search for
  games where the engine and that statement disagree.
- [spoken-narration.md](./spoken-narration.md): how to write each move's
  summary so it can be read aloud.
- [client-modes.md](./client-modes.md): how the server talks to a chat model
  versus an app that runs the game loop itself.
- [board-viz.md](./board-viz.md): how the web debug page draws a board.

## When shared code changes

Steps run forward, but a change to shared code can break a game that already
passed. After such a change, re-run the affected step for the affected games:

- The `Game` interface or saved-session shapes → check saved sessions still
  load ([building-a-game.md](./building-a-game.md), "Saved sessions outlive
  code changes").
- `@zekel/game-kit`'s MCTS or `@zekel/dev`'s analysis → re-run AI and balance
  for games that use them.
- `@zekel/mcp`'s `mcp/tools.ts` or `mcp/nextStep.ts` → re-run desync for one
  game of each setup style.
- The shape of `run_ai_turn`'s reply, or a game's summaries or log text →
  re-run relay (probe mode) for that game.
- A game's `engine.ts` or `legalMoves.ts`, for a game with a rules checker →
  re-run rules verification for it: `pnpm verify-hunt -- --game=<id> --mode=random --games=1000`
  must report nothing, then a hunter batch. A rules ruling that changes the
  rules also updates the pinned rules text in the same change.

## Outside services

- **Ollama**, running locally, for the bots that drive a language model
  (desync, relay, assistant, LLM bots).
- **LibreChat**, for the integration bot.
