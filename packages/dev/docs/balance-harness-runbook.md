# Evaluating a Game with the AI Harness

A repeatable runbook for using the AI-vs-AI harness as a **balance + AI-quality
analysis tool** for any registered game. It is the working companion to
[`balance-metric-definitions.md`](./balance-metric-definitions.md) — that file
defines *what* each metric means and why; this file is *how* to produce and read
it with the harness. Read the definitions doc first; the section numbers below
(§0–§6) point back into it.

It needs the [AI-development runbook](./ai-development-runbook.md) done first: an AI
with real skill tiers, strategies and a dead-turn rule. Without that, balance can't
tell a weak mechanic from an AI that never uses it.

The same commands and output tables work for every registered game. What is
special about one game lives in that game's **dev hooks** (`GameDevHooks` from
`@zekel/dev`; zekel-games keeps each game's in `packages/<game>/src/dev/index.ts`):
`metrics` (extra per-seat, per-game counters), `analysis` (how to split the move
stream into turns, the dead-turn rule, extra lift features and identity features),
`sweeps`, a `strategyDraft` and `featureRows`. The tools themselves hold no
per-game lists. Fractured Fist's dev hooks
(`packages/fractured-fist/src/dev/index.ts`) are a complete small example.

> **What the harness computes today is marked inline.** The metric model is richer
> than the harness currently computes. Each metric below is tagged **[live]** (the
> harness prints it today), **[proxy]** (approximated another way — usually an
> option sweep), or **[planned]** (defined in the model, not yet built). Don't
> report a **[planned]** number as if the harness produced it.

> **Standing instruction — if the harness doesn't support a feature, BUILD IT.**
> A **[proxy]** or **[planned]** tag is a *build target*, not a permanent excuse to
> skip the metric or report a weaker stand-in. When a run genuinely needs a metric
> the harness lacks (a matchup matrix, confidence intervals, a margin histogram,
> the strategy axis), implement it generically in `@zekel/dev`'s
> `harness/analysis.ts` over `GameRecord` so every game gains it at once — then run
> with it. (If you don't maintain `@zekel/dev`, propose the change there; don't fork
> the tool.) **This applies equally to AI strategies:** if evaluating a game requires
> strategy agents (`aggro`, `control`, `economy`, …) that don't exist yet, *build the
> strategies* — add them to the game's `ai.ts` and tag each seat with the one it
> played (§0) — rather than declaring the strategy axis "not supported" and moving
> on. The honest move is to close the gap, not to footnote it. The per-metric tags
> below tell you which gaps exist; closing the one your run needs is part of the run.

The commands below are written as zekel-games runs them (`pnpm harness` is its
script for the `@zekel/dev` `ai-harness` command; `pnpm balance-dashboard` for
`balance-dashboard`). Another project wires the same commands up as the
`@zekel/dev` README shows.

---

## 0. The two axes — tag every seat with both (§0)

Every number the harness produces is conditional on *who played the games*. Two
independent axes describe those agents; keep them separate in every run label and
every findings caption.

- **Skill** — how well a fixed objective is pursued. **[live]** This is the
  harness `--difficulty` flag (`random`, `easy`, `medium`, `hard`, `mcts`). Map the
  tiers onto the model's `random → weak → medium → strong` ladder with one fixed
  point and three per-game ones:
  - **`mcts` → strong, always.** MCTS is a search agent that works for any game, so
    it is the *guaranteed* strong tier in every game — use it as the strong end of
    the skill sweep and as the reference "good play" opponent whenever a game has it.
  - **`easy` / `medium` / `hard` are per-game heuristics**, and their *actual*
    strength is whatever that game's `ai.ts` implements — **do not assume `hard` ==
    strong.** A game's `hard` heuristic may be weaker than its `mcts`, and one
    game's `medium` may out-play another's `hard`. Read `ai.ts` and place each tier
    on the ladder per game (`easy` is the floor — often but not always random; see
    the per-game note below). If a game lacks a genuinely strong heuristic tier,
    use `mcts` for the strong end (and per the standing instruction, build a
    stronger heuristic if you need one without MCTS's per-move cost).

  Holding strategy fixed and sweeping skill answers **"is it fair under good
  play?"** — anchor "good play" on `mcts` unless a game's `hard` is verified to
  match it.
- **Strategy** — *which* objective is pursued (`aggro`, `control`, `economy`,
  `wide`, `tall`, …). **[live, opt-in — a full per-seat axis.]** Pass
  **`--strategy`** (a single value goes to every seat; a comma list assigns one per
  seat, e.g. `--strategy=aggro,control`). It's passed to the game's `getAIMove` as a
  4th argument and stored on each seat, so the analysis prints a **strategy matchup
  matrix** (the metagame view) and a `strategy:<x>` lift row automatically. The
  plumbing is generic, but each game must **implement the strategies** in its
  `ai.ts` (`parseStrategy` → a behavioral lever); a game that doesn't recognize a
  value falls back to adaptive play. **Fractured Fist is the example**: its
  strategies are its four **factions** (fighting styles) — `titan` (burst damage),
  `awakened` (sustain), `masters` (defense), `uncounted` (misstep disruption) —
  each expressed as an own-style buy/play bonus (`fitsFactionStyle` +
  `FACTION_BUY_BONUS` in `packages/fractured-fist/src/ai.ts`), keyed on the card
  EFFECT so neutral cards that fit the style count too. For a game with no
  strategies yet, the standing instruction applies — **build them** (see below),
  don't fall back to a stand-in. Two older approximations remain useful where
  strategies aren't built yet: a lift feature naming a goal the player declared
  during play (via `extraFeatures`), and option sweeps (`--sweep=<name>`) that vary
  the setup as a stand-in for "line".

**The data-model rule from §0 still binds:** both axes are tagged per seat at
simulation time and **stored on the record** (`difficulty` and `strategy`) — they
cannot be recovered after the fact. The strategy tag flows automatically into both
the lift table and the matchup matrix.

**Building strategies for a new game** (the §0 "build the strategies"
instruction): add a `parseStrategy(s)` to the game's `ai.ts` mapping names →
archetypes, feed the archetype into the heuristic's load-bearing lever (Fractured
Fist: the faction-style buy/play bonus), and keep `undefined` = the current adaptive
default so existing batches are unchanged. The harness/analysis side is already
generic — no new wiring once `getAIMove` honors the strategy. (How to derive the
archetypes: [AI-development runbook](./ai-development-runbook.md) §4.)

