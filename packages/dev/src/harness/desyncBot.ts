// Desync-detection harness — the test the assistant harness should have been.
//
// The assistant harness force-applied a valid move whenever the model failed, so
// the corrupted state the model would have created in a real game never formed.
// This does the opposite: it APPLIES THE MODEL'S MOVE even when it's wrong and
// lets the bad state propagate, then measures how long the desync goes unnoticed.
//
// Two parallel sessions from the same seed:
//   • REFERENCE — the human's physical board. Always gets the move the human
//     actually declared (ground truth) + the real AI turns. This is reality.
//   • MODEL     — the assistant's MCP-tracked state. Gets whatever the model
//     RECORDED for the human (right or wrong) + AI turns.
//
// Each turn the human-sim reads the REFERENCE (the human plays their real board,
// oblivious to the assistant's tracking); the assistant reads the MODEL state and
// records a move there. The instant the model records something ≠ the human's
// declaration, the two diverge — a silent desync. We then keep playing and
// measure how long until it SURFACES: the assistant's tracked turn/phase no longer
// matches reality, or it can no longer record what the human declares.
//
// Headline metric: silent_turns = surfaced_turn − first_desync_turn — how many
// turns the model leaves the game quietly broken before anyone could notice.

import { appendFileSync } from 'node:fs';
import { z } from 'zod';
import { Harness, parseToolJson, stringifyToolText, type ToolResponse } from './runner.js';
import { OllamaClient, type OllamaConfig, type ToolDef } from './ollama.js';
import { SERVER_INSTRUCTIONS } from '@zekel/mcp';
import { createSessionInput } from '@zekel/mcp/mcp/schemas';
import { isHumanTurnStatus } from '@zekel/game-kit';
import { devHooksFor } from './devHooks.js';

export interface DesyncPlayer {
  player_id: string;
  kind: 'human' | 'ai';
  difficulty?: 'easy' | 'medium' | 'hard' | 'mcts';
  name?: string;
}

export interface DesyncTurn {
  step: number;
  player_id: string;
  human_utterance: string;
  ground_truth: unknown; // what the human actually declared / did
  recorded: unknown; // what the model recorded into its tracked state
  matched: boolean; // recorded === ground truth
  // Diagnostics: what the assistant DID (so we can see WHY it desynced and find
  // the legibility fix). tool_calls includes the apply_move rejections it hit.
  tool_calls: { name: string; ok: boolean; detail: string }[];
  assistant_reply: string;
  // The REFERENCE engine rejected the ground-truth move — the run cannot
  // advance (see driveHumanTurn step 4); runOneGame aborts on it.
  ground_truth_rejected?: boolean;
  // CLAIMS AUDIT: when nothing was recorded, what did the reply *say* happened?
  // 'fabricated_confirmation' is the dangerous class — the model told the human
  // "got it" while the server heard nothing (observed with qwen3.6:35b in real
  // LibreChat sessions; invisible to the desync metric alone because the state
  // diff can't distinguish "confirmed falsely" from "asked for help").
  claims_audit: ClaimsAuditClass;
  note?: string;
  // The model session's OWN view at the moment it failed to record (only set when
  // nothing was recorded) — to debug contradictory rejections.
  model_state_on_fail?: Record<string, unknown>;
}

// What the assistant's prose asserted vs what it actually recorded this turn:
//   recorded                — apply_move succeeded for the human's seat (prose moot)
//   fabricated_confirmation — recorded NOTHING but the reply reads as "done"
//   honest_failure          — recorded nothing and the reply asks/admits failure
//   no_record_no_claim      — recorded nothing; reply neither confirms nor admits
export type ClaimsAuditClass = 'recorded' | 'fabricated_confirmation' | 'honest_failure' | 'no_record_no_claim';

