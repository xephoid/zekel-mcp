// Relay-fidelity harness — does the assistant's PROSE carry the AI's turn?
//
// The desync harness tests the inbound half of the table loop (human declares →
// model records); it drives AI turns itself, so the OUTBOUND half — the model
// reading a run_ai_turn response and telling the human what the AI did, so the
// human can execute it on the physical board — is untested. This harness tests
// exactly that, as a round trip:
//
//   run_ai_turn (REFERENCE) ──▶ RELAYER (weak LLM): response JSON → prose
//                               ──▶ READER (weak LLM, sees ONLY the prose):
//                                   fills a blanked skeleton of the moves
//                               ──▶ the filled moves are APPLIED to a MODEL
//                                   session (the "physical board" a human built
//                                   from the prose alone)
//   headline: canonical-state diff MODEL vs REFERENCE — the same metric, and
//   the same compare machinery, as the desync harness.
//
// Human turns are driven deterministically on BOTH sessions (the desync
// harness's ground-truth policy) — no assistant LLM; every divergence here is
// the relay's.
//
// Attribution (whose fault is a divergence?) is annotated per batch:
//   A — the fact isn't in the run_ai_turn response at all (server summary
//       incomplete: no relay could convey it). Fix the game's log/summary.
//   B — in the response JSON but not in the prose (relayer dropped it).
//   C — relayer intermittent (differs across probe repeats).
//   D — in the prose but not in the reconstruction (reader noise — discount;
//       the --calibrate run, which feeds the reader the raw JSON as if it were
//       the relay, measures the reader's ceiling).
//
// Three modes (see docs/relay-harness-runbook.md):
//   scout — no LLM: play the REFERENCE forward, score every AI batch for
//           complexity; output the ranked worst-case turns to probe.
//   probe — replay a fresh session pair to one scouted batch, run the round
//           trip on just that batch, repeat N times (weak-model failures are
//           probabilistic).
//   full  — run the round trip on EVERY AI batch of a whole game; the MODEL
//           board accumulates whatever the prose conveyed, and the headline is
//           first_relay_desync_step / silent steps, exactly like desync.

import { Harness, parseToolJson, stringifyToolText, type ToolResponse } from './runner.js';
import { OllamaClient, type OllamaConfig, extractMoveJson } from './ollama.js';
import { checkSpokenText } from '../core/spokenText.js';
import {
  canonicalObject,
  deriveGroundTruth,
  diffPaths,
  idToNameMap,
  nameifyValue,
  type DesyncPlayer,
} from './desyncBot.js';
import { isHumanTurnStatus } from '@zekel/game-kit';

export type RelayPlayer = DesyncPlayer;

export interface FactCheck {
  fact: string;
  in_relay: boolean; // stated (lexically) in the relayer's prose
  in_reconstruction: boolean; // survived into the reader's filled skeleton
}

export interface RelayBatch {
  step: number; // drive-loop step at which this batch ran
  batch_index: number; // 0-based AI-batch counter within the game
  player_ids: string[]; // AI seat(s) that acted in the batch
  moves_played: number;
  complexity: number;
  ground_truth: unknown[]; // move_taken per move, minted ids resolved to names
  summaries: string[]; // state_summary per move (the authoritative fact list)
  relay_text: string; // what the relayer would SAY to the human
  reconstructed: unknown[] | null; // the reader's filled skeleton (null = unparseable)
  unfilled_placeholders: number; // skeleton slots the reader left blank
  reader_retries: number; // nudged re-reads after unfilled placeholders (see below)
  apply_failures: string[]; // reconstructed moves the MODEL engine rejected
  fact_checks: FactCheck[]; // lexical coverage — the A/B/D disambiguator
  leaks: string[]; // hidden names spoken in the prose (server privacy bug if real)
  matched: boolean; // MODEL canonical state === REFERENCE after the batch
  state_diff?: string[]; // diffPaths when not matched
  // Diff paths whose reference-side value never appears in the run_ai_turn
  // response text — the automated hint that the divergence is class A (the
  // summary itself omitted the fact). Judgment confirms; this only points.
  possible_class_a?: string[];
  // Advisory: summary lines that break the spoken-text conventions
  // (docs/spoken-narration.md, core/spokenText.ts) — a raw seat id, an
  // internal id, an abbreviation, debug text. Not part of the match verdict:
  // a relayer can still carry a badly worded summary; a voice client cannot.
  spoken_text_issues?: string[];
}

export interface RelayResult {
  game_id: string;
  seed: number;
  players: RelayPlayer[];
  mode: 'full' | 'probe';
  relayer_model: string;
  reader_model: string;
  calibrate: boolean;
  // --spoken: the relay IS the ordered state_summary lines (what a voice client
  // reads aloud), no relayer model — tests the server text alone.
  spoken: boolean;
  ref_completed: boolean;
  steps: number;
  ai_batches: number;
  batches_matched: number;
  batches: RelayBatch[];
  // Headline (full mode): mirrors the desync harness. null = never diverged.
  first_relay_desync_step: number | null;
  first_relay_desync_batch: number | null;
  surfaced_step: number | null;
  surfaced_how: string | null;
  silent_steps: number | null;
  never_surfaced: boolean;
  // Aggregate fact coverage (diagnostic, not the headline).
  facts_total: number;
  facts_in_relay: number;
  facts_in_reconstruction: number;
  result?: { winners?: string[]; scores?: Record<string, number>; summary?: string };
  error?: { code: string; message: string };
}

export interface ScoutBatch {
  step: number;
  batch_index: number;
  player_ids: string[];
  moves_played: number;
  complexity: number;
  preview: string; // first summary, truncated — enough to recognize the turn
}

