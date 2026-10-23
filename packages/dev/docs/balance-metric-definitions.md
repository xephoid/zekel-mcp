# Balance metric definitions

A build reference. Every metric below is defined precisely enough to implement and to argue about. Where a choice exists, the choice is stated and justified rather than left implicit, because implicit definitions are how dashboards end up confidently wrong.

This file says *what* each metric means and why. How to produce and read each one
with the `@zekel/dev` AI harness — and which ones the harness computes today — is
in [`balance-harness-runbook.md`](./balance-harness-runbook.md), whose section
numbers (§0–§6) point back here.

---

## 0. The two agent axes

Every metric in this document is conditional on *who played the games it was computed from*. There are two independent axes describing those agents. Keep them separate everywhere — in storage, in the UI, in every chart caption.

**Skill** — how well a fixed objective is pursued. Operationalized as agent strength: search depth, evaluation quality, mistake rate. Tiers: `random → weak → medium → strong`. Holding strategy fixed and varying skill answers *"is this fair under good play?"*

**Strategy** — which objective is pursued. A named policy or heuristic profile: e.g. `aggro`, `control`, `economy`, `tempo`, `wide`, `tall`. Holding skill fixed and varying strategy answers *"does the game support multiple viable approaches, or does one line dominate?"*

These are orthogonal. A `(skill, strategy)` pair fully specifies an agent's behavioral class. Every stored game record must tag **both** for **every seat**, or none of the conditional slicing below is possible. This is the single most important data-model decision in the system — if games aren't tagged with both axes per seat at simulation time, the strategy metrics cannot be recovered after the fact.

**Default reporting tier.** Unless stated, headline numbers are reported at `skill=medium` with strategies sampled from the *designer-declared strategy pool* in proportion to a uniform prior (each strategy equally likely per seat). This is a deliberate, stated default, not a silent one — see §5 on the strategy mix as a parameter.

---

## 1. The appearance / draw / play distinction

Most component metrics ask "how does component X affect outcomes?" The answer depends entirely on what "X was involved" means. Three definitions, three different numbers, three different meanings. Pick per component type and state it on the chart.

- **Present** — X was in the game at all (in a deck, on the map, available to be drafted). Denominator = games where X *could* have mattered. Use for components a player doesn't choose: board tiles, fixed faction abilities, cards that are always in the pool.
- **Acquired / Drawn** — X entered a player's control (drawn, drafted, purchased, built). Use for components whose *access* is variable but whose *use* is not separately meaningful.
- **Played / Activated** — X was actively used to affect game state. The strictest and usually most causally meaningful. Use for cards/abilities a player chooses to deploy.

Rule of thumb: report at the **most downstream stage the component reaches**, because that's the stage closest to a causal claim. A card's "win rate when *drawn*" mixes together games where it was drawn and used with games where it was drawn and rotted in hand — those are different facts. "Win rate when *played*" isolates the first.

Always store all three counts where available. The gap between them is itself a signal: a card with high acquire-rate but low play-rate is being drawn and not used — a sign it's a dead card, which raw "present" win rate completely hides.

---

## 2. Outcome metrics (the "is it balanced" layer)

### 2.1 Win rate
Fraction of games won by a category (seat, faction, agent class).

```
win_rate(C) = wins(C) / games(C)
```

Draws: count explicitly as a third outcome, never silently split. Report `draw_rate` alongside. A 45/45/10 game is not a 50/50 game.

**Always sliceable by both axes.** `win_rate(faction=Frost | skill=strong, strategy=aggro)` is a different and more informative number than the aggregate. The aggregate is the *least* informative view and should never be the only one shown.

### 2.2 Matchup win rate
Win rate of category A conditional on facing category B.

```
matchup(A, B) = wins(A in games A-vs-B) / games(A-vs-B)
```

The headline asymmetry metric. By construction `matchup(A,B) + matchup(B,A) + draws = 100%`. Rendered as the heatmap. Compute separately per skill tier — matchup spreads almost always *widen* with skill, and reporting only the low-skill matrix understates imbalance.

**Strategy matchup matrix** — the same computation with strategy as the category instead of faction: `matchup(aggro, control)`. This is the metagame view. A healthy game has no strategy that beats all others; a dominant row in this matrix is a strategic-diversity problem even if every faction's win rate is 50%.

### 2.3 Seat advantage
Win rate by turn order (seat 1, seat 2, …) with everything else marginalized out. The classic first-player-advantage check. Report at each skill tier; first-player advantage is frequently skill-dependent (it often grows as agents learn to exploit tempo).

---

## 3. Component metrics (the "what's driving it" layer)

