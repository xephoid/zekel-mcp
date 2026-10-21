// Assistant harness — the FAITHFUL scenario.
//
// This models how the product is actually used: a HUMAN plays the physical game
// and talks to an AI ASSISTANT (this is the Claude-Code-over-MCP role); the
// assistant operates the MCP tools, records the human's declared moves, resolves
// the AI opponents, and SPEAKS back to the human (confirming the move and — the
// load-bearing part — narrating what the AI did so the human can update the
// board). Nobody asks the LLM to *decide* a human's move from a directive; that
// was the unrealistic part of the llm-bot.
//
//   • The human is SIMULATED: the game AI picks the move a good human would make
//     (or, at a physical-report pending, the server supplies the real drawn/rolled
//     values via auto_report). A "human-sim" LLM phrases that as casual table talk.
//   • The ASSISTANT (model under test) gets real MCP tools (get_state,
//     get_legal_moves, get_rules, apply_move, run_ai_turn) and drives the session
//     in an agentic loop, then returns its spoken reply.
//   • We AUTO-SCORE the translation (did the move the assistant recorded match the
//     human's ground-truth move?) and LOG the spoken reply for manual review.

import { Harness, parseToolJson, stringifyToolText } from './runner.js';
import { OllamaClient, type OllamaConfig, type ToolDef } from './ollama.js';
import { isHumanTurnStatus } from '@zekel/game-kit';

export interface AssistantPlayer {
  player_id: string;
  kind: 'human' | 'ai';
  difficulty?: 'easy' | 'medium' | 'hard' | 'mcts';
}

export type Translation = 'exact' | 'type_only' | 'mismatch' | 'none';

export interface ToolCallRecord {
  name: string;
  args: unknown;
  ok: boolean;
  result_preview: string;
}

export interface AssistantTurnRecord {
  step: number;
  kind: 'human' | 'ai';
  player_id: string;
  human_utterance?: string;
  ground_truth_move?: unknown;
  is_report?: boolean;
  recorded_move?: unknown;
  translation?: Translation;
  tool_calls: ToolCallRecord[];
  spoken_reply: string;
  resolved: boolean; // did the assistant itself advance the game (apply/run_ai)?
  note?: string;
}

export interface AssistantGameResult {
  game_id: string;
  seed: number;
  assistant_model: string;
  human_model: string;
  players: AssistantPlayer[];
  completed: boolean;
  game_over: boolean;
  steps: number;
  human_turns: number;
  ai_turns: number;
  // Translation auto-score over human turns:
  translation: Record<Translation, number>;
  translation_rate: number; // (exact + type_only) / human_turns
  turns: AssistantTurnRecord[];
  error?: { code: string; message: string };
  // The harness could not advance a human turn (no valid move; auto_report could
  // not fill the pending) — a harness/report-coverage gap, NOT a game bug. The
  // run stops here instead of re-posting the same unresolvable pending forever.
  blocked?: { move_type: string; reason: string };
  result?: { winners?: string[]; scores?: Record<string, number>; summary?: string };
}

interface StepView {
  next_step?: { status?: string; active_player_id?: string | null; instruction?: string };
  game_over?: boolean;
  result?: { winners?: string[]; scores?: Record<string, number>; summary?: string };
}

const STEP_LIMIT = 2000;
const MAX_TOOL_CALLS_PER_TASK = 16;

export class AssistantBot {
  private readonly harness: Harness;
  private readonly assistant: OllamaClient;
  private readonly human: OllamaClient;

