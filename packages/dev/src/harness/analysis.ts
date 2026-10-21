// Batch-level analysis for the AI testing harness. Where metrics.ts produces
// one MetricsRecord PER GAME (per-seat counters), this module answers the
// cross-batch balance questions the harness exists to answer:
//
//   - What is each card / action / mechanic's relationship to winning?
//     ("usage -> win-rate lift" — the dominant-strategy / OP / useless signal)
//   - How long does a game run (rounds + player-turns)?
//   - How often do players take a "dead" turn (no card played AND none bought)?
//   - How big is the initiative-seat advantage?
//
// Everything here is GENERIC over the move stream: a move record carries
// `{type, card_id, ...}`, so feature extraction works for any registered game.
// Per-game refinements come from each game's dev hooks (devHooksFor(id).analysis,
// src/harness/devHooks.ts) — the generic core needs none.

import type { GameRecord, MoveRecord } from './runner.js';
import { devHooksFor } from './devHooks.js';
import {
  wilsonInterval,
  newcombeDiffInterval,
  bootstrapMedianCI,
  halfWidthPct,
  Z_95,
  type Interval,
} from './stats.js';
import { computeMeta, type MetaAnalysis } from './meta.js';

// ---------- per-game overrides ----------
//
// The generic analysis assumes the Fractured-Fist-style move vocabulary
// (play_card / buy_card / end_turn); games with a different vocabulary supply an
// override through their dev hooks. A game without one uses the generic
// behaviour unchanged.

export interface AnalysisOverride {
  // Per-turn dead-turn predicate. Return a boolean to override; return null/
  // undefined to fall back to the generic rule (0 play_card AND 0 buy_card).
  isDeadTurn?(moves: MoveRecord[]): boolean | null;
  // Extra feature keys for the lift table, beyond the generic action:/play:/buy:.
  // These are never availability-gated (only play:/buy: are), so use them for
  // entities the game always exposes (Dragonwood's fixed creature/enhancement
  // pool, weapons, etc.).
  extraFeatures?(move: MoveRecord): string[];
  // Whether a segmented run of one player's moves is a REAL player-turn. Return
  // false to DROP the segment from turn counts + dead-turn stats — for games where
  // the move stream contains forced sub-resolutions that aren't turns (e.g. a frog
  // reporting a Blast-relocation / death roll it was forced into). Default: every
  // segment is a real turn.
  isRealTurn?(moves: MoveRecord[]): boolean;
  // Per-PLAYER-GAME feature keys (not tied to a single move) — e.g. the identity a
  // seat played (frog / faction / god). Never availability-gated, so the lift
  // table reports that identity's win rate vs the field. Read from the record
  // (final_views, options, etc.).
  playerFeatures?(record: GameRecord, playerId: string): string[];
  // §4 temporal metrics: reduce one player's public-scoreboard row (the resource
  // map getScoreboard returns) to the single scalar that defines "who is ahead".
  // REQUIRED for §4 (lead-change count, decisiveness) — without it the harness
  // will NOT guess a leader (summing unrelated resources would be misleading), so
  // §4 is simply omitted for that game. Return the same quantity the game's
  // result.scores ranks on. e.g. Dragonwood → row.victory_points.
  leaderScalar?(scoreboardRow: Record<string, number>): number;
}

/** A move's canonical summary text ('' when it has none). Shared with games' analysis overrides. */
export function summaryOf(m: MoveRecord): string {
  return typeof m.summary === 'string' ? m.summary : '';
}


// ---------- per-turn segmentation ----------

export interface TurnSummary {
  player_id: string;
  seat_index: number; // position in this game's playerOrder (0 = initiative)
  difficulty?: string;
  move_count: number;
  played_count: number; // play_card moves this turn
  bought_count: number; // buy_card moves this turn
  // A turn is "dead" iff the player neither played a card nor bought one
  // (per the game designer's chosen threshold — effectively a passed turn).
  is_dead: boolean;
}

export function moveType(m: MoveRecord): string {
  const t = (m.move as { type?: unknown } | null | undefined)?.type;
  return typeof t === 'string' ? t : 'unknown';
}

export function moveCardId(m: MoveRecord): string | undefined {
  const c = (m.move as { card_id?: unknown } | null | undefined)?.card_id;
  return typeof c === 'string' ? c : undefined;
}

function seatMap(record: GameRecord): Record<string, number> {
  const out: Record<string, number> = {};
  record.players.forEach((p, i) => {
    out[p.player_id] = i;
  });
  return out;
}

function difficultyMap(record: GameRecord): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const p of record.players) out[p.player_id] = p.difficulty;
  return out;
}

// Split a game's flat move stream into player-turns. A turn is the maximal run
// of one player's moves ending at their `end_turn` (which is how every FF turn
// closes — it triggers cleanup / strike resolution). A trailing partial run
// (e.g. an errored or safety-capped game with no closing end_turn) is still
// emitted as a final turn so its moves are counted.
export function segmentTurns(record: GameRecord): TurnSummary[] {
  const seats = seatMap(record);
  const diffs = difficultyMap(record);
  const override = devHooksFor(record.game_id).analysis;
  const turns: TurnSummary[] = [];
  let cur: MoveRecord[] = [];

  const flush = (): void => {
    if (cur.length === 0) return;
    // Drop segments the game says aren't real turns (forced reactive sub-rolls).
    if (override?.isRealTurn && !override.isRealTurn(cur)) {
      cur = [];
      return;
    }
    const pid = cur[0]!.player_id;
    const played = cur.filter((m) => moveType(m) === 'play_card').length;
    const bought = cur.filter((m) => moveType(m) === 'buy_card').length;
    const overridden = override?.isDeadTurn?.(cur);
    turns.push({
      player_id: pid,
      seat_index: seats[pid] ?? 0,
      difficulty: diffs[pid],
      move_count: cur.length,
      played_count: played,
      bought_count: bought,
      is_dead: typeof overridden === 'boolean' ? overridden : played === 0 && bought === 0,
    });
    cur = [];
  };

  for (const m of record.moves) {
    // A change of acting player without an intervening end_turn shouldn't
    // happen in FF, but guard so each turn stays single-player.
    if (cur.length > 0 && cur[0]!.player_id !== m.player_id) flush();
    cur.push(m);
    if (moveType(m) === 'end_turn') flush();
  }
  flush();
  return turns;
}

// ---------- per-player-game projection ----------

export interface PlayerGame {
  game_id: string;
  seed: number;
  player_id: string;
  seat_index: number;
  difficulty?: string;
  won: boolean;
  is_tie: boolean;
  turns: TurnSummary[];
  // Features the player exercised at least once this game.
  features: Set<string>;
  // Card features (play:/buy:) that were AVAILABLE to the player this game —
  // the denominator for lift, so "didn't use" never includes "couldn't use".
  availableCards: Set<string>;
  // Per-seat IDENTITY/strategy labels for the §2.2 matchup matrix — the subset of
  // features that name WHO this seat was (its faction/frog/god/setup-slot, from the
  // override's playerFeatures) plus its skill tier (`difficulty:<d>`). Distinct from
  // `features` (which also holds the component play:/buy:/action: keys) because a
  // matchup dimension must be a one-per-seat categorical label, not a component the
  // seat may or may not have used.
  identityFeatures: Set<string>;
}

// A card is available in a game if it's in the declared loadout option OR it
// appeared in any player's move (captures always-on resources + missteps
// without hardcoding their ids — FF pools are symmetric across both seats).
function availableCardsForGame(record: GameRecord): Set<string> {
  const out = new Set<string>();
  const loadout = (record.options as { loadout?: unknown } | undefined)?.loadout;
  if (Array.isArray(loadout)) for (const id of loadout) if (typeof id === 'string') out.add(id);
  for (const m of record.moves) {
    const c = moveCardId(m);
    if (c) out.add(c);
  }
  return out;
}

