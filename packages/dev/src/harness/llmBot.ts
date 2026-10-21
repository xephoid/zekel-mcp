// Comprehension LLM-bot: drives ONE seat as a real LLM would — reading only the
// human-facing surface (the player VIEW + the next_step DIRECTIVE + recent log)
// and constructing the move JSON FREE-FORM, then submitting it via apply_move.
//
// This is the legibility test the engine-bot can't do: the engine-bot proves the
// FLOW is sound (a perfect player never desyncs); the LLM-bot proves the PROSE is
// COMPREHENSIBLE (a weak model, reading what a human reads, picks the right
// action and reports when asked). It runs on the same next_step client loop.
//
// Scoring = flow + directive-adherence. Per human turn we classify the model's
// move against an oracle (get_legal_moves + auto_report — NEVER shown to the
// model): did it produce a legal action now, recognize when it owed a physical
// report, etc. Hidden report VALUES (dealt cards, dice) are filled by the server
// (auto_report) — the model is only expected to recognize it must report, not to
// invent values it cannot see. Whatever the model does, we still advance the game
// with a valid fallback move so every run yields a full-game transcript.

import { Harness, parseToolJson, stringifyToolText } from './runner.js';
import { OllamaClient, extractMoveJson, type OllamaConfig } from './ollama.js';
import { isHumanTurnStatus } from '@zekel/game-kit';

export interface LlmBotPlayer {
  player_id: string;
  kind: 'human' | 'ai';
  difficulty?: 'easy' | 'medium' | 'hard' | 'mcts';
}

export type TurnOutcome =
  | 'applied_ok' // model's move was legal now and applied as-is
  | 'report_ok' // a report was owed; model produced the right report move type
  | 'bad_params' // right action type, but illegal parameters (advanced via fallback)
  | 'wrong_action' // move type not legal now (advanced via fallback)
  | 'missed_report' // a report was owed; model produced a non-report (advanced via auto_report)
  | 'format_error'; // no parseable move JSON (advanced via fallback)

export interface TurnRecord {
  step: number;
  player_id: string;
  directive: string;
  model_raw: string;
  parsed_type: string | null;
  outcome: TurnOutcome;
  detail?: string;
}

export interface LlmBotResult {
  game_id: string;
  seed: number;
  model: string;
  players: LlmBotPlayer[];
  completed: boolean;
  game_over: boolean;
  steps: number;
  human_turns: number;
  ai_turns: number;
  reports_synthesized: number;
  adherence: Record<TurnOutcome, number>;
  // (applied_ok + report_ok) / human_turns — the headline "did the model do the
  // right thing reading only human-facing text" number.
  adherence_rate: number;
  turns: TurnRecord[];
  blocked?: { move_type: string; reason: string };
  error?: { code: string; message: string };
  result?: { winners?: string[]; scores?: Record<string, number>; summary?: string };
}

interface StepView {
  next_step?: { status?: string; active_player_id?: string | null; instruction?: string };
  game_over?: boolean;
  result?: { winners?: string[]; scores?: Record<string, number>; summary?: string };
}

const STEP_LIMIT = 4000;

export class LlmBot {
  private readonly harness: Harness;
  private readonly llm: OllamaClient;
  constructor(cfg: OllamaConfig, harness?: Harness) {
    this.harness = harness ?? new Harness();
    this.llm = new OllamaClient(cfg);
  }

  async start(): Promise<void> {
    await this.harness.start();
  }
  async close(): Promise<void> {
    await this.harness.close();
  }

