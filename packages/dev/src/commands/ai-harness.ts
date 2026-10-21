#!/usr/bin/env tsx
// CLI for the AI testing harness. Game-agnostic — drives any registered MCP
// game through tool calls. Per-game metric enrichment via the registry in
// src/harness/metrics.ts.
//
// Examples:
//   tsx scripts/ai-harness.ts --game=fractured-fist --n=100 --players=2
//   tsx scripts/ai-harness.ts --game=sweetlands-imperium --n=20 --players=2,3,4
//   tsx scripts/ai-harness.ts --game=fractured-fist --n=5 --players=2

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve as resolvePath, join, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { Harness, parseToolJson, type AIPlayerConfig, type Difficulty, type GameMetadata, type GameRecord } from '../harness/runner.js';
import { extractMetrics, type MetricsRecord, type MetricValue } from '../harness/metrics.js';
import { analyzeBatch, renderBatchAnalysis } from '../harness/analysis.js';
import { devHooksFor, type SweepSpec, type StrategyDraftPlan } from '../harness/devHooks.js';
import { asBooleans, asNumbers, avg, makeBooleanRow, makeNumericRow, num, pct, pctTrue, pluck, type FeatureRow } from '../harness/featureRows.js';
import { mulberry32, pickDistinct } from '../harness/random.js';
import type { BalanceAxis } from '@zekel/game-kit';

interface CliArgs {
  game: string;
  n: number;
  players: number[];
  // One difficulty (broadcast to every seat) OR one per seat for head-to-head
  // (e.g. --difficulty=mcts,medium,medium → ai1=mcts vs ai2/ai3=medium). Seat
  // rotation still debiases position, and metrics are keyed by player_id, so
  // ai1's win rate cleanly measures the mcts player.
  difficulties: Difficulty[];
  // Strategy axis (§0), orthogonal to difficulty. Single value broadcasts to every
  // seat; a per-seat list (length === player_count) assigns ai(i+1) = list[i].
  // Empty = no strategy (the game's adaptive default). Forwarded to getAIMove and
  // tagged per seat so the analysis emits the strategy matchup matrix.
  strategies: string[];
  seed: number;
  outDir: string;
  quiet: boolean;
  scenario?: string;
  // Generic pass-through: a JSON object merged into every game's createSession
  // options (e.g. --game-options='{"hideout":["Little Ghana"]}'). Lets a batch
  // pin any option lever a game exposes without a bespoke sweep.
  gameOptions?: Record<string, unknown>;
  mctsBudgetMs?: number;
  serverPath?: string;
  // Option sweep: vary game options per game so the batch covers the whole
  // card pool. Currently 'loadout' (Fractured Fist) — a random N-technique
  // loadout per game. Off by default (uses the game's default options).
  sweep?: string;
  // Skip per-game JSON files (1000-scale runs would otherwise write 1000
  // files). The aggregate markdown + analysis still print to stdout.
  noGameFiles: boolean;
  // Stop a game as a draw after this many rounds (stalemate guard for
  // degenerate loadouts). Default 80 (~4x the observed mean game length).
  maxRounds: number;
  // Recycle (kill + respawn) the server child every N games to bound memory.
  // The in-memory store + undo stacks accumulate ~MB/game and OOM the child
  // (~4GB) around game ~440. Default 150 keeps peak well under the limit.
  recycleEvery: number;
  // §4 temporal trace: capture a per-turn scoreboard snapshot (one extra
  // get_state call per turn) so the analysis can report lead-change count and
  // decisiveness. Off by default — only meaningful for games that implement
  // getScoreboard AND a leaderScalar analysis override. Costs ~2x tool calls.
  trace: boolean;
  // Worker count: run games across this many server children in parallel.
  // Safe for heuristic difficulties — every per-game config derives purely from
  // (seed, index), so results are byte-identical to a sequential run. Keep at 1
  // for reproducible `mcts` batches: the MCTS budget is wall-clock, so CPU
  // contention changes search depth and therefore moves.
  parallel: number;
  // Balance-axis coverage: by default the harness only WARNS about setup choices
  // (balance axes) the run left at default. With this set, an unexercised
  // non-cosmetic axis is a hard error (exit 2) before any games run.
  strictCoverage: boolean;
  // Write the aggregated BatchAnalysis (one per scenario) as JSON to this path.
  // The companion to --no-game-files at scale: the balance dashboard
  // (scripts/balance-dashboard.ts --analysis=...) consumes this directly, so a
  // 1000-game run needs no per-game record files.
  analysisJson?: string;
}

