// "Does the game have a meta?" — metagame analysis over a strategy matchup matrix
// (BALANCE-METRIC-DEFINITIONS §0/§2.2). Game-agnostic: pure math over a square
// win-rate matrix, so it works for any game's faction/strategy dimension.
//
// Three questions, three measures:
//   1. Is there a DOMINANT strategy? (Condorcet winner — beats every other > 50%.)
//      A dominant strategy means "no meta — just play it."
//   2. How many strategies are VIABLE? — the support of the NASH EQUILIBRIUM of
//      the matchup matrix treated as a symmetric zero-sum game. Support = 1 ⇒
//      degenerate; support >= 2 with real weight ⇒ a genuine meta. Strategies the
//      equilibrium gives ~0 weight are DEAD (dominated). This is the principled,
//      cross-game definition of "the viable set" + "the expected field".
//   3. Is the meta a CYCLE or a LADDER? — the Helmholtz–Hodge decomposition splits
//      the (skew-symmetric) advantage matrix into a transitive (power-ranking)
//      part and a cyclic (rock-paper-scissors) part. High cyclicity = counterplay
//      meta; pure transitivity = a tier list. (Insight, not a pass/fail gate.)
//
// References: empirical game-theoretic analysis ("Nash of the payoff matrix") and
// HodgeRank / Balduzzi et al. "Re-evaluating evaluation" use exactly this pairing.

export interface MetaAnalysis {
  categories: string[];
  // Nash equilibrium mix over the strategies (sums to 1). The "expected field".
  nash: Record<string, number>;
  // Support of the Nash equilibrium (weight >= viabilityFloor) — the viable set.
  viable: string[];
  // Strategies the equilibrium drops to ~0 weight — dead/dominated.
  dead: string[];
  // A Condorcet winner (beats every other strategy > 50% on point estimate), or null.
  dominant: string | null;
  // Hodge decomposition of the advantage matrix (fractions, sum ~1).
  transitivity: number; // power-ladder share of the matchup structure
  cyclicity: number; // rock-paper-scissors share
  // A representative 3-cycle a→b→c→a (each beats the next > 50%), or null if none.
  topCycle: string[] | null;
}

export interface MetaOptions {
  // Minimum Nash weight to count a strategy as viable. Default 5%.
  viabilityFloor?: number;
  iters?: number; // multiplicative-weights iterations
}

// Nash equilibrium of a SYMMETRIC zero-sum game via multiplicative-weights (Hedge)
// self-play on the skew-symmetric advantage matrix A. For a zero-sum game the
// time-average of no-regret play converges to a Nash equilibrium; the symmetric
// game has value 0, and the average strategy is the maximin mix. Deterministic
// (no RNG), so the result is reproducible.
function nashEquilibrium(advantage: number[][], iters: number): number[] {
  const n = advantage.length;
  if (n === 0) return [];
  if (n === 1) return [1];
  let w = new Array<number>(n).fill(1);
  const avg = new Array<number>(n).fill(0);
  const eta = 0.5; // advantage entries are in [-1, 1], so this step size is stable
  for (let t = 0; t < iters; t++) {
    const sum = w.reduce((a, b) => a + b, 0);
    const p = w.map((x) => x / sum);
    for (let i = 0; i < n; i++) avg[i]! += p[i]!;
    // Expected advantage of each pure strategy i vs the current mix p.
    const g = advantage.map((row) => row.reduce((s, a, j) => s + a * p[j]!, 0));
    for (let i = 0; i < n; i++) w[i]! *= Math.exp(eta * g[i]!);
    // Renormalize to the max weight each step to avoid float overflow.
    const mx = Math.max(...w);
    if (mx > 0) for (let i = 0; i < n; i++) w[i]! /= mx;
  }
  const s = avg.reduce((a, b) => a + b, 0);
  return s > 0 ? avg.map((x) => x / s) : new Array<number>(n).fill(1 / n);
}

