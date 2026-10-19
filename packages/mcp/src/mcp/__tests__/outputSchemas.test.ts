// Output schemas (src/mcp/outputSchemas.ts), checked against real responses.
// Plays sessions of the made-up test game (luckyTicTacToe.ts), set up five
// ways so every field below appears, through the real server wiring, in both client modes, and for every result
// of a tool that has an output schema checks that:
//   - the client's own validation passed (the SDK client checks each result
//     against the schema from tools/list, and throws if it doesn't fit);
//   - structuredContent is exactly the text block's JSON, and the text block
//     is still the pretty-printed form every client has always received;
//   - the CLOSED copy of the schema accepts it, so a field the server sends
//     but the schema doesn't describe fails here.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildOutputSchemas, outputSchemasJson, OUTPUT_SCHEMAS } from '../outputSchemas.js';
import { connect, ORCHESTRATED_CAPABILITIES } from './testServer.js';

const CLOSED = buildOutputSchemas(true).tools as Record<string, { safeParse(v: unknown): { success: boolean; error?: unknown } }>;
const SCHEMA_TOOLS = new Set(Object.keys(OUTPUT_SCHEMAS.tools));

interface Seen {
  tool: string;
  game: string;
  mode: string;
  text: string;
  structured: unknown;
}

type Body = Record<string, any>;

class Recorder {
  seen: Seen[] = [];
  constructor(
    private client: Client,
    private game: string,
    private mode: string,
  ) {}

  async call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; body: Body }> {
    const r = (await this.client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent?: unknown;
    };
    const text = r.content[0]!.text;
    if (!r.isError && SCHEMA_TOOLS.has(name)) {
      this.seen.push({ tool: name, game: this.game, mode: this.mode, text, structured: r.structuredContent });
    }
    return { ok: !r.isError, body: JSON.parse(text) as Body };
  }
}

// Plays forward: the server plays AI seats (one get_ai_move first, then
// run_ai_turn); for a human seat, take the move the game's AI would suggest,
// else the first legal move. Stops at game over, when nothing can be applied,
// or after `maxSteps`.
async function play(rec: Recorder, created: Body, maxSteps: number): Promise<void> {
  const sid = created.session_id as string;
  let step = created.next_step as Body;
  for (let i = 0; i < maxSteps && step.status !== 'game_over'; i++) {
    const pid = step.active_player_id as string;
    if (step.status === 'ai_to_move') {
      const tool = rec.seen.some((x) => x.tool === 'get_ai_move') ? 'run_ai_turn' : 'get_ai_move';
      const r = await rec.call(tool, { session_id: sid, player_id: pid });
      if (!r.ok) return;
      step = r.body.next_step;
      continue;
    }
    await rec.call('get_state', { session_id: sid, player_id: pid });
    const legal = await rec.call('get_legal_moves', { session_id: sid, player_id: pid });
    const suggested = await rec.call('suggest_move', { session_id: sid, player_id: pid });
    let applied = suggested.ok
      ? await rec.call('apply_move', { session_id: sid, player_id: pid, move: suggested.body.suggested_move })
      : { ok: false, body: {} };
    const first = legal.body.legal_moves?.[0]?.move_id;
    if (!applied.ok && first) {
      applied = await rec.call('apply_move', { session_id: sid, player_id: pid, move_id: first });
    }
    if (!applied.ok) return;
    step = applied.body.next_step;
  }
}

const lucky = (players: Array<Record<string, unknown>>, seed: number) => ({
  game_id: 'lucky-tic-tac-toe',
  players,
  options: { seed },
});

