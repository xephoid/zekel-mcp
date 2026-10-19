import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GameError, type ErrorCode } from '@zekel/game-kit';
import { toGameMetadata, type GameLogEntry, type LogResourceDelta, type PlayerConfig, type ReportVoice, type SessionState } from '@zekel/game-kit';
import { diffScoreboardRow } from '@zekel/game-kit';
import { getGame, listRegisteredGames, type AnyGame } from '../core/registry.js';
import {
  getSession,
  newSessionId,
  saveSession,
  recordUndoSnapshot,
  undoSession,
  undoDepth,
  registerJoinCode,
  isJoinCodeTaken,
  resolveJoinCode,
} from '../core/sessions.js';
import {
  generateJoinCode,
  generateToken,
  hashToken,
  normalizeJoinCode,
  isJoinable,
  isMultiDevice,
  openSeats,
  verifySeatAuth,
  verifyReleaseAuth,
  verifyHostAuth,
} from '../core/joinAuth.js';
import { forgetSessionInAIPlugins, noteAppliedMove, pickAIMove } from '../core/aiPlugins.js';
import { buildNextStep } from './nextStep.js';
import { llmDrivenContext, withClientMode, type ConnectionContext } from './clientMode.js';
import { buildMoveMenu, menuForActivePlayer } from './moveMenu.js';
import { OUTPUT_SCHEMAS } from './outputSchemas.js';
import { snapshotSeats } from './snapshotSeats.js';
import {
  applyMoveInput,
  AI_DIFFICULTIES,
  createSessionInput,
  gameOnlyInput,
  getRulesInput,
  joinSessionInput,
  playerOnlyInput,
  queryChoiceInput,
  sessionOnlyInput,
  setSessionPreferencesInput,
  undoInput,
} from './schemas.js';
import { findSections, renderRulesText } from '@zekel/game-kit';
import { enrichGateRejection, moveTypeOf, unavailableMoves } from '@zekel/game-kit';
import {
  buildRulesBriefing,
  gateLessonSection,
  markTaught,
  teachingEnabled,
} from './teaching.js';

type AnyMove = unknown;

interface ToolErrorPayload {
  error_code: string;
  message: string;
  details?: unknown;
}

function ok(payload: unknown) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

