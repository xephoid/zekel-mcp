// Output schemas for the tool results a typed client relies on (zekel Live's
// bridge today, Universe later). Each tool below is registered with an MCP
// `outputSchema`, and its result carries `structuredContent` — the same JSON as
// the text block, parsed, and shaped for the connection's client mode
// (clientMode.ts withClientMode adds it; the text block is untouched, so
// llm_driven clients see exactly what they saw before).
//
// A client can generate its types from `schemas/tool-outputs.schema.json`
// (written by `pnpm schemas`, kept current by __tests__/outputSchemas.test.ts)
// or read each tool's outputSchema from tools/list at run time.
//
// One source, checked by the compiler. The TypeScript types in core/game.ts
// (NextStep, HumanResponse, MoveMenu, ...) stay what game code is written
// against; the schemas here describe what goes on the wire. They cannot be the
// same thing, because the wire depends on the client mode: orchestrated
// connections never get `instruction`, `report_to_human`, `agent_guidance`,
// the reminders or `how_to_use`; llm_driven connections never get `facts`,
// `seat`, `shared_session` or `human_response.private` (docs/client-modes.md).
// So every field that one mode drops is optional here. The bottom of this file
// makes `pnpm typecheck` fail if a TypeScript type gains a field the schema
// lacks, or if a value of the type would not fit the schema.
//
// Objects are published open (extra fields allowed): the server validates its
// own results against these schemas before sending, and a client validates
// what it receives against the schema the running server lists — an open
// schema means a field added later can never turn a working call into an
// error. The test builds a CLOSED copy (buildOutputSchemas(true)) and checks
// real responses against it, so a field that is sent but not described here
// fails the test instead of slipping by.

import { z } from 'zod';
import type {
  GameResult,
  HumanResponse,
  LegalMove,
  MoveMenu,
  MoveMenuEntry,
  NextStep,
  NextStepFacts,
  NextStepSeat,
  PhysicalSetupStep,
  PrivateReveal,
  SessionContext,
  SetupStep,
} from '@zekel/game-kit';
import type { UnavailableMove } from '@zekel/game-kit';
import type { RulesBriefing } from './teaching.js';

// Both builds are typed as closed objects: that is the "known fields" type the
// compile-time checks below compare against. At run time the published build
// is open.
type ObjectFactory = <S extends z.ZodRawShape>(shape: S) => z.ZodObject<S, z.core.$strict>;

const MODE_NOTE_LLM = 'Sent to llm_driven clients only.';
const MODE_NOTE_ORCH = 'Sent to orchestrated clients only.';

