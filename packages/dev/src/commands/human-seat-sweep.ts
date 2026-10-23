#!/usr/bin/env tsx
// Human-seat conformance sweep — the programmatic half of post-port §5/§7.
//
// The all-AI harness (the ai-harness command) never drives the human-facing
// surface, so an engine that auto-resolves a human-owned choice, strands a
// human-owed pending, or routes a directive to the wrong seat runs clean games
// and looks fully playable. This sweep drives ONE seat as a human through the
// real client loop (src/harness/engineBot.ts) across EVERY registered game ×
// every supported player count × every seat position × N seeds, and reports the
// flow violations engineBot detects.
//
// Registry-driven: games and their player-count ranges come from `list_games`,
// so a newly registered game is swept with no per-game code.
//
// Build first (`pnpm build`) — the harness spawns the compiled server.
//
// Examples:
//   pnpm sweep -- --games=sweetlands-imperium,cybernoir-2127
//   pnpm sweep -- --games=sweetlands-imperium --n=3 --counts=4,5
//   pnpm sweep                                   # whole catalog, 1 seed each

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { parseArgs } from 'node:util';
import { Harness, type GameMetadata } from '../harness/runner.js';
import { EngineBot, type EngineBotPlayer, type EngineBotResult } from '../harness/engineBot.js';

interface CliArgs {
  /** Game ids to sweep. Empty = every registered game. */
  games: string[];
  /** Player counts to sweep. Empty = every count the game supports. */
  counts: number[];
  /** Seeds per (game, count, human-seat) cell. */
  n: number;
  seed: number;
  outDir: string;
  /** Sweep only this seat index as the human (default: every seat). */
  seat?: number;
}

/** One engineBot run, tagged with the sweep cell it came from. */
interface SweepRun extends EngineBotResult {
  player_count: number;
  human_seat: number;
}

interface GameReport {
  game_id: string;
  runs: number;
  completed: number;
  errored: number;
  /** Runs that stopped on a report the harness can't synthesize — a harness
   *  gap (no per-game report responder), NOT a game bug. Tracked separately so
   *  it never inflates the violation count. */
  blocked: number;
  violations: number;
  by_kind: Record<string, number>;
  /** Cells that produced at least one violation, for the drilldown command. */
  failing_cells: string[];
}

function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      games: { type: 'string', default: '' },
      counts: { type: 'string', default: '' },
      n: { type: 'string', default: '1' },
      seed: { type: 'string', default: '1' },
      seat: { type: 'string' },
      'out-dir': { type: 'string', default: 'harness-out' },
    },
  });
  const list = (v: string): string[] =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  return {
    games: list(String(values.games ?? '')),
    counts: list(String(values.counts ?? '')).map(Number),
    n: Number(values.n),
    seed: Number(values.seed),
    seat: values.seat === undefined ? undefined : Number(values.seat),
    outDir: resolvePath(String(values['out-dir'])),
  };
}

/** Seat `humanSeat` is the human; every other seat is a medium AI. */
function makePlayers(count: number, humanSeat: number): EngineBotPlayer[] {
  return Array.from({ length: count }, (_, i) =>
    i === humanSeat
      ? ({ player_id: `p${i + 1}`, kind: 'human' } as EngineBotPlayer)
      : ({ player_id: `p${i + 1}`, kind: 'ai', difficulty: 'medium' } as EngineBotPlayer),
  );
}

function cellLabel(count: number, seat: number, seed: number): string {
  return `${count}p/seat${seat}/seed${seed}`;
}

function summarize(gameId: string, runs: SweepRun[]): GameReport {
  const byKind: Record<string, number> = {};
  const failing = new Set<string>();
  for (const r of runs) {
    for (const v of r.violations) {
      byKind[v.kind] = (byKind[v.kind] ?? 0) + 1;
      failing.add(cellLabel(r.player_count, r.human_seat, r.seed));
    }
    if (r.error) failing.add(cellLabel(r.player_count, r.human_seat, r.seed));
  }
  return {
    game_id: gameId,
    runs: runs.length,
    completed: runs.filter((r) => r.completed).length,
    errored: runs.filter((r) => r.error).length,
    blocked: runs.filter((r) => r.blocked && !r.completed).length,
    violations: runs.reduce((s, r) => s + r.violations.length, 0),
    by_kind: byKind,
    failing_cells: [...failing].sort(),
  };
}

