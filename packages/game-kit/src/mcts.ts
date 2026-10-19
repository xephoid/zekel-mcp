// Generic Monte Carlo Tree Search engine.
//
// Operates on the Game<State, Move, Options> interface directly (NOT through
// MCP roundtrips). A game opts in by implementing `getRewardForPlayer` plus
// optionally `selectRolloutMove`, `determinize`, `cloneState`,
// `getHeuristicValue` (see src/core/game.ts).
//
// Algorithm:
//   - UCB1 selection from root to a non-terminal frontier node.
//   - Expansion: add one child per call (lazy expansion).
//   - Simulation: random or heuristic rollout to a terminal state OR until
//     `maxRolloutPlies` is hit, at which point `getHeuristicValue` is used.
//   - Backpropagation: every node updates win counts for ALL players
//     (Max^N — supports >2-player games without modification).
//   - Hidden-info: if the game supplies `determinize`, every simulation
//     starts from a fresh sample. This is "single observer determinized
//     UCT" (SO-ISMCTS), the standard for hidden-info MCTS.
//
// Tuning knobs (`MCTSConfig`):
//   - `budget_ms`: wall-clock per decision (default 1000).
//   - `max_iterations`: hard cap on simulations (default Infinity).
//   - `ucb_c`: exploration constant (default √2).
//   - `max_rollout_plies`: cap rollout depth before using heuristic
//     fallback (default 200).
//
// Performance: each iteration is ~1 clone + N applyMove calls (= rollout
// depth). On medium-state games (around 30µs per clone) a
// 1-second budget yields ~400-1000 simulations. That's enough to clearly
// outperform 1-ply heuristics; not enough to compete with AlphaGo-tier
// engines, but no game in this repo demands that.

import type { Game, LegalMove, SessionState } from './game.js';

export interface MCTSConfig {
  budget_ms?: number;
  max_iterations?: number;
  ucb_c?: number;
  max_rollout_plies?: number;
  seed?: number;
}

export interface MCTSResult<Move> {
  move: Move;
  iterations: number;
  elapsed_ms: number;
  root_visits: number;
  // Per-candidate-move statistics, sorted by visit count (most-visited first).
  // Useful for debugging and harness instrumentation.
  candidates: Array<{
    move: Move;
    visits: number;
    avg_reward: number;
    ucb: number;
  }>;
}

interface MCTSNode<Move> {
  // Move that led from parent → this node. Null at the root.
  inboundMove: Move | null;
  // Whose turn it was at the PARENT — i.e., who chose this move.
  // Used during backprop to credit the right player.
  movingPlayer: string | null;
  // Children explored so far.
  children: Array<MCTSNode<Move>>;
  // Untried legal moves at this node's state. Lazy expansion drains this.
  untried: Array<LegalMove<Move>>;
  // Visit count.
  visits: number;
  // Sum of rewards backed up here, KEYED BY player_id. Max^N.
  rewardSum: Record<string, number>;
  // Cached: is this node terminal? Set after first visit.
  terminal: boolean;
  // Active player at this node (who picks the next move).
  activePlayerId: string;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function defaultClone<S>(state: SessionState<S>): SessionState<S> {
  return JSON.parse(JSON.stringify(state)) as SessionState<S>;
}

function defaultRolloutMove<S, M>(
  game: Game<S, M, unknown>,
  state: SessionState<S>,
  playerId: string,
  rng: () => number,
): M | null {
  const legal = game.getLegalMoves(state, playerId);
  if (legal.length === 0) return null;
  const pick = legal[Math.floor(rng() * legal.length)]!;
  return pick.move;
}

function defaultHeuristic(): number {
  return 0.5;
}

// One Max^N simulation from `rootState` (which has already been cloned and,
// for hidden-info games, determinized). Returns the final per-player reward
// map.
function simulate<S, M, O>(
  game: Game<S, M, O>,
  state: SessionState<S>,
  config: Required<MCTSConfig>,
  rng: () => number,
): Record<string, number> {
  let plies = 0;
  while (plies < config.max_rollout_plies) {
    const result = game.isGameOver(state);
    if (result !== null) {
      return rewardMap(game, state);
    }
    const pid = state.activePlayerId;
    const move = game.selectRolloutMove
      ? game.selectRolloutMove(state, pid)
      : defaultRolloutMove(game, state, pid, rng);
    if (move === null) {
      // No legal moves but not flagged terminal — bail.
      return rewardMap(game, state);
    }
    try {
      const applied = game.applyMove(state, pid, move);
      state = applied.newState;
    } catch {
      // Defensive: a misbehaving rollout policy proposed an illegal move.
      // Treat the run as a draw.
      return drawReward(state);
    }
    plies += 1;
  }
  // Rollout depth cut. Use heuristic fallback per player.
  const heur = game.getHeuristicValue ?? defaultHeuristic;
  const out: Record<string, number> = {};
  for (const p of state.players) {
    out[p.player_id] = heur(state, p.player_id);
  }
  return out;
}

function rewardMap<S, M, O>(
  game: Game<S, M, O>,
  state: SessionState<S>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const fn = game.getRewardForPlayer;
  if (!fn) {
    return drawReward(state);
  }
  for (const p of state.players) {
    out[p.player_id] = fn(state, p.player_id);
  }
  return out;
}

function drawReward<S>(state: SessionState<S>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of state.players) out[p.player_id] = 0.5;
  return out;
}

