#!/usr/bin/env tsx
// CLI for the engine-bot integration harness. Drives one HUMAN seat through the
// real MCP client loop (next_step → get_legal_moves/suggest_move → apply_move),
// with AI opponents, and reports flow/invariant violations. Catches crashes,
// desyncs, wrong-pending-owner, missing directives, and self-rejected moves —
// the human-path bugs the all-AI harness (the ai-harness command) can't see.
//
// Examples:
//   engine-bot --game=sweetlands-imperium --n=5 --players=3
//   engine-bot --game=fractured-fist --n=3 --players=2

import { parseArgs } from 'node:util';
import { EngineBot, type EngineBotPlayer, type EngineBotResult } from '../harness/engineBot.js';

function parseCli(argv: string[]): { game: string; n: number; playerCount: number; seed: number } {
  const { values } = parseArgs({
    args: argv,
    options: {
      game: { type: 'string' },
      n: { type: 'string', default: '5' },
      players: { type: 'string', default: '2' },
      seed: { type: 'string', default: '1' },
    },
  });
  if (!values.game) {
    throw new Error('Usage: engine-bot --game=<id> [--n=N] [--players=K] [--seed=S]');
  }
  return {
    game: values.game,
    n: Number(values.n),
    playerCount: Number(values.players),
    seed: Number(values.seed),
  };
}

// Seat 0 is the human; the rest are AI opponents at medium difficulty.
function makePlayers(count: number): EngineBotPlayer[] {
  return Array.from({ length: count }, (_, i) =>
    i === 0
      ? ({ player_id: `p${i + 1}`, kind: 'human' } as EngineBotPlayer)
      : ({ player_id: `p${i + 1}`, kind: 'ai', difficulty: 'medium' } as EngineBotPlayer),
  );
}

export async function main(argv: string[]): Promise<void> {
  const cli = parseCli(argv);
  const bot = new EngineBot();
  await bot.start();
  const results: EngineBotResult[] = [];
  try {
    for (let i = 0; i < cli.n; i++) {
      const seed = cli.seed + i;
      const r = await bot.runOneGame({
        game_id: cli.game,
        players: makePlayers(cli.playerCount),
        seed,
      });
      results.push(r);
      const v = r.violations.length;
      const status = r.error
        ? `ERROR ${r.error.code}`
        : r.completed
          ? 'completed'
          : r.blocked
            ? `blocked (needs report responder: ${r.blocked.move_type})`
            : 'stopped';
      process.stderr.write(
        `  game ${i + 1}/${cli.n} (seed ${seed}): ${status} — ${r.steps} steps, ${r.human_moves} human moves, ${v} violation(s)\n`,
      );
    }
  } finally {
    await bot.close();
  }

  // Aggregate report.
  const completed = results.filter((r) => r.completed).length;
  const errored = results.filter((r) => r.error).length;
  const blocked = results.filter((r) => r.blocked && !r.completed);
  const allViolations = results.flatMap((r) => r.violations.map((vi) => ({ seed: r.seed, ...vi })));
  const byKind: Record<string, number> = {};
  for (const v of allViolations) byKind[v.kind] = (byKind[v.kind] ?? 0) + 1;

  process.stdout.write(`\n=== engine-bot: ${cli.game} (${cli.playerCount}p) — ${cli.n} games ===\n`);
  process.stdout.write(
    `completed: ${completed}/${cli.n}   errored: ${errored}   blocked-on-report: ${blocked.length}   real violations: ${allViolations.length}\n`,
  );
  if (blocked.length > 0) {
    const b = blocked[0]!.blocked!;
    process.stdout.write(`  needs a report responder for "${b.move_type}": ${b.reason}\n`);
  }
  if (Object.keys(byKind).length > 0) {
    process.stdout.write('violations by kind:\n');
    for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${k}: ${n}\n`);
    }
    process.stdout.write('\nsamples:\n');
    for (const v of allViolations.slice(0, 12)) {
      process.stdout.write(`  [seed ${v.seed}, step ${v.step}] ${v.kind}: ${v.detail.slice(0, 200)}\n`);
    }
  }
  for (const r of results.filter((x) => x.error)) {
    process.stdout.write(`  ERROR seed ${r.seed}: ${r.error!.code} — ${r.error!.message.slice(0, 200)}\n`);
  }

  // Non-zero exit if anything went wrong, so CI can gate on it.
  if (errored > 0 || allViolations.length > 0) process.exitCode = 1;
}

