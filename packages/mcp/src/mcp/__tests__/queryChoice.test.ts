// query_choice: a read-only question a seat asks while composing a decision,
// through the real MCP tool surface. It answers a game that defines the
// question, applies nothing, and refuses a game that answers none.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connect } from './testServer.js';

let client: Client;

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: Record<string, any> }> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content?: Array<{ text?: string }> };
  return { isError: !!r.isError, data: JSON.parse(r.content?.[0]?.text ?? '{}') };
}

beforeAll(async () => { client = await connect(); });
afterAll(async () => { await client.close(); });

describe('query_choice', () => {
  it("passes the game's refusal through, and changes nothing", async () => {
    const created = await call('create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [{ player_id: 'p1', kind: 'human', name: 'Ada' }, { player_id: 'p2', kind: 'ai' }],
    });
    expect(created.isError).toBe(false);
    const session_id = created.data['session_id'] as string;
    const before = await call('get_state', { session_id, player_id: 'p1' });
    const asked = await call('query_choice', { session_id, player_id: 'p1', name: 'lucky_square' });
    expect(asked.isError).toBe(true);
    expect(JSON.stringify(asked.data)).toContain('You have no lucky square yet');
    const after = await call('get_state', { session_id, player_id: 'p1' });
    expect(after.data).toEqual(before.data);
  });

  it("returns the game's answer once there is one", async () => {
    const created = await call('create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [{ player_id: 'p1', kind: 'human', name: 'Ada' }, { player_id: 'p2', kind: 'ai' }],
    });
    const session_id = created.data['session_id'] as string;
    await call('apply_move', { session_id, player_id: 'p1', move: { type: 'assign_setup_choices', selections: { p1: 'X', p2: 'O' } } });
    await call('apply_move', { session_id, player_id: 'p1', move: { type: 'report_lucky_card', square: 'B2' } });
    const asked = await call('query_choice', { session_id, player_id: 'p1', name: 'lucky_square' });
    expect(asked.isError).toBe(false);
    expect(JSON.stringify(asked.data)).toContain('B2');
  });

  it('refuses a game that answers no questions', async () => {
    const created = await call('create_session', {
      game_id: 'plain-tic-tac-toe', players: [{ player_id: 'p1', kind: 'human' }, { player_id: 'p2', kind: 'ai' }],
    });
    const asked = await call('query_choice', { session_id: created.data['session_id'], player_id: 'p1', name: 'anything' });
    expect(asked.isError).toBe(true);
    expect(JSON.stringify(asked.data)).toContain('answers no queries');
  });
});
