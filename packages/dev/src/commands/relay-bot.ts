#!/usr/bin/env tsx
// CLI for the relay-fidelity harness: can a weak LLM's PROSE carry an AI turn
// well enough that a human could execute it on the physical board? Round trip:
// run_ai_turn response → relayer prose → reader reconstruction → applied to a
// shadow session → canonical state diff vs reality (the desync metric).
//
//   scout (no LLM): rank every AI batch of a seeded game by relay complexity
//     tsx scripts/relay-bot.ts --game=sweetlands-imperium --players=2 --seed=1 --mode=scout
//   probe: round-trip the K most complex batches, N reps each
//     tsx scripts/relay-bot.ts --game=sweetlands-imperium --seed=1 --mode=probe --probes=3 --reps=3
//   full: round-trip EVERY AI batch of a whole game (the endgame gate)
//     tsx scripts/relay-bot.ts --game=sweetlands-imperium --seed=1 --mode=full
//   --calibrate: skip the relayer, feed the reader the raw JSON — the reader's
//     ceiling every live score is read against.
//   --spoken: skip the relayer, feed the reader ONLY each move's state_summary,
//     in order and verbatim — what a voice client (zekel Live) reads aloud.
//     Tests whether the server's own text is enough to rebuild an AI turn.

import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RelayBot, type RelayPlayer, type RelayBatch, type ScoutResult } from '../harness/relayBot.js';

const DEFAULT_BASE_URL = 'http://192.168.68.100:11434';
const DEFAULT_MODEL = 'qwen3.6:35b';

function parseCli(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      game: { type: 'string' },
      players: { type: 'string', default: '2' },
      seed: { type: 'string', default: '1' },
      mode: { type: 'string', default: 'probe' }, // scout | probe | full
      relayer: { type: 'string', default: DEFAULT_MODEL },
      reader: { type: 'string', default: DEFAULT_MODEL },
      'base-url': { type: 'string', default: DEFAULT_BASE_URL },
      out: { type: 'string', default: './harness-out' },
      'human-seat': { type: 'string', default: '0' },
      probes: { type: 'string', default: '3' }, // probe mode: top-K batches by complexity
      reps: { type: 'string', default: '3' }, // probe mode: repetitions per batch
      batches: { type: 'string' }, // probe mode: explicit comma-separated batch indexes (skips the top-K pick)
      calibrate: { type: 'boolean', default: false },
      spoken: { type: 'boolean', default: false },
    },
  });
  if (!values.game || !['scout', 'probe', 'full'].includes(values.mode!)) {
    throw new Error(
      'Usage: tsx scripts/relay-bot.ts --game=<id> --mode=scout|probe|full [--players=K] [--seed=S] [--human-seat=N] [--probes=K] [--reps=N] [--batches=i,j] [--calibrate|--spoken] [--relayer=M] [--reader=M] [--out=DIR]',
    );
  }
  return {
    game: values.game,
    players: Number(values.players),
    seed: Number(values.seed),
    mode: values.mode as 'scout' | 'probe' | 'full',
    relayer: values.relayer!,
    reader: values.reader!,
    baseUrl: values['base-url']!,
    outDir: values.out!,
    humanSeat: Number(values['human-seat']),
    probes: Number(values.probes),
    reps: Number(values.reps),
    batches: values.batches ? values.batches.split(',').map(Number) : null,
    calibrate: values.calibrate!,
    spoken: values.spoken!,
  };
}

function makePlayers(count: number, humanSeat: number): RelayPlayer[] {
  return Array.from({ length: count }, (_, i) =>
    i === humanSeat
      ? ({ player_id: `p${i + 1}`, kind: 'human' } as RelayPlayer)
      : ({ player_id: `p${i + 1}`, kind: 'ai', difficulty: 'medium' } as RelayPlayer),
  );
}

function batchLine(b: RelayBatch): string {
  const facts = b.fact_checks;
  const inRelay = facts.filter((f) => f.in_relay).length;
  const inRecon = facts.filter((f) => f.in_reconstruction).length;
  const flag = b.matched ? 'ok   ' : 'DIVERGED';
  return (
    `  [batch ${b.batch_index} @ step ${b.step}] ${flag} moves=${b.moves_played} ` +
    `facts relay=${inRelay}/${facts.length} recon=${inRecon}/${facts.length}` +
    (b.unfilled_placeholders ? ` unfilled=${b.unfilled_placeholders}` : '') +
    (b.reader_retries ? ` reader_retries=${b.reader_retries}` : '') +
    (b.apply_failures.length ? ` apply_failures=${b.apply_failures.length}` : '') +
    (b.leaks.length ? ` LEAKS=${b.leaks.join(',')}` : '') +
    (b.spoken_text_issues?.length ? ` spoken_text_issues=${b.spoken_text_issues.length}` : '')
  );
}

