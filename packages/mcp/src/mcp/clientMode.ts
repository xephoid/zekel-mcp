// Client mode, declared per MCP connection (zekel Live engine change,
// 2026-09-23). README design principle 2: the mode is a capability the client
// DECLARES — never inferred from which client is connected (clientInfo.name),
// and never stored on the game session (one session may be played from the
// voice bridge and later from a chat client; each gets text that fits it).
//
//   capabilities.experimental.zekel = { mode: "orchestrated" }   at initialize
//
// 'llm_driven' (the default) is today's behaviour: an LLM drives the turn loop
// and reads the prose directions. 'orchestrated' is a client whose CODE drives
// the loop (zekel Live's bridge): it gets the FACTS (whose turn, what the game
// is waiting for, persona, rules context) and none of the LOOP DIRECTIONS
// (which tool to call next, "keep calling", "REPORT AI MOVES IN FULL").
//
// Every tool and resource handler is wrapped once at registration
// (withClientMode), so the split lives here and nowhere else:
//   - orchestrated: next_step loses `instruction`; report_to_human,
//     agent_guidance, the create_session reminders, join instructions,
//     recovery hints, how_to_apply, unavailable_note, move_menu.how_to_use
//     and the rules_briefing teach_note are dropped. Facts stay: next_step status/seat/answer shape
//     (plus .facts, .seat, .shared_session), move_menu, views, logs, the
//     rules_briefing sections, the grey list's reasons, players_recorded.
//   - llm_driven: responses are byte-identical to before this change, except
//     the structured facts added for orchestrated clients (next_step.facts,
//     .seat, .shared_session, human_response.private) are removed — the prose
//     already carries them. The status itself is shared by both modes:
//     'awaiting_private_input' reaches llm_driven clients too (2+ humans only).
//     Locked against a recorded baseline by __tests__/clientMode.test.ts.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InitializeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ClientMode } from '@zekel/game-kit';

export type { ClientMode } from '@zekel/game-kit';

/** Per-connection state. Mutable: the mode is known only once the client's
 *  initialize request arrives, after tools are registered. */
export interface ConnectionContext {
  mode: ClientMode;
}

export function llmDrivenContext(): ConnectionContext {
  return { mode: 'llm_driven' };
}

/** The mode a client declared in its initialize capabilities. Anything other
 *  than an explicit "orchestrated" is llm_driven (today's behaviour). */
export function parseClientMode(capabilities: unknown): ClientMode {
  const zekel = (capabilities as { experimental?: { zekel?: { mode?: unknown } } } | undefined)?.experimental
    ?.zekel;
  return zekel?.mode === 'orchestrated' ? 'orchestrated' : 'llm_driven';
}

/**
 * Reads the client's declared mode from its initialize request into `ctx`, and
 * answers with the server instructions for that mode. Works the same for stdio
 * and HTTP because it hooks the initialize message itself. The SDK sends
 * `instructions` in its initialize reply from a value fixed at construction, so
 * this re-uses the SDK's own initialize handling and swaps only that one field.
 */
export function installClientModeDetection(
  server: McpServer,
  ctx: ConnectionContext,
  instructionsFor: (mode: ClientMode) => string,
): void {
  const inner = server.server as unknown as {
    _oninitialize(request: unknown): Promise<Record<string, unknown>>;
  };
  server.server.setRequestHandler(InitializeRequestSchema, async (request) => {
    ctx.mode = parseClientMode(request.params.capabilities);
    const result = await inner._oninitialize(request);
    return { ...result, instructions: instructionsFor(ctx.mode) } as never;
  });
}

// ---- shaping responses for the connection's mode --------------------------

// Top-level response fields that are loop directions for an LLM.
const ORCHESTRATED_DROP_TOP = [
  'report_to_human',
  'agent_guidance',
  'naming_reminder',
  'difficulty_reminder',
  'all_ai_reminder',
  'instructions',
  'how_to_apply',
  'unavailable_note',
];

// next_step fields only orchestrated clients receive.
const ORCHESTRATED_ONLY_NEXT_STEP = ['facts', 'seat', 'shared_session'];

function isNextStep(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { status?: unknown }).status === 'string';
}

// Walk the payload; `visit` sees every object that sits under a "next_step" key.
function eachNextStep(v: unknown, visit: (step: Record<string, unknown>) => void): void {
  if (Array.isArray(v)) {
    for (const x of v) eachNextStep(x, visit);
    return;
  }
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === 'next_step' && isNextStep(x)) visit(x);
    else eachNextStep(x, visit);
  }
}

