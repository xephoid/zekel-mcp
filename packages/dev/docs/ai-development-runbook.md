# AI-development runbook

How to take a game module from "the rules are implemented" to "the AI plays them
well and is **instrumented** so the balance harness produces honest numbers," and
produce the committed record that proves it.

It is the middle of three peer gates:

| Gate | Runbook | Question |
|---|---|---|
| **Post-port** | [`post-port-runbook.md`](./post-port-runbook.md) | Is every printed rule implemented, and does every choice reach the player? |
| **AI-development** (this one) | `ai-development-runbook.md` | Does the AI play every mechanic well, across a skill ladder, with the hooks balance needs? |
| **Balance** | [`balance-harness-runbook.md`](./balance-harness-runbook.md) | Is it balanced, and is the metagame healthy? |

**This gate exists because balance cannot tell balance from AI-incompetence.** A
mechanic the AI never uses reads as "weak" in the lift table; a `hard` tier that
doesn't actually out-play `medium` makes the "fair under good play?" read a lie.
The balance runbook's own caveat — *"a high-lift, rarely-used feature is an
AI-quality lead, and any balance verdict on it is premature"* — is this gap
leaking through. So the AI-dev gate's job is to hand balance an AI that is **good
enough and instrumented enough** to measure.

## ⛔ Hard precondition — DO NOT start AI-dev until the port is COMPLETE (post-port GREEN)

**This gate is BLOCKED until `POST-PORT.md` is a green "fully playable" verdict.** Do
not tune, measure, or build an AI against a port that is `partial` / `approximated` /
has `placeholder` data or deferred mechanics. This is a hard stop, not a preference,
because the AI is optimized *against the game's own reward structure* — and an
incomplete port has the **wrong** reward structure. Every AI measurement (skill
ladder, the stronger-tier-wins check in §1, lift, dead-turn) is then taken against a
game that does not exist, so the numbers are noise and any "AI gap" you chase may be
a **port gap wearing an AI mask**.