function newNode<S, M, O>(
  game: Game<S, M, O>,
  state: SessionState<S>,
  inboundMove: M | null,
  movingPlayer: string | null,
): MCTSNode<M> {
  const terminal = game.isGameOver(state) !== null;
  // Tree expansion uses the game's curated search-move set if it provides one
  // (prunes dominated moves the search would waste iterations on), else the
  // full legal set. The rollout policy and the human-facing legal set are
  // unaffected.
  const enumerate = game.getSearchMoves ?? game.getLegalMoves;
  const untried = terminal ? [] : enumerate.call(game, state, state.activePlayerId);
  return {
    inboundMove,
    movingPlayer,
    children: [],
    untried,
    visits: 0,
    rewardSum: {},
    terminal,
    activePlayerId: state.activePlayerId,
  };
}

function ucb1<M>(child: MCTSNode<M>, parentVisits: number, c: number): number {
  if (child.visits === 0) return Number.POSITIVE_INFINITY;
  const pid = child.movingPlayer;
  // child.rewardSum[pid] is the SUM of rewards from pid's perspective across
  // all rollouts through child. UCB1 = mean + c·√(ln(N)/n).
  const sum = pid ? child.rewardSum[pid] ?? 0 : 0;
  const mean = sum / child.visits;
  return mean + c * Math.sqrt(Math.log(parentVisits + 1) / child.visits);
}