const DIFFICULTIES: Difficulty[] = ['random', 'easy', 'medium', 'hard', 'mcts'];

function parseCli(argv: string[]): CliArgs {
  // pnpm forwards a leading `--` separator literally to the script (npm strips
  // it). parseArgs then treats every option after `--` as positional, which
  // `allowPositionals: false` rejects — so `pnpm harness -- --game=...` crashes
  // before any game loads. Strip one leading `--` so both invocation forms work.
  const rawArgv = argv;
  const harnessArgs = rawArgv.length > 0 && rawArgv[0] === '--' ? rawArgv.slice(1) : rawArgv;
  const { values } = parseArgs({
    options: {
      game: { type: 'string' },
      n: { type: 'string', default: '50' },
      players: { type: 'string' },
      difficulty: { type: 'string', default: 'medium' },
      strategy: { type: 'string' },
      'mcts-budget-ms': { type: 'string' },
      // Alternate compiled server entrypoint, for testing a build other than
      // the default dist/index.js (which registers every game).
      server: { type: 'string' },
      seed: { type: 'string', default: '1' },
      'out-dir': { type: 'string', default: './harness-out' },
      quiet: { type: 'boolean', default: false },
      scenario: { type: 'string' },
      'game-options': { type: 'string' },
      sweep: { type: 'string' },
      'strict-coverage': { type: 'boolean', default: false },
      'no-game-files': { type: 'boolean', default: false },
      'analysis-json': { type: 'string' },
      'max-rounds': { type: 'string', default: '80' },
      'recycle-every': { type: 'string', default: '150' },
      trace: { type: 'boolean', default: false },
      parallel: { type: 'string', default: '1' },
    },
    args: harnessArgs,
    strict: true,
    allowPositionals: false,
  });
  const game = values.game as string | undefined;
  if (!game) {
    console.error('Usage: tsx scripts/ai-harness.ts --game=<id> [--n=50] [--players=2,3,4] [--difficulty=medium | --difficulty=mcts,medium,medium] [--mcts-budget-ms=200] [--seed=1] [--parallel=4] [--out-dir=./harness-out] [--quiet] [--scenario=<scenario_id>] [--game-options=<json merged into createSession options>]');
    process.exit(2);
  }
  const n = Number(values.n);
  if (!Number.isInteger(n) || n < 1) {
    console.error('--n must be a positive integer');
    process.exit(2);
  }
  // --difficulty accepts a single value (broadcast) or a comma-separated list
  // (one per seat) for head-to-head comparisons.
  const difficulties = String(values.difficulty)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as Difficulty[];
  if (difficulties.length === 0) difficulties.push('medium');
  for (const d of difficulties) {
    if (!DIFFICULTIES.includes(d)) {
      console.error(`--difficulty entries must be one of ${DIFFICULTIES.join(', ')}; got "${d}"`);
      process.exit(2);
    }
  }
  // --strategy: optional, single (broadcast) or comma-separated per-seat list.
  // Free-form (each game owns its vocabulary), so no enum validation here.
  const strategies = values.strategy
    ? String(values.strategy)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  let mctsBudgetMs: number | undefined;
  if (values['mcts-budget-ms'] !== undefined) {
    mctsBudgetMs = Number(values['mcts-budget-ms']);
    if (!Number.isInteger(mctsBudgetMs) || mctsBudgetMs < 1) {
      console.error('--mcts-budget-ms must be a positive integer (milliseconds)');
      process.exit(2);
    }
  }
  const seed = Number(values.seed);
  if (!Number.isInteger(seed) || seed < 0) {
    console.error('--seed must be a non-negative integer');
    process.exit(2);
  }
  let players: number[] | undefined;
  if (values.players) {
    players = String(values.players)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const v = Number(s);
        // >= 1: solo games exist (warble-way-galaxy, minPlayers 1). Per-game
        // bounds are still enforced against [min_players, max_players] below.
        if (!Number.isInteger(v) || v < 1) {
          console.error(`--players entries must be integers >= 1; got "${s}"`);
          process.exit(2);
        }
        return v;
      });
  }
  return {
    game,
    n,
    players: players ?? [],
    difficulties,
    strategies,
    seed,
    outDir: resolvePath(String(values['out-dir'])),
    quiet: Boolean(values.quiet),
    scenario: values.scenario ? String(values.scenario) : undefined,
    gameOptions: values['game-options'] ? JSON.parse(String(values['game-options'])) as Record<string, unknown> : undefined,
    mctsBudgetMs,
    serverPath: values.server ? resolvePath(String(values.server)) : undefined,
    sweep: values.sweep ? String(values.sweep) : undefined,
    noGameFiles: Boolean(values['no-game-files']),
    analysisJson: values['analysis-json'] ? resolvePath(String(values['analysis-json'])) : undefined,
    trace: Boolean(values.trace),
    parallel: (() => {
      const v = Number(values.parallel);
      if (!Number.isInteger(v) || v < 1 || v > 32) {
        console.error('--parallel must be an integer between 1 and 32');
        process.exit(2);
      }
      return v;
    })(),
    strictCoverage: Boolean(values['strict-coverage']),
    maxRounds: (() => {
      const v = Number(values['max-rounds']);
      if (!Number.isInteger(v) || v < 1) {
        console.error('--max-rounds must be a positive integer');
        process.exit(2);
      }
      return v;
    })(),
    recycleEvery: (() => {
      const v = Number(values['recycle-every']);
      if (!Number.isInteger(v) || v < 1) {
        console.error('--recycle-every must be a positive integer');
        process.exit(2);
      }
      return v;
    })(),
  };
}