  constructor(cfg: { assistant: OllamaConfig; human: OllamaConfig }, harness?: Harness) {
    // Assistant turns are tool-calling loops → allow a long per-call timeout.
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
    players: AssistantPlayer[];
    assistant_model: string;
    human_model: string;
    options?: Record<string, unknown>;
    seed: number;
    maxHumanTurns?: number;
    onTurn?: (rec: AssistantTurnRecord, res: AssistantGameResult) => void;
  }): Promise<AssistantGameResult> {
    const humanSeats = args.players.filter((p) => p.kind === 'human').map((p) => p.player_id);
    const aiSeats = args.players.filter((p) => p.kind === 'ai').map((p) => p.player_id);
    const res: AssistantGameResult = {
      game_id: args.game_id,
      seed: args.seed,
      assistant_model: args.assistant_model,
      human_model: args.human_model,
      players: args.players,
      completed: false,
      game_over: false,
      steps: 0,
      human_turns: 0,
      ai_turns: 0,
      translation: { exact: 0, type_only: 0, mismatch: 0, none: 0 },
      translation_rate: 0,
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
    const systemPrompt = this.buildAssistantSystem(args.game_id, sessionId, humanSeats, aiSeats);
    const tools = mcpToolDefs();

    let view: StepView = created;
    const maxHuman = args.maxHumanTurns ?? Infinity;
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
        await this.handleAiTurn(sessionId, active, systemPrompt, tools, res);
        res.ai_turns += 1;
        args.onTurn?.(res.turns[res.turns.length - 1]!, res);
      } else if (isHumanTurnStatus(step.status) && active && humanSeats.includes(active)) {
        if (res.human_turns >= maxHuman) break;
        await this.handleHumanTurn(sessionId, args.game_id, active, step.instruction ?? '', systemPrompt, tools, res);
        res.human_turns += 1;
        args.onTurn?.(res.turns[res.turns.length - 1]!, res);
        if (res.blocked) break; // unresolvable pending — stop instead of spinning to STEP_LIMIT
      } else if (step.status === 'game_over') {
        res.completed = true;
        res.game_over = true;
        res.result = view.result;
        break;
      } else if (active) {
        // human directive routed to an AI seat (report phase) — let the assistant resolve it as an AI step.
        await this.handleAiTurn(sessionId, active, systemPrompt, tools, res);
      } else {
        break;
      }

      // Re-read whose turn it is from the SERVER (authoritative — never trust the
      // assistant's belief about turn order).
      view = await this.readNextStep(sessionId, humanSeats[0] ?? active ?? '');
    }

    // Capture the final result. get_state's next_step flips to game_over but does
    // NOT carry the winner/scores, so the game-over branches above leave
    // res.result undefined — ask is_game_over for the authoritative outcome.
    if (res.game_over && !res.result) {
      const r = await this.harness.callTool('is_game_over', { session_id: sessionId });
      if (!r.isError) {
        const j = parseToolJson(r) as ({ game_over?: boolean } & NonNullable<AssistantGameResult['result']>) | null;
        if (j && j.game_over !== false) res.result = { winners: j.winners, scores: j.scores, summary: j.summary };
      }
    }

    const good = res.translation.exact + res.translation.type_only;
    res.translation_rate = res.human_turns > 0 ? good / res.human_turns : 1;
    return res;
  }

  // ---- human turn: simulate the human, let the assistant record + reply -------

  private async handleHumanTurn(
    sessionId: string,
    gameId: string,
    playerId: string,
    directive: string,
    systemPrompt: string,
    tools: ToolDef[],
    res: AssistantGameResult,
  ): Promise<void> {
    const rec: AssistantTurnRecord = { step: res.steps, kind: 'human', player_id: playerId, tool_calls: [], spoken_reply: '', resolved: false };

    // 1. Ground truth: the move a good human would make (or the real reported
    //    values at a physical-report pending).
    const gt = await this.deriveGroundTruth(sessionId, playerId);
    rec.ground_truth_move = gt?.move;
    rec.is_report = gt?.isReport ?? false;
    if (!gt) {
      rec.note = 'no ground-truth move available';
      res.turns.push(rec);
      return;
    }

    // 2. The human says it, casually, in their own words.
    rec.human_utterance = await this.humanUtterance(gameId, gt.move, gt.isReport, directive);

    // 3. The assistant handles it (agentic tool loop). It gets the authoritative
    //    next_step DIRECTIVE — exactly what a real assistant carries from the prior
    //    tool response. This is load-bearing: at e.g. an Arcs court refill after an
    //    AI Secure, the raw view still shows the AI as the active player with no
    //    legal moves for the human, but the directive says THIS human must flip the
    //    replacement card. Without the directive the assistant trusts the
    //    contradictory raw view and stalls.
    const directiveLine = directive ? `The server's instruction right now is: "${directive}"\n\n` : '';
    const task = gt.isReport
      ? `${directiveLine}The human just told you, about their physical cards/dice: "${rec.human_utterance}"\n\nRecord this for seat ${playerId} using the correct apply_move report, then reply to the human. Trust the server's instruction above over any seeming "whose turn" signal in the raw state.`
      : `${directiveLine}The human (seat ${playerId}) just told you their move: "${rec.human_utterance}"\n\nWork out the exact move and record it with apply_move for seat ${playerId}, then reply to the human confirming it and anything they must do physically.`;
    const loop = await this.runAssistant(sessionId, systemPrompt, tools, task, playerId, rec);
    rec.spoken_reply = loop.reply;

    // 4. Score the translation: the move the assistant actually recorded for this
    //    seat vs the human's ground truth.
    const recorded = loop.appliedForSeat;
    rec.recorded_move = recorded ?? null;
    rec.translation = scoreTranslation(gt.move, recorded);
    res.translation[rec.translation] += 1;
    rec.resolved = loop.advancedHuman;

    // 5. If the assistant never recorded a valid move, advance the game ourselves
    //    so we still get a full transcript (and the miss is recorded).
    if (!loop.advancedHuman) {
      const forced = await this.forceApply(sessionId, playerId, gt.move);
      if (forced) {
        rec.note = 'assistant did not record a valid move; forced ground truth to advance';
      } else {
        // Nothing can advance this pending (the assistant, every legal move, the
        // ground truth, and auto_report all failed). Record it as blocked so the
        // controller STOPS — re-posting the same unresolvable pending every step
        // would otherwise spin to STEP_LIMIT (this happened on a SW:R mission
        // deck that ran dry: a ReportCardDraw auto_report couldn't fill).
        const mt =
          typeof (gt.move as { type?: unknown })?.type === 'string' ? String((gt.move as { type: string }).type) : 'unknown';
        rec.note = 'assistant did not record a move and forced advance failed (blocked)';
        res.blocked = {
          move_type: mt,
          reason: `cannot advance human turn — no valid move and auto_report could not fill ${rec.is_report ? 'this report' : 'this pending'}`,
        };
      }
    }
    res.turns.push(rec);
  }

  // ---- AI turn: assistant resolves it and narrates to the human ---------------

  private async handleAiTurn(
    sessionId: string,
    playerId: string,
    systemPrompt: string,
    tools: ToolDef[],
    res: AssistantGameResult,
  ): Promise<void> {
    const rec: AssistantTurnRecord = { step: res.steps, kind: 'ai', player_id: playerId, tool_calls: [], spoken_reply: '', resolved: false };
    const task = `It is AI opponent seat ${playerId}'s turn. Resolve their whole turn with run_ai_turn, then tell the human IN FULL every board change the AI made (what it played/built/moved/captured/bought, where pieces go, and any score or resource changes) so they can update the physical board.`;
    const loop = await this.runAssistant(sessionId, systemPrompt, tools, task, playerId, rec);
    rec.spoken_reply = loop.reply;
    rec.resolved = loop.advancedAi;
    if (!loop.advancedAi) {
      // Force the AI turn so the game still progresses.
      const r = await this.harness.callTool('run_ai_turn', { session_id: sessionId, player_id: playerId });
      rec.note = r.isError ? 'assistant did not resolve the AI turn and forced run failed' : 'assistant did not call run_ai_turn; forced it to advance';
    }
    res.turns.push(rec);
  }

  // ---- the agentic assistant loop --------------------------------------------

  private async runAssistant(
    sessionId: string,
    systemPrompt: string,
    tools: ToolDef[],
    task: string,
    seatForScoring: string,
    rec: AssistantTurnRecord,
  ): Promise<{ reply: string; appliedForSeat?: unknown; advancedHuman: boolean; advancedAi: boolean }> {
    const messages: unknown[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task },
    ];
    let appliedForSeat: unknown;
    let advancedHuman = false;
    let advancedAi = false;
    let reply = '';

    for (let i = 0; i < MAX_TOOL_CALLS_PER_TASK; i++) {
      let turn;
      try {
        turn = await this.assistant.chatTools(messages, tools);
      } catch {
        // One retry — a thinking 35B doing several rounds can occasionally trip
        // the per-call timeout; a single retry recovers most of these.
        try {
          turn = await this.assistant.chatTools(messages, tools);
        } catch (e2) {
          reply = `__ASSISTANT_ERROR__ ${(e2 as Error).message}`;
          break;
        }
      }
      messages.push(turn.raw);
      if (turn.toolCalls.length === 0) {
        reply = turn.content;
        break;
      }
      for (const tc of turn.toolCalls) {
        const dispatch = await this.dispatchTool(sessionId, tc.name, tc.arguments);
        rec.tool_calls.push({ name: tc.name, args: tc.arguments, ok: dispatch.ok, result_preview: dispatch.text.slice(0, 240) });
        // Track game-advancing effects for scoring + fallback decisions.
        if (tc.name === 'apply_move' && dispatch.ok) {
          const movedSeat = (tc.arguments as { player_id?: string }).player_id;
          if (movedSeat === seatForScoring) {
            appliedForSeat = (tc.arguments as { move?: unknown }).move;
            advancedHuman = true;
          }
        }
        if (tc.name === 'run_ai_turn' && dispatch.ok) advancedAi = true;
        messages.push({ role: 'tool', tool_name: tc.name, content: dispatch.text });
      }
    }
    return { reply, appliedForSeat, advancedHuman, advancedAi };
  }

  // Execute one MCP tool the assistant asked for. session_id/game_id are injected
  // if the model omitted them (lenient, but it should pass session_id).
  private async dispatchTool(sessionId: string, name: string, rawArgs: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    const allowed = new Set(['get_state', 'get_legal_moves', 'get_rules', 'apply_move', 'run_ai_turn']);
    if (!allowed.has(name)) {
      return { ok: false, text: JSON.stringify({ error: `unknown tool "${name}"` }) };
    }
    const args: Record<string, unknown> = { ...rawArgs };
    if (name !== 'get_rules') args.session_id = sessionId;
    try {
      const resp = await this.harness.callTool(name, args);
      const text = (resp.content?.[0]?.text as string | undefined) ?? JSON.stringify(resp);
      // Cap tool output so a giant view can't blow the context window.
      return { ok: !resp.isError, text: text.length > 4000 ? `${text.slice(0, 4000)}…(truncated)` : text };
    } catch (e) {
      return { ok: false, text: JSON.stringify({ error: (e as Error).message }) };
    }
  }

  // ---- human simulation -------------------------------------------------------

  private async humanUtterance(gameId: string, move: unknown, isReport: boolean, directive: string): Promise<string> {
    const sys = [
      `You are a person playing the physical board game "${gameId}" at a table, talking to your AI helper who records your moves for you.`,
      `You have decided what to do. Tell your helper OUT LOUD in one or two casual sentences, the way a real player speaks.`,
      `BE SPECIFIC so your helper knows EXACTLY what you mean: name the precise card (its name and/or number — "Admiral 3", "the AGG-2 card"), the exact slot number, system, or piece. A real player names the exact card — never say a vague "my Admiral card" when you hold several; say which one.`,
      `Do not output raw JSON, braces, or key:value pairs — but DO speak the card names, numbers, and slot/location values plainly.`,
      `If your move just advances a phase (ending your prelude, passing, skipping an ambition declaration, ending your turn), say so DIRECTLY ("I'm ending my prelude", "I pass", "I'll skip the ambition"). NEVER reply with filler like "I'm ready when you are" — always state the actual move.`,
      isReport
        ? `This is you reporting what you physically drew or rolled. State EVERY value exactly and completely — if you drew 9 cards, name all 9 (including duplicates); if you must keep some and set one aside, say which. Do not drop or merge any.`
        : `This is the action you are taking on your turn.`,
    ].join('\n');
    const user = [
      `The move you decided on (for your reference — translate it into natural speech, don't read it out):`,
      JSON.stringify(move),
      directive ? `\nContext the table is in: ${directive}` : '',
      `\nSay it to your helper now.`,
    ].join('\n');
    try {
      const reply = await this.human.chat([
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ]);
      return reply.content.replace(/^["']|["']$/g, '').trim() || JSON.stringify(move);
    } catch {
      return JSON.stringify(move);
    }
  }

  // ---- ground truth + fallbacks ----------------------------------------------

  private async deriveGroundTruth(sessionId: string, playerId: string): Promise<{ move: unknown; isReport: boolean } | null> {
    // A physical-report pending → the server holds the real values.
    const auto = await this.harness.callTool('auto_report', { session_id: sessionId, player_id: playerId });
    if (!auto.isError) {
      const r = (parseToolJson(auto) as { report_move?: unknown } | null)?.report_move;
      if (r != null) return { move: r, isReport: true };
    }
    // For a normal turn: prefer the AI's suggestion (it plays well) but only if it
    // is actually LEGAL right now — getAIMove can return an out-of-phase move at a
    // setup/choice pending (e.g. Arcs returns a pass at the colour-setup phase).
    // Fall back to the first legal move so the ground truth is never illegal.
    const legalResp = await this.harness.callTool('get_legal_moves', { session_id: sessionId, player_id: playerId });
    const legalMoves = (parseToolJson(legalResp) as { legal_moves?: { move?: unknown }[] } | null)?.legal_moves ?? [];
    const legalTypes = new Set(
      legalMoves.map((m) => (m.move as { type?: unknown })?.type).filter((t): t is string => typeof t === 'string'),
    );
    const suggest = await this.harness.callTool('suggest_move', { session_id: sessionId, player_id: playerId });
    if (!suggest.isError) {
      const m = (parseToolJson(suggest) as { suggested_move?: unknown } | null)?.suggested_move as { type?: unknown } | undefined;
      if (m != null && typeof m.type === 'string' && legalTypes.has(m.type)) return { move: m, isReport: false };
    }
    const first = legalMoves[0]?.move;
    return first != null ? { move: first, isReport: false } : null;
  }

  // Advance the game with a guaranteed-valid move (the ground truth, else any
  // legal move, else the report) when the assistant failed to.
  private async forceApply(sessionId: string, playerId: string, groundTruth: unknown): Promise<boolean> {
    const tryMove = async (move: unknown): Promise<boolean> => {
      const a = await this.harness.callTool('apply_move', { session_id: sessionId, player_id: playerId, move });
      return !a.isError;
    };
    if (await tryMove(groundTruth)) return true;
    const legal = await this.harness.callTool('get_legal_moves', { session_id: sessionId, player_id: playerId });
    for (const m of (parseToolJson(legal) as { legal_moves?: { move?: unknown }[] } | null)?.legal_moves ?? []) {
      if (m.move != null && (await tryMove(m.move))) return true;
    }
    const auto = await this.harness.callTool('auto_report', { session_id: sessionId, player_id: playerId });
    if (!auto.isError) {
      const r = (parseToolJson(auto) as { report_move?: unknown } | null)?.report_move;
      if (r != null && (await tryMove(r))) return true;
    }
    return false;
  }

  private async readNextStep(sessionId: string, playerId: string): Promise<StepView> {
    if (!playerId) return {};
    const resp = await this.harness.callTool('get_state', { session_id: sessionId, player_id: playerId });
    return (parseToolJson(resp) as StepView | null) ?? {};
  }

  // ---- prompts ----------------------------------------------------------------

  private buildAssistantSystem(gameId: string, sessionId: string, humanSeats: string[], aiSeats: string[]): string {
    return [
      `You are an AI assistant helping a human play the PHYSICAL board game "${gameId}" at a real table.`,
      `A bookkeeping MCP server tracks the shared board and runs the AI opponents. You operate its tools.`,
      ``,
      `Session id: ${sessionId} (pass session_id="${sessionId}" on every tool call).`,
      `The human you assist controls seat(s): ${humanSeats.join(', ') || '(none)'}.`,
      `The AI opponent(s) control seat(s): ${aiSeats.join(', ') || '(none)'}.`,
      ``,
      `TOOLS: get_state, get_legal_moves, get_rules (look things up), apply_move (record a move for a seat),`,
      `run_ai_turn (resolve an AI opponent's whole turn). Call them as needed, then give your spoken reply as plain text.`,
      ``,
      `WHEN THE HUMAN DECLARES A MOVE: figure out the exact move (use get_legal_moves / get_state / get_rules`,
      `if unsure), record it with apply_move for the human's seat, then confirm to the human in plain language.`,
      `Do not invent values the human did not state; if they reported a physical draw or roll, record exactly that.`,
      ``,
      `WHEN IT IS AN AI OPPONENT'S TURN: call run_ai_turn, then tell the human IN FULL every board change the AI`,
      `made (played/built/moved/captured/bought, where pieces go, score/resource deltas) so they can update the`,
      `physical board. Never just say "the AI took its turn" — the human cannot see what the virtual AI did.`,
      ``,
      `Keep spoken replies to what the human needs: what you recorded and what they must physically do.`,
    ].join('\n');
  }
}

// ---- tool definitions exposed to the assistant ------------------------------

function mcpToolDefs(): ToolDef[] {
  const sid = { type: 'string', description: 'The session id from the system prompt.' };
  const pid = { type: 'string', description: 'The seat/player id to act for.' };
  return [
    {
      type: 'function',
      function: {
        name: 'get_state',
        description: "Get a player's view of the current board plus next_step (whose turn / what is owed).",
        parameters: { type: 'object', required: ['session_id', 'player_id'], properties: { session_id: sid, player_id: pid } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_legal_moves',
        description: 'List the legal moves available to a player right now (each with its exact JSON shape).',
        parameters: { type: 'object', required: ['session_id', 'player_id'], properties: { session_id: sid, player_id: pid } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_rules',
        description: 'Get the rules text, reference data, and the move-shape catalog for this game.',
        parameters: { type: 'object', required: ['game_id'], properties: { game_id: { type: 'string', description: 'The game id.' } } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'apply_move',
        description: "Record a move for a seat. `move` is a JSON object matching one of the game's move shapes.",
        parameters: {
          type: 'object',
          required: ['session_id', 'player_id', 'move'],
          properties: { session_id: sid, player_id: pid, move: { type: 'object', description: 'The structured move to record.' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_ai_turn',
        description: "Resolve an AI opponent's entire turn (all its moves) until a human is owed something or the game ends.",
        parameters: { type: 'object', required: ['session_id', 'player_id'], properties: { session_id: sid, player_id: pid } },
      },
    },
  ];
}

// ---- translation scoring ----------------------------------------------------

function scoreTranslation(groundTruth: unknown, recorded: unknown): Translation {
  if (recorded == null) return 'none';
  const gt = groundTruth as { type?: unknown };
  const rec = recorded as { type?: unknown };
  if (stableStringify(groundTruth) === stableStringify(recorded)) return 'exact';
  if (typeof gt?.type === 'string' && gt.type === rec?.type) return 'type_only';
  return 'mismatch';
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