  async runOneGame(args: {
    game_id: string;
    players: LlmBotPlayer[];
    model: string;
    options?: Record<string, unknown>;
    seed: number;
  }): Promise<LlmBotResult> {
    const humans = new Set(args.players.filter((p) => p.kind === 'human').map((p) => p.player_id));
    const res: LlmBotResult = {
      game_id: args.game_id,
      seed: args.seed,
      model: args.model,
      players: args.players,
      completed: false,
      game_over: false,
      steps: 0,
      human_turns: 0,
      ai_turns: 0,
      reports_synthesized: 0,
      adherence: { applied_ok: 0, report_ok: 0, bad_params: 0, wrong_action: 0, missed_report: 0, format_error: 0 },
      adherence_rate: 0,
      turns: [],
    };

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

    // Fetch the static reference once for the system prompt: rules + the move
    // shape catalog (the action reference a real player has — NOT the legal-now
    // set). This is what a real MCP client would read from get_rules.
    const rulesResp = await this.harness.callTool('get_rules', { game_id: args.game_id });
    const rulesJson = (parseToolJson(rulesResp) as { rules?: string; move_schema?: unknown } | null) ?? {};
    const systemPrompt = buildSystemPrompt(args.game_id, rulesJson.rules ?? '', rulesJson.move_schema);

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
      if (!step?.status) break;
      const active = step.active_player_id ?? undefined;

      if (step.status === 'ai_to_move' && active) {
        const resp = await this.harness.callTool('run_ai_turn', { session_id: sessionId, player_id: active });
        res.ai_turns += 1;
        if (resp.isError) {
          res.error = { code: 'RUN_AI_TURN_ERROR', message: stringifyToolText(resp) };
          break;
        }
        view = (parseToolJson(resp) as StepView | null) ?? {};
        continue;
      }

      if (isHumanTurnStatus(step.status) && active && humans.has(active)) {
        const next = await this.driveLlmMove(sessionId, active, step.instruction ?? '', systemPrompt, res);
        if (!next) break; // blocked/stuck — recorded
        view = next;
        res.human_turns += 1;
        continue;
      }

      // A human directive routed to a non-human seat, or a terminal status —
      // recover by advancing AI, or finish.
      if (step.status === 'game_over') {
        res.completed = true;
        res.game_over = true;
        res.result = view.result;
        break;
      }
      if (active) {
        const resp = await this.harness.callTool('run_ai_turn', { session_id: sessionId, player_id: active });
        view = (parseToolJson(resp) as StepView | null) ?? {};
        continue;
      }
      break;
    }

    if (res.steps >= STEP_LIMIT) {
      res.error = { code: 'STEP_LIMIT', message: `Exceeded ${STEP_LIMIT} steps` };
    }
    const good = res.adherence.applied_ok + res.adherence.report_ok;
    res.adherence_rate = res.human_turns > 0 ? good / res.human_turns : 1;
    return res;
  }

  /** Ask the LLM for one move (free-form JSON from human-facing text only),
   *  classify it against the legal-move + report oracle, apply it (or a valid
   *  fallback so the game always advances), and record the outcome. */
  private async driveLlmMove(
    sessionId: string,
    playerId: string,
    directive: string,
    systemPrompt: string,
    res: LlmBotResult,
  ): Promise<StepView | null> {
    // 1. The human-facing VIEW (the model's "look at the table").
    const stateResp = await this.harness.callTool('get_state', { session_id: sessionId, player_id: playerId });
    const stateJson = parseToolJson(stateResp) as (Record<string, unknown> & { log?: unknown }) | null;
    const view = stripForView(stateJson);
    const recentLog = extractRecentLog(stateJson);

    // 2. Oracle (NEVER shown to the model): what is legal now + a server-filled
    //    report move if one is owed.
    const legalResp = await this.harness.callTool('get_legal_moves', { session_id: sessionId, player_id: playerId });
    const legal = (parseToolJson(legalResp) as { legal_moves?: { move?: { type?: string } }[] } | null)?.legal_moves ?? [];
    const legalTypes = new Set(legal.map((m) => m.move?.type).filter((t): t is string => typeof t === 'string'));
    const autoResp = await this.harness.callTool('auto_report', { session_id: sessionId, player_id: playerId });
    const reportMove = autoResp.isError ? null : (parseToolJson(autoResp) as { report_move?: { type?: string } } | null)?.report_move ?? null;
    const reportType = (reportMove as { type?: string } | null)?.type;
    const reportOwed = reportMove != null;

    // 3. Ask the model.
    const userPrompt = buildTurnPrompt(view, recentLog, directive);
    let parsed: Record<string, unknown> | null = null;
    let raw = '';
    try {
      const reply = await this.llm.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]);
      raw = reply.content;
      parsed = extractMoveJson(reply.content);
    } catch (e) {
      raw = `__LLM_ERROR__ ${(e as Error).message}`;
    }
    const parsedType = typeof parsed?.type === 'string' ? (parsed.type as string) : null;

    // 4. Classify + apply (with a guaranteed-valid fallback so we always advance).
    const record: TurnRecord = { step: res.steps, player_id: playerId, directive, model_raw: raw.slice(0, 800), parsed_type: parsedType, outcome: 'format_error' };

    const applyFallback = async (): Promise<StepView | null> => {
      for (const m of legal) {
        if (m.move == null) continue;
        const a = await this.harness.callTool('apply_move', { session_id: sessionId, player_id: playerId, move: m.move });
        if (!a.isError) return (parseToolJson(a) as StepView | null) ?? {};
      }
      if (reportMove) {
        const a = await this.harness.callTool('apply_move', { session_id: sessionId, player_id: playerId, move: reportMove });
        if (!a.isError) {
          res.reports_synthesized += 1;
          return (parseToolJson(a) as StepView | null) ?? {};
        }
        record.detail = stringifyToolText(a).replace(/\s+/g, ' ').slice(0, 160);
        res.blocked = { move_type: reportType ?? 'report', reason: record.detail };
      }
      return null;
    };

    let nextView: StepView | null;
    if (reportOwed) {
      if (parsedType && reportType && parsedType === reportType) {
        record.outcome = 'report_ok';
      } else {
        record.outcome = 'missed_report';
        record.detail = `owed ${reportType}, got ${parsedType ?? 'unparseable'}`;
      }
      // Either way the VALUES come from the server (the model can't see them).
      const a = await this.harness.callTool('apply_move', { session_id: sessionId, player_id: playerId, move: reportMove! });
      if (!a.isError) {
        res.reports_synthesized += 1;
        nextView = (parseToolJson(a) as StepView | null) ?? {};
      } else {
        nextView = await applyFallback();
      }
    } else if (parsed == null) {
      record.outcome = 'format_error';
      nextView = await applyFallback();
    } else if (parsedType && legalTypes.has(parsedType)) {
      const a = await this.harness.callTool('apply_move', { session_id: sessionId, player_id: playerId, move: parsed });
      if (!a.isError) {
        record.outcome = 'applied_ok';
        nextView = (parseToolJson(a) as StepView | null) ?? {};
      } else {
        record.outcome = 'bad_params';
        record.detail = stringifyToolText(a).replace(/\s+/g, ' ').slice(0, 160);
        nextView = await applyFallback();
      }
    } else {
      record.outcome = 'wrong_action';
      record.detail = `type "${parsedType ?? 'none'}" not legal now (legal: ${[...legalTypes].join(', ') || 'none'})`;
      nextView = await applyFallback();
    }

    res.adherence[record.outcome] += 1;
    res.turns.push(record);
    return nextView;
  }
}