// ---------- option sweep ----------

// The game's reference data (get_rules): its own shape, read by its dev hooks.
type ReferenceData = Record<string, unknown>;

// The sweep for --sweep=<name>, from the game's dev hooks, or null when the game
// has none by that name.
function buildSweepSpec(sweep: string, gameId: string, ref: ReferenceData): SweepSpec | null {
  return devHooksFor(gameId).sweeps?.[sweep]?.(ref) ?? null;
}

// ---------- balance-axis coverage ----------
//
// The default run fixes every setup choice; this reports which balance axes
// (declared by the game's getBalanceAxes, surfaced via get_rules) the run varied
// vs left at default — so a setup choice is never silently un-evaluated.

async function fetchBalanceAxes(harness: Harness, gameId: string): Promise<BalanceAxis[]> {
  const resp = await harness.callTool('get_rules', { game_id: gameId });
  const payload = parseToolJson(resp) as { balance_axes?: BalanceAxis[] } | null;
  return Array.isArray(payload?.balance_axes) ? payload!.balance_axes! : [];
}

function axisVaried(axis: BalanceAxis, args: CliArgs): boolean {
  return axis.levers.some((lever) => {
    switch (lever) {
      case 'strategy':
        return new Set(args.strategies).size >= 2;
      case 'sweep':
        return Boolean(args.sweep);
      case 'difficulty':
        return new Set(args.difficulties).size >= 2;
      case 'players':
        return args.players.length >= 2;
      default:
        return false; // 'scenario' and anything else: can't auto-detect → treat as not varied
    }
  });
}

// Print the coverage report (to stderr) and return the unexercised non-cosmetic
// axes. Adds a generic player-count axis for any game with a player range.
function reportCoverage(meta: GameMetadata, declared: BalanceAxis[], args: CliArgs): BalanceAxis[] {
  const axes = [...declared];
  if (meta.max_players > meta.min_players && !axes.some((a) => a.levers.includes('players'))) {
    axes.push({
      name: 'player_count',
      kind: 'config',
      description: `Supports ${meta.min_players}–${meta.max_players} players; length / dead turns / balance can shift with count.`,
      levers: ['players'],
      recipe: `--players=${meta.min_players}${meta.max_players > meta.min_players + 1 ? ',…,' : ','}${meta.max_players}`,
    });
  }
  process.stderr.write('\nBalance-axis coverage (setup choices a balance pass should vary):\n');
  if (axes.length === 0) {
    process.stderr.write('  (this game declares no balance axes — if it has setup choices, implement getBalanceAxes)\n');
    return [];
  }
  const unexercised: BalanceAxis[] = [];
  for (const a of axes) {
    if (a.levers.length === 0) {
      // No harness lever: a cosmetic axis (confirm flat) or a real axis the harness
      // can't yet vary (e.g. tactical obstacle placement). Surfaced as MANUAL — it
      // is not counted as a strict-coverage failure, since no flag can fix it.
      const note = a.kind === 'cosmetic' ? 'confirm win rate is flat' : 'no harness lever yet — evaluate manually';
      process.stderr.write(`  ~ ${a.name} (${a.kind}) — ${note}: ${a.recipe}\n`);
    } else if (axisVaried(a, args)) {
      process.stderr.write(`  ✓ ${a.name} (${a.kind}) — varied this run\n`);
    } else {
      unexercised.push(a);
      process.stderr.write(`  ✗ ${a.name} (${a.kind}) — UNEXERCISED (left at default). Vary with: ${a.recipe}\n`);
    }
  }
  process.stderr.write(
    unexercised.length === 0
      ? '  → all non-cosmetic axes exercised.\n'
      : `  → ${unexercised.length} axis/axes left at default; this run only evaluates that slice.\n`,
  );
  return unexercised;
}