// Feature keys for one move: the action type, plus the specific card for
// play/buy moves. These are the units the lift table correlates with winning.
function featuresOfMove(m: MoveRecord, override?: AnalysisOverride): string[] {
  const t = moveType(m);
  const keys = [`action:${t}`];
  const c = moveCardId(m);
  if (c && t === 'play_card') keys.push(`play:${c}`);
  if (c && t === 'buy_card') keys.push(`buy:${c}`);
  if (override?.extraFeatures) keys.push(...override.extraFeatures(m));
  return keys;
}

export function toPlayerGames(record: GameRecord): PlayerGame[] {
  if (record.error) return []; // errored games carry no trustworthy outcome
  const override = devHooksFor(record.game_id).analysis;
  const turns = segmentTurns(record);
  const available = availableCardsForGame(record);
  const winners = record.result.winners;
  const isTie = winners.length !== 1;
  return record.players.map((p, seat) => {
    const myMoves = record.moves.filter((m) => m.player_id === p.player_id);
    const features = new Set<string>();
    for (const m of myMoves) for (const k of featuresOfMove(m, override)) features.add(k);
    // Identity/strategy labels feed both the lift table (per-identity win rate vs
    // the field) AND the matchup matrix — keep them in BOTH sets.
    const identityFeatures = new Set<string>();
    if (override?.playerFeatures) {
      for (const k of override.playerFeatures(record, p.player_id)) {
        features.add(k);
        identityFeatures.add(k);
      }
    }
    // Skill tier is always a matchup dimension (gives the Run-B skill-vs-skill
    // matrix for free). Kept OUT of `features` so it never appears as a lift row.
    if (p.difficulty) identityFeatures.add(`difficulty:${p.difficulty}`);
    // Strategy axis (§0): a per-seat tag set by --strategy. Both a lift feature
    // (its win rate vs the field) AND a matchup dimension (the strategy matchup
    // matrix / metagame view). Generic — any game whose seats carry a strategy
    // gets these for free.
    if (p.strategy) {
      identityFeatures.add(`strategy:${p.strategy}`);
      features.add(`strategy:${p.strategy}`);
    }
    return {
      game_id: record.game_id,
      seed: record.seed,
      player_id: p.player_id,
      seat_index: seat,
      difficulty: p.difficulty,
      won: winners.includes(p.player_id),
      is_tie: isTie,
      turns: turns.filter((t) => t.player_id === p.player_id),
      features,
      availableCards: available,
      identityFeatures,
    };
  });
}

// ---------- batch analysis ----------

export interface FeatureLift {
  feature: string; // e.g. "buy:grand_finale", "action:focus_reload"
  n_available: number; // player-games where this feature could be used
  n_used: number; // ...and was used >= 1x
  usage_rate: number; // n_used / n_available
  win_rate_used: number; // win rate among the used subset
  win_rate_used_ci: Interval; // 95% Wilson CI on win_rate_used
  win_rate_not_used: number; // win rate among the available-but-unused subset
  lift: number; // win_rate_used - win_rate_not_used
  lift_ci: Interval; // 95% Newcombe CI on the difference (lift is real iff it excludes 0)
}

export interface SeatOutcome {
  seat_index: number;
  games: number;
  win_rate: number;
  win_rate_ci: Interval; // 95% Wilson CI
}

// §3.3 acquire-to-play ratio — a dead-component detector. For a deck-builder,
// "acquired" = buy_card events and "played" = play_card events for a card across
// the batch. a2p ≈ 0 ⇒ bought but left unplayed (a dead purchase); a2p ≥ 1 ⇒ a
// reusable card pulling its weight. Distinct from the lift table: a card can have
// strong lift WHEN played yet a low a2p (powerful but situational / hard to enable).
export interface AcquireToPlay {
  card: string;
  acquired: number; // buy_card count
  played: number; // play_card count
  a2p: number; // played / acquired
}

// §2.2 matchup matrix: win rate of category A in games where category B is also
// present. Built per identity/strategy DIMENSION (faction, frog, god, difficulty,
// …) — one matrix per dimension. For 2-player games each cell is the exact
// definition matchup(A,B); for >2 players it is "A's win rate in games containing
// B" (a seat can face several categories at once), noted in the rendered caption.
export interface MatchupCell {
  games: number;
  wins: number;
  win_rate: number;
  ci: Interval;
}

export interface MatchupMatrix {
  dimension: string; // the feature prefix, e.g. "faction", "difficulty"
  categories: string[]; // sorted distinct category values (the part after "prefix:")
  // cells[a][b] = A-vs-B. Missing pair ⇒ never co-occurred.
  cells: Record<string, Record<string, MatchupCell>>;
  // §0/§2.2 "does this dimension have a meta?" — Nash support + Hodge cycles over
  // this matrix. Most informative when every pairing has data (a pool run).
  meta: MetaAnalysis;
}

// §5 game-shape — a distribution summary. The §5 rule is "report distributions,
// never means": the histogram + quartiles expose a bimodal length (fast-rush vs
// slow-grind lines) or an all-routs margin that a single mean hides.
export interface HistBucket {
  lo: number;
  hi: number; // half-open [lo, hi), except the last bucket which includes max
  count: number;
}

export interface Distribution {
  n: number;
  min: number;
  p25: number;
  median: number;
  median_ci: Interval; // 95% bootstrap CI on the median (§6.2)
  p75: number;
  max: number;
  mean: number;
  histogram: HistBucket[];
}

// §5 margin of victory — the final score-gap distribution plus the headline
// nail-biter vs rout shares. Shares are computed on a SCALE-FREE normalized margin
// (gap ÷ winner's score) so the default thresholds work across games with wildly
// different score scales; thresholds are designer-tunable (see analyzeBatch opts).
export interface MarginStats {
  distribution: Distribution; // absolute score gap, over decisive non-stalemate games
  nail_biter_max: number; // normalized-margin threshold for "nail-biter" (default 0.10)
  rout_min: number; // normalized-margin threshold for "rout" (default 0.50)
  nail_biter_share: number; // share of games with normalized margin <= nail_biter_max
  nail_biter_ci: Interval; // 95% Wilson CI on nail_biter_share
  rout_share: number; // share of games with normalized margin >= rout_min
  rout_ci: Interval; // 95% Wilson CI on rout_share
  exact_tie_share: number; // share that were exact 0-margin ties (the ultimate nail-biter)
}

// §5.1 pace associations — "what ends games quickly / what makes them drag".
// Length-conditional feature presence: a feature over-represented in the
// WINNER's kit in the fastest games is a finisher; a feature over-represented
// (on either side) in the longest games — stalemates included — is a stall
// suspect. Only significant positive associations are kept (the CI on the
// difference excludes 0), so an empty list means "nothing distinguishes them".
export interface PaceAssociation {
  feature: string;
  n_group: number; // games in the fast/long group
  rate_group: number; // share of group games where the feature was present
  n_rest: number; // comparison games
  rate_rest: number;
  diff: number; // rate_group − rate_rest (positive = over-represented in group)
  diff_ci: Interval; // 95% Newcombe
}

export interface PaceStats {
  fast_max_turns: number; // fast = decisive games with ≤ this many player-turns (P25 of decisive)
  long_min_turns: number; // long = scored games with ≥ this many player-turns (P75 of all scored)
  n_fast: number;
  n_decisive_rest: number;
  n_long: number;
  n_short_rest: number;
  // Features of the WINNER over-represented in fast decisive games.
  fast_finishers: PaceAssociation[];
  // Features of ANY player over-represented in long games (stalemates included).
  drag_features: PaceAssociation[];
}

