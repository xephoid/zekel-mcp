import type { ExtraResources, ExtraTool } from './extensions.js';

export interface PlayerConfig {
  player_id: string;
  kind: 'human' | 'ai';
  name?: string;
  difficulty?: 'random' | 'easy' | 'medium' | 'hard' | 'mcts' | 'hyperon';
  /** Where this seat is played. 'physical' (default for humans) = a person at a
   *  real table reports their own hidden state and their own randomness, and the
   *  server is only the bookkeeper. 'digital' = a person deciding over
   *  server-held hidden state (hand/deck tracked by the engine), with
   *  randomness resolved by the server via a no-payload trigger move ("Roll",
   *   "Draw") — never silently. Ignored for AI seats: they are always digital.
   *  Additive/tolerate-absence: existing sessions load unchanged. */
  table?: 'physical' | 'digital';
  /** Strategy axis — a named policy/heuristic profile the AI should pursue (e.g.
   *  'aggro', 'control'), orthogonal to difficulty (skill). Free-form per game;
   *  unrecognized values fall back to the game's default/adaptive play. */
  strategy?: string;
}

/** A signed resource change for the log. `amount` is always positive; whether it
 *  was spent or gained is conveyed by which list it lives in. `resource` is a
 *  free string so every game can use its own resource vocabulary. */
export interface LogResourceDelta {
  resource: string;
  amount: number;
}

/** A rich, human-readable log entry. Shared across games so the MCP layer can
 *  surface a consistent replayable history. Self-logging games (those that author
 *  per-event entries with names, board locations, and phase transitions) expose
 *  these via Game.getLog. Games that only implement Game.getScoreboard get a
 *  lighter auto-delta entry synthesized by the framework on MoveLogEntry instead.
 *  Every summary should use names + board locations, never internal ids. */
export interface GameLogEntry {
  /** 1-based monotonic id, == index+1 within the log array. */
  seq: number;
  /** Game round/turn when emitted (0 during setup). */
  turn: number;
  /** Optional finer phase label (game-defined, e.g. 'action', 'war'). */
  phase?: string;
  /** Player this event is attributed to, or null for table/system events. */
  actor: string | null;
  /** Game-defined category tag (e.g. 'action', 'phase', 'production'). */
  category: string;
  /** Human-readable line: names + board locations, no internal ids. */
  summary: string;
  /** Resources spent (positive amounts), if any. */
  spent?: LogResourceDelta[];
  /** Resources gained (positive amounts), if any. */
  gained?: LogResourceDelta[];
  /** Optional: a short line for a player-facing log, set on the entries that
   *  matter at a glance (a purchase, a death, a treaty, a battle card). Names
   *  and board locations, like summary; summary keeps every detail. */
  headline?: string;
  /** Optional: the seat a headline is about, when it is about one seat. */
  subject?: string;
  /** Optional: the headline as that seat reads it ("Your base at C4 was destroyed!"). */
  subject_headline?: string;
  /** Optional: 'loss' when the line reports something the subject lost. */
  tone?: 'loss';
  /** Optional: the seats that must be told of this entry and acknowledge it
   *  (a death or a destroyed base to its owner, an answer to whoever asked). */
  notify?: string[];
}

export interface MoveLogEntry {
  turn: number;
  player_id: string;
  move: unknown;
  summary: string;
  timestamp: string;
  /** Optional per-move resource deltas, synthesized by the framework from
   *  Game.getScoreboard for games that do not author their own rich log. */
  spent?: LogResourceDelta[];
  gained?: LogResourceDelta[];
}

// Record of a remote human seat that has been claimed via join_session. The
// token is stored ONLY as a hash — the plaintext claim_token is returned to the
// joiner exactly once (at join time) and never persisted, so reading session
// state can never leak it. Presence of any entry in SessionState.seatClaims
// flips the session into "multi-device" mode, where every player-scoped tool
// call must carry the right auth_token (the claimed seat's claim_token, or the
// host_token for every other seat). See src/core/joinAuth.ts.
export interface SeatClaim {
  // sha256(claim_token) — compared against sha256(provided auth_token).
  tokenHash: string;
  // Display name the joiner supplied (optional); mirrored onto the seat's
  // PlayerConfig.name so reports can address them.
  name?: string;
  // ISO timestamp the seat was claimed.
  claimedAt: string;
}

/** Is this seat's hidden state held by the server? True for AI seats (always
 *  tracked) and for human seats configured `table: 'digital'`. False for the
 *  default physical human, whose hand/deck stays opaque to the server.
 *  Games use this wherever they would otherwise branch on `kind` to decide
 *  state ownership (tracked vs opaque) — see docs/digital-mode.md. */
export function isDigitalSeat(p: PlayerConfig): boolean {
  return p.kind === 'ai' || p.table === 'digital';
}