export function buildOutputSchemas(closed: boolean) {
  const obj: ObjectFactory = closed ? z.strictObject : (z.looseObject as unknown as ObjectFactory);
  // Named types become $defs in the exported JSON Schema, so a generated client
  // gets one NextStep type instead of an anonymous copy per tool. Only the
  // published build registers names (ids must be unique in zod's registry).
  // Registered in place, not cloned, so a schema that refers to itself (a menu
  // entry's submenu) points at the named copy.
  const named = <T extends z.ZodType>(schema: T, id: string): T => {
    if (!closed) z.globalRegistry.add(schema, { id });
    return schema;
  };

  const HumanResponseSchema = named(
    obj({
      ask: z.string().describe('What to ask the player, in plain words.'),
      example: z.string().describe('How a player might phrase the answer. Not the actual value.'),
      records_as: z.string().describe('The move and fields the answer is recorded as.'),
      private: z
        .boolean()
        .optional()
        .describe(`The other humans at the table must not hear the answer. ${MODE_NOTE_ORCH}`),
    }),
    'HumanResponse',
  );

  const NextStepFactsSchema = named(
    obj({
      phase: z.string().optional().describe('The role or phase the acting seat is in.'),
      turn_owner_id: z
        .string()
        .optional()
        .describe('Whose turn it is, when a different seat is making this choice.'),
      reason: z.string().optional().describe('Why this step is owed now.'),
      progress: obj({
        current: z.number(),
        total: z.number(),
        of: z.string().optional(),
      })
        .optional()
        .describe('Where the step sits in a sequence ("card 2 of 5").'),
      repeat: z.string().optional().describe('When the step repeats, and until what.'),
      options: z.array(z.string()).optional().describe('The printed options to choose among.'),
      notes: z.array(z.string()).optional().describe('Other facts needed to answer; one per entry.'),
    }),
    'NextStepFacts',
  );

  const NextStepSeatSchema = named(
    obj({
      remote: z.boolean().describe('The acting seat is played from its own joined device.'),
    }),
    'NextStepSeat',
  );

  const NextStepSchema = named(
    obj({
      status: z
        .enum(['game_over', 'ai_to_move', 'human_to_move', 'awaiting_private_input'])
        .describe(
          "awaiting_private_input is a human turn whose answer the other humans must not hear (2+ human seats only).",
        ),
      active_player_id: z.string().nullable(),
      instruction: z.string().optional().describe(`Prose directions for an LLM driving the loop. ${MODE_NOTE_LLM}`),
      human_response: HumanResponseSchema.optional(),
      facts: NextStepFactsSchema.optional().describe(MODE_NOTE_ORCH),
      seat: NextStepSeatSchema.optional().describe(`Present only when a remote device is involved. ${MODE_NOTE_ORCH}`),
      shared_session: z
        .boolean()
        .optional()
        .describe(`Another device may change the session at any time. ${MODE_NOTE_ORCH}`),
    }),
    'NextStep',
  );

  // A menu entry holds a submenu of entries, so its schema refers to itself;
  // TypeScript needs the type spelled out for that, hence the annotation (the
  // lock below still checks no field of MoveMenuEntry is left out).
  const moveMenuEntryShape = {
    key: z.string(),
    label: z.string(),
    move_id: z.string().optional().describe('Leaf only: the move_id to pass to apply_move.'),
    count: z.number().optional(),
    group_by: z.string().optional(),
    submenu: z.lazy((): z.ZodType<MoveMenuEntry[]> => z.array(MoveMenuEntrySchema)).optional(),
  };
  type _MoveMenuEntryLock = None<Missing<MoveMenuEntry, typeof moveMenuEntryShape>>;
  const MoveMenuEntrySchema: z.ZodType<MoveMenuEntry> = named(obj(moveMenuEntryShape), 'MoveMenuEntry');

  const MoveMenuSchema = named(
    obj({
      prompt: z.string(),
      entries: z.array(MoveMenuEntrySchema),
      total_moves: z.number(),
      collapsed: z.boolean(),
      free_text_hint: z.string(),
      how_to_use: z.string().optional().describe(MODE_NOTE_LLM),
    }),
    'MoveMenu',
  );

  const RulesBriefingSchema = named(
    obj({
      for_player: z.string(),
      sections: z.array(obj({ id: z.string(), title: z.string(), text: z.string() })),
      teach_note: z.string().optional().describe(MODE_NOTE_LLM),
    }),
    'RulesBriefing',
  );

  const GameResultSchema = named(
    obj({
      game_over: z.literal(true),
      winners: z.array(z.string()),
      scores: z.record(z.string(), z.number()),
      summary: z.string(),
    }),
    'GameResult',
  );

  const LegalMoveSchema = named(
    obj({
      move_id: z.string(),
      description: z.string(),
      move: z.unknown().describe("The game's own move object."),
      cost: z.string().optional().describe("What taking the move spends, in the game's printed words."),
      landing: obj({
        piece: z.string(),
        from: z.unknown(),
        to: z.unknown(),
        path: z.array(z.unknown()),
        stops: z.array(z.unknown()).optional(),
      }).optional().describe("Where the move puts a piece: where it ends and every place it passes, in the game's own location shape."),
    }),
    'LegalMove',
  );

  const UnavailableMoveSchema = named(
    obj({
      move_type: z.string(),
      item: z.string().optional(),
      reason: z.string(),
      rules_section: z.string().optional(),
    }),
    'UnavailableMove',
  );

  const PrivateRevealSchema = named(
    obj({
      player_id: z.string(),
      text: z.string(),
    }),
    'PrivateReveal',
  );

  const SetupStepSchema = named(
    obj({
      move_type: z.string(),
      count: z.number(),
      description: z.string(),
      ask_human_for: z.string(),
    }),
    'SetupStep',
  );

  const PhysicalSetupStepSchema = named(
    z.discriminatedUnion('kind', [
      obj({ kind: z.literal('action'), text: z.string(), for_player_id: z.string().optional() }),
      obj({
        kind: z.literal('report'),
        text: z.string(),
        move_type: z.string().describe('The setup_checklist entry this report belongs to.'),
        for_player_id: z.string().optional(),
      }),
    ]),
    'PhysicalSetupStep',
  );

  const SessionContextSchema = named(
    obj({
      persona: z.string().optional(),
      rules_context: z.string().optional(),
    }),
    'SessionContext',
  );

  const PlayerRecordedSchema = named(
    obj({
      player_id: z.string(),
      kind: z.enum(['human', 'ai']),
      table: z.enum(['physical', 'digital']).optional(),
      name: z.string().optional(),
      difficulty: z.enum(['random', 'easy', 'medium', 'hard', 'mcts', 'hyperon']).optional(),
      strategy: z.string().optional(),
    }),
    'PlayerRecorded',
  );

  const JoinInfoSchema = named(
    obj({
      join_code: z.string(),
      host_player_id: z.string(),
      host_token: z.string().describe('Keep private; pass as auth_token on the host device.'),
      open_seats: z.array(z.string()),
      instructions: z.string().optional().describe(MODE_NOTE_LLM),
    }),
    'JoinInfo',
  );

  const AiMoveSchema = named(
    obj({
      player_id: z.string(),
      move_taken: z.unknown(),
      narration: z.string().describe('Optional flavour; state_summary is the canonical line.'),
      state_summary: z.string().describe('The move in words, written to be read aloud as-is.'),
      player_views: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Digital human seats only: each seat’s view as it stood after this move.'),
      log_entries: z.array(z.record(z.string(), z.unknown())).optional().describe("The game's log entries this move produced (games with a rich log), each with its summary and, for key events, a short headline."),
    }),
    'AiMove',
  );

  const llmOnly = () => z.string().optional().describe(MODE_NOTE_LLM);

  const CreateSessionResultSchema = named(
    obj({
      session_id: z.string(),
      game_id: z.string(),
      active_player_id: z.string(),
      players_recorded: z.array(PlayerRecordedSchema),
      initial_state_uri: z.string(),
      next_step: NextStepSchema,
      setup_checklist: z.array(SetupStepSchema).optional(),
      physical_setup: z.array(PhysicalSetupStepSchema).optional(),
      session_context: SessionContextSchema.optional().describe(MODE_NOTE_ORCH),
      naming_reminder: llmOnly(),
      all_ai_reminder: llmOnly(),
      difficulty_reminder: llmOnly(),
      rules_briefing: RulesBriefingSchema.optional(),
      join: JoinInfoSchema.optional().describe('Present when the session has 2+ human seats.'),
      agent_guidance: llmOnly(),
    }),
    'CreateSessionResult',
  );

  const LegalMovesResultSchema = named(
    obj({
      session_id: z.string(),
      player_id: z.string(),
      is_their_turn: z.boolean(),
      legal_moves: z.array(LegalMoveSchema),
      must_move: z.boolean(),
      move_menu: MoveMenuSchema.optional(),
      unavailable_moves: z.array(UnavailableMoveSchema).optional(),
      unavailable_note: llmOnly(),
      rules_briefing: RulesBriefingSchema.optional(),
      how_to_apply: llmOnly(),
    }),
    'LegalMovesResult',
  );

  const ApplyMoveResultSchema = named(
    obj({
      session_id: z.string(),
      applied: z.literal(true),
      state_summary: z.string(),
      log_entries: z.array(z.record(z.string(), z.unknown())).optional().describe("The game's log entries this move produced (games with a rich log), each with its summary and, for key events, a short headline."),
      private_reveals: z.array(PrivateRevealSchema).optional(),
      rules_briefing: RulesBriefingSchema.optional(),
      report_to_human: llmOnly(),
      next_active_player_id: z.string(),
      next_step: NextStepSchema,
      move_menu: MoveMenuSchema.optional(),
      game_over: z.boolean(),
      result: GameResultSchema.optional(),
    }),
    'ApplyMoveResult',
  );

  const GetAiMoveResultSchema = named(
    obj({
      session_id: z.string(),
      player_id: z.string(),
      move_taken: z.unknown(),
      narration: z.string(),
      state_summary: z.string(),
      log_entries: z.array(z.record(z.string(), z.unknown())).optional().describe("The game's log entries this move produced (games with a rich log), each with its summary and, for key events, a short headline."),
      report_to_human: llmOnly(),
      next_active_player_id: z.string(),
      next_step: NextStepSchema,
      game_over: z.boolean(),
      result: GameResultSchema.optional(),
    }),
    'GetAiMoveResult',
  );

  const RunAiTurnResultSchema = named(
    obj({
      session_id: z.string(),
      moves_played: z.number(),
      moves: z.array(AiMoveSchema),
      report_to_human: llmOnly(),
      next_active_player_id: z.string(),
      next_step: NextStepSchema,
      move_menu: MoveMenuSchema.optional(),
      rules_briefing: RulesBriefingSchema.optional(),
      game_over: z.boolean(),
      result: GameResultSchema.optional(),
      warning: z.string().optional().describe('Set when the safety cap on AI moves stopped the call (a bug).'),
    }),
    'RunAiTurnResult',
  );

  // get_state spreads the game's own player view at the top level, so this one
  // stays open in both builds; only the fields the server adds are described.
  const GetStateResultSchema = named(
    z.looseObject({
      next_step: NextStepSchema,
      log: z.array(z.record(z.string(), z.unknown())).optional().describe("The game's log entries."),
      scoreboard: z.record(z.string(), z.record(z.string(), z.number())).optional(),
      move_menu: MoveMenuSchema.optional(),
      rules_briefing: RulesBriefingSchema.optional(),
      state: z.unknown().optional().describe('Only when the game view is not an object.'),
    }),
    'GetStateResult',
  );

  return {
    parts: {
      NextStep: NextStepSchema,
      HumanResponse: HumanResponseSchema,
      NextStepFacts: NextStepFactsSchema,
      NextStepSeat: NextStepSeatSchema,
      MoveMenu: MoveMenuSchema,
      MoveMenuEntry: MoveMenuEntrySchema,
      RulesBriefing: RulesBriefingSchema,
      GameResult: GameResultSchema,
      LegalMove: LegalMoveSchema,
      UnavailableMove: UnavailableMoveSchema,
      PrivateReveal: PrivateRevealSchema,
      SetupStep: SetupStepSchema,
      PhysicalSetupStep: PhysicalSetupStepSchema,
      SessionContext: SessionContextSchema,
    },
    /** Tool name → the schema of its successful result. */
    tools: {
      create_session: CreateSessionResultSchema,
      get_legal_moves: LegalMovesResultSchema,
      apply_move: ApplyMoveResultSchema,
      get_ai_move: GetAiMoveResultSchema,
      run_ai_turn: RunAiTurnResultSchema,
      get_state: GetStateResultSchema,
    },
  };
}