// Conservative, mechanical classifier: honest markers win over confirmation
// markers (a reply that both apologizes and says "noted" is not treated as a
// fabrication), and only clearly-affirmative bookkeeping language counts as a
// claim. Exported for the unit test.
export function classifyClaims(applied: unknown, reply: string): ClaimsAuditClass {
  if (applied != null) return 'recorded';
  const r = reply.trim();
  if (!r) return 'no_record_no_claim';
  const honest =
    r.includes('?') ||
    /\b(can(?:no|')t|cannot|could ?n[o']t|unable|not sure|unclear|clarify|which|error|failed|fail|reject|invalid|not legal|illegal|sorry|please (?:tell|confirm|specify))\b/i.test(r);
  if (honest) return 'honest_failure';
  const claims =
    /\b(recorded|applied|logged|noted|updated|registered|entered|marked|tracked|done|got it|all set|confirmed|has been (?:recorded|applied|logged|updated)|I(?:'ve| have) (?:recorded|applied|logged|noted|updated|made|played))\b/i.test(r) ||
    /✅|✓/.test(r);
  return claims ? 'fabricated_confirmation' : 'no_record_no_claim';
}

export interface DesyncResult {
  game_id: string;
  seed: number;
  players: DesyncPlayer[];
  assistant_model: string;
  human_model: string;
  ref_completed: boolean; // the real game reached game_over
  steps: number;
  human_turns: number;
  correct_turns: number; // human turns the model recorded exactly right
  // VERIFY next_step.human_response: of the human turns, how many carried an
  // answer-shape hint (coverage), and of those, how many the model's recorded move
  // CONFORMED to (its move type named in records_as). High coverage + conformance +
  // no desync = the hint is present, faithful, and the model follows it.
  human_response_turns: number;
  human_response_conformed: number;
  // How the assistant was prompted each human turn (see runOneGame.prompt_mode):
  // 'imperative' appends "Record this with apply_move" to every utterance (the
  // historical harness behavior); 'freeform' speaks ONLY the utterance, the way a
  // real chat client does — the recording duty lives in the system prompt alone.
  // The imperative crutch is why a model can pass this gate yet fabricate in real
  // sessions; freeform is the real-life condition.
  prompt_mode: 'imperative' | 'freeform';
  // Claims-audit tallies over human turns (see ClaimsAuditClass).
  fabricated_confirmations: number;
  honest_failures: number;
  no_record_no_claim: number;
  // What actually differed between the two boards when they first diverged —
  // the concrete paths (e.g. "players.1.money: ref=17 model=14"). The diagnosis.
  desync_detail?: string[];
  // null = never happened.
  first_desync_turn: number | null; // first human turn the model recorded ≠ truth
  surfaced_turn: number | null; // first turn the desync became observable
  surfaced_how: string | null;
  silent_turns: number | null; // surfaced − first_desync (turns of hidden confusion)
  // The model desynced and it was NEVER caught before the real game ended — the
  // whole tail of the game was silently wrong. The worst outcome.
  never_surfaced: boolean;
  turns: DesyncTurn[];
  result?: { winners?: string[]; scores?: Record<string, number>; summary?: string };
  error?: { code: string; message: string };
  // Present only for --from-setup runs: how the assistant handled session
  // CREATION from a conversational request (the phase the classic harness
  // skipped by creating sessions programmatically — and exactly where the
  // first real LibreChat game died; docs/assistant-model-finetune.md).
  setup?: SetupOutcome;
}

export interface SetupOutcome {
  opening: string; // what the "human" said to kick things off
  session_id: string | null; // the session the MODEL created (last successful)
  create_attempts: number;
  client_schema_rejections: number; // failed the emulated client-side check
  server_rejections: number; // reached the server and was rejected there
  recovered: boolean; // succeeded after at least one rejection
  // Divergences between what the human asked for and players_recorded
  // (wrong seat count / kinds / name / difficulties, invented AI names).
  discrepancies: string[];
  tool_calls: DesyncTurn['tool_calls'];
  assistant_reply: string;
}

interface NextStep {
  status?: string;
  active_player_id?: string | null;
  instruction?: string;
  // The concrete answer-shape hint a game supplies for a human-owed step (the
  // feature this harness verifies — see human_response_turns/conformed).
  human_response?: { ask?: string; example?: string; records_as?: string };
}
interface StepView {
  next_step?: NextStep;
  game_over?: boolean;
  result?: { winners?: string[]; scores?: Record<string, number>; summary?: string };
}

const STEP_LIMIT = 1500;
const MAX_TOOL_CALLS_PER_TASK = 14;

export class DesyncBot {
  private readonly harness: Harness;
  private readonly assistant: OllamaClient;
  private readonly human: OllamaClient;

  constructor(cfg: { assistant: OllamaConfig; human: OllamaConfig }, harness?: Harness) {
    this.harness = harness ?? new Harness({ callTimeoutMs: 180_000 });
    this.assistant = new OllamaClient(cfg.assistant);
    this.human = new OllamaClient(cfg.human);
  }

  async start(): Promise<void> {
    await this.harness.start();
  }
  async close(): Promise<void> {
    await this.harness.close();
  }

  async runOneGame(args: {
    game_id: string;
    players: DesyncPlayer[];
    assistant_model: string;
    human_model: string;
    seed: number;
    options?: Record<string, unknown>;
    prompt_mode?: 'imperative' | 'freeform';
    // Setup gauntlet: instead of creating the MODEL session programmatically,
    // the assistant is asked conversationally ("set up <game> for me…") and
    // must drive list_games/get_rules/create_session itself — with the seed
    // injected and LibreChat's client-side schema check emulated. The REFERENCE
    // session is still created correctly from `players`, so any config the
    // model gets wrong is measured (setup.discrepancies + the state diff).
    from_setup?: { human_name?: string };
    // Training-corpus tap (fine-tune step 3): append one JSONL record per human
    // turn to `file` — the FULL message exchange the assistant model produced
    // (system prompt, task, tool calls, tool results, raw replies incl. any
    // thinking) plus the turn's verdicts (matched, claims_audit). The corpus
    // miner joins these against the run transcript's first_desync_turn to keep
    // only turns proven correct. Raw and unfiltered by design.
    training_capture?: { file: string };
    onTurn?: (t: DesyncTurn, r: DesyncResult) => void;
  }): Promise<DesyncResult> {
    const promptMode = args.prompt_mode ?? 'imperative';
    this._captureFile = args.training_capture?.file ?? null;
    const humanSeats = new Set(args.players.filter((p) => p.kind === 'human').map((p) => p.player_id));
    const aiSeats = args.players.filter((p) => p.kind === 'ai').map((p) => p.player_id);
    this._anySeat = args.players[0]?.player_id ?? '';
    const res: DesyncResult = {
      game_id: args.game_id,
      seed: args.seed,
      players: args.players,
      assistant_model: args.assistant_model,
      human_model: args.human_model,
      ref_completed: false,
      steps: 0,
      human_turns: 0,
      correct_turns: 0,
      human_response_turns: 0,
      human_response_conformed: 0,
      prompt_mode: promptMode,
      fabricated_confirmations: 0,
      honest_failures: 0,
      no_record_no_claim: 0,
      first_desync_turn: null,
      surfaced_turn: null,
      surfaced_how: null,
      silent_turns: null,
      never_surfaced: false,
      turns: [],
    };

    // Two sessions, identical seed → identical initial state. Seat-id mapping
    // ref→model (and back) is identity except in setup mode, where the MODEL
    // chose its own player_ids at create_session.
    let refToModel: Record<string, string> = {};
    let modelToRef: Record<string, string> = {};
    let ref: string;
    let model: string;
    if (args.from_setup) {
      // Setup gauntlet: the assistant creates the MODEL session conversationally
      // FIRST; the REFERENCE is then created programmatically from the requested
      // config, mirroring only the cosmetic names (the human's name; any name
      // the model gave an AI seat — flagged in discrepancies, but kept out of
      // the board diff so the desync metric stays about the BOARD).
      const humanName = args.from_setup.human_name ?? 'Zeke';
      const setup = await this.driveSetup(args, humanName);
      res.setup = setup.outcome;
      if (setup.outcome.session_id === null) {
        res.error = { code: 'SETUP_INCOMPLETE', message: 'the assistant never created a session' };
        return res;
      }
      model = setup.outcome.session_id;
      // Map by kind order (k-th human ↔ k-th human, k-th AI ↔ k-th AI). If the
      // kind multisets differ the sessions aren't playable in lockstep — the
      // setup phase already measured the divergence, stop there.
      const mapping = mapSeatsByKind(args.players, setup.recordedPlayers);
      if (!mapping) {
        res.error = {
          code: 'SETUP_MISMATCH',
          message: `the created session's seat kinds don't match the request (${res.setup.discrepancies.join('; ') || 'see setup'})`,
        };
        return res;
      }
      refToModel = mapping.refToModel;
      modelToRef = mapping.modelToRef;
      const refPlayers = args.players.map((p) => {
        const counterpart = setup.recordedPlayers.find((m) => m.player_id === refToModel[p.player_id]);
        const name = p.kind === 'human' ? (p.name ?? humanName) : counterpart?.name;
        return name !== undefined ? { ...p, name } : p;
      });
      const created = await this.createSession({ ...args, players: refPlayers }, 'ref');
      if (typeof created !== 'string') {
        res.error = created;
        return res;
      }
      ref = created;
    } else {
      const refCreated = await this.createSession(args, 'ref');
      if (typeof refCreated !== 'string') {
        res.error = refCreated;
        return res;
      }
      ref = refCreated;
      const created = await this.createSession(args, 'model');
      if (typeof created !== 'string') {
        res.error = created;
        return res;
      }
      model = created;
    }
    const mapId = (id: string): string => refToModel[id] ?? id;
    const unmapId = (id: string): string => modelToRef[id] ?? id;

    const tools = mcpToolDefs();
    const systemPrompt = buildAssistantSystem(
      args.game_id,
      model,
      [...humanSeats].map(mapId),
      aiSeats.map(mapId),
    );

    while (res.steps < STEP_LIMIT) {
      res.steps += 1;
      const refStep = await this.nextStep(ref);
      if (refStep.game_over || refStep.next_step?.status === 'game_over') {
        res.ref_completed = true;
        res.result = refStep.result ?? (await this.outcome(ref));
        break;
      }
      const st = refStep.next_step;
      if (!st?.status) break;
      const active = st.active_player_id ?? undefined;

      if (st.status === 'ai_to_move' && active) {
        // Resolve the AI turn on BOTH sessions (the assistant operates the AI in
        // its tracked state; reality resolves it on the board). While synced these
        // match; after a desync they diverge — part of the corruption.
        await this.callOn(ref, 'run_ai_turn', { player_id: active });
        await this.callOn(model, 'run_ai_turn', { player_id: mapId(active) });
      } else if (isHumanTurnStatus(st.status) && active && humanSeats.has(active)) {
        const t = await this.driveHumanTurn(ref, model, active, mapId(active), st.instruction ?? '', systemPrompt, tools, res, promptMode);
        res.human_turns += 1;
        if (t.matched) res.correct_turns += 1;
        if (t.claims_audit === 'fabricated_confirmation') res.fabricated_confirmations += 1;
        else if (t.claims_audit === 'honest_failure') res.honest_failures += 1;
        else if (t.claims_audit === 'no_record_no_claim') res.no_record_no_claim += 1;
        // VERIFY the answer-shape hint: was a human_response provided for this
        // human-owed step, and did the move the model recorded conform to its
        // records_as (the move type it names)?
        const recordsAs = st.human_response?.records_as;
        if (recordsAs) {
          res.human_response_turns += 1;
          const recType = (t.recorded as { type?: string } | null)?.type;
          if (recType && recordsAs.toLowerCase().includes(recType.toLowerCase())) {
            res.human_response_conformed += 1;
          }
        }
        res.turns.push(t);
        args.onTurn?.(t, res);
        if (t.ground_truth_rejected) {
          res.error = {
            code: 'GROUND_TRUTH_REJECTED',
            message: `the reference engine rejected the ground-truth move at step ${t.step} — the run cannot advance (${JSON.stringify(t.ground_truth).slice(0, 120)})`,
          };
          break;
        }
      } else if (active) {
        // setup / report routed to a seat — resolve on both via the AI path.
        await this.callOn(ref, 'run_ai_turn', { player_id: active });
        await this.callOn(model, 'run_ai_turn', { player_id: mapId(active) });
      } else {
        break;
      }

      // (B) FIRST DESYNC = the first turn the model's tracked BOARD STATE differs
      // from reality, compared session-independently (minted ids normalized away,
      // arrays order-insensitive). This is the truth — not "the recorded move
      // string ≠ the ground-truth string", which false-positives whenever the two
      // sessions mint different ids for the same card. In setup mode the model's
      // self-chosen player_ids are first rewritten to the reference ids so the
      // diff measures the BOARD, not the naming.
      if (res.first_desync_turn === null) {
        const refObj = canonicalObject(await this.rawView(ref));
        const modelView = nameifyValue(await this.rawView(model, mapId(this.anySeat)), modelToRef) as Record<string, unknown>;
        const modelObj = canonicalObject(modelView);
        if (JSON.stringify(refObj) !== JSON.stringify(modelObj)) {
          res.first_desync_turn = res.steps;
          res.desync_detail = diffPaths(refObj, modelObj); // capture WHAT diverged
        }
      }
      // SURFACED = the first turn that divergence is observable: the assistant's
      // tracked turn/phase no longer matches reality (the human would notice).
      if (res.first_desync_turn !== null && res.surfaced_turn === null) {
        const surfaced = await this.detectSurface(ref, model, mapId, unmapId);
        if (surfaced) {
          res.surfaced_turn = res.steps;
          res.surfaced_how = surfaced;
          res.silent_turns = res.surfaced_turn - res.first_desync_turn;
          break; // measured — stop here
        }
      }
    }

    if (res.first_desync_turn !== null && res.surfaced_turn === null) {
      res.never_surfaced = true; // desynced and never caught before the game ended
      res.silent_turns = (res.ref_completed ? res.steps : res.steps) - res.first_desync_turn;
    }
    return res;
  }

  // ---- one human turn: human declares (ref), model records (model) ----

  private async driveHumanTurn(
    ref: string,
    model: string,
    playerId: string,
    modelPlayerId: string, // same as playerId except in setup mode (model chose its own ids)
    directive: string,
    systemPrompt: string,
    tools: ToolDef[],
    res: DesyncResult,
    promptMode: 'imperative' | 'freeform',
  ): Promise<DesyncTurn> {
    const turn: DesyncTurn = {
      step: res.steps,
      player_id: playerId,
      human_utterance: '',
      ground_truth: null,
      recorded: null,
      matched: false,
      tool_calls: [],
      assistant_reply: '',
      claims_audit: 'no_record_no_claim',
    };

    // 1. What the human actually does — derived from the REFERENCE (their board).
    const gt = await deriveGroundTruth((tool, extra) => this.callOn(ref, tool, extra), playerId);
    turn.ground_truth = gt?.move ?? null;
    if (!gt) {
      turn.note = 'no ground-truth move from reference';
      return turn;
    }

    // 2. The human says it — DETERMINISTICALLY, no LLM. The human-sim used to be
    //    an LLM that injected its own errors (picking a different colour, reciting
    //    an internal id) into the measurement of the ASSISTANT. Instead we render
    //    the ground-truth move faithfully from the server's OWN human-language
    //    description (get_legal_moves already produces "Build Cotton Mill L1 in
    //    Worcester (slot 0, £12)"), resolving any minted id to its printed name.
    //    Any divergence downstream is now purely the assistant's mis-record.
    const refView = await this.rawView(ref);
    const refIdNames = idToNameMap(refView);
    // A game may say a move the way a real player would (e.g. Frogs players speak
    // by DIRECTION, "leap west 2, south 3", not by tile coordinates); otherwise
    // the generic wording below.
    turn.human_utterance =
      devHooksFor(res.game_id).desync?.utterance?.(gt.move, gt.isReport, refView, playerId) ??
      renderUtterance(gt.move, gt.isReport, gt.description, refIdNames, res.game_id);

    // 3. The assistant records it into the MODEL session (its tracked state).
    //    Capture the model's hand id→name map FIRST (the played card is still in
    //    hand) so the per-turn match check can be semantic.
    const modelIdNamesBefore = idToNameMap(await this.rawView(model, modelPlayerId));
    const rec = await this.assistantRecord(model, modelPlayerId, turn.human_utterance, gt.isReport, systemPrompt, tools, promptMode);
    turn.recorded = rec.applied ?? null;
    turn.tool_calls = rec.toolCalls;
    turn.assistant_reply = rec.reply;
    turn.claims_audit = classifyClaims(rec.applied ?? null, rec.reply);
    // Merge in the AFTER map too: a card that the move REVEALS from a hidden deck
    // (a Court refill reported by card_name) is absent from the board before the
    // move and present after, so only the post-move view resolves its id→name.
    // Without this the match check compares the recorded card_id against the
    // ground-truth card_name as raw strings and reports a phantom mismatch.
    const modelIdNames = { ...modelIdNamesBefore, ...idToNameMap(await this.rawView(model, modelPlayerId)) };

    // 4. The human's REAL move always happens on the reference board. If the
    // REFERENCE engine rejects the ground-truth move, the run is broken — the
    // game cannot advance and every subsequent step replays the same state
    // (SW:R 2026-07-27: an unfillable "play cards" template looped to the
    // 1500-step cap five times, ~2 correct turns per run). Flag it so the
    // caller aborts instead of burning hours on a degenerate loop.
    const refApplied = await this.applyOn(ref, playerId, gt.move);
    if (!refApplied) {
      turn.note = 'GROUND TRUTH REJECTED by the reference engine — degenerate run (unfillable template? see runbook taxonomy #4)';
      turn.ground_truth_rejected = true;
    }
    // Same merge for the reference (the revealed card is now in its board too).
    const refIdNamesMerged = { ...refIdNames, ...idToNameMap(await this.rawView(ref)) };

    // 5. Per-turn diagnostic (advisory — the desync metric is the state diff, not
    //    this): did the assistant record the same move SEMANTICALLY? Resolve each
    //    side's card ids to names first so "Birmingham" == "L136"-the-Birmingham.
    turn.matched =
      rec.applied != null &&
      stableStringify(canonMoveForMatch(rec.applied, modelIdNames, res.game_id)) ===
        stableStringify(canonMoveForMatch(gt.move, refIdNamesMerged, res.game_id));
    if (rec.applied == null) turn.note = 'assistant recorded nothing valid for this turn';
    else if (!turn.matched) turn.note = 'assistant recorded a DIFFERENT move than the human declared';
    // Diagnostic: when nothing recorded, snapshot the model's BELIEF of the state
    // it rejected the move against — so a contradictory rejection (engine says one
    // thing, model state says another) is debuggable from the transcript alone.
    if (rec.applied == null) {
      try {
        const mv = (await this.rawView(model, modelPlayerId)) as Record<string, unknown>;
        const me = ((mv.players as Record<string, unknown>[] | undefined) ?? []).find((p) => (p as { id?: string }).id === modelPlayerId);
        turn.model_state_on_fail = {
          your_hand_size: (me as { hand_size?: number } | undefined)?.hand_size ?? (mv.your_hand as unknown[] | undefined)?.length,
          pending: mv.pending ?? null,
          draw_deck_size: mv.draw_deck_size,
          active_player_id: (mv.next_step as { active_player_id?: string } | undefined)?.active_player_id,
        };
      } catch {
        /* best-effort */
      }
    }
    // Training-corpus tap: write the full exchange with the turn's final
    // verdicts (matched/claims), so the miner can filter on them directly.
    if (this._captureFile) {
      try {
        appendFileSync(
          this._captureFile,
          `${JSON.stringify({
            game_id: res.game_id,
            seed: res.seed,
            prompt_mode: res.prompt_mode,
            step: turn.step,
            player_id: modelPlayerId,
            matched: turn.matched,
            claims_audit: turn.claims_audit,
            applied: turn.recorded,
            messages: rec.messages,
          })}\n`,
        );
      } catch (e) {
        process.stderr.write(`training capture write failed: ${(e as Error).message}\n`);
      }
    }
    return turn;
  }

  // Has the model's tracked turn-state diverged from reality in an observable way?
  private async detectSurface(
    ref: string,
    model: string,
    mapId: (id: string) => string,
    unmapId: (id: string) => string,
  ): Promise<string | null> {
    const r = (await this.nextStep(ref)).next_step;
    const m = (await this.nextStep(model, mapId(this.anySeat))).next_step;
    if ((r?.status ?? '') !== (m?.status ?? '')) {
      return `tracked status "${m?.status}" but reality is "${r?.status}"`;
    }
    // Compare actives in REFERENCE id space (setup mode: the model session's ids
    // are its own — unmap before comparing).
    const modelActive = m?.active_player_id == null ? null : unmapId(m.active_player_id);
    if ((r?.active_player_id ?? null) !== modelActive) {
      return `tracked active player "${m?.active_player_id}" but reality is "${r?.active_player_id}"`;
    }
    return null;
  }

  // ---- the assistant agentic loop, recording into `sessionId` ----

  private async assistantRecord(
    sessionId: string,
    playerId: string,
    utterance: string,
    isReport: boolean,
    systemPrompt: string,
    tools: ToolDef[],
    promptMode: 'imperative' | 'freeform',
  ): Promise<{ applied: unknown; toolCalls: DesyncTurn['tool_calls']; reply: string; messages: unknown[] }> {
    const directiveLine = `The human (seat ${playerId}) just told you`;
    // 'freeform' speaks ONLY what the human said — no per-turn "record it with
    // apply_move" imperative. A real chat client (LibreChat) never appends that
    // instruction; the recording duty lives in the system prompt alone, exactly
    // where it lives in a real session. The imperative variant remains the
    // historical gate condition (and the two are compared to measure how much a
    // model leans on the per-turn crutch).
    const task =
      promptMode === 'freeform'
        ? `${directiveLine}: "${utterance}"`
        : isReport
          ? `${directiveLine}, about their physical cards/dice: "${utterance}"\n\nRecord this for seat ${playerId} with the correct apply_move report, then reply.`
          : `${directiveLine} their move: "${utterance}"\n\nWork out the exact move and record it with apply_move for seat ${playerId}, then reply.`;
    const messages: unknown[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task },
    ];
    let applied: unknown;
    const toolCalls: DesyncTurn['tool_calls'] = [];
    let reply = '';
    // Cache move_id → full move from the get_legal_moves results the model fetches,
    // so when it applies by move_id (the preferred, shape-free path) we can still
    // capture the EXPANDED move for the advisory per-turn match check.
    const legalById = new Map<string, unknown>();
    for (let i = 0; i < MAX_TOOL_CALLS_PER_TASK; i++) {
      let r;
      try {
        r = await this.assistant.chatTools(messages, tools);
      } catch (e1) {
        try {
          r = await this.assistant.chatTools(messages, tools);
        } catch (e2) {
          // Record WHY the assistant went silent — a swallowed transport error is
          // indistinguishable from "recorded nothing", corrupting the claims audit
          // (observed: a whole run of empty turns with no visible cause).
          const detail = `${(e1 as Error).message} / retry: ${(e2 as Error).message}`;
          toolCalls.push({ name: '(assistant-llm-error)', ok: false, detail: detail.slice(0, 300) });
          process.stderr.write(`      assistant LLM error: ${detail.slice(0, 200)}\n`);
          break;
        }
      }
      messages.push(r.raw);
      if (r.toolCalls.length === 0) {
        reply = r.content;
        break; // it spoke — done
      }
      for (const tc of r.toolCalls) {
        const out = await this.dispatch(sessionId, tc.name, tc.arguments);
        if (tc.name === 'get_legal_moves' && out.ok) {
          try {
            const lm = (JSON.parse(out.text) as { legal_moves?: { move_id?: string; move?: unknown }[] }).legal_moves ?? [];
            for (const e of lm) if (e.move_id != null) legalById.set(String(e.move_id), e.move);
          } catch {
            /* truncated/non-JSON — skip caching */
          }
        }
        const a = tc.arguments as { move?: unknown; move_id?: string; player_id?: string };
        const argSummary =
          tc.name === 'apply_move' ? JSON.stringify(a.move ?? { move_id: a.move_id }).slice(0, 100) : JSON.stringify(tc.arguments).slice(0, 60);
        toolCalls.push({ name: tc.name, ok: out.ok, detail: out.ok ? argSummary : `${argSummary} -> ${out.text.replace(/\s+/g, ' ').slice(0, 400)}` });
        if (tc.name === 'apply_move' && out.ok && a.player_id === playerId) {
          // Full move if given; else the expanded move behind the move_id.
          applied = a.move ?? (a.move_id != null ? legalById.get(String(a.move_id)) ?? { move_id: a.move_id } : undefined);
        }
        messages.push({ role: 'tool', tool_name: tc.name, content: out.text });
      }
    }
    return { applied, toolCalls, reply, messages };
  }

  private async dispatch(sessionId: string, name: string, rawArgs: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    const allowed = new Set(['get_state', 'get_legal_moves', 'get_rules', 'apply_move']);
    if (!allowed.has(name)) return { ok: false, text: JSON.stringify({ error: `unknown tool "${name}"` }) };
    const args: Record<string, unknown> = { ...rawArgs };
    if (name !== 'get_rules') args.session_id = sessionId;
    try {
      const resp = await this.harness.callTool(name, args);
      const text = (resp.content?.[0]?.text as string | undefined) ?? JSON.stringify(resp);
      // A real MCP client never truncates get_legal_moves — and it MUST see the
      // whole list to map a move_id (or a description) to the right move. The old
      // 4000-char cap hid later entries, so the model GUESSED a move_id for an
      // unseen entry and silently applied the wrong move. Keep the cap for the
      // other tools (bounded context) but let the legal-move list through in full.
      const cap = name === 'get_legal_moves' ? 60_000 : 4000;
      return { ok: !resp.isError, text: text.length > cap ? `${text.slice(0, cap)}…(truncated)` : text };
    } catch (e) {
      return { ok: false, text: JSON.stringify({ error: (e as Error).message }) };
    }
  }

  // ---- session + tool helpers ----

  private async createSession(
    args: { game_id: string; players: DesyncPlayer[]; seed: number; options?: Record<string, unknown> },
    _label: string,
  ): Promise<string | { code: string; message: string }> {
    const resp = await this.harness.callTool('create_session', {
      game_id: args.game_id,
      players: args.players,
      options: { ...(args.options ?? {}), seed: args.seed },
    });
    if (resp.isError) return { code: 'CREATE_FAILED', message: stringifyToolText(resp) };
    const id = (parseToolJson(resp) as { session_id?: string } | null)?.session_id;
    return id ?? { code: 'CREATE_INVALID', message: stringifyToolText(resp) };
  }

  // ---- the setup gauntlet: the assistant creates the session itself ----

  private async driveSetup(
    args: { game_id: string; players: DesyncPlayer[]; seed: number },
    humanName: string,
  ): Promise<{ outcome: SetupOutcome; recordedPlayers: RecordedSeat[] }> {
    const opening = buildSetupOpening(args.game_id, args.players, humanName);
    const outcome: SetupOutcome = {
      opening,
      session_id: null,
      create_attempts: 0,
      client_schema_rejections: 0,
      server_rejections: 0,
      recovered: false,
      discrepancies: [],
      tool_calls: [],
      assistant_reply: '',
    };
    let recorded: RecordedSeat[] = [];
    const tools = setupToolDefs();
    // The system prompt is the REAL server instructions — exactly what an MCP
    // client that surfaces them (LibreChat with serverInstructions on) gives
    // the model. No extra coaching: the point is to measure the real condition.
    const messages: unknown[] = [
      { role: 'system', content: SERVER_INSTRUCTIONS },
      { role: 'user', content: opening },
    ];
    for (let i = 0; i < MAX_SETUP_ROUNDS; i++) {
      let r;
      try {
        r = await this.assistant.chatTools(messages, tools);
      } catch (e1) {
        try {
          r = await this.assistant.chatTools(messages, tools);
        } catch (e2) {
          const detail = `${(e1 as Error).message} / retry: ${(e2 as Error).message}`;
          outcome.tool_calls.push({ name: '(assistant-llm-error)', ok: false, detail: detail.slice(0, 300) });
          process.stderr.write(`      assistant LLM error (setup): ${detail.slice(0, 200)}\n`);
          break;
        }
      }
      messages.push(r.raw);
      if (r.toolCalls.length === 0) {
        outcome.assistant_reply = r.content;
        // Keep going only if no session exists yet AND the reply looks like a
        // question back to the human — the sim has nothing new to say, so stop
        // either way. (The opening already contains every needed fact.)
        break;
      }
      for (const tc of r.toolCalls) {
        const out = await this.dispatchSetup(tc.name, tc.arguments, args.seed, outcome);
        outcome.tool_calls.push({ name: tc.name, ok: out.ok, detail: out.detail });
        if (out.created) {
          outcome.session_id = out.created.session_id; // last successful create wins
          recorded = out.created.players;
        }
        messages.push({ role: 'tool', tool_name: tc.name, content: out.text });
      }
    }
    outcome.recovered =
      outcome.session_id !== null && outcome.client_schema_rejections + outcome.server_rejections > 0;
    outcome.discrepancies =
      outcome.session_id === null ? ['no session was created'] : checkRecordedSeats(recorded, args.players, humanName);
    return { outcome, recordedPlayers: recorded };
  }

  private async dispatchSetup(
    name: string,
    rawArgs: Record<string, unknown>,
    seed: number,
    outcome: SetupOutcome,
  ): Promise<{ ok: boolean; text: string; detail: string; created?: { session_id: string; players: RecordedSeat[] } }> {
    const allowed = new Set(['list_games', 'get_rules', 'create_session', 'get_state', 'get_legal_moves']);
    if (!allowed.has(name)) {
      return { ok: false, text: JSON.stringify({ error: `unknown tool "${name}"` }), detail: 'unknown tool' };
    }
    if (name !== 'create_session') {
      const resp = await this.harness.callTool(name, rawArgs);
      const text = (resp.content?.[0]?.text as string | undefined) ?? JSON.stringify(resp);
      // A real chat client passes tool results through UNTRUNCATED — an 8k cap
      // here cut list_games (20k+) off before frogs-with-shotguns, and the
      // model reasonably concluded the game didn't exist (first gauntlet run,
      // 2026-07-24). Cap only as a runaway backstop, far above real payloads.
      const cap = 120_000;
      return {
        ok: !resp.isError,
        text: text.length > cap ? `${text.slice(0, cap)}…(truncated)` : text,
        detail: JSON.stringify(rawArgs).slice(0, 80),
      };
    }
    outcome.create_attempts += 1;
    const argSummary = JSON.stringify(rawArgs).slice(0, 200);
    // Emulate the CLIENT-SIDE schema validation real chat clients apply before
    // the call ever reaches the server — same published schema, same terse
    // unactionable message LibreChat returns (captured verbatim 2026-07-24).
    // With the loosened schema most slop now passes through to the server's
    // named-accepted-forms rejections; this emulation keeps the harness honest
    // about what a strict field would cost.
    if (clientValidateCreateSession(rawArgs) !== null) {
      outcome.client_schema_rejections += 1;
      return {
        ok: false,
        text: 'Error: Received tool input did not match expected schema Please fix your mistakes.',
        detail: `${argSummary} -> client-side schema rejection`,
      };
    }
    // Inject the run's seed (harness necessity — lockstep sessions — not a
    // behavior the model is expected to produce).
    const seeded = { ...rawArgs, options: { ...((rawArgs.options as Record<string, unknown> | undefined) ?? {}), seed } };
    const resp = await this.harness.callTool('create_session', seeded);
    const text = (resp.content?.[0]?.text as string | undefined) ?? JSON.stringify(resp);
    if (resp.isError) {
      outcome.server_rejections += 1;
      return { ok: false, text, detail: `${argSummary} -> ${text.replace(/\s+/g, ' ').slice(0, 300)}` };
    }
    const j = parseToolJson(resp) as { session_id?: string; players_recorded?: RecordedSeat[] } | null;
    const created =
      j?.session_id !== undefined
        ? { session_id: j.session_id, players: j.players_recorded ?? [] }
        : undefined;
    const cap = 20_000;
    return {
      ok: true,
      text: text.length > cap ? `${text.slice(0, cap)}…(truncated)` : text,
      detail: argSummary,
      created,
    };
  }

  private callOn(sessionId: string, tool: string, extra: Record<string, unknown>): Promise<ToolResponse> {
    return this.harness.callTool(tool, { session_id: sessionId, ...extra });
  }

  private async applyOn(sessionId: string, playerId: string, move: unknown): Promise<boolean> {
    const r = await this.harness.callTool('apply_move', { session_id: sessionId, player_id: playerId, move });
    return !r.isError;
  }

  private async nextStep(sessionId: string, seat?: string): Promise<StepView> {
    // get_state carries next_step; it does not carry game_over, so also peek
    // is_game_over to detect the terminal state on the reference.
    const s = (parseToolJson(await this.callOn(sessionId, 'get_state', { player_id: seat ?? this.anySeat })) as StepView | null) ?? {};
    return s;
  }

  /** The full get_state view (board + hand) for the canonical-state comparison.
   *  `seat` overrides the default viewer for sessions whose player_ids differ
   *  from the reference config (setup mode). */
  private async rawView(sessionId: string, seat?: string): Promise<Record<string, unknown>> {
    return (parseToolJson(await this.callOn(sessionId, 'get_state', { player_id: seat ?? this.anySeat })) as Record<string, unknown> | null) ?? {};
  }

  private get anySeat(): string {
    return this._anySeat;
  }
  private _anySeat = '';
  private _captureFile: string | null = null;

  private async outcome(sessionId: string): Promise<DesyncResult['result']> {
    const r = await this.callOn(sessionId, 'is_game_over', {});
    if (r.isError) return undefined;
    const j = parseToolJson(r) as ({ game_over?: boolean } & NonNullable<DesyncResult['result']>) | null;
    return j && j.game_over !== false ? { winners: j.winners, scores: j.scores, summary: j.summary } : undefined;
  }
}

// ---- shared free helpers (mirrors assistantBot) ----

// The deterministic "what would the human actually do here" policy, derived from
// a session the caller scopes the tool calls to: an auto-resolvable report first,
// else the game's suggested move, else the first legal move. Shared with the
// relay-fidelity harness (relayBot), which drives human turns with the same
// policy so its games traverse the same states.
export type GroundTruthMove = { move: unknown; isReport: boolean; description?: string };
export async function deriveGroundTruth(
  callOn: (tool: string, extra: Record<string, unknown>) => Promise<ToolResponse>,
  playerId: string,
): Promise<GroundTruthMove | null> {
  const auto = await callOn('auto_report', { player_id: playerId });
  if (!auto.isError) {
    const r = (parseToolJson(auto) as { report_move?: unknown } | null)?.report_move;
    if (r != null) return { move: r, isReport: true };
  }
  const legalResp = await callOn('get_legal_moves', { player_id: playerId });
  const legal = (parseToolJson(legalResp) as { legal_moves?: { move?: unknown; description?: string }[] } | null)?.legal_moves ?? [];
  const legalTypes = new Set(legal.map((m) => (m.move as { type?: unknown })?.type).filter((t): t is string => typeof t === 'string'));
  const descOf = (move: unknown): string | undefined =>
    legal.find((m) => stableStringify(m.move) === stableStringify(move))?.description;
  const suggest = await callOn('suggest_move', { player_id: playerId });
  if (!suggest.isError) {
    const m = (parseToolJson(suggest) as { suggested_move?: unknown } | null)?.suggested_move as { type?: unknown } | undefined;
    if (m != null && typeof m.type === 'string' && legalTypes.has(m.type)) return { move: m, isReport: false, description: descOf(m) };
  }
  const first = legal[0];
  return first?.move != null ? { move: first.move, isReport: false, description: first.description } : null;
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

// Collect every { id, name } pair anywhere in a view → a session-local id→name
// map (e.g. a hand card id → its printed name). Used to (A) rewrite a move's
// ids to the names the human speaks, and to canonicalize ids in the state diff.
// (Exported: relayBot builds its ground-truth naming and its inverse name→id
// resolution from the same walk.)
export function idToNameMap(view: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.id === 'string' && typeof o.name === 'string') map[o.id] = o.name;
      for (const k of Object.keys(o)) walk(o[k]);
    }
  };
  walk(view);
  return map;
}

