# Desync-harness runbook

How to run the desync harness against a game, read what it reports, and fix,
one at a time, the breakdowns in communication it finds. "Desync" means the
server's record of the game has quietly stopped matching the real table. This
process has taken several games, including three from other publishers' designs,
to clean end-to-end games.

## What the harness measures (and why)

A weak language model helping a human at a **physical** table is the server's
only client. When the model can't map what the human says to the right
`apply_move`, it records the wrong thing, or nothing, and the server's tracked
state silently drifts away from the real board. Often nobody notices for many
turns. The desync harness reproduces exactly this and measures it.

It runs **two sessions from the same seed**:

- **REFERENCE**: the human's real board. It always gets the move the human
  actually declared (the true move), plus the real AI turns. This is reality.
- **MODEL**: the state the assistant tracks through MCP. It gets whatever the
  model *recorded* for the human (right or wrong), plus AI turns.

Each human turn: the simulated human works out the true move from the REFERENCE
and states it the same way every time (no language model; see below). The
assistant (a language model) reads the MODEL state and records a move there.
The harness **applies the model's move even when it's wrong** and lets the bad
state carry forward, then measures how long the mismatch stays silent.

Headline numbers (`DesyncResult` in `@zekel/dev`'s `harness/desyncBot.ts`):

- `first_desync_turn`: the first turn the model's tracked board differs from
  reality. The comparison ignores session differences: generated ids are
  normalized and array order doesn't count.
- `surfaced_turn` / `surfaced_how`: the first turn the difference becomes
  visible (the tracked turn or phase no longer matches reality).
- `silent_turns = surfaced − first_desync`: turns the game was quietly broken.
- `never_surfaced`: went wrong and was never caught before the game ended. The
  worst case.
- `correct_turns / human_turns`: an advisory count of turns recorded right (see
  the caution below).

Key files:

- `@zekel/dev` `harness/desyncBot.ts`: the harness itself (working out the true
  move, the assistant's tool-calling loop, spotting state differences, and
  turning moves into spoken sentences).
- `@zekel/dev` `commands/desync-bot.ts`: the command.
- The game's `index.ts` hooks the harness leans on: `autoResolveReport`,
  `getSuggestedMove`, `describeNextStep`, `getLegalMoves`, `getSetupChecklist`.
  (`describeNextStep` and `getSetupChecklist` are explained in
  [building-a-game.md, "Telling the model what comes next"](./building-a-game.md).)
- The game's dev hooks (its `desync` part, `DesyncHooks` in `@zekel/dev`
  `harness/devHooks.ts`): how a real player would *say* a move, how to say one
  value inside it, and how to tidy a move before comparing. Sweetlands
  Imperium's `packages/sweetlands-imperium/src/dev/index.ts` in zekel-games
  is an example.

For a game that uses rules teaching ([rules-teaching.md](./rules-teaching.md)),
the **greyed-out list of unavailable moves** that rides on `get_legal_moves` is
part of what this gate tests. Each grey line says why a move isn't offered, and
that stops the assistant inventing a rule for a move it can't see. A transcript
where the assistant quotes a grey line instead of looping on `get_rules` is the
feature working. A desync traced to an invented rule for a missing move means
that move's gate declaration is missing or unclear: fix it there, not in the
prompt.

## Prerequisites