// §3.5 combo synergy — pairs of components whose combined win rate exceeds what
// each part predicts alone. `interaction` is the 2×2 interaction contrast
// WR(both) − WR(A only) − WR(B only) + WR(neither): zero when effects are
// additive, positive when the pair is worth more than the sum of its parts —
// the "breaks the game" direction. Only positive-significant pairs are kept.
export interface ComboSynergy {
  feature_a: string;
  feature_b: string;
  n_both: number;
  wr_both: number;
  wr_both_ci: Interval;
  n_a_only: number;
  wr_a_only: number;
  n_b_only: number;
  wr_b_only: number;
  n_neither: number;
  wr_neither: number;
  interaction: number;
  interaction_ci: Interval; // normal approx over the four cells
}

// §4.1 decisiveness — at a fractional progress point, how often the current
// leader is the eventual winner. The "lightweight win-predictor" is simply
// "predict the current leader to win"; accuracy ≈ how decided the game is by then.
export interface DecisivenessPoint {
  progress: number; // 0.1 … 1.0 (fraction of the game's turns elapsed)
  accuracy: number; // P(leader at this point == eventual winner)
  n: number; // games contributing
  ci: Interval; // 95% Wilson CI on accuracy
}

// §4 temporal metrics, present only when the batch was run with --trace AND the
// game provides a leaderScalar override.
export interface TemporalStats {
  n_games: number; // decisive games with a usable score trace
  // §4.2 — per game, the number of turn-snapshots where the current leader was
  // NOT the eventual winner. Mean ≈ 0 ⇒ runaway leader; high ⇒ comeback-friendly.
  turns_trailing_winner: Distribution;
  // §4.2 — per game, how many times the leader's identity changed (swinginess).
  lead_changes: Distribution;
  // §4.1 — decisiveness curve over the course of the game.
  decisiveness: DecisivenessPoint[];
}

export interface BatchAnalysis {
  games_total: number;
  games_errored: number;
  games_scored: number;
  tie_rate: number;
  // Share of scored games stopped at the round cap (degenerate/endless
  // loadouts). A subset of ties — broken out so it's not mistaken for a
  // normal simultaneous-KO tie.
  stalemate_rate: number;
  avg_player_turns: number; // mean player-turns per game
  avg_rounds: number; // player-turns / player_count
  // §5 game length — the distribution of player-turns per game (not just the mean
  // above). A bimodal shape = two different games hiding in one ruleset.
  game_length: Distribution;
  // §5 margin of victory — score-gap distribution + nail-biter/rout shares.
  margin: MarginStats;
  dead_turn_rate: number; // dead turns / all turns
  dead_turn_rate_by_difficulty: Record<string, number>;
  seat_outcomes: SeatOutcome[];
  feature_lift: FeatureLift[];
  // §3.3 — acquire-to-play per bought card. Empty for games with no buy_card.
  acquire_to_play: AcquireToPlay[];
  // §2.2 — one matchup matrix per identity/strategy dimension present (≥2
  // categories). Empty for a symmetric, single-difficulty batch.
  matchups: MatchupMatrix[];
  // §5.1 — what ends games quickly / what makes them drag.
  pace: PaceStats;
  // §3.5 — super-additive component pairs (candidate broken combos).
  combos: ComboSynergy[];
  // §4 — decisiveness + lead stability. Present only for a --trace run of a game
  // with a leaderScalar override; undefined otherwise.
  temporal?: TemporalStats;
}

export interface AnalyzeOpts {
  // §5 normalized-margin thresholds (gap ÷ winner score). Defaults: ≤10% = nail-biter,
  // ≥50% = rout. Designer-set against the game's stated balance objective.
  nailBiterMax?: number;
  routMin?: number;
}

// ---------- distribution helpers (§5) ----------

// Linear-interpolated percentile of an ASCENDING-sorted array. p in [0,1].
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

// Equal-width histogram over [min, max] with up to `buckets` bins. A degenerate
// range (all values equal) collapses to a single bin. The last bin is closed on
// the right so the max value lands in it.
function buildHistogram(values: number[], buckets = 8): HistBucket[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [{ lo: min, hi: max, count: values.length }];
  const span = max - min;
  const n = Math.min(buckets, Math.max(1, Math.ceil(span))); // never more bins than integer span
  const width = span / n;
  const out: HistBucket[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ lo: min + i * width, hi: min + (i + 1) * width, count: 0 });
  }
  for (const v of values) {
    let bin = Math.floor((v - min) / width);
    if (bin >= n) bin = n - 1; // max value → last bin (closed right edge)
    if (bin < 0) bin = 0;
    out[bin]!.count += 1;
  }
  return out;
}

function summarizeDistribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n,
    min: n ? sorted[0]! : 0,
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    median_ci: bootstrapMedianCI(sorted),
    p75: percentile(sorted, 0.75),
    max: n ? sorted[n - 1]! : 0,
    mean: rate(sum, n),
    histogram: buildHistogram(sorted),
  };
}

