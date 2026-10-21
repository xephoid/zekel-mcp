// Engine-bot integration harness.
//
// Unlike runner.ts (which drives ALL-AI games via get_ai_move and never touches
// the human-facing surface), this driver plays ONE seat as a HUMAN through the
// real MCP client loop — exactly the path an LLM assistant follows:
//
//   read next_step → if it's an AI's turn, run_ai_turn;
//                    if a human is owed a move, get_legal_moves / suggest_move,
//                    then submit it via apply_move; repeat.
//
// The human's MOVE is chosen by the game AI (suggest_move — full-state, so it
// plays well and synthesizes valid dice/draw reports), but it is SUBMITTED
// through the human apply path. That deliberately tests FLOW, not legibility:
// it catches crashes, desyncs, wrong-pending-owner, missing directives, and
// moves the server suggests but then rejects. (Legibility — whether the prose a
// real LLM reads is comprehensible — is the separate LLM-bot's job, on this
// same loop.)

import { Harness, parseToolJson, stringifyToolText } from './runner.js';
import { isHumanTurnStatus } from '@zekel/game-kit';

export interface EngineBotPlayer {
  player_id: string;
  kind: 'human' | 'ai';
  difficulty?: 'easy' | 'medium' | 'hard' | 'mcts';
}

export interface InvariantViolation {
  step: number;
  kind:
    | 'missing_next_step'
    | 'missing_active_player'
    | 'empty_human_directive'
    | 'human_directive_targets_ai'
    | 'human_stuck_no_move'
    | 'suggested_move_rejected'
    | 'apply_error';
  detail: string;
}

export interface EngineBotResult {
  game_id: string;
  seed: number;
  players: EngineBotPlayer[];
  completed: boolean;
  game_over: boolean;
  steps: number;
  human_moves: number;
  ai_turns: number;
  reports_synthesized?: number;
  violations: InvariantViolation[];
  // The human owed a physical REPORT (dice/draw/hand) that neither the AI
  // suggestion nor get_legal_moves could fill, and no per-game report responder
  // is registered. This is a HARNESS LIMITATION, not a game bug — it scopes the
  // per-game report-responder work, kept separate from `violations`.
  blocked?: { move_type: string; reason: string };
  error?: { code: string; message: string };
  result?: { winners?: string[]; scores?: Record<string, number>; summary?: string };
}

// Heuristic: an apply rejection that means "the client/harness could not supply
// a value here" — a physical report needing real draw/roll values, or a
// resolve_choice TEMPLATE whose payload the harness can't synthesize (e.g.
// SW:Rebellion's choice system). These are harness gaps the server handles
// correctly (it returns a recovery next_step); they are NOT flow bugs.
function looksLikeReportGap(message: string): boolean {
  return /report (exactly|the|your)|got 0|reserved for AI|must report|draw .* cards?|roll|choice payload needs|INVALID_MOVE_SHAPE|needs (a )?(string|array|number)/i.test(
    message,
  );
}

interface StepView {
  next_step?: { status?: string; active_player_id?: string | null; instruction?: string };
  game_over?: boolean;
  result?: { winners?: string[]; scores?: Record<string, number>; summary?: string };
}

const STEP_LIMIT = 4000;

export class EngineBot {
  private readonly harness: Harness;
  constructor(harness?: Harness) {
    this.harness = harness ?? new Harness();
  }

  async start(): Promise<void> {
    await this.harness.start();
  }
  async close(): Promise<void> {
    await this.harness.close();
  }

  async runOneGame(args: {
    game_id: string;
    players: EngineBotPlayer[];
    options?: Record<string, unknown>;
    seed: number;
  }): Promise<EngineBotResult> {
    const humans = new Set(args.players.filter((p) => p.kind === 'human').map((p) => p.player_id));
    const res: EngineBotResult = {
      game_id: args.game_id,
      seed: args.seed,
      players: args.players,
      completed: false,
      game_over: false,
      steps: 0,
      human_moves: 0,
      ai_turns: 0,
      violations: [],
    };
    const note = (kind: InvariantViolation['kind'], detail: string): void => {
      res.violations.push({ step: res.steps, kind, detail });
    };

    // Create the session. NO ai_auto_setup: we WANT the human setup handshake to
    // fire so the client loop exercises it.
    const create = await this.harness.callTool('create_session', {
      game_id: args.game_id,
      players: args.players,
      options: { ...(args.options ?? {}), seed: args.seed },
    });
    if (create.isError) {
      res.error = { code: 'CREATE_SESSION_FAILED', message: stringifyToolText(create) };
      return res;
    }
    const created = parseToolJson(create) as ({ session_id?: string } & StepView) | null;
    if (!created?.session_id) {
      res.error = { code: 'CREATE_SESSION_INVALID', message: stringifyToolText(create) };
      return res;
    }
    const sessionId = created.session_id;

    let view: StepView = created;
    while (res.steps < STEP_LIMIT) {
      res.steps += 1;

      if (view.game_over) {
        res.completed = true;
        res.game_over = true;
        res.result = view.result;
        break;
      }
      const step = view.next_step;
      if (!step || !step.status) {
        note('missing_next_step', `response carried no next_step: ${JSON.stringify(view).slice(0, 200)}`);
        break;
      }
      const active = step.active_player_id ?? undefined;
      if (step.status !== 'game_over' && !active) {
        note('missing_active_player', `status=${step.status} but no active_player_id`);
        break;
      }

      if (step.status === 'ai_to_move') {
        const resp = await this.harness.callTool('run_ai_turn', { session_id: sessionId, player_id: active });
        res.ai_turns += 1;
        if (resp.isError) {
          res.error = { code: 'RUN_AI_TURN_ERROR', message: stringifyToolText(resp) };
          break;
        }
        view = (parseToolJson(resp) as StepView | null) ?? {};
        continue;
      }

      if (isHumanTurnStatus(step.status)) {
        if (!humans.has(active!)) {
          note('human_directive_targets_ai', `next_step routed human_to_move to non-human seat ${active}`);
          // Recover: treat it as an AI move so the game can still progress.
          const resp = await this.harness.callTool('run_ai_turn', { session_id: sessionId, player_id: active });
          view = (parseToolJson(resp) as StepView | null) ?? {};
          continue;
        }
        if (!step.instruction || step.instruction.trim().length === 0) {
          note('empty_human_directive', `human_to_move for ${active} carried no instruction`);
        }
        const next = await this.driveHumanMove(sessionId, active!, note, res);
        if (!next) break; // stuck, blocked-on-report, or fatal — already recorded
        view = next;
        res.human_moves += 1;
        continue;
      }

      // game_over status (terminal directive) without game_over flag — finish.
      if (step.status === 'game_over') {
        res.completed = true;
        res.game_over = true;
        res.result = view.result;
        break;
      }

      note('missing_next_step', `unknown next_step.status="${step.status}"`);
      break;
    }

    if (res.steps >= STEP_LIMIT) {
      res.error = { code: 'STEP_LIMIT', message: `Exceeded ${STEP_LIMIT} steps` };
    }
    return res;
  }