export interface SessionState<State> {
  sessionId: string;
  gameId: string;
  players: PlayerConfig[];
  activePlayerId: string;
  turnNumber: number;
  gameState: State;
  moveLog: MoveLogEntry[];
  createdAt: string;
  // ---- Multi-device join support (all optional / additive — sessions created
  // before this feature simply lack them, so no schema migration is needed) ----
  // The seat the CREATING device plays; it drives the whole game except on a
  // remote player's own turn. Defaults to the first human seat at create time.
  hostPlayerId?: string;
  // sha256 of the host_token handed back to the creating device. Present only
  // when the session has a joinable seat (>= 2 human seats). Required on every
  // non-remote seat's calls once the session is multi-device (a seat is claimed).
  hostTokenHash?: string;
  // The 4-character code a second human enters in join_session to claim an open
  // seat. Present only when the session has a joinable seat. Indexed in-memory
  // by the sessions facade for O(1) lookup.
  joinCode?: string;
  // Remote seats that have been claimed, keyed by player_id. Empty/absent means
  // the session is single-device (no auth enforced — hot-seat stays frictionless).
  seatClaims?: Record<string, SeatClaim>;
  // ---- Rules teaching (docs/rules-teaching.md; optional / additive — no
  // schema bump, older sessions simply lack them) ----
  // Per-seat preferences. teaching defaults ON (absent = on); set at
  // create_session or via set_session_preferences. NOT a game event: never in
  // the move log, and undoSession carries it FORWARD across a restore.
  seatPreferences?: Record<string, { teaching?: boolean }>;
  // Per-seat RuleSection ids already taught (teach-once). A game event's
  // shadow: REVERTS with undo (undoing back into a situation replays its
  // lesson). Marked by the MCP layer when a lesson is delivered.
  taughtSections?: Record<string, string[]>;
}

export interface LegalMove<Move> {
  move_id: string;
  description: string;
  move: Move;
  /**
   * What taking this move spends, in the game's own printed words: "4 AP",
   * "free, once per game", "discard 3 Locations". Additive and optional; a
   * game that has no prices leaves it out.
   *
   * It exists so a client can put the price beside the button without
   * knowing what anything costs. The cost is a rule, and a rule has one
   * home: here. Clients must never parse it out of `description` or infer it.
   */
  cost?: string;
  /**
   * Where taking this move puts a piece, for a game whose moves move pieces
   * across a board: the place it ends and every place it passes on the way,
   * in the game's own location shape (the same one its views use). Additive
   * and optional; a move that moves nothing leaves it out.
   *
   * It exists so a client can outline the destination and slide the piece
   * along its path without knowing how pieces move. Movement is a rule, and a
   * rule has one home: here. Clients must never work a destination out
   * themselves.
   */
  landing?: MoveLanding;
}

/** See LegalMove.landing. */
export interface MoveLanding {
  /** The piece that moves, in the game's own words for it ("knight"). */
  piece: string;
  /** Where the piece is before the move. */
  from: unknown;
  /** Where the movement leaves it, before any action the move then takes. */
  to: unknown;
  /** Every place it passes, in order, ending with `to`. Empty when it cannot move. */
  path: unknown[];
  /** For a move that moves twice: where each movement ends, in order. */
  stops?: unknown[];
}

// The live status of one move TYPE for one seat (docs/rules-teaching.md). The
// negative space of illegal move INSTANCES is unbounded; the catalog of move
// types is finite — gates work at the type level. One declaration is the single
// voice for a rule: the ambient grey list on get_legal_moves, the apply_move
// rejection enrichment, and the teach trigger all render from it, so the reason
// can never drift from the engine the way parallel prose does.
export interface MoveGateStatus {
  /** A moveSchema discriminant (the move's `type`/`action` value). */
  move_type: string;
  /** available = has legal instances now; gated = blocked by a rule worth
   *  teaching (stat/resource/state requirement); routine = phase-bound absence,
   *  listed but with no lesson attached. */
  status: 'available' | 'gated' | 'routine';
  /** Why, rendered against LIVE state ("needs Strength 2, yours is 1") — what
   *  lets the human check the server's belief against the physical table. */
  reason?: string;
  /** Governing RuleSection id — keys the teaching channels. */
  rules_section?: string;
  /** Optional: ONE option of this move type that is blocked (a purchasable by
   *  printed name, a treaty), when other options of the same type may still
   *  be offered — "build: Dragon — needs Dragon Hoard". Item entries are
   *  greyed even while the type has legal instances; the game's own test
   *  checks that no offered move is that item. Absent = the whole type. */
  item?: string;
}

// Instance-level gates inside a pending. MoveGateStatus above answers "why is
// this move TYPE not on the table"; it stays type-level because the negative
// space of illegal instances is unbounded in general. Inside an open pending it
// is not: the decision ranges over an enumerable set (your treaties, the cards
// face up, the options at a defense step). A game may publish that set on its
// view's `pending`, shut options included, each shut one carrying the engine's
// own refusal sentence. Lock with core/moveGates.ts checkPendingOptionConsistency.

/** One option a pending decision ranges over — takeable or shut. */
export interface PendingOption<Move> {
  /** Stable id within this pending: a treaty id, a card instance, a tile label. */
  option_id: string;
  /** The printed label a screen shows. Printed names and tile labels only —
   *  never an internal id, never a raw "c,r" coord. */
  label: string;
  /** The move that takes it. ABSENT when the option is shut. */
  move?: Move;
  /** Shut only: why, rendered against live state, in the engine's own words.
   *  The same string the engine throws if the move is attempted. Clients must
   *  never compute it themselves or parse it out of anything else. */
  blocked_reason?: string;
  /** Governing RuleSection id — same vocabulary as MoveGateStatus. */
  rules_section?: string;
  /** Printed facts the screen needs beside the label (cost, culture income,
   *  owner, count). Game-defined and structured; never prose to be parsed. */
  detail?: Record<string, unknown>;
}

/** What a view's `pending` returns. `question` is the voice and LLM contract
 *  and is unchanged; `options` sits beside it. */
export interface PendingView<Move> {
  kind: string;
  for: string;
  question: string;
  /** The bounded option set, INCLUDING the shut ones. Omitted when the
   *  decision has no enumerable option set. */
  options?: PendingOption<Move>[];
  /** True when the seat may take several options before the pending clears
   *  (treaty breaking). Default false. */
  repeatable?: boolean;
  /** Facts about the decision that are not options: the declared purchase, the
   *  queue position, the batch layout. */
  context?: Record<string, unknown>;
}