/** The published schemas (open objects). */
export const OUTPUT_SCHEMAS = buildOutputSchemas(false);

export type ToolWithOutputSchema = keyof typeof OUTPUT_SCHEMAS.tools;

export function outputSchemaFor(tool: string): z.ZodType | undefined {
  return (OUTPUT_SCHEMAS.tools as Record<string, z.ZodType>)[tool];
}

/** One JSON Schema document for every tool result, with shared $defs — what a
 *  client generates its types from (scripts/export-output-schemas.ts). */
export function outputSchemasJson(): Record<string, unknown> {
  return z.toJSONSchema(z.object(OUTPUT_SCHEMAS.tools), { target: 'draft-7', io: 'output' }) as Record<
    string,
    unknown
  >;
}

// ---- compile-time lock against core/game.ts --------------------------------
// If one of these lines stops compiling, a TypeScript type and its schema have
// drifted apart: add the new field to the schema above (optional if a client
// mode drops it), or fix the type.

type Parts = ReturnType<typeof buildOutputSchemas>['parts'];
type Wire<K extends keyof Parts> = z.infer<Parts[K]>;
/** Compiles only when every value of T fits the schema's type W. */
type Fits<T extends W, W> = T;
/** The fields T has that the schema leaves out (Skip = fields that never go
 *  on the wire). */
