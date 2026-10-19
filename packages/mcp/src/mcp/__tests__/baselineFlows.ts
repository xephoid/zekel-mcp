// Fixed, seeded conversations with the MCP server, played with the made-up
// test game (luckyTicTacToe.ts). clientMode.test.ts re-runs them and compares
// the llm_driven responses with __fixtures__/llmDrivenBaseline.json, so any
// change to what a model reads is made on purpose: re-record with
// UPDATE_BASELINE=1 and review the diff. Volatile values (session ids, tokens, join codes, timestamps) are
// replaced with placeholders so the comparison is exact everywhere else.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';

export type Connect = (capabilities?: Record<string, unknown>) => Promise<Client>;

export interface FlowRecord {
  instructions: string | undefined;
  calls: Array<{ call: string; response: unknown }>;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const text = r.content.map((c) => c.text).join('\n');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { isError: r.isError ?? false, body };
}

async function readResource(client: Client, uri: string): Promise<unknown> {
  const r = await client.readResource({ uri });
  return r.contents.map((c) => {
    const text = (c as { text?: string }).text ?? '';
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  });
}

const VOLATILE_KEYS = new Set([
  'session_id',
  'host_token',
  'claim_token',
  'join_code',
  'created_at',
  'createdAt',
  'updated_at',
  'updatedAt',
  'timestamp',
  'at',
]);

const TIME_KEYS = new Set(['created_at', 'createdAt', 'updated_at', 'updatedAt', 'timestamp', 'at']);

// Replace every volatile value (and every other occurrence of that value's
// text, e.g. a session id quoted inside an instruction) with a placeholder.
export function normalize(records: FlowRecord[]): FlowRecord[] {
  const found = new Map<string, string>();
  let idCount = 0;
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(collect);
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (VOLATILE_KEYS.has(k) && typeof x === 'string' && x.length >= 4 && !found.has(x)) {
          // Ids and tokens keep a number so "the same session" stays visible;
          // timestamps don't (two moves can share a millisecond).
          found.set(x, TIME_KEYS.has(k) ? `<${k}>` : `<${k}:${idCount++}>`);
        }
        collect(x);
      }
    }
  };
  collect(records);
  let text = JSON.stringify(records);
  for (const [value, placeholder] of found) text = text.split(value).join(placeholder);
  return JSON.parse(text) as FlowRecord[];
}

const GAME = 'lucky-tic-tac-toe';

async function flowSolo(connect: Connect): Promise<FlowRecord> {
  const client = await connect();
  const calls: FlowRecord['calls'] = [];
  const rec = async (name: string, args: Record<string, unknown>) => {
    const response = await call(client, name, args);
    calls.push({ call: name, response });
    return response as { body: Record<string, unknown> };
  };
  const created = await rec('create_session', {
    game_id: GAME,
    players: [
      { player_id: 'p1', kind: 'human', name: 'Zeke' },
      { player_id: 'p2', kind: 'ai', difficulty: 'medium' },
    ],
    options: { seed: 7 },
  });
  const sid = created.body.session_id as string;
  await rec('get_state', { session_id: sid, player_id: 'p1' });
  await rec('get_legal_moves', { session_id: sid, player_id: 'p1' });
  await rec('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'assign_setup_choices', selections: { p1: 'X', p2: 'O' } } });
  await rec('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'place', square: 'B2' } }); // illegal now: recovery path
  await rec('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'report_lucky_card', square: 'C3' } });
  await rec('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'place', square: 'B2' } });
  await rec('run_ai_turn', { session_id: sid, player_id: 'p2' });
  await rec('get_state', { session_id: sid, player_id: 'p1' });
  calls.push({
    call: 'resource:player',
    response: await readResource(client, `game://${GAME}/sessions/${sid}/player/p1`),
  });
  const instructions = client.getInstructions();
  await client.close();
  return { instructions, calls };
}

async function flowTwoHumansJoined(connect: Connect): Promise<FlowRecord> {
  const client = await connect();
  const calls: FlowRecord['calls'] = [];
  const rec = async (name: string, args: Record<string, unknown>) => {
    const response = await call(client, name, args);
    calls.push({ call: name, response });
    return response as { body: Record<string, unknown> };
  };
  const created = await rec('create_session', {
    game_id: GAME,
    players: [
      { player_id: 'p1', kind: 'human', name: 'Zeke' },
      { player_id: 'p2', kind: 'human', name: 'Ada' },
    ],
    options: { seed: 3 },
  });
  const sid = created.body.session_id as string;
  const join = created.body.join as { join_code: string; host_token: string };
  const joined = await rec('join_session', { join_code: join.join_code, name: 'Ada' });
  const claim = joined.body.claim_token as string;
  await rec('get_state', { session_id: sid, player_id: 'p1', auth_token: join.host_token });
  await rec('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'assign_setup_choices', selections: { p1: 'X', p2: 'O' } }, auth_token: join.host_token });
  await rec('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'report_lucky_card', square: 'A1' }, auth_token: join.host_token });
  await rec('get_state', { session_id: sid, player_id: 'p2', auth_token: claim });
  await client.close();
  return { instructions: undefined, calls };
}

async function flowSetupReports(connect: Connect): Promise<FlowRecord> {
  const client = await connect();
  const calls: FlowRecord['calls'] = [];
  const setups: Array<[string, Array<Record<string, unknown>>]> = [
    ['table human vs AI', [{ player_id: 'p1', kind: 'human' }, { player_id: 'p2', kind: 'ai' }]],
    ['on-screen human vs AI', [{ player_id: 'p1', kind: 'human', table: 'digital' }, { player_id: 'p2', kind: 'ai' }]],
    ['AI vs table human', [{ player_id: 'p1', kind: 'ai' }, { player_id: 'p2', kind: 'human' }]],
  ];
  for (const [label, players] of setups) {
    const created = (await call(client, 'create_session', { game_id: GAME, players, options: { seed: 5 } })) as { body: Record<string, unknown> };
    calls.push({ call: `create_session ${label}`, response: created });
    const sid = created.body.session_id as string;
    const human = (players.find((p) => p.kind === 'human')!.player_id) as string;
    calls.push({ call: `get_state ${label}`, response: await call(client, 'get_state', { session_id: sid, player_id: human }) });
    calls.push({
      call: `get_legal_moves ${label}`,
      response: await call(client, 'get_legal_moves', { session_id: sid, player_id: human }),
    });
  }
  await client.close();
  return { instructions: undefined, calls };
}

export async function runBaselineFlows(connect: Connect): Promise<FlowRecord[]> {
  return normalize([
    await flowSolo(connect),
    await flowTwoHumansJoined(connect),
    await flowSetupReports(connect),
  ]);
}
