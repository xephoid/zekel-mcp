# Port-planning runbook

How to take a game from "we want to port it" to "we have a reviewed, exhaustive
plan that says exactly what the port must build." This is the **planning** phase —
the front of the lifecycle, upstream of the build. It produces a single
design document that enumerates *every* feature of the game in enough detail that
(a) the port runbook can build straight from it without re-deriving the rules, and
(b) a human can read it and confirm **full coverage** before any code is written.

It is the upstream of everything:

```
PORT-PLANNING (this one) ──▶ PORT ──▶ post-port ──▶ ai-development ──▶ ┌─ desync
   the spec                  build       rules         AI quality       └─ balance
```

| Gate | Runbook | Owns |
|---|---|---|
| **Port-planning** (this one) | [`port-planning-runbook.md`](./port-planning-runbook.md) | the spec: an exhaustive, human-reviewed feature inventory + build plan |
| Port | [`port-runbook.md`](./port-runbook.md) | the build: scope, zones, data, faithful code |
| post-port | [`post-port-runbook.md`](./post-port-runbook.md) | every rule implemented; every choice reaches the player |
| ai-development | [`ai-development-runbook.md`](./ai-development-runbook.md) | a good, instrumented AI across a skill ladder |
| desync | [`desync-harness-runbook.md`](./desync-harness-runbook.md) | weak-model client tracking |
| balance | [`balance-harness-runbook.md`](./balance-harness-runbook.md) | balance + metagame |

> **Why a planning gate exists.** Every downstream gate is a *check* — and a check
> can only catch what it thinks to look for. The recurring failure of a port is not
> a feature built wrong; it is a feature **never noticed** — a card sub-clause, an
> edge-case tiebreaker, a phase that only triggers at 5 players. Post-port's
> two-pass rulebook walk is the safety net, but discovering a missing mechanic
> *after* the build means a rewrite, not a patch (the irreversible decisions —
> zone categorization, move shapes — were already poured around the gap). The plan
> moves enumeration **before** the irreversible decisions, and puts a human in the
> loop to confirm coverage while changing the plan is still free.

> **The plan is a spec, not code.** No game module exists yet when
> this runbook runs (beyond, optionally, a data-transcription scratch). The output
> is prose + tables a reviewer reads. Resist writing engine code here — the moment
> you do, you have started the port without a reviewed plan.

> **The plan is also the handoff artifact.** §7's milestones are the build's
> work units and their checks are its done-conditions — whoever builds, including
> you tomorrow. That is why the runnable checks, the ambiguity flags, and the
> divergence ledger are requirements and not niceties: they are what lets someone
> other than the plan's author finish the port without re-deriving it.

---

## The deliverable