function renderMarkdown(reports: GameReport[], runs: SweepRun[], args: CliArgs): string {
  const lines: string[] = [];
  lines.push('# Human-seat conformance sweep');
  lines.push('');
  lines.push(
    `Seeds per cell: ${args.n} (from ${args.seed}). One seat driven as a human through ` +
      '`next_step` → `get_legal_moves`/`suggest_move` → `apply_move`; other seats medium AI.',
  );
  lines.push('');
  lines.push('| Game | runs | completed | errored | blocked (harness gap) | violations |');
  lines.push('|---|--:|--:|--:|--:|--:|');
  for (const r of reports) {
    lines.push(
      `| \`${r.game_id}\` | ${r.runs} | ${r.completed} | ${r.errored} | ${r.blocked} | ${r.violations} |`,
    );
  }
  lines.push('');

  for (const rep of reports) {
    if (rep.violations === 0 && rep.errored === 0) continue;
    lines.push(`## ${rep.game_id}`);
    lines.push('');
    for (const [kind, n] of Object.entries(rep.by_kind).sort((a, b) => b[1] - a[1])) {
      lines.push(`- **${kind}** × ${n}`);
    }
    if (rep.failing_cells.length > 0) {
      lines.push(`- failing cells: ${rep.failing_cells.join(', ')}`);
    }
    lines.push('');
    const samples = runs
      .filter((r) => r.game_id === rep.game_id)
      .flatMap((r) =>
        r.violations.map(
          (v) => `  - [${cellLabel(r.player_count, r.human_seat, r.seed)} step ${v.step}] \`${v.kind}\`: ${v.detail}`,
        ),
      )
      .slice(0, 15);
    if (samples.length > 0) {
      lines.push('Samples:');
      lines.push(...samples);
      lines.push('');
    }
    for (const r of runs.filter((x) => x.game_id === rep.game_id && x.error)) {
      lines.push(`- ERROR ${cellLabel(r.player_count, r.human_seat, r.seed)}: ${r.error!.code} — ${r.error!.message}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export async function main(argv: string[]): Promise<void> {
  const args = parseCli(argv);
  const harness = new Harness();
  await harness.start();

  let catalog: GameMetadata[];
  try {
    catalog = await harness.listGames();
  } catch (e) {
    await harness.close();
    throw e;
  }
  const selected =
    args.games.length > 0 ? catalog.filter((g) => args.games.includes(g.game_id)) : catalog;

  const missing = args.games.filter((id) => !catalog.some((g) => g.game_id === id));
  if (missing.length > 0) {
    process.stderr.write(`unknown game id(s): ${missing.join(', ')}\n`);
  }

  const bot = new EngineBot(harness);
  const runs: SweepRun[] = [];

  try {
    for (const game of selected) {
      const counts =
        args.counts.length > 0
          ? args.counts.filter((c) => c >= game.min_players && c <= game.max_players)
          : Array.from(
              { length: game.max_players - game.min_players + 1 },
              (_, i) => game.min_players + i,
            );
      if (counts.length === 0) {
        process.stderr.write(`${game.game_id}: no requested player count in range — skipped\n`);
        continue;
      }
      process.stderr.write(`\n=== ${game.game_id} (${counts.join(',')}p) ===\n`);

      for (const count of counts) {
        const seats = args.seat === undefined ? Array.from({ length: count }, (_, i) => i) : [args.seat];
        for (const seat of seats) {
          if (seat >= count) continue;
          for (let i = 0; i < args.n; i++) {
            const seed = args.seed + i;
            const started = Date.now();
            const r = await bot.runOneGame({
              game_id: game.game_id,
              players: makePlayers(count, seat),
              seed,
            });
            const run: SweepRun = { ...r, player_count: count, human_seat: seat };
            runs.push(run);
            const status = r.error
              ? `ERROR ${r.error.code}`
              : r.completed
                ? 'completed'
                : r.blocked
                  ? `blocked (${r.blocked.move_type})`
                  : 'stopped';
            process.stderr.write(
              `  ${cellLabel(count, seat, seed)}: ${status} — ${r.steps} steps, ` +
                `${r.human_moves} human moves, ${r.violations.length} violation(s) ` +
                `[${Math.round((Date.now() - started) / 1000)}s]\n`,
            );
          }
        }
      }
    }
  } finally {
    await bot.close();
  }

  const reports = selected
    .map((g) => summarize(g.game_id, runs.filter((r) => r.game_id === g.game_id)))
    .filter((r) => r.runs > 0);

  const md = renderMarkdown(reports, runs, args);
  process.stdout.write(`\n${md}\n`);

  await mkdir(args.outDir, { recursive: true });
  const slug = reports.map((r) => r.game_id).join('+').slice(0, 60) || 'catalog';
  const base = `human-seat-sweep-${slug}`;
  await writeFile(join(args.outDir, `${base}.json`), JSON.stringify({ args, reports, runs }, null, 2), 'utf8');
  await writeFile(join(args.outDir, `${base}.md`), md, 'utf8');
  process.stderr.write(`\nwrote ${join(args.outDir, base)}.{json,md}\n`);

  const bad = reports.reduce((s, r) => s + r.violations + r.errored, 0);
  if (bad > 0) process.exitCode = 1;
}