function select<S, M, O>(
  game: Game<S, M, O>,
  root: MCTSNode<M>,
  rootState: SessionState<S>,
  config: Required<MCTSConfig>,
): { node: MCTSNode<M>; state: SessionState<S>; path: Array<MCTSNode<M>> } {
  const path: Array<MCTSNode<M>> = [root];
  let node = root;
  let state = rootState;
  while (!node.terminal && node.untried.length === 0 && node.children.length > 0) {
    let best = node.children[0]!;
    let bestScore = ucb1(best, node.visits, config.ucb_c);
    for (let i = 1; i < node.children.length; i++) {
      const c = node.children[i]!;
      const s = ucb1(c, node.visits, config.ucb_c);
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    let applied;
    try {
      applied = game.applyMove(state, node.activePlayerId, best.inboundMove as M);
    } catch {
      // Under hidden-info determinization, a child that was legal when it was
      // first expanded can be illegal in THIS iteration's sampled state — e.g.
      // a capture move enumerated for an opaque opponent whose concrete hand
      // differs from the sample (or, absent a `determinize` hook, a placeholder
      // opaque move that the engine refuses without physically-rolled dice).
      // As the caveat below in chooseMoveMCTS promises, we fall back to
      // expanding/simulating from `node` rather than aborting the whole search.
      // The child is left in place (it may be legal under other samples).
      break;
    }
    state = applied.newState;
    node = best;
    path.push(node);
  }
  return { node, state, path };
}

function expand<S, M, O>(
  game: Game<S, M, O>,
  node: MCTSNode<M>,
  state: SessionState<S>,
  rng: () => number,
): { node: MCTSNode<M>; state: SessionState<S> } {
  // Drain untried moves until one applies cleanly. A move can throw when it
  // is illegal in the current (determinized) state — e.g. a placeholder
  // capture enumerated for an opaque opponent whose real hand the server
  // cannot see, which the engine rejects because it has no physically-rolled
  // dice. Discard such moves and try the next rather than aborting the search
  // (see the ISMCTS caveat in chooseMoveMCTS). Without this guard a single
  // opaque capture in the tree throws straight out of getAIMove.
  while (!node.terminal && node.untried.length > 0) {
    // Pop a random untried move for variety.
    const idx = Math.floor(rng() * node.untried.length);
    const picked = node.untried.splice(idx, 1)[0]!;
    const movingPlayer = node.activePlayerId;
    let applied;
    try {
      applied = game.applyMove(state, movingPlayer, picked.move);
    } catch {
      continue;
    }
    const child = newNode(game, applied.newState, picked.move, movingPlayer);
    node.children.push(child);
    return { node: child, state: applied.newState };
  }
  return { node, state };
}

function backprop<M>(
  path: Array<MCTSNode<M>>,
  rewards: Record<string, number>,
): void {
  for (const n of path) {
    n.visits += 1;
    for (const [pid, r] of Object.entries(rewards)) {
      n.rewardSum[pid] = (n.rewardSum[pid] ?? 0) + r;
    }
  }
}

// Public entry. Returns the best move for `playerId` from `state`.
export function chooseMoveMCTS<S, M, O>(
  game: Game<S, M, O>,
  state: SessionState<S>,
  playerId: string,
  configOverride?: MCTSConfig,
): MCTSResult<M> {
  const config: Required<MCTSConfig> = {
    budget_ms: configOverride?.budget_ms ?? 1000,
    max_iterations: configOverride?.max_iterations ?? Number.POSITIVE_INFINITY,
    ucb_c: configOverride?.ucb_c ?? Math.SQRT2,
    max_rollout_plies: configOverride?.max_rollout_plies ?? 200,
    seed: configOverride?.seed ?? Math.floor(Math.random() * 0xffffffff),
  };
  const rng = mulberry32(config.seed);
  const clone = game.cloneState ?? defaultClone;
  const determinize = game.determinize;

  // The root mirrors the live state from `playerId`'s view; we re-determinize
  // each iteration to reflect uncertainty about hidden facts.
  const rootClone = clone(state);
  const root = newNode<S, M, O>(game, rootClone, null, null);

  // Edge: nothing to choose. Caller's responsibility to handle (some games
  // have legitimate "pass" / no-legal-moves states the engine treats as
  // implicit moves). We surface the absence rather than throw.
  if (root.untried.length === 0 && root.children.length === 0) {
    return {
      move: undefined as unknown as M,
      iterations: 0,
      elapsed_ms: 0,
      root_visits: 0,
      candidates: [],
    };
  }
  // Edge: one legal move. Skip search.
  if (root.untried.length === 1) {
    const only = root.untried[0]!;
    return {
      move: only.move,
      iterations: 0,
      elapsed_ms: 0,
      root_visits: 0,
      candidates: [{ move: only.move, visits: 0, avg_reward: 0, ucb: 0 }],
    };
  }

  const startedAt = Date.now();
  let iterations = 0;
  while (iterations < config.max_iterations) {
    if (Date.now() - startedAt >= config.budget_ms) break;

    // Per-iteration determinization for hidden-info games. We rebuild the
    // root each iteration so the tree integrates across many possible
    // hidden-state realizations (SO-ISMCTS).
    let simState = clone(state);
    if (determinize) {
      simState = determinize(simState, playerId, rng);
    }

    // For ISMCTS, the standard caveat applies: tree children correspond to
    // moves at the root's active player. Children deeper in the tree may
    // become inconsistent with the determinized state's legal moves. We
    // handle this defensively in `select` by falling back to expansion when
    // applyMove throws — but at the root, this concern doesn't apply: legal
    // moves are computed once from the public view, which is what `playerId`
    // sees.

    const { node: leaf, state: leafState, path } = select(game, root, simState, config);
    const { node: expanded, state: expandedState } = expand(game, leaf, leafState, rng);
    if (expanded !== leaf) path.push(expanded);
    const rewards = simulate(game, expandedState, config, rng);
    backprop(path, rewards);
    iterations += 1;
  }

  // Edge: every root expansion was rejected under determinization (all sampled
  // worlds made the root moves illegal — e.g. identity-targeted moves against
  // re-sampled hidden zones). Falling through would read `children[0]` of an
  // empty array, so fall back to a seeded pick from the REAL legal set — those
  // moves were legal in the true state even if inconsistent with the samples.
  if (root.children.length === 0) {
    const legal = game.getLegalMoves(state, playerId);
    const pick = legal[Math.floor(rng() * legal.length)]!;
    return {
      move: pick.move,
      iterations,
      elapsed_ms: Date.now() - startedAt,
      root_visits: root.visits,
      candidates: [],
    };
  }

  // Pick the most-visited child (robust against UCB variance).
  let best = root.children[0]!;
  for (let i = 1; i < root.children.length; i++) {
    const c = root.children[i]!;
    if (c.visits > best.visits) best = c;
  }

  const candidates = root.children
    .map((c) => ({
      move: c.inboundMove as M,
      visits: c.visits,
      avg_reward: c.visits > 0 ? (c.rewardSum[playerId] ?? 0) / c.visits : 0,
      ucb: ucb1(c, root.visits, config.ucb_c),
    }))
    .sort((a, b) => b.visits - a.visits);

  return {
    move: best.inboundMove as M,
    iterations,
    elapsed_ms: Date.now() - startedAt,
    root_visits: root.visits,
    candidates,
  };
}