function fail(err: unknown) {
  const payload: ToolErrorPayload =
    err instanceof GameError
      ? err.toJSON()
      : { error_code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

// Teach-on-first-encounter (docs/rules-teaching.md channel 2): compute the
// rules_briefing field for a human seat and record the delivered lesson on the
// session (teach-once). MUTATES session.taughtSections — the store hands back
// live object references, so move tools piggyback the marking on the save they
// already do (pass save=false, call BEFORE that save); read tools (get_state /
// get_legal_moves) pass save=true, the documented exception where delivering a
// lesson writes: teach-once beats read purity, and the write-through store
// makes it cheap.
async function teachFields(
  game: AnyGame,
  session: SessionState<unknown>,
  playerId: string | null | undefined,
  save: boolean,
): Promise<Record<string, unknown>> {
  if (playerId === null || playerId === undefined) return {};
  const built = buildRulesBriefing(game, session, playerId);
  if (!built) return {};
  markTaught(session, playerId, built.taught_ids);
  if (save) await saveSession(session);
  return { rules_briefing: built.briefing };
}

// Codes where the client can recover on its own if we hand it enough context.
const RECOVERABLE_MOVE_ERRORS = new Set<ErrorCode>([
  'ILLEGAL_MOVE',
  'INVALID_MOVE_SHAPE',
  'AI_SEAT_NO_APPLY',
  'AMBIGUOUS_MOVE',
  'NOT_YOUR_TURN',
  'GAME_OVER',
  'NOT_AN_AI_PLAYER',
  'SEAT_AUTH_REQUIRED',
  'INVALID_SEAT_AUTH',
]);

// Move-tool error wrapper that attaches a `recovery` block so a model can fix a
// rejected request in one step instead of guessing again. For a bad move shape
// or illegal move on the player's own turn, it includes your_legal_moves (the
// exact objects to copy) plus a hint; for turn/order mistakes it includes the
// authoritative next_step. Enrichment is best-effort: if anything in here
// throws (e.g. the original error was SESSION_NOT_FOUND), we fall back to the
// plain error rather than masking it.
async function failMove(err: unknown, sessionId: string, playerId: string) {
  const base = fail(err);
  if (!(err instanceof GameError) || !RECOVERABLE_MOVE_ERRORS.has(err.error_code)) {
    return base;
  }
  try {
    const session = await getSession(sessionId);
    const game = getGame(session.gameId);
    const gameOver = game.isGameOver(session);
    const recovery: Record<string, unknown> = { next_step: buildNextStep(session, gameOver, game) };
    const isTheirTurn = session.activePlayerId === playerId;
    const isBadMove =
      err.error_code === 'ILLEGAL_MOVE' ||
      err.error_code === 'INVALID_MOVE_SHAPE' ||
      err.error_code === 'AMBIGUOUS_MOVE';

    if (gameOver !== null) {
      recovery.hint = 'The game is already over. Do not send any more moves; report the result.';
    } else if (err.error_code === 'NOT_YOUR_TURN') {
      recovery.hint =
        'You tried to move for a player whose turn it is not. Do not retry; follow next_step.';
    } else if (err.error_code === 'SEAT_AUTH_REQUIRED' || err.error_code === 'INVALID_SEAT_AUTH') {
      recovery.hint =
        'This session has a remote player, so calls are auth-gated. If you are the HOST, pass the host_token (from create_session) as auth_token — but note you cannot act on the remote player\'s seat at all; if next_step says it is their turn, WAIT for them. If you are the REMOTE player, pass your claim_token (from join_session) as auth_token, and only for your own seat.';
    } else if (err.error_code === 'NOT_AN_AI_PLAYER') {
      recovery.hint =
        'You called get_ai_move for a human player. Only call get_ai_move for AI players; for a human, wait for them to declare a move. Follow next_step.';
    } else if (err.error_code === 'AI_SEAT_NO_APPLY') {
      recovery.hint =
        'You tried to apply_move for an AI seat on its own turn. The server plays AI seats — call run_ai_turn (preferred) or get_ai_move for that seat instead, then relay the returned summaries. Do not apply_move for AI seats. Follow next_step.';
    } else if (isBadMove && isTheirTurn) {
      recovery.your_legal_moves = game.getLegalMoves(session, playerId);
      recovery.hint =
        'Your move was rejected. Pick one entry from your_legal_moves and resend it EXACTLY as the move argument (copy the move object verbatim). Do not retry the rejected move or invent a different shape.';
    } else if (isBadMove && !isTheirTurn) {
      recovery.hint = 'That move was not legal and it is not this player\'s turn. Follow next_step.';
    } else {
      recovery.hint = 'Follow next_step.';
    }

    const payload = { ...err.toJSON(), recovery };
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    };
  } catch {
    return base;
  }
}

// Resolve the apply_move action argument. A model may pass a `move_id` (the id of
// an entry from this player's CURRENT get_legal_moves) instead of constructing the
// move object — the server expands it against the live legal set, so weak models
// never have to build a move shape for an ENUMERABLE action.
//
// Precedence: an explicit `move` WINS over move_id. This is load-bearing. Some
// moves carry values the server cannot enumerate — a human reporting which hidden
// cards they drew (report_refill's drawn_types) — so their get_legal_moves entry
// is only a SKELETON (e.g. drawn_types: []). A model that correctly built the full
// move AND also passed the skeleton's move_id must get its real values, not the
// empty skeleton. (The desync harness caught the inverse: move_id winning silently
// stripped the human's reported draws to [], the refill failed, the model burned
// its retries, and the un-recorded refill drifted the tracked deck for the rest of
// the game.) So: if the caller built a move, trust it; move_id is the shortcut for
// when they did NOT. A missing/unknown id with no move throws a RECOVERABLE
// INVALID_MOVE_SHAPE (failMove attaches your_legal_moves), never a guess.
export function resolveMoveArg(
  game: Pick<ReturnType<typeof getGame>, 'getLegalMoves'>,
  session: SessionState<unknown>,
  playerId: string,
  moveId: string | undefined,
  move: Record<string, unknown> | undefined,
): unknown {
  // Explicit move wins — it may carry values the enumerated skeleton lacks.
  if (move !== undefined && Object.keys(move).length > 0) return move;
  if (moveId !== undefined && moveId !== '') {
    const legal = game.getLegalMoves(session, playerId);
    const hit = legal.find((m) => m.move_id === moveId);
    if (!hit) {
      throw new GameError(
        'INVALID_MOVE_SHAPE',
        `No legal move has move_id "${moveId}" for ${playerId} right now. move_ids are valid only for THIS player's CURRENT get_legal_moves — call it again and pick a move_id from the fresh list (or pass the full move object).`,
      );
    }
    return hit.move;
  }
  throw new GameError(
    'INVALID_MOVE_SHAPE',
    'apply_move needs either a full move object or a move_id from this player\'s current get_legal_moves. You provided neither.',
  );
}

function appendMoveLog(
  state: SessionState<unknown>,
  playerId: string,
  move: unknown,
  summary: string,
  deltas?: { spent: LogResourceDelta[]; gained: LogResourceDelta[] } | null,
): void {
  state.moveLog.push({
    turn: state.turnNumber,
    player_id: playerId,
    move,
    summary,
    timestamp: new Date().toISOString(),
    ...(deltas && deltas.spent.length ? { spent: deltas.spent } : {}),
    ...(deltas && deltas.gained.length ? { gained: deltas.gained } : {}),
  });
}

/** Append a move-log entry, attaching auto-computed resource deltas for games
 *  that expose getScoreboard but do NOT author their own rich log (getLog). This
 *  is the cheap "spent X, gained Y" reporting path that any game gets by
 *  implementing one small accessor. Self-logging games skip it (their getLog
 *  already carries deltas) to avoid double-reporting. */
function appendMoveLogWithDeltas(
  game: AnyGame,
  prior: SessionState<unknown>,
  next: SessionState<unknown>,
  playerId: string,
  move: unknown,
  summary: string,
): void {
  let deltas: { spent: LogResourceDelta[]; gained: LogResourceDelta[] } | null = null;
  if (game.getScoreboard && !game.getLog) {
    deltas = diffScoreboardRow(game.getScoreboard(prior), game.getScoreboard(next), playerId);
  }
  appendMoveLog(next, playerId, move, summary, deltas);
}


// Per-response `report_to_human` strings. BOARD_VOICE is the server default —
// byte-identical to the strings that were inlined here before the ReportVoice
// extraction, locked by mcp/__tests__/reportVoice snapshot assertions and
// scripts/smoke-mcp.mjs. A game whose depth contract differs (e.g. Warble Way
// Galaxy, where apply_move resolves outcomes the solo player can't see and the
// narrator adds color) overrides it per game via Game.reportVoice; the type
// lives in core/game.ts so game modules never import this layer.
export const BOARD_VOICE: ReportVoice = {
  applyMoveConfirm:
    'Confirm the human\'s move briefly — one line restating what they declared and what state_summary says changed. Do NOT recite their hand, the board, the supply, or scores; they can see those.',
  aiMoveFull:
    'REPORT THIS AI MOVE TO THE HUMAN IN FULL: relay state_summary verbatim — every board-changing fact (what was played, rolled, captured, built, moved, bought, drawn or discarded; WHERE each piece/card goes; and any score/resource change) — in plain game terms, nothing omitted and no flavor, so the human can update their physical board. One get_ai_move is ONE move: if next_step still shows this AI is up, keep calling it.',
  runAiTurnNone: 'No AI moves were played this call — follow next_step.',
  runAiTurn: (movesPlayed, gameOverNow) =>
    `REPORT THESE ${movesPlayed} AI MOVE(S) TO THE HUMAN NOW, IN ORDER: for EACH entry in \`moves\`, relay its \`state_summary\` IN FULL and verbatim — every board-changing fact (what moved where; who/what was captured, blasted, built, bought, played, moved, drawn or discarded; and every piece / score / resource change) — in plain game terms, nothing omitted and no flavor added, so the human can update their physical board. Do NOT compress an AI turn into a summary like "the AI took its turn".` +
    (gameOverNow
      ? ' Then report the game result.'
      : ' Then follow next_step: it is a human\'s turn — call get_legal_moves for that player and relay their options.'),
};

// Which report_to_human voice a response uses: the game's own profile when it
// declares one, else the board-game default.
function voiceFor(game: AnyGame): ReportVoice {
  return game.reportVoice ?? BOARD_VOICE;
}

/** The log entries a move produced, for games with a rich log (getLog): the
 *  entries after the last one the state before the move held. A client that
 *  keeps its own log appends them to the event the move made. */
function newLogEntries(game: { getLog?: (s: never) => GameLogEntry[] }, before: unknown, after: unknown): GameLogEntry[] | undefined {
  if (!game.getLog) return undefined;
  const read = game.getLog as (s: unknown) => GameLogEntry[];
  const last = read(before).at(-1)?.seq ?? 0;
  return read(after).filter((e) => e.seq > last);
}

export function registerTools(rawServer: McpServer, ctx: ConnectionContext = llmDrivenContext()): void {
  // Every handler's result is shaped for this connection's declared mode
  // (orchestrated = facts only) — see src/mcp/clientMode.ts.
  const server = withClientMode(rawServer, ctx);
  server.registerTool(
    'list_games',
    {
      description:
        'Returns the catalog of games this server supports. Each game has an id, metadata, and an options_schema for create_session.',
    },
    () => {
      try {
        const games = listRegisteredGames().map(toGameMetadata);
        return ok({ games });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'get_rules',
    {
      description:
        'Returns the rules text and structured reference data (card catalog, ' +
        'piece definitions, starting positions, constants, etc.) for a ' +
        'specific game. Call this when the human asks a rules question, when ' +
        'you need to know what a specific card does, or any time you would ' +
        'otherwise be tempted to speculate about how the game works. The ' +
        'reference_data field is game-specific JSON — for Fractured Fist it ' +
        'includes every card\'s id, name, cost, value, effects, and ' +
        'description; for other games it may include different structures. ' +
        'Games with sectioned rules also return a rules_sections index; pass ' +
        'topic (a section id or title) to fetch just the governing section.',
      inputSchema: getRulesInput,
    },
    (args) => {
      try {
        const game = getGame(args.game_id);
        // Sectioned rules (docs/rules-teaching.md): the sections are the source;
        // the blob derives from them (games use renderRulesText in getRulesText).
        // With a topic, return just the matching section(s); on no match, say so
        // and include the index — never guess, never fail the call.
        const sections = game.getRulesSections?.() ?? [];
        let rules: string;
        if (args.topic !== undefined && sections.length > 0) {
          const matched = findSections(sections, args.topic);
          rules = matched.length
            ? renderRulesText(matched)
            : `No rules section matches topic "${args.topic}". Pick an id from rules_sections.`;
        } else {
          rules =
            game.getRulesText?.() ??
            (sections.length ? renderRulesText(sections) : `No rules text available for ${game.id}.`);
        }
        const referenceData = game.getReferenceData?.();
        // The static catalog of every move SHAPE this game accepts (the universe
        // of action types + their fields). This is the action reference a player
        // has — NOT the legal-now set (that is get_legal_moves). A client builds
        // apply_move payloads from this; the move param is otherwise an opaque
        // record, so without it the shapes are only discoverable from prose.
        const moveSchema = game.moveSchema;
        // Balance axes (setup/config choices a balance pass must vary) — surfaced
        // so the harness can report coverage. Empty/absent for games that haven't
        // declared them.
        const balanceAxes = game.getBalanceAxes?.() ?? [];
        return ok({
          game_id: args.game_id,
          rules,
          ...(sections.length
            ? { rules_sections: sections.map((s) => ({ id: s.id, title: s.title })) }
            : {}),
          ...(referenceData !== undefined ? { reference_data: referenceData } : {}),
          ...(moveSchema !== undefined ? { move_schema: moveSchema } : {}),
          ...(balanceAxes.length ? { balance_axes: balanceAxes } : {}),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'create_session',
    {
      description:
        'Starts a new game session. The response includes a session_id, the ' +
        'initial active player, AND an agent_guidance field containing ' +
        'per-game persona and setup instructions. ALWAYS read agent_guidance ' +
        'before doing anything else — it tells you how to talk to the player ' +
        'and what assumptions the game makes about their setup (e.g. that ' +
        'they have a physical copy of the game). Options are validated ' +
        'against the chosen game\'s options_schema. ' +
        // A copyable example beats field-by-field construction for weak models
        // (the move_id principle, applied to the one call made before any
        // session exists to enumerate from).
        'Example — one human vs one AI: {"game_id":"dragonwood","players":' +
        '[{"player_id":"p1","kind":"human","name":"Zeke"},' +
        '{"player_id":"p2","kind":"ai","difficulty":"medium"}]}. ' +
        'The person at the table is kind:"human" (never "ai"); only ' +
        'server-played opponents are kind:"ai".',
      inputSchema: createSessionInput,
      outputSchema: OUTPUT_SCHEMAS.tools.create_session,
    },
    async (args) => {
      try {
        const game = getGame(args.game_id);
        // Normalize the loosened seat fields (see schemas.ts: they are plain
        // strings so imperfect calls reach THIS code instead of dying on a
        // client-side schema check with an unactionable one-liner). Tolerant in
        // what it accepts (case/whitespace; "" = unset; difficulty on a human
        // seat dropped); specific in what it rejects (names the accepted forms).
        const players = args.players.map((p) => {
          const kind = p.kind.trim().toLowerCase();
          if (kind !== 'human' && kind !== 'ai') {
            throw new GameError(
              'INVALID_PLAYERS',
              `Seat "${p.player_id}" has kind "${p.kind}" — use "human" for a person at the table or "ai" for a server-played opponent.`,
            );
          }
          let difficulty = p.difficulty?.trim().toLowerCase();
          if (difficulty === '') difficulty = undefined; // "" = unset, not an error
          if (kind === 'human') difficulty = undefined; // meaningless on a human seat
          if (difficulty !== undefined && !(AI_DIFFICULTIES as readonly string[]).includes(difficulty)) {
            throw new GameError(
              'INVALID_PLAYERS',
              `Seat "${p.player_id}" has difficulty "${p.difficulty}" — use easy, medium, hard, mcts, random ` +
                '(random legal moves), or hyperon (external brain), or omit it and the server applies a default ladder.',
            );
          }
          let table = p.table?.trim().toLowerCase();
          if (table === '') table = undefined; // "" = unset, not an error
          if (kind === 'ai') table = undefined; // ignored on AI seats (always digital)
          if (table !== undefined && table !== 'physical' && table !== 'digital') {
            throw new GameError(
              'INVALID_PLAYERS',
              `Seat "${p.player_id}" has table "${p.table}" — use "physical" (default) or "digital" (server holds this seat's hidden state).`,
            );
          }
          return { ...p, kind, difficulty, table } as typeof p & { kind: 'human' | 'ai'; difficulty?: PlayerConfig['difficulty']; table?: PlayerConfig['table'] };
        });
        if (players.length < game.minPlayers || players.length > game.maxPlayers) {
          throw new GameError(
            'INVALID_PLAYERS',
            `Game ${game.id} requires between ${game.minPlayers} and ${game.maxPlayers} players; got ${players.length}`,
          );
        }
        // Reject duplicate player_ids up front. Two seats sharing an id makes
        // activePlayerId ambiguous and corrupts every later move/state lookup —
        // a setup mistake that otherwise surfaces as baffling behavior many
        // moves later. Fail loudly at create time instead.
        const ids = players.map((p) => p.player_id);
        const duplicateId = ids.find((id, i) => ids.indexOf(id) !== i);
        if (duplicateId !== undefined) {
          throw new GameError(
            'INVALID_PLAYERS',
            `Duplicate player_id "${duplicateId}"; every player needs a unique player_id`,
          );
        }
        // Default difficulty ladder: AI players that don't specify a difficulty
        // descend by add-order — the 1st AI gets the strongest tier, then down,
        // cycling: mcts → hard → medium → easy → mcts → … An explicit per-player
        // difficulty always wins. The rung is positional (an overriding player
        // still consumes its slot), so the ladder stays stable. Game-agnostic:
        // games that don't implement a tier fall back to their own default in
        // getAIMove (e.g. mcts → medium), and agent-hunter ignores difficulty.
        const DIFFICULTY_LADDER = ['mcts', 'hard', 'medium', 'easy'] as const;
        let aiSeatIndex = 0;
        const playersWithDefaults = players.map((p) => {
          // `teaching` is a session preference (seeded onto seatPreferences
          // below), not a seat property — keep it off PlayerConfig.
          const { teaching: _teaching, ...seat } = p;
          if (seat.kind !== 'ai') return seat;
          const rung = DIFFICULTY_LADDER[aiSeatIndex % DIFFICULTY_LADDER.length]!;
          aiSeatIndex += 1;
          return seat.difficulty === undefined ? { ...seat, difficulty: rung } : seat;
        });
        const session = game.createSession(playersWithDefaults as PlayerConfig[], args.options ?? {});
        session.sessionId = newSessionId();
        // Seed per-seat teaching preferences from the creation input (rules
        // teaching, docs/rules-teaching.md) BEFORE the first lesson is computed.
        for (const p of players) {
          if (p.teaching !== undefined) {
            (session.seatPreferences ??= {})[p.player_id] = { teaching: p.teaching };
          }
        }

        // Multi-device join: enable it whenever there is more than one human seat
        // — i.e. at least one seat a SECOND human could claim from another device.
        // The host (creating device) keeps one seat and drives the whole game
        // except on a remote player's own turn. A 4-char code + a host_token are
        // issued; no auth is enforced until someone actually joins, so solo-vs-AI
        // and hot-seat play stay exactly as before.
        const humanSeats = session.players.filter((p) => p.kind === 'human');
        let joinInfo:
          | { join_code: string; host_player_id: string; host_token: string; open_seats: string[] }
          | undefined;
        if (humanSeats.length >= 2) {
          let hostPlayerId = humanSeats[0]!.player_id;
          if (args.host_player_id !== undefined) {
            const hostSeat = session.players.find((p) => p.player_id === args.host_player_id);
            if (!hostSeat || hostSeat.kind !== 'human') {
              throw new GameError(
                'INVALID_PLAYERS',
                `host_player_id "${args.host_player_id}" must be one of this session's human seats`,
              );
            }
            hostPlayerId = args.host_player_id;
          }
          const hostToken = generateToken();
          const joinCode = generateJoinCode(isJoinCodeTaken);
          session.hostPlayerId = hostPlayerId;
          session.hostTokenHash = hashToken(hostToken);
          session.joinCode = joinCode;
          registerJoinCode(joinCode, session.sessionId);
          joinInfo = {
            join_code: joinCode,
            host_player_id: hostPlayerId,
            host_token: hostToken,
            open_seats: openSeats(session),
          };
        }

        // First lesson (rules teaching channel 2): whatever sections govern the
        // opening state (setup phase / the first offered moves) teach on the
        // session's very first response. Marked before the save below.
        const teach = await teachFields(game, session, session.activePlayerId, false);
        await saveSession(session);
        // Embed session-start guidance directly in the response so the agent
        // doesn't have to fetch a separate resource to learn the game's
        // persona/setup expectations. Critical for agents that aren't great
        // at proactively reading resources.
        // Pass the table mode through only when the session includes a digital
        // human (docs/digital-mode.md): existing games ignore the argument and
        // see no change; digital-savvy games adjust their physical-first prose.
        const anyDigitalHuman = session.players.some((p) => p.kind === 'human' && p.table === 'digital');
        const guidance = game.getSessionStartGuidance?.(anyDigitalHuman ? 'digital' : 'physical');
        // Echo back the config the server actually recorded so a misconfigured
        // session (wrong kinds, missing human seat, swapped ids) is caught
        // immediately rather than 10 moves later.
        const players_recorded = session.players.map((p) => ({
          player_id: p.player_id,
          kind: p.kind,
          // Table mode: echoed only when set; absent = physical default.
          // Ignored for AI seats (always digital) and not echoed there.
          ...(p.kind === 'human' && p.table !== undefined ? { table: p.table } : {}),
          ...(p.name !== undefined ? { name: p.name } : {}),
          ...(p.difficulty !== undefined ? { difficulty: p.difficulty } : {}),
          ...(p.strategy !== undefined ? { strategy: p.strategy } : {}),
        }));
        // Phase-aware directive: for games with a post-creation setup handshake
        // this names the exact first move (e.g. setup_card_drawn) instead of
        // leaving the model to infer it from the guidance prose.
        const next_step = buildNextStep(session, game.isGameOver(session), game);
        // Explicit, ordered setup to-do list. Empty for games that are
        // immediately playable after creation.
        const setup_checklist = game.getSetupChecklist?.(session) ?? [];
        // The physical setup as ordered steps (every mode): one action per
        // step, with report steps pointing at their setup_checklist entry.
        const physical_setup = game.getPhysicalSetup?.(session) ?? [];
        // Orchestrated connections get persona + rules context without loop
        // directions (agent_guidance is dropped for them in clientMode.ts);
        // llm_driven connections keep agent_guidance exactly as before.
        const session_context =
          ctx.mode === 'orchestrated' ? game.getSessionContext?.(anyDigitalHuman ? 'digital' : 'physical') : undefined;
        // Backstop for "ask each human their name": flag human seats created
        // without a real name (missing, or a bare player_id placeholder) so the
        // model collects it. The session is brand new (no moves), so re-creating
        // with names is cheap; at minimum the model should address them by name.
        const unnamedHumans = session.players
          .filter(
            (p) =>
              p.kind === 'human' &&
              (p.name === undefined || p.name.trim() === '' || p.name === p.player_id),
          )
          .map((p) => p.player_id);
        // Backstop for "ask the human the AI difficulty": flag AI seats created
        // with no explicit difficulty (the server then applied a positional
        // default the human didn't choose). Read the RAW input, before defaults.
        const aiSeatsNeedingDifficulty = players
          .filter((p) => p.kind === 'ai' && p.difficulty === undefined)
          .map((p) => p.player_id);
        return ok({
          session_id: session.sessionId,
          game_id: session.gameId,
          active_player_id: session.activePlayerId,
          players_recorded,
          initial_state_uri: `game://${session.gameId}/sessions/${session.sessionId}/player/${session.activePlayerId}`,
          next_step,
          ...(setup_checklist.length > 0 ? { setup_checklist } : {}),
          ...(physical_setup.length > 0 ? { physical_setup } : {}),
          ...(session_context ? { session_context } : {}),
          ...(unnamedHumans.length
            ? {
                naming_reminder:
                  `Human seat(s) ${unnamedHumans.join(', ')} have no name. Ask each human their name and ` +
                  'address them by it from now on. No moves have been made yet, so prefer re-creating the ' +
                  'session with each human\'s `name` set (so the server also refers to them by name). Do ' +
                  'NOT invent names — for humans ask, and leave AI seats unnamed (their game identity is their name).',
              }
            : {}),
          // Backstop for the observed weak-model mistake of marking EVERY seat
          // kind:"ai" (including the human's). All-AI sessions stay legal — the
          // harness creates them on purpose — so this is a warning, not a
          // rejection: only a client relaying for a real human will act on it.
          ...(humanSeats.length === 0
            ? {
                all_ai_reminder:
                  'Every seat in this session is kind:"ai", so the server will play ALL of them. If a human ' +
                  'is at the table, this is a misconfiguration — re-create the session with their seat set to ' +
                  'kind:"human" (no moves have been made yet). If an all-AI game was intended, ignore this.',
              }
            : {}),
          ...(aiSeatsNeedingDifficulty.length
            ? {
                difficulty_reminder:
                  `AI seat(s) ${aiSeatsNeedingDifficulty.join(', ')} were created with no chosen difficulty, so ` +
                  'the server applied a default (see players_recorded for the resolved level). Ask the human how ' +
                  'challenging they want each AI opponent — easy, medium, hard, or mcts (strongest) — and if they ' +
                  'want anything other than the default, re-create the session with each AI\'s `difficulty` set ' +
                  '(no moves have been made yet).',
              }
            : {}),
          ...teach,
          ...(joinInfo
            ? {
                join: {
                  ...joinInfo,
                  instructions:
                    `This game has ${joinInfo.open_seats.length} open seat(s) a second human can join from another device. ` +
                    `Give the other player the join_code "${joinInfo.join_code}" to enter in join_session (only works while the game is still in setup). ` +
                    'KEEP host_token PRIVATE and pass it as auth_token on every one of YOUR calls from now on (it is ignored until someone joins, then it is required). ' +
                    'Once a player joins, you (the host) drive the whole game EXCEPT on that player\'s own turn — when next_step says it is their turn, WAIT for them to play on their device, then continue. ' +
                    'YOU ARE NOT THE ONLY DEVICE TALKING TO THIS SESSION: once joined, the remote player applies their own moves directly to the shared session from their device, on their own schedule, without you doing anything. Do not assume the state you last saw still holds — every time your human comes back to you (even just to ask a question), call get_state first and read its next_step fresh rather than reusing what you last remember; the remote player may already have moved. ' +
                    'If no one joins, just play normally (hot-seat) — the open seats stay playable by you.',
                },
              }
            : {}),
          ...(guidance ? { agent_guidance: guidance } : {}),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'join_session',
    {
      description:
        'Joins an in-progress game from a SECOND device using the 4-character ' +
        'join_code the host was shown in create_session. Use this when a ' +
        'different human wants to take an open seat so they can report their own ' +
        'secret information (drawn cards, etc.) WITHOUT the host seeing it. Only ' +
        'works while the game is still in setup (before real play has begun) and ' +
        'an unclaimed human seat remains; otherwise returns SESSION_NOT_JOINABLE ' +
        'or NO_OPEN_SEAT. The server auto-assigns the next open seat and returns ' +
        'its player_id plus a claim_token. KEEP the claim_token PRIVATE and pass ' +
        'it as auth_token on every later call for your seat — it is what keeps ' +
        'your seat (and your hidden information) yours alone. From now on, only ' +
        'act on YOUR seat; the host drives the rest of the game.',
      inputSchema: joinSessionInput,
    },
    async (args) => {
      try {
        const code = normalizeJoinCode(args.join_code);
        const sessionId = resolveJoinCode(code);
        if (!sessionId) {
          throw new GameError(
            'JOIN_CODE_NOT_FOUND',
            `No joinable session has code "${code}". Check the code with the host (it is shown in their create_session response), or the game may have already started.`,
          );
        }
        const session = await getSession(sessionId);
        const game = getGame(session.gameId);
        if (!isJoinable(session, game)) {
          throw new GameError(
            'SESSION_NOT_JOINABLE',
            'This game is no longer in setup — real play has begun, so new players can no longer join.',
          );
        }
        const open = openSeats(session);
        const seatId = open[0];
        if (seatId === undefined) {
          throw new GameError(
            'NO_OPEN_SEAT',
            'Every open human seat in this game has already been claimed.',
          );
        }
        const claimToken = generateToken();
        const claimedAt = new Date().toISOString();
        session.seatClaims = {
          ...(session.seatClaims ?? {}),
          [seatId]: {
            tokenHash: hashToken(claimToken),
            ...(args.name !== undefined ? { name: args.name } : {}),
            claimedAt,
          },
        };
        // Mirror the joiner's name onto the seat so reports can address them.
        if (args.name !== undefined) {
          const seat = session.players.find((p) => p.player_id === seatId);
          if (seat) seat.name = args.name;
        }
        await saveSession(session);
        const next_step = buildNextStep(session, game.isGameOver(session), game);
        return ok({
          session_id: session.sessionId,
          game_id: session.gameId,
          player_id: seatId,
          claim_token: claimToken,
          next_step,
          instructions:
            `You have joined as seat ${seatId}. Pass claim_token as auth_token on EVERY call for this ` +
            'seat (get_legal_moves, get_state, apply_move). It is yours alone — keep it private; the ' +
            'host cannot see your hidden information or act for you. Watch next_step: when it is your ' +
            'turn, play your move; otherwise the host is running the game (AI turns and their own ' +
            'moves) and you simply wait until next_step says it is your turn again. ' +
            'YOU ARE NOT THE ONLY DEVICE TALKING TO THIS SESSION: the host\'s device applies AI turns ' +
            'and its own moves directly to the shared session on its own schedule, without you doing ' +
            'anything and without you seeing it happen live. Do not assume the state or next_step you ' +
            'last saw still holds — every time your human comes back to you, call get_state first and ' +
            'read its next_step fresh rather than reusing what you last remember, since several turns ' +
            'may have already happened on the host\'s side.',
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'release_seat',
    {
      description:
        'Releases a claimed (remote) seat so it becomes open again — the fix for ' +
        'a remote player who left or got disconnected, so the game does not soft-' +
        'lock on their seat. Authorized by EITHER that seat\'s claim_token (the ' +
        'remote player bowing out) OR the host_token (the host reclaiming an ' +
        'abandoned seat). Afterwards the seat is host-driveable again (hot-seat), ' +
        'and can be re-joined with join_session while the game is still in setup; ' +
        'if it was the last remote seat, the session drops back to single-device ' +
        '(no auth required). NOTE: if the host reclaims a seat whose hidden hand ' +
        'the server was tracking (a shared-deck game), the host will now be able ' +
        'to see it — unavoidable if they are to keep playing that seat; tell the ' +
        'human. Returns SEAT_NOT_CLAIMED if the seat has no remote owner.',
      inputSchema: playerOnlyInput,
    },
    async (args) => {
      try {
        const session = await getSession(args.session_id);
        const game = getGame(session.gameId);
        if (session.seatClaims?.[args.player_id] === undefined) {
          throw new GameError(
            'SEAT_NOT_CLAIMED',
            `Seat ${args.player_id} is not held by a remote player, so there is nothing to release.`,
          );
        }
        verifyReleaseAuth(session, args.player_id, args.auth_token);
        const remaining = { ...session.seatClaims };
        delete remaining[args.player_id];
        session.seatClaims = remaining;
        await saveSession(session);
        const next_step = buildNextStep(session, game.isGameOver(session), game);
        const stillMultiDevice = isMultiDevice(session);
        return ok({
          session_id: session.sessionId,
          released_player_id: args.player_id,
          // Once false, no auth_token is required on any seat again until someone
          // re-joins — the session is back to solo/hot-seat.
          multi_device: stillMultiDevice,
          next_step,
          report_to_human:
            `Seat ${args.player_id} is now open. ` +
            (stillMultiDevice
              ? 'Other remote seats are still active, so keep using auth_token as before. '
              : 'No remote players remain; you can play all seats yourself again (no auth_token needed). ') +
            'While the game is still in setup, another device can join_session to take this seat; otherwise you (the host) now play it.',
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'reassign_seat',
    {
      description:
        'Rotates a claimed seat\'s claim_token and returns a fresh one — the path ' +
        'for a remote player RECONNECTING on a new device (their old token is ' +
        'gone) or HANDING the seat to a different person. Unlike join_session this ' +
        'works at ANY time, including mid-game, because reconnection must. ' +
        'Authorized by the host_token (the host vouches for the reconnecting ' +
        'player) OR the seat\'s current claim_token (rotating a compromised ' +
        'token). The OLD claim_token stops working immediately; relay the new ' +
        'claim_token to the device that will now play the seat. The seat stays ' +
        'claimed (still locked to its token; the host still cannot act on it). ' +
        'Returns SEAT_NOT_CLAIMED if the seat has no remote owner (use ' +
        'join_session to claim an open seat instead).',
      inputSchema: playerOnlyInput,
    },
    async (args) => {
      try {
        const session = await getSession(args.session_id);
        const game = getGame(session.gameId);
        const existing = session.seatClaims?.[args.player_id];
        if (existing === undefined) {
          throw new GameError(
            'SEAT_NOT_CLAIMED',
            `Seat ${args.player_id} is not held by a remote player; nothing to reassign. To claim an open seat during setup, use join_session.`,
          );
        }
        verifyReleaseAuth(session, args.player_id, args.auth_token);
        const claimToken = generateToken();
        session.seatClaims = {
          ...session.seatClaims,
          [args.player_id]: {
            ...existing,
            tokenHash: hashToken(claimToken),
            claimedAt: new Date().toISOString(),
          },
        };
        await saveSession(session);
        const next_step = buildNextStep(session, game.isGameOver(session), game);
        return ok({
          session_id: session.sessionId,
          player_id: args.player_id,
          claim_token: claimToken,
          next_step,
          instructions:
            `Seat ${args.player_id} has a NEW claim_token; the previous one no longer works. ` +
            'Give this claim_token to the device that will play the seat — it passes the token as ' +
            'auth_token on every call for this seat. Keep it private; the host still cannot act on this seat.',
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'query_choice',
    {
      description:
        'Asks a game a read-only question about a decision this seat is composing (for example, where its next collector may go given the ones already chosen). Nothing is applied. Games that answer no questions, unknown questions, and questions the seat is not in a position to ask return an error.',
      inputSchema: queryChoiceInput,
    },
    async (args) => {
      try {
        const session = await getSession(args.session_id);
        const game = getGame(session.gameId);
        verifySeatAuth(session, args.player_id, args.auth_token);
        if (!game.queryChoice) throw new GameError('ILLEGAL_MOVE', `${game.name} answers no queries`);
        const answer = game.queryChoice(session, args.player_id, args.name, args.args ?? {});
        return ok({ session_id: session.sessionId, player_id: args.player_id, name: args.name, answer });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'get_legal_moves',
    {
      description:
        'Lists the legal moves available to a specific player in a session. Includes is_their_turn so clients can distinguish "no moves available" from "not their turn".',
      inputSchema: playerOnlyInput,
      outputSchema: OUTPUT_SCHEMAS.tools.get_legal_moves,
    },
    async (args) => {
      try {
        const session = await getSession(args.session_id);
        const game = getGame(session.gameId);
        verifySeatAuth(session, args.player_id, args.auth_token);
        const moves = game.getLegalMoves(session, args.player_id);
        const isTheirTurn = session.activePlayerId === args.player_id;
        const seat = session.players.find((p) => p.player_id === args.player_id);
        // Typing-friendly numbered menu for a human who is actually on the clock.
        // AI seats and off-turn queries get no menu (nothing for a human to pick).
        const move_menu =
          isTheirTurn && seat?.kind === 'human'
            ? (buildMoveMenu(session, moves, game) ?? undefined)
            : undefined;
        // Ambient grey list (docs/rules-teaching.md): move TYPES this seat
        // could have but currently can't, each with the live gate reason
        // ("needs Strength 2, yours is 1"). A desync guard, not pedagogy — it
        // closes the vacuum a model otherwise fills with invented rules when
        // the human asks "why can't I X?". Same gating as move_menu: only a
        // human actually on the clock.
        const grey =
          isTheirTurn && seat?.kind === 'human' && game.describeMoveGates
            ? unavailableMoves(game.describeMoveGates(session, args.player_id), moves)
            : [];
        // Channel 2 on a read tool: delivering a lesson marks it taught, which
        // writes (the documented teach-once exception — see teachFields).
        const teach =
          isTheirTurn && seat?.kind === 'human'
            ? await teachFields(game, session, args.player_id, true)
            : {};
        return ok({
          session_id: session.sessionId,
          player_id: args.player_id,
          is_their_turn: isTheirTurn,
          legal_moves: moves,
          must_move: moves.length > 0 && isTheirTurn,
          ...(move_menu ? { move_menu } : {}),
          ...(grey.length
            ? {
                unavailable_moves: grey,
                unavailable_note:
                  'These move types exist in this game but are NOT possible right now, for the stated reason. If the human asks to do one (or asks why they can\'t), answer with its reason — do NOT invent a rule or substitute a different move.',
              }
            : {}),
          ...teach,
          how_to_apply:
            'To make one of these, call apply_move with this player_id and the chosen entry\'s move_id (the server expands it — you do NOT build a move object). Pick the entry whose description matches the intended action. IMPORTANT: if the chosen move needs a value the human just told you that is NOT already in its `move` (e.g. which hidden cards they drew for a refill — its drawn_types is an empty skeleton), do NOT use move_id; pass the full `move` object with those values filled in instead.',
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'apply_move',
    {
      description:
        'Applies a move on behalf of a player. Specify the action EITHER by move_id (the id of an entry from this player\'s current get_legal_moves — the server expands it, so you never build a move shape; best for enumerable actions) OR by move (the full structured object — REQUIRED for moves carrying values not enumerable in get_legal_moves, e.g. a human\'s reported hidden draw). If both are given the full move wins. Returns ILLEGAL_MOVE, NOT_YOUR_TURN, AMBIGUOUS_MOVE, or INVALID_MOVE_SHAPE on errors.',
      inputSchema: applyMoveInput,
      outputSchema: OUTPUT_SCHEMAS.tools.apply_move,
    },
    async (args) => {
      try {
        const session = await getSession(args.session_id);
        const game = getGame(session.gameId);
        // Multi-device auth: a claimed (remote) seat needs its claim_token; every
        // other seat needs the host_token. No-op for single-device sessions.
        verifySeatAuth(session, args.player_id, args.auth_token);
        // Guard: never let a client hand-apply a NORMAL AI turn. AI seats are
        // driven by run_ai_turn / get_ai_move (the server computes the move). A
        // weak model that keeps calling apply_move after the human's move races
        // the tracked board ahead by playing the AI's whole turn itself — a silent
        // desync the desync-harness surfaced (it recorded p1's report, then drove
        // an AI seat's lead/declare/prelude/influence). We still ALLOW applying for
        // an AI seat when a HUMAN is owed a report routed to that seat (e.g. a
        // Ransack Court refill keyed to the AI attacker's for_player_id): there the
        // game's describeNextStep flips the directive to human_to_move, so we block
        // ONLY when the directive for the current state is ai_to_move.
        const seat = session.players.find((p) => p.player_id === args.player_id);
        // Harness escape (relay-fidelity harness only, docs/relay-harness-runbook.md):
        // relayBot must apply RECONSTRUCTED AI moves to its shadow session — the
        // moves a human would physically execute from the assistant's relay — which
        // is exactly the action this guard blocks for real clients. The harness
        // sets the env var on the server IT spawns; production servers never do.
        const harnessAiApply = process.env.ZEKEL_HARNESS_AI_APPLY === '1';
        if (!harnessAiApply && seat?.kind === 'ai' && buildNextStep(session, game.isGameOver(session), game).status === 'ai_to_move') {
          throw new GameError(
            'AI_SEAT_NO_APPLY',
            `${args.player_id} is an AI seat and it is an AI turn — do not apply_move for AI seats. ` +
              `Call run_ai_turn for ${args.player_id} (it plays the whole AI turn and hands back summaries to relay), ` +
              `or get_ai_move; the server computes and applies AI moves itself.`,
          );
        }
        // Resolve move_id → full move against the CURRENT legal set (so the model
        // can pick an enumerated option by id instead of constructing a shape).
        // move_id wins if both are given; an unknown id fails cleanly (recoverable
        // INVALID_MOVE_SHAPE with your_legal_moves) rather than guessing.
        const move = resolveMoveArg(game, session, args.player_id, args.move_id, args.move);
        let result;
        try {
          result = game.applyMove(session, args.player_id, move as AnyMove);
        } catch (engineErr) {
          // Gate-aware rejection (docs/rules-teaching.md): if the game declares
          // a gate for this move type and it's currently blocked, the rejection
          // carries the live reason — the rule speaks instead of leaving a
          // vacuum for the model to fill from training memory.
          const gates = game.describeMoveGates?.(session, args.player_id);
          let err = enrichGateRejection(engineErr, gates, move);
          // Channel 3 — full lesson on demonstrated intent: a rejection on a
          // failed gate is the one moment the server can SEE the player wanted
          // the blocked move, so the complete rules section rides the error
          // (inlined every time; MARKED teach-once). applyMove threw, so the
          // session is unchanged and saving the marking here is safe.
          const blockedType = moveTypeOf(move);
          const gate = blockedType
            ? gates?.find((g) => g.move_type === blockedType && g.status !== 'available')
            : undefined;
          const lesson = gateLessonSection(game, gate?.rules_section);
          if (err instanceof GameError && lesson && teachingEnabled(session, args.player_id)) {
            const baseDetails =
              err.details !== null && typeof err.details === 'object'
                ? (err.details as Record<string, unknown>)
                : {};
            err = new GameError(err.error_code, err.message, {
              ...baseDetails,
              rules_briefing: {
                for_player: args.player_id,
                sections: [{ id: lesson.id, title: lesson.title, text: lesson.text }],
                teach_note:
                  'The human just tried this blocked move — relay the rejection reason, then explain this rule plainly (this is the moment it sticks).',
              },
            });
            if (!(session.taughtSections?.[args.player_id] ?? []).includes(lesson.id)) {
              markTaught(session, args.player_id, [lesson.id]);
              await saveSession(session);
            }
          }
          throw err;
        }
        appendMoveLogWithDeltas(game, session, result.newState, args.player_id, move, result.summary);
        await noteAppliedMove(game, session, result.newState, args.player_id, move);
        await recordUndoSnapshot(session); // pre-move snapshot so this move can be undone
        // Channel 2 for whoever is on the clock AFTER this move — marked on
        // newState before the save below so the lesson persists with it.
        const teach = await teachFields(game, result.newState, result.newState.activePlayerId, false);
        await saveSession(result.newState);
        const gameOver = game.isGameOver(result.newState);
        const next_step = buildNextStep(result.newState, gameOver, game);
        // If the next player to act is a human, offer their move menu now so the
        // client can present numbered options without a separate get_legal_moves.
        const move_menu = menuForActivePlayer(game, result.newState, next_step, args.auth_token);
        // Information revealed privately to THIS caller's seat (a card dealt to
        // their server-tracked hand) — shown on their screen, never spoken.
        // Reveals for any other seat are never returned here.
        const private_reveals = (result.privateReveals ?? []).filter((r) => r.player_id === args.player_id);
        const log_entries = newLogEntries(game, session, result.newState);
        return ok({
          session_id: session.sessionId,
          applied: true,
          state_summary: result.summary,
          ...(log_entries ? { log_entries } : {}),
          ...(private_reveals.length > 0 ? { private_reveals } : {}),
          ...teach,
          // Per-response REPORTING directive (same field the AI-move tools carry, so
          // the model obeys ONE field instead of arbitrating "brief vs full" from the
          // system prompt). Default voice: apply_move is the HUMAN's own declared
          // action — they can see their board — so confirm briefly. A game's own
          // reportVoice overrides (e.g. Warble, where apply_move resolves unseen
          // consequences and must be relayed in full).
          report_to_human: voiceFor(game).applyMoveConfirm,
          next_active_player_id: result.newState.activePlayerId,
          next_step,
          ...(move_menu ? { move_menu } : {}),
          game_over: gameOver !== null,
          ...(gameOver !== null ? { result: gameOver } : {}),
        });
      } catch (e) {
        // A move that arrives in the wrong SHAPE (missing/extra/misnamed fields)
        // often trips an engine field-access before any GameError guard, throwing
        // a bare TypeError that would otherwise surface as INTERNAL_ERROR with NO
        // recovery — exactly when the model most needs to be shown the right
        // shape. Re-cast any non-GameError on the apply_move path as a RECOVERABLE
        // INVALID_MOVE_SHAPE so failMove attaches your_legal_moves + "copy the
        // move object verbatim". The original message is preserved in details for
        // debugging (a genuine engine bug still shows its real cause there). The
        // engine should ALSO guard its own field access (clean GameError at the
        // source) — this is the framework backstop so the class can never again
        // become a guidance-less crash.
        const recoverable =
          e instanceof GameError
            ? e
            : new GameError(
                'INVALID_MOVE_SHAPE',
                `The move could not be applied — its shape is probably wrong (missing or misnamed fields). Copy a move object from get_legal_moves (or your_legal_moves below) EXACTLY. (${e instanceof Error ? e.message : String(e)})`,
                { original: e instanceof Error ? e.message : String(e) },
              );
        return failMove(recoverable, args.session_id, args.player_id);
      }
    },
  );

  server.registerTool(
    'get_ai_move',
    {
      description:
        'Computes and applies a move on behalf of an AI player. The player_id must refer to a player with kind=ai. Returns NOT_YOUR_TURN if it is not currently this player\'s turn.',
      inputSchema: playerOnlyInput,
      outputSchema: OUTPUT_SCHEMAS.tools.get_ai_move,
    },
    async (args) => {
      try {
        const session = await getSession(args.session_id);
        const game = getGame(session.gameId);
        // AI seats are non-claimed, so in a multi-device session this requires the
        // host_token — only the host drives AI play. No-op single-device.
        verifySeatAuth(session, args.player_id, args.auth_token);
        const playerConfig = session.players.find((p) => p.player_id === args.player_id);
        if (!playerConfig) {
          throw new GameError('PLAYER_NOT_FOUND', `No player ${args.player_id} in session`);
        }
        if (playerConfig.kind !== 'ai') {
          throw new GameError('NOT_AN_AI_PLAYER', `Player ${args.player_id} is not an AI`);
        }
        if (session.activePlayerId !== args.player_id) {
          throw new GameError('NOT_YOUR_TURN', `It is ${session.activePlayerId}'s turn`);
        }
        const aiPick = await pickAIMove(game, session, args.player_id, playerConfig);
        const result = game.applyMove(session, args.player_id, aiPick.move);
        appendMoveLogWithDeltas(game, session, result.newState, args.player_id, aiPick.move, result.summary);
        await noteAppliedMove(game, session, result.newState, args.player_id, aiPick.move);
        await recordUndoSnapshot(session); // pre-move snapshot so this AI move can be undone
        await saveSession(result.newState);
        const gameOver = game.isGameOver(result.newState);
        return ok({
          session_id: session.sessionId,
          player_id: args.player_id,
          move_taken: aiPick.move,
          narration: aiPick.narration,
          state_summary: result.summary,
          ...(game.getLog ? { log_entries: newLogEntries(game, session, result.newState) } : {}),
          // Per-response REPORTING directive (same field apply_move / run_ai_turn
          // carry). This is an AI move the human CANNOT see but must execute on the
          // physical board, so report it IN FULL — the opposite depth from a human's
          // own move. The model obeys this field, not a brief-vs-full rule it has to
          // recall and apply correctly from the system prompt.
          report_to_human: voiceFor(game).aiMoveFull,
          next_active_player_id: result.newState.activePlayerId,
          next_step: buildNextStep(result.newState, gameOver, game),
          game_over: gameOver !== null,
          ...(gameOver !== null ? { result: gameOver } : {}),
        });
      } catch (e) {
        return failMove(e, args.session_id, args.player_id);
      }
    },
  );

  server.registerTool(
    'suggest_move',
    {
      description:
        'Returns the move the game AI would play for the named player WITHOUT ' +
        'applying it and WITHOUT requiring kind=ai — a hint/suggestion. Unlike ' +
        'get_ai_move (which applies, and only for AI seats), this is read-only ' +
        'and works for any seat, so an integration test or an assistant can ask ' +
        '"what is a reasonable move here?" then submit it via apply_move. Returns ' +
        'NO_SUGGESTION if the game cannot compute one for this state (e.g. a ' +
        'human-only setup handshake — use get_legal_moves there instead).',
      inputSchema: playerOnlyInput,
    },
    async (args) => {
      try {
        const session = await getSession(args.session_id);
        const game = getGame(session.gameId);
        verifySeatAuth(session, args.player_id, args.auth_token);
        const playerConfig = session.players.find((p) => p.player_id === args.player_id);
        if (!playerConfig) {
          throw new GameError('PLAYER_NOT_FOUND', `No player ${args.player_id} in session`);
        }
        // No kind check and no apply: this only COMPUTES a move. Prefer the
        // game's getSuggestedMove (a directly-APPLYABLE concrete decision — e.g.
        // SW:R returns report_rebel_base / resolve_choice here instead of the
        // opaque ai_step getAIMove hands back) so the harness ground truth plays
        // a representative game; fall back to getAIMove otherwise.
        const suggested = game.getSuggestedMove?.(session, args.player_id);
        const pick =
          suggested && suggested.move != null
            ? { move: suggested.move, narration: undefined as string | undefined }
            : await pickAIMove(game, session, args.player_id, playerConfig);
        if (!pick || pick.move == null) {
          throw new GameError('NO_SUGGESTION', `No move suggestion for ${args.player_id} in this state`);
        }
        return ok({
          session_id: session.sessionId,
          player_id: args.player_id,
          suggested_move: pick.move,
          narration: pick.narration,
        });
      } catch (e) {
        return failMove(e, args.session_id, args.player_id);
      }
    },
  );

  server.registerTool(
    'auto_report',
    {
      description:
        'Integration-test affordance. When the named human is owed a physical ' +
        'REPORT (a draw/roll/reveal) whose valid values depend on the game\'s ' +
        'hidden remaining deck — which is NOT exposed in any view — the server ' +
        'synthesizes a VALID report move from its own tracked state and returns ' +
        'it (without applying). A test harness submits it via apply_move to drive ' +
        'a human seat past reports it cannot know. Returns NO_SUGGESTION when the ' +
        'current pending is not an auto-resolvable report or the game does not ' +
        'support it. NOT for real play — a real human reports what they drew.',
      inputSchema: playerOnlyInput,
    },
    async (args) => {
      try {
        const session = await getSession(args.session_id);
        const game = getGame(session.gameId);
        verifySeatAuth(session, args.player_id, args.auth_token);
        if (!game.autoResolveReport) {
          throw new GameError('NO_SUGGESTION', `${session.gameId} has no report auto-resolver`);
        }
        const r = game.autoResolveReport(session, args.player_id);
        if (!r || r.move == null) {
          throw new GameError('NO_SUGGESTION', `No auto-resolvable report for ${args.player_id} in this state`);
        }
        return ok({ session_id: session.sessionId, player_id: args.player_id, report_move: r.move });
      } catch (e) {
        return failMove(e, args.session_id, args.player_id);
      }
    },
  );

  server.registerTool(
    'run_ai_turn',
    {
      description:
        'Plays the AI forward through its ENTIRE turn — and any following ' +
        'consecutive AI turns — in a single call, then stops the instant a ' +
        'human must act (their turn, or a human-owed report/pending) or the ' +
        'game ends. This is the preferred way to advance AI play: one call ' +
        'instead of many get_ai_move calls, with no risk of stopping early ' +
        'mid-turn. The server computes and applies every AI move itself; do ' +
        'NOT also call apply_move. player_id must be the AI whose turn it is ' +
        'now (NOT_YOUR_TURN otherwise). Returns the ordered list of moves the ' +
        'AI made (with per-move summaries, so you can report faithfully ' +
        'without inventing anything) plus the final next_step. Each move\'s ' +
        '`state_summary` is the CANONICAL string for that move: it carries ' +
        'everything needed to copy the move onto the table and is written to be ' +
        'read aloud as-is; `narration` is optional flavour that never adds a ' +
        'required fact. On a session ' +
        'with digital human seats, each move also carries `player_views`: one ' +
        'snapshot per digital seat, keyed by player_id, of that seat\'s view as ' +
        'it stood after THAT move — play them back one at a time so each person ' +
        'sees each thing happen instead of an avalanche (docs/digital-mode.md). ' +
        'In an all-AI session this plays ' +
        'the whole game to completion in one call.',
      inputSchema: playerOnlyInput,
      outputSchema: OUTPUT_SCHEMAS.tools.run_ai_turn,
    },
    async (args) => {
      try {
        const session = await getSession(args.session_id);
        const game = getGame(session.gameId);
        // Driving AI play targets a non-claimed seat, so multi-device sessions
        // require the host_token here — only the host advances AI turns.
        verifySeatAuth(session, args.player_id, args.auth_token);
        const playerConfig = session.players.find((p) => p.player_id === args.player_id);
        if (!playerConfig) {
          throw new GameError('PLAYER_NOT_FOUND', `No player ${args.player_id} in session`);
        }
        if (playerConfig.kind !== 'ai') {
          throw new GameError('NOT_AN_AI_PLAYER', `Player ${args.player_id} is not an AI`);
        }
        if (session.activePlayerId !== args.player_id) {
          throw new GameError('NOT_YOUR_TURN', `It is ${session.activePlayerId}'s turn`);
        }
        // Loop while the server's own directive says an AI is to move. This
        // naturally spans BOTH the within-turn multi-move sequence (e.g. an
        // Arcs AI leading a card then spending each pip) AND consecutive AI
        // turns, and it stops exactly when describeNextStep flags a human-owed
        // step (e.g. an Arcs Court refill after the AI Secures) or the game
        // ends — the same authoritative signal every other tool uses.
        const MAX_AI_MOVES = 2000; // safety net against a stale-pending loop
        const moves: Array<{
          player_id: string;
          move_taken: unknown;
          narration: string;
          state_summary: string;
          /** One player view per DIGITAL HUMAN seat, keyed by player_id, AS IT
           *  STOOD after this move. Lets a digital client replay an AI turn one
           *  snapshot at a time for every person at the table, instead of one
           *  avalanche of a final state (docs/digital-mode.md). Omitted entirely
           *  on physical sessions. On a multi-device session only the seats the
           *  caller's credential may read are included (snapshotSeats.ts). */
          player_views?: Record<string, unknown>;
        }> = [];
        // Decide once whose views to embed: every digital human seat this
        // caller may read; none on a physical session.
        const snapshotFor = snapshotSeats(session, args.auth_token);
        let current = session;
        let gameOver = game.isGameOver(current);
        let next = buildNextStep(current, gameOver, game);
        while (next.status === 'ai_to_move' && moves.length < MAX_AI_MOVES) {
          const aiId = next.active_player_id!;
          const cfg = current.players.find((p) => p.player_id === aiId);
          const aiPick = await pickAIMove(game, current, aiId, cfg);
          const result = game.applyMove(current, aiId, aiPick.move);
          appendMoveLogWithDeltas(game, current, result.newState, aiId, aiPick.move, result.summary);
          await noteAppliedMove(game, current, result.newState, aiId, aiPick.move);
          const log_entries = newLogEntries(game, current, result.newState);
          current = result.newState;
          moves.push({
            player_id: aiId,
            move_taken: aiPick.move,
            narration: aiPick.narration,
            state_summary: result.summary,
            ...(log_entries ? { log_entries } : {}),
            ...(snapshotFor.length > 0
              ? { player_views: Object.fromEntries(snapshotFor.map((pid) => [pid, game.getPlayerView(current, pid)])) }
              : {}),
          });
          gameOver = game.isGameOver(current);
          next = buildNextStep(current, gameOver, game);
        }
        // One undo reverts the WHOLE AI sequence this call played (back to before it).
        if (moves.length > 0) await recordUndoSnapshot(session);
        // Channel 2 for the human this call stopped for — marked before the save.
        const teach = await teachFields(game, current, current.activePlayerId, false);
        await saveSession(current);
        const hitCap = moves.length >= MAX_AI_MOVES && next.status === 'ai_to_move';
        // Always tell the client to RELAY the AI moves to the human, in full — the
        // human is the AI's hands on the physical board and can't see what the AI
        // did unless the model reports every state_summary. This reminder rides on
        // EVERY run_ai_turn response (game-agnostic) so a weak model never compresses
        // an AI turn into "the AI moved" and strands the human. Mirrors the
        // "REPORT AI MOVES IN FULL" server-wide rule.
        const reportToHuman =
          moves.length === 0
            ? voiceFor(game).runAiTurnNone
            : voiceFor(game).runAiTurn(moves.length, gameOver !== null);
        // run_ai_turn stops the instant a human is owed something, so if it ends
        // on a human's turn, hand back their numbered menu in the same response.
        const move_menu = menuForActivePlayer(game, current, next, args.auth_token);
        return ok({
          session_id: session.sessionId,
          moves_played: moves.length,
          moves,
          report_to_human: reportToHuman,
          next_active_player_id: current.activePlayerId,
          next_step: next,
          ...(move_menu ? { move_menu } : {}),
          ...teach,
          game_over: gameOver !== null,
          ...(gameOver !== null ? { result: gameOver } : {}),
          ...(hitCap
            ? {
                warning:
                  `Stopped after the ${MAX_AI_MOVES}-move safety cap while it was still an ` +
                  `AI's turn — this usually means an AI is stuck on an unresolvable pending ` +
                  `(a bug). Inspect with get_state before continuing.`,
              }
            : {}),
        });
      } catch (e) {
        return failMove(e, args.session_id, args.player_id);
      }
    },
  );

  server.registerTool(
    'undo',
    {
      description:
        'Reverts the human\'s last move AND any AI moves that followed it — in ONE ' +
        'call — restoring the exact prior state. So "I took my turn, then the AI ' +
        'went" undoes as a single unit (you do NOT need a second undo for the AI). ' +
        'Use this whenever a move was made by mistake — most importantly if YOU ' +
        'applied a move the human did not actually choose, or the human says ' +
        '"undo"/"take that back". Call it again to step further back through recent ' +
        'history. (Caveat: a human REPORT made mid-AI-turn — e.g. confirming a Feds ' +
        'catch — is itself a human action, so the sweep stops there; undo again to ' +
        'continue past it. An all-AI run_ai_turn reverts as one batch.) Game-agnostic. ' +
        'Returns reverted=N (how many actions were rolled back) and the restored ' +
        'next_step, or undone=false if there is nothing to undo.',
      inputSchema: undoInput,
    },
    async (args) => {
      try {
        // undo rewinds the shared game, so in a multi-device session it is a
        // host-only action — pass the host_token as auth_token. No-op solo.
        verifyHostAuth(await getSession(args.session_id), args.auth_token);
        const result = await undoSession(args.session_id);
        forgetSessionInAIPlugins(args.session_id); // what an outside AI saw no longer describes the game
        if (!result) {
          // Validate the session exists so an unknown id still errors clearly.
          await getSession(args.session_id);
          return ok({
            session_id: args.session_id,
            undone: false,
            message: 'Nothing to undo — no state-changing move has been recorded for this session.',
          });
        }
        const { restored, reverted } = result;
        const game = getGame(restored.gameId);
        const gameOver = game.isGameOver(restored);
        return ok({
          session_id: args.session_id,
          undone: true,
          actions_reverted: reverted,
          undo_remaining: await undoDepth(args.session_id),
          restored_active_player_id: restored.activePlayerId,
          restored_turn: restored.turnNumber,
          next_step: buildNextStep(restored, gameOver, game),
          game_over: gameOver !== null,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'set_session_preferences',
    {
      description:
        'Sets per-seat session preferences. Currently: `teaching` — rules ' +
        'teaching on/off for one seat (docs: first-encounter rules lessons in ' +
        'responses; default on). Use it the moment a human says they already ' +
        'know the game or wants no rules explanations (teaching=false), or ' +
        'wants lessons back (true). Works any time, before or during the ' +
        'game. NOT a game move: nothing is logged, nothing becomes undoable, ' +
        'and the preference survives undo. The unavailable_moves grey list is ' +
        'NOT affected (it is a board-fidelity guard, not teaching). ' +
        'Multi-device sessions: pass the seat\'s usual auth_token (a claimed ' +
        'seat\'s claim_token, or the host_token for any other seat).',
      inputSchema: setSessionPreferencesInput,
    },
    async (args) => {
      try {
        const session = await getSession(args.session_id);
        verifySeatAuth(session, args.player_id, args.auth_token);
        const seat = session.players.find((p) => p.player_id === args.player_id);
        if (!seat) {
          throw new GameError('PLAYER_NOT_FOUND', `No player ${args.player_id} in session`);
        }
        const prefs = (session.seatPreferences ??= {});
        prefs[args.player_id] = {
          ...prefs[args.player_id],
          ...(args.preferences.teaching !== undefined
            ? { teaching: args.preferences.teaching }
            : {}),
        };
        await saveSession(session);
        return ok({
          session_id: session.sessionId,
          player_id: args.player_id,
          preferences: prefs[args.player_id],
          note: 'Preference recorded. Not a game move — nothing was logged or made undoable.',
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'get_state',
    {
      description:
        'Returns the current game state from a specific player\'s perspective, ' +
        'plus a next_step field telling you authoritatively whose turn it is ' +
        'and what to do next (call get_ai_move, wait for the human, or stop ' +
        'because the game is over). Call this any time you are unsure who is to ' +
        'move or whether an AI turn is finished — re-derive the turn from this, ' +
        'do not rely on memory. Equivalent to reading game://{game_id}/sessions/' +
        '{session_id}/player/{player_id}.',
      inputSchema: playerOnlyInput,
      outputSchema: OUTPUT_SCHEMAS.tools.get_state,
    },
    async (args) => {
      try {
        const session = await getSession(args.session_id);
        const game = getGame(session.gameId);
        // A player view can include that seat's hidden information, so in a
        // multi-device session reading it requires the seat's token (the remote's
        // claim_token for their seat, the host_token for any other). No-op solo.
        verifySeatAuth(session, args.player_id, args.auth_token);
        const view = game.getPlayerView(session, args.player_id);
        const next_step = buildNextStep(session, game.isGameOver(session), game);
        // The replayable history: a game's rich log if it self-logs (getLog),
        // otherwise the generic moveLog (auto-enriched with deltas for games that
        // implement getScoreboard).
        const log = game.getLog ? game.getLog(session) : session.moveLog;
        // Public scalar scoreboard (current standings) for games that expose it.
        // It is PUBLIC data by contract (getScoreboard returns each player's public
        // resources), so it is safe in any player's view, and it gives clients —
        // and the harness's §4 temporal trace — a current leader signal mid-game.
        const scoreboard = game.getScoreboard ? game.getScoreboard(session) : undefined;
        // If a human is on the clock, attach their numbered move menu so the
        // client can re-derive the options without a separate get_legal_moves.
        const move_menu = menuForActivePlayer(game, session, next_step, args.auth_token);
        // Channel 2 on a read tool for the viewing seat (phase-trigger lessons
        // can fire off-turn; the write is the documented teach-once exception).
        const teach = await teachFields(game, session, args.player_id, true);
        // Surface next_step + log at the top level so they are easy to find. Fall
        // back to nesting the view if a game ever returns a non-object view.
        return ok(
          view && typeof view === 'object'
            ? { ...(view as Record<string, unknown>), log, scoreboard, next_step, move_menu, ...teach }
            : { state: view, log, scoreboard, next_step, move_menu, ...teach },
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'is_game_over',
    {
      description:
        'Returns whether the game is over, the winners, scores, and a one-line summary. game_over=false means the game is still in progress.',
      inputSchema: sessionOnlyInput,
    },
    async (args) => {
      try {
        const session = await getSession(args.session_id);
        const game = getGame(session.gameId);
        const result = game.isGameOver(session);
        if (result === null) {
          return ok({ game_over: false });
        }
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