async function fetchReferenceData(harness: Harness, gameId: string): Promise<ReferenceData> {
  const resp = await harness.callTool('get_rules', { game_id: gameId });
  const payload = parseToolJson(resp) as
    | { reference_data?: ReferenceData }
    | null;
  return payload?.reference_data ?? {};
}

// Per-game options = scenario (if any) + a sweep pick seeded deterministically
// from this game's seed (so a run is reproducible from --seed).
function buildGameOptions(
  args: CliArgs,
  sweepSpec: SweepSpec | null,
  seed: number,
  factionDraft: StrategyDraftPlan | null = null,
  gameFactions: string[] | null = null,
  gameDifficulties: (string | undefined)[] = [],
): Record<string, unknown> | undefined {
  const opts: Record<string, unknown> = {};
  if (args.scenario) opts.scenario_id = args.scenario;
  if (args.gameOptions) Object.assign(opts, args.gameOptions);
  // Faction draft owns the shared loadout when seats carry factions — it replaces
  // the random loadout sweep (the two are mutually exclusive for FF). The loadout
  // is co-drafted from THIS game's seat factions, each seat drafting at its skill.
  if (factionDraft && gameFactions) {
    Object.assign(opts, factionDraft.options(seed, gameFactions, gameDifficulties));
    return opts;
  }
  if (sweepSpec) {
    const rand = mulberry32((seed ^ 0x9e3779b9) >>> 0);
    let pick = pickDistinct(sweepSpec.pool, sweepSpec.count, rand);
    // Enforce the win-condition requirement: if no pick is from the required
    // subset, swap one slot for a required card (guaranteed not already in the
    // pick, since the branch only runs when none are present).
    const must = sweepSpec.mustIncludeFrom;
    if (must && must.length > 0 && !pick.some((id) => must.includes(id))) {
      const required = must[Math.floor(rand() * must.length)]!;
      const slot = Math.floor(rand() * pick.length);
      pick = pick.map((id, i) => (i === slot ? required : id));
    }
    opts[sweepSpec.optionKey] = pick;
    if (sweepSpec.companion) {
      const used = new Set<string>();
      opts[sweepSpec.companion.optionKey] = pick.map((id) => {
        const eligible = (sweepSpec.companion!.eligible[id] ?? []).filter((x) => !used.has(x));
        if (eligible.length === 0) throw new Error(`No companion assignment available for ${id}`);
        const chosen = eligible[Math.floor(rand() * eligible.length)]!;
        used.add(chosen);
        return chosen;
      });
    }
  }
  return Object.keys(opts).length > 0 ? opts : undefined;
}

// Assign difficulties (and optional strategies) to seats ai1..aiN. A single value
// broadcasts to every seat; a per-seat list (length === count) assigns ai(i+1) =
// list[i]. An empty strategy list leaves strategy unset (the game's adaptive default).
function buildPlayers(count: number, difficulties: Difficulty[], strategies: string[] = []): AIPlayerConfig[] {
  return Array.from({ length: count }, (_, i) => {
    const strategy = strategies.length === 0 ? undefined : strategies.length === 1 ? strategies[0]! : strategies[i]!;
    return {
      player_id: `ai${i + 1}`,
      kind: 'ai' as const,
      difficulty: difficulties.length === 1 ? difficulties[0]! : difficulties[i]!,
      ...(strategy !== undefined ? { strategy } : {}),
    };
  });
}

