# Port runbook (build phase)

How to take a game from "we have a reviewed plan" to "implemented, smoke- and
harness-clean, ready for verification." This is the **build** phase — the first
gate that produces a code module, and the one every later gate exists to check.
The porting rules (1–7) in
[building-a-game.md, "Porting from an existing version"](./building-a-game.md#porting-from-an-existing-version)
are the load-bearing laws; this runbook is the process that applies them and the
record it produces.

**Its upstream is port-planning** ([`port-planning-runbook.md`](./port-planning-runbook.md)):
the build should not start until the plan's human-coverage review gate is green.
The plan (`packages/<game>/PORT-PLAN.md`) is this runbook's input — the feature
inventory, zone plan, move shapes, choice-catalog seed, and build milestones are
already written and reviewed there. This runbook *builds the plan*, it does not
re-derive it; where the build discovers the plan was wrong, fix the code and note
the divergence in `PORT-NOTES.md`.

It sits between planning and the verification gates:

```
port-planning ──▶ PORT (this one) ──▶ post-port ──▶ ai-development ──▶ ┌─ desync
   the spec          build                rules          AI quality    └─ balance
```

| Gate | Runbook | Owns |
|---|---|---|
| port-planning | [`port-planning-runbook.md`](./port-planning-runbook.md) | the spec: exhaustive, human-reviewed feature inventory + build plan |
| **Port** (this one) | [`port-runbook.md`](./port-runbook.md) | the build: scope, zones, data, faithful code |
| post-port | [`post-port-runbook.md`](./post-port-runbook.md) | every rule implemented; every choice reaches the player |
| ai-development | [`ai-development-runbook.md`](./ai-development-runbook.md) | a good, instrumented AI across a skill ladder |
| desync | [`desync-harness-runbook.md`](./desync-harness-runbook.md) | weak-model client tracking |
| balance | [`balance-harness-runbook.md`](./balance-harness-runbook.md) | balance + metagame |

> **The build is where the irreversible decisions are made.** Zone categorization
> and shared-hidden-deck identification (§2) shape every move shape, tool response,
> and type in the module. Get them wrong and the fix is a rewrite, not a patch. Do
> §2 before writing any move shape.

---

## The deliverable

One committed, per-game artifact: **`packages/<game>/PORT-NOTES.md`** (in the
game's own package folder) — the build's design record and running scratchpad.
Use the hyphenated spelling, matching `POST-PORT.md` / `AI-NOTES.md`. Unlike the
downstream verification artifacts, this one is *living during the port* —
scope, the zone table, the data-transcription plan, the build order, open
questions — and settles into the provenance + design record post-port reads.

---

## The first decision (do this before any move shape)

### Zone categorization + shared hidden decks

Categorize every deck, hand, and hidden zone into the four categories from
[building-a-game.md, "Physical-first design"](./building-a-game.md#physical-first-design):
public/shared, server-tracked AI-private, server-dealt human-private, opaque
human-private. **The first question is: which zones are shared AND hidden?** A
shared deck both players draw hidden cards from cannot use the tracked/opaque
split — it needs the server-dealt category, with the report-then-deal flow
([Shared decks](./building-a-game.md#shared-decks)). Getting this wrong rewrites
the move shapes, the tool responses, and the type system (porting rule #7).

Write the categorization as the comment block at the top of `types.ts` (every
game module must carry it there) and mirror it into `PORT-NOTES.md`. This block
is what post-port §1 verifies — author it now, deliberately.

---

## The process

### 1. Scope lock

The scope was *proposed* and reviewed in the plan (port-planning §1) — lock it now.
Pin, in `PORT-NOTES.md` and any project notes you keep: which
**edition/expansions** are in scope vs explicitly out; the **player counts** to
support; and the **reference material** — the exact rulebook (edition + pages)
and the reference implementation (repo + commit/path), if porting from code. This
is the provenance post-port §0 inherits. With the plan reviewed, "out of scope"
is already a decision; this step records it as settled.

### 2. Zone categorization (above) — `types.ts` comment block + `PORT-NOTES.md`.

### 3. Transcribe the data faithfully

Cards, tech, tiles, scoring tables, board geometry — transcribe from the rulebook/
components into `data/`, not from memory. For image-only or fiddly data, use a
`DATA_TEMPLATE.md` in the module (a fill-in template with a slot for every
printed field, so a missing field shows as an empty slot) to structure the
transcription. **Lock the data with integrity tests** (`data.test.ts`): counts,
id↔name uniqueness, cost/effect ranges, prerequisite references resolve. Data
errors are the cheapest bugs to prevent and the most expensive to chase later.
(Examples: `src/__tests__/data.test.ts` in zekel-games' `sweetlands-imperium`,
`cybernoir-2127` or `neither-guts-nor-gears`.)

### 4. Port the code as exactly as possible

Apply porting rules #1–#3: match the original's structure/names/control flow;
where you can't be exact (idioms, sync→async, the physical-first split), **comment
the divergence and reason about its gameplay/AI effect**; consult the rulebook (not
intuition) when the original is unclear, and write the mapping down. Preserve
heuristic weights/orderings/constants verbatim — the AI port's precision is
load-bearing (ai-development depends on it). Use full words, never abbreviations
(rule #6).

### 5. Build order

A reliable spine, so each layer rests on a tested one:
1. **Engine spine** — `createInitialState` + `applyMove` skeleton + state types.
2. **Setup + identity picks** — wire `setupChoices.ts` (in `@zekel/game-kit`)
   for any per-seat identity (resolve asymmetric identities BEFORE placing
   identity-keyed pieces; see
   [Setup choices belong to the player](./building-a-game.md#setup-choices-belong-to-the-player)).
   If the rulebook recommends a first-game/beginner setup, implement it as a
   named deterministic option (the default where the rulebook advises it), built
   from the exact printed components — and have guidance/`getSetupChecklist`
   describe it in the rulebook's own words (e.g. "the objectives marked 1") so
   "use the beginner setup" resolves to the printed set, not an approximation.
3. **Phases** — the round/phase machine.
4. **Actions / moves** — each action type; **accept the printed name** for any
   constrained-set field, resolve name→id server-side
   ([Don't make the model guess](./building-a-game.md#dont-make-the-model-guess)).
5. **Scoring + game-end** — every scoring case, tiebreaker, end condition.
6. **Views + legalMoves** — `getPublicView`/`getPlayerView` (no hidden-info leak);
   `getLegalMoves` enumerates concrete options.
7. **MCP wiring** — `index.ts`: the `Game` interface + the hooks below.

### 6. Wire the framework hooks as you build

Don't defer these to post-port — author them alongside the code they describe (full
*verification* is post-port's job, but the hooks must exist):
- `describeNextStep` for every human-owed pending; `getSetupChecklist` (`[]` for
  all-AI). See
  [Telling the model what comes next](./building-a-game.md#telling-the-model-what-comes-next).
- `getLog` (rich) or `getScoreboard` (cheap) so moves are reported, never silently
  applied ([The game log](./building-a-game.md#the-game-log)).
- Each move's `summary` (`state_summary`) written to be **spoken as-is**: the
  physical action first, display names (`seatNames.ts` in `@zekel/game-kit`),
  printed names, no ids or engine terms, and nothing hidden from any seat. It is
  the canonical string for the move; an AI's `narration` adds nothing it lacks.
  Conventions: [`spoken-narration.md`](./spoken-narration.md).
- `describeNextStep` answer hints (`human_response`, with `private: true` when
  the answer is a secret) and `facts` for anything the `instruction` prose says
  beyond them — a client that never reads the prose must still get it
  ([`client-modes.md`](./client-modes.md)).
- `getPhysicalSetup`: the physical setup as ordered, speakable steps, with
  report steps pointing at their `getSetupChecklist` entry.
- `getSessionStartGuidance` stating the **turn-action structure** and pointing at
  per-session values.
- `getReferenceData` / `move_schema` so the legal set is surfaced.
- Rules authored as **sections** from the start (`getRulesSections` with
  move-type/phase tags, plus gate declarations for gated move types), not one
  blob — the blob `getRulesText` derives from the sections. See
  [`rules-teaching.md`](./rules-teaching.md); splitting a blob after the fact is
  the expensive path (one large game had to be retrofitted this way, across
  more than a hundred move types). **Rules-teaching adoption is a port
  BLOCKER, not an optional extra** — a module without `getRulesSections` +
  gate declarations does not pass this runbook's finish checks. (Examples in
  zekel-games: `fractured-fist/src/rulesSections.ts` and
  `fractured-fist/src/moveGates.ts`; `adventurer-olympics` and
  `neither-guts-nor-gears` also declare gates.)

### 7. Edge cases + pending hygiene, continuously

As you build, apply porting rule #5 and the
[pending-hygiene rule](./building-a-game.md#pending-state-hygiene): every
pending-setting path clears its degenerate branch; handle deck-exhaustion,
empty-hand, no-legal-move, simultaneous game-end, numeric extremes. These are the
bugs the harness will otherwise surface as errored games.

### 7a. Respect component-count and resource limits (load-bearing)

A physical game is **bounded by its box contents** — the engine must honor every
one of those bounds, because the harness (all-AI, low contention) usually won't
hit them and they slip through silently. From the component list and the rules,
enumerate every bounded quantity and enforce it where it's spent/gained:

- **Shared finite supplies** — tokens/cubes/markers/tiles with a printed count
  (e.g. "24 tokens, 4 per colour", "30 cubes"). A buy/take must check the *global*
  remaining supply, not just a per-player cap. Per-player ≤1 ≠ "only 4 exist". Test
  the high-player-count contention case — that's where 5 players chase 4 tokens.
- **Deck / pool conservation** — the total card count is invariant. A "convert /
  exchange / search" action must MOVE cards between deck/hand/discard, never **mint**
  a new one (a synthesized card silently grows the deck past its size). Assert
  `deck + discards + all hands == DECK_SIZE` in a test.
- **Per-resource caps** — influence/track maxima, tax ceilings, hand limits: clamp
  on every path that increases them (gain, trade, reward), not just the obvious one.
- **Per-player vs supply** — distinguish "no per-player limit" (a rule about
  hoarding) from "N exist in the box" (a supply bound). They can coexist; honor both
  unless the rules explicitly make a resource unbounded.

**Caveat — components are the default cap, but the rules can lift it.** The printed
count is the limit *unless the rules explicitly say otherwise*. Some games state a
resource is unlimited and the components are just "what we put in the box — use a
substitute if you run out" (a soft cap), while others make the count a hard rule
("if the supply is empty you cannot take one"). Default to enforcing the printed
count; relax it ONLY where the rules explicitly grant an overflow. Record which
reading each bounded resource uses (hard supply vs. rules-stated unlimited) in
`PORT-NOTES.md` so the choice is auditable, and confirm any ambiguous case with the
source/designer rather than guessing.

Lock the load-bearing ones with a `componentLimits` test (supply exhausted →
rejected; deck conserved through every exchange). Reference: zekel-games'
`sweetlands-imperium` (`doBuyToken` 4-per-colour token supply, `doBuySugar`
30-cube bank, `takeColorFromDeck` deck conservation, all in `src/engine.ts`;
`src/__tests__/componentLimits.test.ts`). `neither-guts-nor-gears` has one too.

### 8. The build's own check — smoke + harness-clean

The commands below are the script names zekel-games uses (its `package.json`
maps each to `tsx scripts/dev.ts <command>`, and `pnpm tool <command> [args]`
runs any of them). Other projects wire up the same `@zekel/dev` commands as the
`@zekel/dev` README shows. `ai-harness` (run here as `pnpm harness`) plays
batches of AI-vs-AI games through your built server.

The build is "done enough to verify" when:
- Your end-to-end smoke test passes (build first). In zekel-games that is
  `pnpm build && pnpm smoke`, which starts the real server and plays an easy
  all-AI game of every game through the MCP tools.
- `pnpm harness -- --game=<id> --n=50 --players=<each count>` runs with **zero
  errored games** for every supported count. The harness is a bug-finder — any
  `ERR:` is a real edge case to fix before handing off, not after.
- `pnpm test` green (engine/data/ai unit suites).

This is not the fully-playable bar (that's post-port) — it's "no crashes, rules
roughly walk." Don't claim playable yet.

### 9. Seed the choice catalog

The plan already seeded this from the rulebook (port-planning §5) — carry it
forward and **add every point you discover while building** where the rules give a
player a choice (target, discard, order, split, reward, optional bonus, setup
identity) in `PORT-NOTES.md`. This seed becomes the **shared choice catalog**
post-port formalizes (ownership), ai-development annotates (AI policy), and balance
annotates (axis) — one table, three lenses, instead of three drifting copies. You
see these choices first while building; capture them now.

### 10. Hand off to post-port

The build is complete when §8 is clean and `PORT-NOTES.md` carries scope, the zone
table, provenance, the divergence log, and the seeded choice catalog. Post-port
then verifies rule-by-rule.

---

## Per-game checklist

- [ ] §1 Scope locked (edition/expansions in/out, player counts, provenance) in `PORT-NOTES.md`.
- [ ] §2 Zone categorization written in `types.ts` comment block; shared-hidden decks identified BEFORE move shapes.
- [ ] §3 Data transcribed from source + locked with `data.test.ts`.
- [ ] §4 Code ported faithfully; every divergence commented + reasoned.
- [ ] §5 Engine→setup→phases→actions→scoring→views→MCP built in order.
- [ ] §6 Framework hooks wired (`describeNextStep`, `getSetupChecklist`, log path, guidance, reference data); **rules teaching adopted** (`getRulesSections` + gate declarations — blocker).
- [ ] §7 Edge cases + pending hygiene handled as built.
- [ ] §7a Component-count + resource limits enforced (shared supplies, deck conservation, per-resource caps); locked with a `componentLimits` test.
- [ ] §8 Smoke green; harness clean (0 errored) for every player count; `pnpm test` green.
- [ ] §9 Choice catalog seeded in `PORT-NOTES.md`.
- [ ] Deliverable `packages/<game>/PORT-NOTES.md` committed.

---

## Deliverable template

`packages/<game>/PORT-NOTES.md`:

```
# Port notes — <Game>

1. Scope (edition, expansions in/out, player counts)
2. Provenance (rulebook edition + pages, reference impl + commit)
3. Zone categorization (4-category table; shared-hidden decks called out)
4. Data transcription plan + integrity-test coverage
5. Divergences from the reference implementation (each reasoned)
6. Build status by layer (engine/setup/phases/actions/scoring/views/MCP)
7. Choice catalog (seed) — every player choice point found while building
8. Open questions / rules ambiguities to resolve in post-port
9. Build-check results (smoke, harness-clean per count, test count)
```
