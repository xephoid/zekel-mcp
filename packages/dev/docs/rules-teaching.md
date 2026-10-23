# Rules teaching — sectioned rules, explaining missing moves, teaching on first use

This is shared server machinery, not a gate. It is the design record and the
checklist a game follows to adopt it. Every new game is expected to adopt it:
a game without `getRulesSections` and gate declarations fails the port runbook
(see [port-runbook.md](./port-runbook.md)).

What it does, in one line each:

- The game's rules are split into named sections the server can point at.
- When a move the player expects is missing from `get_legal_moves`, the
  response says why, with the live numbers ("only when your stamina is lower
  than your opponent's — yours is 14, theirs is 9").
- The first time a rule matters to a player, the server includes that rule's
  section once. When the player tries a move a rule blocks, the server
  includes the full section with the refusal.
- Each player can turn the lessons off. The "why is this missing" lines stay.

Where it lives:

| Piece | File |
|---|---|
| `RuleSection`, `MoveGateStatus`, the two optional `Game` hooks, the two `SessionState` fields | `@zekel/game-kit` `game.ts` |
| Rendering the rules text from sections, lookups, the coverage check | `@zekel/game-kit` `rulesSections.ts` |
| The grey list, the gate/legal-moves agreement check, rejection wording | `@zekel/game-kit` `moveGates.ts` |
| Deciding which lessons to send | `@zekel/mcp` `mcp/teaching.ts` |
| `get_rules` topic filter, `unavailable_moves`, `rules_briefing`, `set_session_preferences` | `@zekel/mcp` `mcp/tools.ts`, `mcp/schemas.ts` |
| Preferences surviving undo | `@zekel/mcp` `core/sessions.ts` (`undoSession`) |

Tests that lock it on the server side: `packages/game-kit/src/__tests__/rulesSections.test.ts`
and `packages/mcp/src/mcp/__tests__/getRules.test.ts`, `moveGates.test.ts`,
`teaching.test.ts`, `sessionPreferences.test.ts` (with the stub game in
`rulesTeachingStub.ts`) in zekel-mcp.

**Reference game: Fractured Fist** in zekel-games
(`packages/fractured-fist/src/`): `rulesSections.ts` (the sections),
`moveGates.ts` (the gate declarations), the two hooks in `index.ts`, and the
locks in `__tests__/spokenAndTeaching.test.ts` (`describe('rules teaching')`).
Adventurer Olympics (`src/moveGates.ts`, `__tests__/rulesTeaching.test.ts`)
and Neither Guts nor Gears (`src/rulesSections.ts`, `src/moveGates.ts`) are
two more full adoptions; Cybernoir 2127 and 8-Bit Demon Hunter have sections.

## The problem (why this exists)

When a move the player expects is absent from `get_legal_moves`, the server
used to say nothing about *why*. The model filled that gap from training
memory and stated a wrong rule with confidence.

The real incident, from one port (Vast): a player asked whether they could
make a ranged attack. The engine was correctly withholding the move, because
the character's strength stat was too low. Nothing said so. The chat client
invented a set of contradictory rules for the attack (a made-up cost, a
made-up range limit, a story about walls). The player could not tell "the rule
is working" from "this is a bug", and spent hours hunting a bug that did not
exist.

Two causes, both in the structure:

1. **The rules were one block of text.** `getRulesText()` returns one string.
   A weak model can't reliably find the one sentence that governs a moment,
   and the server can't attach "the relevant rule" to anything, because the
   rules have no named pieces.
2. **Missing moves were silent.** The original digital version of that game
   shows unavailable actions greyed out *with a reason*. The MCP tools leave
   illegal moves out entirely, so that information was lost in the port. A
   fix that only adds the rule to the rules text recites the rule but never
   quotes the *live* state ("your strength is 1"). The live value is the half
   that ends both the bug hunt and the invented rule in one stroke.

A second goal: help the player **learn the rules** at the table. A lesson
given at the moment of confusion sticks. A hint paragraph riding on every
response gets skimmed like boilerplate.

## Design overview

Four pieces. The first two are data (a game declares them once). The last two
are behaviour (the server renders them everywhere, the same way for every
game).

```
getRulesSections()  ──┐
                      ├──▶ 3 ways of delivering ──▶ rules_briefing / grey list
gate declarations   ──┘      (server side)           in tool responses
                                    ▲
                per-seat teaching preference + taughtSections
```

### 1. Sectioned rules — `Game.getRulesSections()`

Rules become named sections instead of one block:

```ts
interface RuleSection {
  id: string;          // stable slug, e.g. "focus-reload", "channel-phase"
  title: string;
  text: string;        // the rules prose for this one topic
  tags: {
    move_types?: string[];  // move types this section governs
    phases?: string[];      // phases this section governs
  };
}
```

- `getRulesText()` is **derived** — the sections joined, via
  `renderRulesText(sections)`. One source of truth. A game that only has a
  block of text keeps working (sections are optional for the server, though
  required for a new port).
- `get_rules` takes an optional **`topic`** (a section id, or a
  case-insensitive title match) and returns just that section. Its response
  carries a `rules_sections` index (`[{id, title}]`) so the model can see the
  valid topics. No topic → the full text, as before.
- **Lock:** a test that every move type in the game's move schema maps to at
  least one section (`validateSectionCoverage`). An untagged new move type is
  then a failing test, not a silent gap with no hint.

### 2. Gate declarations — the rule said in one place

A game declares, once per move type, why that type may be unavailable — for
example "`focus_reload` needs your stamina to be lower than your
opponent's". Each declaration renders itself against live state ("yours is
14, theirs is 9") and names its rules section. **Three things render from
that one declaration**: the grey line, the `apply_move` refusal message, and
the trigger for the lesson. There are no separate hand-written copies to drift
apart when a rule changes. (In the incident above, the port had stated the
same requirement in three hand-written places — the rules text, the move's
description and the error message. Adopting this should merge those into the
declaration, not add a fourth copy.)

Gates work on move **types**, not on single moves. The set of illegal single
moves is unbounded (every square a piece can't reach). The list of move
*types* is short and already exists (`get_rules` `move_schema`). Each
declaration has a status:

- `available` — at least one legal move of this type exists right now;
- `gated` — a real rule worth teaching (a stat, resource or state
  requirement);
- `routine` — missing because of the phase or turn ("it is not your turn"),
  listed but with no lesson attached.

The hook is `describeMoveGates(state, playerId): MoveGateStatus[]`, one entry
per move type that applies to this seat, each
`{ move_type, status, reason?, rules_section? }`. The game decides which move
types apply to a seat (in a game where seats have different abilities, a seat
only lists its own). An entry may also carry `item` — one blocked option of a
type whose other options are still offered (one card the player can't afford
while other buys stay open). Item entries are greyed even while the type has
legal moves; the agreement check skips them, so the game's own test checks
that no offered move is that item.

A pattern that keeps gates honest cheaply (Fractured Fist's `moveGates.ts`):
read `available` straight off `getLegalMoves`, so it agrees with the offered
list by construction. The only hand-written part is the *reason* a type is
missing, checked against live state in the same order the engine checks it,
with the live values quoted.

### 3. Three ways a rule reaches the player

**The grey list** (on every `get_legal_moves` for a human seat whose turn it
is — the same seats that get a `move_menu`): the move types that apply to
this seat but have no legal move right now, one line each with the live gate
values — `focus_reload — only when your stamina is lower than your
opponent's — yours is 14, theirs is 9`. It is the `unavailable_moves` field,
computed fresh on each call (`unavailableMoves` in `moveGates.ts`) and
bounded by the list of move types. **It protects against desync; it is not a
lesson.** It closes the gap the model would otherwise fill with an invented
rule. So it **stays on when teaching is turned off**, and it keeps no
"already taught" record.

**Teach on first encounter** (the positive side): the first time a tagged
phase or move type becomes live for a seat in a session, the response
includes that rules section once. After that, only the section id is sent as
a pointer. Teaching exactly once is what keeps it read instead of skimmed.

**Full lesson when the player tries a blocked move** (the negative side):
when `apply_move` refuses a move because a gate failed, the refusal includes
the complete section and marks it taught. A refusal is the one moment the
server can *see* the player wanted the blocked move — the right moment to
teach. A move type showing up greyed for the first time does NOT teach: early
in a game most things are blocked, and that would dump six lessons on turn
one.

### 4. Where it goes in the response

Lessons ride a **separate top-level field**, `rules_briefing`, on the tool
responses — never inside `next_step.instruction`. The `next_step` directive
has a "never bloat, never lie" contract, and the desync bot checks the model's
behaviour against it; teaching text must not water it down. Grey lines ride
with the legal-moves payload (and the `move_menu` may show them to the human
directly).

## Teaching preference (turning lessons off)

- **Per seat**, **on** by default. The players who most need teaching are the
  least likely to know there is a switch. Turning it off takes one sentence.
- Set at `create_session` (a per-seat `teaching` option) or mid-game with the
  generic **`set_session_preferences`** tool. Teaching is the first
  preference; future settings ride the same tool. It is **not a game move**:
  the engine is not involved, it is never in the move log, and it can't be
  undone.
- Seat auth follows the multi-device join rules: a seat sets its own
  preference; the host token may set any seat's.
- **Off silences the two lesson channels only.** The grey list stays. It
  protects the board's accuracy even for a player who knows the rules cold,
  because the model is the one who needs it. Hiding grey lines too would be a
  separate, second preference, not part of "teaching".
- The server instructions tell the model the human can turn teaching off or
  on at any time by saying so.

## Saved state and undo

- Two optional `SessionState` fields, both **keyed by seat** (with two devices,
  teaching the host didn't teach the remote player; a solo game has one seat):
  `seatPreferences` (the teaching preference) and `taughtSections` (which
  section ids each seat has been taught). Both are additive and may be absent
  → **no schema version bump** (the stores save the whole state as JSON).
- A section is marked taught **by the server when the response is built and
  saved** — never inside `applyMove`. `applyMove` must stay pure, and it isn't
  what causes teaching; rendering a response is.
- Marking taught saves the session **wherever a lesson was delivered, even on
  read-only tools** like `get_state`. This is a deliberate exception to "reads
  don't write", noted where it happens in the code: teach-once matters more
  than read purity, and the write-through store makes it cheap. (The rejected
  alternative was marking only on tools that already save; then lessons would
  repeat on back-to-back `get_state` calls.) The refusal path saves too.
- **Undo** restores whole earlier snapshots (`core/sessions.ts`), so:
  - `taughtSections` **goes back** with undo — you undid back into the
    situation, so the lesson plays again. Deliberate.
  - The **preference survives** undo — `undoSession` carries
    `seatPreferences` forward across the restore. A preference is not a game
    event; "I turned teaching off, undid a move, and teaching came back" is a
    bug. Both directions are locked by tests.

## What a game gets without adopting

The machinery is server-wide and the same for every game. A game adopts by
implementing `getRulesSections()` and `describeMoveGates()`. A game that
implements neither behaves exactly as before: one block of rules, no grey
list, no lessons.

Changing tool response shapes is a cross-cutting change: re-run the desync
gate ([desync-harness-runbook.md](./desync-harness-runbook.md)) for a
representative game of each setup shape. Growth in response size is a real
risk for weak models; the desync re-run is the guard, and lessons are bounded
by teach-once and the preference.

## Test locks

Server side (zekel-mcp), against a stub game:

- `getRulesText()` equals the rendered sections (one source).
- Grey list: a gated move type with no legal moves renders its gate line with
  live values; offered move types never appear greyed.
- One voice per gate: the grey line, the refusal message and the taught
  section for one gate all come from the one declaration.
- Teach once: a section is included on first encounter and only a pointer
  after, across different tool responses.
- A failed-gate refusal carries the full section and marks it taught.
- Preference: off silences the lessons while the grey list stays; seats are
  independent; the preference survives undo while `taughtSections` goes back.
- `set_session_preferences` seat auth (own seat / host token / wrong token),
  and it never appears in the move log or the undo stack.

Per adopting game:

- Every move type in the move schema maps to ≥ 1 rules section
  (`validateSectionCoverage`), section ids are unique (`duplicateSectionIds`),
  and the rules text is the rendered sections.
- **The gates agree with `getLegalMoves`** (`checkGateConsistency`): a type
  reported `available` has at least one legal move, and a type with legal
  moves is never reported `gated` or `routine`. Run it over many states from
  real play, not one hand-built state — Fractured Fist plays whole games and
  checks every state for every seat. This is the most important test of the
  whole feature: a gate that disagrees with the legal moves is a grey line
  that lies.
- Where a game shows the options of a pending choice separately, the same
  agreement check for those options (`checkPendingOptionConsistency`).
- **Replay the confusion you expect.** Build the state where a player would
  ask "why can't I X?", and assert the grey line carries the live values and a
  forced attempt at X is refused with the full section. Fractured Fist's
  versions: an out-of-actions technique phase greys `play_card` with the live
  count; Focus reload greys with both stamina values when the player isn't
  behind; a refine window greys everything else with the refines owed.

## Per-game adoption checklist

- [ ] Rules written as sections with stable ids; `getRulesText()` derived from
      them (`renderRulesText`).
- [ ] Every move type tagged to ≥ 1 section (test-locked).
- [ ] Gates declared for every move type that can be missing, marked
      `gated`/`routine`, rendering live values. Any existing hand-written
      copies of the same rule (move descriptions, error messages) merged onto
      the declarations.
- [ ] Phase tags cover every phase a human seat can be in.
- [ ] Session-dependent numbers (starting values, hand sizes, setups that vary
      by player count) are not recited in the sections; they are read from
      this session's `get_state`.
- [ ] The grey list checked by eye at typical states: would a "why can't I
      X?" question be answered by what's on screen?
- [ ] The desync gate run (or re-run) after adopting.

## Where other docs touch this

- [port-runbook.md](./port-runbook.md): new games write their rules as
  sections from the start.
- [post-port-runbook.md](./post-port-runbook.md) (§7a and its checklist):
  every move type tagged, every withheld move has a reason a player can say
  out loud.
- [desync-harness-runbook.md](./desync-harness-runbook.md): the grey list is
  part of what that gate exercises.
- [building-a-game.md](./building-a-game.md), "Rules teaching": the short
  version for game authors.

## How the server side is built

Kept here so a change to the machinery keeps its contracts. The server side
was built in four steps, each leaving every existing game exactly as it was;
the fifth step was the first game's adoption, the sixth the checks.

### Step 1 — Sectioned rules

- `game-kit/game.ts`: `RuleSection` and the optional `getRulesSections?():
  RuleSection[]` on `Game`, next to `getRulesText`.
- `game-kit/rulesSections.ts`: `renderRulesText(sections)` (the derived
  text), `sectionsForMoveType` / `sectionsForPhase` / `findSections` lookups,
  `validateSectionCoverage(sections, moveSchema)` for each game's coverage
  test, and `duplicateSectionIds`.
- `mcp/tools.ts` `get_rules`: when the game has sections, the text is derived
  with `renderRulesText`; the optional `topic` filters it; the response gains
  the `rules_sections` index. No topic and no sections → exactly the old
  behaviour.

### Step 2 — Gate declarations and the grey list

- `game-kit/game.ts`: the optional hook `describeMoveGates?(state,
  playerId): MoveGateStatus[]`. The game computes `reason` against live state.
  Move types only; the game decides which types apply to a seat.
- `mcp/tools.ts` `get_legal_moves`: for a human seat whose turn it is (the
  same rule as `move_menu`), attach `unavailable_moves`: the hook's entries
  whose move type has no instance in `legal_moves`, as `{move_type, reason,
  rules_section?}`.
- The agreement check (`checkGateConsistency`) as a shared helper every
  adopting game runs in its tests. A mismatch is a failing test, not a grey
  line that lies.
- `apply_move` refusals (same for every game): when the engine refuses a move
  whose type the hook reports `gated`, the gate's reason is added to the
  error message (`enrichGateRejection`).

### Step 3 — Teaching state and the two lesson channels

- `SessionState`: the two optional per-seat fields, `seatPreferences?:
  Record<playerId, {teaching?: boolean}>` and `taughtSections?:
  Record<playerId, string[]>`. No schema bump.
- `mcp/teaching.ts`: works out first encounters (a tagged phase now active, a
  tagged move type now offered, minus what the seat has been taught) and the
  failed-gate lesson; returns the sections to include, pointers for ones
  already taught, and the ids to mark.
- `mcp/tools.ts`: attaches `rules_briefing` (never inside
  `next_step.instruction`) to `create_session`, `apply_move`,
  `get_legal_moves`, `get_state` and the stop of `run_ai_turn`, for human
  seats with teaching on, and saves where a lesson was delivered (the
  save-on-read exception above).
- The failed-gate path of `apply_move` includes the full section on the error
  response and marks it taught.
- `core/sessions.ts` `undoSession`: after restoring the snapshot, carry
  `seatPreferences` forward from the pre-undo state; leave `taughtSections` to
  go back.

### Step 4 — The preference

- `mcp/schemas.ts`: per-seat optional `teaching` on the `create_session`
  player entry; the `set_session_preferences` input (`session_id, player_id,
  preferences: {teaching?: boolean}, auth_token?`).
- `mcp/tools.ts`: register `set_session_preferences` — seat auth through the
  existing `verifySeatAuth` (own claim token, or the host token for any seat);
  update `seatPreferences`; save; **never** add to the move log or undo stack;
  echo the resulting preferences. One line in the server instructions: the
  human can turn teaching off or on at any time by saying so.

### Step 5 — The first game's adoption (the heavy part)

What adoption meant for the first game, a large one with several factions
that each play by different rules:

- Split the existing rules text into tagged sections — the shared rules,
  each piece of equipment's requirements, each faction's turn structure and
  its blocked actions. The old rules-text test's content checks carried over
  unchanged onto the derived text.
- Declare gates per faction, at least for the moves behind the incident and
  its neighbours (other stat-gated actions, and ending a turn while a
  mandatory event is still unresolved), with phase-bound absences marked
  `routine`.
- Merge the hand-written copies of those rules (offered-move descriptions,
  engine refusal messages) onto the declarations.
- Lock it: coverage of every move type; the agreement check over built
  states for every faction; and the incident replayed as the acceptance test
  (the low-stat state greys the move with the live value, and a forced attempt
  is refused with the full section).

Scope warning from that adoption: the coverage test needs every move type
*tagged*, not every rule rewritten. Leave prose as it is except where merging
duplicate copies touches it, and set a time limit on the rest.

### Step 6 — Checks

- Full test suite, `tsc --noEmit`, a build, and the MCP smoke test.
- Because tool response shapes changed: a desync re-run on a representative
  game. (It came back with no desync, every turn tracked.)

### Not part of this

- Drawing grey lines inside `move_menu` (possible later; they already ride the
  same response).
- A second preference to hide the grey list (deliberately not part of
  "teaching" — see the preference section).
- Writing sections for older games that only have a block of rules text and
  aren't adopting.

### Risks

- **The gates disagreeing with the legal moves** — handled by the agreement
  check; it is the test the whole feature rests on.
- **The save-on-read exception** — a small change to what reads do; noted in
  the code and covered by the teach-once tests.
- **Sectioning a big rulebook growing without end** — tag every move type,
  don't rewrite every rule.
- **Weak models doing worse because responses grew** — grey lists and
  lessons add text that weak models read; the desync re-run is the guard, and
  lessons are bounded by teach-once and the preference.
