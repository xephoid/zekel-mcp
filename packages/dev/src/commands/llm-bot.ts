#!/usr/bin/env tsx
// CLI for the comprehension LLM-bot. Drives one HUMAN seat with a real (local)
// LLM that reads ONLY the human-facing surface (player view + next_step directive
// + recent log) and constructs the move JSON free-form. AI opponents play medium.
// Scores flow + directive-adherence — does a weak model, reading what a human
// reads, pick the right action and recognize when it owes a physical report.
//
// Needs a reachable ollama server (default the LAN box). The model must be pulled.
//
// Examples:
//   tsx scripts/llm-bot.ts --game=sweetlands-imperium --n=1 --players=3
//   tsx scripts/llm-bot.ts --game=sweetlands-imperium --n=3 --model=qwen3.6:35b --think
//   tsx scripts/llm-bot.ts --game=cybernoir-2127 --seed=1 --transcript

import { parseArgs } from 'node:util';
import { LlmBot, type LlmBotPlayer, type LlmBotResult, type TurnOutcome } from '../harness/llmBot.js';

const DEFAULT_BASE_URL = 'http://192.168.68.100:11434';
const DEFAULT_MODEL = 'qwen3.6:35b';

interface Cli {
  game: string;
  n: number;
  playerCount: number;
  seed: number;
  model: string;
  baseUrl: string;
  think: boolean;
  transcript: boolean;
}

function parseCli(argv: string[]): Cli {
  const { values } = parseArgs({
    args: argv,
    options: {
      game: { type: 'string' },
      n: { type: 'string', default: '1' },
      players: { type: 'string', default: '3' },
      seed: { type: 'string', default: '1' },
      model: { type: 'string', default: DEFAULT_MODEL },
      'base-url': { type: 'string', default: DEFAULT_BASE_URL },
      think: { type: 'boolean', default: false },
      transcript: { type: 'boolean', default: false },
    },
  });
  if (!values.game) {
    throw new Error(
      'Usage: tsx scripts/llm-bot.ts --game=<id> [--n=N] [--players=K] [--seed=S] [--model=M] [--base-url=URL] [--think] [--transcript]',
    );
  }
  return {
    game: values.game,
    n: Number(values.n),
    playerCount: Number(values.players),
    seed: Number(values.seed),
    model: values.model!,
    baseUrl: values['base-url']!,
    think: values.think!,
    transcript: values.transcript!,
  };
}

// Seat 0 is the LLM-controlled human; the rest are AI opponents at medium.
function makePlayers(count: number): LlmBotPlayer[] {
  return Array.from({ length: count }, (_, i) =>
    i === 0
      ? ({ player_id: `p${i + 1}`, kind: 'human' } as LlmBotPlayer)
      : ({ player_id: `p${i + 1}`, kind: 'ai', difficulty: 'medium' } as LlmBotPlayer),
  );
}

const OUTCOME_ORDER: TurnOutcome[] = ['applied_ok', 'report_ok', 'bad_params', 'wrong_action', 'missed_report', 'format_error'];

export async function main(argv: string[]): Promise<void> {
  const cli = parseCli(argv);
  const bot = new LlmBot({ baseUrl: cli.baseUrl, model: cli.model, think: cli.think });
  await bot.start();
  const results: LlmBotResult[] = [];
  try {
    for (let i = 0; i < cli.n; i++) {
      const seed = cli.seed + i;
      const r = await bot.runOneGame({
        game_id: cli.game,
        players: makePlayers(cli.playerCount),
        model: cli.model,
        seed,
      });
      results.push(r);
      const status = r.error ? `ERROR ${r.error.code}` : r.completed ? 'completed' : r.blocked ? `blocked (${r.blocked.move_type})` : 'stopped';
      process.stderr.write(
        `  game ${i + 1}/${cli.n} (seed ${seed}): ${status} — ${r.human_turns} human turns, adherence ${(r.adherence_rate * 100).toFixed(0)}%\n`,
      );
    }
  } finally {
    await bot.close();
  }

  // Aggregate.
  const totals: Record<TurnOutcome, number> = { applied_ok: 0, report_ok: 0, bad_params: 0, wrong_action: 0, missed_report: 0, format_error: 0 };
  let humanTurns = 0;
  for (const r of results) {
    humanTurns += r.human_turns;
    for (const k of OUTCOME_ORDER) totals[k] += r.adherence[k];
  }
  const good = totals.applied_ok + totals.report_ok;
  const completed = results.filter((r) => r.completed).length;
  const errored = results.filter((r) => r.error).length;

  process.stdout.write(`\n=== llm-bot: ${cli.game} (${cli.playerCount}p) — ${cli.n} game(s), model ${cli.model} ===\n`);
  process.stdout.write(`completed: ${completed}/${cli.n}   errored: ${errored}   human turns: ${humanTurns}\n`);
  process.stdout.write(`directive-adherence: ${humanTurns > 0 ? ((good / humanTurns) * 100).toFixed(1) : '100.0'}%  (${good}/${humanTurns} right action)\n`);
  process.stdout.write('outcomes:\n');
  for (const k of OUTCOME_ORDER) {
    const n = totals[k];
    if (n > 0) process.stdout.write(`  ${k}: ${n}\n`);
  }

  // Show a sample of the misses — the actual comprehension failures to learn from.
  const misses = results.flatMap((r) =>
    r.turns.filter((t) => t.outcome !== 'applied_ok' && t.outcome !== 'report_ok').map((t) => ({ seed: r.seed, ...t })),
  );
  if (misses.length > 0) {
    process.stdout.write(`\nmisses (${misses.length}) — sample:\n`);
    for (const m of misses.slice(0, 12)) {
      process.stdout.write(`  [seed ${m.seed}, step ${m.step}] ${m.outcome}: ${m.detail ?? ''}\n`);
      process.stdout.write(`     directive: ${m.directive.slice(0, 140)}\n`);
      process.stdout.write(`     model said: ${m.model_raw.replace(/\s+/g, ' ').slice(0, 140)}\n`);
    }
  }

  if (cli.transcript) {
    process.stdout.write('\n=== full transcript ===\n');
    process.stdout.write(JSON.stringify(results, null, 2));
    process.stdout.write('\n');
  }

  for (const r of results.filter((x) => x.error)) {
    process.stdout.write(`  ERROR seed ${r.seed}: ${r.error!.code} — ${r.error!.message.slice(0, 200)}\n`);
  }
  if (errored > 0) process.exitCode = 1;
}