**Default reporting tier (§0).** Headline numbers are reported at `skill=medium`
with whatever strategy mix the run actually used — state it. Never report an
aggregate without naming both axes (§6.4).

---

## 0.5 List the game's DIMENSIONS first (do this before any run)

Skill and the identity/config/scenario axes (§0, `getBalanceAxes`) are not the only
ways a game's outcomes can vary that a balance pass must walk. **Before running,
list every way the game's outcomes can vary, and make sure each is both
*exercised* and *measured*.** For most games:

1. **Skill** — the difficulty ladder (§0).
2. **Identity / config / scenario** — every `getBalanceAxes` entry (faction, loadout,
   map…); vary via `--difficulty`/`--strategy`/`--sweep`/`--players`.
3. **Objectives / scoring lines — the most-missed one.** A game won by completing
   objectives (a points race, a set of win conditions, several scoring tracks) has a
   separate dimension *per objective*: **which objectives can be achieved, how often
   each is achieved, and which ones actually win.** List the win conditions and how
   they ADD UP to the win threshold (e.g. "5 points = a 3-point public objective + a
   2-point secret one; secrets alone cap at 4, so every win needs a public one"),
   then **count how often each objective is achieved** (below). This matters because
   two builds with identical faction win rates can have wildly different *objective*
   health — half the win conditions never met, one objective present in every win.

**Count objective achievement** by emitting each SCORED objective as a
`playerFeatures` lift feature (`obj_pub:<id>` / `obj_secret:<id>`), showing scored
objectives in the game-over view only (so nothing leaks mid-game). The lift table
then reports, per objective: **Usage = how often it was achieved** and **lift = how
strongly achieving it goes with winning**.

Read it like the mechanic-coverage check (AI-development §9): **an objective achieved
0% of the time (or never listed) is either impossible OR an AI gap — and a balance
verdict on objectives is premature until the AI actually attempts every objective**
(just as an unused *mechanic* blocks a verdict on it). A win condition no agent ever
meets looks exactly like an impossible one until an agent tries. Example:
Sweetlands Imperium's dev hooks (`packages/sweetlands-imperium/src/dev/index.ts`,
`playerFeatures`) emit `faction:` + `obj_pub:`/`obj_secret:` features, so a balance
pass on it can report the per-objective table and flag never-achieved objectives as
AI gaps.

---

## Build first, every time

The harness drives the **compiled server** (`dist/`), so stale code gives stale
answers. This is the single most common way a run lies.

```
pnpm build
```

---

## The runs

### Run A — balance batch (self-play, equal skill, at scale)

Every seat plays the SAME good difficulty so component value reflects the *game*,
not a skill gap. This is the base for the §2 outcome metrics and the §3
component metrics. Scale to 100s–1000s of games; seeds vary per game.

```
pnpm build && pnpm harness -- --game=<id> --n=1000 --players=<counts> \
  --difficulty=medium --no-game-files --quiet --seed=1 --parallel=4 [--sweep=<name>]
```

- `--parallel=K` runs games across K server processes. Safe for heuristic
  batches: every per-game setting comes purely from (seed, game number), so the
  outputs are **byte-identical** to a sequential run (checked). Keep
  `--parallel=1` for reproducible **mcts** batches — the MCTS budget is clock
  time, so competition for the CPU changes how deep it searches and therefore its
  moves (the harness prints a warning when you combine them).
- `--players=2,3,4` runs each count as a separate scenario. Per-identity / seat
  balance needs the count where ALL identities appear (e.g. 4-player for a
  4-faction game).