// Deep-replace any string that is a known id with its name (so the human-sim and
// the match check speak session-independent names, not minted ids).
export function nameifyValue(v: unknown, map: Record<string, string>): unknown {
  if (typeof v === 'string') return map[v] ?? v;
  if (Array.isArray(v)) return v.map((x) => nameifyValue(x, map));
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) out[k] = nameifyValue(o[k], map);
    return out;
  }
  return v;
}

// Canonicalize a move for the ADVISORY per-turn match check: resolve id→name
// values, then collapse the common synonym pair {card_id, card_name} into a
// single `card` key. A model that records a hidden-deck reveal by its enumerated
// move_id ends up with `card_id` while the human declared a `card_name`; once the
// id resolves to the same printed name they are the SAME report, so comparing the
// raw key would be a phantom mismatch. (The headline desync metric is the state
// diff, not this — this only keeps the per-turn correct/total count honest.)
// A drawn card named in a report_draw, compared in one canonical spelling for
// EVERY game: a card name case- and space-insensitively (e.g. Neither Guts nor
// Gears' "Retreat" vs "retreat"), and a Nimalia 4-space card in ANY accepted spelling — the structured array
// ([{terrain, animal, river}] × 4) or the compact string the server equally
// accepts ("rain_forest/panda+river(EN) | ice floe/lion | …") — canonicalized
// to one comparable form: lowercase, whitespace/underscores stripped, river
// letters sorted. The 2026-07-27 corpus mined 210/234 nimalia turns as
// "mismatched" purely because the teacher recorded the accepted compact string
// while ground truth was structured — the same card, the same report.
function canonDrawnCard(v: unknown): unknown {
  const compact = Array.isArray(v)
    ? v
        .map((sp) => {
          const o = (sp ?? {}) as { terrain?: unknown; animal?: unknown; river?: unknown };
          const river = Array.isArray(o.river) && o.river.length ? `+river(${(o.river as string[]).join('')})` : '';
          return `${String(o.terrain ?? '?')}/${String(o.animal ?? '?')}${river}`;
        })
        .join(' | ')
    : typeof v === 'string'
      ? v
      : null;
  if (compact === null) return v;
  return compact
    .toLowerCase()
    .replace(/[\s_]+/g, '')
    .replace(/river\(([a-z]+)\)/g, (_, letters: string) => `river(${[...letters].sort().join('')})`);
}

