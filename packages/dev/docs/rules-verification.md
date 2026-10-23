# Rules verification — a second statement of the rules (design record + how a game adopts it)

This is not a gate of its own. It rides inside two existing gates:
port-planning writes the paper half
([port-planning-runbook.md](./port-planning-runbook.md)), post-port runs the
executable half ([post-port-runbook.md](./post-port-runbook.md)), and any later
engine change runs it again. It was proven on Cybernoir 2127, where it found a
real engine bug that 9,600 random games had missed.

The tools are the `verify-lint` and `verify-hunt` commands in `@zekel/dev`
(called "the rules checker" in its README). The reference adoption is
Cybernoir 2127 in zekel-games: `packages/cybernoir-2127/src/dev/verify/`.

## The problem it exists for

Ports ship one particular kind of bug: the engine confidently does something
the rulebook doesn't say. It comes in three shapes:

- **vague wording** — the book supports two readings, and the port silently
  picks one;
- **silence** — the book says nothing, and the engine invents a behaviour;
- **missing limits** — the book never forbids something, and the engine
  allows it.

Checking rules is always a comparison between two independent statements of
them. The port is one. This tool is the other — written from the rulebook
alone, never from the port's code.

## The two halves

**The paper half** (at planning time): a typed list of every rule, each
quoting, word for word, the rulebook sentence it comes from. Every place where
the book is silent or can be read two ways is its own entry — a gap is written
down, never left out. Two mechanical checks run on it (`verify-lint`, code in
`@zekel/dev` `verify/lint.ts`):

- every quote must appear exactly in a pinned plain-text copy of the rules;
- every combination of a place on the table and a thing that can happen there
  must be a rule, a recorded gap, or an explicit "nothing applies here,
  because…".

The recorded gaps are a findings list before a single game is played. They
become questions for the designer.

**The executable half** (post-port): checking rules that run. The driver
(`@zekel/dev` `verify/exec/driver.ts`) imports the game directly and plays
whole games through the engine (around 100 games a second — going through the
MCP server would make this crawl). After every move, per-game rules predict
what the affected fields of the next state must be, worked out from the
engine's own previous state. Any mismatch is reported with the seed, the move,
the rule, the quoted sentence and both values.

On top of that, the hunter (`@zekel/dev` `verify/hunter/`) evolves small,
readable strategy programs that are rewarded only for finding disagreements
not already found. It steers play into corners random play never reaches.

One design choice matters: the rules side keeps NO state of its own. It
checks each move against the engine's state before and after; it does not run
a parallel copy of the game. That makes partial rule coverage safe — no drift,
no false alarms — at the cost of the blind spots listed below.

## What it catches, and what it cannot

What it did on Cybernoir 2127:

- The paper half surfaced a silence in the rulebook about one rule that had
  already produced a real shipped bug, plus 26 other recorded gaps, about two
  of them noise.
- The executable half caught a deliberately re-planted old bug in its first
  game. (That planted bug turned out to be too easy to be a real test of the
  hunter: the per-move checks caught it alone. When you plant a bug to test
  the tool, pick one that random play rarely reaches.)
- It found a REAL, previously unknown bug: the engine drew an empty card when
  one deck and its discard pile were both empty. 9,600 random games never
  reached that state; the hunter reached it in 168.

It cannot catch:

- a rule the book states clearly but the designer later reverses (nothing in
  the text is wrong — only playtests or the designer catch those);
- a legal move the engine wrongly WITHHOLDS (the checker only sees moves the
  engine applies; post-port §7a, which checks every withheld move has a
  reason, is the net there);
- bugs in fields no rule predicts (coverage is explicit — add rules when you
  need them).