// Rotate the player list so each AI plays each seat across the batch.
// With 30 games and 3 players, each AI plays each seat 10 times,
// eliminating the structural seat bias (initiative-holder always
// player_ids[0]; setup-card seat-0 always player_ids[0]; tie-break
// favors earliest in turn order).
function rotatePlayers(players: AIPlayerConfig[], gameIndex: number): AIPlayerConfig[] {
  const offset = gameIndex % players.length;
  return [...players.slice(offset), ...players.slice(0, offset)];
}

export async function main(argv: string[]): Promise<void> {
  const args = parseCli(argv);
  if (args.parallel > 1 && args.difficulties.includes('mcts')) {
    process.stderr.write(
      `NOTE: --parallel=${args.parallel} with mcts seats — the MCTS budget is wall-clock, so CPU ` +
        'contention changes search depth (and therefore moves). Results will not be reproducible ' +
        'across parallelism levels; use --parallel=1 for a reproducible mcts batch.\n',
    );
  }
  const harness = new Harness({ mctsBudgetMs: args.mctsBudgetMs, serverPath: args.serverPath });
  await harness.start();

  let meta: GameMetadata | undefined;
  try {
    const games = await harness.listGames();
    meta = games.find((g) => g.game_id === args.game);
    if (!meta) {
      console.error(`Unknown game: ${args.game}. Registered: ${games.map((g) => g.game_id).join(', ')}`);
      process.exit(2);
    }
  } catch (e) {
    console.error(`Failed to list games: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  // Balance-axis coverage: report which setup choices this run varies vs leaves at
  // default, so an axis is never silently un-evaluated. Warn by default; hard-fail
  // under --strict-coverage.
  const balanceAxes = await fetchBalanceAxes(harness, args.game);
  const unexercised = reportCoverage(meta, balanceAxes, args);
  if (args.strictCoverage && unexercised.length > 0) {
    console.error(
      `--strict-coverage: ${unexercised.length} balance axis/axes unexercised ` +
        `(${unexercised.map((a) => a.name).join(', ')}). Vary them, or drop --strict-coverage.`,
    );
    process.exit(2);
  }

  // Resolve the option sweep AND the faction draft (if any) once — both read the
  // card pool from the server's reference data, so they stay game-agnostic.
  let sweepSpec: SweepSpec | null = null;
  let factionDraft: StrategyDraftPlan | null = null;
  const strategyDraft = devHooksFor(args.game).strategyDraft;
  if (args.sweep || (strategyDraft && args.strategies.length > 0)) {
    const ref = await fetchReferenceData(harness, args.game);
    factionDraft = strategyDraft?.plan(args.strategies, ref) ?? null;
    if (factionDraft) {
      if (!args.quiet) {
        process.stderr.write(`${factionDraft.describe(args.strategies.length)}\n`);
      }
    } else if (args.sweep) {
      sweepSpec = buildSweepSpec(args.sweep, args.game, ref);
      if (!sweepSpec) {
        console.error(`--sweep=${args.sweep} does not apply to ${args.game}; running with default options.`);
      } else if (!args.quiet) {
        process.stderr.write(`Sweep: ${sweepSpec.optionKey} — ${sweepSpec.count} of ${sweepSpec.pool.length} per game\n`);
      }
    }
  }

  // Determine which player counts to run. If --players unspecified, default
  // to game.maxPlayers (one scenario).
  const playerCounts = args.players.length > 0 ? args.players : [meta.max_players];

  // Per scenario, kick off a batch of games.
  const scenarios: Array<{
    player_count: number;
    games: GameRecord[];
    metricsPerGame: MetricsRecord[];
  }> = [];

  let scenarioOffset = 0;
  for (const playerCount of playerCounts) {
    if (playerCount < meta.min_players || playerCount > meta.max_players) {
      console.error(`Skipping ${playerCount}-player scenario: ${args.game} requires ${meta.min_players}-${meta.max_players} players.`);
      continue;
    }
    // A per-seat difficulty list must match the player count for this scenario.
    if (args.difficulties.length > 1 && args.difficulties.length !== playerCount) {
      console.error(
        `Skipping ${playerCount}-player scenario: --difficulty list has ${args.difficulties.length} entries (need 1 or ${playerCount}).`,
      );
      continue;
    }
    // A per-seat strategy list must match the player count — UNLESS it's a POOL
    // (more strategies than seats), sampled per game ("pool mode": faction draft for
    // FF, or the generic per-game distinct-sample below for any game whose strategies
    // aren't factions). Only a list that is >1 but SHORTER than the seat count is
    // ambiguous and skipped.
    if (!factionDraft && args.strategies.length > 1 && args.strategies.length < playerCount) {
      console.error(
        `Skipping ${playerCount}-player scenario: --strategy list has ${args.strategies.length} entries (need 1, ${playerCount}, or > ${playerCount} for pool mode).`,
      );
      continue;
    }
    const diffLabel =
      args.difficulties.length === 1 ? args.difficulties[0]! : args.difficulties.join(',');
    const stratLabel = args.strategies.length === 0 ? '' : ` strategy=${args.strategies.join(',')}`;
    if (!args.quiet) {
      process.stderr.write(`\n=== ${playerCount}-player scenario, n=${args.n}, difficulty=${diffLabel}${stratLabel} ===\n`);
    }
    const players = buildPlayers(playerCount, args.difficulties, args.strategies);

    // Precompute every game's config UP FRONT. Each derives purely from
    // (seed, index) — the seeded faction/strategy sampling, seat rotation, and
    // option sweep never consume a shared sequence — so the batch can then be
    // dispatched to any number of workers and produce byte-identical results
    // to a sequential run.
    interface GameJob {
      index: number;
      seed: number;
      gamePlayers: AIPlayerConfig[];
      options: Record<string, unknown> | undefined;
    }
    const jobs: GameJob[] = [];
    for (let i = 0; i < args.n; i++) {
      const seed = args.seed + scenarioOffset + i;
      // Per-game seats. With a faction draft, assign this game's factions (fixed
      // pair, or sampled in pool mode) and co-draft the shared loadout from them;
      // otherwise use the fixed players. Rotation debiases seat in both cases.
      let gamePlayers: AIPlayerConfig[];
      let gameFactions: string[] | null = null;
      let gameDifficulties: (string | undefined)[] = [];
      if (factionDraft) {
        const seatFactions = factionDraft.seatStrategies(playerCount, seed);
        gamePlayers = rotatePlayers(buildPlayers(playerCount, args.difficulties, seatFactions), i);
        // Derive the draft inputs from the FINAL players so faction↔difficulty stay
        // paired through rotation (each seat drafts toward its faction at its skill).
        gameFactions = gamePlayers.map((p) => p.strategy!);
        gameDifficulties = gamePlayers.map((p) => p.difficulty);
      } else if (args.strategies.length > playerCount) {
        // Generic strategy-pool mode: sample `playerCount` DISTINCT strategies from
        // the list per game (seeded → reproducible), so across the batch every
        // pairing appears and the strategy matchup matrix + §0 meta block fill in.
        const rng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
        const seatStrats = pickDistinct(args.strategies, playerCount, rng);
        gamePlayers = rotatePlayers(buildPlayers(playerCount, args.difficulties, seatStrats), i);
      } else {
        gamePlayers = rotatePlayers(players, i);
      }
      const options = buildGameOptions(args, sweepSpec, seed, factionDraft, gameFactions, gameDifficulties);
      jobs.push({ index: i, seed, gamePlayers, options });
    }

    // Run the jobs on a pool of `--parallel` server children. Workers pull the
    // next job off a shared cursor (single-threaded event loop → no race);
    // results land at their job index so output order matches sequential runs.
    // Worker 0 is the existing harness; extras are spawned per scenario batch
    // and closed after. Each worker recycles ITS child every recycleEvery games
    // (the memory bound is per child, so the cadence is per worker).
    const results = new Array<{ record: GameRecord; metrics: MetricsRecord }>(jobs.length);
    const extraWorkers: Harness[] = [];
    for (let w = 1; w < Math.min(args.parallel, jobs.length); w++) {
      const h = new Harness({ mctsBudgetMs: args.mctsBudgetMs, serverPath: args.serverPath });
      await h.start();
      extraWorkers.push(h);
    }
    const workers = [harness, ...extraWorkers];
    let cursor = 0;
    let done = 0;
    await Promise.all(
      workers.map(async (h) => {
        let ranOnThisChild = 0;
        for (;;) {
          const idx = cursor;
          cursor += 1;
          if (idx >= jobs.length) return;
          const job = jobs[idx]!;
          if (ranOnThisChild > 0 && ranOnThisChild % args.recycleEvery === 0) {
            await h.restart();
          }
          let record: GameRecord;
          try {
            record = await h.runOneGame({
              game_id: args.game,
              players: job.gamePlayers,
              seed: job.seed,
              options: job.options,
              maxRounds: args.maxRounds,
              captureScoreTrace: args.trace,
            });
          } catch (e) {
            // A crashed child (e.g. OOM) rejects the in-flight call. Record the
            // failure, respawn THIS worker, and keep going so one bad game can't
            // abort the run.
            record = {
              game_id: args.game,
              seed: job.seed,
              players: job.gamePlayers,
              options: job.options,
              moves: [],
              result: { winners: [], scores: {}, summary: '' },
              final_views: {},
              error: { code: 'GAME_THREW', message: e instanceof Error ? e.message : String(e) },
            };
            await h.restart();
          }
          ranOnThisChild += 1;
          const metrics = extractMetrics(record);
          results[idx] = { record, metrics };
          if (!args.noGameFiles) {
            await writeGameJson(args.outDir, args.game, playerCount, job.seed, record, metrics);
          }
          done += 1;
          if (!args.quiet) {
            reportProgress(args, job, record, done);
          }
        }
      }),
    );
    for (const h of extraWorkers) await h.close();

    const games: GameRecord[] = results.map((r) => r.record);
    const metricsPerGame: MetricsRecord[] = results.map((r) => r.metrics);
    scenarios.push({ player_count: playerCount, games, metricsPerGame });
    scenarioOffset += args.n;
  }

  await harness.close();

  // Emit markdown summary on stdout.
  const today = new Date().toISOString().slice(0, 10);
  process.stdout.write(`# AI Harness — ${args.game} — ${today}\n`);
  const diffLabel = args.difficulties.length === 1 ? args.difficulties[0]! : args.difficulties.join(',');
  const budgetNote = args.mctsBudgetMs !== undefined ? `, mcts-budget=${args.mctsBudgetMs}ms` : '';
  const stratNote = args.strategies.length === 0 ? '' : `, strategy=${args.strategies.join(',')}`;
  process.stdout.write(`\nSettings: n=${args.n} per scenario, difficulty=${diffLabel}${stratNote}${budgetNote}, seed=${args.seed}, seat-rotation=on${args.scenario ? `, scenario=${args.scenario}` : ''}\n`);
  const analyses: Array<{ player_count: number; analysis: ReturnType<typeof analyzeBatch> }> = [];
  for (const scenario of scenarios) {
    const seatDiffs = perSeatDifficulties(args.difficulties, scenario.player_count);
    process.stdout.write(`\n## Scenario: ${scenario.player_count} players\n`);
    process.stdout.write(renderOutcomes(scenario.player_count, scenario.metricsPerGame, seatDiffs));
    process.stdout.write(renderPerPlayerTable(scenario.player_count, scenario.metricsPerGame, args.game));
    // Cross-batch balance analysis: game length, dead turns, seat advantage,
    // and the card/action usage → win-rate lift table.
    const analysis = analyzeBatch(scenario.games);
    analyses.push({ player_count: scenario.player_count, analysis });
    process.stdout.write(renderBatchAnalysis(analysis));
  }

  // Aggregated-analysis JSON — the settings block carries the §6.4 conditioning
  // (skill, strategy mix, N, seed) so a downstream report stays self-describing
  // even though no per-game records exist.
  if (args.analysisJson) {
    const payload = {
      game_id: args.game,
      generated: today,
      settings: {
        n: args.n,
        difficulty: diffLabel,
        strategy: args.strategies.join(',') || undefined,
        sweep: args.sweep,
        seed: args.seed,
        trace: args.trace,
      },
      scenarios: analyses,
    };
    await mkdir(dirname(args.analysisJson), { recursive: true });
    await writeFile(args.analysisJson, JSON.stringify(payload, null, 2), 'utf8');
    process.stderr.write(`analysis JSON written to ${args.analysisJson}\n`);
  }
}

// One per-game progress line. With --parallel > 1 games finish out of order, so
// the line shows both the completion count and the game's own index/seed.
function reportProgress(
  args: CliArgs,
  job: { index: number; seed: number },
  record: GameRecord,
  done: number,
): void {
  let tag: string;
  if (record.error) {
    tag = `ERR:${record.error.code}`;
  } else {
    const winner = record.result.winners.join(',') || '(none)';
    // Include each player's final score when the game has scores.
    const scoreEntries = Object.entries(record.result.scores ?? {});
    const scoreStr = scoreEntries.length
      ? ' scores=' + scoreEntries.map(([pid, s]) => `${pid}:${s}`).join(',')
      : '';
    tag = `winner=${winner}${scoreStr}`;
  }
  process.stderr.write(
    `  game ${done}/${args.n} (#${job.index + 1}, seed=${job.seed}) turns=${record.moves.length} ${tag}\n`,
  );
}

// Resolve the difficulty each seat (ai1..aiN) plays, broadcasting a single
// value or passing through a per-seat list.
function perSeatDifficulties(difficulties: Difficulty[], count: number): Difficulty[] {
  return Array.from({ length: count }, (_, i) =>
    difficulties.length === 1 ? difficulties[0]! : difficulties[i]!,
  );
}

async function writeGameJson(
  baseDir: string,
  game: string,
  playerCount: number,
  seed: number,
  record: GameRecord,
  metrics: MetricsRecord,
): Promise<void> {
  const dir = join(baseDir, game, `${playerCount}p`);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `seed-${seed}.json`);
  const payload = { ...record, metrics };
  await writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
}

// ---------- aggregation ----------

// Outcomes table: win rate, average score, average actions per seat. The
// Difficulty column makes head-to-head batches (mixed difficulties) legible —
// since seats rotate, ai1's win rate is the seat-debiased rate for whatever
// difficulty ai1 plays.
function renderOutcomes(playerCount: number, metricsList: MetricsRecord[], seatDiffs: Difficulty[]): string {
  const lines: string[] = [];
  lines.push('\n### Outcomes\n');
  lines.push('| Seat  | Difficulty | Win rate | Avg score | Avg actions |');
  lines.push('|-------|------------|----------|-----------|-------------|');
  for (let i = 0; i < playerCount; i++) {
    const pid = `ai${i + 1}`;
    const diff = seatDiffs[i] ?? 'medium';
    const wins = pctTrue(asBooleans(pluck(metricsList, `${pid}_won`)));
    const score = avg(asNumbers(pluck(metricsList, `${pid}_score`)));
    const actions = avg(asNumbers(pluck(metricsList, `${pid}_action_count`)));
    lines.push(`| ${pid.padEnd(5)} | ${diff.padEnd(10)} | ${pct(wins).padStart(8)} | ${num(score).padStart(9)} | ${num(actions).padStart(11)} |`);
  }
  const ties = pctTrue(asBooleans(pluck(metricsList, 'is_tie')));
  lines.push(`| (tie) | ${''.padEnd(10)} | ${pct(ties).padStart(8)} |         — |           — |`);
  lines.push(`\nGames: ${metricsList.length}  Mean moves/game: ${num(avg(asNumbers(pluck(metricsList, 'total_turns'))))} _(see "Avg rounds/game" below for turn-based length)_`);
  return lines.join('\n') + '\n';
}

// Per-player feature engagement table. Renders %-of-games-true for boolean
// metrics, mean for numeric metrics. Tries to be game-aware: chooses keys
// based on game_id; falls back to generic keys for unrecognized games.
function renderPerPlayerTable(playerCount: number, metricsList: MetricsRecord[], gameId: string): string {
  const lines: string[] = [];
  lines.push('\n### Feature engagement\n');

  const rows = collectFeatureRows(metricsList, playerCount, gameId);
  if (rows.length === 0) {
    return '_(no per-player feature metrics recorded for this game)_\n';
  }

  const headerCells = ['Metric', ...Array.from({ length: playerCount }, (_, i) => `ai${i + 1}`)];
  lines.push(`| ${headerCells.join(' | ')} |`);
  lines.push(`|${headerCells.map(() => '------').join('|')}|`);
  for (const row of rows) {
    lines.push(`| ${row.label} | ${row.values.join(' | ')} |`);
  }
  return lines.join('\n') + '\n';
}


function collectFeatureRows(metricsList: MetricsRecord[], playerCount: number, gameId: string): FeatureRow[] {
  const rows: FeatureRow[] = [];

  // Generic: action variety (mean) — useful signal regardless of game.
  rows.push(makeNumericRow(metricsList, playerCount, 'action_variety', 'Action variety (mean)'));

  // Game-specific rows (from the game's dev hooks).
  rows.push(...(devHooksFor(gameId).featureRows?.(metricsList, playerCount) ?? []));

  return rows;
}