export interface ScoutResult {
  game_id: string;
  seed: number;
  players: RelayPlayer[];
  ref_completed: boolean;
  steps: number;
  batches: ScoutBatch[]; // every AI batch, in play order (rank by complexity)
  result?: { winners?: string[]; scores?: Record<string, number>; summary?: string };
  error?: { code: string; message: string };
}

export interface ProbeReport {
  game_id: string;
  seed: number;
  players: RelayPlayer[];
  relayer_model: string;
  reader_model: string;
  calibrate: boolean;
  spoken: boolean;
  probes: Array<{
    batch_index: number;
    complexity: number;
    reps: RelayBatch[];
    reps_matched: number;
  }>;
  error?: { code: string; message: string };
}

interface NextStep {
  status?: string;
  active_player_id?: string | null;
  instruction?: string;
}
interface StepView {
  next_step?: NextStep;
  game_over?: boolean;
  result?: { winners?: string[]; scores?: Record<string, number>; summary?: string };
}
interface RunAiMoveEntry {
  player_id: string;
  move_taken: unknown;
  narration: string;
  state_summary: string;
}
interface RunAiTurnPayload {
  moves_played?: number;
  moves?: RunAiMoveEntry[];
  report_to_human?: string;
  game_over?: boolean;
  result?: { winners?: string[]; scores?: Record<string, number>; summary?: string };
}

const STEP_LIMIT = 1500;
// Consecutive zero-move AI batches with an unchanged directive = a stuck drive
// loop (a stale pending or a directive bug), not a game — bail with an error.
const MAX_ZERO_MOVE_STREAK = 3;

export class RelayBot {
  private readonly harness: Harness;
  private readonly relayer: OllamaClient;
  private readonly reader: OllamaClient;

  constructor(cfg: { relayer: OllamaConfig; reader: OllamaConfig }, harness?: Harness) {
    this.harness = harness ?? new Harness({ callTimeoutMs: 180_000 });
    this.relayer = new OllamaClient(cfg.relayer);
    this.reader = new OllamaClient(cfg.reader);
  }

  async start(): Promise<void> {
    await this.harness.start();
  }
  async close(): Promise<void> {
    await this.harness.close();
  }

  // ---- scout: LLM-free complexity survey of every AI batch --------------------

  async scoutGame(args: { game_id: string; players: RelayPlayer[]; seed: number; options?: Record<string, unknown> }): Promise<ScoutResult> {
    const res: ScoutResult = {
      game_id: args.game_id,
      seed: args.seed,
      players: args.players,
      ref_completed: false,
      steps: 0,
      batches: [],
    };
    const ref = await this.createSession(args);
    if (typeof ref !== 'string') {
      res.error = ref;
      return res;
    }
    const humanSeats = new Set(args.players.filter((p) => p.kind === 'human').map((p) => p.player_id));
    const viewSeat = this.pickViewSeat(args.players);
    let batchIndex = 0;
    const outcome = await this.drive(ref, null, humanSeats, viewSeat, res, async (active, step) => {
      const payload = await this.runAiBatch(ref, active);
      const moves = payload.moves ?? [];
      if (moves.length > 0) {
        const gt = await this.nameifiedGroundTruth(ref, moves);
        res.batches.push({
          step,
          batch_index: batchIndex,
          player_ids: [...new Set(moves.map((m) => m.player_id))],
          moves_played: moves.length,
          complexity: batchComplexity(gt.nameified, moves.map((m) => m.state_summary)),
          preview: (moves[0]?.state_summary ?? '').slice(0, 120),
        });
        batchIndex += 1;
      }
      return moves.length;
    });
    res.ref_completed = outcome.completed;
    if (outcome.error) res.error = outcome.error;
    if (outcome.result) res.result = outcome.result;
    return res;
  }

  // ---- full game: round-trip every AI batch, desync-style headline -------------

  async runFullGame(args: {
    game_id: string;
    players: RelayPlayer[];
    relayer_model: string;
    reader_model: string;
    seed: number;
    calibrate?: boolean;
    spoken?: boolean;
    options?: Record<string, unknown>;
    onBatch?: (b: RelayBatch, partial: RelayResult) => void;
  }): Promise<RelayResult> {
    const res = emptyRelayResult(args, 'full');
    const ref = await this.createSession(args);
    if (typeof ref !== 'string') {
      res.error = ref;
      return res;
    }
    const model = await this.createSession(args);
    if (typeof model !== 'string') {
      res.error = model;
      return res;
    }
    const humanSeats = new Set(args.players.filter((p) => p.kind === 'human').map((p) => p.player_id));
    const viewSeat = this.pickViewSeat(args.players);

    const outcome = await this.drive(ref, model, humanSeats, viewSeat, res, async (active, step) => {
      const payload = await this.runAiBatch(ref, active);
      const moves = payload.moves ?? [];
      if (moves.length === 0) {
        // Nothing to relay — keep the MODEL in lockstep for turn-order pendings
        // resolved as zero-move AI calls.
        await this.callOn(model, 'run_ai_turn', { player_id: active });
        return 0;
      }
      const batch = await this.relayRoundTrip({
        ref,
        model,
        payload,
        step,
        batchIndex: res.ai_batches,
        viewSeat,
        calibrate: args.calibrate ?? false,
        spoken: args.spoken ?? false,
      });
      res.ai_batches += 1;
      res.batches.push(batch);
      accumulateFacts(res, batch);
      if (batch.matched) res.batches_matched += 1;
      else if (res.first_relay_desync_step === null) {
        res.first_relay_desync_step = step;
        res.first_relay_desync_batch = batch.batch_index;
      }
      // SURFACED: the model's tracked turn/phase no longer matches reality — the
      // moment a human at the table could notice something is off.
      if (res.first_relay_desync_step !== null && res.surfaced_step === null) {
        const surfaced = await this.detectSurface(ref, model, viewSeat);
        if (surfaced) {
          res.surfaced_step = step;
          res.surfaced_how = surfaced;
          res.silent_steps = res.surfaced_step - res.first_relay_desync_step;
        }
      }
      args.onBatch?.(batch, res);
      return moves.length;
    });
    res.ref_completed = outcome.completed;
    res.steps = outcome.steps;
    if (outcome.error) res.error = outcome.error;
    if (outcome.result) res.result = outcome.result;
    if (res.first_relay_desync_step !== null && res.surfaced_step === null) {
      res.never_surfaced = true;
      res.silent_steps = outcome.steps - res.first_relay_desync_step;
    }
    return res;
  }