export async function main(argv: string[]): Promise<void> {
  const cli = parseCli(argv);
  // The relay harness's shadow session receives the AI moves the human would
  // physically execute from the prose — via apply_move on AI seats, which the
  // AI_SEAT_NO_APPLY guard exists to block for real clients. Lift it on the
  // server THIS harness spawns only (the Harness child inherits process.env).
  process.env.ZEKEL_HARNESS_AI_APPLY = '1';
  const bot = new RelayBot({
    relayer: { baseUrl: cli.baseUrl, model: cli.relayer, think: true, timeoutMs: 300_000 },
    reader: { baseUrl: cli.baseUrl, model: cli.reader, think: true, timeoutMs: 300_000 },
  });
  await bot.start();
  mkdirSync(cli.outDir, { recursive: true });
  const players = makePlayers(cli.players, cli.humanSeat);
  const base = { game_id: cli.game, players, seed: cli.seed };

  try {
    if (cli.mode === 'scout') {
      const r = await bot.scoutGame(base);
      const file = resolve(cli.outDir, `relay-scout-${cli.game}-seed${cli.seed}.json`);
      writeFileSync(file, JSON.stringify(r, null, 2));
      printScout(r, file);
      if (r.error) process.exitCode = 1;
      return;
    }

    if (cli.mode === 'probe') {
      // Scout first (cheap, no LLM) so the probe targets the worst-case batches.
      let targets = cli.batches;
      let scout: ScoutResult | null = null;
      if (!targets) {
        scout = await bot.scoutGame(base);
        if (scout.error) {
          process.stdout.write(`scout failed: ${scout.error.code}: ${scout.error.message.slice(0, 300)}\n`);
          process.exitCode = 1;
          return;
        }
        targets = [...scout.batches]
          .sort((a, b) => b.complexity - a.complexity)
          .slice(0, cli.probes)
          .map((b) => b.batch_index);
        process.stderr.write(`scout: ${scout.batches.length} AI batches; probing ${targets.join(', ')} (top ${cli.probes} by complexity)\n`);
      }
      const file = resolve(cli.outDir, `relay-probe-${cli.game}-seed${cli.seed}${cli.calibrate ? '-calibrate' : ''}${cli.spoken ? '-spoken' : ''}.json`);
      const r = await bot.probeBatches({
        ...base,
        relayer_model: cli.relayer,
        reader_model: cli.reader,
        batch_indexes: targets,
        reps: cli.reps,
        calibrate: cli.calibrate,
        spoken: cli.spoken,
        onRep: (probeIdx, rep, b, partial) => {
          writeFileSync(file, JSON.stringify(partial, null, 2));
          process.stderr.write(`[probe batch ${probeIdx} rep ${rep + 1}/${cli.reps}]\n${batchLine(b)}\n`);
        },
      });
      writeFileSync(file, JSON.stringify(r, null, 2));
      process.stdout.write(`\n=== relay-bot probe: ${cli.game} (${cli.players}p), seed ${cli.seed}${cli.calibrate ? ' [CALIBRATE — reader ceiling]' : ''}${cli.spoken ? ' [SPOKEN — state_summary lines only, no relayer]' : ''} ===\n`);
      process.stdout.write(`relayer=${cli.relayer}  reader=${cli.reader}\n`);
      for (const p of r.probes) {
        process.stdout.write(`\nbatch ${p.batch_index} (complexity ${p.complexity}): matched ${p.reps_matched}/${p.reps.length} reps\n`);
        for (const rep of p.reps) {
          process.stdout.write(`${batchLine(rep)}\n`);
          if (!rep.matched) {
            for (const d of (rep.state_diff ?? []).slice(0, 6)) process.stdout.write(`      ${d}\n`);
            for (const a of rep.possible_class_a ?? []) process.stdout.write(`      possible CLASS A (fact absent from server response): ${a}\n`);
          }
        }
      }
      if (r.error) {
        process.stdout.write(`ERROR ${r.error.code}: ${r.error.message.slice(0, 300)}\n`);
        process.exitCode = 1;
      }
      process.stdout.write(`\nfull transcript: ${file}\n`);
      return;
    }

    // full
    const file = resolve(cli.outDir, `relay-full-${cli.game}-seed${cli.seed}${cli.calibrate ? '-calibrate' : ''}${cli.spoken ? '-spoken' : ''}.json`);
    const r = await bot.runFullGame({
      ...base,
      relayer_model: cli.relayer,
      reader_model: cli.reader,
      calibrate: cli.calibrate,
      spoken: cli.spoken,
      onBatch: (b, partial) => {
        writeFileSync(file, JSON.stringify(partial, null, 2));
        process.stderr.write(`${batchLine(b)}\n`);
      },
    });
    writeFileSync(file, JSON.stringify(r, null, 2));
    process.stdout.write(`\n=== relay-bot full: ${cli.game} (${cli.players}p), seed ${cli.seed}${cli.calibrate ? ' [CALIBRATE — reader ceiling]' : ''}${cli.spoken ? ' [SPOKEN — state_summary lines only, no relayer]' : ''} ===\n`);
    process.stdout.write(`relayer=${cli.relayer}  reader=${cli.reader}\n`);
    if (r.error) {
      process.stdout.write(`ERROR ${r.error.code}: ${r.error.message.slice(0, 300)}\n`);
      process.exitCode = 1;
    }
    process.stdout.write(
      `AI batches: ${r.ai_batches}   matched: ${r.batches_matched}/${r.ai_batches}   ref game ${r.ref_completed ? 'completed' : 'stopped'}\n`,
    );
    process.stdout.write(
      `fact coverage: relay ${r.facts_in_relay}/${r.facts_total}, reconstruction ${r.facts_in_reconstruction}/${r.facts_total}\n`,
    );
    if (r.first_relay_desync_step === null) {
      process.stdout.write('NO RELAY DESYNC — a human executing only the prose kept a correct board all game.\n');
    } else {
      process.stdout.write(`FIRST RELAY DESYNC at step ${r.first_relay_desync_step} (AI batch ${r.first_relay_desync_batch}):\n`);
      const bad = r.batches.find((b) => b.batch_index === r.first_relay_desync_batch);
      for (const d of (bad?.state_diff ?? []).slice(0, 8)) process.stdout.write(`    ${d}\n`);
      for (const a of bad?.possible_class_a ?? []) process.stdout.write(`    possible CLASS A (fact absent from server response): ${a}\n`);
      if (r.surfaced_step !== null) {
        process.stdout.write(`SURFACED at step ${r.surfaced_step}: ${r.surfaced_how}\n>>> SILENT for ${r.silent_steps} step(s).\n`);
      } else {
        process.stdout.write(`>>> NEVER SURFACED — silently wrong for ${r.silent_steps}+ step(s).\n`);
      }
    }
    const leaks = r.batches.flatMap((b) => b.leaks);
    if (leaks.length) process.stdout.write(`HIDDEN-INFO LEAKS in prose: ${[...new Set(leaks)].join(', ')}\n`);
    if (r.result) process.stdout.write(`real-game result: ${JSON.stringify(r.result)}\n`);
    process.stdout.write(`\nfull transcript: ${file}\n`);
  } finally {
    await bot.close();
  }
}

function printScout(r: ScoutResult, file: string): void {
  process.stdout.write(`\n=== relay-bot scout: ${r.game_id}, seed ${r.seed} ===\n`);
  if (r.error) process.stdout.write(`ERROR ${r.error.code}: ${r.error.message.slice(0, 300)}\n`);
  process.stdout.write(`AI batches: ${r.batches.length}   ref game ${r.ref_completed ? 'completed' : 'stopped'} in ${r.steps} steps\n`);
  const ranked = [...r.batches].sort((a, b) => b.complexity - a.complexity).slice(0, 10);
  process.stdout.write('most complex batches (probe these):\n');
  for (const b of ranked) {
    process.stdout.write(`  batch ${b.batch_index} @ step ${b.step}: complexity ${b.complexity}, ${b.moves_played} move(s) — "${b.preview}"\n`);
  }
  process.stdout.write(`\nfull scout: ${file}\n`);
}

