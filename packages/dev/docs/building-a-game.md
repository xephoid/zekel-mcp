# Building a game: the rules every game follows

These are the rules a game for the Zekel MCP server is built to. The runbooks
check them; this page says what they are and why. Read it before a port, and
come back to the section a runbook points at.

A game is one module that exports a `Game` object (the interface is in
`@zekel/game-kit`, file `game.ts`). The server (`@zekel/mcp`) turns any such
object into MCP tools. A game imports shared code **only** from
`@zekel/game-kit` — never from `@zekel/mcp`, another game, or a project's
tools. Node's built-in `node:` modules are fine. That keeps every game movable
on its own. Tests may use anything.

Examples below point at Zekel Games' own games in the
[zekel-games](https://github.com/xephoid/zekel-games) repo, under
`packages/<game>/src/`.

## Physical-first design

The human plays with a **physical** copy of the game on a real table. The
server keeps the books for shared state and plays the AI opponents. It is not
running a virtual game for the human.

So sort every piece of state by two questions: **who holds the truth**, and
**who may see it**.

| Kind of state | Truth held by | Seen by | Used for |
|---|---|---|---|
| Public, shared | Server | Everyone | Supply, scores, anything on the table |
| Tracked by the server, private to an AI | Server | That AI | The AI's own deck, hand and discard |
| Dealt by the server, private to a human | Server | That human | Cards the server dealt a human from a shared deck (next section) |
| Held by the human, private | The human | The human | A hand or deck the human shuffles themselves |

In a game where each player has their own deck, this comes down to: the AI's
cards are tracked, the human's are not. Moves then take a different shape per
player. A tracked play names a position in the hand (`hand_index`). An
untracked play names the card (`card_id`); the server checks the card could
exist in the game, then trusts the human's word. Fractured Fist works this way
(`fractured-fist/src/types.ts`).

**Every game declares this sorting at the top of its `types.ts`**, as a
comment listing every deck, hand and hidden zone and which kind it is. This is
the first decision of a port. Get it wrong and every move shape after it is
wrong.

## Shared decks

When players draw hidden cards from one deck they all share, neither "tracked"
nor "held by the human" works. **The server must own that deck:**

- The server shuffles it when the session starts and owns the order.
- When an AI draws, the server takes the top card. The AI's report says "the
  AI drew a card" without saying which.
- When a human draws, the move's reply gives the card **privately** to that
  human. The AI never sees it. From then on the server keeps track of that
  human's hand and checks moves against it.

Privacy is done by filtering each reply: every move reply carries only what
the caller may know. Write each reply's shape down in `types.ts`, so a leak is
easy to spot in review. The kind is decided per deck, not per game: one game
can have a shared deck and private decks side by side. Declare each one.

## Telling the model what comes next

A language model sits between the human and the server. It forgets, and it
fills gaps from what it remembers about other games. So every reply that moves
the game on — `create_session`, `apply_move`, `get_ai_move`, `get_state` —
carries a **`next_step`**: the one statement of whose turn it is and what to
call next. It must never go quiet or be wrong.

`run_ai_turn` plays AI moves until a human is owed something or the game ends,
and returns the list of moves made. One call instead of many.

The server works out a plain `next_step` from whose turn it is. It does not
know the game's phases, so it is wrong during setup, during "report what you
drew" steps, and whenever a human owes an answer in the middle of someone
else's turn. Two optional hooks fix that:

- **`describeNextStep(state)`** returns a `NextStep` or `null`. A non-null
  answer replaces the plain one. Rule of thumb: when a **human** must answer
  something, name the exact move and the value to ask the human for ("ASK …
  do NOT invent it"). When an **AI** owns the same question, return `null` and
  the AI answers it. Cover every question a human can owe, during setup and
  during play. Cybernoir 2127 does this; its test is
  `cybernoir-2127/src/__tests__/setupDirectives.test.ts`.
- **`getSetupChecklist(state)`** returns the setup moves to make after the
  session is created, in order, each with the move type, how many, a
  description, and what to ask the human. Return `[]` when the game is ready
  at once (for example, all AI seats).

Two rules apply to every game, in the server's standing instructions
(`@zekel/mcp`, `mcp/serverInstructions.ts`), because models rebuild rules
from memory:

- **One action per move.** Each `apply_move` is one action. Never chain steps
  from memory ("draw, then attack"). Follow `next_step`; ask
  `get_legal_moves` what is legal now.
- **Use this session's numbers.** Hand sizes, supply counts and card values can
  change with player count and options. Read them from this session's replies,
  not from general knowledge. A game's guidance points at the session's value
  and never recites a number.

So a new game should: say its turn structure in `getSessionStartGuidance`
(any "exactly one of these per turn", which actions end the turn); implement
`describeNextStep` for every answer a human can owe; implement
`getSetupChecklist`; and point its guidance at session values.

## Setup choices belong to the player

Many games start with each player picking something: a colour, a faction, a
character. The plain turn loop would hand these out by seat number, choosing
for the human. The server's rule is: **setup choices belong to the human;
never pick them silently. Humans choose first,** then each AI seat gets one of
the options left.

`@zekel/game-kit`'s `setupChoices.ts` wires this up in a few lines:

- One move, `{ type: 'assign_setup_choices', selections: { [playerId]: optionId } }`.
  The first human seat reports the whole table's picks.
- While a human is present, the game blocks in its setup step until that move
  arrives. With all AI seats, it hands options out by seat and skips the
  question.
- The game owns the list of options and where the picks are stored. If the
  pick changes what a player is (a faction with its own pieces), resolve it
  first, before anything that depends on it is placed.
- The helpers check the picks and write the checklist and `next_step` text:
  `validateSetupSelections`, `defaultSetupAssignment`,
  `setupChoiceChecklistStep`, `setupChoiceNextStep`.

Sweetlands Imperium uses it for factions (`sweetlands-imperium/src/engine.ts`).

Two related rules the server gives the model: **ask each human their name**
before creating the session (an AI seat is never given an invented name; its
name is its colour, faction or character), and **ask how hard each AI should
be** (`easy`, `medium`, `hard`, `mcts`) instead of letting the default stand.

## Reporting voice

Report in plain game terms: exact card, action, resource and space names from
the move summaries. No story, no flavour, no invented detail. Weak models
could not keep game terms intact inside prose; "the AI captured a card with a
14 and refilled the row" turned into "the AI made a bold play", and the human
lost track of the table.

One reversal matters. For the **human's own** moves, the model just confirms
briefly. For **AI moves**, the human has to carry them out on the physical
table, so the model must relay **every fact that changes the table**: what was
played, rolled, taken, built, moved, bought or discarded, where it went, and
what changed. Completeness beats brevity there, but it stays plain. Never
"the AI took its turn". Never reveal the AI's hidden hand.

Each move's `state_summary` is the one canonical text for that move. A voice
client reads it aloud as-is. An AI move's `narration` is optional flavour and
never carries a fact the summary lacks. How to write summaries is in
[spoken-narration.md](./spoken-narration.md); `pnpm check-summaries` checks
them.

## Don't make the model guess

When a move field must hold a value from a fixed set — a card, a space, a
tile, an option — the server is the model's only window onto that set and its
spelling. If the model has to guess an internal id it has never seen, it
guesses wrong, the move is refused, nothing is recorded, and the table and the
server quietly drift apart.

Two rules:

1. **Accept the name printed on the component.** Any field naming a physical
   thing accepts the printed name, ignoring case, spacing and punctuation.
   Turn the name into an id on the server with a `resolveX` helper. The
   refusal message lists the forms it accepts. Prefer `*_name` fields over
   `*_id` fields. Every Zekel game has resolvers (search its `src/` for
   `resolve`).
2. **Show the options somewhere the model already reads.** `get_legal_moves`
   lists real options; `get_state` names things by their printed names;
   `next_step` lists the choices; `get_rules` carries the move shapes and the
   reference tables. The model picks; it never invents a format.

The test: *to fill this field, must the model produce a string it cannot read
in any reply?* If yes, accept the printed name or list the options. Lock it
with a resolver test.

The desync bot ([desync-harness-runbook.md](./desync-harness-runbook.md))
measures exactly this.

## The move menu

Every reply where a human is on the clock carries a **`move_menu`**: the legal
moves as a numbered list, so the human types "3" and the model sends the
matching `move_id`. It is drawn only from `get_legal_moves`; it never decides
what is legal. Short lists come out flat. Long lists are grouped by move type,
then by whichever field splits each big group best, with pages as the last
resort, so no level is too long. Every game gets this for free
(`@zekel/mcp`, `mcp/moveMenu.ts`).

A game can group its own menu with the optional `describeMoveMenu(state,
legalMoves)` hook (return `null` to use the default; `composeMenu` in
`@zekel/game-kit`'s `moveMenu.ts` does the boilerplate). Do this when the
default grouping pages through most busy turns, or when many options are the
same thing (seven identical pieces going to the same space are one choice).
When an override merges options, set `total_moves` to the number actually
offered.

**Offer every option, don't sample.** If `get_legal_moves` leaves out the move
the human wants, the model picks a nearby wrong one and the game drifts. In one
port, a cap of 24 listed moves hid the target on an open board. Where the set
of values is truly unbounded, accept a declared form instead, check it exactly
in the engine, and have `describeNextStep` tell the model to use it.

## Rules teaching

Every new game must have this. The problem: when a move the player expects is
missing from `get_legal_moves`, nothing says why, so the model invents a rule.

The pieces:

- **`getRulesSections()`**: the rules as addressable sections, tagged with the
  move types and phases they cover. `get_rules` can then return one topic.
- **Gate declarations** (`describeMoveGates`): for each move type, the
  conditions that make it legal. One declaration produces three things: the
  grey "not available because…" line in `get_legal_moves`, the refusal message
  from `apply_move`, and the trigger for teaching the section. Never write
  those three as separate prose. `checkGateConsistency` (`@zekel/game-kit`,
  `moveGates.ts`) checks the declarations agree with `getLegalMoves`.
- **Teaching on first contact**: the first time a seat meets a tagged
  situation, its section comes along once in a `rules_briefing` field.
- A failed move gets the full lesson.
- Each seat can turn teaching off; the grey list stays either way, because it
  prevents drift.

Adventurer Olympics, Fractured Fist and Neither Guts nor Gears declare gates.
Details: [rules-teaching.md](./rules-teaching.md).

## The game log

A shared log, so AI moves, spending and round changes are **reported, never
silently applied**. Entries use names and board places, never ids, and never
reveal hidden information. It shows in `get_state` (`log`). Two ways to adopt
it:

- **Full:** `getLog(state)` returns entries the engine writes during
  `applyMove`. Each move's summary is the new entries rendered. Neither Guts
  nor Gears does this (`neither-guts-nor-gears/src/__tests__/logDetail.test.ts`).
  Copying the log on every move makes AI search slower, so keep a depth cap
  on the AI's look-ahead.
- **Cheap:** `getScoreboard(state)` returns each player's public numbers; the
  server compares before and after each move and logs the changes. Fractured
  Fist does this.

## Pending state hygiene

Every code path that *might* set a pending question must also handle the case
where it can't, and set `state.pending = null` explicitly. A pending question
nobody can answer makes the AI loop forever. (Real cases: a "draw until…"
effect with an empty deck.)

The mirror rule for the AI: when the engine deliberately skips an action in an
edge case (an effect that targets a hand that is empty), the AI must still
send a valid move for that path, not throw.

## Simulation fidelity

When code stands in for real game mechanics — the AI-vs-AI runner, an AI
reporting cards in place of a human, any simplified model — **follow the
printed rules. No statistical shortcuts, no "close enough on average".**

In one port, the stand-in for a human revealing cards sampled them at random by
weight instead of shuffling a real deck. On average it matched, but it skipped
the rule that removes some cards at setup, and in 100 games it surfaced one
rare card once. The fix was to build a real deck once, apply the setup rules,
and reveal cards in order. If a stand-in must differ from the rules, say so in
a comment, and prefer the faithful version.

## Saved sessions outlive code changes

Sessions are saved (MongoDB or SQLite), and they outlive code changes. Any
change to a game's state types — a renamed, removed or retyped field, a
changed pending shape, a new required field — can break saved games. Either:

- **Tolerate absence** (additions only): give the new field a default when an
  old session loads.
- **Migrate**: the server's store has a schema version and a `migrate()` step
  (`@zekel/mcp`, `core/store/`). A game-state change that cannot be read as an
  addition needs a migration there, which means a server release.

## Porting from an existing version

When a game already exists in code (an app, a prototype):

1. **Port as exactly as possible.** Match its structure, names and control
   flow first. Where you can't (language idioms, sync to async, the
   physical-first split), comment the difference and what it does to play and
   to the AI. Keeping the original's bugs is fine until you've shown it wrong.
   "Improving" code you don't fully understand gives you a second game, not a
   port.
2. **Where you can't port exactly, read the rulebook,** not your instinct. The
   printed rulebook is the truth; the old code is one reading of it, possibly
   wrong. Write the mapping down in a comment.
3. **AI ports need precision.** Weights, decision order, tie-breaks and
   constants all matter. Keep them word for word. If you change the structure
   (a whole-turn planner into a one-move scorer), it must rank the same moves
   the same way on the same inputs. Lock it with tests that compare the two.
4. **Check against the rulebook before calling it done,** section by section:
   every phase, action, "you must", "you may", scoring case, tie-break and end
   condition. Passing tests is not this check.
5. **Look for edge cases and question every simplification:** the deck runs
   out mid-draw, there are no legal moves, two endings trigger at once, a card
   must come from an empty hand, a number reaches the end of its range.
6. **Don't abbreviate.** Full words in field names, enum values, types and
   text ("Safe House", not "SH"). The model reads field names as part of its
   instructions. In one port, a model kept getting a comparison backwards
   until a field `result: 'higher' | 'lower'` was renamed to say whose card was
   higher than whose.
7. **Find shared hidden decks before designing moves.** They need the
   server-dealt kind (above). Declare each zone's kind in `types.ts`.

## What fully playable means

A game is **fully playable** only when **every rule and feature in the printed
rulebook is implemented exactly**, and a human can play a whole game against
the AI with every card, action, phase, choice, objective, tie-break and
scoring rule working as printed.

It does **not** include: placeholders (one effect standing in for another),
reduced first versions, "close enough", effects or phases skipped or turned
into no-ops, player counts left out, or "not implemented" errors at run time.
Those are fine only as clearly commented steps in an unfinished port. Never
call a partly built game playable; say exactly what is missing.

Confirming a game is fully playable is the post-port check
([post-port-runbook.md](./post-port-runbook.md)). In short:

1. Walk the rulebook section by section.
2. Search the game for `placeholder|MVP|stub|TODO|FIXME|approximat|for now|not yet|simplif|deferred|no-op`
   and resolve every hit, or record it as an expansion left out on purpose.
3. Lock the important constants and tables with tests.
4. Run AI-vs-AI batches (`pnpm harness`) at **every player count** with
   **zero errored games**. The AI must *use* every mechanic, not just survive.
5. Declare the game's balance axes in `getBalanceAxes()`: a faction or
   character pick is `identity`, a loadout or draft is `config`, a scenario is
   `scenario`, a colour or seat is `cosmetic`.
6. **Play it in your head, slowly, from a human seat.** Hunt for any choice the
   game quietly makes *for* the player — a colour, a target, a discard, an
   order, a split. Every choice the human should own must be asked.