  // ---- probe: replay to one scouted batch, round-trip it N times ---------------

  async probeBatches(args: {
    game_id: string;
    players: RelayPlayer[];
    relayer_model: string;
    reader_model: string;
    seed: number;
    batch_indexes: number[]; // from the scout, usually the top-K by complexity
    reps: number;
    calibrate?: boolean;
    spoken?: boolean;
    options?: Record<string, unknown>;
    onRep?: (probe: number, rep: number, b: RelayBatch, partial: ProbeReport) => void;
  }): Promise<ProbeReport> {
    const report: ProbeReport = {
      game_id: args.game_id,
      seed: args.seed,
      players: args.players,
      relayer_model: args.relayer_model,
      reader_model: args.reader_model,
      calibrate: args.calibrate ?? false,
      spoken: args.spoken ?? false,
      probes: [],
    };
    for (const target of args.batch_indexes) {
      const probe: ProbeReport['probes'][number] = { batch_index: target, complexity: 0, reps: [], reps_matched: 0 };
      report.probes.push(probe);
      for (let rep = 0; rep < args.reps; rep++) {
        const b = await this.probeOnce(args, target);
        if ('code' in b) {
          report.error = b;
          return report;
        }
        probe.complexity = b.complexity;
        probe.reps.push(b);
        if (b.matched) probe.reps_matched += 1;
        args.onRep?.(target, rep, b, report);
      }
    }
    return report;
  }

  /** One probe repetition: fresh session pair, driven in LOCKSTEP (ground-truth
   *  human moves on both; real run_ai_turn on both) until the target batch, then
   *  the round trip runs on that batch alone. Everything before the target is
   *  deterministic — same seed, same ground-truth policy — so every rep probes
   *  the identical game state. */
  private async probeOnce(
    args: { game_id: string; players: RelayPlayer[]; seed: number; calibrate?: boolean; spoken?: boolean; options?: Record<string, unknown> },
    target: number,
  ): Promise<RelayBatch | { code: string; message: string }> {
    const ref = await this.createSession(args);
    if (typeof ref !== 'string') return ref;
    const model = await this.createSession(args);
    if (typeof model !== 'string') return model;
    const humanSeats = new Set(args.players.filter((p) => p.kind === 'human').map((p) => p.player_id));
    const viewSeat = this.pickViewSeat(args.players);
    let batchIndex = 0;
    let captured: RelayBatch | null = null;
    const shell = emptyRelayResult({ ...args, relayer_model: '', reader_model: '' }, 'probe');
    const outcome = await this.drive(ref, model, humanSeats, viewSeat, shell, async (active, step) => {
      const payload = await this.runAiBatch(ref, active);
      const moves = payload.moves ?? [];
      if (moves.length === 0) {
        await this.callOn(model, 'run_ai_turn', { player_id: active });
        return 0;
      }
      if (batchIndex < target) {
        // Not the probed batch — keep MODEL in lockstep with reality (same seed →
        // run_ai_turn plays the identical moves there).
        await this.callOn(model, 'run_ai_turn', { player_id: active });
        batchIndex += 1;
        return moves.length;
      }
      captured = await this.relayRoundTrip({
        ref,
        model,
        payload,
        step,
        batchIndex,
        viewSeat,
        calibrate: args.calibrate ?? false,
        spoken: args.spoken ?? false,
      });
      return null; // stop the drive — the probe is done
    });
    if (captured) return captured;
    return { code: 'PROBE_TARGET_NOT_REACHED', message: outcome.error?.message ?? `game ended before AI batch ${target}` };
  }

  // ---- the round trip on one batch ---------------------------------------------