// One addressable piece of a game's rules text (docs/rules-teaching.md). Games
// that implement getRulesSections get: a get_rules topic filter, and — once the
// game also declares move gates — the rules-teaching channels (ambient grey
// list, teach-on-first-encounter, full lesson on a failed-gate rejection). The
// blob getRulesText should DERIVE from these via renderRulesText (single
// source), never be a parallel copy.
export interface RuleSection {
  /** Stable slug, e.g. "sight-and-visibility", "knight-bow". */
  id: string;
  title: string;
  /** The rules prose for this one topic. Printed names, no internal ids. */
  text: string;
  /** What this section governs — drives topic lookup and teach triggers. */
  tags: {
    /** Move types (moveSchema discriminants) this section governs. */
    move_types?: string[];
    /** Game-defined phase labels this section governs. */
    phases?: string[];
  };
}

export interface GameResult {
  game_over: true;
  winners: string[];
  scores: Record<string, number>;
  summary: string;
}

// When the active player is a HUMAN, the concrete SHAPE of the answer the model
// should expect — so it asks for the right thing and records it correctly instead
// of guessing terms (close-but-wrong) or echoing an internal id it can't translate.
// Carried on NextStep for human-owed steps; populated by Game.describeNextStep.
export interface HumanResponse {
  // What to ask the human, in plain language ("what did you roll on your 2d6?").
  ask: string;
  // A concrete example of how a human would PHRASE the answer in English
  // ("I rolled a 4 and a 2") — the anti-guessing hint. NOT the actual value.
  example: string;
  // What that answer is recorded AS — the move type + the fields to fill
  // ("report_roll with d1 and d2 set to those two faces"). Names the shape so the
  // model maps English → move without inventing field names or ids.
  records_as: string;
  // True when the answer is information the OTHER humans at the table must not
  // hear — a secret pick, a hidden hand being reported. buildNextStep turns such
  // a step into status 'awaiting_private_input' when (and only when) 2+ humans
  // share the session and the acting seat is not on its own joined device, so a
  // shared-phone client can ask for it privately. Solo sessions never see it.
  // Absent/false = the answer may be spoken aloud.
  private?: boolean;
  // A clean version of `ask` for ORCHESTRATED clients, which may speak it to
  // the player: the same question with no tool names or directions to an LLM
  // ("call get_legal_moves", "ASK them", "do not invent"). Set it when `ask`
  // carries such directions; orchestrated clients receive it AS `ask`, and
  // llm_driven clients never see it (src/mcp/clientMode.ts).
  spoken_ask?: string;
}

// Facts about a step that a client needs but that are not already in status,
// active_player_id or human_response. Filled by Game.describeNextStep beside
// its `instruction` prose (orchestrated clients never receive the prose).
// Rules for every value (locked by core/nextStepFacts.ts lintNextStepFacts):
// plain game facts in speakable words, printed names, no tool or move names,
// no loop directions ("call", "ASK", "do not invent") — the move shape belongs
// in human_response.records_as, and loop directions stay in `instruction`.
export interface NextStepFacts {
  // The role or phase the acting seat is in: "Detective", "Upkeep", "Setup".
  phase?: string;
  // Whose turn it is, when a DIFFERENT seat is making this choice (e.g. a
  // defender choosing during the attacker's turn). A seat id.
  turn_owner_id?: string;
  // Why this step is owed now: "the Hacker is playing Eddie the Doorman".
  reason?: string;
  // Where the step sits in a sequence: "card 2 of 5", "step 1 of 2".
  progress?: { current: number; total: number; of?: string };
  // When the step repeats: "one slot at a time until the Court row is full".
  repeat?: string;
  // The printed options to choose among, when they are few and fixed.
  options?: string[];
  // Everything else a player must know to answer: limits, costs, thresholds,
  // consequences. One fact per entry.
  notes?: string[];
}

// The seat a next_step is about, as structured facts (orchestrated clients get
// these instead of the prose remote-seat notes). Present only when a remote
// device is involved.
export interface NextStepSeat {
  // The acting seat is claimed by a REMOTE device (join_session): only that
  // device can act for it; this device should wait.
  remote: boolean;
}

// Client mode, declared per MCP connection (capabilities.experimental.zekel.mode
// at initialize; see src/mcp/clientMode.ts). 'llm_driven' (default) = an LLM
// drives the turn loop and needs the prose directions; 'orchestrated' = client
// code drives the loop (zekel Live's bridge), so responses carry facts only.
export type ClientMode = 'llm_driven' | 'orchestrated';

// An authoritative, machine-followable directive for what the client should do
// next given a session's current state. Built centrally by buildNextStep from
// the active player's kind, but a game may override it for phases the generic
// logic can't see — see Game.describeNextStep.
export interface NextStep {
  // 'awaiting_private_input' is a human turn whose answer the other humans must
  // not hear (see HumanResponse.private). Games never emit it themselves:
  // buildNextStep promotes a 'human_to_move' step whose human_response is
  // private, only in sessions with 2+ human seats where the acting seat is not
  // claimed by a remote device. Every consumer treats it as a human turn.
  status: 'game_over' | 'ai_to_move' | 'human_to_move' | 'awaiting_private_input';
  active_player_id: string | null;
  // Prose for an LLM that drives the turn loop: loop directions mixed with facts.
  // Orchestrated connections never receive it (src/mcp/clientMode.ts), so any
  // FACT a client needs must also live in a structured field below.
  instruction: string;
  // Present only on a human turn when the game supplied a concrete answer-shape
  // hint for this step (see HumanResponse). Optional: a game that doesn't
  // populate it falls back to instruction + get_legal_moves.
  human_response?: HumanResponse;
  // The facts of this step that used to live only in `instruction` prose —
  // what a client that never sees `instruction` still needs (see NextStepFacts).
  facts?: NextStepFacts;
  // Structured facts about the acting seat when a remote device is involved.
  seat?: NextStepSeat;
  // True once any seat is claimed by a remote device: other devices may change
  // the session at any time, so re-read state rather than trust a cached copy.
  shared_session?: boolean;
}

