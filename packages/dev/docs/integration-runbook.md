# Integration-harness runbook

How to run the first-real-game harness: a script plays a **complete game as the
human**, through a **real chat client** (LibreChat), and reports what went
wrong. It is the automated version of "sit down and play the game for the first
time", the step that has found a real bug almost every time a human has done
it. Cybernoir 2127's first six human games found: hidden information about an
informant shown to the wrong player, the assistant choosing the human's role
for them, recruits reaching cards they shouldn't, moves along the jail track
never reported, and a wrong jail rule.

It runs AFTER desync and relay. Those gates use a scripted human with no goals,
a fresh context every turn, and an imitation of the chat client. This gate
covers what they can't:

- **A player who wants something.** The player follows a strategy guide and
  tries to win. A scripted human can't notice a choice being made *for* it,
  because it never wanted anything. This player can.
- **The real client.** LibreChat's own prompt wrapping, limits on tool-call
  steps, rejections of badly shaped tool arguments, and one continuous
  conversation for the whole game: the exact conditions the other harnesses'
  imitation of a client can't fully reproduce.
- **The whole game at once.** The setup conversation, then every turn, then
  game over, in one sitting, the way a real first game happens.

This is a **judgment gate**. There is no reference session and no state
comparison. The output is a transcript plus the player's flags, and a human
reads them. Quiet drift between the server and the table is still the desync
gate's job ([desync-harness-runbook.md](./desync-harness-runbook.md));
whether the words for AI moves can be acted on is still the relay gate's job
([relay-harness-runbook.md](./relay-harness-runbook.md)). This gate exists to
catch the glaring, first-session bugs that those gates' scripted humans walk
past.

## The pieces

- **The assistant**: the LibreChat agent the human normally plays with,
  connected to the game server over MCP. It is not what's under test here, but
  its failures will show up; sort them honestly (below) rather than changing
  the game to work around them.
- **The player**: a strong language model the script drives. It gets the
  strategy guide, a list of things to watch for, and a persona. It talks to
  the assistant in short casual messages, like a person at a table. The player
  must be *stronger* than the assistant: it is the measuring tool, and a weak
  player's confusion looks exactly like a real bug.
- **The script**: the `integration-bot` command (`@zekel/dev`
  `commands/integration-bot.ts`). It logs into LibreChat, carries the
  conversation between the two models, and answers the player's questions
  about physical facts (below). It writes a live transcript and a summary.

Three literal markers connect the player to the script. The assistant never
sees them.

- `ASK-TABLE`: the player needs a physical fact it can't know (what it drew,
  what it rolled). It has two forms.
  - `ASK-TABLE: pick N of: <names separated by ;>`: the player lists the cards
    that could come up (what's left in its own deck) and the script shuffles
    them: a uniform random pick, returned as the draw. This is how the player
    builds and refills a real hand from a deck it owns. Without it the player
    limps through the game one card at a time. (In the first run, the
    Detective in Cybernoir 2127 never held the 3 starting cards the rulebook
    gives it, and so could never buy a clue.) Keeping that list right is the
    player's job: its full deck minus every card it has already drawn or
    played, unless the game shuffled its discards back in.
  - Bare `ASK-TABLE`: the cards that could come up are hidden from the player
    too, so the script asks the game server through the `suggest_move` tool,
    which makes up a valid outcome from the server's own hidden record. Answers
    to the bare form are MOVES, not answers to rules questions; a player asking
    anything else gets a misleading suggestion back.

  Use either form only for facts a deck or a die would decide. Decisions stay
  with the player.
- `FLAG: <text>`: a finding. Removed from the outgoing message and collected
  into the run summary.
- `GAME-OVER: <text>`: the player's closing verdict once the assistant reports
  the game has ended. It stops the run.

## Write the strategy guide first

`STRATEGY-GUIDE.md` in the game's package folder
(`packages/<game>/STRATEGY-GUIDE.md`), committed. One page or less.
**Strategy only**: what to value, what a good opening looks like, which plans
to follow, what the opponent will try. Write it from the `get_rules` output
plus the game's `AI-NOTES.md` (the strategy choices the AI can make, and what
the balance work showed).

Do NOT restate the rules in it beyond what a strategy tip needs. The server
teaches the rules (`next_step`, legal moves, `get_rules`); the guide gives the
player things to want. This matters when you sort the findings: a wrong rules
claim in the guide will show up as a flagged "rules bug" against a correct
server. When a flag smells like that, check the guide before the engine, and
fix the guide.

## Prerequisites

- Desync and relay pass for the game. Running earlier is allowed but noisy:
  expect flags that belong to those gates, and send them to those runbooks
  instead of sorting them here.
- The setup described in the next section: the game server over HTTP, a
  LibreChat with an agent connected to that same server, an account for the
  bot, and an endpoint for the player model.