  private async relayRoundTrip(ctx: {
    ref: string;
    model: string;
    payload: RunAiTurnPayload;
    step: number;
    batchIndex: number;
    viewSeat: string;
    calibrate: boolean;
    spoken: boolean;
  }): Promise<RelayBatch> {
    const moves = ctx.payload.moves ?? [];
    const summaries = moves.map((m) => m.state_summary);
    const gt = await this.nameifiedGroundTruth(ctx.ref, moves);
    const batch: RelayBatch = {
      step: ctx.step,
      batch_index: ctx.batchIndex,
      player_ids: [...new Set(moves.map((m) => m.player_id))],
      moves_played: moves.length,
      complexity: batchComplexity(gt.nameified, summaries),
      ground_truth: gt.nameified,
      summaries,
      relay_text: '',
      reconstructed: null,
      unfilled_placeholders: 0,
      reader_retries: 0,
      apply_failures: [],
      fact_checks: [],
      leaks: [],
      matched: false,
    };
    const seatIds = [...new Set([...moves.map((m) => m.player_id), ctx.viewSeat])];
    const spokenIssues = summaries.flatMap((line) =>
      checkSpokenText(line, seatIds).map((p) => `${p.rule}: ${p.detail} — ${JSON.stringify(line.slice(0, 120))}`),
    );
    if (spokenIssues.length > 0) batch.spoken_text_issues = spokenIssues;

    // What a real assistant sees: the run_ai_turn response, minus next_step /
    // move_menu (they steer the HUMAN'S next move, not the relay; dropping them
    // keeps the relayer on-task — documented divergence from the raw response).
    const relayerInput = JSON.stringify(
      {
        moves_played: ctx.payload.moves_played ?? moves.length,
        moves,
        report_to_human: ctx.payload.report_to_human,
        ...(ctx.payload.game_over ? { game_over: true, result: ctx.payload.result } : {}),
      },
      null,
      2,
    );

    // 1. RELAY — prose for the human. --calibrate skips the relayer and hands the
    //    reader the raw JSON: its score there is the READER'S CEILING, the
    //    baseline every live relay score is read against.
    if (ctx.spoken) {
      // What a voice client says: each move's state_summary, in order, verbatim.
      batch.relay_text = summaries.join('\n');
    } else if (ctx.calibrate) {
      batch.relay_text = relayerInput;
    } else {
      try {
        const r = await chatWithTransportRetry(this.relayer, [
          { role: 'system', content: buildRelayerSystem() },
          { role: 'user', content: `The server just returned this run_ai_turn response:\n\n${relayerInput}\n\nWrite exactly what you would say to the human at the table now.` },
        ]);
        batch.relay_text = r.content;
      } catch (e) {
        batch.relay_text = '';
        batch.apply_failures.push(`relayer error: ${(e as Error).message}`);
      }
    }

    // 2. RECONSTRUCT — the reader sees ONLY the prose and fills the skeleton.
    //    The reader is the measuring INSTRUMENT, not the thing under test — so
    //    when it leaves placeholders unfilled, nudge it to re-read ONCE (a human
    //    re-reads a note; a real relay omission survives the retry because the
    //    nudge says to keep the placeholder when the words don't state a value).
    //    Wrong-VALUE reconstructions have zero unfilled slots and never retry,
    //    so genuine findings can't be masked.
    const skeleton = gt.nameified.map((m) => blankSkeleton(m));
    let recon: unknown[] | null = null;
    if (batch.relay_text) {
      try {
        const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
          { role: 'system', content: buildReaderSystem() },
          { role: 'user', content: buildReaderTask(batch.relay_text, skeleton) },
        ];
        const first = await chatWithTransportRetry(this.reader, messages);
        recon = parseReaderMoves(first.content);
        if (recon === null) {
          // Unparseable reader output is an instrument decode failure, not a relay
          // finding — same rationale as the transport-error retries below: a decode
          // hiccup must not decide a fidelity measurement. Nudge with the format
          // contract (no answer content leaks — the skeleton was already given).
          const formatRetry = [
            ...messages,
            { role: 'assistant' as const, content: first.content },
            {
              role: 'user' as const,
              content: 'Your reply was not parseable. Reply with ONLY the JSON object {"moves":[...]} — the completed skeleton, no prose, no code fences, no commentary.',
            },
          ];
          for (let attempt = 0; attempt < 2 && recon === null; attempt++) {
            batch.reader_retries += 1;
            try {
              recon = parseReaderMoves((await this.reader.chat(formatRetry)).content);
            } catch {
              /* transport error — try again, else leave recon null */
            }
          }
        }
        if (recon && recon.length !== skeleton.length) {
          // The skeleton GRANTS the move count; a wrong-length reply (a dropped or
          // merged move) shifts every later slot and corrupts the whole batch —
          // an instrument alignment failure, not a relay finding. Nudge once for
          // the exact count; keep the original reply if the retry doesn't fix it.
          const countRetry = [
            ...messages,
            { role: 'assistant' as const, content: JSON.stringify({ moves: recon }) },
            {
              role: 'user' as const,
              content: `The skeleton lists ${skeleton.length} move(s) but your reply has ${recon.length}. Reply with ONLY the JSON object {"moves":[...]} containing exactly ${skeleton.length} entries in skeleton order — one per skeleton move, same shapes. If the words truly do not state a move's values, keep that move's placeholders unchanged.`,
            },
          ];
          for (let attempt = 0; attempt < 2; attempt++) {
            batch.reader_retries += 1;
            try {
              const r2 = parseReaderMoves((await this.reader.chat(countRetry)).content);
              if (r2 && r2.length === skeleton.length) recon = r2;
              break;
            } catch {
              /* transport error — try again, else keep the original reply */
            }
          }
        }
        const unfilledPaths = recon ? placeholderPaths(recon) : [];
        if (recon && unfilledPaths.length > 0) {
          const retryMessages = [
            ...messages,
            { role: 'assistant' as const, content: first.content },
            {
              role: 'user' as const,
              content:
                `These placeholders are still unfilled: ${unfilledPaths.join(', ')}. Re-read the assistant's words — if a value IS stated for one, fill it; if the words truly do not state it, keep that placeholder unchanged. Reply with ONLY the completed JSON object.`,
            },
          ];
          // The retry is best-effort: a transport error (timeout/abort) keeps
          // the first parse and tries once more — an Ollama hiccup must not
          // decide a fidelity measurement (a live seat-1 run lost a batch to
          // exactly that). Two transport failures in a row → keep first parse.
          for (let attempt = 0; attempt < 2; attempt++) {
            batch.reader_retries += 1;
            try {
              const retry = await this.reader.chat(retryMessages);
              recon = parseReaderMoves(retry.content) ?? recon;
              break;
            } catch {
              /* transport error — try again, else fall back to the first parse */
            }
          }
        }
      } catch (e) {
        batch.apply_failures.push(`reader error: ${(e as Error).message}`);
      }
    }
    batch.reconstructed = recon;

