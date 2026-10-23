# Relay-harness runbook

How to run the relay harness against a game, read what it reports, and fix,
one at a time, the failures it finds. "Relay" here means the assistant telling
the human, in words, what the AI just did. Companion to
[desync-harness-runbook.md](./desync-harness-runbook.md), which tests the
*incoming* half of the table loop (the human declares a move, the model records
it). This one tests the *outgoing* half.

## What the harness measures (and why)

The human at the physical table is the AI's hands. Every AI move exists on the
real board only if the assistant's **words** carried it. The server already
does its part: `run_ai_turn` returns every move with a `state_summary` and a
`report_to_human` directive ("REPORT AI MOVES IN FULL"). But nothing checked
that a weak model actually turns that JSON into words a human can act on. A
relay fails by **leaving out** a fact that changes the board, **making one
up**, **giving away** hidden information, or being too **vague to act on**
("the AI made a bold play"). Any of these silently pulls the physical board
away from the server's record, exactly like a wrongly recorded human move.

The harness makes that measurable as a **round trip**:

1. **RELAYER** (a weak language model): gets the actual `run_ai_turn` response
   JSON and writes what it would say to the human. (`--calibrate` and
   `--spoken` skip this step; see below.)
2. **READER** (a second instance of a weak model, starting fresh): sees ONLY
   those words and fills in an **outline** of the AI's moves. The outline is
   the real move shapes with every value blanked to a typed placeholder
   (`"<string>"`, `"<number>"`); the move types and the structure are kept.
   The outline gives away the *structure* (how many moves, what shapes); only
   the *values* are under test.
3. **APPLY**: the filled-in moves are applied to a shadow **MODEL** session:
   the physical board a human would have built from the words alone. Moves
   that are rejected or left unfilled are skipped (the human shrugs and does
   nothing), and the difference carries forward.
4. **Headline**: a comparison of the MODEL state with the REFERENCE state.
   It is the same comparison, ignoring session differences, as the desync
   harness uses, and the same code.

Human turns are played **the same fixed way on both sessions** (the desync
harness's rule for the true move: the automatic report, else the suggested
move, else the first legal move), with no language model. So every difference
comes from the relay.