It also inherits one weakness: the checking rules may read the game's data
tables (a typed-in copy of the rulebook's card lists). If the tables differ
from the printed cards, the checker has the same error. Checking the data
during the port is the guard there.

## Where the files live

The shared parts are in `@zekel/dev` (zekel-mcp `packages/dev/src/verify/`):

```
verify/
├── types.ts            # the paper-half types (the same for every game)
├── lint.ts             # the exact-quote + coverage checker (same for every game)
├── exec/
│   ├── types.ts        # the common shape, events, checking-rule types
│   ├── driver.ts       # direct-import game loop + comparison; describes the adapter
│   └── adapters.ts     # finds a game's adapter through its dev hooks
└── hunter/             # genome.ts (strategy trees), evolve.ts (rewarded evolution),
                        # versus.ts (versus mode, below)
```

Each game keeps its own parts in its package, under `src/dev/verify/`
(Cybernoir 2127's, in zekel-games):

```
packages/<game>/src/dev/verify/
├── rules-<version>.txt   # the pinned plain-text rules
├── encoding.ts           # the paper half
├── project.ts            # turns the game state into the common shape
├── rules.ts              # the checking rules, each quoting the pinned text
├── adapter.ts            # ties it together for the driver and the hunter
└── __tests__/            # oracleCitations.test.ts (every quote is in the text), …
```

The adapter is listed under `verify` in the game's dev hooks
(`packages/<game>/src/dev/index.ts`; see the `@zekel/dev` README for dev
hooks). Fractured Fist and Sweetlands Imperium have the executable half; Neither
Guts nor Gears has the paper half; Adventurer Olympics has both.

Commands (these are the script names zekel-games uses; another project wires
them up the way the `@zekel/dev` README shows, or runs them as
`pnpm tool <command> [args]`):

- `pnpm verify-lint -- --game=<id>` — check the paper half; prints the list
  of recorded gaps. By default it loads `src/verify/<game>/encoding.ts` from
  the current folder; pass `--encoding=<file>` when the encoding lives
  elsewhere (zekel-games' `scripts/dev.ts` adds it, pointing at the game's
  package).
- `pnpm verify-hunt -- --game=<id> --mode=random --games=1000` — the
  calibration run (random play, the control).
- `pnpm verify-hunt -- --game=<id> --mode=hunt --pop=40 --gens=20 --games-per=12`
  — the hunter (about 9,600 games, a few minutes).
- Both take `--seed=<n>` (default 1) and `--max-moves=<n>` (default 600, a cap
  on moves per game).

## How a game adopts it

**At port-planning** (details in the port-planning runbook, its
rules-encoding section):

1. Pin the rules as plain text, with a version, at
   `packages/<game>/src/dev/verify/rules-<version>.txt`.
2. Write the encoding from the rulebook text ALONE, in a fresh context given
   only the pinned text and `@zekel/dev/verify/types.ts`. Independence is
   built in (no port exists yet to copy) and must stay built in: the author
   sees nothing else of the project.
3. Run `verify-lint` until there are zero structural problems. The silent and
   vague findings go into the plan's risk list and the list of questions for
   the designer.
4. Commit `encoding.ts` with the plan.

**At post-port** (details in the post-port runbook, its
executable-verification section):

5. Build the glue in `packages/<game>/src/dev/verify/`: the projection to a
   common shape (`project.ts`), checking rules that quote the pinned text
   (`rules.ts`, locked by a citation test), and an adapter (`adapter.ts`)
   listed under `verify` in the game's dev hooks. Reference: Cybernoir
   2127's folder.
6. Calibrate: a random-play run must be SILENT on the finished engine. Every
   alert is either a bug in a checking rule or the glue (fix it) or a real
   disagreement between the engine and the book (a post-port finding). Sort
   each one; never tune an alert away without naming which of the two it was.
7. Run the hunter, and sort what it found the same way. Record both runs in
   `packages/<game>/POST-PORT.md` (or in a findings file the game keeps
   beside it, linked from POST-PORT).

**Standing safety net:** any change to a game's `engine.ts` or
`legalMoves.ts` — balance dials and designer rulings included — re-runs that
game's calibration and a hunter batch. Your project's status table (zekel-games
keeps one in `GAMES.md`) should carry this trigger. When a designer ruling
changes the rules, update the pinned text and the affected rules and encoding
entries FIRST, in the same change; the citation tests refuse quotes the new
text no longer contains.

## Versus mode — the same machinery aimed at the game's AI

`pnpm verify-hunt -- --game=<id> --mode=versus --role=<seat> --difficulty=<level>`
evolves the same readable strategy trees, but rewards them for BEATING the
game's own AI instead of for finding rule disagreements. It looks for cheap
winning lines, for the ai-development and balance gates
([ai-development-runbook.md](./ai-development-runbook.md),
[balance-harness-runbook.md](./balance-harness-runbook.md)). Extra flags:
`--pop`, `--gens`, `--games-per`, and `--holdout=<n>` (default 200).

What it prints: the best strategy in words, its win rate on HELD-OUT games it
never trained on (never the training number), and a random-play baseline on
the same held-out seeds. Best ≈ baseline means no simple winning line at that
budget. Best well above baseline is a degenerate line to fix, delivered as its
own readable report. The checking rules stay on while it plays, so any rules
alert seen along the way is printed for you to look at separately.

It needs only the projection and the adapter, not the checking rules, so a
game can adopt versus mode alone for a couple of hours of glue.

Limits:

- Strategies prefer move TYPES, not specific targets. A winning line that
  depends on which target or which card is invisible to it.
- The `mcts` AI level is too slow to play against at evolution scale. Use the
  heuristic levels, and confirm against `mcts` with small batches.
- A strategy that never ends its turn can stall a game for ever (for example
  by repeating a free action). The `--max-moves` cap ends such games and
  counts them as losses, which is the right score for a player that won't
  finish.
- If a seat produces zero wins in thousands of tries, evolution has nothing to
  select on. Before trusting a zero, check the harness can produce wins for
  that seat at all — play the game's own AI in that seat through the same
  driver.

First run, on Cybernoir 2127 (every seat against every heuristic level): no
simple strategy beat the AI. One seat matched the random baseline (that seat
needs real deduction, which a strategy tree can't do); the other won nothing
(it needs coordinated play that move-type preferences never produce), and the
check above confirmed the game's own AI does win from that seat. That is a
pass for the AI and, at the same time, a picture of the tool's bluntness.

## How much to cover

Rule coverage is allowed to start partial and grow. Start with turn
structure, action costs, "every card is in exactly one place", and the
mechanics the plan's risk list flagged as disputed. "Every card is in exactly
one place" style rules are the cheapest wide net: one rule catches
duplication or loss anywhere. The hunter's suggested budget (40 × 20 × 12)
runs in minutes; there is no reason to cut it on a re-run.