### 3.1 Win-rate lift — the core component metric
**Do not use raw win rate for components.** Raw win rate is confounded: a card can show a high win rate because it's strong, *or* because it's disproportionately acquired by players who are already winning for other reasons. Lift attacks the confound by measuring against a baseline.

**Definition (baseline-difference lift):**
```
lift(X) = win_rate(games where X was [played]) − baseline_win_rate
```
where `baseline_win_rate` is the win rate of the *same population of seats* over *all* their games. Units: percentage points (pp). Positive = the component is associated with winning above baseline.

**Stronger definition (played-vs-available lift), use where the data supports it:**
```
lift_pva(X) = win_rate(X was played | X was available)
            − win_rate(X was NOT played | X was available)
```
This conditions on *availability* and contrasts *use vs non-use*, which controls for "this card is only available in certain game states." It isolates the marginal effect of choosing to use X far better than the baseline-difference form. Prefer it whenever you can identify the "available but not played" counterfactual; fall back to baseline-difference when you can't.

**Neither is a clean causal estimate.** Both still suffer selection on unobserved state (a skilled player both plays X *and* plays better generally). Treat lift as a strong localization signal — "look here" — not a proof of causation. The honest one-line caveat to surface in the UI: *lift flags association, not proof; confirm with a targeted holdout.* (See §6.2.)

### 3.2 Play frequency
```
freq(X) = games where X was [played] / total games
```
The indispensable companion to lift. **Lift without frequency is the single most common way these dashboards mislead.** A +25pp lift at 2% frequency is a curiosity; +15pp at 60% frequency is a crisis. The scatter (freq on x, lift on y) exists precisely so neither is ever read alone. The danger zone is the high-freq / high-lift corner.

### 3.3 Acquire-to-play ratio
```
a2p(X) = times X was played / times X was acquired
```
Detects dead components. Low ratio = drawn/bought but not used. A card with strong lift *when played* but a low a2p is a card that's powerful but situational or hard to enable — a different design note than a card that's simply strong.

### 3.4 Strategy-conditional lift — where the strategy axis earns its keep
The same lift, computed within a single strategy:
```
lift(X | strategy=S)
```
This is the metric that catches the most subtle and most damaging kind of imbalance: a component that's balanced *on average* but warps a specific strategy. A card showing `lift ≈ 0` overall can hide `lift = +20pp | aggro` and `lift = −20pp | control` — it's not balanced, it's *bimodal*, and it's silently forcing a strategic choice. Averaging across strategies erases exactly the design fact you most need to see.

**Lift variance across strategy** is therefore a first-class derived metric:
```
strat_spread(X) = max_S lift(X|S) − min_S lift(X|S)
```
High spread = the component is a strategy-defining card (could be intentional depth, could be a trap). Low spread = uniformly strong/weak. This number tells a designer whether a balance problem is *global* (tune the number) or *strategic* (the card is doing something to the metagame).

### 3.5 Pairwise combo synergy — "is the pair worth more than its parts?"
Single-component lift misses the classic degenerate case: two components that are fine alone and broken together. For a pair (X, Y), over the seats where **both were available**, partition into both / X-only / Y-only / neither and compute the 2×2 **interaction contrast**:

```
synergy(X, Y) = WR(both) − WR(X only) − WR(Y only) + WR(neither)
```

Zero = the components are additive (each contributes its own lift, no combo). Significantly positive = **super-additive** — the pair wins more than the sum of its parts predicts, the "breaks the game" direction. Attach a CI (normal approximation over the four cells) and report only pairs whose CI excludes 0; gate every cell on sample size (the single-use cells starve first). Exclude tautological pairs (acquiring X and playing X). **Also require `WR(both) > WR(neither)`**: two individually-awful components whose badness fails to stack produce a positive interaction while still losing — "less bad together" is not a broken combo. Same causation caveat as §3.1 — a confirmed combo warrants a §6.3 holdout (disable one half, re-run).

---

## 4. Temporal metrics (the "where in the game" layer)

### 4.1 Decisiveness by phase / turn
For each phase node (these map onto the flow-map nodes), the degree to which outcomes are determined by the end of that phase. Operationalize via a lightweight win-predictor: at the boundary of phase *p*, how well does current game state predict the eventual winner?
```
decisiveness(p) = predictive_accuracy(state at end of p → final winner)
```
A phase where accuracy jumps to ~90% is where the game is effectively decided. If that's turn 3 of a 12-turn game, you have a snowball/runaway-leader problem regardless of what win rates say. This is the metric that paints onto the flow map — phase nodes tinted by decisiveness, transition edges weighted by how often they're the pivot.

### 4.2 Lead stability / lead changes
Average number of times the eventual winner was *not* the current leader. High = comeback-friendly, swingy. Zero = whoever's ahead stays ahead (runaway leader). A core "feel" metric that win rate cannot express.