Headline numbers (`RelayResult` in `@zekel/dev`'s `harness/relayBot.ts`):

- `first_relay_desync_step` / `first_relay_desync_batch`: the first batch of
  AI moves after which a board built from the words differs from reality.
- `surfaced_step` / `silent_steps` / `never_surfaced`: how long that stays
  invisible (the tracked turn and phase still match), as in the desync
  harness.
- `batches_matched / ai_batches`: how many batches made the round trip
  correctly.
- `facts_in_relay / facts_total`: an advisory word-matching count of how many
  facts made it into the words (see below).
- `leaks` for each batch: hidden names spoken in the words.

Key files: `@zekel/dev` `harness/relayBot.ts` (the harness) and
`commands/relay-bot.ts` (the command). The MODEL session applies moves to AI
seats, which the `AI_SEAT_NO_APPLY` guard exists to block. The command lifts
that guard **only on the server it starts**, by setting
`ZEKEL_HARNESS_AI_APPLY=1` (read in `@zekel/mcp`'s `mcp/tools.ts`). Real
servers never set it.

## Prerequisites

- A local [Ollama](https://ollama.com) with the relayer and reader model
  pulled. The default model is `qwen3.6:35b` for both. `--relayer=<model>` /
  `--reader=<model>` choose others. The harness looks for Ollama at
  `OLLAMA_BASE_URL` if that is set, else `http://localhost:11434`;
  `--base-url=<address>` overrides both for one run.
- A built server. The harness starts the **compiled** server, so **rebuild
  before every run** (`pnpm build` in zekel-games).
- The game should already pass desync, or at least post-port (the check that
  the port is fully playable) and ai-development (the AI is built and
  measured). This gate runs alongside desync, and a broken directive or AI
  further up produces noise here.

## Running it: probe first, then a full game

The commands below are the script names zekel-games uses (`pnpm relay-bot`,
`pnpm test`, and so on). Another project wires the same commands up as the
`@zekel/dev` README shows, or runs any of them as `pnpm tool <command> [args]`.
Splitting probe from full is the point of this harness: work cheaply on the
hardest turns before paying for a whole game driven by a language model.

```bash
pnpm build    # REBUILD FIRST (the harness runs the built server)

# 1. SCOUT (no language model, fast): rank every AI batch of a seeded game by how hard it is to relay
pnpm relay-bot -- --game=<id> --players=2 --seed=1 --mode=scout

# 2. CALIBRATE the reader's best possible score on the hardest batches (the reader sees the raw JSON)
pnpm relay-bot -- --game=<id> --seed=1 --mode=probe --probes=3 --reps=3 --calibrate

# 3. PROBE the same batches live (the relayer's words in between)
pnpm relay-bot -- --game=<id> --seed=1 --mode=probe --probes=3 --reps=3

# 4. When the probes are clean: a FULL game, then more seeds and the other seat
pnpm relay-bot -- --game=<id> --seed=1 --mode=full
```

- **scout** plays the REFERENCE only, with the fixed human rule and real AI
  turns, and scores every AI batch (moves × facts). Output: the hardest
  batches, ranked. No language model, so no cost: run it again freely after
  any fix.
- **probe** replays a fresh pair of sessions side by side up to one scouted
  batch, runs the round trip on just that batch, `--reps` times (a weak
  model's failures are a matter of chance, so one sample tells you little).
  `--batches=i,j` probes the batches you name instead of the top `--probes`.
- **calibrate** gives the reader the raw response JSON *as if it were the
  relay*. Its score is the **best the reader can do**. If the calibrate run
  itself fails a batch, the round trip (the outline's shape, name lookup,
  enum spelling) can't carry that batch however good the words are. Fix that
  before blaming the relayer.
- **spoken** (`--spoken`, with probe or full) gives the reader ONLY each
  move's `state_summary`, in order and word for word: exactly what a voice
  client reads aloud with no model rewording it
  ([spoken-narration.md](./spoken-narration.md)). Unlike calibrate, the reader
  never sees the structured move, so a clean spoken run shows the server's own
  text is enough to rebuild the AI's turn on the board. A difference here that
  calibrate doesn't show is a fact missing from, or unclear in, the summary
  text (a class A problem for a voice client; see below).
- **full** makes the round trip for EVERY AI batch of a whole game; the MODEL
  board collects whatever the words carried. Goal: `NO RELAY DESYNC`.
- Other flags: `--human-seat=<index>` (default 0), `--players` (default 2),
  `--out=<dir>` (default `./harness-out`). AI seats play at `medium`.

One probe repetition costs two model calls; a full game costs two per AI
batch. Run long jobs in the background and watch the `.stderr` line for each
batch (`ok`/`DIVERGED`, fact counts, `LEAKS=`).

## The loop

```
1. Build; scout; calibrate the top batches (the reader's best).
2. Probe the top batches live.
3. For each DIVERGED repetition, read that batch in the transcript:
     - summaries      (what the server said happened; the source of truth for the words)
     - relay_text     (what the relayer told the human)
     - fact_checks    (which facts made it into the words, and into the rebuilt moves)
     - reconstructed + apply_failures + state_diff
4. Decide the cause (next section). Fix the smallest thing. Lock it with a unit test.
5. Rebuild, probe the SAME batch and seed again; the fix should change how often it passes.
6. When probes are clean: a full game, more seeds, the other seat(s).
```

## Find the cause before you fix: A, B, C or D

The question "whose fault is this difference?" is the whole job, and the notes
in the transcript answer most of it mechanically.

### A. Server: the fact isn't in the response at all

The real value that differs never appears in the `run_ai_turn` response text
(the transcript marks these `possible_class_a`). **No relay could have carried
it.** The game's `state_summary` or log entry left out a fact that changes the
board, used an internal id instead of a printed name, or a summary is unclear
about where something went. The most valuable fix: the game's log or summary
wording (rich `getLog` entries or move summaries; see
[building-a-game.md, "The game log"](./building-a-game.md)). This is what the
harness is really hunting. A `leaks` hit is also class A: the relayer only
ever saw the response, so a hidden name in the words means the **response**
gave it away (a bug in the filtering of what each call may show), or two names
happen to collide. Check which before fixing.

### B. The relayer dropped it: in the JSON, not in the words

`fact_checks` shows `in_relay: false` for a fact the response carried. The
relayer left it out, usually because it was buried (a nested field of
`move_taken` that the summary never mentions), repeated across fields, or the
batch was long. Fix it like the desync harness's clarity bugs: make the
summary state the fact plainly at the top level; keep one sentence that
settles each fact that changes the board. If the fact was ONLY in
`move_taken` and not in the summary, treat it as class A: the summary is what
the relay has to carry, not the raw move.

### C. The relayer is unreliable: it fails in some repetitions only

The same batch relays fine in most repetitions and drops facts in others.
Often there's nothing to fix on the server, but check whether a clarity change
(shorter summaries, one fact per sentence, explicit counts) changes how often
it passes. Failures that come down to chance respond to clearer wording.

### D. The reader fumbled: in the words, not in the rebuilt moves

`fact_checks` shows `in_relay: true` but `in_reconstruction: false`, or the
apply failed on a value the words stated plainly. The reader (the harness's
stand-in for the human) got it wrong. Discount it, **unless the calibrate run
shows the same failure**. Then the round trip itself can't express that move,
usually because of an enum or spelling the reader can't produce from words
(the words say "took the gold", the field wants `take_resource`). That's the
desync harness's bug #3 again: if a human acting on the words couldn't name
the move field either, accept the human's wording on the server (a name
lookup) and probe again.

## The bugs that keep coming back (and how they get fixed)

From the first full pass of this gate, on another publisher's game. Expect
these first in any game:

1. **An AI move field that words can't carry.** An array index, an internal
   handle, a slot number the summary never says. *Fix:* the AI sends a
   **declared form** (the printed kind or name) and the engine looks it up.
   This is the "accept the printed name" rule ([building-a-game.md, "Don't
   make the model guess"](./building-a-game.md)) applied to moves the AI
   sends. (In that game, a repair move named the piece by its position in a
   list; it now names the kind of piece.)
2. **A move type the desync gate never tried rejects printed names.** The
   desync gate only tests moves the human declares. Move types only the AI
   makes never got name lookups. *Fix:* the same lookup the report moves use.
3. **An unclear field name in a move that refers to two things.** A `card_id`
   in a move that involves two cards: the reader fills it with the other card.
   *Fix:* a field name that says which one (`played_card_name` and
   `target_card_name` rather than `card_id`, say), with the old forms still
   accepted.
4. **A value given without saying what kind of thing it is.** "declares
   <value>" (a <value> what?), "p3 <name>: places ships" (what is <name>?). A
   weak model maps words to move fields by words for categories. *Fix:* say
   the category next to the value: "declares the <value> goal", "uses the
   <name> card". This one looks like class C (it comes and goes) but is really
   a summary that isn't clear enough; a spot that fails again and again across
   runs marks it.

## Judgment is part of this gate (more than the other runbooks)

The automatic numbers sort the problems; they don't decide. Words can be
complete but impossible to act on ("moves a ship": which ship? to where?), or
miss a word the check looks for and still be fine (a paraphrase the fact check
missed). For every probed batch, clean or not, **read `relay_text` against
`summaries`** and judge as the human at the table: *could I update my board
from this, and only this?* Write down the judgment for each batch in the
game's `RELAY-NOTES.md` (in its package folder, e.g.
`packages/<game>/RELAY-NOTES.md`). The automatic checks are there to make that
reading quick and to catch what eyes skim past (a missing change in a number, a
leak), not to replace it. A game passes this gate on `NO RELAY DESYNC`
**plus** a written judgment of the hardest probed batches.

## Help the harness gives, and its limits (read before trusting a number)

- **The outline gives away the structure.** The reader is told how many moves
  happened and their shapes, so failures in how the words split or order the
  moves are mostly forgiven. The fact checks and your judgment cover what the
  outline gives away. (Array lengths are kept too, so a missing item shows up
  in `fact_checks`, not in the shape.)
- **The word-matching fact check is only advisory.** It looks for the value,
  more or less exactly, with a little tolerance for plurals. Paraphrases show
  up as false omissions, and numbers that match by chance hide real ones. The
  headline is the state comparison; `fact_checks` only points your reading.
- **The reader gets one extra nudge to re-read when it leaves blanks.** The
  reader is the measuring tool, not the thing under test, and it sometimes
  skips a slot whose value the words state plainly. (In the first full run of
  this gate, the reader left one declared value blank and that one blank threw
  off the rest of the game.) The retry names the empty slots and says to keep
  any the words truly don't state, so a real omission in the relay survives
  it, and rebuilt moves with a wrong VALUE (no empty slots) can never trigger
  it. `reader_retries` is recorded for each batch; a game that needs many
  retries probably has unclear wording worth reading.
- **Move fields that take an enum are hard for the reader by nature.** The
  words say "takes the gold"; the field wants `take_resource`. Calibrate shows
  these. The fix is a name lookup on the server, not a smarter reader prompt.
- **`move_menu` and `next_step` are removed from what the relayer sees** (they
  steer the human's next move, not the relay). A real assistant sees them; if
  a game's relay depends on them, that's a finding, not something to change in
  the harness.

## Lock every fix with a test

- A fix to make a summary complete (class A): a unit test that applies the
  move and checks the summary or log entry names the fact (printed name, where
  it went, the change in number). Model: Neither Guts nor Gears'
  `packages/neither-guts-nor-gears/src/__tests__/logDetail.test.ts`
  (zekel-games), and `@zekel/mcp`'s `core/__tests__/gameLog.test.ts`.
- A privacy fix (a leak): check that the `run_ai_turn` / `get_ai_move`
  response for that state does NOT contain the hidden value. The same
  `logDetail.test.ts` checks a human's drawn card stays out of the summary and
  log.
- A name-lookup fix (class D): check the human's wording is accepted, as
  Sweetlands Imperium's
  `packages/sweetlands-imperium/src/__tests__/humanFlow.test.ts` does for a
  card reported by its printed name.
- The harness's own round-trip helpers are locked by `@zekel/dev`'s
  `harness/__tests__/relayBot.test.ts`.

Then run the full suite (`pnpm test`). A relay fix must not break any game.

## Checklist for each game

- [ ] The gates before this one pass (post-port, ai-development; ideally desync).
- [ ] Scout seed 1; calibrate the top 3 batches (`--calibrate`). The reader's
      best is clean, or fix the round trip first.
- [ ] Probe the top 3 batches live, at least 3 repetitions each; find the
      cause, fix, probe again until clean.
- [ ] A full game on seed 1 until `NO RELAY DESYNC`; then 1–2 more seeds and
      the other seat(s) (`--human-seat`).
- [ ] The judgment written into `packages/<game>/RELAY-NOTES.md`: for each
      probed batch, could a human act on the words? Leaks: none.
- [ ] Every fix has a unit test; the full suite passes.
- [ ] Update your project's status table (zekel-games keeps one in
      `GAMES.md`): the Relay column.

## The lesson under every fix

The mirror of the desync lesson: **the summary is what the relay has to
carry.** If every fact that changes the board is stated once, plainly, by
printed name, at the top level of a move's `state_summary`, a weak model's
words carry it and a human can act on it. When a relay fails, fix what the
server *says* before blaming how the model *speaks*.