  /** Pick and submit one move for the human seat. Tries the AI suggestion first
   *  (best move + valid synthesized reports for games where that works), then
   *  every concrete legal move (the real human surface — covers setup-choice
   *  defaults and named turns the AI's meta-moves can't stand in for). Returns
   *  the resulting StepView, or null if blocked/stuck (recorded on `res`). */
  private async driveHumanMove(
    sessionId: string,
    playerId: string,
    note: (kind: InvariantViolation['kind'], detail: string) => void,
    res: EngineBotResult,
  ): Promise<StepView | null> {
    const candidates: { move: unknown; source: string }[] = [];
    const suggest = await this.harness.callTool('suggest_move', { session_id: sessionId, player_id: playerId });
    if (!suggest.isError) {
      const s = parseToolJson(suggest) as { suggested_move?: unknown } | null;
      if (s?.suggested_move != null) candidates.push({ move: s.suggested_move, source: 'suggest_move' });
    }
    const legal = await this.harness.callTool('get_legal_moves', { session_id: sessionId, player_id: playerId });
    const l = parseToolJson(legal) as { legal_moves?: { move?: unknown }[] } | null;
    for (const m of l?.legal_moves ?? []) {
      if (m.move != null) candidates.push({ move: m.move, source: 'get_legal_moves' });
    }

    if (candidates.length === 0) {
      note('human_stuck_no_move', `${playerId} is owed a move but neither suggest_move nor get_legal_moves offered one`);
      return null;
    }

    // A rejected move never mutates state (the engine throws before applying), so
    // it's safe to try candidates in order until one is accepted.
    let lastReason = '';
    for (const c of candidates) {
      const applied = await this.harness.callTool('apply_move', { session_id: sessionId, player_id: playerId, move: c.move });
      if (!applied.isError) {
        return (parseToolJson(applied) as StepView | null) ?? {};
      }
      lastReason = stringifyToolText(applied);
    }

    // Nothing the client can SEE produced a valid move — this is a physical
    // REPORT whose values live in the server's hidden deck. Ask the server to
    // synthesize a valid one (auto_report) and submit it through the human path.
    const auto = await this.harness.callTool('auto_report', { session_id: sessionId, player_id: playerId });
    if (!auto.isError) {
      const a = parseToolJson(auto) as { report_move?: unknown } | null;
      if (a?.report_move != null) {
        const applied = await this.harness.callTool('apply_move', {
          session_id: sessionId,
          player_id: playerId,
          move: a.report_move,
        });
        if (!applied.isError) {
          res.reports_synthesized = (res.reports_synthesized ?? 0) + 1;
          return (parseToolJson(applied) as StepView | null) ?? {};
        }
        lastReason = stringifyToolText(applied);
      }
    }

    // Even auto_report couldn't resolve it. If the rejections read like "this
    // needs real reported values", the game lacks an auto-resolver for this
    // pending (harness gap). Otherwise the server offered moves it then refused —
    // a real flow bug.
    const moveType =
      typeof (candidates[0]?.move as { type?: unknown })?.type === 'string'
        ? String((candidates[0]!.move as { type: string }).type)
        : 'unknown';
    if (looksLikeReportGap(lastReason)) {
      res.blocked = { move_type: moveType, reason: lastReason.replace(/\s+/g, ' ').slice(0, 160) };
    } else {
      note('suggested_move_rejected', `every candidate for ${playerId} was rejected; last: ${lastReason.slice(0, 200)}`);
    }
    return null;
  }
}
