#!/usr/bin/env tsx
// CLI for the desync-detection harness. Runs TWO parallel sessions (reference =
// the human's real board; model = the assistant's tracked state), applies the
// MODEL'S move even when wrong, and measures how long a silent desync goes
// unnoticed. The headline number is silent_turns.
//
// Examples:
//   tsx scripts/desync-bot.ts --game=sweetlands-imperium --players=3 --seed=1
//   tsx scripts/desync-bot.ts --game=sweetlands-imperium --seed=2 --assistant=qwen3.6:35b

import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DesyncBot, type DesyncPlayer, type DesyncResult } from '../harness/desyncBot.js';

const DEFAULT_BASE_URL = 'http://192.168.68.100:11434';
const DEFAULT_MODEL = 'qwen3.6:35b';

function parseCli(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      game: { type: 'string' },
      players: { type: 'string', default: '3' },
      seed: { type: 'string', default: '1' },
      assistant: { type: 'string', default: DEFAULT_MODEL },
      human: { type: 'string', default: DEFAULT_MODEL },
      'base-url': { type: 'string', default: DEFAULT_BASE_URL },
      out: { type: 'string', default: './harness-out' },
      // Which seat index (0-based) is the HUMAN; the rest are AI. Default 0. The
      // human's faction follows the game's default side assignment by seat order,
      // so for SW:R --human-seat=1 makes the human the Empire (seat 0 → Rebel,
      // seat 1 → Empire) without any side-preset option.
      'human-seat': { type: 'string', default: '0' },
      // 'imperative' (default) appends "record it with apply_move" to every turn —
      // the historical gate. 'freeform' speaks only the human's words, like a real
      // chat client; pair with the claims-audit counts to measure fabrication.
      mode: { type: 'string', default: 'imperative' },
      // Setup gauntlet: the assistant creates the MODEL session itself from a
      // conversational request (list_games → create_session), with LibreChat's
      // client-side schema check emulated — the phase where the first real
      // 9B game died. The reference session is still created correctly.
      'from-setup': { type: 'boolean', default: false },
      'human-name': { type: 'string', default: 'Zeke' },
      // Run the assistant WITHOUT model thinking — validates whether tracking
      // quality holds when the proxy disables reasoning (its --no-think).
      'no-think': { type: 'boolean', default: false },
    },
  });
  if (values.mode !== 'imperative' && values.mode !== 'freeform') {
    throw new Error(`--mode must be "imperative" or "freeform", got "${values.mode}"`);
  }
  if (!values.game) throw new Error('Usage: tsx scripts/desync-bot.ts --game=<id> [--players=K] [--seed=S] [--human-seat=N] [--assistant=M] [--human=M] [--out=DIR]');
  return {
    game: values.game,
    players: Number(values.players),
    seed: Number(values.seed),
    assistant: values.assistant!,
    human: values.human!,
    baseUrl: values['base-url']!,
    outDir: values.out!,
    humanSeat: Number(values['human-seat']),
    mode: values.mode as 'imperative' | 'freeform',
    fromSetup: values['from-setup']!,
    humanName: values['human-name']!,
    noThink: values['no-think']!,
  };
}

function makePlayers(count: number, humanSeat: number): DesyncPlayer[] {
  return Array.from({ length: count }, (_, i) =>
    i === humanSeat ? ({ player_id: `p${i + 1}`, kind: 'human' } as DesyncPlayer) : ({ player_id: `p${i + 1}`, kind: 'ai', difficulty: 'medium' } as DesyncPlayer),
  );
}