function rate(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

// Whether a card feature key (play:/buy:) refers to a card; action: keys are
// always "available" so they're never availability-gated.
function isCardFeature(key: string): boolean {
  return key.startsWith('play:') || key.startsWith('buy:');
}

function cardOfFeature(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

// ---------- matchup matrices (§2.2) ----------

// Build one matchup matrix per identity/strategy dimension. A dimension is a
// feature prefix (the part before ':') seen in identityFeatures — faction, frog,
// god, setup_slot, difficulty, … A seat's category in dimension D is the value of
// its `D:<value>` identity feature (assumed at most one per dimension per seat).
//
// matchup(A,B) counts, for every seat with category A, the games where SOME OTHER
// seat has category B, crediting A a win if that seat won. For 2-player games this
// is exactly the §2.2 definition; for >2 players it is "A's win rate in games
// containing B". Mirror cells (A vs A) require a second seat also of category A.
function computeMatchups(playerGames: PlayerGame[]): MatchupMatrix[] {
  // Group player-games by the game they belong to.
  const byGame = new Map<string, PlayerGame[]>();
  for (const pg of playerGames) {
    const key = `${pg.game_id}:${pg.seed}`;
    (byGame.get(key) ?? byGame.set(key, []).get(key)!).push(pg);
  }

  // Discover dimensions and their categories from identityFeatures.
  const dimCategories = new Map<string, Set<string>>();
  for (const pg of playerGames) {
    for (const f of pg.identityFeatures) {
      const i = f.indexOf(':');
      if (i < 0) continue;
      const dim = f.slice(0, i);
      const val = f.slice(i + 1);
      (dimCategories.get(dim) ?? dimCategories.set(dim, new Set()).get(dim)!).add(val);
    }
  }

  const matrices: MatchupMatrix[] = [];
  for (const [dim, cats] of dimCategories) {
    if (cats.size < 2) continue; // a single category has no matchup to report
    const categories = [...cats].sort();
    // raw[a][b] = { games, wins }
    const raw = new Map<string, Map<string, { games: number; wins: number }>>();
    const bump = (a: string, b: string, won: boolean): void => {
      const row = raw.get(a) ?? raw.set(a, new Map()).get(a)!;
      const cell = row.get(b) ?? row.set(b, { games: 0, wins: 0 }).get(b)!;
      cell.games += 1;
      if (won) cell.wins += 1;
    };
    const catOf = (pg: PlayerGame): string | null => {
      for (const f of pg.identityFeatures) {
        if (f.startsWith(`${dim}:`)) return f.slice(dim.length + 1);
      }
      return null;
    };
    for (const seats of byGame.values()) {
      const labelled = seats.map((pg) => ({ pg, cat: catOf(pg) })).filter((x) => x.cat !== null) as {
        pg: PlayerGame;
        cat: string;
      }[];
      for (const me of labelled) {
        // Categories present on OTHER seats this game (dedup so multiple same-cat
        // opponents count once per category — matchup is vs a category, not a seat).
        const oppCats = new Set<string>();
        for (const other of labelled) if (other !== me) oppCats.add(other.cat);
        for (const b of oppCats) bump(me.cat, b, me.pg.won);
      }
    }
    const cells: Record<string, Record<string, MatchupCell>> = {};
    for (const [a, row] of raw) {
      cells[a] = {};
      for (const [b, v] of row) {
        cells[a]![b] = {
          games: v.games,
          wins: v.wins,
          win_rate: rate(v.wins, v.games),
          ci: wilsonInterval(v.wins, v.games),
        };
      }
    }
    // §0/§2.2 meta analysis over this dimension's matrix. winRate[i][j] = i-vs-j,
    // falling back to 1 − (j-vs-i) when only the mirror cell has data, else 0.5.
    const winRate = categories.map((a, i) =>
      categories.map((b, j) => {
        if (i === j) return 0.5;
        const ab = cells[a]?.[b];
        if (ab) return ab.win_rate;
        const ba = cells[b]?.[a];
        return ba ? 1 - ba.win_rate : 0.5;
      }),
    );
    const meta = computeMeta(categories, winRate);
    matrices.push({ dimension: dim, categories, cells, meta });
  }
  // Stable, useful order: skill matchup last, identity dimensions first.
  return matrices.sort((x, y) =>
    x.dimension === 'difficulty' ? 1 : y.dimension === 'difficulty' ? -1 : x.dimension.localeCompare(y.dimension),
  );
}

// ---------- §5.1 pace associations ----------

// Per-game view for pace: length, decisiveness, the winner's features, and the
// union of every seat's features. Strategy/identity tags stay in — "fast games
// are won by <faction>" is a legitimate answer to "what ends games quickly".
interface GamePaceRow {
  length: number;
  decisive: boolean;
  winnerFeatures: Set<string>;
  anyFeatures: Set<string>;
}

function paceRows(playerGames: PlayerGame[], turnsPerGame: Map<string, number>): GamePaceRow[] {
  const byGame = new Map<string, PlayerGame[]>();
  for (const pg of playerGames) {
    const key = `${pg.game_id}:${pg.seed}`;
    (byGame.get(key) ?? byGame.set(key, []).get(key)!).push(pg);
  }
  const rows: GamePaceRow[] = [];
  for (const [key, seats] of byGame) {
    const winners = seats.filter((pg) => pg.won);
    const winnerFeatures = new Set<string>();
    for (const w of winners) for (const f of w.features) winnerFeatures.add(f);
    const anyFeatures = new Set<string>();
    for (const s of seats) for (const f of s.features) anyFeatures.add(f);
    rows.push({
      length: turnsPerGame.get(key) ?? 0,
      decisive: winners.length === 1 && !seats[0]!.is_tie,
      winnerFeatures,
      anyFeatures,
    });
  }
  return rows;
}

// Significant positive associations between group membership and feature
// presence: share of group games containing the feature vs the same share in
// the comparison games, kept only when the 95% Newcombe CI excludes 0.
function paceAssociations(
  group: Set<string>[],
  rest: Set<string>[],
  minGroup: number,
): PaceAssociation[] {
  if (group.length < minGroup || rest.length < minGroup) return [];
  const universe = new Set<string>();
  for (const s of group) for (const f of s) universe.add(f);
  const out: PaceAssociation[] = [];
  for (const feature of universe) {
    const inGroup = group.filter((s) => s.has(feature)).length;
    const inRest = rest.filter((s) => s.has(feature)).length;
    const rGroup = rate(inGroup, group.length);
    const rRest = rate(inRest, rest.length);
    const ci = newcombeDiffInterval(inGroup, group.length, inRest, rest.length);
    if (ci.low <= 0) continue; // keep significant OVER-representation only
    out.push({
      feature,
      n_group: group.length,
      rate_group: rGroup,
      n_rest: rest.length,
      rate_rest: rRest,
      diff: rGroup - rRest,
      diff_ci: ci,
    });
  }
  return out.sort((a, b) => b.diff - a.diff);
}

function computePace(playerGames: PlayerGame[], turnsPerGame: Map<string, number>): PaceStats {
  const rows = paceRows(playerGames, turnsPerGame);
  const decisive = rows.filter((r) => r.decisive);
  const decisiveLengths = decisive.map((r) => r.length).sort((a, b) => a - b);
  const allLengths = rows.map((r) => r.length).sort((a, b) => a - b);
  const fastMax = percentile(decisiveLengths, 0.25);
  const longMin = percentile(allLengths, 0.75);

  const fast = decisive.filter((r) => r.length <= fastMax);
  const decisiveRest = decisive.filter((r) => r.length > fastMax);
  const long = rows.filter((r) => r.length >= longMin);
  const shortRest = rows.filter((r) => r.length < longMin);

  return {
    fast_max_turns: fastMax,
    long_min_turns: longMin,
    n_fast: fast.length,
    n_decisive_rest: decisiveRest.length,
    n_long: long.length,
    n_short_rest: shortRest.length,
    fast_finishers: paceAssociations(
      fast.map((r) => r.winnerFeatures),
      decisiveRest.map((r) => r.winnerFeatures),
      10,
    ),
    drag_features: paceAssociations(
      long.map((r) => r.anyFeatures),
      shortRest.map((r) => r.anyFeatures),
      10,
    ),
  };
}

// ---------- §3.5 combo synergy ----------

const COMBO_MAX_FEATURES = 40; // pair space cap: 40 → 780 pairs
const COMBO_MIN_CELL = 20; // both/neither cells must clear this
const COMBO_MIN_SINGLE = 15; // A-only/B-only cells must clear this

function comboEligible(feature: string, lift: FeatureLift | undefined): boolean {
  if (!lift) return false;
  const kind = feature.slice(0, feature.indexOf(':'));
  if (kind !== 'play' && kind !== 'buy' && kind !== 'action') return false;
  // Need a real counterfactual on both sides of "used".
  return lift.n_used >= 30 && lift.usage_rate <= 0.95;
}

function featureAvailableTo(pg: PlayerGame, feature: string): boolean {
  return !isCardFeature(feature) || pg.availableCards.has(cardOfFeature(feature));
}

function computeCombos(playerGames: PlayerGame[], featureLift: FeatureLift[]): ComboSynergy[] {
  const byFeature = new Map(featureLift.map((f) => [f.feature, f]));
  const candidates = featureLift
    .filter((f) => comboEligible(f.feature, byFeature.get(f.feature)))
    .sort((a, b) => b.n_used - a.n_used)
    .slice(0, COMBO_MAX_FEATURES)
    .map((f) => f.feature);

  const out: ComboSynergy[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      // buy:X + play:X of the same card is a tautology (playing implies buying),
      // not a combo — the A-only/B-only cells degenerate.
      if (isCardFeature(a) && isCardFeature(b) && cardOfFeature(a) === cardOfFeature(b)) continue;
      let nBoth = 0;
      let wBoth = 0;
      let nA = 0;
      let wA = 0;
      let nB = 0;
      let wB = 0;
      let nNone = 0;
      let wNone = 0;
      for (const pg of playerGames) {
        if (!featureAvailableTo(pg, a) || !featureAvailableTo(pg, b)) continue;
        const hasA = pg.features.has(a);
        const hasB = pg.features.has(b);
        const w = pg.won ? 1 : 0;
        if (hasA && hasB) {
          nBoth += 1;
          wBoth += w;
        } else if (hasA) {
          nA += 1;
          wA += w;
        } else if (hasB) {
          nB += 1;
          wB += w;
        } else {
          nNone += 1;
          wNone += w;
        }
      }
      if (nBoth < COMBO_MIN_CELL || nNone < COMBO_MIN_CELL || nA < COMBO_MIN_SINGLE || nB < COMBO_MIN_SINGLE) {
        continue;
      }
      const pBoth = rate(wBoth, nBoth);
      const pA = rate(wA, nA);
      const pB = rate(wB, nB);
      const pNone = rate(wNone, nNone);
      const interaction = pBoth - pA - pB + pNone;
      // Normal approximation on the four independent cells.
      const se = Math.sqrt(
        (pBoth * (1 - pBoth)) / nBoth +
          (pA * (1 - pA)) / nA +
          (pB * (1 - pB)) / nB +
          (pNone * (1 - pNone)) / nNone,
      );
      const ci: Interval = { low: interaction - Z_95 * se, high: interaction + Z_95 * se };
      if (ci.low <= 0) continue; // keep super-additive pairs only
      // "Breaks the game" needs the pair to actually WIN, not merely be less bad
      // than its parts predict: two awful cards whose badness doesn't stack (e.g.
      // paired defensive duds at 8% WR) show positive interaction too. Require
      // the combined win rate to beat the no-combo baseline.
      if (pBoth <= pNone) continue;
      out.push({
        feature_a: a,
        feature_b: b,
        n_both: nBoth,
        wr_both: pBoth,
        wr_both_ci: wilsonInterval(wBoth, nBoth),
        n_a_only: nA,
        wr_a_only: pA,
        n_b_only: nB,
        wr_b_only: pB,
        n_neither: nNone,
        wr_neither: pNone,
        interaction,
        interaction_ci: ci,
      });
    }
  }
  return out.sort((x, y) => y.interaction - x.interaction).slice(0, 15);
}

// ---------- §4 temporal (decisiveness + lead stability) ----------

const DECILES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

// Compute §4 metrics from per-turn score traces. Returns undefined unless the
// batch carries traces (a --trace run) AND the game declares a leaderScalar — we
// do NOT invent a leader from an unknown scoreboard (summing unrelated resources
// would be misleading; see the override doc).
function computeTemporal(records: GameRecord[]): TemporalStats | undefined {
  const traced = records.filter((r) => !r.error && r.score_trace && r.score_trace.length > 0);
  if (traced.length === 0) return undefined;
  const override = devHooksFor(traced[0]!.game_id).analysis;
  const leaderScalar = override?.leaderScalar;
  if (!leaderScalar) return undefined;

  // The single leader in a snapshot, or null when the top scalar is tied.
  const leaderOf = (snap: Record<string, Record<string, number>>): string | null => {
    let best: string | null = null;
    let bestVal = -Infinity;
    let tied = false;
    for (const [pid, row] of Object.entries(snap)) {
      const v = leaderScalar(row);
      if (v > bestVal) {
        bestVal = v;
        best = pid;
        tied = false;
      } else if (v === bestVal) {
        tied = true;
      }
    }
    return tied ? null : best;
  };

  const trailing: number[] = [];
  const changes: number[] = [];
  const dec = DECILES.map(() => ({ correct: 0, n: 0 }));

  for (const r of traced) {
    // Decisiveness + trailing both reference the eventual winner, so need exactly one.
    if (r.result.winners.length !== 1) continue;
    const winner = r.result.winners[0]!;
    const trace = r.score_trace!;
    let nTrailing = 0; // snapshots where the winner is STRICTLY behind someone
    let nChanges = 0; // genuine lead swaps between distinct players
    let lastLeader: string | undefined; // last non-tied leader seen
    for (const snap of trace) {
      // Trailing = some OTHER player strictly outscores the eventual winner. A
      // tie-at-the-top (early 0–0 Dragonwood opening) is NOT trailing — nobody is
      // ahead — so the comeback signal isn't swamped by the scoreless opening.
      const winnerVal = leaderScalar(snap[winner] ?? {});
      const behind = Object.entries(snap).some(([pid, row]) => pid !== winner && leaderScalar(row) > winnerVal);
      if (behind) nTrailing += 1;
      // Lead change = the strict (untied) leader becomes a DIFFERENT player.
      // Tie states (null) don't reset or count, so tie-flicker isn't swinginess.
      const ld = leaderOf(snap);
      if (ld !== null) {
        if (lastLeader !== undefined && ld !== lastLeader) nChanges += 1;
        lastLeader = ld;
      }
    }
    trailing.push(nTrailing);
    changes.push(nChanges);
    const n = trace.length;
    DECILES.forEach((f, di) => {
      const idx = Math.min(n - 1, Math.floor((n - 1) * f));
      const ld = leaderOf(trace[idx]!);
      dec[di]!.n += 1;
      if (ld === winner) dec[di]!.correct += 1;
    });
  }
  if (trailing.length === 0) return undefined;

  return {
    n_games: trailing.length,
    turns_trailing_winner: summarizeDistribution(trailing),
    lead_changes: summarizeDistribution(changes),
    decisiveness: DECILES.map((f, di) => ({
      progress: f,
      accuracy: rate(dec[di]!.correct, dec[di]!.n),
      n: dec[di]!.n,
      ci: wilsonInterval(dec[di]!.correct, dec[di]!.n),
    })),
  };
}

export function analyzeBatch(records: GameRecord[], opts?: AnalyzeOpts): BatchAnalysis {
  const nailBiterMax = opts?.nailBiterMax ?? 0.1;
  const routMin = opts?.routMin ?? 0.5;
  const errored = records.filter((r) => r.error).length;
  const scored = records.filter((r) => !r.error);
  const playerGames = scored.flatMap(toPlayerGames);

  // Outcomes.
  const ties = scored.filter((r) => r.result.winners.length !== 1).length;
  const stalemates = scored.filter((r) => r.timeout).length;
  const playerCount = scored[0]?.players.length ?? 2;
  const allTurns = playerGames.flatMap((pg) => pg.turns);
  const deadTurns = allTurns.filter((t) => t.is_dead).length;
  const totalPlayerTurns = allTurns.length;

  // §5 game length — player-turns per game (the distribution behind avg_player_turns).
  const turnsPerGame = new Map<string, number>();
  for (const pg of playerGames) {
    const key = `${pg.game_id}:${pg.seed}`;
    turnsPerGame.set(key, (turnsPerGame.get(key) ?? 0) + pg.turns.length);
  }
  const gameLength = summarizeDistribution([...turnsPerGame.values()]);

  // §5 margin of victory — final score gap over DECISIVE, non-stalemate games.
  // Stalemates (round-cap draws, degenerate 0–0) are excluded so they don't read
  // as "nail-biters". A real simultaneous-KO tie stays in as a 0-margin game.
  const marginValues: number[] = [];
  let nailBiters = 0;
  let routs = 0;
  let exactTies = 0;
  for (const r of scored) {
    if (r.timeout) continue;
    const vals = Object.values(r.result.scores).sort((a, b) => b - a);
    if (vals.length < 2) continue;
    const gap = vals[0]! - vals[1]!;
    marginValues.push(gap);
    const normalized = vals[0]! > 0 ? gap / vals[0]! : 0;
    if (gap === 0) exactTies += 1;
    if (normalized <= nailBiterMax) nailBiters += 1;
    if (normalized >= routMin) routs += 1;
  }
  const margin: MarginStats = {
    distribution: summarizeDistribution(marginValues),
    nail_biter_max: nailBiterMax,
    rout_min: routMin,
    nail_biter_share: rate(nailBiters, marginValues.length),
    nail_biter_ci: wilsonInterval(nailBiters, marginValues.length),
    rout_share: rate(routs, marginValues.length),
    rout_ci: wilsonInterval(routs, marginValues.length),
    exact_tie_share: rate(exactTies, marginValues.length),
  };

  // Dead-turn rate by difficulty.
  const byDiff = new Map<string, { dead: number; total: number }>();
  for (const t of allTurns) {
    const key = t.difficulty ?? 'unknown';
    const slot = byDiff.get(key) ?? { dead: 0, total: 0 };
    slot.total += 1;
    if (t.is_dead) slot.dead += 1;
    byDiff.set(key, slot);
  }
  const deadByDiff: Record<string, number> = {};
  for (const [k, v] of byDiff) deadByDiff[k] = rate(v.dead, v.total);

  // Seat outcomes (initiative advantage). Seat index is the position in the
  // game's playerOrder, independent of which AI identity sat there.
  const seatAgg = new Map<number, { games: number; wins: number }>();
  for (const pg of playerGames) {
    const slot = seatAgg.get(pg.seat_index) ?? { games: 0, wins: 0 };
    slot.games += 1;
    if (pg.won) slot.wins += 1;
    seatAgg.set(pg.seat_index, slot);
  }
  const seatOutcomes: SeatOutcome[] = [...seatAgg.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seat, v]) => ({
      seat_index: seat,
      games: v.games,
      win_rate: rate(v.wins, v.games),
      win_rate_ci: wilsonInterval(v.wins, v.games),
    }));

  // Feature lift. For each feature, partition the player-games where it was
  // available into used / not-used and compare win rates.
  interface Agg {
    available: number;
    used: number;
    winsUsed: number;
    winsNotUsed: number;
  }
  const agg = new Map<string, Agg>();
  // Universe of feature keys observed anywhere.
  const universe = new Set<string>();
  for (const pg of playerGames) for (const k of pg.features) universe.add(k);

  for (const pg of playerGames) {
    for (const key of universe) {
      // Availability gate: card features only count when the card was in pool.
      if (isCardFeature(key) && !pg.availableCards.has(cardOfFeature(key))) continue;
      const slot = agg.get(key) ?? { available: 0, used: 0, winsUsed: 0, winsNotUsed: 0 };
      slot.available += 1;
      if (pg.features.has(key)) {
        slot.used += 1;
        if (pg.won) slot.winsUsed += 1;
      } else if (pg.won) {
        slot.winsNotUsed += 1;
      }
      agg.set(key, slot);
    }
  }

  const featureLift: FeatureLift[] = [...agg.entries()]
    .map(([feature, v]) => {
      const nNot = v.available - v.used;
      const wrUsed = rate(v.winsUsed, v.used);
      const wrNot = rate(v.winsNotUsed, nNot);
      return {
        feature,
        n_available: v.available,
        n_used: v.used,
        usage_rate: rate(v.used, v.available),
        win_rate_used: wrUsed,
        win_rate_used_ci: wilsonInterval(v.winsUsed, v.used),
        win_rate_not_used: wrNot,
        lift: wrUsed - wrNot,
        lift_ci: newcombeDiffInterval(v.winsUsed, v.used, v.winsNotUsed, nNot),
      };
    })
    // Highest positive lift first; that's the "strong" end of the list.
    .sort((a, b) => b.lift - a.lift);

  // §3.3 acquire-to-play — count play_card vs buy_card per card across the batch.
  const playCounts = new Map<string, number>();
  const buyCounts = new Map<string, number>();
  for (const r of scored) {
    for (const m of r.moves) {
      const c = moveCardId(m);
      if (!c) continue;
      const t = moveType(m);
      if (t === 'play_card') playCounts.set(c, (playCounts.get(c) ?? 0) + 1);
      else if (t === 'buy_card') buyCounts.set(c, (buyCounts.get(c) ?? 0) + 1);
    }
  }
  const acquireToPlay: AcquireToPlay[] = [...buyCounts.entries()]
    .map(([card, acquired]) => {
      const played = playCounts.get(card) ?? 0;
      return { card, acquired, played, a2p: rate(played, acquired) };
    })
    // Lowest ratio first — the dead-purchase end of the list.
    .sort((a, b) => a.a2p - b.a2p);

  return {
    games_total: records.length,
    games_errored: errored,
    games_scored: scored.length,
    tie_rate: rate(ties, scored.length),
    stalemate_rate: rate(stalemates, scored.length),
    avg_player_turns: rate(totalPlayerTurns, scored.length),
    avg_rounds: rate(totalPlayerTurns, scored.length * Math.max(1, playerCount)),
    game_length: gameLength,
    margin,
    dead_turn_rate: rate(deadTurns, totalPlayerTurns),
    dead_turn_rate_by_difficulty: deadByDiff,
    seat_outcomes: seatOutcomes,
    feature_lift: featureLift,
    acquire_to_play: acquireToPlay,
    matchups: computeMatchups(playerGames),
    pace: computePace(playerGames, turnsPerGame),
    combos: computeCombos(playerGames, featureLift),
    temporal: computeTemporal(scored),
  };
}