    // 3. DIAGNOSTICS on the prose — these disambiguate attribution before any
    //    apply: fact absent from prose = relay omission (B/C); present in prose
    //    but absent from the reconstruction = reader noise (D).
    const facts = extractFacts(gt.nameified, summaries);
    const reconText = recon ? JSON.stringify(recon) : '';
    batch.fact_checks = facts.map((fact) => ({
      fact,
      in_relay: textContains(batch.relay_text, fact),
      in_reconstruction: textContains(reconText, fact),
    }));
    batch.leaks = await this.scanLeaks(ctx.ref, batch.relay_text, relayerInput);

    // 4. APPLY the reconstruction to the MODEL board — the human executing what
    //    they heard. Failures are recorded and SKIPPED (the human shrugs and does
    //    nothing for that move); the resulting divergence is the honest outcome.
    if (recon) {
      for (let i = 0; i < moves.length; i++) {
        const entry = moves[i]!;
        const filled = recon[i];
        if (filled == null) {
          batch.apply_failures.push(`move ${i} (${moveType(entry.move_taken)}): no reconstruction`);
          continue;
        }
        const { value: coerced, unfilled } = coerceReconstruction(filled, gt.nameified[i]);
        batch.unfilled_placeholders += unfilled;
        // Resolve names the reader wrote back to the MODEL session's OWN ids —
        // only at the paths the ground truth was nameified at, so a field that
        // legitimately holds a printed name is never converted. Recomputed per
        // move: a card the previous move revealed only has a model-side id now.
        const inverse = invertNameMap(await this.mergedIdNameMap(ctx.model));
        const move = denameifyAtPaths(coerced, gt.nameifiedPaths.get(i) ?? [], inverse);
        const r = await this.harness.callTool('apply_move', { session_id: ctx.model, player_id: entry.player_id, move });
        if (r.isError) {
          batch.apply_failures.push(
            `move ${i} (${moveType(entry.move_taken)}): ${stringifyToolText(r).replace(/\s+/g, ' ').slice(0, 240)}`,
          );
        }
      }
    } else if (moves.length > 0) {
      batch.apply_failures.push('no parseable reconstruction — nothing applied for this batch');
    }

    // 5. HEADLINE — canonical-state diff, exactly the desync harness's metric.
    const refCanon = canonicalObject(await this.rawView(ctx.ref, ctx.viewSeat));
    const modelCanon = canonicalObject(await this.rawView(ctx.model, ctx.viewSeat));
    batch.matched = JSON.stringify(refCanon) === JSON.stringify(modelCanon);
    if (!batch.matched) {
      batch.state_diff = diffPaths(refCanon, modelCanon);
      // Class-A hint: a diverging reference value that never appears in the
      // response text was unconveyable by ANY relay — the summary omitted it.
      batch.possible_class_a = (batch.state_diff ?? []).filter((d) => {
        const m = /ref=(.+?) model=/.exec(d);
        const refVal = m?.[1]?.replace(/^"|"…?$|"$/g, '') ?? '';
        return refVal.length >= 2 && !textContains(relayerInput, refVal);
      });
    }
    return batch;
  }

  // ---- drive loop (shared) -------------------------------------------------------
  //
  // Mirrors the desync harness's loop: game_over ends it; ai_to_move (or any
  // routed non-human step) goes to the AI-batch handler; a human-owed step gets
  // the deterministic ground-truth move applied to BOTH sessions. The handler
  // returns the number of AI moves played (stall detection) or null to stop.

  private async drive(
    ref: string,
    model: string | null,
    humanSeats: Set<string>,
    viewSeat: string,
    res: { steps: number },
    onAiBatch: (active: string, step: number) => Promise<number | null>,
  ): Promise<{ completed: boolean; steps: number; error?: { code: string; message: string }; result?: RelayResult['result'] }> {
    let steps = 0;
    let zeroStreak = 0;
    while (steps < STEP_LIMIT) {
      steps += 1;
      res.steps = steps;
      const refStep = await this.nextStep(ref, viewSeat);
      if (refStep.game_over || refStep.next_step?.status === 'game_over') {
        return { completed: true, steps, result: refStep.result ?? (await this.outcome(ref)) };
      }
      const st = refStep.next_step;
      if (!st?.status) return { completed: false, steps, error: { code: 'NO_NEXT_STEP', message: 'reference session returned no next_step' } };
      const active = st.active_player_id ?? undefined;
      if (isHumanTurnStatus(st.status) && active && humanSeats.has(active)) {
        const gt = await deriveGroundTruth((tool, extra) => this.callOn(ref, tool, extra), active);
        if (!gt) return { completed: false, steps, error: { code: 'NO_GROUND_TRUTH', message: `no ground-truth move for ${active} at step ${steps}` } };
        await this.applyOn(ref, active, gt.move);
        // Post-desync the same declaration may be illegal on the MODEL — that IS
        // the divergence propagating; the failed apply is the human's declaration
        // bouncing off the model's wrong tracked state.
        if (model) await this.applyOn(model, active, gt.move);
        zeroStreak = 0;
      } else if (active) {
        const played = await onAiBatch(active, steps);
        if (played === null) return { completed: false, steps };
        if (played === 0) {
          zeroStreak += 1;
          if (zeroStreak >= MAX_ZERO_MOVE_STREAK) {
            return { completed: false, steps, error: { code: 'STALLED', message: `AI batch for ${active} played 0 moves ${zeroStreak}x in a row at step ${steps}` } };
          }
        } else {
          zeroStreak = 0;
        }
      } else {
        return { completed: false, steps, error: { code: 'NO_ACTIVE_PLAYER', message: `directive "${st.status}" carries no active_player_id` } };
      }
    }
    return { completed: false, steps, error: { code: 'STEP_LIMIT', message: `exceeded ${STEP_LIMIT} steps` } };
  }