- `--no-game-files` is essential at scale (else one JSON file per game).
- `--quiet` suppresses per-game progress lines.
- Seeds vary per game (`seed + index`) → decks/dice/turn order are **randomized but
  reproducible**. (Single-seed determinism is for parity tests, not balance.)
- `--sweep=<name>` covers the whole option/strategy space instead of one default
  setup. The names come from the game's dev hooks (`sweeps`): for example
  `loadout` (Fractured Fist's card pool), `faction` (Sweetlands Imperium, Neither
  Guts nor Gears), `hideout` (Cybernoir 2127). Omit if the game has none.
- `--game-options='<json>'` merges a fixed option into every game's
  `createSession`, to pin one setting without writing a sweep.
- Seat rotation is always on — each AI plays each seat equally, so win rates and
  the seat table are free of seat-position bias.

### Run B — skill sweep / skill floor (§6.1, head-to-head)

The **skill sweep** is the §6.1 instrument for *"fair under good play?"*: hold
strategy fixed, vary skill, watch the metric move. Run the same matchup at each
neighbouring tier and compare; imbalances and matchup spreads usually **widen** with
skill, so a low-skill-only read understates them (§2.2).

```
pnpm harness -- --game=<id> --n=400 --players=2 --difficulty=easy,medium --no-game-files --quiet
pnpm harness -- --game=<id> --n=400 --players=2 --difficulty=medium,mcts --no-game-files --quiet
pnpm harness -- --game=<id> --n=400 --players=2 --difficulty=easy,mcts   --no-game-files --quiet
```

Anchor the strong end on **`mcts`** (the guaranteed-strong tier, §0) unless the
game's `hard` heuristic is verified to match it — then `hard` is a cheaper strong
anchor. `--difficulty` assigns one tier per seat; seats rotate and metrics are
keyed by `player_id`, so `ai1`'s win rate cleanly measures its tier. The weakest
seat is the **skill floor**: how well does a weak/random player do against a
strong one? `--mcts-budget-ms` lowers the per-move search time if an `mcts` batch is
too slow.
**Check what `easy` MEANS for this game first** (read `ai.ts`): in some games it's
uniform-random (a true floor), in others a weaker heuristic. If there's no random
tier and you need a true random baseline, use `--difficulty=random` if the game
honors it, treat `easy` as "weakest available" and say so, or add a random tier to
the game's AI.

### Run C — strategy sweep (§6.1) — **[live]** for games with built strategies

The §6.1 counterpart of the skill sweep — hold skill fixed, vary *strategy*, to
answer *"is the metagame interesting / does one line dominate?"* Fix
`--difficulty=medium` and assign distinct strategies per seat:

```
pnpm harness -- --game=fractured-fist --n=400 --players=2 --difficulty=medium \
  --strategy=titan,awakened --no-game-files --quiet --sweep=loadout
```

Seats rotate (strategy travels with the seat), so the **strategy matchup matrix**
reads cleanly: `matchup(titan, awakened)` is the metagame headline. A row that beats
every column is a strategic-diversity problem even if every faction win rate is
50%. A settable / re-weightable strategy *prior* (to model an expected metagame
mix) is **[planned]** — for now the mix is whatever `--strategy` assigns.

---

## Metric families — how to produce and read each

The harness prints, per scenario: a **Game length & dead turns** block, the **Game
length** and **Margin of victory** distribution sections (§5), a **Win rate by
seat** table (with 95% CIs), a **usage → win-rate lift** table (CIs + ✓
significance, with a "rarely-used" list), and one **Matchup matrix** per
identity/skill dimension (§2.2). The per-seat **Outcomes** / **Feature-engagement**
tables come from `harness/metrics.ts` plus the game's `metrics` hook. Map them to
the model as follows.

### §2 Outcome metrics — "is it balanced?"

| Metric (def) | Status | Where / how |
|---|---|---|
| §2.1 Win rate | **[live]** | Outcomes table, per seat/identity. **Draws counted explicitly** as a third outcome — `Tie rate`, never silently split into the win rates. |
| §2.1 Win rate sliced by **both** axes | **[live, opt-in]** | Skill slice via `--difficulty` (Run B); strategy slice via `--strategy` (the `strategy:<x>` lift row = its win rate vs the field). Both tagged per seat. A single combined `win_rate(faction \| skill, strategy)` view is **[planned]**, but each axis slices on its own today. |
| §2.2 Matchup win rate (faction-vs-faction heatmap) | **[live]** | One matchup matrix per identity/strategy **dimension** the game's `playerFeatures` emits (`faction`, `role`, …) plus a `difficulty` (skill-vs-skill) matrix in Run B. Each cell = the row category's win rate vs the column category, with N and a ±95% Wilson half-width; thin cells (N < the minimum sample) are greyed. For 2-player batches each cell is the exact `matchup(A,B)`. `harness/analysis.ts` `computeMatchups`. |
| §2.2 Strategy matchup matrix (metagame view) | **[live]** for games with built strategies | Run with `--strategy=a,b` (or a **pool** — see below) → the `strategy` matchup matrix. Example: Fractured Fist's 4 factions (`titan`, `awakened`, `masters`, `uncounted`). Games without built strategies print no such matrix. |
| **§0 "Does the game have a meta?"** (strategy diversity) | **[live]** | Below each strategy matchup matrix (≥3 categories), a **Meta** block: the **Nash equilibrium** of the matrix (the viable set + expected field), a **Condorcet** dominant-strategy check (head-to-head, robust to ties), and the **Hodge** split into ladder-like vs rock-paper-scissors-like structure + one example cycle. `harness/analysis.ts` → `harness/meta.ts` `computeMeta`. See the section below. |
| §2.3 Seat advantage (first-player) | **[live]** | "Win rate by seat" table; seat 0 = goes first. A few points ≈ no advantage. **Report it at each skill tier** (§2.3) — re-read the seat table across Run B's tiers; first-player advantage often grows with skill. |

