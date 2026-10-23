# Post-port runbook

How to take a game module from "the code runs and the harness is clean" to
**verified fully playable**, and produce the durable record that proves it. This
is the working companion to
[building-a-game.md, "What fully playable means"](./building-a-game.md#what-fully-playable-means)
— that section defines the bar; this file is the repeatable process for clearing
it and writing down the evidence.

It is one of three peer gates a port must pass before it is "done":

| Gate | Runbook | Question it answers |
|---|---|---|
| **Post-port** (this one) | [`post-port-runbook.md`](./post-port-runbook.md) | Is every printed rule implemented, and does every choice the rules give the player actually reach the player? |
| **Desync** | [`desync-harness-runbook.md`](./desync-harness-runbook.md) | Can a weak model track a full game without the recorded state silently diverging from the physical board? |
| **Balance** | [`balance-harness-runbook.md`](./balance-harness-runbook.md) | Is it balanced and does the AI actually use every mechanic? |

These are **independent** — passing one does not imply another, and this runbook
does **not** absorb the other two. Where post-port and desync nearly touch (the
in-game choice audit, §5 below, vs. desync's "don't make the model guess"), this
runbook stays on the *rules-completeness* lens — *does the player own this
choice?* — and references the desync artifact for the *fidelity* lens — *can the
model record it without guessing?* Same field, two questions.

> **This is a gate, not a description.** A port is not "fully playable" — and must
> not be described to anyone as such — until **every** checklist line in the
> deliverable is green (or is a deliberate, documented out-of-scope expansion).
> A `partial`, `stub`, `MVP`, or `approximation` row is a failing gate, by the
> exclusion list in "What fully playable means". Surface what is missing; do not
> round up.

---

## The deliverable

One committed, per-game artifact: **`packages/<game>/POST-PORT.md`** — checked
in next to the code it documents, alongside that module's `PORT-NOTES.md`.

Unlike `FINDINGS-<game>.md` (the balance gate's local-only snapshot, kept out of
git), this file **is checked in**. It is two things at once:

1. A **verification record** — the section-by-section proof that the port cleared
   the bar, with code and test pointers a reviewer can follow.
2. A **living maintenance reference** — the first file to read before touching the
   game's state types (`types.ts`), its scoring, or before a re-port. It is where
   the schema-migration trail, the rules-ambiguity decisions, and the
   zone-categorization live in one place.

The public example is `packages/8-bit-demon-hunter/POST-PORT.md` in
[zekel-games](https://github.com/xephoid/zekel-games); copy its section order.
(That game is a solo game with no physical copy, so a few sections there say how
they were adapted; a table game fills every section as written here.) The
template is reproduced at the end of this runbook.

---

## The methodological backbone

Two habits make this gate trustworthy instead of a memory exercise. Everything
below rests on them.

### 1. The two-pass rulebook walk

You cannot enumerate-and-verify in a single sweep — that is exactly how you "check
only what you remembered to write," the failure porting rule #4
([Porting from an existing version](./building-a-game.md#porting-from-an-existing-version))
warns about. Split it:

- **Pass 1 — enumerate.** Read the printed rulebook **section by section** and
  write *every* rule into the traceability matrix pre-marked `missing`: every
  phase, every action type, every "you must" / "you may", every scoring case,
  every tiebreaker, every game-end condition, every card/tech/component category.
  Do not look at code yet. The output of pass 1 is a complete checklist of the
  *rulebook*, independent of what was implemented.
- **Pass 2 — verify.** Walk that checklist and flip each line to `implemented`
  **only** with a `file:line` pointer to the code that does it and a pointer to
  the test that locks it. A line with no test pointer is at most `partial`.

The matrix is the artifact's spine. It turns "did we implement it?" from recall
into something a reviewer — or a future script — can check line by line.

### 2. The standing edge-case catalog

Porting rule #5 ("question every simplification") becomes a fixed section every
game fills in, not a vibe. For each entry, state what the game does and point at
the code/test:

- A deck/pool runs out mid-draw (a faction deck, a shared pool, a tile stack).
- A player has no legal move (must they pass? is pass auto-applied?).
- Both players hit a game-end condition in the same beat.
- A hand/zone is empty when a card must come from it.
- A number sits at the extreme of its range and the comparison enum has no valid
  value.
- Every supported **player count** is walked, not just the smallest.
- Every **pending-setting path** has its degenerate branch handled (see §6).

The framework guarantees none of these — the source code often handled them
implicitly via its host framework, and the port usually does not.

---

## The process

Build first (`pnpm build`), then work the steps in order. Each step has a
corresponding section in the deliverable.

The commands below are the script names zekel-games uses (its `package.json`
maps each to `tsx scripts/dev.ts <command>`, and `pnpm tool <command> [args]`
runs any of them). Other projects wire up the same `@zekel/dev` commands as the
`@zekel/dev` README shows.

### 0. Provenance pin

Record the exact **rulebook edition + page numbers** and the **reference
implementation** (repo + commit/path) the port came from. Every later citation
("rulebook P.34", "engine.js ~1570") points back here. Without this, a future
reviewer cannot tell a faithful port from a plausible guess.

### 1. Zone categorization

Lift the four-category table from the module's `types.ts` comment block (see
[Physical-first design](./building-a-game.md#physical-first-design), which
requires it there) into the artifact, and **verify it**: every deck, hand, and
hidden zone is assigned to exactly one of public/shared, server-tracked
AI-private, server-dealt human-private, or opaque human-private. The high-risk
case is a **shared hidden deck** — confirm it is server-owned and that the
human-present flow (report → deal AI from remainder) preserves disjointness and
privacy. Getting this wrong invalidates every downstream move shape.

### 1a. View completeness — the table-reconstruction test

The zone categorization (§1) says who may see each zone; this step verifies the
views actually deliver it. The principle:

> Every state field a player is entitled to see must be recoverable from the
> views in **structured, unambiguous** form — `getPublicView` for anything
> visible on the table, `getPlayerView` for that seat's private-but-known info.
> Prose labels may accompany the structured value, never replace it.

This is the server's core promise made checkable: the server is the bookkeeper
the human rebuilds their physical table from. A view that drops a position, or
renders it only as prose, breaks desync *recovery* even when move summaries were
relayed correctly at the time.

Classify every field of the game's state (walk `types.ts` top to bottom):

- **public-physical** — anything a player at the table can see: piece positions,
  face-up cards, filled track spaces, tokens/markers on boards and mats. Must be
  in `getPublicView`, structured (ids / indices / coordinates).
- **private-known** — a seat's own hand, own secrets, own deduction aids. Must
  be in that seat's `getPlayerView`, structured.
- **hidden-by-rule** — deck order, face-down values, opaque human-managed zones
  the server doesn't track. Exempt (and must NOT leak — this step never argues
  for exposing more than the table shows).
- **internal** — RNG state, AI-private memory, undo stacks, caches, derived
  conveniences. Exempt.

The test for each public-physical / private-known field: **could a human who
lost track of the table fully and unambiguously rebuild everything they are
entitled to see, from `getPlayerView` alone?** A count where contents are
visible fails. A prose label that matches more than one board space fails (the
Sweetlands Imperium `"region 2 ring (yellow)"` bug — each region's ring runs its
six colours twice, so the label fits two spaces). ASCII renders don't count; the
structured fields must stand alone. Indices must use the same base and
coordinate frame as the **move language** — a view that says `(0,0)` where
`apply_move` means `(3,-2)` (this happened in Nimalia), or emits 0-based indices
on a 1-based wire format (this happened in Agent Hunter), fails as ambiguity
even though the data is "there".

Two rulings bind this step:

- **Face-up discard piles are public information** — contents in the view —
  unless the printed rulebook explicitly forbids inspecting them. (An opaque
  human-managed discard the server never tracked stays exempt; the ruling
  governs server-tracked piles.)
- **Tokenless public facts count.** Remembered-but-public state with no physical
  token — once-per-turn flags that gate legality, who has acted this round,
  seating/turn order — is in scope: the player is entitled to it and cannot
  recover it from the table.

Record the classification table in the artifact and lock the fields with a view
test (zekel-games examples: `src/__tests__/viewCompleteness.test.ts` in
`fractured-fist`, `sweetlands-imperium`, `warble-way-galaxy`,
`neither-guts-nor-gears` and `8-bit-demon-hunter`). The audit that motivated
this step, one pass over every game the server had at the time, is
[`view-completeness-audit.md`](./view-completeness-audit.md) — the recurring
failure was views written as LLM reading material (prose summaries, counts)
that silently dropped structure the physical-first contract requires the server
to be able to report.

### 1b. Hidden zones vs the move list — can the HUMAN seat act at all?

§1 writes down which zones the server tracks and which are hidden from it; §1a
verifies the views deliver what that promises. This step verifies the **move
list** does too, which is a different surface and fails in its own way.

The failure: `getLegalMoves` builds its options by reading server-tracked state.
When a seat's hand or holdings are hidden from the server — which is the normal
case for a HUMAN, by the physical-first split — that code path has nothing to
read, so the moves are simply never offered. The engine usually accepts the move
perfectly well if it is spelled out; nothing ever tells the player it exists.

For every zone marked hidden in §1, take that seat's core actions and confirm the
move list offers them **for a human holding that seat**, not only for the
server-tracked one. Where the options genuinely cannot be listed — the set is not
known until the move resolves — the move's own description must say the player
may name it, and what happens if they don't. That is the
[Don't make the model guess](./building-a-game.md#dont-make-the-model-guess)
rule pointed at a case it had not been pointed at before.

Two defects of exactly this shape, both invisible to every other section:

- **Cybernoir 2127** — every Evidence play sat inside
  `if (state.hacker.kind === 'tracked')` (`legalMoves.ts`). A human Hacker's hand
  is opaque, so a human was never offered any way to commit Evidence: the entire
  win condition of that seat. A spelled-out `play_evidence` was accepted and
  worked, so the rule was implemented all along — only the offer was missing.
  `play_person` twenty lines above handled the opaque case correctly, and the
  same fix had already been made once for the Detective's `buy_clue`, so this
  was a known pattern missed on the other side. (The fix is in
  `packages/cybernoir-2127/src/legalMoves.ts` in zekel-games.)
- **Sweetlands Imperium** — a Red capture never offered `targetPlayerId`, because
  the targets are not known until the move resolves; the engine then took the
  enemy Leader. The rules make the target matter (capturing a leader and
  capturing an ambassador are different secret objectives), so a player chasing
  the ambassador had the leader taken for them.

Record the result in the artifact next to the §1 zone table.

### 2. Two-pass rulebook walk → traceability matrix

Run the backbone (§1 above). Produce the matrix: one row per rule, `status` ∈
`{implemented, partial, stub, missing, out-of-scope}`, a `file:line`, and a test
pointer. `partial`/`stub`/`missing` rows must be empty for a passing gate (or
justified as out-of-scope).

### 2a. Executable rules verification — the rule-walk, mechanized and re-runnable

The rule-walk above (§2) happens once; this step turns part of it into checks
that run forever. Full design record:
[`rules-verification.md`](./rules-verification.md). The plan already committed
the paper encoding (`encoding.ts`, authored blind at port-planning §3b); this
step builds the executable half against the finished engine:

- **Build the glue** next to the encoding (zekel-games keeps it in
  `packages/<game>/src/dev/verify/`): a projection of the engine state onto a
  common comparison shape, and checking rules that predict — for every applied
  move — what the affected fields of the next state must be, each rule citing
  its rulebook sentence word-for-word from the pinned rules text (locked by a
  citation test). List the adapter under `verify` in the game's dev hooks
  (zekel-games: `packages/<game>/src/dev/index.ts`). Reference:
  `packages/cybernoir-2127/src/dev/verify/` and
  `packages/cybernoir-2127/src/dev/index.ts` in zekel-games.
  Start with turn structure, action costs, and zone conservation ("every card
  is in exactly one place" — the cheapest wide net), plus whatever the plan's
  risk register flagged as contested; coverage may grow later.
- **Calibrate**: `pnpm verify-hunt -- --game=<id> --mode=random --games=1000`
  must be SILENT. Every alert is either a bug in your rules/glue (fix it) or a
  real engine-vs-book disagreement (a finding for this gate) — triage each one
  by name; never quiet an alert without recording which of the two it was.
- **Hunt**:
  `pnpm verify-hunt -- --game=<id> --mode=hunt --pop=40 --gens=20 --games-per=12`
  (minutes). The hunter evolves strategies that get paid only
  for NEW disagreements, so it reaches corners random play does not. Triage its
  archive the same way; every divergence report arrives with the cited sentence,
  both values, and the strategy that produced it in words.
- **Record both runs** (budgets, archive contents, dispositions) in
  `POST-PORT.md`, or in a findings file next to the encoding, linked from it.

Known blind spots, so this step is never mistaken for the whole gate: it
cannot see a legal move the engine wrongly WITHHOLDS (§7a is that net), it
does not check fields no rule predicts, and it inherits the module's data
tables. Track record: on Cybernoir 2127 the hunter found a real unknown engine
bug (null card drawn from an empty deck + empty discard) that 9,600 random games
never reached — in the exact corner the paper encoding had flagged as
rulebook-silent.

**This check is standing, not once**: any later change to the game's
`engine.ts` or `legalMoves.ts` — balance dials and designer rulings included —
re-runs the calibration + a hunter batch. Record that trigger in your project's
status table so it is not forgotten. A ruling that changes the rules updates the
pinned rules text and the affected rules in the SAME change; the citation tests
refuse quotes the new text no longer contains.

### 3. Anti-stub grep sweep

Grep the module for the vocabulary on the exclusion list in
[What fully playable means](./building-a-game.md#what-fully-playable-means) and
disposition **every** hit in the artifact:

```
placeholder  MVP  stub  TODO  FIXME  approximat  "for now"  "not yet"
no-op  simplif  deferred  "v0"  "v1"  "Phase N"
```

Each hit is either resolved, or a documented deliberate out-of-scope expansion
(a different edition/expansion), not a base-game gap. A surviving stub is a
failing gate. (Beware false positives — a comment like "absent reads as not yet
used" describing the tolerate-absence pattern is not a stub; note why.)

### 4. Setup-choice audit

Every per-seat identity/config/scenario/cosmetic choice the rules give the player
at setup must be **surfaced and asked**, never auto-assigned by seat index for a
human. Confirm each is wired through `getSetupChecklist`, `describeNextStep`, and
(for the consolidated identity pick) `setupChoices.ts` in `@zekel/game-kit` (see
[Setup choices belong to the player](./building-a-game.md#setup-choices-belong-to-the-player)).
Cross-check that the same choices are declared in `getBalanceAxes()` (the
balance-axes step of "What fully playable means" — this is the balance gate's
twin, but its **absence is a post-port gap** because an un-declared setup choice
is a choice nobody verified the player owns).

### 5. In-game choice audit (the in-head playtest) — MANDATORY, and the all-AI harness CANNOT do it for you

Turn the "playtest it in your head" step of
[What fully playable means](./building-a-game.md#what-fully-playable-means)
into a structured pass: walk a full game from a human seat and, at **every**
point the rules give the player a decision — a target, a discard, an ordering, a
split, an optional bonus, a reward pick — ask: *did the engine make this choice
for them?* Every such choice the human should own must be surfaced (a named
move via `describeNextStep`, options enumerated by `get_legal_moves`) or
explicitly justified as auto-resolved. The red flag is the decision quietly
taken out of the player's hands.

> **⚠️ This step is NOT optional and a clean harness does NOT substitute for it.**
> The all-AI harness cannot see this kind of bug at all: the AI is *supposed*
> to auto-decide every choice, so an engine that silently auto-resolves a
> human-owned choice runs 50/50 clean games and looks "fully playable" while a
> real human seat is denied the decision. Rules-completeness (§2) and
> choice-ownership (§5) are **different gates** — passing the harness proves the
> former, never the latter. You must actually walk the human seat. A useful tell
> while reading the code: any branch commented *"humans would get a pending; AI
> auto"* that does **not** actually branch on `kind === 'human'` is a silent
> auto-resolution — the comment is a promise the code never kept.

> **Worked example — Wonderland's War.** That port was declared fully playable
> on the strength of every ability implemented, 50/50 clean harness games at
> every player count, and more than 1,900 green tests — but §5 had been skipped
> (only the *catalog* was written, not the human-seat walk). Doing it later
> found **eight kinds of decision settled for every seat, humans included**:
> which upgrade to take (or whether to skip), whether and which objective to
> complete, whether to block a penalty, which of two awards to take in a tie, a
> wager, which of two drawn cards to keep, the target of every targeted
> ability, and which unit to lose. Several even carried the comment *"Humans
> would get a pending; AI auto"* while the code auto-resolved for everyone. The
> harness had been green the whole time. The verdict had to be corrected to
> "fully playable all-AI; NOT for a human seat." **Do the walk; a green harness
> is not a substitute.**

**This step formalizes the shared choice catalog, and the catalog is DATA, not
prose.** The port runbook seeds it (every player choice point found while
building, in `PORT-NOTES.md`); post-port turns it into the game's
`src/choices.ts` — one row per choice, typed as `PlayerChoice` (`game.ts` in
`@zekel/game-kit`), declared through the `getChoiceCatalog` hook. Every
zekel-games package has one (for example
`packages/sweetlands-imperium/src/choices.ts`). Post-port owns *owner* and *how
surfaced*; ai-development fills *AI policy* (§7 there) and balance fills
*balance axis* — they **annotate this one catalog, they do not restate it**.
One catalog, three lenses, so the three gates can't drift. Combine the §4 setup
choices and the §5 in-game choices into it.

The `POST-PORT.md` §6 table is then **generated, never hand-written**:

```
pnpm choice-catalog -- <game-id>
```

Hand-maintaining a second copy is how the document and the code drift apart.

So this step has three parts, in order:

1. **Walk the human seat.** Unchanged, still mandatory, and still the only part
   that FINDS anything new.
2. **Write what the walk found into `choices.ts`** — each row saying who the
   rules give the decision to, and for anything the engine settles, why that is
   faithful.
3. **Generate the §6 table** from the catalog.

> **⚠️ The automated check tests only the rows someone wrote down.**
> `measureChoiceCoverage` (`@zekel/dev/harness/choiceCoverage`) plays a game
> in-process with one seat driven as a human and reports any row marked
> `player` that is never actually offered. Call it from a test so it runs on
> every `pnpm test`. (zekel-games' `8-bit-demon-hunter` asks the same question
> of its engine directly, with staged situations, in
> `src/__tests__/choiceCoverage.test.ts`.) That catches a decision the engine
> starts settling later — but a decision NOBODY LISTED is invisible to it.
> Wonderland's War failed by having no row at all, not by having a failing
> one, so skipping part 1 leaves the check green and meaningless. It protects a
> walk that happened; it cannot stand in for one that didn't.

**Reviewing `dependsOn` is part of the job, not a one-time write.** A row may
declare a condition that has to hold before the decision can come up (being a
particular faction, holding a particular card). The check then reports such a row
as unreached instead of failing. That field is the one place a real bug can hide
behind a reasonable-sounding excuse, so re-read the rows periodically and confirm
each condition against the code. In one catalog-wide review, of 114
`dependsOn` rows **four were simply wrong** (they named a move field, or in one
case a whole move type, that does not exist — a row that can never be covered
passes silently) and **two were covering real defects**. Roughly one in
twenty. Two mechanical helps: the coverage check reports a row whose move is
offered repeatedly but never carries the field it names, and `dependsOn` cannot
see fields nested inside arrays, so a decision carried in a nested field is not
separately checked.

This is the lens that distinguishes post-port from desync: here the question is
*ownership* (does the player get to choose?), not *fidelity* (can the model spell
the choice?). Defer the spelling/resolver side to the desync artifact.

### 6. Pending hygiene sweep

For every code path that sets `state.pending`, confirm the degenerate branch
(condition not met) explicitly clears it
([Pending state hygiene](./building-a-game.md#pending-state-hygiene)). A stale
pending makes the AI loop forever on an unresolvable action — a kind of bug the
unit tests miss and the harness surfaces as an errored game. List each pending
and its clear-path.

### 7. next_step coverage

Confirm `describeNextStep` names the exact move for **every human-owed pending**
(including mid-game ones, not just setup) and routes report phases to the human
reporter even when an AI is the active seat. AI-owed pendings return `null` so the
generic `ai_to_move` directive stands
([Telling the model what comes next](./building-a-game.md#telling-the-model-what-comes-next)).
Tabulate every pending → its directive.

Then play it rather than only reading it:

```
pnpm build
pnpm human-seat-sweep -- --games=<game-id> --n=2
```

This drives one seat as a human through the real client loop — read `next_step`,
call `get_legal_moves` or `suggest_move`, submit with `apply_move` — across every
supported player count and every seat position, and reports directives sent to the
wrong seat, human-owed steps with nothing offered, and moves the server suggests
and then refuses. It needs the compiled server, so it is a step here rather than a
test.

Treat it as cheap insurance, not as proof. **It has not yet caught a real defect**:
across 56 games on the three games with known escapes it reported nothing, and its
only catch so far was a fault introduced deliberately to confirm it works. Run it
because it is fast and tests something real; do not lean on a clean result.

One thing it CANNOT see, for the same reason the all-AI harness cannot: a decision
that is never offered produces nothing to trip over. Choice ownership is §5's job.

### 7a. Rules-teaching adoption / withheld-move legibility

**Rules text on the server is REQUIRED, not optional.** The game must serve
its rules through `get_rules` — sectioned (`getRulesSections`, preferred; the
port runbook says author sections from the start) or at minimum a
`getRulesText` blob. A game with NO rules text fails this section: every
rules question the client gets is then answered from training memory, and it
will answer differently each time (Cybernoir 2127's first integration games
gave three different answers to "how does Evidence work?" in one sitting — the
server had no rules at all, and an earlier "if adopted" wording of this section
let that through). Lock sections with the coverage test (every move type tagged
to ≥1 section, no duplicate ids — zekel-games models:
`src/__tests__/rulesSections.test.ts` in `cybernoir-2127` and
`8-bit-demon-hunter`).

If the game also adopts gate declarations, verify their locks here: every
`gated` move type's grey line renders live gate values, and the grey line /
rejection message / taught section all derive from ONE declaration
([`rules-teaching.md`](./rules-teaching.md); zekel-games example:
`fractured-fist/src/moveGates.ts`). Adopted or not, ask the question that
started rules teaching at representative states: **does every withheld move
have a speakable reason** the assistant can read from a tool response? A move
that can be absent with no stated reason is a gap the model will fill from
training memory (in one game, a move the player expected was missing with no
reason given, and the model made up a rule to explain it — see the problem
section of `rules-teaching.md`).

### 8. Logging path

Record whether the game uses rich `getLog` or cheap `getScoreboard`
([The game log](./building-a-game.md#the-game-log)), and confirm it never leaks
hidden info (hand contents, face-down rewards) and uses names, not internal ids.
Note the per-move `summary` source.

The per-move `summary` is the canonical, spoken string for the move
([`spoken-narration.md`](./spoken-narration.md)). Run the spoken-text check and
record the result:

```
pnpm check-summaries -- --game=<game-id> --games=5
```

It plays all-AI games and flags any summary or AI narration that says a raw seat
id, an internal id, an abbreviation or debug text. It must report no problems.
Then read a handful of AI turns aloud: could a person copy each move onto the
table from the words alone? Information only one human may see must never be in
a summary; it goes in `privateReveals`.

### 9. Schema / migration impact

Did this port (or a change during it) alter `SessionState` or the game's state
types? Saved sessions outlive code changes
([Saved sessions outlive code changes](./building-a-game.md#saved-sessions-outlive-code-changes)),
so either the change is additive and the reading code tolerates absence, or it
needs a migration: a bump of `SESSION_SCHEMA_VERSION` and an old→new transform
in **both** persistent stores (`core/store/types.ts`, `core/store/sqlite.ts`
and `core/store/mongo.ts` in `@zekel/mcp`). Confirm which, and record it. This
is the maintenance landmine the committed artifact exists to record.

### 10. Sibling gates

Confirm the other two gates passed and **link their outputs** — do not restate
them. The desync run reached `NO DESYNC` for each seat; the balance harness ran
clean (zero errored games) for every player count with axis coverage. The
artifact's sign-off cites the desync transcript and `FINDINGS-<game>.md`.

---

## Filling the traceability matrix — conventions

- One row per **rulebook rule**, not per code function. If one function
  implements three rules, that's three rows pointing at the same `file:line`.
- `status: implemented` requires *both* a code pointer and a test pointer. No
  test → downgrade to `partial` and explain.
- Group rows by rulebook section so a reviewer can diff against the physical book.
- Prefer the printed page number in the rule description ("Trade: gain 2 coins,
  P.20") so the row is self-locating.

---

## The gate / sign-off

The artifact ends with a sign-off block: date, `pnpm test` count, the desync
result per seat, the balance run summary, and links out. The port is "fully
playable" **iff** every matrix row is `implemented` or documented-out-of-scope,
every grep hit is dispositioned, every setup and in-game choice is owned-or-
justified, every pending clears, and the three gates are green. Anything short of
that is recorded as a known gap and the game is **not** described as fully
playable.

---

## Per-game checklist

- [ ] §0 Provenance pinned (rulebook edition + pages, reference impl + commit).
- [ ] §1 Zone categorization lifted from `types.ts` and verified (esp. shared
      hidden decks).
- [ ] §1a View completeness: every public-physical / private-known field
      structurally recoverable from the views (table-reconstruction test);
      face-up discards public unless the rulebook forbids; view indices match
      the move language's base/frame; locked by a view test.
- [ ] §1b Every zone hidden from the server checked against the move list: a
      HUMAN holding that seat is actually offered its core actions, or the move
      description says the player may name the value and what happens if they
      don't.
- [ ] §2 Two-pass rulebook walk done; traceability matrix complete, every
      `implemented` row has a code + test pointer.
- [ ] §2a Rules checker built (where the game has an encoding): random-play
      calibration silent; a hunter batch run; every alert triaged and recorded.
- [ ] §3 Grep sweep run; every hit dispositioned; no surviving stub/MVP/approx.
- [ ] §4 Every setup choice surfaced/asked; declared in `getBalanceAxes()`.
- [ ] §5 In-head playtest **actually walked from a human seat** (NOT inferred from a clean all-AI harness, nor from a green choice-coverage check — both are blind to a decision nobody listed); every in-game player choice owned (human pending) or explicitly justified as auto-resolved. Grep for `"humans would get a pending"`-style comments that don't branch on `kind === 'human'`.
- [ ] §5 The walk's findings written into `src/choices.ts`
      (`getChoiceCatalog`), the §6 table GENERATED from it
      (`pnpm choice-catalog -- <game-id>`), and the choice-coverage check
      green for the game.
- [ ] §5 Every `dependsOn` row re-read against the code: the condition is real,
      and the move type and any field it names actually exist. (One in twenty
      were wrong in one catalog-wide review; a row that can never be covered
      passes silently.)
- [ ] §6 Every pending-setting path clears in its degenerate branch.
- [ ] §7 `describeNextStep` names a move for every human-owed pending; the
      human-seat sweep run (`pnpm human-seat-sweep -- --games=<id>`)
      with no violations.
- [ ] §7a Rules text served via get_rules (sections preferred; NO rules text =
      fail); adoption status recorded; every withheld move has a speakable
      reason (grey line / tagged rules section / offered description).
- [ ] §8 Logging path recorded; no hidden-info leak; names not ids;
      `pnpm check-summaries` reports no problems.
- [ ] §9 Schema/migration impact recorded (bump+migrate, or tolerate-absence).
- [ ] §10 Desync (`NO DESYNC`, both seats) and balance (clean, all counts) gates
      green and linked.
- [ ] Deliverable `packages/<game>/POST-PORT.md` committed.

---

## Deliverable template

The committed artifact uses these sections (see
`packages/8-bit-demon-hunter/POST-PORT.md` in zekel-games for a filled example):

```
# Post-port verification — <Game>

1.  Provenance & sources
2.  Zone categorization (4-category table) + view-completeness classification
    + the hidden-zone check against the move list (§1b)
3.  Mechanics traceability matrix (rule → status → file:line → test)
4.  Edge-case catalog (the standing list, answered per-game)
5.  Design choices — forced (port constraints) vs discretionary (rule reading)
6.  Choice catalog — GENERATED from src/choices.ts by
    `pnpm choice-catalog -- <game-id>`; never hand-written.
    choice · owner · how surfaced · AI policy · balance axis
    (post-port fills owner + how-surfaced; ai-development fills AI policy;
     balance fills the axis — one catalog, annotated, never restated)
7.  Turn-action structure
8.  next_step / describeNextStep coverage map
9.  Logging path
10. Schema / migration impact
11. Rules ambiguities → resolution log
12. Out-of-scope / expansions
13. Verification sign-off (date, tests, desync + balance links)
```