- The strategy guide committed. The script refuses to start without it.

## Setting up LibreChat and the player

The script talks to three services. You run all three; none of them is
provided for you.

1. **The game server, over HTTP.** Build, then start the server with HTTP
   switched on. In zekel-games:

   ```bash
   pnpm build
   MCP_TRANSPORT=http PORT=3000 node examples/serve.mjs
   ```

   The MCP address is then `http://<host>:3000/mcp`. Set `MCP_BEARER_TOKEN`
   on the server if it is reachable by anyone else, and give the same value to
   the script as `ZEKEL_MCP_TOKEN`. The server keeps sessions in MongoDB by
   default; `SESSION_STORE=memory` (lost when the server stops) or
   `SESSION_STORE=sqlite` avoid needing one.

2. **LibreChat, connected to that same server.** Run
   [LibreChat](https://www.librechat.ai) and add the game server to its MCP
   servers in `librechat.yaml`, for example:

   ```yaml
   mcpServers:
     zekel:
       type: streamable-http
       url: http://<host>:3000/mcp
       headers:
         Authorization: "Bearer <your MCP_BEARER_TOKEN>"   # only if you set one
   ```

   Check LibreChat's own MCP documentation for your version; the field names
   can change. Then, in the LibreChat web page, create an **agent**: pick the
   model you want to test as the assistant, and add the game server's tools to
   it. This agent is what the human would normally play with.

   **LibreChat and the script must reach the same server process.** The
   script finds the session the assistant created by reading the server's
   session list, and the `ASK-TABLE` lookup works on that session. A second
   copy of the server, even with the same games, has a different session list.
   (Joining from a second device has the same rule: sessions are tracked
   inside one process.) Watch out if LibreChat runs in Docker: `localhost`
   inside its container is not your machine, so use an address both LibreChat
   and the script can reach.

3. **A LibreChat account for the bot.** The script logs in with an email and
   password (LibreChat's normal email login), so create an account that has
   one. The agent must be visible to that account: create it from that
   account, or share it with it.

4. **An endpoint for the player model.** Any API that speaks the
   OpenAI-compatible chat-completions format. A local
   [Ollama](https://ollama.com) works: its address is
   `http://localhost:11434/v1`. Pick a strong model (see "The pieces" above).

The script reads these settings from the environment, or from a `.env` file
in the folder you run it from (real environment variables win):

| Setting | What it is |
|---|---|
| `LIBRECHAT_URL` (or `--librechat-url`) | LibreChat's web address. |
| `LIBRECHAT_EMAIL`, `LIBRECHAT_PASSWORD` | The bot's LibreChat account. |
| `ZEKEL_MCP_URL` (or `--mcp-url`) | The game server's MCP address, the same one LibreChat uses, e.g. `http://<host>:3000/mcp`. |
| `ZEKEL_MCP_TOKEN` | The server's `MCP_BEARER_TOKEN`, if you set one. |
| `PLAYER_BASE_URL` (or `--player-base-url`) | The player model's OpenAI-compatible address, e.g. `http://localhost:11434/v1`. |
| `PLAYER_API_KEY` | The key for that endpoint, if it needs one. |
| `PLAYER_MODEL` (or `--player-model`) | The player model's name. |

Without these, the script assumes everything runs on this machine: LibreChat at
`http://localhost:3080`, the game server at `http://localhost:3000/mcp`, and the
player model on Ollama at `OLLAMA_BASE_URL` (else `http://localhost:11434`) +
`/v1`.

## Running it

The commands below are the script names zekel-games uses (`pnpm
integration-bot`, `pnpm test`). Another project wires the same commands up as
the `@zekel/dev` README shows, or runs any of them as
`pnpm tool <command> [args]`.

```bash
# 1. Check the connections end to end (login, endpoint list, agents this
#    account can see, MCP reachable, suggest_move present):
pnpm integration-bot -- --game=<id> --check

# 2. Full run (run it in the background; a whole game takes about an hour):
pnpm integration-bot -- --game=<id> --agent-id=<your-agent-id> \
    --guide=packages/<id>/STRATEGY-GUIDE.md \
    > harness-out/integration.stdout 2> harness-out/integration.stderr
```

`--check` lists the id and name of every agent the bot's account can see. You
can also find an agent's id in the LibreChat page address while the agent is
open.

Without `--guide`, the script looks for the strategy guide at
`packages/<id>/STRATEGY-GUIDE.md`, then `src/games/<id>/STRATEGY-GUIDE.md`.

**Cover every playable identity.** One run plays one seat. The gate needs a
complete game for EVERY identity the game offers: both sides in Cybernoir 2127,
every Sweetlands Imperium faction. The list is the game's `identity` axis in
`getBalanceAxes()` (declared at post-port). Pass `--role=<name>` to tell the
player which identity to ask for; without it the player follows the strategy
guide's default. Each seat has its own setup, its own hidden information, and
its own bugs; the desync gate's lesson to run both seats applies here as it is.

Other flags: `--player-model`, `--player-name` (default `Riley`),
`--max-exchanges` (a safety cap, default 250), `--reply-timeout-s` (how long
to wait for one assistant reply, default 900), `--out` (default
`./harness-out`), and `--endpoint=<name> --model=<model>` instead of
`--agent-id` to talk to a plain LibreChat endpoint rather than an agent (an
agent is the normal case, because MCP servers are attached to agents). Live
progress is one stderr line per message. The transcript (JSONL) and the
summary (JSON, with all flags pulled out) go to `harness-out/`.

Each exchange costs one assistant reply and one player reply. There is no
cheap probe mode, because the whole point is one continuous game. So don't use
this harness to check fixes that a unit test, or a desync or relay probe, can
check faster.

## Check the checker (once per game, before trusting a clean run)

A clean run from a player that can't spot bugs means nothing. Before believing
the first clean run, put back one first-game bug that has already been fixed
(on a branch), run, and confirm the player flags it. Good choices are bugs
like Cybernoir 2127's first-game ones: the assistant choosing the human's role
without asking, or jail-track moves never reported. If the bug sails through,
the watch list or the player model is too weak: strengthen it and check again.
Write the result in the notes. Do this for each game the first time the gate
runs there, and again when the player model or its prompt changes a lot.

## Reading a run

Read the `GAME-OVER:` verdict and the `FLAG:` list first, then skim the full
transcript once. The flags point; they don't decide. The player misses things
while it's busy playing, and it also raises false alarms. What to look for:

- **Decisions made for the player.** Any choice that the game's own list of
  player decisions (in its `POST-PORT.md`) says belongs to the player, but that
  happened without the player being asked. The strongest signal this gate
  gives.
- **Wrong rules.** What happened contradicts what the assistant taught
  earlier, or the printed rulebook. Check against the server before believing
  it: read the session's log resource and `get_rules`. The player is a
  witness, not an authority. And check the strategy guide isn't the one that's
  wrong.
- **State that stops adding up.** Scores jumping, cards appearing twice, facts
  the player reported coming back changed. This is a *sign* of desync: confirm
  and fix it through the desync runbook's loop, not by eye.
- **What the assistant did.** Stalls the player had to push past with
  "continue", actions it claimed that didn't happen, fumbles in setup. Real
  findings, but usually not fixes to the game module (see below).
- **Friction with nothing broken.** Places the player had to ask twice, or the
  conversation dragged. Worth a note; often a clarity fix (the directive's
  wording, the shape of a summary) that the other runbooks already cover.

## Find the cause before you fix

- **A. Game bug**: the module did the wrong thing: a decision taken from the
  player, a wrong rule, a leak of hidden information, a missing report. Fix it
  in the game module and lock it with a unit test. This is why the gate exists:
  every class A find here would have hit a real first-time human.
- **B. A gap in what the player was told**: the move was applied correctly but
  the player was never told. That belongs to the relay gate: fix it through
  [relay-harness-runbook.md](./relay-harness-runbook.md) (the summary is what
  the relay has to carry).
- **C. The assistant or the client**: the model between the player and the
  server failed (stopped early, said it did something it didn't, sent badly
  shaped tool arguments). Not a fix to the game. Record it; the transcript is
  real evidence of how the assistant model behaves in a real client, which is
  useful when choosing or improving that model.
- **D. Noise from the player**: the guide misled it, or it misread a correct
  reply. Fix the guide or the player prompt. If the same noise repeats across
  runs, ask whether a real human would stumble the same way: "noise" that keeps
  coming back is sometimes a clarity problem in disguise.

## Notes file

`INTEGRATION-NOTES.md` in the game's package folder
(`packages/<game>/INTEGRATION-NOTES.md`), committed. For each run: the date,
the assistant and player models, the transcript path, the result of checking
the checker, and every finding with its class, the fix, and the test that
locks it. The gate passes when:

- [ ] A complete game has been played start to finish through the real client
      for EVERY playable identity (each role, faction or character on the
      game's `identity` balance axis): one run per identity, each recorded
      separately in the notes.
- [ ] The checker has been checked (a bug put back on purpose was flagged).
- [ ] Every flag has been looked at and given a class; nothing is left
      unexplained.
- [ ] Every class A finding is fixed and locked with a test; the full suite
      (`pnpm test`) passes.
- [ ] Your project's status table updated (zekel-games keeps one in
      `GAMES.md`): the Integration column.

## The goal

A stranger with the box, the chat client and an hour should meet none of the
bugs this gate exists to catch. When the player's whole game went smoothly
enough that the flags are small, the game is ready for a first-time human.