**Confidence intervals (§6.2) are [live].** Every win rate the harness prints
carries a **95% Wilson interval**, and every lift row carries a **95% Newcombe
interval on the difference** with a **✓** marker when that interval excludes 0
(significant). The seat table shows the CI directly; the lift table shows `WR
±95%`, the lift CI bounds, and the ✓. Read them per §6.2: a seat advantage is real
only if its CI excludes 50%; a lift is real only if it's marked ✓ — an unmarked
row is sampling noise, do not act on it. Matchup cells show a ±95% half-width and
grey out below the sample floor. The §5 distribution **medians** carry a **95%
bootstrap CI** (`bootstrapMedianCI`, 1000 resamples, seeded so it's reproducible),
and the §5 nail-biter/rout shares carry Wilson CIs. (`@zekel/dev` `harness/stats.ts`:
`wilsonInterval`, `newcombeDiffInterval`, `bootstrapMedianCI`, `intervalsSeparate`
for the build-vs-build test.) The remaining CI gap is intervals on the §4
lead-stability **means/counts** — **[planned]**.

### §0 Does the game have a meta? (strategy diversity) — **[live]**

The deepest balance question: can several playstyles win, or does one dominate?
It's about the *shape* of the strategy space, not any single number — so it reads
the whole **strategy matchup matrix** at once. Three measures, printed as a
**Meta** block under each strategy/identity matrix with ≥3 categories
(`harness/meta.ts` `computeMeta`):

- **Dominant strategy? (Condorcet)** — does one strategy beat *every* other
  **head-to-head** (it wins the pairing more often — *not* an absolute >50%, which
  ties would defeat)? A dominant strategy means **no meta — just play it.** This is
  the meta-killer and the headline.
- **Viable set (Nash equilibrium)** — the matrix is solved as a **symmetric
  zero-sum game** (multiplicative weights, deterministic); the strategies the
  equilibrium actually uses are the viable set, and their weights are the "expected
  field." Only one strategy used ⇒ degenerate (one dominant); two or more with real
  weight ⇒ a genuine meta. Strategies that lose every matchup are flagged **dead**.
  This is a principled definition of "viable" that works the same way for any game.
- **Ladder vs rock-paper-scissors (Hodge)** — the matrix splits into a ranking part
  (a power ranking) and a cyclic part (counterplay). Highly cyclic = a
  rock-paper-scissors meta (a strong, *not required*, sign of health); a pure
  ranking = a tier list. An example cycle is named when one exists.

**To run it:** fill the *whole* matchup matrix in one batch with **strategy-pool
mode** — pass MORE strategies than seats and the harness picks a random pairing per
game (`--strategy=titan,awakened,masters,uncounted` with 2 seats → all 6 pairings).
The meta block then reads a complete matrix. Check it at **≥2 skill tiers** (a meta
can collapse under stronger play) and **several seeds** (matchup cells run thin
fast — ±10 points at about 100 games per cell). A dominant strategy at scale and at
high skill is a real balance problem; report it with the §6.4 caption.

### §1 + §3 Component metrics — "what's driving it?"

The lift table is the harness's §3 engine. Read §1 (present/acquired/played) and
§3.1's causation caveat *before trusting a number*.

- **§1 present / acquired / played.** The harness lift feature is counted at the
  **played/activated** stage (`play:<card>`, `buy:<card>`, `action:<type>`, plus the
  game's `extraFeatures`) — the furthest-along, most causal stage, which is the §1
  rule of thumb. **[live]** The **acquired** vs **played** split (§1, §3.3) is
  **[partial]**: `buy:` captures acquisition for games where you buy cards, but a
  generic drawn-but-not-played counter is **[planned]**. Where you have both, report
  both — the gap is the dead-card signal.
- **§3.1 Win-rate lift.** **[live]**, and already the **stronger played-vs-available
  form** (`lift_pva`): `lift = WR(used | available) − WR(available, not used)`.
  The availability check (`availableCards` in `analysis.ts`) is exactly the §3.1
  "condition on availability" control. It is **association, not causation** —
  repeat the §3.1 caveat word for word: *lift flags association, not proof; confirm
  with a targeted holdout.*
- **§3.2 Play frequency.** **[live]** — the `Usage` column. **Never read lift
  without it** (§3.2): +25 points at 2% usage is a curiosity; +15 points at 60% usage
  is a crisis. The danger zone is high usage / high lift. (A frequency-vs-lift
  scatter plot is the §3.2 ideal; the table carries both columns so you can eyeball
  it.)
- **§3.3 Acquire-to-play ratio (finds dead components).** **[live]** for games
  with `buy_card` — the "Acquire-to-play ratio" table reports `plays ÷
  acquisitions` per bought card (≈0 = bought but left unplayed = a dead purchase;
  ≥1 = reused). Complements the lift table: a card with strong lift *when played*
  but a low ratio is powerful but situational, not simply strong. The "rarely-used
  available cards" list remains as the never-bought companion signal.
- **§3.5 Combo synergy (pairs worth more than their parts).** **[live]** — the
  "Combo synergy" section reports pairs of components whose combined win rate
  significantly exceeds what each part predicts alone (the 2×2 interaction contrast
  `WR(both) − WR(A only) − WR(B only) + WR(neither)`, significant positive pairs
  only, every cell gated on sample size, buy/play of the same card excluded because
  one implies the other, and `WR(both) > WR(neither)` required — two individually
  awful components whose badness fails to stack are "less bad together", not a
  broken combo). An empty section is a *finding*: no pair beats the sum of its
  parts. A confirmed combo is the strongest §6.3 holdout candidate — disable one
  half and re-run.
- **§3.4 Strategy-conditional lift `lift(X | strategy=S)`.** **[planned]** as a
  built-in breakdown — but the per-seat `strategy` tag exists, so you can get it
  today by running one `--strategy=S` batch per strategy and comparing the lift
  tables. This is where the strategy axis earns its keep: a component at `lift ≈ 0`
  overall can hide `+20 points | aggro` / `−20 points | control` — split two ways,
  not balanced. A built-in per-strategy breakdown and the derived
  **`strat_spread(X) = max_S lift − min_S lift`** are still to build.

**Reading the lift table — the causation rules (carry into every findings doc):**
- Lift is **correlation, not causation**. A move that's only *legal when behind* (a
  catch-up/desperation action) shows large **negative** lift because it's a
  *symptom* of losing, not a cause. Know the rules before calling it a trap.
- **Starter/base cards** often show negative lift: leaning on them late means you
  failed to upgrade — expected, not a flaw.
- Use the **equal-skill Run A** table for balance — a skill gap contaminates lift.
- The table **filters on sample size** (`n_used ≥ 20` on both sides); thin rows are
  hidden.
- A **high-lift but rarely-used** feature is an **AI-quality lead** (the AI is
  leaving value on the table), and any balance verdict on it is premature until
  the AI actually uses it. Fix the AI / engine, then re-run (see "What fully playable
  means" in [`building-a-game.md`](./building-a-game.md), and AI-development §9).

### §4 Timing metrics — "where in the game is it decided?"

**[live, opt-in — needs `--trace` + a `leaderScalar` in the game's dev hooks.]**
Both metrics read a per-turn **score trace** the harness captures only when you
pass `--trace` (one extra `get_state` per turn — off by default so normal batches
pay nothing). The trace alone isn't enough: the analysis must know *which number
means "ahead"*, so the `analysis` part of the game's dev hooks must define
**`leaderScalar(scoreboardRow)`** — the during-play "who's winning" number, matching
what `result.scores` ranks on. **Without it the harness refuses to guess a leader**
(adding up unrelated resources would mislead), and the §4 section prints a one-line
"how to enable" hint instead. The game must also implement `getScoreboard` so
`get_state` can show the per-turn board. Every Zekel game's dev hooks set one —
Fractured Fist (`row.stamina`) is the simplest; Sweetlands Imperium shows how to
fold several resources into one number with weights.

- §4.1 **Decisiveness curve** — at each 10% of game progress, how often the current
  leader is the eventual winner (a simple "predict the winner from the leader"
  test). Each point carries a 95% Wilson CI. Where it first reaches about 90% is
  where the game is effectively decided; early ⇒ snowball / runaway leader. The
  100%-progress point can sit below 100% when the winner is set by **end-of-game
  scoring** the mid-game board doesn't show (for example a bonus for the most of
  something, awarded only at the end) — that gap is itself a "decided at the buzzer"
  signal, not an error.
- §4.2 **Lead stability** — mean turns the eventual winner spent *strictly behind*
  (≈0 ⇒ runaway leader; high ⇒ comeback-friendly) and mean **lead changes** per
  game (swinginess), each as a distribution. Turns tied for the lead don't count as
  trailing, so a scoreless opening doesn't swamp the signal.

Run it: `pnpm harness -- --game=<id> --n=… --difficulty=medium --trace
--no-game-files --quiet`. For a game without a `leaderScalar` yet, the standing
instruction applies — add one (about 3 lines, matching `result.scores`) and re-run.

### §5 Game-shape metrics — "close or a blowout?"

The §5 rule is **distributions, never means** — two batches with identical mean
margin can be all nail-biters or all routs.

- **Game length** — **[live]**. The "Game length distribution" section reports the
  full player-turns-per-game distribution: median (with a 95% bootstrap CI), IQR,
  range, mean, and a text histogram. Read the **shape**, not the mean — a histogram
  with two humps (a fast-rush line and a slow-grind line) is the signal the mean
  hides. (`Avg rounds / game` / `Avg player-turns / game` remain as the at-a-glance
  summary above it.)
- **Margin of victory** — **[live]**. The "Margin of victory distribution" section
  reports the final score-gap distribution (median/IQR/histogram) plus the headline
  **nail-biter share** and **rout share**. Shares use a margin scaled to the game
  (gap ÷ winner's score) with default thresholds ≤10% (nail-biter) / ≥50% (rout) —
  **designer-tunable** via `analyzeBatch`'s `nailBiterMax`/`routMin` options.
  Stalemate (round-cap) games are left out so they don't read as nail-biters.
- **§5.1 Pace — what ends games quickly / what makes them drag.** **[live]** — the
  "Pace" section splits games at the length quartiles and reports, with CIs, (a)
  **fast finishers**: features the *winner* used significantly more often in the
  fastest quarter of decisive games, and (b) **drag suspects**: features *either*
  side used significantly more often in the longest quarter (stalemates included —
  a round-cap game is the purest drag signal). Read against the §5 length
  histogram: each hump should have an explanation here. Association, not causation
  (the §3.1 caveat applies).
- **Lead-change count** distribution (from §4.2) — **[live, opt-in]**: needs the
  `--trace` run and `leaderScalar` described in §4.
- **Dead-turn rate** — **[live]**, overall and by difficulty. Not in the §5 list,
  but the harness's headline "is a turn wasted?" metric. Its definition is per game
  (`isDeadTurn` in the dev hooks); the default is 0 cards played AND 0 bought.
- **§5 strategy cross-tab** (length/margin per strategy matchup) — **[planned]**.

`stalemate_rate` (ties from hitting the round cap, `--max-rounds`, default 80) is
reported apart from normal ties so a loadout that never finishes isn't mistaken
for a draw where both players fell at once.

### §6 Rules that apply to every run

1. **§6.1 Strategy mix is a parameter, not a constant.** A settable / re-weightable
   strategy prior is **[planned]**. Today the mix is "whatever the sweep and the
   single heuristic produced" — **state it explicitly** in findings; don't present
   an aggregate as if it held under any mix.
2. **§6.2 Confidence intervals are mandatory.** **[live]** — Wilson on every rate,
   Newcombe on every lift, ✓ on significant lifts, ±95% on matchup cells (see the
   §2 CI note). The intent still binds your *reading*: trust a ✓ lift and a
   CI-separated difference, ignore the rest; thin matchup cells are greyed for the
   same reason. Bootstrap CIs for the §4/§5 distribution figures are the remaining
   gap.
3. **§6.3 Targeted holdout for causal confirmation.** **[live]** — the edit half
   stays manual (re-run a batch with component X disabled / its setting changed),
   but the *compare* half is built: run both batches with
   `--analysis-json=<file>`, then
   `pnpm balance-dashboard -- --game=<id> --compare --analysis "before=a.json" --analysis "after=b.json"`
   renders every difference (outcome rates, seats, medians, the components whose
   lift moved most, metagame/combo shifts), each shown as real only when the two
   95% ranges separate — differences that don't are explicitly labelled noise
   (§6.2's "no compare view shows a difference without its significance"). That
   turns a "look here" lift into a controlled A/B test. It is also the right tool
   for a two-seed noise check before believing any single-batch verdict.
4. **§6.4 Every caption names both axes.** Minimum: *"win rate · skill=medium ·
   strategy mix=<what the run used> · N=… · 95% CI."* The CI is real (Wilson /
   Newcombe) — cite it. A number without its conditions invites the "confidently
   wrong" failure the whole model exists to prevent.

`pnpm balance-dashboard` also turns one or more `--analysis-json` files (or a
folder of per-game records) into a single self-contained HTML report, one tab per
run, each with its §6.4 caption.

---

## Question → metric → where

| Question | Metric family (def) | Status / where |
|---|---|---|
| Is it fair under good play? | §2 win rate, matchup, lift via the **skill sweep** | [live] Run B across tiers |
| Per-identity / skill matchups? | §2.2 matchup matrix (identity + `difficulty`) | [live] one matrix per dimension, ±95% |
| Is the metagame healthy / interesting? | §2.2 strategy matchup matrix (`--strategy=a,b`) | [live] for games with built strategies; §3.4 strategy-conditional lift + `strat_spread` still [planned] |
| **Does the game have a meta?** (one dominant line, or many viable?) | §0 Meta block: Nash viable set + Condorcet dominance + Hodge cycles | [live] pool run (`--strategy=<all factions>`), ≥2 skill tiers + several seeds |
| **Is each setup choice balanced?** (no dominant/dead faction; cosmetic picks flat) | §0 balance axes — `getBalanceAxes` + the harness coverage report | [live] vary every axis (`--strategy`/`--sweep`/`--players`); the report flags any left at default |
| Dominant strategy? | §3.1/§3.2 top of the lift table (high positive lift, decently used) | [live] |
| What guarantees victory? | §2.1 highest `WR used`, lift ≫ 0 (top WR-used about 50–55% ⇒ nothing degenerate) | [live] |
| What's useless / a trap? | §3.3 acquire-to-play (≈0) + rarely-used list + large negative lift — **with the causation caveat** | [live] |
| What ends games quickly (what do fast winners use)? | §5.1 pace — fast finishers (features winners used more in the fastest quarter of decisive games) | [live] |
| What makes games drag on? | §5.1 pace — drag suspects (features either side used more in the longest quarter, stalemates included) | [live] |
| Are there overpowered combos that break the game? | §3.5 combo synergy — pairs worth more than their parts, confirmed by a §6.3 holdout | [live] |
| Dead turns? | §5 dead-turn rate (per-game `isDeadTurn`) | [live] |
| Game length? | §5 length distribution (median/IQR/histogram) | [live] |
| Skill floor? | §6.1 skill sweep, weak-seat win rate | [live] Run B |
| Does turn order matter? | §2.3 win rate by seat, per skill tier | [live] |
| Player-count effect on length / dead turns? | §5, run `--players=2,3,4` | [live] |
| Decided too early? | §4 decisiveness curve (per-progress) | [live, opt-in] `--trace` + `leaderScalar` |
| Does it feel close? | §5 margin & length **distributions** + §4 lead stability/changes | [live]; lead changes via `--trace` |
| Per-identity balance (does a faction/role over-perform)? | §2.1 identity win rate via `playerFeatures` | [live] if the dev hooks emit it |

---

## Per-game prerequisites (the gotchas)

Before a run gives meaningful numbers, confirm:

0. **List the setup choices (balance axes) FIRST.** Every choice a player makes at
   setup — faction/god/character, loadout/draft, scenario/map/module — and every
   cosmetic pick (colour/seat) is a **balance axis**, and the *default run fixes all
   of them*. This is the most-missed step (it was nearly missed for Fractured Fist,
   where the loadout *is* the central choice). Declare them in the game's
   **`getBalanceAxes()`** (the balance twin of `getSetupChecklist`): `identity` →
   evaluate via the matchup matrix + meta; `config` → vary via `--sweep`/
   `--strategy`; `scenario` → run per scenario; `cosmetic` → **confirm win rate is
   flat** across it (a difference is a hidden bug). The harness prints a
   **coverage report** at the start of a run listing which axes this run varied vs
   left at default, and **`--strict-coverage`** stops a run that leaves a
   non-cosmetic axis unexercised. A balance pass must vary every axis (or justify
   fixing one). Example declarations: `fractured-fist` (faction + loadout),
   `sweetlands-imperium` (faction + which foe), `adventurer-olympics` (a cosmetic
   standee colour + a random quest draw), all in each game's `src/index.ts`. The
   harness adds a generic player-count axis for any game with a player range.
   **Declare an axis even when the harness can't yet vary it** — a real setup choice
   the simulation picks at random and the AI plays without regard to (in Frogs with
   Shotguns, obstacle placement) is declared with **no lever** (`levers: []`); the
   report lists it as "no harness lever yet — evaluate manually" (not a
   strict-coverage failure), so the gap is shown and tracked instead of silently
   left out. Neither Guts nor Gears' `starting_location` axis is declared this way.
   Evaluating such an axis later needs both a way to vary it AND an AI that plays it
   (the same "the AI ignores the mechanic" problem as AI-development §9).
1. **What each difficulty means (§0 skill axis).** Read the game's `ai.ts`. Know
   what `easy/medium/hard` actually do for *this* game (their strength is per game —
   don't assume `hard` == strong) and whether `easy` is random. `mcts` is the
   guaranteed-strong tier. Pick a *good* tier for Run A (a heuristic checked to be
   strong, else `mcts`) and the *weakest* for the floor seat in Run B.
2. **Strategy support (§0 strategy axis).** Does the game's `ai.ts` implement
   strategies (a `parseStrategy` + a behavioral lever)? If yes, run
   `--strategy=a,b` for the matchup matrix (Fractured Fist:
   `titan`/`awakened`/`masters`/`uncounted`). If not and you want the metagame
   view, **build them** (§0) — or fall back to the older stand-ins (a declared-goal
   feature, option sweeps). The per-seat tag and all the analysis are generic; only
   the in-game lever is per game.
3. **`metrics`** (the game's dev hooks) — optional extra per-seat metrics for the
   Feature-engagement table. The generic metrics (win rate, action counts and
   variety, score) always run.
4. **`analysis`** (the game's dev hooks) — **required when the game isn't a
   `play_card`/`buy_card`/`end_turn` deck-builder**, or when its win rate should be
   broken out by identity:
   - `isDeadTurn(moves)` — define "wasted turn" (§5). A non-card game MUST supply
     this or every turn reads as dead.
   - `isRealTurn(moves)` — drop stretches of the move stream that aren't real turns
     (forced reactions during another player's turn, setup reports,
     simultaneous-commit phases) from turn counts + dead-turn figures. Without it,
     those stretches inflate length and skew the dead-turn %.
   - `extraFeatures(move)` — add lift features that aren't cards (weapons, named
     targets, a declared goal or strategy, one-shot abilities). **This is where a
     strategy tag enters the lift table.**
   - `playerFeatures(record, playerId)` — add a per-player, per-game **identity**
     feature (`faction:…`, `role:…`) so the lift table reports that identity's win
     rate vs the field — the §2.1 per-identity balance metric, and the most valuable
     signal for asymmetric games.
   - `leaderScalar(scoreboardRow)` — the during-play "who's ahead" number (matching
     `result.scores`), required to turn on the **§4** decisiveness + lead-stability
     metrics in a `--trace` run. Leave it out and §4 stays off (the harness won't
     guess). Needs the game to implement `getScoreboard`. Skip it for games with no
     score that climbs during play (a pure hidden-identity game, a co-op game).

   Reference dev hooks in zekel-games (`packages/<game>/src/dev/index.ts`):
   **Fractured Fist** (a card game with a stricter dead-turn rule, `leaderScalar`,
   a strategy draft and a loadout sweep); **Cybernoir 2127** (no card-play
   vocabulary, reactions that aren't turns, a `role:` identity, a hideout sweep);
   **Adventurer Olympics** (no cards, setup and dice reports that aren't turns, an
   `icon:` extra feature, a quest-draw feature); **Neither Guts nor Gears**
   (reactions that aren't turns, `faction:` identity, faction sweep); **Sweetlands
   Imperium** (`faction:` identity + per-objective features).
5. **Options/strategy sweep.** If the game has a configurable pool (loadout,
   modules, setup layout, identities), add a named sweep under `sweeps` in the
   game's dev hooks and pass `--sweep=<name>` so the batch covers the whole
   space — the [proxy] strategy axis for games whose strategies aren't built yet.

---

## Deliverable

Write the answers to `FINDINGS-<game>.md`: the questions answered in prose, each
backed by the relevant table excerpt. **Every claim carries its §6.4 caption**
(skill tier + strategy mix + N) and the relevant caveats: skill vs balance,
correlation vs causation (§3.1), any rough edges in how turns were split, and —
explicitly — **which §4/§5 metrics were [planned] or not measured for this run** so
a reader doesn't assume "decided too early?" or "feels close?" were checked when
they weren't. Both the raw run output and the `FINDINGS-*.md` files are **local
working files — keep them out of git** (snapshots, not source).

**Commit a dated verdict.** The raw `FINDINGS-*.md` stays local (it goes stale),
but balance is otherwise the only gate that leaves no lasting record in the repo —
so also write a short, committed **`packages/<game>/BALANCE.md`**: the headline
verdict ("balanced under good play as of <date>; no dominant strategy; first-player
+X points"), the run settings (skill tiers, strategy mix, N, seeds), the date, and
any known imbalance / open AI gap. Your project's status table reads this
(zekel-games keeps one in `GAMES.md`), and it lets a later reader know *when*
balance was last assessed and against which AI. Update it whenever the AI or the
balance-relevant rules change — a change to the game's `ai.ts`, its rules, or the
shared `mcts.ts` / `harness/analysis.ts` means re-running this gate.

---

## Limits and iterating

- **No language-model AI in batches** — too slow and expensive at 1000s of games.
  Use the programmatic heuristics (prefer them over MCTS where a heuristic matches,
  to keep per-move cost low).
- **A clean run has 0 errored games.** Any `ERR:` is a real bug — investigate
  before trusting the run. The harness finds bugs, not just numbers.
- **One batch may not settle the question.** A weak AI, an engine bug, or something
  the harness can't see all distort the picture. Treat findings as hypotheses;
  iterate (fix the AI / add a dev hook / extend a metric / re-run). The §6.3 holdout
  loop (rebuild with X disabled, re-run, compare) is the way to turn a lift signal
  into a causal claim.
- **Keep everything game-agnostic.** New per-game needs go in the game's dev hooks
  (`metrics`, `analysis`, `sweeps`) — never one-off branches in the runner. New
  *metric families* (matchup matrix, CIs, distributions, the strategy axis) belong
  in `@zekel/dev`'s `harness/analysis.ts` as generic computations over
  `GameRecord`, so every game gets them at once. That is the path that closes the
  **[planned]** gaps above.