const GAMES: Array<{ name: string; create: Record<string, unknown>; steps: number }> = [
  {
    // A human playing on screen: the server deals their card (private_reveals)
    // and run_ai_turn carries per-move views (player_views).
    name: 'on-screen human vs AI',
    create: lucky([{ player_id: 'p1', kind: 'human', name: 'Zeke', table: 'digital' }, { player_id: 'p2', kind: 'ai', difficulty: 'easy' }], 7),
    steps: 40,
  },
  {
    name: 'all-AI',
    create: lucky([{ player_id: 'p1', kind: 'ai', difficulty: 'easy' }, { player_id: 'p2', kind: 'ai', difficulty: 'easy' }], 3),
    steps: 2,
  },
  {
    // Two humans on one device: the secret card reports come back as
    // awaiting_private_input, and create_session offers a join code.
    name: 'two humans',
    create: lucky([{ player_id: 'p1', kind: 'human', name: 'Ada' }, { player_id: 'p2', kind: 'human', name: 'Zeke' }], 4),
    steps: 30,
  },
  {
    // A human at a physical table: physical setup, the setup checklist and a
    // reported card.
    name: 'table human vs AI',
    create: lucky([{ player_id: 'p1', kind: 'human', name: 'Zeke' }, { player_id: 'p2', kind: 'ai', difficulty: 'medium' }], 5),
    steps: 30,
  },
  {
    name: 'two humans on screen',
    create: lucky([{ player_id: 'p1', kind: 'human', name: 'Ada', table: 'digital' }, { player_id: 'p2', kind: 'human', name: 'Zeke', table: 'digital' }], 8),
    steps: 30,
  },
  {
    name: 'AI first, on-screen human second',
    create: lucky([{ player_id: 'p1', kind: 'ai', difficulty: 'mcts' }, { player_id: 'p2', kind: 'human', name: 'Zeke', table: 'digital' }], 9),
    steps: 30,
  },
  {
    name: 'AI first, human second',
    create: lucky([{ player_id: 'p1', kind: 'ai', difficulty: 'hard' }, { player_id: 'p2', kind: 'human', name: 'Zeke' }], 6),
    steps: 30,
  },
];

const MODES: Array<[string, Record<string, unknown>]> = [
  ['llm_driven', {}],
  ['orchestrated', ORCHESTRATED_CAPABILITIES],
];

describe('tool output schemas', () => {
  const seen: Seen[] = [];

  beforeAll(async () => {
    for (const [mode, caps] of MODES) {
      for (const g of GAMES) {
        const client = await connect(caps);
        // Listing the tools makes the SDK client check every later result
        // against the published schema (it throws on a mismatch).
        await client.listTools();
        const rec = new Recorder(client, g.name, mode);
        const created = await rec.call('create_session', g.create);
        expect(created.ok, JSON.stringify(created.body)).toBe(true);
        await play(rec, created.body, g.steps);
        seen.push(...rec.seen);
        await client.close();
      }
    }
  }, 120_000);

  it('tools/list publishes an output schema for each of them', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const withSchema = tools.filter((t) => t.outputSchema).map((t) => t.name).sort();
    expect(withSchema).toEqual([...SCHEMA_TOOLS].sort());
    await client.close();
  });

  it('structuredContent is the text block, and the text block is unchanged', () => {
    for (const s of seen) {
      expect(s.structured, `${s.tool} (${s.game}, ${s.mode})`).toEqual(JSON.parse(s.text));
      expect(s.text).toBe(JSON.stringify(s.structured, null, 2));
    }
  });

  it('every field sent is described by the schema', () => {
    const failures = seen
      .map((s) => ({ s, r: CLOSED[s.tool]!.safeParse(s.structured) }))
      .filter(({ r }) => !r.success)
      .map(({ s, r }) => `${s.tool} (${s.game}, ${s.mode}): ${String(r.error)}`);
    expect(failures).toEqual([]);
  });

  it('covers every schema tool, both modes, and the fields zekel Live depends on', () => {
    expect(seen.length).toBeGreaterThan(200);
    for (const mode of ['llm_driven', 'orchestrated']) {
      const tools = new Set(seen.filter((s) => s.mode === mode).map((s) => s.tool));
      expect([...tools].sort()).toEqual([...SCHEMA_TOOLS].sort());
    }
    const all = JSON.stringify(seen.map((s) => s.structured));
    for (const needle of [
      '"awaiting_private_input"',
      '"game_over": true',
      '"physical_setup"',
      '"setup_checklist"',
      '"private_reveals"',
      '"player_views"',
      '"facts"',
      '"human_response"',
      '"move_menu"',
      '"join"',
    ]) {
      expect(all.includes(needle.replace(': ', ':')) || all.includes(needle), needle).toBe(true);
    }
  });
});

describe('schemas/tool-outputs.schema.json', () => {
  it('is current (regenerate with `pnpm schemas`)', () => {
    const committed = JSON.parse(readFileSync(resolve('packages/mcp/schemas/tool-outputs.schema.json'), 'utf-8'));
    expect(committed).toEqual(outputSchemasJson());
  });
});