// One step of PHYSICAL setup, in table order (Game.getPhysicalSetup). Real
// setups interleave doing and telling ("deal 5 cards" … "tell me what you
// drew"), so one ordered list carries both:
// - 'action': something the players do at the table. `text` is one physical
//   action, short and speakable ("Shuffle your deck.").
// - 'report': the players now tell the server something. It points at the
//   setup_checklist entry (getSetupChecklist) with the same `move_type`, which
//   still owns the count and exactly what to ask for.
export type PhysicalSetupStep =
  | { kind: 'action'; text: string; for_player_id?: string }
  | { kind: 'report'; text: string; move_type: string; for_player_id?: string };

// What a session-start context looks like for an ORCHESTRATED client
// (Game.getSessionContext): the persona and rules context an interpreting LLM
// may need, with none of the turn-loop directions getSessionStartGuidance mixes in.
export interface SessionContext {
  persona?: string;
  rules_context?: string;
}

// A single entry in a MoveMenu — either a LEAF (a concrete move the human can
// pick, carrying the move_id apply_move expands) or a NODE (a category whose
// `submenu` drills down). Keys are short selection tokens ("1".."N") unique
// within their level; the client renders one level at a time, so the same keys
// recur per submenu. The human types the key — or a name/word the client matches
// to a label — and the client never invents a move shape.
export interface MoveMenuEntry {
  // Short selection token the human types (e.g. "1"), unique within this level.
  key: string;
  // Human-facing one-liner. For leaves this is the legal move's description; for
  // nodes it names the category (e.g. "Build", "Recruit").
  label: string;
  // LEAF only: the move_id from get_legal_moves to pass to apply_move.
  move_id?: string;
  // NODE only: how many leaf options live underneath (shown in the label count).
  count?: number;
  // NODE only: the move field this node's submenu is split on ("location"), a
  // hint so the client can phrase the follow-up ("Build where?").
  group_by?: string;
  // NODE only: the next level of entries to show once this category is chosen.
  submenu?: MoveMenuEntry[];
}

// A human-typing-optimized presentation of the current legal moves, so the
// client can offer a numbered menu ("type 3") instead of making the human spell
// out a whole move. Built game-agnostically by buildMoveMenu from
// get_legal_moves; a game may override grouping via Game.describeMoveMenu. Rides
// alongside next_step on every human-to-move response. NEVER the source of truth
// for legality (that stays get_legal_moves) — purely a rendering of it.
export interface MoveMenu {
  // Human-facing lead-in the client can show verbatim.
  prompt: string;
  // The top level of the menu (numbers map to entries / categories).
  entries: MoveMenuEntry[];
  // Total legal moves represented (across all submenus).
  total_moves: number;
  // True when the list was too long to show flat and was grouped into
  // categories — the client must drill down rather than dump every option.
  collapsed: boolean;
  // Human-facing note that they can also answer in their own words.
  free_text_hint: string;
  // Client-facing: how to render the menu and resolve a pick to an apply_move.
  how_to_use: string;
}

// One required setup action that must happen after create_session before the
// game can be played. Surfaced as create_session.setup_checklist so the client
// has an explicit, ordered to-do list instead of having to parse setup prose
// out of agent_guidance.
export interface SetupStep {
  // The apply_move `type` the client must send (e.g. "setup_card_drawn").
  move_type: string;
  // How many times this move is required (e.g. one report per Court slot).
  count: number;
  // Human-readable description of the step.
  description: string;
  // Exactly what value to obtain from the human — named so the model asks
  // instead of inventing it. The single most common setup failure is a model
  // fabricating a card id rather than asking what the human physically drew.
  ask_human_for: string;
}

// The harness lever(s) that vary a balance axis, used by the harness's coverage
// report to tell whether a given run exercised the axis or left it at default.
export type BalanceAxisLever = 'strategy' | 'sweep' | 'players' | 'difficulty' | 'scenario';

// A setup/configuration choice that is a BALANCE AXIS — something a player picks
// (faction, god, character, loadout) or the table configures (scenario, module)
// that can affect outcomes. The DEFAULT harness run fixes every axis (default
// loadout, no faction, default scenario, auto-assigned identities), so a balance
// pass must vary each one (or justify fixing it). The harness reports coverage
// against this declaration so an axis is never silently left unexercised.
//
// This is the balance-eval twin of getSetupChecklist: that declares a game's setup
// choices so they are never auto-resolved FOR the human (ownership); this declares
// them so they are never silently UN-EVALUATED. Every game with a non-trivial
// setup choice should implement getBalanceAxes (see the porting checklist).
export interface BalanceAxis {
  // Short id, e.g. 'faction', 'loadout', 'scenario', 'player_color'.
  name: string;
  // How to evaluate it:
  //  identity → per-identity win rate + matchup matrix + the §0 meta question
  //  config   → a loadout/draft/option; vary it so the whole space is exercised
  //  scenario → map/scenario/module; run per scenario and compare
  //  cosmetic → should NOT affect balance (colour/seat label); CONFIRM win rate is
  //             flat across it — a difference is a hidden balance bug.
  kind: 'identity' | 'config' | 'scenario' | 'cosmetic';
  description: string;
  // Which harness lever(s) vary this axis. The coverage check treats the axis as
  // exercised if ANY listed lever was varied in the run.
  levers: BalanceAxisLever[];
  // Human-facing recipe: the exact flag(s) to vary it, shown verbatim in the report
  // (e.g. "--strategy=titan,awakened,masters,uncounted").
  recipe: string;
}