// Every object sitting under key `key`, anywhere in the payload.
function eachKey(v: unknown, key: string, visit: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(v)) {
    for (const x of v) eachKey(x, key, visit);
    return;
  }
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === key && x && typeof x === 'object' && !Array.isArray(x)) visit(x as Record<string, unknown>);
    else eachKey(x, key, visit);
  }
}

/** Shapes `payload` for `mode`, in place, and returns it. */
export function shapeForMode(payload: unknown, mode: ClientMode): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (mode === 'llm_driven') {
    eachNextStep(payload, (step) => {
      for (const k of ORCHESTRATED_ONLY_NEXT_STEP) delete step[k];
      const hr = step.human_response as Record<string, unknown> | undefined;
      if (hr && typeof hr === 'object') {
        delete hr.private;
        delete hr.spoken_ask;
      }
    });
    return payload;
  }
  const out = payload as Record<string, unknown>;
  for (const k of ORCHESTRATED_DROP_TOP) delete out[k];
  const join = out.join as Record<string, unknown> | undefined;
  if (join && typeof join === 'object') delete join.instructions;
  const recovery = out.recovery as Record<string, unknown> | undefined;
  if (recovery && typeof recovery === 'object') delete recovery.hint;
  // move_menu keeps every entry; only how_to_use (render it, then "call
  // apply_move with the move_id") is a direction to a loop-driving LLM.
  eachKey(out, 'move_menu', (menu) => delete menu.how_to_use);
  // rules_briefing keeps its sections; only the relay direction goes.
  const briefing = out.rules_briefing as Record<string, unknown> | undefined;
  if (briefing && typeof briefing === 'object') delete briefing.teach_note;
  eachNextStep(out, (step) => {
    delete step.instruction;
    // A prompt with LLM directions in it has a clean spoken version.
    const hr = step.human_response as Record<string, unknown> | undefined;
    if (hr && typeof hr === 'object' && typeof hr.spoken_ask === 'string') {
      hr.ask = hr.spoken_ask;
      delete hr.spoken_ask;
    }
  });
  return out;
}

type TextContent = { type: string; text?: string };

// Re-shape the JSON text blocks of a tool/resource result. Payloads are always
// written with JSON.stringify(x, null, 2) (tools.ts ok/fail), so parse and
// re-stringify reproduce them exactly; a block is rewritten only when shaping
// actually changed something.
function shapeTextBlocks<T extends TextContent>(blocks: T[], mode: ClientMode): T[] {
  return blocks.map((b) => {
    if (typeof b.text !== 'string' || !b.text.startsWith('{')) return b;
    let parsed: unknown;
    try {
      parsed = JSON.parse(b.text);
    } catch {
      return b;
    }
    const before = b.text;
    const shaped = shapeForMode(parsed, mode);
    const text = JSON.stringify(shaped, null, 2);
    return text === before ? b : { ...b, text };
  });
}

// The JSON object in a result's first text block, or undefined.
function structuredFrom(blocks: TextContent[]): Record<string, unknown> | undefined {
  const text = blocks[0]?.text;
  if (typeof text !== 'string' || !text.startsWith('{')) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * A view of `server` whose registerTool / registerResource wrap every handler
 * so its result is shaped for the connection's mode at call time.
 */
export function withClientMode(server: McpServer, ctx: ConnectionContext): McpServer {
  const registerTool = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  const registerResource = server.registerResource.bind(server) as (...a: unknown[]) => unknown;
  const view = Object.create(server) as McpServer;
  (view as unknown as { registerTool: unknown }).registerTool = (name: unknown, config: unknown, cb: unknown) =>
    registerTool(name, config, async (...args: unknown[]) => {
      const result = (await (cb as (...a: unknown[]) => unknown)(...args)) as {
        content?: TextContent[];
        isError?: boolean;
      };
      if (!result?.content) return result;
      const content = shapeTextBlocks(result.content, ctx.mode);
      // A tool with an output schema (outputSchemas.ts) also returns its result
      // as structuredContent: the text block's JSON, already shaped for this
      // mode, so the two can never disagree. Errors carry none.
      const hasSchema = !!(config as { outputSchema?: unknown } | undefined)?.outputSchema;
      if (!hasSchema || result.isError) return { ...result, content };
      const structuredContent = structuredFrom(content);
      return structuredContent ? { ...result, content, structuredContent } : { ...result, content };
    });
  (view as unknown as { registerResource: unknown }).registerResource = (...a: unknown[]) => {
    const cb = a[a.length - 1] as (...x: unknown[]) => unknown;
    const wrapped = async (...args: unknown[]) => {
      const result = (await cb(...args)) as { contents?: TextContent[] };
      if (!result?.contents) return result;
      return { ...result, contents: shapeTextBlocks(result.contents, ctx.mode) };
    };
    return registerResource(...a.slice(0, -1), wrapped);
  };
  return view;
}