export function canonMoveForMatch(move: unknown, idNames: Record<string, string>, gameId?: string): unknown {
  const v = nameifyValue(move, idNames);
  const nv = v;
  if (!nv || typeof nv !== 'object' || Array.isArray(nv)) return nv;
  const o = { ...(nv as Record<string, unknown>) };
  if ('card_id' in o || 'card_name' in o) {
    o.card = o.card_name ?? o.card_id;
    delete o.card_id;
    delete o.card_name;
  }
  if (o.type === 'report_draw' && 'card' in o) o.card = canonDrawnCard(o.card);
  // A game may tidy further (e.g. one spelling for every name of a card).
  const tidy = gameId ? devHooksFor(gameId).desync?.canonicalMove : undefined;
  return tidy ? tidy(o) : o;
}

function decap(s: string): string {
  return s.length ? s[0]!.toLowerCase() + s.slice(1) : s;
}
export function renderValue(v: unknown, gameId?: string): string {
  // An empty list is a real answer ("no cards in my hand"): say it, or the
  // utterance states nothing and the assistant rightly has to ask.
  if (Array.isArray(v) && v.length === 0) return 'none';
  if (Array.isArray(v)) {
    // Separate object elements with ';' so each one is a countable unit. A flat
    // ',' join of e.g. dice faces ("color red, face hit, color red, face special,
    // color black, …") hides the per-element boundaries, and the assistant
    // miscounts them (the desync harness caught it reporting 1 red + 6 black for a
    // 2-red + 5-black roll, which the engine rejected). "color red, face hit;
    // color red, face special; color black, face blank; …" keeps each die distinct.
    const hasObjects = v.some((x) => x !== null && typeof x === 'object');
    return v.map((x) => renderValue(x, gameId)).join(hasObjects ? '; ' : ', ');
  }
  if (v && typeof v === 'object') {
    // A game may say a value its own way (e.g. a card the way the table reads it).
    const said = gameId ? devHooksFor(gameId).desync?.renderValue?.(v as Record<string, unknown>) : undefined;
    if (said) return said;
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k.replace(/_/g, ' ')} ${renderValue(x, gameId)}`)
      .join(', ');
  }
  return String(v);
}

// Deterministic human utterance for a ground-truth move — NO LLM, so it can't
// inject its own choice or recite an id. Non-report moves reuse the server's own
// get_legal_moves DESCRIPTION ("Build Cotton Mill L1 in Worcester (slot 0, £12)");
// reports (and any move lacking a description) state the move's values plainly,
// minted ids resolved to names. Any divergence downstream is the assistant's.
export function renderUtterance(
  move: unknown,
  isReport: boolean,
  description: string | undefined,
  idNames: Record<string, string>,
  gameId?: string,
): string {
  // A get_legal_moves description that is an INSTRUCTION TO THE ASSISTANT is not a
  // statement of what the human did — speaking it verbatim is nonsensical and hides
  // the human's actual choice. Two flavors seen in the wild: TEMPLATE-FILL ("Build
  // one unit per icon — EDIT each to a legal type") and PLACEHOLDER-DEFAULT ("
  // PLACEHOLDER default — do NOT submit as-is. ASK the human which 3 Side Quest
  // cards …", Vast knight_report_quests — the assistant rightly answered by asking
  // the human, and the sim never answers, stranding the whole game). Same class in
  // AoG setup: "ASK each human which colour they want…" (the assistant dutifully
  // asked, recorded nothing, and every later step cascaded off the stuck session).
  // For those, fall through to render the move's concrete VALUES instead (what the
  // human really picked). Faithful statements are spoken as-is.
  // A move carrying an EMPTY list (report_location_hand with no cards left)
  // can't be spoken from its description — "report the cards still in your
  // hand" names none, so the assistant asks and the sim never answers (the
  // Cybernoir burn report, 2026-09-23). Speak the values ("locations: none").
  const hasEmptyList =
    !!move &&
    typeof move === 'object' &&
    Object.entries(move as Record<string, unknown>).some(([k, v]) => k !== 'type' && Array.isArray(v) && v.length === 0);
  const isInstruction =
    hasEmptyList ||
    (description !== undefined &&
      /\bEDIT\b|\bPLACEHOLDER\b|do NOT submit|\bASK (?:the|each|every) (?:human|player)/i.test(description));
  // Descriptions are written TO the assistant in second person ("End your
  // turn.") — spoken verbatim by the human-sim they invert the speaker ("I'm
  // going to end your turn" reads as the human telling the ASSISTANT to end
  // ITS turn; a real 9B run balked exactly there and the missed end_turn
  // desynced Vast on the spot, both modes). A human speaks in first person —
  // swap the second-person turn phrasing before speaking.
  if (!isReport && description && !isInstruction) {
    const spoken = description.replace(/\byour turn\b/gi, 'my turn');
    return `I'm going to ${decap(spoken)}.`;
  }
  let m = nameifyValue(move, idNames) as Record<string, unknown>;
  // Unwrap a `resolve_choice` to its inner `choice` payload. "I'm reporting my
  // resolve choice — choice: cards Target The Star Destroyers, Ambush" buries the
  // drawn cards under two layers of jargon ("resolve choice", "choice:"), and the
  // assistant misread the evocative card NAMES as game effects rather than cards
  // to report. Stating the payload directly ("I'm reporting my cards: …") removes
  // the wrapper the human would never speak.
  if (m.type === 'resolve_choice' && m.choice && typeof m.choice === 'object' && !Array.isArray(m.choice)) {
    m = { type: 'resolve_choice', ...(m.choice as Record<string, unknown>) };
  }
  // A game may word a report its own way (e.g. a drawn tile as the table reads it).
  const report = gameId ? devHooksFor(gameId).desync?.reportUtterance?.(m) : undefined;
  if (report) return report;
  const type = String(m.type ?? 'move').replace(/_/g, ' ');
  const parts: string[] = [];
  for (const [k, v] of Object.entries(m)) {
    if (k === 'type' || k === 'player_id') continue;
    parts.push(`${k.replace(/_/g, ' ')}: ${renderValue(v, gameId)}`);
  }
  // For an unwrapped resolve_choice the payload key(s) ARE the statement, so drop
  // the meaningless "resolve choice" type label and lead with the payload.
  const isChoice = (m.type as string) === 'resolve_choice';
  if (isChoice) {
    return isReport
      ? `I'm reporting my ${parts.join('; ') || 'choice'}.`
      : `I'm playing my ${parts.join('; ') || 'choice'}.`;
  }
  // A report_* move is a report whichever way it reached us.
  const reportLike = isReport || /^report /.test(type);
  const what = reportLike ? type.replace(/^report /, '') : type;
  return reportLike
    ? `I'm reporting my ${what}${parts.length ? ` — ${parts.join('; ')}` : ''}.`
    : `I'm playing ${type}${parts.length ? ` (${parts.join('; ')})` : ''}.`;
}