export interface ApplyMoveResult<State> {
  newState: SessionState<State>;
  // The CANONICAL per-move string (state_summary on the wire). zekel Live speaks
  // it as-is and text clients show it as-is, so for an AI move it must carry
  // everything needed to copy the move onto the table: lead with the physical
  // action, use printed names and display names (core/seatNames.ts), no
  // internal ids or engine terms, one move per string. It must NEVER contain
  // information hidden from any seat — anything only one human may see goes in
  // privateReveals. Conventions: docs/spoken-narration.md.
  summary: string;
  // Information the server reveals to ONE human privately (a card dealt to
  // their server-tracked hand). Surfaced as `private_reveals` on apply_move so
  // a client can show it on that player's screen instead of speaking it.
  privateReveals?: PrivateReveal[];
}

export interface PrivateReveal {
  player_id: string;
  // Plain words, printed names ("You drew Focus, Focus and Attack.").
  text: string;
}

// Per-response `report_to_human` strings — the reporting-depth contract the MCP
// layer stamps on apply_move / get_ai_move / run_ai_turn responses. The server
// default (BOARD_VOICE, mcp/tools.ts) is the scorekeeper voice: brief confirm
// for the human's own move, full no-flavor relay for AI moves. A game may carry
// its own profile via Game.reportVoice — e.g. Warble Way Galaxy's DM voice,
// where apply_move RESOLVES outcomes the solo player cannot see (hazard damage,
// credits, XP), so its confirm string demands full relay plus invited color.
// Lives in core (not mcp/) so game modules can declare a voice without
// importing the mcp layer — same layering rule as MoveMenu.
export interface ReportVoice {
  /** apply_move — the human's own declared action. */
  applyMoveConfirm: string;
  /** get_ai_move — one AI move the human must execute on the physical board. */
  aiMoveFull: string;
  /** run_ai_turn with zero moves played. */
  runAiTurnNone: string;
  /** run_ai_turn with n moves played (gameOverNow: the batch ended the game). */
  runAiTurn(movesPlayed: number, gameOverNow: boolean): string;
}

export interface AIMoveResult<Move> {
  move: Move;
  // Optional flavour from the AI picker, shown to LLM-driven clients beside the
  // move's state_summary. The summary is canonical (ApplyMoveResult.summary):
  // nothing a player needs may live only here, it must never contradict the
  // summary, and it must never contain debug output (search counts, scores) —
  // put that in the server log. The simplest safe choice is the summary itself.
  narration: string;
}

// One decision the printed rules give a player — the post-port §6 choice table
// as data rather than prose. Helpers (validation, rendering the table) live in
// core/choiceCatalog.ts; the type lives here so a game module can declare its
// catalog without importing anything else, the same split as GameLogEntry.
// See Game.getChoiceCatalog for why this exists.
export interface PlayerChoice {
  /** Stable id, unique within the game. Lowercase, hyphenated. */
  id: string;
  /** What the decision is, in the game's own terms. Plain words. */
  description: string;
  /**
   * Who the printed rules give this decision to.
   * - `player` — whoever holds the seat decides, so a HUMAN seat must be asked.
   * - `auto` — the engine may settle it without asking; `why` must justify that.
   */
  owner: 'player' | 'auto';
  /** Does it come up during setup, or during play? */
  when: 'setup' | 'in-game';
  /**
   * The move types that settle this decision.
   *
   * An entry written as `options.<name>` means the player makes this choice when
   * the session is created, by passing that option — not through a move. Playing
   * the game cannot show whether they were asked, so the coverage check reports
   * those separately instead of pretending to have checked them.
   */
  resolvedBy: string[];
  /**
   * When several decisions ride on the SAME move type, the move field that tells
   * this one apart — e.g. Sweetlands settles "which unit moves", "ring or road"
   * and "raise taxes?" all inside one `play_intel`. Without this the check would
   * only confirm the move was offered, and would miss one of those decisions
   * quietly disappearing. The check looks for an offered move that actually sets
   * the field.
   */
  distinguishedBy?: string;
  /**
   * What has to be true before this decision can come up at all — being a
   * particular god or species, holding a particular power, having a unit off the
   * board. Ordinary play may never reach it, so the check reports it as a gap
   * instead of failing.
   *
   * Say the condition plainly. This is the one field that can hide a real bug
   * behind a plausible excuse, so it is meant to be read by a person, not to be
   * a way of quieting the check.
   */
  dependsOn?: string;
  /** Required when `owner` is `auto`: why settling it without asking is faithful. */
  why?: string;
  /** Filled in by the ai-development gate — how the AI decides this one. */
  aiPolicy?: string;
  /** Filled in by the balance gate — the matching name from `getBalanceAxes()`. */
  balanceAxis?: string;
}

export type JSONSchema = Record<string, unknown>;