type Missing<T, W, Skip extends PropertyKey = never> = Exclude<keyof T, keyof W | Skip>;
/** Compiles only when X is empty. */
type None<X extends never> = X;

export type OutputSchemaLock = [
  Fits<NextStep, Wire<'NextStep'>>,
  None<Missing<NextStep, Wire<'NextStep'>>>,
  // spoken_ask never reaches the wire: orchestrated clients get it AS `ask`,
  // llm_driven clients never see it (clientMode.ts shapeForMode).
  Fits<HumanResponse, Wire<'HumanResponse'>>,
  None<Missing<HumanResponse, Wire<'HumanResponse'>, 'spoken_ask'>>,
  Fits<NextStepFacts, Wire<'NextStepFacts'>>,
  None<Missing<NextStepFacts, Wire<'NextStepFacts'>>>,
  None<Missing<NonNullable<NextStepFacts['progress']>, NonNullable<Wire<'NextStepFacts'>['progress']>>>,
  Fits<NextStepSeat, Wire<'NextStepSeat'>>,
  None<Missing<NextStepSeat, Wire<'NextStepSeat'>>>,
  Fits<MoveMenu, Wire<'MoveMenu'>>,
  None<Missing<MoveMenu, Wire<'MoveMenu'>>>,
  Fits<RulesBriefing, Wire<'RulesBriefing'>>,
  None<Missing<RulesBriefing, Wire<'RulesBriefing'>>>,
  Fits<GameResult, Wire<'GameResult'>>,
  None<Missing<GameResult, Wire<'GameResult'>>>,
  Fits<LegalMove<unknown>, Wire<'LegalMove'>>,
  None<Missing<LegalMove<unknown>, Wire<'LegalMove'>>>,
  Fits<UnavailableMove, Wire<'UnavailableMove'>>,
  None<Missing<UnavailableMove, Wire<'UnavailableMove'>>>,
  Fits<PrivateReveal, Wire<'PrivateReveal'>>,
  None<Missing<PrivateReveal, Wire<'PrivateReveal'>>>,
  Fits<SetupStep, Wire<'SetupStep'>>,
  None<Missing<SetupStep, Wire<'SetupStep'>>>,
  Fits<PhysicalSetupStep, Wire<'PhysicalSetupStep'>>,
  None<Missing<Extract<PhysicalSetupStep, { kind: 'action' }>, Extract<Wire<'PhysicalSetupStep'>, { kind: 'action' }>>>,
  None<Missing<Extract<PhysicalSetupStep, { kind: 'report' }>, Extract<Wire<'PhysicalSetupStep'>, { kind: 'report' }>>>,
  Fits<SessionContext, Wire<'SessionContext'>>,
  None<Missing<SessionContext, Wire<'SessionContext'>>>,
];
