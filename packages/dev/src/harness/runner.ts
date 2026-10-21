// Game-agnostic AI testing harness. Spawns the built MCP server as a child
// process, talks via raw JSON-RPC over stdio (matching the existing
// scripts/smoke-mcp.mjs pattern), and runs AI-vs-AI games end-to-end.
//
// Per the plan, this layer is game-agnostic: it calls the standard tool
// surface (`create_session`, `get_ai_move`, `is_game_over`, `get_state`)
// and works for any game registered with the server. Per-game metrics live
// in src/harness/metrics.ts.

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

export type Difficulty = 'random' | 'easy' | 'medium' | 'hard' | 'mcts';

export interface AIPlayerConfig {
  player_id: string;
  kind: 'ai';
  difficulty?: Difficulty;
  /** Strategy axis (§0) — a named policy forwarded to the game's getAIMove,
   *  orthogonal to difficulty. Travels with the seat across rotation. */
  strategy?: string;
}

export interface MoveRecord {
  turn: number;
  player_id: string;
  move: unknown;
  narration: string;
  summary: string;
}

export interface GameRecord {
  game_id: string;
  seed: number;
  players: AIPlayerConfig[];
  /** The options passed to create_session (e.g. the swept loadout). Recorded
   *  so batch analysis can use "card was available" as a lift denominator. */
  options?: Record<string, unknown>;
  moves: MoveRecord[];
  result: { winners: string[]; scores: Record<string, number>; summary: string };
  final_views: Record<string, unknown>;
  error?: { code: string; message: string };
  /** True when the game was stopped at the round cap without a natural end —
   *  a stalemate (no net damage ever lands). Recorded as a draw, NOT an error,
   *  and surfaced as a "stalemate rate" so degenerate loadouts are measurable. */
  timeout?: boolean;
  /** §4 temporal trace: one public-scoreboard snapshot per completed player-turn,
   *  in order. Captured only when runOneGame is called with captureScoreTrace
   *  (the harness `--trace` flag) and the game implements getScoreboard. Each
   *  snapshot is `playerId → { resource → value }`, exactly getScoreboard's shape.
   *  Absent ⇒ no trace requested or the game exposes no scoreboard. */
  score_trace?: Record<string, Record<string, number>>[];
}

