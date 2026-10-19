// Another human's private choices must NOT leak through move menus attached to
// responses. With two authenticated seats (create_session + join_session), the
// off-turn seat must never receive the on-clock human's menu.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../tools.js';
import { setSessionStore } from '../../core/sessions.js';
import { MemorySessionStore } from '../../core/store/memory.js';
import { registerGame } from '../../core/registry.js';
import { luckyTicTacToe } from './luckyTicTacToe.js';

let client: Client;

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content?: Array<{ text?: string }> };
  const text = r.content?.[0]?.text ?? '{}';
  try { return { isError: !!r.isError, data: JSON.parse(text) }; } catch { return { isError: !!r.isError, data: { _raw: text } }; }
}

function activeIdOf(d: Record<string, unknown>): string | null {
  const ns = d['next_step'] as { active_player_id?: string | null } | undefined;
  return ns?.active_player_id ?? null;
}

beforeAll(async () => {
  setSessionStore(new MemorySessionStore());
  registerGame(luckyTicTacToe);
  const server = new McpServer({ name: 'test', version: '0' }, { capabilities: { tools: {} } });
  registerTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => { await client.close(); });

describe('move menus are seat-scoped', () => {
  it('two authenticated seats: off-turn caller gets no menu; on-clock caller does', async () => {
    const create = await call('create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [
        { player_id: 'p1', kind: 'human', name: 'Host' },
        { player_id: 'p2', kind: 'human', name: 'Guest', table: 'digital' },
      ],
      options: { seed: 2 },
    });
    expect(create.isError).toBe(false);
    const sessionId = create.data['session_id'] as string;
    const joinInfo = create.data['join'] as { join_code: string; host_token: string };
    const hostToken = joinInfo.host_token;

    const joinResp = await call('join_session', { session_id: sessionId, join_code: joinInfo.join_code, player_id: 'p2' });
    expect(joinResp.isError).toBe(false);
    const claimToken = joinResp.data['claim_token'] as string;
    const tokFor = (pid: string) => (pid === 'p1' ? hostToken : claimToken);

    const applyAs = async (pid: string, move: Record<string, unknown>) => {
      const r = await call('apply_move', { session_id: sessionId, auth_token: tokFor(pid), player_id: pid, move });
      if (r.isError) throw new Error(`apply_move(${pid}, ${JSON.stringify(move)}) failed: ${JSON.stringify(r.data).slice(0, 240)}`);
      return r.data;
    };

    // Setup: marks on the host; the host's card is reported, the guest's is dealt on screen.
    await applyAs('p1', { type: 'assign_setup_choices', selections: { p1: 'X', p2: 'O' } });
    await applyAs('p1', { type: 'report_lucky_card', square: 'A1' });
    await applyAs('p2', { type: 'draw_lucky_card' });

    // Play: X (p1) is on the clock.
    const st0 = (await call('get_state', { session_id: sessionId, auth_token: hostToken, player_id: 'p1' })).data;
    const active = activeIdOf(st0);
    expect(active).toBe('p1');
    const other = 'p2';

    const menuForActive = (await call('get_state', { session_id: sessionId, auth_token: tokFor(active!), player_id: active! })).data['move_menu'];
    const menuForOther = (await call('get_state', { session_id: sessionId, auth_token: tokFor(other), player_id: other })).data['move_menu'];
    expect(menuForActive, 'the on-clock seat gets its own menu').toBeTruthy();
    expect(menuForOther, 'the off-turn seat never receives the on-clock menu').toBeUndefined();

    // After the move the other human is on the clock: the mover's response must
    // not carry the other human's menu; the other human fetches their own.
    const resp = await applyAs(active!, { type: 'place', square: 'B2' });
    expect(activeIdOf(resp)).toBe(other);
    expect(resp['move_menu'], 'the mover gets no menu; the next human fetches their own').toBeUndefined();
    const otherNow = (await call('get_state', { session_id: sessionId, auth_token: tokFor(other), player_id: other })).data;
    expect(otherNow['move_menu']).toBeTruthy();
  });

  it('single-device two-human session issues no join credentials to a second device and the menu is attached as before', async () => {
    const create = await call('create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [
        { player_id: 'A', kind: 'human', name: 'A' },
        { player_id: 'B', kind: 'human', name: 'B' },
      ],
    });
    expect(create.isError).toBe(false);
    const st = (await call('get_state', { session_id: create.data['session_id'], player_id: 'A' })).data;
    expect(st['move_menu'], 'hot-seat keeps the menu').toBeTruthy();
  });
});