  // ---- ground truth + naming helpers ----------------------------------------------

  /** Nameify each move_taken with the union of EVERY seat's id→name map (the
   *  harness's server-side privilege — an AI's hand ids only resolve in its own
   *  view). Also records which paths changed, so the reconstruction can be
   *  denameified at exactly those paths and nowhere else. */
  private async nameifiedGroundTruth(
    session: string,
    moves: RunAiMoveEntry[],
  ): Promise<{ nameified: unknown[]; nameifiedPaths: Map<number, string[]> }> {
    const map = await this.mergedIdNameMap(session);
    const nameified = moves.map((m) => nameifyValue(m.move_taken, map));
    const nameifiedPaths = new Map<number, string[]>();
    moves.forEach((m, i) => nameifiedPaths.set(i, collectChangedPaths(m.move_taken, nameified[i])));
    return { nameified, nameifiedPaths };
  }

  /** Union of idToNameMap over every seat's view of the session. */
  private async mergedIdNameMap(session: string): Promise<Record<string, string>> {
    const merged: Record<string, string> = {};
    for (const pid of this.seatIds) Object.assign(merged, idToNameMap(await this.rawView(session, pid)));
    return merged;
  }

  /** Names visible in some AI seat's view but in NO human seat's view = hidden
   *  information. Any such name in the prose that the response itself never
   *  mentioned is a leak — and since the relayer only ever saw the response, a
   *  real leak means the RESPONSE leaked (a server privacy bug) or a collision. */
  private async scanLeaks(ref: string, relayText: string, responseText: string): Promise<string[]> {
    if (!relayText) return [];
    const humanNames = new Set<string>();
    const aiNames = new Set<string>();
    for (const p of this.players) {
      const names = Object.values(idToNameMap(await this.rawView(ref, p.player_id)));
      for (const n of names) (p.kind === 'human' ? humanNames : aiNames).add(n);
    }
    const leaks: string[] = [];
    for (const n of aiNames) {
      if (humanNames.has(n) || n.length < 3) continue;
      if (textContains(relayText, n) && !textContains(responseText, n)) leaks.push(n);
    }
    return leaks;
  }

  // ---- session/tool plumbing (mirrors desyncBot) ------------------------------------

  private players: RelayPlayer[] = [];
  private get seatIds(): string[] {
    return this.players.map((p) => p.player_id);
  }
  private pickViewSeat(players: RelayPlayer[]): string {
    this.players = players;
    return (players.find((p) => p.kind === 'human') ?? players[0]!).player_id;
  }

  private async createSession(args: {
    game_id: string;
    players: RelayPlayer[];
    seed: number;
    options?: Record<string, unknown>;
  }): Promise<string | { code: string; message: string }> {
    const resp = await this.harness.callTool('create_session', {
      game_id: args.game_id,
      players: args.players,
      options: { ...(args.options ?? {}), seed: args.seed },
    });
    if (resp.isError) return { code: 'CREATE_FAILED', message: stringifyToolText(resp) };
    const id = (parseToolJson(resp) as { session_id?: string } | null)?.session_id;
    return id ?? { code: 'CREATE_INVALID', message: stringifyToolText(resp) };
  }

  private async runAiBatch(session: string, active: string): Promise<RunAiTurnPayload> {
    const resp = await this.callOn(session, 'run_ai_turn', { player_id: active });
    return (parseToolJson(resp) as RunAiTurnPayload | null) ?? {};
  }

  private callOn(sessionId: string, tool: string, extra: Record<string, unknown>): Promise<ToolResponse> {
    return this.harness.callTool(tool, { session_id: sessionId, ...extra });
  }

  private async applyOn(sessionId: string, playerId: string, move: unknown): Promise<boolean> {
    const r = await this.harness.callTool('apply_move', { session_id: sessionId, player_id: playerId, move });
    return !r.isError;
  }

  private async nextStep(sessionId: string, viewSeat: string): Promise<StepView> {
    return (parseToolJson(await this.callOn(sessionId, 'get_state', { player_id: viewSeat })) as StepView | null) ?? {};
  }

  private async rawView(sessionId: string, viewSeat: string): Promise<Record<string, unknown>> {
    return (parseToolJson(await this.callOn(sessionId, 'get_state', { player_id: viewSeat })) as Record<string, unknown> | null) ?? {};
  }

  private async detectSurface(ref: string, model: string, viewSeat: string): Promise<string | null> {
    const r = (await this.nextStep(ref, viewSeat)).next_step;
    const m = (await this.nextStep(model, viewSeat)).next_step;
    if ((r?.status ?? '') !== (m?.status ?? '')) return `tracked status "${m?.status}" but reality is "${r?.status}"`;
    if ((r?.active_player_id ?? null) !== (m?.active_player_id ?? null)) {
      return `tracked active player "${m?.active_player_id}" but reality is "${r?.active_player_id}"`;
    }
    return null;
  }

  private async outcome(sessionId: string): Promise<RelayResult['result']> {
    const r = await this.callOn(sessionId, 'is_game_over', {});
    if (r.isError) return undefined;
    const j = parseToolJson(r) as ({ game_over?: boolean } & NonNullable<RelayResult['result']>) | null;
    return j && j.game_over !== false ? { winners: j.winners, scores: j.scores, summary: j.summary } : undefined;
  }
}