export interface GameMetadata {
  game_id: string;
  name: string;
  description: string;
  min_players: number;
  max_players: number;
  supports_ai: boolean;
  has_hidden_information: boolean;
  options_schema: unknown;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingCall {
  resolve: (msg: JsonRpcMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const HARNESS_SAFETY_TURN_LIMIT = 5000;
// A single player-turn that makes this many moves without ending is treated as
// a non-terminating loop (e.g. an AI re-selecting a no-progress move forever)
// and the game is recorded as a timeout-draw rather than spinning to the hard
// cap. Far above any legitimate turn (a big turn is well under ~30 moves).
const PER_TURN_MOVE_CAP = 250;

export interface HarnessOptions {
  /** Path to the built MCP server entrypoint. Defaults to the project's server
   *  (DevSetup.serverPath), else dist/index.js in the current folder. */
  serverPath?: string;
  /** Per-tool-call timeout in milliseconds. Larger AI games (e.g., Ollama-backed) may need higher. */
  callTimeoutMs?: number;
  /**
   * Per-move MCTS budget in milliseconds, forwarded to the spawned server via
   * the MCTS_BUDGET_MS env var. Games that support 'mcts' difficulty read it
   * (Arcs does). Lets head-to-head batches run at a feasible per-move cost
   * instead of the server's 1000ms default.
   */
  mctsBudgetMs?: number;
}

// The server a Harness starts when it is not given one. A project whose server
// is not dist/index.js names its own with DevSetup.serverPath (runDevCommand
// sets it here).
let defaultServerPath: string | undefined;

/** Set the server every Harness starts unless told otherwise; undefined goes
 *  back to dist/index.js in the current folder. */
export function setDefaultServerPath(path: string | undefined): void {
  defaultServerPath = path === undefined ? undefined : resolve(path);
}

export class Harness {
  private child: ChildProcess | null = null;
  private pending = new Map<number, PendingCall>();
  private nextId = 1;
  private buf = '';
  private initialized = false;
  private readonly serverPath: string;
  private readonly callTimeoutMs: number;
  private readonly mctsBudgetMs?: number;

  constructor(opts: HarnessOptions = {}) {
    // The project's built server: the one it named, else dist/index.js in the
    // folder the command runs from.
    this.serverPath = opts.serverPath ?? defaultServerPath ?? resolve(process.cwd(), 'dist', 'index.js');
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.mctsBudgetMs = opts.mctsBudgetMs;
  }

  /** Spawn the server child process and complete the MCP initialize handshake. */
  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn('node', [this.serverPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        // Default the child server to the in-memory session store so harness
        // batches (50+ throwaway sessions per run) never pollute the
        // persistent DB. An explicit SESSION_STORE in the caller's env wins.
        SESSION_STORE: process.env.SESSION_STORE ?? 'memory',
        ...(this.mctsBudgetMs !== undefined ? { MCTS_BUDGET_MS: String(this.mctsBudgetMs) } : {}),
      },
    });
    this.child = child;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => this.onStdout(chunk));
    child.on('exit', (code, signal) => {
      // Ignore the exit of a child we've already replaced (deliberate restart):
      // close() nulls/swaps this.child first, so a stale exit must not reject
      // the NEW child's in-flight calls or null the live handle. Only act when
      // the exiting child is still the active one (i.e. an unexpected crash).
      if (this.child !== child) return;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server exited (code=${code}, signal=${signal}) with pending calls`));
      }
      this.pending.clear();
      this.child = null;
    });

    await this.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ai-harness', version: '0.0.0' },
    });
    this.writeRaw({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (!this.child) return;
    // Null the handle BEFORE killing so the exit handler (which fires async)
    // sees this.child !== child and treats it as a deliberate close — it must
    // not reject calls belonging to a subsequently-spawned child (restart race).
    const child = this.child;
    this.child = null;
    this.initialized = false;
    this.buf = ''; // drop any partial line so it can't corrupt the next child's stream
    child.stdout?.removeAllListeners('data');
    child.kill();
  }

  /** Kill and respawn the server child. The in-memory session store and undo
   *  stacks accumulate across games (~megabytes per game); over a long batch
   *  the child OOMs (~4GB heap). Recycling between games reclaims it. Cheap
   *  (~one MCP handshake) and game-agnostic — each game is independent and its
   *  record is already captured before recycling. */
  async restart(): Promise<void> {
    await this.close();
    await this.start();
  }

  /** List games registered with the server. */
  async listGames(): Promise<GameMetadata[]> {
    await this.ensureStarted();
    const resp = await this.callTool('list_games', {});
    const payload = parseToolJson(resp);
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as Record<string, unknown>).games)) {
      throw new Error('list_games returned no games array');
    }
    return (payload as { games: GameMetadata[] }).games;
  }

  /** Run a single AI-vs-AI game to completion and return the full record. */
  async runOneGame(args: {
    game_id: string;
    players: AIPlayerConfig[];
    options?: Record<string, unknown>;
    seed: number;
    /** Stop and record a draw once this many full rounds complete without a
     *  natural game end. A "round" = one `end_turn` per player. Games that
     *  don't use `end_turn` never trigger this and rely on the hard move
     *  backstop instead. Default: no round cap. */
    maxRounds?: number;
    /** §4 temporal trace: capture a public-scoreboard snapshot after each
     *  completed player-turn (one extra get_state call per turn). Off by default
     *  so normal balance batches pay no extra cost; the harness sets it for
     *  `--trace` runs. No-op for games without getScoreboard. */
    captureScoreTrace?: boolean;
  }): Promise<GameRecord> {
    await this.ensureStarted();
    const record: GameRecord = {
      game_id: args.game_id,
      seed: args.seed,
      players: args.players,
      options: args.options,
      moves: [],
      result: { winners: [], scores: {}, summary: '' },
      final_views: {},
    };

    let session: { session_id: string; active_player_id: string };
    try {
      const create = await this.callTool('create_session', {
        game_id: args.game_id,
        players: args.players,
        // The harness only ever runs AI-vs-AI, so it must explicitly opt
        // into server-driven setup. Games that don't have an auto-setup
        // option ignore this field. (Arcs now refuses to fabricate setup
        // without it — see engine.createInitialState.) Caller options win.
        options: { ai_auto_setup: true, ...(args.options ?? {}), seed: args.seed },
      });
      const payload = parseToolJson(create);
      if (create.isError || !payload || typeof payload !== 'object') {
        record.error = { code: 'CREATE_SESSION_FAILED', message: stringifyToolText(create) };
        return record;
      }
      const p = payload as { session_id?: string; active_player_id?: string };
      if (!p.session_id || !p.active_player_id) {
        record.error = { code: 'CREATE_SESSION_INVALID_PAYLOAD', message: JSON.stringify(p) };
        return record;
      }
      session = { session_id: p.session_id, active_player_id: p.active_player_id };
    } catch (e) {
      record.error = { code: 'CREATE_SESSION_THREW', message: e instanceof Error ? e.message : String(e) };
      return record;
    }

    if (args.captureScoreTrace) record.score_trace = [];
    let active = session.active_player_id;
    let safety = HARNESS_SAFETY_TURN_LIMIT;
    let turn = 1;
    let endTurnCount = 0; // full player-turns completed (one end_turn each)
    let movesThisTurn = 0; // moves since the last end_turn (within-turn loop guard)
    const numPlayers = Math.max(1, args.players.length);
    while (safety-- > 0) {
      const resp = await this.callTool('get_ai_move', {
        session_id: session.session_id,
        player_id: active,
      });
      if (resp.isError) {
        record.error = { code: 'GET_AI_MOVE_ERROR', message: stringifyToolText(resp) };
        break;
      }
      const payload = parseToolJson(resp) as
        | {
            move_taken?: unknown;
            narration?: string;
            state_summary?: string;
            next_active_player_id?: string;
            game_over?: boolean;
            result?: { winners?: string[]; scores?: Record<string, number>; summary?: string };
          }
        | null;
      if (!payload) {
        record.error = { code: 'GET_AI_MOVE_NO_PAYLOAD', message: stringifyToolText(resp) };
        break;
      }
      record.moves.push({
        turn,
        player_id: active,
        move: payload.move_taken,
        narration: payload.narration ?? '',
        summary: payload.state_summary ?? '',
      });
      if (payload.game_over) {
        record.result = {
          winners: payload.result?.winners ?? [],
          scores: payload.result?.scores ?? {},
          summary: payload.result?.summary ?? '',
        };
        // §4 trace: capture the TERMINAL standings so the decisiveness curve's
        // 100%-progress point reflects the final board. (It may still be <100% when
        // a game's WINNER is decided by end-only scoring the during-play scoreboard
        // doesn't show — e.g. Dragonwood's most-creatures bonus — which is itself a
        // signal, not an error.)
        if (record.score_trace) {
          const snap = await this.fetchScoreboard(session.session_id, active);
          if (snap) record.score_trace.push(snap);
        }
        break;
      }
      // Stalemate / loop detection. Two distinct non-termination modes, both
      // recorded as a timeout-draw (NOT an error) so batches stay clean:
      //   (a) round-cap stalemate — maxRounds full rounds with no decisive
      //       strike (degenerate loadout: defense always meets damage);
      //   (b) within-turn loop — one turn making PER_TURN_MOVE_CAP moves
      //       without ending (an AI re-picking a no-progress move forever).
      const moveType = (payload.move_taken as { type?: unknown } | null | undefined)?.type;
      if (moveType === 'end_turn') endTurnCount += 1;
      // Within-turn loop guard counts consecutive moves by the SAME active
      // player and resets when the turn passes to a different player. Keying off
      // the active player (the GENERIC turn boundary) rather than an `end_turn`
      // move is essential: Dragonwood and other games pass the turn implicitly
      // with no end_turn move, so an end_turn-only reset never fired and any
      // long-but-legitimate game was falsely aborted as a "loop". A real
      // same-player loop (e.g. FF focus_reload) still trips the cap.
      if (payload.next_active_player_id && payload.next_active_player_id !== active) {
        movesThisTurn = 0;
        // §4 trace: a player-turn just completed — snapshot the public scoreboard.
        if (record.score_trace) {
          const snap = await this.fetchScoreboard(session.session_id, active);
          if (snap) record.score_trace.push(snap);
        }
      } else {
        movesThisTurn += 1;
      }
      if (args.maxRounds !== undefined && endTurnCount >= args.maxRounds * numPlayers) {
        record.timeout = true;
        record.result = {
          winners: [],
          scores: {},
          summary: `Stalemate: reached ${args.maxRounds}-round cap with no decisive strike.`,
        };
        break;
      }
      // SOLO games (numPlayers === 1) have no turn boundary — every move is the
      // same seat, so "consecutive same-player moves" equals total game length
      // and the per-turn loop guard would abort any long-but-healthy game. The
      // HARNESS_SAFETY_TURN_LIMIT still bounds solo runs. No-op for every
      // multi-player game (the condition only relaxes when numPlayers === 1).
      if (numPlayers > 1 && movesThisTurn >= PER_TURN_MOVE_CAP) {
        record.timeout = true;
        record.result = {
          winners: [],
          scores: {},
          summary: `Non-terminating turn: ${PER_TURN_MOVE_CAP} moves in one turn by ${active} (likely AI move loop).`,
        };
        break;
      }
      if (!payload.next_active_player_id) {
        record.error = { code: 'GET_AI_MOVE_NO_NEXT_PLAYER', message: 'Server did not report next active player' };
        break;
      }
      active = payload.next_active_player_id;
      turn += 1;
    }
    if (safety < 0) {
      record.error = { code: 'SAFETY_LIMIT', message: `Exceeded ${HARNESS_SAFETY_TURN_LIMIT} turns; aborting` };
    }

    // Capture each player's final view (best-effort — failure does not invalidate the record).
    for (const p of args.players) {
      try {
        const view = await this.callTool('get_state', {
          session_id: session.session_id,
          player_id: p.player_id,
        });
        record.final_views[p.player_id] = parseToolJson(view);
      } catch {
        // ignore
      }
    }
    return record;
  }

  // ---------- internals ----------

  // Fetch the current public scoreboard via get_state (any player_id — the
  // scoreboard is public). Returns null on any failure or when the game exposes
  // no scoreboard, so the §4 trace simply skips that turn rather than aborting.
  private async fetchScoreboard(
    sessionId: string,
    playerId: string,
  ): Promise<Record<string, Record<string, number>> | null> {
    try {
      const resp = await this.callTool('get_state', { session_id: sessionId, player_id: playerId });
      if (resp.isError) return null;
      const payload = parseToolJson(resp) as { scoreboard?: Record<string, Record<string, number>> } | null;
      const sb = payload?.scoreboard;
      return sb && typeof sb === 'object' ? sb : null;
    } catch {
      return null;
    }
  }

  private async ensureStarted(): Promise<void> {
    if (!this.initialized) await this.start();
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
      } catch {
        // ignore non-JSON lines (shouldn't happen — server writes JSON-RPC to stdout)
      }
    }
  }

  private call(method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method} (${this.callTimeoutMs}ms)`));
      }, this.callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeRaw({ jsonrpc: '2.0', id, method, params });
    });
  }

  private writeRaw(msg: Record<string, unknown>): void {
    if (!this.child) throw new Error('Harness not started');
    this.child.stdin!.write(JSON.stringify(msg) + '\n');
  }

  /** Call a tool by name and return the raw tool response. Public so other
   *  drivers (e.g. the engine-bot integration harness) reuse this transport. */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResponse> {
    await this.ensureStarted();
    const resp = await this.call('tools/call', { name, arguments: args });
    if (resp.error) throw new Error(`MCP error on ${name}: ${resp.error.message}`);
    return (resp.result ?? {}) as ToolResponse;
  }
}

export { parseToolJson, stringifyToolText };
export type { ToolResponse };

// ---------- helpers ----------

interface ToolResponse {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

function stringifyToolText(resp: ToolResponse): string {
  const text = resp.content?.[0]?.text;
  return typeof text === 'string' ? text : JSON.stringify(resp);
}

function parseToolJson(resp: ToolResponse): unknown {
  const text = resp.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