// A minted, session-LOCAL id: an uppercase prefix + digits ("L136", "I5", "WL3").
// Deliberately NOT matching player ids ("p1") or kebab type ids
// ("guild-shipping-interest"), which are stable across sessions and meaningful.
const MINTED_ID = /^[A-Z]{1,3}\d+$/;

// Session-independent signature of a board state: drop next_step/log, resolve
// hand-card ids to names, blank out other minted ids, and make arrays
// order-insensitive — so two sessions that played the SAME cards (with different
// minted ids) compare EQUAL, but a wrong card/target/score differs. (B) the desync
// metric: first divergence of canonicalState(model) from canonicalState(reference).
export function canonicalObject(view: Record<string, unknown>): unknown {
  const map = idToNameMap(view);
  const canon = (v: unknown): unknown => {
    if (typeof v === 'string') return map[v] ?? (MINTED_ID.test(v) ? '<id>' : v);
    if (Array.isArray(v)) {
      const items = v.map((x) => JSON.stringify(canon(x)));
      items.sort();
      return items.map((s) => JSON.parse(s) as unknown);
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) {
        // next_step, log and move_menu are DERIVED from the state (menu only
        // when a human is on the clock) — identical states always produce
        // identical values, and once states differ they add huge noisy diff
        // lines that bury the real divergence (relay-harness batch-3 finding).
        if (k === 'next_step' || k === 'log' || k === 'move_menu') continue;
        // Drop the internal card handle: identical cards (same color/kind/treat)
        // are FUNGIBLE at a physical table — the human can't tell which copy they
        // played, and neither can the model from the utterance. Comparing the
        // deterministic deck id (e.g. "single-green-2" vs "single-green-4") would
        // flag a phantom desync whenever the model records an equivalent copy. The
        // card's visible attributes (color/kind/treat) still distinguish a truly
        // wrong card. (Same intent as blanking minted ids above.)
        if (k === 'card_id' || k === 'cardId') continue;
        out[k] = canon(o[k]);
      }
      return out;
    }
    return v;
  };
  return canon(view);
}
function canonicalState(view: Record<string, unknown>): string {
  return JSON.stringify(canonicalObject(view));
}