// ---- pure helpers (exported for unit tests) -----------------------------------------

function emptyRelayResult(
  args: { game_id: string; players: RelayPlayer[]; seed: number; relayer_model: string; reader_model: string; calibrate?: boolean; spoken?: boolean },
  mode: 'full' | 'probe',
): RelayResult {
  return {
    game_id: args.game_id,
    seed: args.seed,
    players: args.players,
    mode,
    relayer_model: args.relayer_model,
    reader_model: args.reader_model,
    calibrate: args.calibrate ?? false,
    spoken: args.spoken ?? false,
    ref_completed: false,
    steps: 0,
    ai_batches: 0,
    batches_matched: 0,
    batches: [],
    first_relay_desync_step: null,
    first_relay_desync_batch: null,
    surfaced_step: null,
    surfaced_how: null,
    silent_steps: null,
    never_surfaced: false,
    facts_total: 0,
    facts_in_relay: 0,
    facts_in_reconstruction: 0,
  };
}

function accumulateFacts(res: RelayResult, b: RelayBatch): void {
  res.facts_total += b.fact_checks.length;
  res.facts_in_relay += b.fact_checks.filter((f) => f.in_relay).length;
  res.facts_in_reconstruction += b.fact_checks.filter((f) => f.in_reconstruction).length;
}

function moveType(move: unknown): string {
  const t = (move as { type?: unknown } | null)?.type ?? (move as { action?: unknown } | null)?.action;
  return typeof t === 'string' ? t : 'move';
}

/** Blank a ground-truth move into the reader's fill-in skeleton: every leaf
 *  becomes a typed placeholder, EXCEPT the move discriminant (`type`/`action`)
 *  — the skeleton grants structure (how many moves, what shapes); only the
 *  VALUES are under test. Array lengths are kept (documented assist: counts are
 *  partially given away; the fact_checks still flag count omissions). */
export function blankSkeleton(move: unknown): unknown {
  const blank = (v: unknown, key: string | null): unknown => {
    if (Array.isArray(v)) return v.map((x) => blank(x, null));
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o)) out[k] = blank(o[k], k);
      return out;
    }
    if (key === 'type' || key === 'action') return v;
    if (typeof v === 'string') return '<string>';
    if (typeof v === 'number') return '<number>';
    if (typeof v === 'boolean') return '<boolean>';
    return v;
  };
  return blank(move, null);
}

/** Leaf paths (dot-joined) where `nameified` differs from `raw` — i.e. exactly
 *  the fields nameifyValue rewrote id→name. Only these paths are converted back
 *  name→id when the reconstruction is applied. */
export function collectChangedPaths(raw: unknown, nameified: unknown, path = '', out: string[] = []): string[] {
  if (raw === nameified) return out;
  if (Array.isArray(raw) && Array.isArray(nameified)) {
    raw.forEach((x, i) => collectChangedPaths(x, nameified[i], path ? `${path}.${i}` : String(i), out));
    return out;
  }
  if (raw && nameified && typeof raw === 'object' && typeof nameified === 'object') {
    const o = raw as Record<string, unknown>;
    const n = nameified as Record<string, unknown>;
    for (const k of Object.keys(o)) collectChangedPaths(o[k], n[k], path ? `${path}.${k}` : k, out);
    return out;
  }
  if (typeof raw === 'string' && typeof nameified === 'string' && raw !== nameified) out.push(path);
  return out;
}

/** Replace, at exactly the given paths, a printed name with the target
 *  session's own id for it (inverse of nameifyValue, path-scoped so a field
 *  that legitimately holds a name is never touched). Unknown names pass
 *  through — the engine's own name resolvers get a shot, and a truly wrong
 *  name should fail the apply, not be silently "fixed". */
export function denameifyAtPaths(value: unknown, paths: string[], nameToId: Record<string, string>): unknown {
  if (paths.length === 0) return value;
  const targets = new Set(paths);
  const walk = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, path ? `${path}.${i}` : String(i)));
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o)) out[k] = walk(o[k], path ? `${path}.${k}` : k);
      return out;
    }
    if (typeof v === 'string' && targets.has(path)) return nameToId[v] ?? nameToId[v.trim()] ?? v;
    return v;
  };
  return walk(value, '');
}

/** First-call transport retry: an Ollama timeout/abort on the INITIAL relayer or
 *  reader call must not decide a fidelity measurement (the later nudge loops only
 *  cover their own retry calls). Rethrows the last error after 3 attempts. */
async function chatWithTransportRetry(
  client: OllamaClient,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
): Promise<{ content: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await client.chat(messages);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

function parseReaderMoves(content: string): unknown[] | null {
  const obj = extractMoveJson(content);
  return obj && Array.isArray((obj as { moves?: unknown }).moves) ? (obj as { moves: unknown[] }).moves : null;
}

/** Dot paths (rooted at moves[i]) of every typed placeholder still present in
 *  the reader's output — the unfilled slots the retry nudge names. */
export function placeholderPaths(moves: unknown[], out: string[] = []): string[] {
  const walk = (v: unknown, path: string): void => {
    // An empty string is an unfilled slot in disguise (observed reader behavior:
    // "" instead of the placeholder token) — nudge the same re-read; the nudge
    // keeps genuinely-unstated values unfilled, so nothing is masked.
    if (typeof v === 'string' && (/^<(string|number|boolean)>$/.test(v) || v.trim() === '')) {
      out.push(path);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}.${i}`));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${path}.${k}`);
    }
  };
  moves.forEach((m, i) => walk(m, `moves[${i}]`));
  return out;
}