Concretely, before the first AI run, confirm ALL of:
- Post-port gate is **green** (every rule implemented; `ABILITY_DEFERRED`-style "not
  yet automated" sets are **empty**, not "most of them").
- The **scoring / VP economy is final** — real award values, not placeholders. The AI
  literally maximizes this; a placeholder scoring table trains the wrong policy.
- Every action/ability the AI could choose is actually **implemented and firing** —
  a no-op'd ability is invisible to the AI and silently distorts every position eval.

> **Worked example — Wonderland's War (this is exactly the trap).** AI-dev was started
> while the port still had about half its abilities deferred AND a *placeholder*
> scoring table (a flat stand-in for the real end-of-round awards). The heuristic
> `medium` tier measured *worse than uniform-random* — a baffling, alarming "AI gap" —
> and about 25 tuning attempts (different targeting rules, draw/stop models, spreading
> biases) all failed to close it, burning enormous effort. The result was an artifact:
> with the wrong scoring and missing abilities, the AI was optimizing a phantom game.
> Only after the port was **completed** (every ability firing) and the **real scoring
> data** supplied did the picture resolve — an MCTS tier immediately won **92–100%**
> against the weaker tiers, proving the game was skill-winnable all along. Had
> post-port been green first, none of that thrash would have happened. **Finish the
> port; then build the AI.**

If you discover mid-AI-dev that the port is not actually complete (a never-fired
ability, a placeholder constant), **STOP, return to the port/post-port runbook, finish
it, and restart AI-dev from a clean build.** Do not "work around" an incomplete port
in the AI — you will be measuring the wrong game.

## Setup choices get three looks — this runbook owns the third

A setup choice gets looked at once in each of three runbooks, and the third look is
the one that keeps getting lost:

| Question | Runbook | What it asks | Hook |
|---|---|---|---|
| Does the player choose it? | post-port | does the **human** own it (never auto-picked)? | `getSetupChecklist` / `@zekel/game-kit` `setupChoices.ts` |
| Is it measured? | balance | is it **varied** in a balance run (no axis left at default)? | `getBalanceAxes` |
| **Does the AI choose it well?** | **this one** | does the **AI** pick it *strategically*, not randomly? | `parseStrategy` + an AI setup-choice policy |

Many setup choices are *strategic* — a faction, a loadout draft, a starting
leader, where to place obstacles. When the harness picks them at random and the AI
plays them without regard to its pick, every downstream balance number on that
choice is noise. The clearest case so far: in Frogs with Shotguns, obstacle
placement was declared as a balance axis with no way for the harness to vary it,
the setup picked it at random, and the AI ignored it. **This runbook owns making the
AI seat actually decide its strategic setup picks** (§6).

---

## The deliverable

One committed, per-game artifact: **`packages/<game>/AI-NOTES.md`**, next to the
code (alongside `PORT-NOTES.md` / `POST-PORT.md`). It records the tier meanings,
the strategy archetypes and how they were derived, the dead-turn definition, the
AI's setup-choice and in-game-choice policies, and the **balance-ready
checklist**. The template is at the end of this runbook.

---

## Build first, every time

The harness drives the **compiled** server (`dist/`). Rebuild before every run, or
the AI you measure is stale code.

```
pnpm build
```

The commands in this runbook are written as zekel-games runs them (`pnpm harness`
is its script for the `@zekel/dev` `ai-harness` command). Another project wires the
same commands up as the `@zekel/dev` README shows, and runs them under whatever
script names it chooses.

---

## Standing instruction — build what's missing

Like the balance runbook, **this gate will require building, not just measuring.**
This is the AI *development* phase — its whole point is to close gaps, so a missing
capability is a **build target, not an excuse to skip a step**. When a step needs
something the AI surface lacks, build it:

- No genuinely strong tier? → wire the MCTS hooks (§3), or tune a `hard` heuristic
  and prove it (§1). Don't ship two tiers and call `hard` "not applicable."
- No strategies? → derive archetypes and build the `parseStrategy` lever (§4).
  Don't fall back to "the metagame view isn't supported."
- MCTS too slow to run a batch? → build the pruning (§3), don't drop to a weaker
  tier and footnote it.
- A choice point with no AI policy, a never-used mechanic, a setup pick the AI
  makes without thinking? → fix the AI (§6–§9).

**Build generically.** New mechanisms belong in shared code — the search in
`@zekel/game-kit` (`mcts.ts`), the analysis in `@zekel/dev` (`harness/analysis.ts`)
— so every game gains them at once, never as a one-off branch in one game's
`ai.ts`. If you don't maintain those packages, propose the change to them; keep any
stop-gap inside your game's own dev hooks, not in a fork of the tools. The honest
move is to close the gap; record what you built (and any gap you couldn't yet
close, as an explicit AI gap) in the artifact.

---

## The process

### 1. The tier ladder — easy / medium / hard

Every game must expose three difficulty tiers through `getAIMove(state, playerId,
difficulty?, strategy?)` (the `Game` interface in `@zekel/game-kit` `game.ts`),
mapping cleanly onto the balance runbook's **skill axis**:

- **`easy` = uniform-random** over the legal set. A *true* floor — not a weaker
  heuristic. The balance skill-floor read ("how well does a random player do vs a
  strong one?") depends on `easy` being genuinely random. Implement it by indexing
  the legal moves with the **seeded** rng (§8), never `Math.random`. Sweetlands
  Imperium's `ai.ts` (`randomMove`) is an example.
- **`medium` = the authored/ported heuristic.** For a port, the faithful
  one-move-at-a-time port of the original AI (see "Porting from an existing
  version" in [`building-a-game.md`](./building-a-game.md)), locked by tests that
  check it ranks moves the same way the original does. This is the default tier and
  the default rollout policy.
- **`hard` = verified-strong.** Either a tuned heuristic variant *proven* to
  out-play `medium`, or the generic **`mcts`** tier (§3). `mcts` is the
  guaranteed-strong anchor in every game; a hand-tuned `hard` is only "strong" once
  the check below confirms it.

**Check that each stronger tier really wins (do this before handing to balance).**
Run a quick head-to-head batch at each neighbouring pair and confirm the stronger
tier wins:

```
pnpm harness -- --game=<id> --n=200 --players=2 --difficulty=easy,medium --no-game-files --quiet
pnpm harness -- --game=<id> --n=200 --players=2 --difficulty=medium,hard  --no-game-files --quiet
```

`medium` must beat `easy`, and `hard` must beat `medium`, with the win-rate
confidence interval excluding 50%. If `hard` does not out-play `medium`, the tier is
**mislabeled** — either fix it or anchor `hard` to `mcts` — because the balance
runbook builds its entire "good play" read on that label. Record the result in the
artifact.

### 2. Define the evaluation function once

Three consumers want the same "who is ahead" number: the heuristic's own scoring,
the MCTS leaf evaluation (`getHeuristicValue`), and the balance runbook's §4 timing
metrics (`leaderScalar`, in the game's dev hooks). Define it **once** and reuse it,
so they cannot drift. It should return the same quantity `result.scores` ranks on
(Fractured Fist: relative stamina; a points game: victory points). `leaderScalar`
reads the public `getScoreboard` row; `getHeuristicValue` reads the full state —
keep them numerically consistent. Warble Way Galaxy's dev hooks show the pattern:
its `leaderScalar` mirrors the AI's own progress score, with a comment saying to
keep the two in step.

### 3. The generic strong tier = MCTS hooks

When a game lacks a hand-tuned strong heuristic, `hard`/`mcts` comes from wiring
the generic search (`@zekel/game-kit` `mcts.ts`) via the `Game` hooks:

- `getRewardForPlayer` — end-of-game payoff (win=1, loss=0, draw=0.5; split for ties).
- `selectRolloutMove` — the rollout policy; **reuse `medium`** as a strong default.
- `getHeuristicValue` — the leaf score when a rollout is cut short (§2).
- `getSearchMoves` — a curated subset of `getLegalMoves` (see pruning below).
- `determinize` *(only with hidden info)* — fill in the hidden zones by sampling
  from what could be there. Omit when the AI-vs-AI setup has no hidden information
  (Fractured Fist tracks both decks in AI-vs-AI play, so its search over the
  public view is correct without it — `mctsHooks.ts` says why). Cybernoir 2127 and
  Adventurer Olympics wire `determinize` for real hidden information.

Fractured Fist (`index.ts` + `mctsHooks.ts`) is a small, complete example of the
first three hooks.

#### Pruning is mandatory, not optional (MCTS is slow)

**MCTS is the slowest thing in a batch by far**, and a batch is 100s–1000s of
games — an un-pruned search makes an `mcts` (or `mcts`-anchored `hard`) batch
infeasible, which is how a game silently loses its strong tier. **Every game that
relies on MCTS must make a real attempt to prune** — the goal is the same search
quality at a fraction of the work. Build whichever apply (per the standing
instruction, generically in `mcts.ts` where possible):

- **Curate the move set (`getSearchMoves`).** This is the first and biggest lever.
  Drop moves that are never right and moves that change nothing (never-correct buys,
  redundant passes, cost-0 filler), and **merge repeated moves that differ only by a
  number** — don't branch on `manufacture 1..N` as N separate children when one
  representative (or a rough 2–3 bucket) suffices. The number of choices per move
  drives the cost faster than linearly. Cybernoir 2127 and Adventurer Olympics both
  supply a `getSearchMoves`.
- **Cap the rollout depth** (`max_rollout_plies` in the search options) —
  required for games whose `applyMove` copies a growing game log, or rollouts pay
  a cost that grows with the square of their length. Score the leaf with
  `getHeuristicValue` (§2) instead of playing to the end. Cybernoir 2127,
  Adventurer Olympics and Neither Guts nor Gears all set a cap.
- **Tune the per-move budget** (`MCTS_BUDGET_MS`, default about 1000ms) so a batch
  is feasible; the harness can lower it for scale (`--mcts-budget-ms`).
- **Prefer the heuristic over MCTS wherever it matches** — keep per-move cost down
  by only searching states where search actually changes the decision.
- Consider **progressive widening / first-play urgency** (ways to try only a few
  children of a node at first) when there are still many choices per move after
  curation.

Record the pruning you applied, the resulting per-move cost, and whether an `mcts`
batch is feasible, in the artifact. If after pruning MCTS still can't run at batch
scale, that's an explicit AI gap — say so; don't let `hard` quietly become
`medium`.

### 4. Strategy — how to derive the archetypes

Strategy is the balance runbook's §0 axis (independent of skill): *which* objective
the AI pursues. The first pass is built here. Don't invent archetypes from
intuition — **derive them from the game's structure**:

1. **List the distinct paths to victory** — the scoring tracks, win conditions,
   and the `identity`/`config` balance axes. Each *distinct* path is a candidate
   archetype. (Fractured Fist's four factions, a 4X game's
   military/economic/tech tracks — the game usually names them for you.)
2. **Merge paths that play the same way** and split a single named identity if it
   supports two real lines.
3. **Express each as a behavioral lever** in the heuristic: a bonus toward the
   moves/cards that advance that path. **Key the lever on the EFFECT, not the
   label**, so neutral pieces that fit the style count too (this is the subtle,
   load-bearing part — see the Fractured Fist example).
4. **Wire `parseStrategy(s)`** in `ai.ts`: map free-form names (+ aliases) → an
   archetype; **`undefined` ⇒ the adaptive default** so existing batches are
   unchanged. The harness passes each seat's `--strategy` as `getAIMove`'s 4th
   argument and tags the seat with it, so balance's matchup matrix + `strategy:<x>`
   lift rows come for free once the lever exists.

**Worked example — Fractured Fist** (`packages/fractured-fist/src/ai.ts`). The four
factions *are* the archetypes, each a fighting style with a signature effect:
Titan = `damage`, The Awakened = `heal`/`spirit`/economy, Masters' Circle =
`defense`, Uncounted = `add_misstep`. `parseStrategy` maps `"titan"|"burst" → TITAN`,
etc. (`ai.ts:20`). The lever is two bonuses — a buy bonus (`FACTION_BUY_BONUS = 60`)
and a play tiebreak (`FACTION_PLAY_BONUS = 3`) — applied when a card
`fitsFactionStyle` (`ai.ts:41`). The load-bearing subtlety: `fitsFactionStyle` keys
on the **effect**, so Uncounted leans on the *neutral* Distract/Smoke Bomb (both
`add_misstep`), not only its faction-tagged cards. Two seats drafting the same
shared supply build different decks. `undefined` ⇒ the adaptive ramp heuristic, no
lean. Its dev hooks (`packages/fractured-fist/src/dev/index.ts`) add a
`strategyDraft` so a `--strategy` batch also co-drafts a faction-themed card pool.

### 5. Dead turn (and what counts as a real turn)

Define `isDeadTurn(moves)` in the `analysis` part of the game's dev hooks
(`packages/<game>/src/dev/index.ts`, registered with `@zekel/dev`). The generic rule
(0 `play_card` AND 0 `buy_card`) is a baseline; **most games need their own rule**,
because "a card was played" is too lenient — a setup or do-nothing move hides a
wasted turn. Decide what *board progress* means for this game and test for it.

- **Worked example — Fractured Fist** (`packages/fractured-fist/src/dev/index.ts`).
  Playing a Focus for spirit counts as a `play_card`, so a misstep-clogged turn that
  only managed a Focus/refine/reload read as "live" — the harness reported a bogus
  0% dead-turn rate. The faithful definition: a dead turn made **no board progress**
  — queued no impactful technique (damage/defense/misstep) AND bought no card.
  Resources, refines, focus-reloads, advance and end are all setup or no-ops.
- A non-card game **must** supply its own rule or every turn reads dead. Cybernoir
  2127 and Adventurer Olympics each list their "progress" moves.
- Also define `isRealTurn(moves)` to **drop** stretches of the move stream that
  aren't real turns (forced reactions during someone else's turn, setup reports,
  simultaneous-commit phases) — without it they inflate game length and skew the
  dead-turn rate. Cybernoir 2127, Adventurer Olympics and Neither Guts nor Gears
  all do this.

### 6. Strategic setup choices need an AI policy

For every setup choice on a strategic axis (`getBalanceAxes` `identity`/`config`/
`scenario`), the **AI seat must choose tactically**, not by seat index or random
draw. Two cases:

- The choice has a `parseStrategy` lever (§4) → the AI's archetype *is* the
  identity pick; assigning the strategy assigns the choice coherently.
- The choice has **no lever yet** (the Frogs with Shotguns obstacle placement case
  above) → declare the axis with `levers: []` so it's tracked, AND note in the
  artifact that the AI plays it without regard to its pick. Closing it later needs
  **both** a way for the harness to vary it AND an AI that plays it — flag it as an
  explicit AI gap, don't let it read as "covered."

The test: when the harness varies this axis, does the AI's *play* respond to its
own pick, or is the pick decoration to the AI? Record each strategic setup choice
and the AI's policy for it.

### 7. The AI needs a policy for every in-game choice point

This is the AI's view of the **shared choice catalog** post-port built (§6 there):
the one table listing every decision the rules give a player. Every such choice —
target, discard, ordering, split, reward pick, optional bonus — the AI brain must
resolve (`describeNextStep` returns `null` for a choice an AI seat owns; the AI
resolves its own pending choices through `get_ai_move`). A choice point with no AI
policy means the AI crashes or picks badly every time. **Fill the catalog's "AI
policy" column** for §6's setup rows and every in-game row — annotate that one
table, don't restate it — and record any that fall back to a trivial default.

### 8. AI determinism (load-bearing)

**Grep `ai.ts` (and `mctsHooks.ts` and any rollout policy) for `Math.random` and
route every roll through the seeded rng.** A single stray `Math.random` (a) makes the
desync harness's two side-by-side sessions drift apart — a fake desync no assistant
mistake explains — and (b) makes balance batches impossible to reproduce. The seeded
path also backs `easy` (§1). Note even fallback `Math.random` calls in a `catch` —
they are determinism bugs waiting to fire; use the seeded rng there too. Lock with a
determinism test: two playouts from the same seed produce the identical move
sequence, and different seeds differ. Sweetlands Imperium, Adventurer Olympics and
Neither Guts nor Gears each have one (`src/__tests__/aiDeterminism.test.ts`); Warble
Way Galaxy's `aiTiers.test.ts` checks tiers and strategies the same way.

### 9. The AI must USE every mechanic (the honesty bridge to balance)

The AI-quality bar is not "doesn't crash" — it is "**exercises every action, card,
and ability**." Run a batch and read the action counts + the "rarely-used" list:

```
pnpm harness -- --game=<id> --n=200 --players=2 --difficulty=medium --no-game-files --quiet
```

Any mechanic the AI **never** plays is an AI gap, not a balance finding — fix the
heuristic (or the engine, if the mechanic can't be reached — see "What fully playable
means" in [`building-a-game.md`](./building-a-game.md)), then re-run. The loop is real
and has teeth: in Dragonwood, one card the AI never played went from 0% to 30% use
after a heuristic fix. A balance verdict on an unused mechanic is premature, so this
check **must pass before handing to balance**: hand balance an AI whose spread of
actions covers the game.

### 10. Performance budget

Balance runs 100s–1000s of games with **no language-model AI** (too slow and
expensive). The `medium` heuristic must be fast (synchronous, cheap per move); tune
the MCTS budget so an `mcts` batch is feasible; prefer the heuristic over MCTS where
it matches. Record the approximate per-move cost / state copies per second in the
artifact.

---

## What balance needs from this gate (the balance-ready checklist)

Balance can produce honest numbers only when these are present and real. This is
the gate's finish condition:

- [ ] **ENTRY CHECK (verify FIRST): post-port is GREEN / the port is COMPLETE** — every
      rule implemented, the scoring is final (no placeholders), every ability fires
      (the "not-yet-automated" set is empty). If not, STOP and finish the port; an AI
      built against an incomplete port measures the wrong game (see the ⛔
      precondition above).
- [ ] **Three tiers, each stronger than the last** — `easy`=random,
      `medium`=heuristic, `hard`/`mcts` checked to beat `medium` (§1).
- [ ] **`parseStrategy`** wired with archetypes derived from the paths to victory
      (§4); `undefined` = adaptive default.
- [ ] **`isDeadTurn`** (and `isRealTurn` where needed) defined to mean real board
      progress (§5).
- [ ] **`leaderScalar`** + `getScoreboard` so balance's §4 timing metrics work
      (§2), consistent with `getHeuristicValue`.
- [ ] **Every strategic setup choice has an AI policy** (§6); axes with no lever
      flagged as AI gaps.
- [ ] **Every in-game choice point has an AI policy** (§7).
- [ ] **No `Math.random` in the AI**; seeded; determinism test passing (§8).
- [ ] **The AI's actions cover the game** — no never-used mechanic (§9).
- [ ] **MCTS hooks** wired if `hard` relies on `mcts` (§3), **pruned** (curated
      `getSearchMoves`, merged number-only variants, rollout-depth cap) so an
      `mcts` batch is actually feasible — not silently downgraded to `medium`.
- [ ] Deliverable `packages/<game>/AI-NOTES.md` committed, and the game's row in
      your project's status table updated (zekel-games keeps one in `GAMES.md`).

---

## Deliverable template

`packages/<game>/AI-NOTES.md` uses these sections:

```
# AI notes — <Game>

1.  Tier ladder (easy/medium/hard[/mcts]) — what each does + the stronger-tier-wins check
2.  Evaluation function (the one "who's ahead" number, its three consumers)
3.  MCTS hooks (which are wired; why determinize is/ isn't needed; pruning)
4.  Strategy archetypes — derivation from the paths to victory + the parseStrategy lever
5.  Dead turn + real-turn definition (and why the generic rule is wrong here)
6.  Strategic setup choices → AI policy (per axis; axes with no lever flagged)
7.  In-game choice points → AI policy (mirror of POST-PORT §7)
8.  Determinism (seeded rng; Math.random audit; determinism test)
9.  Mechanic coverage (spread of actions; any never-used mechanic = open AI gap)
10. Performance (per-move cost; MCTS budget/cap)
11. Balance-ready checklist (what balance needs from this gate)
12. Sign-off (date, tier-check result, links to harness output)
```