export async function main(argv: string[]): Promise<void> {
  const cli = parseCli(argv);
  const bot = new DesyncBot({
    assistant: { baseUrl: cli.baseUrl, model: cli.assistant, think: !cli.noThink, timeoutMs: 300_000 },
    human: { baseUrl: cli.baseUrl, model: cli.human, think: false, timeoutMs: 120_000 },
  });
  await bot.start();
  mkdirSync(cli.outDir, { recursive: true });
  // Baselining runs the same game+seed across models and prompt modes, so the
  // transcript name carries both (the bare historical name would clobber).
  // Slug drops EVERY non-alphanumeric run, dots included ("qwen3.5:9b" →
  // "qwen3-5-9b"). Anything that looks a transcript up by model name must slug
  // it the same way; a regex that keeps "." finds nothing for a dotted model.
  const modelSlug = cli.assistant.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const file = resolve(
    cli.outDir,
    `desync-${cli.game}-seed${cli.seed}-${modelSlug}${cli.mode === 'freeform' ? '-freeform' : ''}${cli.fromSetup ? '-setup' : ''}${cli.noThink ? '-nothink' : ''}.json`,
  );
  let r: DesyncResult;
  try {
    r = await bot.runOneGame({
      game_id: cli.game,
      players: makePlayers(cli.players, cli.humanSeat),
      assistant_model: cli.assistant,
      human_model: cli.human,
      seed: cli.seed,
      prompt_mode: cli.mode,
      from_setup: cli.fromSetup ? { human_name: cli.humanName } : undefined,
      onTurn: (t, partial) => {
        writeFileSync(file, JSON.stringify(partial, null, 2));
        const flag = t.matched ? 'ok ' : t.recorded == null ? (t.claims_audit === 'fabricated_confirmation' ? 'FAB ' : 'MISS') : 'WRONG';
        process.stderr.write(`  [${t.step}] ${flag} ${t.player_id}: "${(t.human_utterance || '').replace(/\s+/g, ' ').slice(0, 70)}"\n`);
      },
    });
  } finally {
    await bot.close();
  }
  writeFileSync(file, JSON.stringify(r, null, 2));

  process.stdout.write(`\n=== desync-bot: ${cli.game} (${cli.players}p), seed ${cli.seed} ===\n`);
  process.stdout.write(`assistant=${cli.assistant}  human-sim=${cli.human}  prompt-mode=${cli.mode}${cli.fromSetup ? '  FROM-SETUP' : ''}\n`);
  if (r.setup) {
    const s = r.setup;
    process.stdout.write(`\n--- setup gauntlet ---\n`);
    process.stdout.write(`human said: "${s.opening}"\n`);
    process.stdout.write(
      `create_session: ${s.create_attempts} attempt(s) — ${s.client_schema_rejections} client-schema rejection(s), ` +
        `${s.server_rejections} server rejection(s)${s.recovered ? ' — RECOVERED' : ''}; session ${s.session_id ?? 'NEVER CREATED'}\n`,
    );
    if (s.discrepancies.length) {
      process.stdout.write(`setup discrepancies (${s.discrepancies.length}):\n`);
      for (const d of s.discrepancies) process.stdout.write(`    - ${d}\n`);
    } else {
      process.stdout.write(`setup FAITHFUL — seats, name, and difficulties match the request.\n`);
    }
  }
  if (r.error) {
    process.stdout.write(`ERROR ${r.error.code}: ${r.error.message.slice(0, 200)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`human turns: ${r.human_turns}   recorded correctly: ${r.correct_turns}/${r.human_turns}   ref game ${r.ref_completed ? 'completed' : 'in progress'}\n`);
  process.stdout.write(
    `answer-shape hint (next_step.human_response): provided on ${r.human_response_turns}/${r.human_turns} human turns; ` +
      `model's record conformed to records_as on ${r.human_response_conformed}/${r.human_response_turns}\n`,
  );
  const noRecord = r.fabricated_confirmations + r.honest_failures + r.no_record_no_claim;
  process.stdout.write(
    `claims audit: ${noRecord} turn(s) recorded nothing — ` +
      `${r.fabricated_confirmations} FABRICATED a confirmation, ${r.honest_failures} honestly failed/asked, ${r.no_record_no_claim} neither\n`,
  );
  if (r.fabricated_confirmations > 0) {
    process.stdout.write(`>>> FABRICATION: the model told the human "done" on ${r.fabricated_confirmations} turn(s) the server never heard about.\n`);
  }
  if (r.first_desync_turn === null) {
    process.stdout.write(`NO DESYNC — the assistant tracked the entire game correctly.\n`);
  } else {
    process.stdout.write(`FIRST DESYNC at turn ${r.first_desync_turn} — the model's tracked board first differs from reality here:\n`);
    for (const d of r.desync_detail ?? []) process.stdout.write(`    ${d}\n`);
    if (r.surfaced_turn !== null) {
      process.stdout.write(`SURFACED at turn ${r.surfaced_turn}: ${r.surfaced_how}\n`);
      process.stdout.write(`>>> SILENT for ${r.silent_turns} turn(s) before it could be noticed.\n`);
    } else {
      process.stdout.write(`>>> NEVER SURFACED — desynced at turn ${r.first_desync_turn} and stayed silently wrong for ${r.silent_turns}+ turns (game ${r.ref_completed ? 'ended' : 'stopped'} still corrupted).\n`);
    }
  }
  if (r.result) process.stdout.write(`real-game result: ${JSON.stringify(r.result)}\n`);

  // The first few divergent turns — what the model got wrong.
  const bad = r.turns.filter((t) => !t.matched);
  if (bad.length) {
    process.stdout.write(`\nwrong/missed recordings (${bad.length}) — first 8:\n`);
    for (const t of bad.slice(0, 8)) {
      process.stdout.write(`  [${t.step}] human: "${(t.human_utterance || '').replace(/\s+/g, ' ').slice(0, 80)}"\n`);
      process.stdout.write(`        meant:    ${JSON.stringify(t.ground_truth).slice(0, 90)}\n`);
      process.stdout.write(`        recorded: ${JSON.stringify(t.recorded).slice(0, 90)}\n`);
    }
  }
  process.stdout.write(`\nfull transcript: ${file}\n`);
}