export interface GameMetadata {
  game_id: string;
  name: string;
  description: string;
  min_players: number;
  max_players: number;
  supports_ai: boolean;
  has_hidden_information: boolean;
  options_schema: JSONSchema;
}

export interface Game<State, Move, Options = Record<string, unknown>> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly supportsAI: boolean;
  readonly hasHiddenInformation: boolean;
  readonly optionsSchema: JSONSchema;
  readonly moveSchema: JSONSchema;
  readonly version: string;

  createSession(players: PlayerConfig[], options?: Options): SessionState<State>;

  getLegalMoves(state: SessionState<State>, playerId: string): LegalMove<Move>[];
  getPublicView(state: SessionState<State>): unknown;
  getPlayerView(state: SessionState<State>, playerId: string): unknown;
  isGameOver(state: SessionState<State>): GameResult | null;

  applyMove(
    state: SessionState<State>,
    playerId: string,
    move: Move,
  ): ApplyMoveResult<State>;

  getAIMove(
    state: SessionState<State>,
    playerId: string,
    difficulty?: string,
    // Strategy axis (§0): a named policy the AI should pursue, orthogonal to
    // difficulty. Optional — games that don't model strategy ignore it.
    strategy?: string,
  ): Promise<AIMoveResult<Move>>;

  getRulesText?(): string;

  /**
   * Optional: a read-only question a seat asks about a decision it is
   * composing, answered from live state without applying anything — e.g.
   * "given the placements I have chosen so far, where may my next collector
   * go?". It exists so a client can offer a chained choice without keeping a
   * second copy of the rule, and without submitting a move to find out whether
   * it is legal. The answer may use only what this seat may know. Unknown
   * names, or a question the seat is not in a position to ask, throw.
   */
  queryChoice?(state: SessionState<State>, playerId: string, name: string, args: Record<string, unknown>): unknown;

  // Optional: the rules as addressable, tagged sections (docs/rules-teaching.md).
  // When present, get_rules gains a topic filter + a section index, and the
  // rules-teaching channels can key lessons to sections. Implementations should
  // derive getRulesText from these via core/rulesSections.ts renderRulesText so
  // the blob and the sections can never drift. Must be pure + stable (no
  // session state; same array every call).
  getRulesSections?(): RuleSection[];

  // Optional (docs/rules-teaching.md): the live status of every move type
  // applicable to this seat right now — the game owns seat-applicability
  // (faction kits, roles). Feeds the ambient grey list on get_legal_moves
  // ("power_strike — needs 2 Energy, you have 0"), rejection enrichment, and
  // the teach triggers. MUST agree with getLegalMoves: a type reported
  // 'available' has ≥1 legal instance and vice versa — lock per game with
  // core/moveGates.ts checkGateConsistency (the load-bearing test of the
  // feature). Pure; called on demand, never cached.
  describeMoveGates?(state: SessionState<State>, playerId: string): MoveGateStatus[];

  // Optional (docs/rules-teaching.md): the game's current phase label — same
  // vocabulary as RuleSection.tags.phases / GameLogEntry.phase — or null when
  // no named phase applies. Drives the teach-on-first-encounter phase trigger;
  // a game without it still gets the move-type triggers.
  getCurrentPhase?(state: SessionState<State>): string | null;

  // Optional: returns short guidance text that the create_session tool will
  // include verbatim in its response, so the agent sees it immediately on
  // session start without needing to fetch a separate resource. Use this for
  // per-game persona / voice instructions, setup expectations, etc.
  //
  // Optional `table` argument (docs/digital-mode.md): the requesting seat's
  // table mode ('physical' default; 'digital' for a server-held hidden state).
  // Games with physical-only guidance ("never roll for them", "physically
  // shuffled the shared deck") should branch on it so a digital session isn't
  // told to shuffle a deck it doesn't have. Omitted when the session has no
  // digital human seat (legacy callers keep physical guidance).
  getSessionStartGuidance?(table?: 'physical' | 'digital'): string;

  // Optional: session-start context for ORCHESTRATED connections — persona and
  // rules context only, no turn-loop directions (those are what
  // getSessionStartGuidance mixes in). Returned as create_session.session_context
  // to orchestrated clients; llm_driven clients keep agent_guidance unchanged.
  // A game without it gives orchestrated clients no guidance text (never its
  // llm_driven prose, which carries loop directions).
  getSessionContext?(table?: 'physical' | 'digital'): SessionContext;

  // Optional: the PHYSICAL setup, as ordered steps for this session's options
  // and seats (see PhysicalSetupStep). Returned as create_session.physical_setup
  // in every mode. Reports interleave with actions and point at the matching
  // getSetupChecklist entry by move_type.
  getPhysicalSetup?(state: SessionState<State>): PhysicalSetupStep[];

  // Optional: this game's report_to_human voice profile, overriding the server
  // default (BOARD_VOICE) on every apply_move / get_ai_move / run_ai_turn
  // response for this game's sessions. Implement it when the default depth
  // contract is wrong for the game — e.g. a solo RPG where apply_move resolves
  // consequences the player can't see and the narrator is invited to add color.
  readonly reportVoice?: ReportVoice;

  // Optional: returns structured game-specific reference data (card catalogs,
  // piece movement tables, etc.) that the get_rules tool will include in its
  // response. Free-form by design — each game decides its own shape.
  getReferenceData?(): unknown;

  // Optional: MCP tools this game adds beside the shared ones (Warble Way
  // Galaxy's get_lore is the reference). Plain descriptions — the server builds
  // the real tools (src/mcp/extensions.ts). Called once per MCP connection;
  // cache anything expensive. See src/game-kit/extensions.ts.
  getExtraTools?(): ExtraTool[];

  // Optional: MCP resources this game adds (fixed URIs and URI templates).
  getExtraResources?(): ExtraResources;

  // Optional: the folder the browser may load this game's board drawing from.
  // The web debug client loads `/web/games/<id>/viz/board.js`, and the server
  // serves `/web/games/<id>/` from this folder — so it is the game's own
  // COMPILED folder (the one holding viz/board.js and anything that drawing
  // imports). Leave it unset for a game with no board drawing: none of its
  // code is then served to browsers. Usually
  // `path.dirname(fileURLToPath(import.meta.url))` from the game's index.ts.
  readonly webAssetsDir?: string;

  // Optional: a game's rich, replayable event log (GameLogEntry[]). Implement
  // this when the engine authors per-event entries (resource deltas, phase
  // transitions, names/locations) — the MCP layer surfaces it in get_state and
  // the session log resource. A game typically stores the log in its own
  // gameState and returns it here. Games that do
  // not self-log omit this and instead implement getScoreboard for the lighter
  // auto-delta path on the generic moveLog.
  getLog?(state: SessionState<State>): GameLogEntry[];

  // Optional: per-player numeric resources right now, as
  // { playerId: { resourceName: amount } }. The MCP layer snapshots this before
  // and after each move and attaches the spending player's deltas to the
  // moveLog entry — giving "spent 3 credits, gained 2 prestige" reporting for
  // free to any game that does NOT implement getLog. Self-logging games (getLog)
  // skip this path to avoid double-reporting. Include only PUBLIC scalar
  // resources (never hidden hand contents).
  getScoreboard?(state: SessionState<State>): Record<string, Record<string, number>>;

  // Optional: a phase-aware override for the next_step directive. The generic
  // buildNextStep only knows the active player's kind, so during setup/report
  // phases (waiting for the human to report a drawn setup card, a Court refill,
  // a battle roll, etc.) it emits a misleading "wait for them to declare a
  // move" — the field the model is told to obey goes blind at the exact moment
  // it improvises and fabricates values. Return a precise directive (which move
  // shape, and what value to ask the human for) for those phases, or null to
  // fall back to the generic kind-based directive. Never invoked once the game
  // is over (buildNextStep emits the game_over step first).
  describeNextStep?(state: SessionState<State>): NextStep | null;

  // Optional: a per-game override for how the current legal moves are grouped
  // into a typing-friendly MoveMenu. The generic builder (buildMoveMenu) groups
  // by the move's discriminant (`type`/`action`) and recursively by the field
  // that best splits each oversized group, which is a reasonable default for
  // every game. Implement this only when a game's move space wants smarter
  // grouping or labels than the generic heuristic infers (e.g. a game with
  // hundreds of build variants grouping them by place, then by what is built).
  // Receives the already-computed legal moves; return null to fall back to the
  // generic builder. Purely presentational — must reference only move_ids that
  // appear in `legalMoves`, never invent moves or alter legality.
  describeMoveMenu?(
    state: SessionState<State>,
    legalMoves: LegalMove<Move>[],
  ): MoveMenu | null;

  // Optional: the ordered list of setup actions the client must perform after
  // create_session before play begins, for games with a post-creation setup
  // handshake (reporting physically-drawn setup cards, initial board reveals,
  // etc.). Returned in the create_session response as setup_checklist. Return
  // an empty array when the freshly created session is immediately playable
  // (no human-reported setup — e.g. an AI-only / auto-setup session).
  getSetupChecklist?(state: SessionState<State>): SetupStep[];

  // Optional: the game's BALANCE AXES — the setup/config choices a balance pass
  // must vary (factions, loadouts, scenarios, cosmetic picks to confirm flat).
  // Surfaced via get_rules so the harness can report which axes a run exercised
  // vs left at default. Implement it for any game with a non-trivial setup choice;
  // the harness adds a generic player-count axis on top.
  getBalanceAxes?(): BalanceAxis[];

  // Optional: the CHOICE CATALOG — every decision the printed rules give a
  // player, as data. A coverage checker can then play the game with a human
  // seat and fail if a decision marked `player` is never actually put to that
  // seat — the one kind of bug an all-AI test run cannot see: a game that makes
  // decisions for the player instead of asking.
  getChoiceCatalog?(): PlayerChoice[];

  // Optional companion to getChoiceCatalog: which catalog choice is this seat
  // being asked to make right now, by id — or null if it is not being asked
  // anything. Only needed when several different decisions are settled by the
  // SAME move type, so the move type alone can't tell them apart (e.g. a game
  // that routes several different decisions through one `resolve_choice` move). Without it
  // the coverage check falls back to matching on the move types in `resolvedBy`,
  // which is enough for most games.
  getChoiceOwed?(state: SessionState<State>, playerId: string): string | null;

  // Optional: synthesize a VALID move for the current human-owed REPORT pending
  // (a physical draw/roll/reveal the human would report) using the game's OWN
  // tracked hidden state — the remaining-deck multiset, the RNG, etc. The
  // remaining deck is deliberately NOT in any player view, so a client/test
  // harness cannot pick a valid value itself; this lets the SERVER (which owns
  // that state) supply one. Returns null when the current pending is not an
  // auto-resolvable report.
  //
  // Two real callers (docs/digital-mode.md):
  //   1. Digital-mode randomness buttons: a digital seat's report pending is
  //      offered to the person as a no-payload trigger move ("Roll", "Draw");
  //      when they press it, the engine calls THIS to fill in the dice/cards
  //      from server-held state. Real play — never resolved silently; always
  //      via the player's button press.
  //   2. The integration/desync test harness, driving a seat past a report it
  //      cannot know. Harness-only — never called on a seat expecting a human
  //      decision; a game must never resolve a move type listed in its choice
  //      catalog with owner:'player' through this path.
  // The synthesized move is still applied through the normal apply_move path.
  autoResolveReport?(state: SessionState<State>, playerId: string): { move: Move } | null;

  // Optional: a directly-APPLYABLE concrete move reflecting the AI's actual
  // decision for `playerId` in the current state — used by the suggest_move tool
  // (the integration harness's ground truth). It exists because getAIMove may
  // return an opaque DRIVER move that carries no decision data (e.g.
  // { type: 'ai_step' }, with the engine resolving the AI's secret picks
  // internally), so a harness driving a HUMAN seat off suggest_move would fall
  // back to get_legal_moves[0] — the first-enumerated option — producing a
  // degenerate game. getSuggestedMove exposes the AI's real choice (a hidden pick
  // via its setup heuristic, a smart resolve_choice payload) so the human seat
  // plays representatively. Return null to defer to getAIMove. Harness-only —
  // NEVER called on a real session; a human-owned decision is the human's to make
  // (docs/digital-mode.md, "Choices always stay with the person").
  getSuggestedMove?(state: SessionState<State>, playerId: string): { move: Move } | null;

  // ============================================================
  // Generic MCTS hooks (src/ai/mcts.ts).
  //
  // A game becomes MCTS-eligible by implementing at minimum
  // `getRewardForPlayer`. Every other hook has a working default in
  // the engine; supply the per-game version only when the default
  // is too weak or too slow.
  //
  // Conventions:
  //   - Rewards are normalized to [0, 1] from each player's
  //     perspective. Win = 1.0, loss = 0.0, draw = 0.5. For ranked
  //     finishes, use (rank-1)/(N-1) so 1st = 1.0 and last = 0.0.
  //   - State cloning operates on the FULL SessionState, not just
  //     gameState — MCTS uses the dispatcher-level shape.
  //   - The rollout policy receives the same SessionState the live
  //     game would; reuse the existing medium-difficulty heuristic
  //     where possible (it's effectively a fast playout policy).
  //   - For hidden-information games (Battle Card commits, opaque
  //     player hands, shared shuffled decks), implement `determinize`
  //     to sample a perfect-info realization consistent with what
  //     `playerId` actually knows. MCTS calls this once per
  //     simulation root (ISMCTS-style).
  // ============================================================

  // Terminal payoff for `playerId`. The engine only calls this on
  // states where `isGameOver(state) !== null`. Returns a value in
  // [0, 1] from `playerId`'s perspective.
  getRewardForPlayer?(state: SessionState<State>, playerId: string): number;

  // Optional fast-path state clone. Default is `JSON.parse(JSON.stringify(state))`,
  // which benchmarks faster than `structuredClone` on Node ≥ 20 for plain
  // JSON-shaped state. Override only when the per-game schema enables a
  // hand-rolled cloner that beats JSON.
  cloneState?(state: SessionState<State>): SessionState<State>;

  // Optional rollout policy. Called repeatedly during simulation; should be
  // fast and reasonable. Default: uniform-random over `getLegalMoves`.
  // Return null to signal "no legal move, let the engine handle terminal".
  selectRolloutMove?(state: SessionState<State>, playerId: string): Move | null;

  // Optional CURATED move set for the MCTS search tree (NOT the human-facing
  // legal set). Defaults to `getLegalMoves`. Use it to prune strictly- or
  // weakly-dominated moves the search would otherwise waste iterations on
  // (e.g. ending a turn with action pips still unspent), so the AI plays
  // tidier without weakening the rollout-based value estimate. The engine
  // still ACCEPTS any move `getLegalMoves` permits — this only narrows what
  // the search considers. Must return a subset of the legal moves.
  getSearchMoves?(state: SessionState<State>, playerId: string): LegalMove<Move>[];

  // Optional hidden-info determinization (ISMCTS). Given a state observable to
  // `fromPlayerId`, return a state where unknown facts (opponent hands, deck
  // order, simultaneous commits) have been filled in with a plausible
  // realization sampled via the provided RNG. Default: identity (game is
  // perfect-information from every player's view).
  determinize?(
    state: SessionState<State>,
    fromPlayerId: string,
    rng: () => number,
  ): SessionState<State>;

  // Optional non-terminal heuristic. If MCTS rollouts get cut short by a
  // depth or time bound, the engine uses this to estimate value from the
  // cutoff state. Default: 0.5 (uninformed). Return [0, 1] from
  // `playerId`'s perspective.
  getHeuristicValue?(state: SessionState<State>, playerId: string): number;
}

export function toGameMetadata<S, M, O>(game: Game<S, M, O>): GameMetadata {
  return {
    game_id: game.id,
    name: game.name,
    description: game.description,
    min_players: game.minPlayers,
    max_players: game.maxPlayers,
    supports_ai: game.supportsAI,
    has_hidden_information: game.hasHiddenInformation,
    options_schema: game.optionsSchema,
  };
}

/** True for every next_step status that means a human owes the next move —
 *  'human_to_move', and 'awaiting_private_input' (a human turn whose answer the
 *  other humans must not hear). Branch on this, never on the literal string. */
export function isHumanTurnStatus(status: string | undefined): boolean {
  return status === 'human_to_move' || status === 'awaiting_private_input';
}