// ---------- markdown rendering ----------

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function signedPct(x: number): string {
  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
}
function ciPct(ci: Interval): string {
  return `[${pct(ci.low)}, ${pct(ci.high)}]`;
}
function num(x: number, digits = 2): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(digits);
}

// §5 distribution — quartile summary + a compact ASCII histogram. The §5 point is
// that the SHAPE matters: a bimodal length or an all-routs margin is invisible in
// the mean alone, so we always show the histogram next to the median/IQR.
function renderDistribution(d: Distribution, unit: string): string[] {
  const lines: string[] = [];
  if (d.n === 0) {
    lines.push('_(no data)_');
    return lines;
  }
  lines.push(
    `median ${num(d.median)} ${unit} (95% CI [${num(d.median_ci.low)}, ${num(d.median_ci.high)}]) · ` +
      `IQR [${num(d.p25)}, ${num(d.p75)}] · range [${num(d.min)}, ${num(d.max)}] · ` +
      `mean ${num(d.mean)} (N=${d.n})\n`,
  );
  const peak = Math.max(...d.histogram.map((b) => b.count), 1);
  lines.push('| Range | Count | |');
  lines.push('|-------|-------|--|');
  for (const b of d.histogram) {
    const bar = '▇'.repeat(Math.round((b.count / peak) * 24));
    const range = b.lo === b.hi ? num(b.lo) : `${num(b.lo)}–${num(b.hi)}`;
    lines.push(`| ${range} | ${b.count} | ${bar} |`);
  }
  return lines;
}