- A local [Ollama](https://ollama.com) with the assistant model pulled. The
  default model is `qwen3.6:35b`; `--assistant=<model>` chooses another. The
  harness looks for Ollama at `OLLAMA_BASE_URL` if that is set, else
  `http://localhost:11434`; `--base-url=<address>` overrides both for one run.
- A built server. The harness starts the **compiled** server, not your source,
  so **rebuild before every run** (`pnpm build` in zekel-games).

## Running it

The commands below are the script names zekel-games uses (`pnpm desync-bot`,
`pnpm test`, and so on). Another project wires the same commands up as the
`@zekel/dev` README shows, or runs any of them as `pnpm tool <command> [args]`.

```bash
pnpm build                                    # REBUILD FIRST (the harness runs the built server)
pnpm desync-bot -- --game=<game-id> --players=<N> --seed=<S> \
    --base-url=http://localhost:11434 [--human-seat=<index>] [--mode=freeform] \
    > harness-out/run.stdout 2> harness-out/run.stderr
```

- `--players=N`: total seats (default 3). Seat 0 is the human, the rest are
  AI, unless you pass `--human-seat`. AI seats play at `medium`.
- `--seed=S`: same seed, same starting deal. Change it to reach paths that only
  some deals produce.
- `--mode=imperative|freeform`: how the assistant is prompted each human turn.
  `imperative` (the default, and the original form of the gate) adds "record
  it with apply_move" to every message. `freeform` sends ONLY the human's
  words, like a real chat client; the duty to record lives in the system
  prompt alone. Freeform is the real-life condition. Pair it with the **claims
  audit**: `fabricated_confirmations` in the result counts turns where the
  reply said "done" but NOTHING was recorded. This has been seen in real chat
  sessions. It shows up as a `FAB ` flag in the live stderr lines.
  The transcript file name carries the assistant model and the mode
  (`desync-<game>-seed<S>-<model>[-freeform].json`), so baseline runs with
  different models don't overwrite each other.
- `--from-setup [--human-name=<name>]`: the **setup run**. Instead of the
  harness creating the MODEL session itself, the assistant is asked in plain
  conversation ("set up <game> for me, my name is X, one medium AI…") and
  must call `list_games` / `get_rules` / `create_session` on its own. The
  run's seed is slipped into its call, and the check a chat client applies to
  tool arguments before sending them is copied (the same short rejection
  LibreChat returns). The reference session is still created correctly, so a
  wrongly built session is measured: the `setup` block of the result reports
  create attempts, rejections and recovery, and seat-by-seat differences
  (wrong human/AI kinds, missing name, wrong difficulty, invented AI names).
  Then the normal loop plays the game on the session the model created (the
  player ids it chose are matched up by kind order). This covers the phase
  every other run skips, and setup is where real chat games have broken down
  first. The file name gains a `-setup` suffix.
- `--human-seat=I`: which seat index is the human (default 0). The human's
  side follows the game's default identity assignment by seat order, so for a
  game whose default puts seat 0 on side A and seat 1 on side B,
  `--human-seat=1` plays side B. **Run both seats**: each side has its own
  setup and report flow and its own bugs.
- Other flags: `--human=<model>` (the model named for the human side),
  `--out=<dir>` (default `./harness-out`), `--no-think` (runs the assistant
  with the model's thinking turned off, to see whether tracking holds up
  without it).

A full game driven by a language model takes many minutes. Run it in the
background, watch `.stderr` for the live `[turn] ok|MISS|WRONG` lines, and read
the `.stdout` summary plus the `harness-out/desync-<game>-seed<S>-….json`
transcript when it finishes.

The goal of each round: push `first_desync_turn` later until the run reaches
`NO DESYNC — the assistant tracked the entire game correctly`.

## The loop

```
1. Build, then run one seed (one seat).
2. Read the result: first_desync_turn, surfaced_how, and the wrong/missed list.
3. Open the transcript at the turn of first_desync, or just before it. Read:
     - human_utterance (what the human said)
     - ground_truth    (the move the human actually made)
     - recorded        (what the model applied; null when it recorded nothing)
     - tool_calls      (apply_move rejections, get_rules loops, etc.)
     - assistant_reply (often shows the model's confusion in words)
4. Decide the cause (next section): server bug, the simulated human, or the model.
5. Fix the smallest thing that addresses it. Lock it with a unit test.
6. Rebuild, re-run the SAME seat and seed. first_desync should move later (or vanish).
7. Repeat until clean, then run more seeds and the other seat.
```

Don't batch fixes blindly. Each desync usually has ONE root cause, and the rest
of the wrong/missed list follows from it. Fix the first, re-run, and most of the
rest disappears.

## Find the cause before you fix

There are three causes, and each is fixed in a different place. Telling them
apart is the whole job.

### A. Server or game bug: the legal moves, the directive, or the true move is wrong

Signs: `get_legal_moves` returns an empty list (or the wrong options) for a
step the human owes; `describeNextStep`, `getLegalMoves` and
`autoResolveReport` **disagree** on which step is owed or in what order; the
model invents a move type or slot because nothing valid was listed.

These are the most valuable fixes, because they would trip up a real assistant
too. Fix them in the game module.

### B. The simulated human doesn't talk like a real one

Signs: the model is rejected or confused by something no human would actually
say: an internal id instead of a printed name, an instruction for editing a
template read out word for word, a flat list that can't be parsed, mechanical
jargon. The engine is fine; the *simulated human* is the problem.

Fix it in the game's `desync` dev hooks (its wording for moves and values),
or in the game's `autoResolveReport` (make the true move use names, not ids).
If the problem is in the harness's general wording, which every game shares,
it is a fix to `@zekel/dev`'s `harness/desyncBot.ts`. A faithful simulated
human is what makes the harness a fair test. Don't "fix" these by making the
model's job artificially easy; make the simulated human talk like a human.

### C. The model just gave up

Signs: the same step works on most turns and fails now and then; the
`assistant_reply` shows it looping on `get_rules` or trailing off; it runs out
of tool calls. Re-running the same seed sometimes passes the same turn.

Often there is nothing to fix on the server. But check whether a clarity
change (a clearer name, an explicit fill-in template, the exact expected
counts in the directive) raises the odds. A weak model's failures are a matter
of chance, and clearer wording shifts the chances.

### How to tell B or C from a real server bug: replay with no model

This is the deciding test. Write a replay of two sessions **with no language
model** that mirrors the harness: REFERENCE applies the full true move; MODEL
applies the move through **its own `move_id` expansion** (what the assistant
does). Compare the two exactly after each step:

- If they stay byte-for-byte identical to the end of the game, then **the
  engine and the `move_id` mechanism are correct**. Every desync in the live
  run is B or C (how the human speaks, or how reliable the model is), not a
  server bug. Stop hunting in the engine.
- If they diverge, you've found a real ordering or expansion bug. The point
  where they diverge and the field name tell you where.

You can also replay the **actual moves from the transcript** (`ground_truth`
to the reference, `recorded` to the model, the equivalent of `run_ai_turn`
for AI steps) and compare exactly, to find the first *true* divergence.
`first_desync_turn` uses a comparison that ignores order, and that can hide a
difference in deck order until it shows up in some other way later.

Both are quick standalone node scripts run against the built server. Write
them, run them, delete them.

## Reading the output carefully: two traps

- **The advisory per-turn match can report failures that aren't real.**
  `correct_turns/human_turns` and the wrong/missed list use a per-turn match
  on meaning that can over-report failures. The real desync measure is the
  **state comparison** (`first_desync_turn`, `desync_detail`), not the
  per-turn flag. A turn flagged WRONG whose state still matches reality is a
  false alarm (for example, the model recorded the same card by `card_id`
  while the human said its `card_name`). The harness turns ids into names and
  treats `card_id` and `card_name` as the same for this check, but confirm
  against the state comparison before treating a WRONG as real.
- **The diagnostic field may have the wrong name for your game.**
  `model_state_on_fail` reads general fields (such as `pending`). A game that
  stores its pending decision under a different name will show `pending: null`
  even when a decision is pending. Don't trust that field for such a game; read
  the game's own view.

## The bugs that keep coming back (and how they get fixed)

Every game so far hit the same handful, and the fix has the same shape each
time.

1. **No legal moves on a step the human owes.** A report or refill phase whose
   `getLegalMoves` returns `[]`, so the model invents the move type and slot.
   *Fix:* offer a hint move (a `move_id` plus a template) for that phase, the
   same way a working phase next to it does. (In one port: the phase where the
   human refills a shared row of cards after an AI action.)

2. **The three sources of "what's next" disagree on order.** `getLegalMoves`,
   `describeNextStep` and `autoResolveReport` must agree on **which** step is
   owed and in **what order**, *for each seat*. When they drift apart, the
   model follows its legal moves while the human declares a different step.
   *Fix:* make all three follow the same order of priority, and make sure
   branches that depend on the seat or its identity only fire for the right
   seat. (In one two-sided port, setup went wrong from both seats: a hidden
   setup pick that only one side makes was asked of the wrong side, and one
   side had to place its pieces before reporting its hand.)

3. **The model must produce a word it can't read in any tool response.** A
   move field needs an internal id, a kebab-case key, or an exact enum
   spelling the human never sees. *Fix:* accept the **printed name** (turn
   the name into the id on the server), and make the true move and the spoken
   sentence use the name, not the id. (This has hit several ports' cards.
   Sweetlands Imperium accepts a reported card by its printed name in any
   case or spacing; see [building-a-game.md, "Don't make the model
   guess"](./building-a-game.md).)

4. **A fill-in template that hides its shape.** A choice the model must
   *build* is shown as an empty `choice:{}` (or a bare template), and the
   model decides "the human's value isn't in the legal moves" and gives up.
   *Fix:* show the fields (`{cards:[]}` / `{faces:[]}`) and a direct
   description, "this template IS the move, fill it in". For rolls, state the
   exact expected counts. (In one port, every kind of report move had this
   problem.)

5. **The AI uses unseeded randomness.** `Math.random()` anywhere in the AI makes
   the two sessions run side by side drift apart on their own: a phantom desync
   that no assistant mistake explains. *Fix:* send every random choice the AI
   makes through the seeded random number generator. **Search each game's
   `ai.ts` for `Math.random` first.** (In one port: a random tie-breaker in
   the AI's scoring.)

6. **Doing too much.** After recording the human's one declared move, the
   model chains extra moves, or plays out an AI seat's whole turn, racing the
   board ahead. *Fix:* the server's own guard in `apply_move` refuses a normal
   AI-seat turn (error `AI_SEAT_NO_APPLY`, "use run_ai_turn") while still
   allowing reports the human owes that are routed to an AI seat. (This
   applies to every game; it lives in `@zekel/mcp`'s `mcp/tools.ts`.)

7. **The simulated human says something no human would.** An instruction for
   editing a template read out word for word ("…EDIT each to a legal type"), a
   flat comma list of dice the model miscounts, the `resolve_choice` /
   `choice:` wrapper that hides what's inside. *Fix, in the harness's wording
   (`renderUtterance` / `renderValue` in `harness/desyncBot.ts`, or the
   game's `desync` dev hooks for game-specific wording):* skip the editing
   instructions and say the values; separate the items of a list of objects
   with `;` so each can be counted; unwrap `resolve_choice` to what's inside
   ("I'm reporting my cards: …").

## Lock every fix with a test

A harness run is slow and its results vary; a unit test is fast and gives the
same answer every time. For each fix, add a test that checks the rule
directly:

- Order and agreement of the three sources: drive setup the way the harness
  does (the automatic report, else the first legal move) and check it finishes
  without ever leaving the human with no legal moves, and in the right order,
  **for each seat**. Cybernoir 2127's
  `packages/cybernoir-2127/src/__tests__/setupDirectives.test.ts` (zekel-games)
  checks the setup checklist and the next-step directive for each
  arrangement of human and AI seats.
- A hint move: check `getLegalMoves` returns the expected `move_id` with the
  right slot in that phase. Sweetlands Imperium's
  `packages/sweetlands-imperium/src/__tests__/humanFlow.test.ts` checks that
  its report template shows the shape of each card object, not an empty list.
- AI determinism: two playouts with the same seed produce the same move
  sequence; different seeds differ. Model:
  `packages/sweetlands-imperium/src/__tests__/aiDeterminism.test.ts`.
- The `apply_move` guard on AI seats: check the directive condition it
  depends on.

Then run the full suite (`pnpm test`). A desync fix must not break any game.

## Checklist for each game

- [ ] Search `ai.ts` (and the files around it) for `Math.random`; seed any hits.
- [ ] Run seed 1, seat 0; repeat the loop until `NO DESYNC`.
- [ ] Run the **other seat** (`--human-seat=1`). Each side has its own setup and
      report bugs (in one two-sided game, two setup bugs only appeared from the
      second side's seat).
- [ ] Run 2–3 more seeds per seat to reach paths only some deals produce.
- [ ] Confirm with the replay with no model that any remaining desync is B or
      C (how the human speaks, or the model), not a server bug.
- [ ] Every fix has a unit test; the full suite passes.

## The lesson under every fix

**Don't make the model guess, and don't make the simulated human talk like a
machine.** Accept the printed name; show the valid options and the shape of
the move in something the model already reads; make the three sources of
"what's next" agree for each seat; and say values the way a person actually
would. When all of that holds, even a small model tracks a full game.