// Helmholtz–Hodge: transitive part T[i][j] = r_i - r_j where r_i = mean_j A[i][j]
// is the strategy's "rating"; cyclic part C = A - T. The two are orthogonal under
// the Frobenius inner product, so ||A||² = ||T||² + ||C||² and the fractions sum
// to 1. transitivity = ||T||²/||A||², cyclicity = ||C||²/||A||².
function hodgeSplit(advantage: number[][]): { transitivity: number; cyclicity: number } {
  const n = advantage.length;
  if (n < 2) return { transitivity: 1, cyclicity: 0 };
  const rating = advantage.map((row) => row.reduce((a, b) => a + b, 0) / n);
  let tNorm = 0;
  let cNorm = 0;
  let aNorm = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const a = advantage[i]![j]!;
      const tr = rating[i]! - rating[j]!;
      const cy = a - tr;
      aNorm += a * a;
      tNorm += tr * tr;
      cNorm += cy * cy;
    }
  }
  if (aNorm === 0) return { transitivity: 1, cyclicity: 0 };
  return { transitivity: tNorm / aNorm, cyclicity: cNorm / aNorm };
}

// Find a representative 3-cycle a→b→c→a (each strictly beats the next), if any.
function findCycle(labels: string[], winRate: number[][]): string[] | null {
  const n = labels.length;
  const beats = (i: number, j: number): boolean => winRate[i]![j]! > 0.5;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      for (let k = 0; k < n; k++) {
        if (k === i || k === j) continue;
        if (beats(i, j) && beats(j, k) && beats(k, i)) return [labels[i]!, labels[j]!, labels[k]!];
      }
    }
  }
  return null;
}

// winRate[i][j] = strategy i's win rate vs strategy j, in [0,1]. Diagonal ignored.
export function computeMeta(labels: string[], winRate: number[][], opts: MetaOptions = {}): MetaAnalysis {
  const floor = opts.viabilityFloor ?? 0.05;
  const iters = opts.iters ?? 20000;
  const n = labels.length;

  // Skew-symmetric advantage A[i][j] = wr(i,j) − wr(j,i) ∈ [−1, 1].
  const advantage = labels.map((_, i) =>
    labels.map((__, j) => (i === j ? 0 : winRate[i]![j]! - winRate[j]![i]!)),
  );

  const mix = nashEquilibrium(advantage, iters);
  const nash: Record<string, number> = {};
  labels.forEach((l, i) => (nash[l] = mix[i] ?? 0));
  const viable = labels.filter((l) => nash[l]! >= floor);

  // Compare strategies HEAD-TO-HEAD (advantage > 0 = i wins the pairing more often
  // than j), NOT against an absolute 50%. With frequent draws, the winner of a
  // pairing can sit below 50% absolute, so an absolute threshold would wrongly
  // report "no dominant strategy" while the Nash collapses to one — this is the
  // tie-robust, Nash-consistent basis.
  const beats = (i: number, j: number): boolean => advantage[i]![j]! > 0;

  // Condorcet winner: beats every other strategy head-to-head.
  let dominant: string | null = null;
  for (let i = 0; i < n; i++) {
    let beatsAll = true;
    for (let j = 0; j < n; j++) {
      if (i !== j && !beats(i, j)) {
        beatsAll = false;
        break;
      }
    }
    if (beatsAll) {
      dominant = labels[i]!;
      break;
    }
  }

  // Dead = strictly dominated by the field: loses (or ties) every matchup, and
  // loses at least one. These are non-viable for a reason distinct from "outside
  // the Nash support because some OTHER strategy dominates".
  const dead = labels.filter((_, i) => {
    let losesSome = false;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (beats(i, j)) return false; // wins a matchup ⇒ not strictly dominated
      if (advantage[i]![j]! < 0) losesSome = true;
    }
    return losesSome;
  });

  const { transitivity, cyclicity } = hodgeSplit(advantage);
  return {
    categories: labels,
    nash,
    viable,
    dead,
    dominant,
    transitivity,
    cyclicity,
    topCycle: findCycle(labels, winRate),
  };
}