// §4 temporal — decisiveness curve + lead stability. Rendered only for a --trace
// run of a game with a leaderScalar override; otherwise a one-line hint so the
// reader knows the section exists and how to enable it.
function renderTemporal(t: TemporalStats | undefined): string[] {
  const lines: string[] = ['\n### Temporal — decisiveness & lead stability (§4)\n'];
  if (!t) {
    lines.push(
      '_Not computed. Re-run with `--trace` on a game whose `analysis.ts` override defines ' +
        '`leaderScalar` (the per-turn "who is ahead" scalar). The harness will not guess a leader ' +
        'from an unknown scoreboard._',
    );
    return lines;
  }
  // §4.2 lead stability.
  lines.push(
    `Over ${t.n_games} decisive traced games. **Mean turns the eventual winner spent NOT leading: ` +
      `${num(t.turns_trailing_winner.mean)}** (median ${num(t.turns_trailing_winner.median)}) — ` +
      `≈0 ⇒ runaway leader, higher ⇒ comeback-friendly. **Mean lead changes/game: ` +
      `${num(t.lead_changes.mean)}** (swinginess).\n`,
  );
  // §4.1 decisiveness curve.
  lines.push(
    'Decisiveness = how often the current leader (by the during-play `leaderScalar`) is the eventual ' +
      'winner, by game progress. Where accuracy first jumps to ~90% is where the game is effectively ' +
      'decided — if that is early, the game snowballs; if it stays near 50% until the end, the leader is ' +
      'a poor predictor and the game is swingy. The 100%-progress point can sit below 100% when the ' +
      'winner is set by end-only scoring or a tiebreaker the mid-game scoreboard does not show — that ' +
      'residual is itself a "decided at the buzzer" signal. 95% CI is Wilson.\n',
  );
  lines.push('| Progress | Decisiveness | 95% CI | N |');
  lines.push('|----------|--------------|--------|---|');
  for (const p of t.decisiveness) {
    lines.push(`| ${pct(p.progress)} | ${pct(p.accuracy)} | ${ciPct(p.ci)} | ${p.n} |`);
  }
  return lines;
}