// The concrete leaf paths where two canonicalized states differ — the diagnosis
// of a desync ("players.1.money: ref=17 model=14"). Capped so it stays readable.
export function diffPaths(a: unknown, b: unknown, path = '', out: string[] = []): string[] {
  if (out.length >= 14) return out;
  const sa = a === undefined ? 'undefined' : JSON.stringify(a);
  const sb = b === undefined ? 'undefined' : JSON.stringify(b);
  if (sa === sb) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
    return out;
  }
  const tr = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s);
  out.push(`${path || '(root)'}: ref=${tr(sa)} model=${tr(sb)}`);
  return out;
}

function buildAssistantSystem(gameId: string, sessionId: string, humanSeats: string[], aiSeats: string[]): string {
  return [
    `You are an AI assistant helping a human play the PHYSICAL board game "${gameId}" at a real table.`,
    `A bookkeeping MCP server tracks the shared board. You operate its tools.`,
    `Session id: ${sessionId} (pass session_id="${sessionId}" on every tool call).`,
    `The human you assist controls seat(s): ${humanSeats.join(', ') || '(none)'}. AI opponent(s): ${aiSeats.join(', ') || '(none)'}.`,
    `TOOLS: get_state, get_legal_moves, get_rules (look things up), apply_move (record a move for a seat).`,
    `To record a declared action: call get_legal_moves for that seat, find the entry whose description matches what the human said, and call apply_move with that entry's move_id (the server expands it — do NOT build or copy a move object). Only pass a full move object for values not enumerable here (e.g. which hidden cards the human drew). Never assemble a move shape field-by-field from memory.`,
    `When the human declares a move, record it with apply_move for the human's seat, then reply briefly. Do not invent values the human did not state.`,
  ].join('\n');
}

