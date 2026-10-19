import { z } from 'zod';

// The accepted values for the seat fields below. Deliberately NOT z.enum:
// several MCP clients (LibreChat among them) validate tool calls against the
// published JSON schema CLIENT-SIDE and reject violations with a terse generic
// message ("input did not match expected schema") the model can't act on — the
// server's helpful rejection text never runs. Observed 2026-07-24: qwen3.5:9b
// sent difficulty:"" and the whole game died in setup on that one-line error
// (docs/assistant-model-finetune.md, "First real-session capture"). Keeping
// these as plain strings lets every call REACH the server, which normalizes
// tolerantly (case/whitespace, "" = unset) and rejects with a message that
// names the accepted forms — the same "don't make the model guess" contract
// every move field follows.
export const PLAYER_KINDS = ['human', 'ai'] as const;
export const AI_DIFFICULTIES = ['random', 'easy', 'medium', 'hard', 'mcts', 'hyperon'] as const;

export const playerConfigSchema = z.object({
  player_id: z.string().min(1),
  kind: z
    .string()
    .min(1)
    .describe('"human" for a person at the table; "ai" for a server-played opponent. The human player\'s seat MUST be kind:"human".'),
  name: z.string().optional(),
  difficulty: z
    .string()
    .optional()
    .describe(
      'AI seats only: easy | medium | hard | mcts. Omit it (rather than guessing) to let the server apply its default ladder. ' +
        '"random" makes uniformly random legal moves where a game offers it (other games play their default level). ' +
        '"hyperon" routes the seat to an external learned-strategy brain (needs HYPERON_BRAIN_URL on the server) — only use it when asked for.',
    ),
  // Strategy axis (orthogonal to difficulty/skill): a named policy the AI should
  // pursue (e.g. 'aggro', 'control'). Free-form so each game owns its vocabulary;
  // a game that doesn't recognize the value falls back to its default play.
  strategy: z.string().min(1).optional(),
  // Table mode (docs/digital-mode.md): 'physical' (default) = person at a real
  // table holds their own hidden state; 'digital' = server holds this human
  // seat's hidden state and resolves its randomness as a button press.
  table: z
    .string()
    .optional()
    .describe(
      'Human seats only: "physical" (default) or "digital". digital = the server holds this seat\'s hidden hand/deck and resolves its dice/draws when the player presses the offered button. Omit for the normal physical-table play.',
    ),
  // Rules teaching for this seat (docs/rules-teaching.md) — a session
  // preference, not a seat property: seeded into seatPreferences at creation,
  // changeable any time via set_session_preferences. Default on; human seats only.
  teaching: z
    .boolean()
    .optional()
    .describe(
      'Rules teaching for this (human) seat: first-encounter rules lessons in responses. Default true; set false if this player already knows the game.',
    ),
});

// Optional auth token for multi-device sessions (one or more seats claimed via
// join_session). The caller passes whichever single secret it holds — the host
// passes the host_token from create_session; a remote player passes the
// claim_token from their join_session. Ignored for single-device sessions.
const authTokenField = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Auth token for a multi-device session (host_token if you are the host, or your seat\'s claim_token if you are a remote player). Only required once another human has joined; ignored otherwise.',
  );

export const createSessionInput = {
  game_id: z.string().min(1).describe('Id of a game from list_games'),
  players: z
    .array(playerConfigSchema)
    .min(1)
    .describe('Players in the session; include kind=ai for AI opponents'),
  options: z
    .object({})
    .passthrough()
    .optional()
    .describe('Game-specific options; see the game\'s options_schema'),
  host_player_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The seat the CREATING device will play (the host). It drives the whole game except on a remote player\'s own turn. Defaults to the first human seat. Only matters when the session has open seats a second human can join.',
    ),
};

export const joinSessionInput = {
  join_code: z
    .string()
    .min(1)
    .describe('The 4-character code shown to the host in create_session (case/space-insensitive).'),
  name: z
    .string()
    .min(1)
    .optional()
    .describe('Display name for the joining player; mirrored onto the claimed seat.'),
};

export const sessionPlayerInput = {
  session_id: z.string().min(1),
  player_id: z.string().min(1),
};

export const applyMoveInput = {
  session_id: z.string().min(1),
  player_id: z.string().min(1),
  // Two ways to specify the action:
  //  • move_id — the `move_id` of an entry from this player's CURRENT
  //    get_legal_moves. The server expands it to the full move; you never build
  //    a move shape. Best for ENUMERABLE actions (build/sell/network/…).
  //  • move — the full structured move object. REQUIRED for moves carrying values
  //    the server can't enumerate (e.g. a human reporting which hidden cards they
  //    drew); the get_legal_moves entry for those is
  //    only a skeleton, so move_id alone would submit empty values.
  // Provide exactly one. If both are given, the full `move` wins (it carries your
  // real values; the move_id skeleton may be empty).
  move_id: z
    .string()
    .min(1)
    .optional()
    .describe('move_id of an entry from this player\'s current get_legal_moves — the server expands it to the full move (no shape to build). Preferred.'),
  move: z
    .object({})
    .passthrough()
    .optional()
    .describe('Full structured move (shape defined by the game). Copy a get_legal_moves entry\'s `move` verbatim. Omit when you pass move_id.'),
  auth_token: authTokenField,
};

export const sessionOnlyInput = {
  session_id: z.string().min(1),
};

// undo PROGRESSES (rewinds) the game, so in a multi-device session it is a
// host-only action — hence it accepts the host's auth_token.
export const undoInput = {
  session_id: z.string().min(1),
  auth_token: authTokenField,
};

export const playerOnlyInput = {
  session_id: z.string().min(1),
  player_id: z.string().min(1),
  auth_token: authTokenField,
};

export const queryChoiceInput = {
  ...playerOnlyInput,
  name: z.string().min(1).max(64).describe('The question, as the game names it (e.g. "collector_reach")'),
  args: z.record(z.string(), z.unknown()).optional().describe('Arguments for the question, as the game defines them'),
};

export const gameOnlyInput = {
  game_id: z.string().min(1).describe('Id of a game from list_games'),
};

export const setSessionPreferencesInput = {
  session_id: z.string().min(1),
  player_id: z.string().min(1).describe('The seat whose preferences to set'),
  preferences: z
    .object({
      teaching: z
        .boolean()
        .optional()
        .describe(
          'Rules teaching for this seat: false stops first-encounter rules lessons (the unavailable_moves grey list stays — it is a board-fidelity guard, not teaching). Default on.',
        ),
    })
    .describe('Preference fields to merge; omitted fields are left unchanged'),
  auth_token: authTokenField,
};

export const getRulesInput = {
  game_id: z.string().min(1).describe('Id of a game from list_games'),
  topic: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional rules topic — a section id or title (from this response\'s rules_sections index) to fetch just that section instead of the full rules text. Only games with sectioned rules support it; others return the full text.',
    ),
};