export function invertNameMap(idToName: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, name] of Object.entries(idToName)) {
    // Duplicate names = fungible physical copies; keep the first (same argument
    // as the canonical compare dropping card handles).
    if (!(name in out)) out[name] = id;
  }
  return out;
}

/** Walk the reader's filled value against the ground truth's types: numeric
 *  strings become numbers where the truth held a number, and any placeholder
 *  the reader left unfilled is counted (it will fail the apply — honestly). */
export function coerceReconstruction(filled: unknown, groundTruth: unknown): { value: unknown; unfilled: number } {
  let unfilled = 0;
  const walk = (v: unknown, gt: unknown, depth: number): unknown => {
    if (typeof v === 'string' && /^<(string|number|boolean)>$/.test(v)) {
      unfilled += 1;
      return v;
    }
    if (Array.isArray(v)) {
      const gtArr = Array.isArray(gt) ? gt : [];
      return v.map((x, i) => walk(x, gtArr[i] ?? gtArr[0], depth + 1));
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const g = (gt && typeof gt === 'object' && !Array.isArray(gt) ? gt : {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o)) out[k] = walk(o[k], g[k], depth + 1);
      // The skeleton GRANTS the move discriminant ("structure kept; only the
      // values are under test") — restore it at the move's top level if the
      // reader rewrote it into a prose verb ("draws") or dropped it. Nested
      // type-named fields stay untouched (they may be values under test).
      if (depth === 0) {
        for (const k of ['type', 'action']) {
          if (typeof g[k] === 'string') out[k] = g[k];
        }
      }
      return out;
    }
    if (typeof gt === 'number' && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
    if (typeof gt === 'boolean' && (v === 'true' || v === 'false')) return v === 'true';
    return v;
  };
  return { value: walk(filled, groundTruth, 0), unfilled };
}

/** Atomic facts of a batch, for the lexical coverage check: every salient leaf
 *  value of the nameified moves, plus numbers and Capitalized name spans from
 *  the summaries. Diagnostic only — the headline is the state diff. */
export function extractFacts(nameifiedMoves: unknown[], summaries: string[]): string[] {
  const facts = new Set<string>();
  const walk = (v: unknown, key: string | null): void => {
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, key));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
      return;
    }
    if (key === 'player_id') return;
    if (typeof v === 'string' && v.length >= 2) facts.add(v);
    if (typeof v === 'number') facts.add(String(v));
  };
  nameifiedMoves.forEach((m) => walk(m, null));
  for (const s of summaries) {
    for (const m of s.matchAll(/\b\d+\b/g)) facts.add(m[0]);
    // Capitalized multi-word spans not at sentence start-ish: cheap printed-name
    // detector ("Cotton Mill", "Gate Six"). Single Capitalized words are too
    // noisy to count as facts on their own.
    for (const m of s.matchAll(/\b([A-Z][\w'-]+(?: (?:of|the|[A-Z][\w'-]+))+)\b/g)) facts.add(m[1]!);
  }
  return [...facts];
}

/** Case/punctuation-tolerant containment, with light plural/verb-s tolerance
 *  ("lead" matches "leads") so the advisory fact check doesn't flag phrasing
 *  as omission. Does the text state this fact? */
export function textContains(text: string, fact: string): boolean {
  if (!text || !fact) return false;
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const t = ` ${norm(text)} `;
  const f = norm(fact);
  if (f.length === 0) return false;
  if (t.includes(` ${f} `) || t.includes(` ${f}s `)) return true;
  return f.endsWith('s') && f.length > 3 && t.includes(` ${f.slice(0, -1)} `);
}

/** Probe-ranking complexity of a batch: how much a relay must carry. */
export function batchComplexity(nameifiedMoves: unknown[], summaries: string[]): number {
  return nameifiedMoves.length * 3 + extractFacts(nameifiedMoves, summaries).length;
}

// ---- prompts -------------------------------------------------------------------------

function buildRelayerSystem(): string {
  return [
    'You are an AI assistant helping a human play a PHYSICAL board game at a real table.',
    'The server just played the AI opponent\'s turn and returned the moves below. The human cannot see anything the server did — they must update the physical board from YOUR words alone.',
    'Relay EVERY move to the human, in order. For each entry in `moves`, state its state_summary in full: every board-changing fact — what was played, built, moved, captured, bought, drawn or discarded, where it went, and every piece/score/resource change — in plain game terms.',
    'Do not omit anything. Do not add flavor, commentary, or any detail the response does not contain. Never compress the turn into a summary like "the AI took its turn".',
  ].join('\n');
}

function buildReaderSystem(): string {
  return [
    'You are the human player at a physical board game table. Your assistant just told you what the AI opponent did on its turn.',
    'Using ONLY the assistant\'s words — no game knowledge, no guessing — fill in the exact structured record of the AI\'s moves.',
  ].join('\n');
}

function buildReaderTask(relayText: string, skeleton: unknown[]): string {
  return [
    `YOUR ASSISTANT SAID:\n"""\n${relayText}\n"""`,
    `TEMPLATE — fill every "<string>", "<number>" and "<boolean>" placeholder with the value the assistant stated. Keep the structure, order, field names and all non-placeholder values EXACTLY as given. Your reply must contain exactly ${skeleton.length} move(s), one per template entry, in the same order — NEVER merge, drop, or add moves, even when one sentence describes several moves or one move's sentence mentions other players. If the assistant's words do not state a value, leave its placeholder unchanged.`,
    JSON.stringify({ moves: skeleton }, null, 2),
    'Reply with ONLY the completed JSON object.',
  ].join('\n\n');
}