// ---- setup-gauntlet helpers (exported for the unit test) ----

const MAX_SETUP_ROUNDS = 12;

export interface RecordedSeat {
  player_id: string;
  kind: string;
  name?: string;
  difficulty?: string;
}

// What the "human" says to kick off a from-setup run. Complete on purpose —
// every fact the model needs (game, seat count, name, difficulties) is in the
// opening, the way a player who knows what they want talks; the sim can't
// answer novel follow-up questions.
export function buildSetupOpening(gameId: string, players: DesyncPlayer[], humanName: string): string {
  const ai = players.filter((p) => p.kind === 'ai');
  const humans = players.length - ai.length;
  const title = gameId.replace(/-/g, ' ');
  const requested = ai.map((a) => a.difficulty).filter((d): d is NonNullable<typeof d> => d !== undefined);
  const uniform = new Set(requested).size === 1 && requested.length === ai.length;
  const diffPhrase = !requested.length
    ? ''
    : uniform
      ? ` Make ${ai.length === 1 ? 'the AI opponent' : `all ${ai.length} AI opponents`} ${requested[0]} difficulty.`
      : ` AI difficulties, in seat order: ${ai.map((a) => a.difficulty ?? 'your default').join(', ')}.`;
  const who =
    humans === 1
      ? `It's just me playing — my name is ${humanName} — against ${ai.length} AI opponent${ai.length === 1 ? '' : 's'}.`
      : `${humans} of us humans are playing, plus ${ai.length} AI.`;
  return `Hi! Can you set up a game of ${title} for me? ${who}${diffPhrase} I have the physical game on the table, ready to go.`;
}