// §2.2 matchup matrices — one table per identity/strategy dimension. Each cell is
// row-category's win rate vs column-category, with N and a ±95% half-width. Cells
// thinner than minSample are greyed (shown as "·") per §6.2 — a confident-looking
// number backed by a handful of games is worse than a visible gap.
function renderMatchups(matchups: MatchupMatrix[], minSample: number): string[] {
  if (matchups.length === 0) return [];
  const lines: string[] = [];
  for (const m of matchups) {
    const label = m.dimension === 'difficulty' ? 'skill (Run B)' : m.dimension;
    lines.push(`\n### Matchup matrix — ${label} (row vs column win rate)\n`);
    lines.push(
      `Cell = row category's win rate in games containing the column category, with N and ±95% (Wilson). ` +
        `Cells with N < ${minSample} are shown as "·" (too thin to read). For 2-player batches each cell is ` +
        `the exact matchup(row, col); the diagonal is the mirror. A row that beats every column is a dominance ` +
        `problem even if aggregate win rates look balanced.\n`,
    );
    const header = ['row \\ col', ...m.categories];
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`|${header.map(() => '---').join('|')}|`);
    for (const a of m.categories) {
      const row = [a];
      for (const b of m.categories) {
        const cell = m.cells[a]?.[b];
        if (!cell || cell.games === 0) {
          row.push('—');
        } else if (cell.games < minSample) {
          row.push(`· (N=${cell.games})`);
        } else {
          row.push(`${pct(cell.win_rate)} ±${halfWidthPct(cell.win_rate, cell.ci)} (N=${cell.games})`);
        }
      }
      lines.push(`| ${row.join(' | ')} |`);
    }
    // §0/§2.2 meta read — only meaningful for an identity/strategy dimension with
    // ≥3 categories (a full matchup matrix). Skip the skill (difficulty) dimension.
    if (m.dimension !== 'difficulty' && m.categories.length >= 3) {
      lines.push(...renderMeta(m));
    }
  }
  return lines;
}

// "Does this dimension have a meta?" — Nash support + Hodge cycles (§0/§2.2).
function renderMeta(m: MatchupMatrix): string[] {
  const meta = m.meta;
  const lines: string[] = [`\n#### Meta — ${m.dimension}: does a diverse strategy space exist?\n`];
  // Nash mix, highest weight first.
  const mix = meta.categories
    .map((c) => `${c} ${pct(meta.nash[c] ?? 0)}`)
    .sort((x, y) => parseFloat(y.split(' ').pop()!) - parseFloat(x.split(' ').pop()!));
  lines.push(`**Nash equilibrium (expected field):** ${mix.join(' · ')}.`);
  lines.push(
    `**Viable set (Nash support):** ${meta.viable.join(', ') || '—'}` +
      (meta.dead.length ? ` · **dead (lose every matchup):** ${meta.dead.join(', ')}` : '') +
      '.',
  );
  // Health verdict keys on the VIABLE-SET SIZE (the Nash support — the chosen
  // definition of viability), not the Condorcet check alone: with frequent ties or
  // a near-cycle, the equilibrium can collapse onto one strategy WITHOUT a strict
  // Condorcet winner, and "1 viable" is unhealthy regardless.
  if (meta.viable.length <= 1) {
    const only = meta.viable[0] ?? '(none)';
    const why = meta.dominant
      ? `${only} is a Condorcet winner (beats every faction head-to-head)`
      : `the equilibrium collapses onto ${only} even without a strict beats-all winner`;
    lines.push(`⚠ **Effectively ONE viable strategy** — ${why}. NOT a healthy meta.`);
  } else {
    lines.push(
      `**${meta.viable.length} viable strategies** share the Nash equilibrium, no single dominant line ` +
        `(a healthy sign).`,
    );
  }
  const texture =
    meta.cyclicity > 0.5 ? 'rock-paper-scissors (counterplay)' : meta.transitivity > 0.7 ? 'a power ladder' : 'mixed';
  lines.push(
    `**Texture:** ${pct(meta.transitivity)} transitive / ${pct(meta.cyclicity)} cyclic — ${texture}` +
      (meta.topCycle ? `; cycle: ${meta.topCycle.join(' → ')} → ${meta.topCycle[0]}` : '') +
      '.',
  );
  lines.push(
    `_Viable = Nash-equilibrium support (weight ≥ 5%). Cyclicity is the Hodge rock-paper-scissors share — a strong (not required) sign of a healthy meta._`,
  );
  return lines;
}

