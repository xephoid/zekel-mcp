# Spoken move text

How to write the text a player **hears** for each move. These rules were first
written for zekel Live, a voice client that reads each move aloud straight from
the server's own strings, with no model rewording them. Chat clients pass on
the same strings, so the rules help them too. Fractured Fist was the first game
written to them; new games should follow them from the start.

Paths below: `game-kit/src/…` is in `@zekel/game-kit` (zekel-mcp's
`packages/game-kit/src/`), and game examples are in zekel-games under
`packages/<game>/src/`.

## Which string is spoken

Every move's **`state_summary`** — the `summary` a game's `applyMove` returns
(`ApplyMoveResult.summary` in `game-kit/src/game.ts`). It is the **canonical**
string for a move, human or AI: a voice client speaks it as-is and text clients
show it as-is. For an AI move it must carry everything needed to copy the move
onto the table.

`run_ai_turn` and `get_ai_move` also return a `narration` for AI moves. It is
**optional flavour**: nothing a player needs may live only there, it must never
contradict the summary, and it must never contain debug output (chat clients
still see it). The simplest safe choice is to make it the move's summary.
Fractured Fist does this: its `getAIMove` applies the chosen move and returns
that summary as the narration (`packages/fractured-fist/src/index.ts`). A line
written separately is composed before the move is applied, so it can't know
what the move caused (a strike, an effect that hit its limit) and drifts.

Debugging detail (search counts, scores, why the AI chose a move) never goes in
either string. Put it in the server log (stderr, behind an environment
variable so batch runs stay quiet).

**Nothing hidden in the summary.** Everyone at the table hears a summary.
Information only one human may see — a card the server dealt into a hand it
tracks for them — goes in `ApplyMoveResult.privateReveals` instead. `apply_move`
returns it as `private_reveals` to that seat only, so a client can show it on
that player's screen. (Fractured Fist: a digital player's draws.)

## Rules for the text

1. **Lead with the physical action.** "Zeke plays Attack", "The AI buys Block",
   "Zeke refines a Misstep". The first words say what happened on the table.
2. **Say who by display name, never by seat id.** Use the name the human gave;
   an unnamed AI is "the AI" (or "AI 1", "AI 2" when there are several). The
   shared helpers are `seatDisplayName` and `seatNamer` in
   `game-kit/src/seatNames.ts`. A seat with an identity (a colour, a faction, a
   character) may use that. Capitalize a name that starts a sentence ("The
   AI").
3. **Card and component names exactly as printed.** "Devastating Blow", never
   `devastating_blow`. No internal ids, phase ids, or field names.
4. **No engine terms or abbreviations.** "damage queued", not "dmg"; "the
   Channel phase", not `channel`. Printed game terms such as "refine",
   "spirit" and "stamina" are fine.
5. **One move per string.** A string may have more than one sentence when a
   single move causes several things (ending the last turn of a round also
   resolves the strike), but it never merges two moves.
6. **Say what actually happened, not the printed number.** If a draw came up
   short, a heal hit the maximum, or an effect hit a limit, say so: "draws 1
   card (deck and discard pile ran out)", "no healing (already at full
   stamina)".
7. **Tell the table what to do with the player's own components.** When a move
   changes something on a human's side of the table, say it as an instruction
   with the destination: "Put 2 Misstep cards in Zeke's discard pile." State
   every stamina change with the new total.
8. **Write it to be heard.** Full sentences ending in a period. Numbers as
   digits are fine (speech engines read them). No brackets that only make
   sense on screen, no lists with symbols, no "+2".

## The spoken question for a human step

A `next_step` owed to a human carries `human_response` (`HumanResponse` in
`game-kit/src/game.ts`). A voice client speaks its `ask`, so the same rules
apply:

- `ask` is a question a person could answer out loud, with the live numbers:
  "Technique phase, you have 1 action. Which technique card do you play? Or
  are you moving on to the Channel phase?"
- `example` is how a person would phrase an answer ("I play Devastating
  Blow"), never the answer itself.
- `records_as` names the move type and fields, for the model that turns the
  answer into a move. It is not spoken.

## Checking a game against these rules

`check-summaries` and `relay-bot` are `@zekel/dev` commands. The forms below are
the script names zekel-games uses; another project wires them up as the
`@zekel/dev` README shows (or runs any command as `pnpm tool <command> [args]`).

- **`pnpm check-summaries -- --game=<id> [--games=5] [--players=N]`** plays
  all-AI games through the game module and checks every `state_summary` and
  every AI `narration` (the rules are in `@zekel/dev`'s `core/spokenText.ts`):
  no seat ids, no internal ids, no abbreviations, no debug text, no raw data.
  Post-port runs it ([`post-port-runbook.md`](./post-port-runbook.md)); it
  must report no problems for a game a voice client reads aloud. It checks
  mechanically only — a person still reads a sample aloud.
- **The relay harness** ([`relay-harness-runbook.md`](./relay-harness-runbook.md))
  marks each AI turn's summary lines that break these rules
  (`spoken_text_issues`, advisory), and its `--spoken` mode
  (`pnpm relay-bot -- --game=<id> --mode=probe --spoken`) shows whether the
  summaries alone let a person rebuild the AI's turn on the table. That mode
  drives a language model, so it needs a local Ollama.
- A game may add its own test; Fractured Fist's is
  `packages/fractured-fist/src/__tests__/spokenAndTeaching.test.ts`.

## What an audit of existing games found

A read-only audit of every game's summaries and narration found the same
problems again and again. Check a new game for each:

- **Raw seat ids** in summaries — the most common problem by far; some games
  had dozens.
- **Internal ids instead of printed names** (card ids, power ids, location or
  connection ids, raw `(row,col)` coordinates).
- **Engine terms and abbreviations** (a move-type name, a phase id, a stat
  abbreviation).
- **Debug-style text in a summary** ("hand_size adjusted…", "Awaiting
  defender's declaration").
- **Narration that is debug output** — search counts, scores, difficulty tags,
  raw move ids. This was the most common narration problem, and sometimes the
  narration was nothing but debug output.

Among Zekel Games' own games, the audit found:

| Game | What broke |
|---|---|
| Neither Guts Nor Gears | raw seat ids (about 60); the `DEF` abbreviation; narration with search counts |
| Cybernoir 2127 | narration was debug output only (search counts, raw move ids) |
| Sweetlands Imperium | raw seat ids (about 16) |
| Warble Way Galaxy | one isolated line |

Fractured Fist was fixed. Each game is fixed as a voice client adopts it; run
`check-summaries` to see a game's current state.
