#!/usr/bin/env tsx
// CLI for the assistant harness — the faithful scenario. A SIMULATED human (game
// AI + a human-sim LLM that speaks the move in plain language) plays a seat; the
// ASSISTANT model under test operates the MCP tools, records the human's moves,
// resolves the AI opponents, and SPEAKS back to the human. We auto-score the
// move translation and write the full transcript (human utterance → tool calls →
// spoken reply, every turn) to a JSON file for manual review.
//
// Needs a reachable ollama server with both models pulled.
//
// Examples:
//   tsx scripts/assistant-bot.ts --game=sweetlands-imperium --players=3 --max-human-turns=8
//   tsx scripts/assistant-bot.ts --game=sweetlands-imperium --assistant=qwen3.6:35b --human=qwen3.5:9b --out=./harness-out

import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AssistantBot, type AssistantPlayer, type AssistantGameResult } from '../harness/assistantBot.js';

const DEFAULT_BASE_URL = 'http://192.168.68.100:11434';
const DEFAULT_ASSISTANT = 'qwen3.6:35b';
const DEFAULT_HUMAN = 'qwen3.6:35b';

interface Cli {
  game: string;
  players: number;
  seed: number;
  assistant: string;
  human: string;
  baseUrl: string;
  maxHumanTurns: number;
  outDir: string;
}

function parseCli(argv: string[]): Cli {
  const { values } = parseArgs({
    args: argv,
    options: {
      game: { type: 'string' },
      players: { type: 'string', default: '3' },
      seed: { type: 'string', default: '1' },
      assistant: { type: 'string', default: DEFAULT_ASSISTANT },
      human: { type: 'string', default: DEFAULT_HUMAN },
      'base-url': { type: 'string', default: DEFAULT_BASE_URL },
      'max-human-turns': { type: 'string', default: '8' },
      out: { type: 'string', default: './harness-out' },
    },
  });
  if (!values.game) {
    throw new Error('Usage: tsx scripts/assistant-bot.ts --game=<id> [--players=K] [--seed=S] [--assistant=M] [--human=M] [--base-url=URL] [--max-human-turns=N] [--out=DIR]');
  }
  return {
    game: values.game,
    players: Number(values.players),
    seed: Number(values.seed),
    assistant: values.assistant!,
    human: values.human!,
    baseUrl: values['base-url']!,
    maxHumanTurns: Number(values['max-human-turns']),
    outDir: values.out!,
  };
}

function makePlayers(count: number): AssistantPlayer[] {
  return Array.from({ length: count }, (_, i) =>
    i === 0
      ? ({ player_id: `p${i + 1}`, kind: 'human' } as AssistantPlayer)
      : ({ player_id: `p${i + 1}`, kind: 'ai', difficulty: 'medium' } as AssistantPlayer),
  );
}

export async function main(argv: string[]): Promise<void> {
  const cli = parseCli(argv);
  const bot = new AssistantBot({
    // Assistant turns are multi-round tool-calling loops with thinking on — give
    // each model call a generous timeout so a long reasoning trace doesn't abort.
    assistant: { baseUrl: cli.baseUrl, model: cli.assistant, think: true, timeoutMs: 300_000 },
    human: { baseUrl: cli.baseUrl, model: cli.human, think: false, timeoutMs: 120_000 },
  });
  await bot.start();
  // Compute the transcript path up front and flush it after every turn, so a long
  // game can be peeked mid-run and a crash still leaves a partial transcript.
  mkdirSync(cli.outDir, { recursive: true });
  const file = resolve(cli.outDir, `assistant-${cli.game}-seed${cli.seed}.json`);
  let r: AssistantGameResult;
  try {
    r = await bot.runOneGame({
      game_id: cli.game,
      players: makePlayers(cli.players),
      assistant_model: cli.assistant,
      human_model: cli.human,
      seed: cli.seed,
      maxHumanTurns: cli.maxHumanTurns,
      onTurn: (rec, partial) => {
        writeFileSync(file, JSON.stringify(partial, null, 2));
        if (rec.kind === 'human') {
          process.stderr.write(`  [${rec.step}] human(${rec.player_id}) → ${rec.translation}${rec.is_report ? ' (report)' : ''}: "${(rec.human_utterance ?? '').replace(/\s+/g, ' ').slice(0, 80)}"\n`);
        } else {
          const ran = rec.tool_calls.filter((c) => c.name === 'run_ai_turn' && c.ok).length;
          process.stderr.write(`  [${rec.step}] ai(${rec.player_id}) → ran_ai_turn=${ran}, ${(rec.spoken_reply || '(no reply)').replace(/\s+/g, ' ').slice(0, 70)}\n`);
        }
      },
    });
  } finally {
    await bot.close();
  }

  // Final flush of the complete transcript.
  writeFileSync(file, JSON.stringify(r, null, 2));

  const t = r.translation;
  const good = t.exact + t.type_only;
  process.stdout.write(`\n=== assistant-bot: ${cli.game} (${cli.players}p), seed ${cli.seed} ===\n`);
  process.stdout.write(`assistant=${cli.assistant}  human-sim=${cli.human}\n`);
  const status = r.error
    ? `ERROR ${r.error.code}`
    : r.completed
      ? 'completed'
      : r.blocked
        ? `BLOCKED on ${r.blocked.move_type} (${r.blocked.reason})`
        : 'partial (turn cap)';
  process.stdout.write(`human turns: ${r.human_turns}   ai turns: ${r.ai_turns}   ${status}\n`);
  if (r.result) process.stdout.write(`result: ${JSON.stringify(r.result)}\n`);
  process.stdout.write(`move-translation: ${r.human_turns > 0 ? ((good / r.human_turns) * 100).toFixed(1) : '100.0'}%  (exact ${t.exact}, type-only ${t.type_only}, mismatch ${t.mismatch}, none ${t.none})\n`);
  if (r.error) process.stdout.write(`error: ${r.error.message.slice(0, 200)}\n`);

  // Print a readable play-by-play so the spoken replies can be eyeballed without
  // opening the JSON (the JSON has the full tool-call detail).
  process.stdout.write(`\n--- play-by-play (full transcript: ${file}) ---\n`);
  for (const turn of r.turns) {
    if (turn.kind === 'human') {
      process.stdout.write(`\n[${turn.step}] HUMAN(${turn.player_id}): "${(turn.human_utterance ?? '').replace(/\s+/g, ' ')}"\n`);
      process.stdout.write(`      ground truth: ${JSON.stringify(turn.ground_truth_move)}${turn.is_report ? ' (report)' : ''}\n`);
      process.stdout.write(`      recorded:     ${JSON.stringify(turn.recorded_move)}  [${turn.translation}]\n`);
      process.stdout.write(`      ASSISTANT → human: ${(turn.spoken_reply || '(no reply)').replace(/\s+/g, ' ').slice(0, 400)}\n`);
    } else {
      process.stdout.write(`\n[${turn.step}] AI(${turn.player_id}) turn — assistant ran ${turn.tool_calls.filter((c) => c.name === 'run_ai_turn' && c.ok).length} run_ai_turn\n`);
      process.stdout.write(`      ASSISTANT → human: ${(turn.spoken_reply || '(no reply)').replace(/\s+/g, ' ').slice(0, 500)}\n`);
    }
    if (turn.note) process.stdout.write(`      note: ${turn.note}\n`);
  }
  if (r.error) process.exitCode = 1;
}