---

## 5. Game-shape metrics (the "close or a blowout" layer)

Report these as **distributions (histograms), never as means.** Collapsing to a mean is where the design signal dies — two games with identical mean margin can be all-nail-biters or all-routs.

- **Game length** — turn-count distribution. Report median and IQR, but show the histogram. Bimodal length = two different games hiding in one ruleset (often a fast-rush line vs. a slow-grind line — cross-reference with strategy).
- **Margin of victory** — final score gap distribution. The nail-biter share (margin ≤ threshold) vs. rout share (margin ≥ threshold) is the headline. Thresholds are designer-set against their stated balance objective.
- **Lead-change count** — distribution from §4.2.

**Strategy cross-tab.** Game shape often depends on the strategy *mix*: aggro-vs-aggro mirrors may always be short, control mirrors always long. Slice game-length and margin by strategy matchup, not just globally — a "swingy" game might actually be perfectly predictable within each matchup and only looks swingy when matchups are pooled.

### 5.1 Pace associations — "what ends games quickly, what makes them drag?"
The length distribution says games are bimodal; this says *why*. Split games at the length quartiles and ask which components distinguish the tails:

- **Fast finishers** — over **decisive** games, fast = length ≤ P25. For each feature: share of fast games where the **winner** used it vs the same share in the remaining decisive games. Winner-only, because the question is "what closed the game out", not "what was present".
- **Drag suspects** — long = length ≥ P75 of **all** scored games, **stalemates included** (a round-cap game is the purest drag signal). For each feature: share of long games where **any** seat used it vs the shorter games. Either side, because a stall is often something done *to* the winner.

Both are difference-of-proportions with a CI (Newcombe); report significant over-representations only. Association, not causation — a finisher card may just be what winners happen to hold in short games; confirm with a §6.3 holdout. Cross-reference with §5's length histogram: each hump should have an explanation here.

---

## 6. Cross-cutting rules

### 6.1 The strategy mix is a parameter, not a constant
Every aggregate number implicitly assumes some distribution over what strategies the agents played. **Make that distribution explicit and controllable.** A faction that's 50% under a uniform strategy mix can be 65% under a metagame where one strategy dominates. The designer should be able to:
- set the strategy prior (uniform, or weighted to model an expected metagame), and
- see how headline metrics move as that prior changes.

This is the strategy analog of the skill sweep. Where the **skill sweep** plots a metric across `random→strong` holding strategy fixed, the **strategy sweep** plots a metric across strategy pairings holding skill fixed. Both should exist; they answer different questions (*fair?* vs *interesting?*).

### 6.2 Confidence intervals are mandatory, not decorative
Every rate is an estimate from a finite sample. Attach a CI to every win rate, matchup, and lift (Wilson interval for proportions; bootstrap for lift differences). The UI must make the noise floor visible so a designer doesn't chase a 2pp wiggle that's sampling noise. A change between two builds is only real if the intervals separate. **No diff/compare view should show a delta without showing whether it's significant.**

Sample-size guidance: matchup and strategy-conditional cells slice the data finely and starve fast. Track per-cell N and grey out / widen intervals on thin cells rather than showing a confident-looking number backed by 30 games.

### 6.3 Targeted holdout for causal confirmation
Because lift is associational (§3.1), the tool should support a confirmation move: re-simulate a batch with component X forcibly disabled (or its parameter changed) and compare outcomes directly. This converts a "look here" signal into a controlled A/B. The edit→rerun loop already does this for parameter changes; extend it to component on/off.

### 6.4 Every chart caption names both axes
No number appears without its conditioning. Minimum caption: *"win rate · skill=medium · strategy mix=uniform · N=5,000 · 95% CI."* A number without its conditions is not interpretable and invites the exact "confidently wrong" failure the whole design is trying to prevent.

---

## 7. Axis summary — what each answers

| Question | Hold fixed | Vary | Metric family |
|---|---|---|---|
| Is it fair under good play? | strategy mix | skill (`random→strong`) | win rate, matchup, lift — *skill sweep* |
| Is the metagame healthy? | skill | strategy (the pool) | strategy matchup matrix, strat-conditional lift, `strat_spread` |
| Is a component a global or strategic problem? | skill | strategy | `strat_spread(X)` |
| Is it decided too early? | both | — | decisiveness by phase, lead stability |
| Does it feel close? | matchup | — | margin & length distributions |

The skill axis and the strategy axis are independent and the tool should let a designer move along either while holding the other fixed. Most existing balance tools have neither as a first-class control; having both, orthogonally, is the thing that distinguishes "a chart of win rates" from "an instrument for understanding a game."