One committed, per-game artifact: **`packages/<game>/PORT-PLAN.md`** (in the
game's own package folder) — the forward-looking design spec, written and
reviewed *before* the build. It is the first file in the per-game record set,
ahead of `PORT-NOTES.md` / `POST-PORT.md` / `AI-NOTES.md`. A public example:
`packages/8-bit-demon-hunter/PORT-PLAN.md` in
[zekel-games](https://github.com/xephoid/zekel-games).

It serves three readers:
1. **The human reviewer** — who signs off that the plan covers the whole game
   before a line is built. This is the gate.
2. **The port runbook** — which builds straight from the feature inventory and
   build decomposition, instead of re-reading the rulebook cold.
3. **Post-port** — which inherits the plan's feature inventory as the *seed* of its
   traceability matrix (post-port still re-enumerates independently — that
   independence is the point of its two-pass walk — but a plan and an independent
   walk that **disagree** immediately flags a gap in one of them).

Commit it before the build starts. Like `PORT-NOTES.md` it can keep living during
the port (a rule you misread, a feature that proved bigger than planned), but its
load-bearing job is done at the review gate.

---

## The methodological backbone

Two habits make this gate worth running. Everything below rests on them.

### 1. Exhaustive enumeration, source in hand

The plan is only as good as it is complete, and completeness comes from reading
the **source**, never memory (porting rule #2 in
[building-a-game.md](./building-a-game.md#porting-from-an-existing-version): the
printed rulebook is truth; the reference code is one possibly-buggy
interpretation). The source may be a PDF and photographed components rather
than text — extract it faithfully first (§0) — but the rule stands: read it,
don't recall it. Walk the rulebook **section by section** and the components
**piece by piece**, and write down
*every* discrete feature: every phase, every action, every card / tile / tech and
each of its sub-clauses, every scoring case, every tiebreaker, every game-end
condition, every "you must" / "you may", every player-count-conditional rule. The
test of a good inventory is granularity — if one row hides three rules, a reviewer
can't tell whether all three are covered. Split until each row is one checkable
thing.

This is the same enumeration post-port's pass-1 performs — done **earlier, and
forward-looking** (each row also carries *how we'll build it*), so the build has a
checklist and the human has something to review. The two enumerations are meant to
corroborate; if post-port later finds a rule the plan missed, the plan's review
gate had a hole worth understanding.

### 2. The human review gate

The plan exists to be **reviewed by a human before the build**, and that review is
the whole point of the runbook — not a formality at the end. The plan must be
written *for* that review: organized by rulebook structure so the reviewer can
diff it against the physical book, explicit about what is in and out of scope,
and honest about what is still unknown (open questions, rules ambiguities). The
gate is cleared only when a human has confirmed the inventory covers the whole
game and signed off. Anything the reviewer flags as missing goes back into the
plan before the build begins. (See §9.)

---

## The process

Work the steps in order. Each has a corresponding section in the deliverable.
You are reading and writing, not coding.

### 0. Gather and extract the sources

Two kinds of source feed a port, and both must be pinned here:

- **The rulebook** — usually a PDF. Read it page by page; record the edition and
  the page/section span you will walk.
- **The components** — cards, tiles, tokens, boards, player mats. These often
  arrive as **photos or scans**, not text: a deck shot card-by-card, a board image,
  a reference sheet. Read them as images; the printed names, costs, and effect text
  on them are the data you must transcribe.
- **The reference implementation**, if porting from code (repo + commit/path).

When the source is an image or a scanned PDF, **extraction is itself the first real
work of the port, and it is fallible** — a misread cost, a dropped effect
sub-clause, a card whose photo is blurry, cropped, or missing from the set will
silently corrupt the build downstream exactly like a missed rule. Treat extraction
as a step with its own fidelity bar:

- Transcribe from the source into structured notes / `data/`, **never** from memory
  or from what the game "probably" does (porting rule #2: the source is truth).
- For image-only or fiddly component data, structure the transcription with a
  **`DATA_TEMPLATE.md`** in the module: a fill-in template with one block per
  component and a slot for every printed field, so a missing field shows as an
  empty slot instead of a silent gap. Several earlier ports built from
  image-only or PDF-only sources used this.
- **Record extraction coverage**: which cards/pages were transcribed cleanly, and
  which were illegible, ambiguous, or absent from the source — and what you did
  about each (re-shot, cross-checked against the rulebook, or flagged for the
  reviewer). An unreadable card is an **open question** (§8), not a silent guess;
  the review gate (§9) must see it.

This provenance — exact rulebook edition + pages, the component photo/scan set, and
the reference implementation — is what the port and post-port runbooks inherit.
Record it once, here.

### 1. Scope proposal

Propose, for the human to confirm: which **edition / expansions** are in scope vs
explicitly out; the **player counts** to support; any mechanic deliberately
deferred to a later pass. Scope is a *proposal* at this stage — the review gate
(§9) is where it gets locked. State the rationale for each out-of-scope call so
"out of scope" is a reviewed decision, not a silent gap. (The port runbook's §1
scope-lock then inherits this as settled.)

### 2. Component & data inventory

From the component list, enumerate every physical thing and its **count**: cards
(by deck/type), tiles, tokens, cubes, dice, boards, tracks, player mats. Counts
are load-bearing twice over — they seed the data-transcription plan, and they are
the **component caps** the build must enforce (port runbook §7a: shared finite
supplies, deck conservation, per-resource maxima). Flag each bounded quantity here
so the build knows what to clamp. Where the data was extracted from photos/scans
(§0), **reconcile the count you transcribed against the stated component manifest**
— a deck you read as 38 cards against a printed "40 cards" means extraction dropped
two, caught here as an arithmetic mismatch rather than surfacing later as a missing
mechanic. Note any component still image-only / not yet cleanly transcribed.

For a **rulebook-only game** (no coded reference implementation), these counts are
also the build's **primary correctness anchors**: they become the conservation and
bounds invariants the harness asserts every move of every game — "the deck holds
exactly N cards across all zones at every point", "no resource exceeds the printed
supply", "VP awarded equals VP on the score track". With no reference
implementation there is nothing to diff against, so these global properties are
the strongest oracle the build will have; they are also cheap to run. Enumerate
the counts as things the engine will be *held to*, not just transcription
bookkeeping.

### 3. The complete feature inventory (the heart of the plan)

The exhaustive enumeration (backbone §1), as a table. **One row per discrete
rule/feature**, grouped by rulebook section. For each row capture:

- **Rule** — what it is, with a page/section reference (`P.12`, "Combat §4").
- **Detail** — the actual mechanic, completely enough that the builder doesn't
  re-read the rulebook: the numbers, the conditions, the sub-clauses, the
  exceptions. This is where "no feature missed" is won or lost — a row that says
  only "scoring" has hidden the work.
- **Planned approach** — how the port will build it: which layer (engine / phase /
  action / scoring / view), the rough move shape if it's a player action, the
  data it reads.
- **Complexity / risk** — trivial / moderate / hard, and *why* if not trivial
  (interacts with hidden info, unusual control flow, ambiguous rule, heavy AI
  implication). This is what the build order (§7) and risk register (§8) draw
  from.

Cover, at minimum: setup, the turn/phase structure, every action type, every
card/tile/tech category **and their individual effects**, resource economy,
scoring (every case + every tiebreaker), and every game-end condition. Don't
collapse "all 40 cards" into one row if their effects differ — the differing
effects are exactly the features that get missed.

**First-game / beginner setup is a feature — inventory it.** If the rulebook
recommends a setup for a first game ("for your first time, use the cards
marked X", a suggested loadout/scenario/starter side), give it its own row:
list the EXACT printed components it selects, read from the rulebook or the
physical cards — never inferred from which options *look* easy. The build must
expose it as a named, selectable option (usually the default), so a human who
asks for "the beginner setup" gets precisely the printed set. A "default" that
is merely plausible desyncs the table from the rulebook on turn zero.
(In one port — Nimalia — the default objective set was hand-picked and did not
match the rulebook's printed first-game set.)

#### 3a. The counter-pass — a second, independent enumeration (rulebook-only games)

This table has no oracle. "Did anyone notice this mechanic exists" cannot be
checked mechanically, and verifying completeness is not cheaper than enumerating:
a reviewer reading a 200-row table cannot tell which row is *absent*. So for a
**rulebook-only game** — no coded reference to diff against — the answer is a
second independent enumeration and a diff, not a review. (Skip it when a
reference implementation exists; its data and behavior already catch most of
what this would.)

- **Independence is structural, never instructed.** The second enumeration is
  made from the printed sources ALONE — not this plan, not the repo. An
  instructed "don't peek" is unverifiable, because an anchored second pass reads
  exactly like an agreeing one.
- **Enumeration only.** Output is one row per discrete rule — `section | page |
  rule | detail` — page cite mandatory, in the same rulebook-section order as the
  table above so the diff aligns.
- **Every disagreement is resolved by re-reading the cited page.** The source
  wins, never the argument. A disagreement is a missing row, two contradictory
  readings of one rule, or a granularity mismatch (one row hiding three rules).
  Recording "20 missing in the primary" is not resolving it — the reconciliation
  is done when the unresolved set is empty and each resolution carries its
  re-read page cite. (One port — Notorious — shipped a gap by treating the list
  of disagreements as if it were the fix.)
- **Agreement is not confirmation.** On a published game both readers share
  training priors and can invent the same "fact", so an *uncited* agreed claim
  gets flagged like any disagreement. On an unpublished or client game neither
  has priors, and this is at its most reliable.
- **Commit the reconciliation record** as a numbered section of the plan. It is
  the review artifact §9 leans on, and post-port's priority list: contested rows
  are empirically the slippery ones.

#### 3b. The rules encoding — the second statement of the rules, authored NOW

Full design record and file layout:
[`rules-verification.md`](./rules-verification.md). The plan authors a
machine-checkable encoding of the rules at planning time — before any engine
code exists — because that is the only moment the encoding's independence is
structural: there is no port yet to copy. It stays in the repo as a check on the
port from outside, forever.

- **Pin the rules text.** A plain-text copy of the rulebook, versioned, kept
  with the game's rules checker (zekel-games keeps it at
  `packages/<game>/src/dev/verify/rules-<ver>.txt`). Every citation check runs
  against this file; when a ruling later changes the rules, the pin is updated
  with it.
- **Author blind.** The encoding is written in a fresh context given exactly
  two inputs: the pinned rules text and `@zekel/dev/verify/types` (the file
  `packages/dev/src/verify/types.ts` in
  [zekel-mcp](https://github.com/xephoid/zekel-mcp)). Nothing else — not this
  plan, not the repo. Same discipline as the counter-pass (§3a): independence
  is structural, never instructed.
- **Gaps are entries, never absences.** One entry per rule, each citing a
  word-for-word quote (the linter string-searches for it, so a citation cannot
  be paraphrased). Where the book is silent about a reachable situation, or a
  sentence supports two readings, that is its own entry stating the situation
  and the ruling needed.
- **Lint until clean, then read the findings.**
  `pnpm verify-lint -- --game=<id>` must report zero structural problems; its silent/vague list is a
  findings deliverable on its own. Fold every finding into §8's risk register —
  the silences are designer questions, and they are empirically where ports
  invent behavior.

  (Commands in this doc are the script names zekel-games uses — its
  `package.json` maps each one to `tsx scripts/dev.ts <command>`. Other
  projects wire up the same `@zekel/dev` commands as its README shows, or run
  them as `pnpm tool <command> [args]` in zekel-games. `verify-lint` reads
  `src/verify/<game>/encoding.ts` in the current folder unless given
  `--encoding=<file>`; zekel-games' `scripts/dev.ts` passes
  `packages/<game>/src/dev/verify/encoding.ts` for you.)
- **Commit** the encoding (`encoding.ts`, next to the pinned rules text) with
  the plan. Four zekel-games packages carry one to read:
  `cybernoir-2127`, `sweetlands-imperium`, `neither-guts-nor-gears`,
  `adventurer-olympics`, each under `src/dev/verify/encoding.ts`.

Track record: on Cybernoir 2127 this surfaced, unprompted, the rulebook's
silence about jail that had already produced a real shipped bug — plus 26 other
recorded gaps, at roughly two entries of noise.

### 4. Zone categorization plan (the irreversible decision — flag for review)

Plan the four-category split from
[building-a-game.md, "Physical-first design"](./building-a-game.md#physical-first-design)
for **every** deck, hand, and hidden zone: public/shared, server-tracked
AI-private, server-dealt human-private, opaque human-private. **The first question
is which zones are shared AND hidden** — a shared deck both players draw hidden
cards from needs the server-dealt category and the report-then-deal flow, not the
tracked/opaque split (porting rule #7; see
[Shared decks](./building-a-game.md#shared-decks)).

This is the single most expensive decision to get wrong (it shapes every move
shape, tool response, and type), and it is being made here *on paper* where it is
cheap to revise — so **call it out explicitly for the reviewer**. The port runbook
§2 then writes this exact table into the `types.ts` comment block; the plan is
where the reviewer pressure-tests it first.

### 5. Move-shape & choice plan

For each player action from §3, sketch the **move shape** — fields and, for any
field drawing from a constrained set (card, space, option), note that it must
**accept the printed name**
([Don't make the model guess](./building-a-game.md#dont-make-the-model-guess)),
so the build plans a `resolveX` helper rather than discovering the need
mid-build.

In the same pass, **seed the choice catalog**: list every point where the rules
hand a player a choice — target, discard, order, split, reward, optional bonus,
setup identity. This is the same catalog the port runbook §9 seeds and post-port
§5 formalizes — starting it here, from the rulebook rather than from the
half-built engine, means fewer choices discovered late. Note for each whether it's
a setup identity pick (→ `setupChoices.ts` in `@zekel/game-kit`; see
[Setup choices belong to the player](./building-a-game.md#setup-choices-belong-to-the-player))
or a mid-game pending (→ `describeNextStep`).

### 6. Framework-hook plan

List which framework hooks the game will need, so they're built alongside the code
(port runbook §6), not retrofitted: `describeNextStep` (enumerate the human-owed
pendings you already found in §5), `getSetupChecklist`, `getLog` (rich) vs
`getScoreboard` (cheap), `getSessionStartGuidance` (state the turn-action
structure), `getReferenceData`, and — for the balance gate's sake —
`getBalanceAxes` (classify each setup choice from §5 as identity / config /
scenario / cosmetic). Naming the axes now means the balance gate never finds an
un-evaluated choice. The hooks are described in
[building-a-game.md](./building-a-game.md); the `Game` interface itself is
`game.ts` in `@zekel/game-kit`.

### 7. Build decomposition & milestones

Turn the inventory into an ordered build plan along the port runbook's spine
(engine → setup → phases → actions → scoring → views → MCP), grouped into
milestones each of which is independently testable (e.g. "engine + setup smoke-runs
an all-AI game", "all actions legal-and-applied", "scoring + end correct"). Pull
the hard/risky rows from §3 forward where they're load-bearing for the spine. This
is the builder's roadmap and the reviewer's sense of size.

Each milestone's *Test:* line must be **runnable, not aspirational** — a check
that exists and executes at handoff: a data diff against the extracted source, a
parity test whose expected values were computed *here*, rulebook open, a harness
invariant, a grep. If a milestone can't be given a cheap honest check, the
milestone is underspecified — split or re-specify it now, while it's free. These
checks are the build's done-conditions, so they must be **anchored outside the
builder's write scope**: a check its own author can edit is documentation, not a
gate, and whoever is building will (consciously or not) drift the check toward
the code rather than the code toward the check.

### 8. Risk register & open questions

Collect every **rules ambiguity** (the rulebook is unclear or the reference code
contradicts it), every **hard feature** flagged in §3, and every **open question**
the human must answer before or during the build. For each, state the question,
the candidate readings, and a *proposed* resolution — but leave genuinely
designer-only questions for the review. This is the section the reviewer engages
with most; the rest is coverage, this is judgment. Ambiguities resolved at the
gate flow into the build as decisions; the rest become `PORT-NOTES.md` open
questions.

Three structures for this section's output:

- **Triage every open question** into one of: *must-answer-now* (structural —
  turn order, zone ownership, anything that shapes move shapes; blocks the
  build), *default-and-disclose* (build the proposed resolution as the default;
  ships in the record as "resolved X as Y — flag if that's not your intent"), or
  *parameterize-and-measure* (balance-relevant and flag-sized).
- **Parameterize-and-measure ambiguities get flag columns**: flag name, default
  reading, alternate reading. Both readings are built behind an `Options` field
  **from the first commit** — a rules-variant flag is a `config` axis in
  `getBalanceAxes`, and the harness sweeps it, so the ambiguity's competitive
  impact is *measured* instead of guessed ("under reading A, X wins 61%; under B,
  49%"). Retrofitting a variant into an engine that hardcoded one reading is the
  expensive rewrite this column prevents. Comparisons run under a fixed AI policy
  and are disclosed as such; a null result ("no detectable difference at n=N —
  print whichever wording is easier to teach") is a valid, reportable finding.
- **The divergence ledger**: every deliberate rule simplification the port will
  make, written HERE and **frozen at handoff**. The build never authors
  divergences — a new approximation discovered in code is a defect, not a
  footnote. That freeze is what keeps the ledger a disclosure list rather than an
  alibi. For client games it ships in the deliverable as exactly that.

For an unpublished (client/designer) game, the open questions go to the
**designer as one batch** after planning — see §9.

### 9. The human review gate

Hand the plan to a human and get explicit sign-off on **coverage** — that the
feature inventory (§3) accounts for the whole game with nothing missed — and on the
**scope** (§1), the **zone plan** (§4), and the **open-question resolutions** (§8).
Fold every flagged gap back into the plan. The gate is green only when the reviewer
has confirmed full coverage. **Do not start the port runbook until this sign-off is
recorded** in the plan's gate block — that is the entire reason the planning phase
exists.

For an unpublished (client/designer) game, the reviewer **is the designer**: the
§8 question batch doubles as the coverage review — nobody is better positioned to
confirm "that is my whole game," and their answers are the ground truth the
build's checks get computed from. Batch the questions once (a slow-responding
designer stalls this gate; only *must-answer-now* items justify off-batch pings).
Where a counter-pass was run, the committed reconciliation record is the primary
review artifact — the reviewer works the contested rows with their page cites,
not the raw feature table.

---

## Per-game checklist

- [ ] §0 Sources gathered + extracted (rulebook PDF pages; component photos/scans transcribed; reference impl + commit); extraction coverage recorded, illegible/ambiguous/missing items flagged.
- [ ] §1 Scope proposed (edition/expansions in/out, player counts, deferrals + rationale).
- [ ] §2 Component & data inventory with counts; bounded quantities flagged.
- [ ] §3 Complete feature inventory — one row per rule, grouped by section, each with detail + planned approach + complexity.
- [ ] §3a Rulebook-only game: independent counter-pass enumeration run from the sources alone; reconciliation committed with the unresolved set empty and every resolution carrying its re-read page cite.
- [ ] §3b Rules encoding authored blind from the pinned rules text; `verify-lint` reports zero structural problems; silent/vague findings folded into §8; `encoding.ts` committed beside the pinned rules text.
- [ ] §4 Zone categorization planned for every zone; shared-hidden decks called out for review.
- [ ] §5 Move shapes sketched (printed-name fields noted); choice catalog seeded.
- [ ] §6 Framework hooks planned, incl. `getBalanceAxes` classification.
- [ ] §7 Build decomposed into ordered milestones, **each with a runnable, anchored check at handoff**.
- [ ] §8 Risk register triaged (must-answer-now / default-and-disclose / parameterize-and-measure); flags carry name + default + alternate readings; divergence ledger written & frozen.
- [ ] §9 **Human review gate: coverage signed off**; gaps folded back in; sign-off recorded.
- [ ] Deliverable `packages/<game>/PORT-PLAN.md` committed before the build starts.

---

## Deliverable template

`packages/<game>/PORT-PLAN.md`:

```
# Port plan — <Game>

1.  Sources & extraction (rulebook edition + pages, component photos/scans,
    reference impl + commit; extraction coverage — illegible/ambiguous/missing items)
2.  Scope proposal (edition, expansions in/out, player counts, deferrals + why)
3.  Component & data inventory (every component + count, reconciled vs manifest;
    bounded quantities flagged)
4.  Feature inventory (the heart) — table:
    rule (+ page) · detail · planned approach · complexity/risk
    grouped by rulebook section; one row per discrete rule
5.  Zone categorization plan (4-category table; shared-hidden decks flagged)
6.  Move-shape & choice plan (move shapes; printed-name fields; choice-catalog seed)
7.  Framework-hook plan (describeNextStep / setup checklist / log path /
    guidance / reference data / getBalanceAxes classification)
8.  Build decomposition & milestones (ordered along the engine→MCP spine;
    each milestone with a runnable, anchored check)
9.  Risk register & open questions (ambiguities triaged: must-answer-now /
    default-and-disclose / parameterize-and-measure with flag columns;
    divergence ledger)
10. Review gate (reviewer — the designer for client games; date, coverage
    sign-off, gaps folded in; counter-pass reconciliation record if one was run)
```