export function renderBatchAnalysis(a: BatchAnalysis, opts?: { minSample?: number }): string {
  const minSample = opts?.minSample ?? 20;
  const lines: string[] = [];

  lines.push('\n### Game length & dead turns\n');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Games scored | ${a.games_scored} (of ${a.games_total}, ${a.games_errored} errored) |`);
  lines.push(`| Tie rate | ${pct(a.tie_rate)} |`);
  lines.push(`| ↳ of which non-terminating (stalemate or move-loop) | ${pct(a.stalemate_rate)} |`);
  lines.push(`| Avg rounds / game | ${num(a.avg_rounds)} |`);
  lines.push(`| Avg player-turns / game | ${num(a.avg_player_turns)} |`);
  lines.push(`| Dead-turn rate (overall) | ${pct(a.dead_turn_rate)} |`);
  for (const [diff, r] of Object.entries(a.dead_turn_rate_by_difficulty)) {
    lines.push(`| Dead-turn rate (${diff}) | ${pct(r)} |`);
  }

  // §5 game-shape distributions — the histograms behind the means above. A
  // bimodal length or an all-routs margin only shows here, never in the mean.
  lines.push('\n### Game length distribution (§5, player-turns per game)\n');
  lines.push('A bimodal shape = a fast-rush line and a slow-grind line hiding in one ruleset.\n');
  lines.push(...renderDistribution(a.game_length, 'turns'));

  const m = a.margin;
  lines.push('\n### Margin of victory distribution (§5, final score gap)\n');
  lines.push(
    `Over decisive non-stalemate games. Nail-biter = won by ≤${pct(m.nail_biter_max)} of the winner's score; ` +
      `rout = won by ≥${pct(m.rout_min)} (normalized so the thresholds are scale-free; designer-tunable).\n`,
  );
  lines.push(
    `**Nail-biter share ${pct(m.nail_biter_share)}** ${ciPct(m.nail_biter_ci)} · ` +
      `**rout share ${pct(m.rout_share)}** ${ciPct(m.rout_ci)} · exact ties ${pct(m.exact_tie_share)} ` +
      `(95% Wilson). Two batches with the same mean margin can sit at opposite ends of these — ` +
      `read the shape, not the mean.\n`,
  );
  lines.push(...renderDistribution(m.distribution, 'pts'));

  // §5.1 pace associations — what ends games quickly / what makes them drag.
  const p = a.pace;
  lines.push('\n### Pace — what ends games quickly, what makes them drag (§5.1)\n');
  lines.push(
    `Fast = decisive games ≤ ${num(p.fast_max_turns)} player-turns (P25 of decisive, N=${p.n_fast}); ` +
      `long = games ≥ ${num(p.long_min_turns)} player-turns (P75 of all scored, stalemates included, N=${p.n_long}). ` +
      `Rows are significant over-representations only (95% Newcombe excludes 0); association, not causation.\n`,
  );
  if (p.fast_finishers.length === 0) {
    lines.push('_No feature of the winner is significantly over-represented in fast games._');
  } else {
    lines.push('**Fast finishers — the winner used these more often in fast games:**\n');
    lines.push('| Feature | In fast wins | In other wins | Diff | 95% CI |');
    lines.push('|---------|-------------|---------------|------|--------|');
    for (const f of p.fast_finishers) {
      lines.push(
        `| ${f.feature} | ${pct(f.rate_group)} | ${pct(f.rate_rest)} | ${signedPct(f.diff)} | ${signedPct(
          f.diff_ci.low,
        )}, ${signedPct(f.diff_ci.high)} |`,
      );
    }
  }
  if (p.drag_features.length === 0) {
    lines.push('\n_No feature is significantly over-represented in long games._');
  } else {
    lines.push('\n**Drag suspects — present (either side) more often in long games:**\n');
    lines.push('| Feature | In long games | In shorter games | Diff | 95% CI |');
    lines.push('|---------|---------------|------------------|------|--------|');
    for (const f of p.drag_features) {
      lines.push(
        `| ${f.feature} | ${pct(f.rate_group)} | ${pct(f.rate_rest)} | ${signedPct(f.diff)} | ${signedPct(
          f.diff_ci.low,
        )}, ${signedPct(f.diff_ci.high)} |`,
      );
    }
  }

  // §3.5 combo synergy — super-additive pairs.
  lines.push('\n### Combo synergy — pairs worth more than the sum of their parts (§3.5)\n');
  lines.push(
    'Interaction = WR(both) − WR(A only) − WR(B only) + WR(neither), over player-games where both were',
    'available. Zero = additive; significantly positive = a super-additive pair (candidate broken combo).',
    'Only positive-significant pairs are listed — an empty section means no pair beats the sum of its parts.\n',
  );
  if (a.combos.length === 0) {
    lines.push('_No significantly super-additive pair found._');
  } else {
    lines.push('| A + B | WR both (N) | WR A only | WR B only | WR neither | Interaction | 95% CI |');
    lines.push('|-------|-------------|-----------|-----------|------------|-------------|--------|');
    for (const c of a.combos) {
      lines.push(
        `| ${c.feature_a} + ${c.feature_b} | ${pct(c.wr_both)} (${c.n_both}) | ${pct(c.wr_a_only)} | ${pct(
          c.wr_b_only,
        )} | ${pct(c.wr_neither)} | ${signedPct(c.interaction)} | ${signedPct(c.interaction_ci.low)}, ${signedPct(
          c.interaction_ci.high,
        )} |`,
      );
    }
  }

  lines.push(...renderTemporal(a.temporal));

  lines.push('\n### Win rate by seat (initiative advantage)\n');
  lines.push('95% CI is the Wilson interval — a seat advantage is only real if its CI excludes 50%.\n');
  lines.push('| Seat | Games | Win rate | 95% CI |');
  lines.push('|------|-------|----------|--------|');
  for (const s of a.seat_outcomes) {
    const label = s.seat_index === 0 ? `${s.seat_index} (initiative)` : String(s.seat_index);
    lines.push(`| ${label} | ${s.games} | ${pct(s.win_rate)} | ${ciPct(s.win_rate_ci)} |`);
  }

  // Card / action value. Gate on sample size so thin cells don't read as signal.
  const ranked = a.feature_lift.filter((f) => f.n_used >= minSample && f.n_available - f.n_used >= minSample);
  lines.push(`\n### Card / action value — usage → win-rate lift (n_used ≥ ${minSample} both sides)\n`);
  lines.push('Lift = win rate when the player used the feature ≥ 1× minus win rate when available but unused.');
  lines.push('Positive = winners use it more (candidate dominant card); near-zero/negative = weak or trap.');
  lines.push('Lift 95% CI is the Newcombe interval on the difference; ✓ marks lift whose CI excludes 0');
  lines.push('(significant at 95%). An unmarked row is within sampling noise — do not act on it.');
  lines.push('CAVEAT: significance is not causation. A move only LEGAL when behind (e.g. focus_reload) shows');
  lines.push('large — and significant — NEGATIVE lift because it is a symptom of losing, not a cause.\n');
  lines.push('| Feature | Avail | Usage | WR used (±95%) | WR unused | Lift | Lift 95% CI | sig |');
  lines.push('|---------|-------|-------|---------------|-----------|------|-------------|-----|');
  for (const f of ranked) {
    const sig = f.lift_ci.low > 0 || f.lift_ci.high < 0 ? '✓' : '';
    lines.push(
      `| ${f.feature} | ${f.n_available} | ${pct(f.usage_rate)} | ${pct(f.win_rate_used)} ±${halfWidthPct(
        f.win_rate_used,
        f.win_rate_used_ci,
      )} | ${pct(f.win_rate_not_used)} | ${signedPct(f.lift)} | ${signedPct(f.lift_ci.low)}, ${signedPct(
        f.lift_ci.high,
      )} | ${sig} |`,
    );
  }

  lines.push(...renderMatchups(a.matchups, minSample));

  // Under-used cards: available a lot, almost never used (candidate "useless").
  const underused = a.feature_lift
    .filter((f) => f.feature.startsWith('buy:') && f.n_available >= minSample && f.usage_rate < 0.05)
    .sort((x, y) => x.usage_rate - y.usage_rate);
  if (underused.length > 0) {
    lines.push('\n### Rarely-bought available cards (candidate "useless")\n');
    lines.push('| Card | Available | Usage rate |');
    lines.push('|------|-----------|------------|');
    for (const f of underused) {
      lines.push(`| ${cardOfFeature(f.feature)} | ${f.n_available} | ${pct(f.usage_rate)} |`);
    }
  }

  // §3.3 acquire-to-play — only meaningful when the game has bought cards.
  const a2p = a.acquire_to_play.filter((x) => x.acquired >= minSample);
  if (a2p.length > 0) {
    lines.push(`\n### Acquire-to-play ratio (§3.3, dead-purchase detector; acquired ≥ ${minSample})\n`);
    lines.push('plays ÷ acquisitions across the batch. ≈0 = bought but left unplayed (a dead purchase);');
    lines.push('≥1 = a reusable card pulling its weight. A card with strong lift WHEN played but a low');
    lines.push('ratio is powerful-but-situational, a different note than a simply weak card.\n');
    lines.push('| Card | Acquired | Played | plays/acq |');
    lines.push('|------|----------|--------|-----------|');
    for (const x of a2p) {
      lines.push(`| ${x.card} | ${x.acquired} | ${x.played} | ${num(x.a2p)} |`);
    }
  }

  return lines.join('\n') + '\n';
}