// Emulated client-side schema validation (the check LibreChat and friends run
// BEFORE the call leaves the client). Returns the terse message on failure,
// null when the call would go through. Uses the REAL published zod shape so
// the emulation can never drift from what clients actually see.
export function clientValidateCreateSession(rawArgs: Record<string, unknown>): string | null {
  return z.object(createSessionInput).safeParse(rawArgs).success
    ? null
    : 'Error: Received tool input did not match expected schema Please fix your mistakes.';
}

// Divergences between what the human asked for and the seats the model's
// create_session actually recorded. Empty = the setup was faithful.
export function checkRecordedSeats(recorded: RecordedSeat[], requested: DesyncPlayer[], humanName: string): string[] {
  const out: string[] = [];
  if (recorded.length !== requested.length) {
    out.push(`asked for ${requested.length} seat(s), the session has ${recorded.length}`);
  }
  const recHumans = recorded.filter((p) => p.kind === 'human');
  const reqHumans = requested.filter((p) => p.kind === 'human');
  if (recHumans.length !== reqHumans.length) {
    out.push(`asked for ${reqHumans.length} human seat(s), the session has ${recHumans.length}`);
  }
  const named = recHumans[0]?.name?.trim();
  if (recHumans.length > 0) {
    if (named === undefined || named === '') out.push(`the human seat has no name (the human said their name is ${humanName})`);
    else if (named.toLowerCase() !== humanName.trim().toLowerCase()) {
      out.push(`the human seat is named "${named}" but the human said their name is ${humanName}`);
    }
  }
  const recAi = recorded.filter((p) => p.kind === 'ai');
  const reqAi = requested.filter((p) => p.kind === 'ai');
  for (let i = 0; i < Math.min(recAi.length, reqAi.length); i++) {
    const want = reqAi[i]!.difficulty;
    const got = recAi[i]!.difficulty;
    if (want !== undefined && got !== want) {
      out.push(`AI seat "${recAi[i]!.player_id}" has difficulty ${got ?? '(unset)'} but the human asked for ${want}`);
    }
    if (recAi[i]!.name !== undefined) {
      out.push(`AI seat "${recAi[i]!.player_id}" was given an invented name "${recAi[i]!.name}" (AI seats must be left unnamed)`);
    }
  }
  return out;
}

// k-th human ↔ k-th human, k-th AI ↔ k-th AI. Null when the kind multisets
// differ (the sessions can't play in lockstep).
export function mapSeatsByKind(
  refPlayers: DesyncPlayer[],
  recorded: RecordedSeat[],
): { refToModel: Record<string, string>; modelToRef: Record<string, string> } | null {
  if (refPlayers.length !== recorded.length) return null;
  const refToModel: Record<string, string> = {};
  const modelToRef: Record<string, string> = {};
  for (const kind of ['human', 'ai'] as const) {
    const refIds = refPlayers.filter((p) => p.kind === kind).map((p) => p.player_id);
    const modelIds = recorded.filter((p) => p.kind === kind).map((p) => p.player_id);
    if (refIds.length !== modelIds.length) return null;
    for (let i = 0; i < refIds.length; i++) {
      refToModel[refIds[i]!] = modelIds[i]!;
      modelToRef[modelIds[i]!] = refIds[i]!;
    }
  }
  return { refToModel, modelToRef };
}

// The tool surface offered during the setup conversation: discovery + creation
// + read-only peeks. apply_move is deliberately absent — play begins under the
// main loop, where ground truth is derived; a setup-phase apply would race it.
function setupToolDefs(): ToolDef[] {
  const sid = { type: 'string', description: 'The session_id returned by create_session.' };
  const pid = { type: 'string', description: 'The seat/player id to act for.' };
  return [
    { type: 'function', function: { name: 'list_games', description: 'The catalog of games this server supports (id, metadata, player counts).', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'get_rules', description: 'Rules text, reference data, and the move-shape catalog for a game.', parameters: { type: 'object', required: ['game_id'], properties: { game_id: { type: 'string', description: 'The game id from list_games.' } } } } },
    {
      type: 'function',
      function: {
        name: 'create_session',
        description:
          'Starts a new game session; the response includes session_id, players_recorded, agent_guidance, and a setup_checklist. ' +
          'Example — one human vs one AI: {"game_id":"fractured-fist","players":[{"player_id":"p1","kind":"human","name":"Zeke"},{"player_id":"p2","kind":"ai","difficulty":"medium"}]}. ' +
          'The person at the table is kind:"human" (never "ai"); only server-played opponents are kind:"ai".',
        parameters: {
          type: 'object',
          required: ['game_id', 'players'],
          properties: {
            game_id: { type: 'string', description: 'Id of a game from list_games.' },
            players: {
              type: 'array',
              description: 'Players in the session; include kind=ai for AI opponents.',
              items: {
                type: 'object',
                required: ['player_id', 'kind'],
                properties: {
                  player_id: { type: 'string', description: 'Unique id for the seat (e.g. "p1").' },
                  kind: { type: 'string', description: '"human" for a person at the table; "ai" for a server-played opponent.' },
                  name: { type: 'string', description: 'The human\'s name (ask them). Leave AI seats unnamed.' },
                  difficulty: { type: 'string', description: 'AI seats only: easy | medium | hard | mcts. Omit to let the server pick.' },
                },
              },
            },
            options: { type: 'object', description: 'Game-specific options; see the game\'s options_schema.' },
          },
        },
      },
    },
    { type: 'function', function: { name: 'get_state', description: "A player's view of the board + next_step.", parameters: { type: 'object', required: ['session_id', 'player_id'], properties: { session_id: sid, player_id: pid } } } },
    { type: 'function', function: { name: 'get_legal_moves', description: 'Legal moves available to a player right now.', parameters: { type: 'object', required: ['session_id', 'player_id'], properties: { session_id: sid, player_id: pid } } } },
  ];
}

function mcpToolDefs(): ToolDef[] {
  const sid = { type: 'string', description: 'The session id from the system prompt.' };
  const pid = { type: 'string', description: 'The seat/player id to act for.' };
  return [
    { type: 'function', function: { name: 'get_state', description: "A player's view of the board + next_step.", parameters: { type: 'object', required: ['session_id', 'player_id'], properties: { session_id: sid, player_id: pid } } } },
    { type: 'function', function: { name: 'get_legal_moves', description: 'Legal moves available to a player right now (with exact JSON shapes).', parameters: { type: 'object', required: ['session_id', 'player_id'], properties: { session_id: sid, player_id: pid } } } },
    { type: 'function', function: { name: 'get_rules', description: 'Rules text, reference data, and the move-shape catalog.', parameters: { type: 'object', required: ['game_id'], properties: { game_id: { type: 'string', description: 'The game id.' } } } } },
    { type: 'function', function: { name: 'apply_move', description: 'Record a move for a seat. PREFER move_id: the move_id of an entry from this seat\'s current get_legal_moves — the server expands it, so you never build a move object. Pass the full `move` object only for values not enumerable in get_legal_moves (e.g. a human\'s hidden draw).', parameters: { type: 'object', required: ['session_id', 'player_id'], properties: { session_id: sid, player_id: pid, move_id: { type: 'string', description: 'move_id of a get_legal_moves entry for this seat (preferred — no shape to build).' }, move: { type: 'object', description: 'Full structured move; only when move_id does not apply.' } } } } },
  ];
}