// ---- prompt assembly --------------------------------------------------------

function buildSystemPrompt(gameId: string, rules: string, moveSchema: unknown): string {
  // Rules can be long; keep them — comprehension is the point — but cap hard so a
  // pathological game can't blow the context window.
  const rulesText = rules.length > 12_000 ? `${rules.slice(0, 12_000)}\n…(rules truncated)` : rules;
  const schemaText = moveSchema ? JSON.stringify(moveSchema, null, 0) : '(no move schema available)';
  return [
    `You are playing the physical board game "${gameId}" at a real table against AI opponents.`,
    `A bookkeeping server tracks the shared board and runs the AI brains. You control ONE seat.`,
    ``,
    `Each turn you are given: (1) YOUR VIEW of the game, (2) a DIRECTIVE that authoritatively tells`,
    `you what to do next, and (3) recent events. You must reply with EXACTLY ONE move as a single`,
    `JSON object — no prose, no markdown fences, no explanation. Just the JSON object.`,
    ``,
    `RULES OF CONDUCT:`,
    `- OBEY THE DIRECTIVE. It tells you which kind of move to make right now.`,
    `- Output ONE move as raw JSON, matching one of the shapes in the ACTION CATALOG below.`,
    `- NEVER invent hidden values. If the DIRECTIVE asks you to REPORT a physical draw, dice roll,`,
    `  or dealt hand whose values you cannot see, reply with the report move's "type" (and player_id`,
    `  if it has one) and leave the unknown values out or empty — the table fills in the real drawn`,
    `  or rolled values. Do NOT fabricate card ids or dice numbers.`,
    `- Read counts, costs, and sizes from YOUR VIEW and the DIRECTIVE, not from memory.`,
    ``,
    `ACTION CATALOG (every move shape this game accepts; only some are legal on any given turn):`,
    schemaText,
    ``,
    `RULES:`,
    rulesText,
  ].join('\n');
}

function buildTurnPrompt(view: unknown, recentLog: string[], directive: string): string {
  return [
    `YOUR VIEW:`,
    JSON.stringify(view, null, 0),
    ``,
    ...(recentLog.length ? [`RECENT EVENTS:`, ...recentLog.map((l) => `- ${l}`), ``] : []),
    `DIRECTIVE: ${directive || '(none — make a legal move for your turn)'}`,
    ``,
    `Reply with exactly one move as a JSON object.`,
  ].join('\n');
}

// Drop next_step + log from the view we hand the model — next_step is delivered
// as the DIRECTIVE, and the log is summarized separately as RECENT EVENTS.
function stripForView(state: Record<string, unknown> | null): unknown {
  if (!state) return {};
  const { next_step: _ns, log: _log, ...rest } = state;
  void _ns;
  void _log;
  return rest;
}

function extractRecentLog(state: Record<string, unknown> | null): string[] {
  const log = state?.log;
  if (!Array.isArray(log)) return [];
  const lines = log
    .map((e) => (typeof e === 'string' ? e : (e as { summary?: string })?.summary))
    .filter((s): s is string => typeof s === 'string');
  return lines.slice(-6);
}
