// Each applied move returns the log entries it produced (log_entries), on
// apply_move and on every run_ai_turn step, so a client that keeps its own
// log can put each entry with the move that made it. Together they are the
// game's whole log, in order, with nothing missing or repeated.

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

describe('log_entries', () => {
  it('apply_move and each AI step return the entries they made, adding up to the whole log', async () => {
    const created = await call('create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [{ player_id: 'p1', kind: 'human', table: 'digital' }, { player_id: 'p2', kind: 'ai' }],
    });
    expect(created.isError).toBe(false);
    const session_id = created.data['session_id'] as string;
    const start = await call('get_state', { session_id, player_id: 'p1' });
    const seqs: number[] = (start.data['log'] as Array<{ seq: number }>).map((e) => e.seq);
    let next = start.data['next_step'] as { status: string; active_player_id?: string };
    for (let i = 0; i < 40 && next.status !== 'game_over'; i++) {
      if (next.status === 'ai_to_move') {
        const ai = await call('run_ai_turn', { session_id, player_id: next.active_player_id });
        expect(ai.isError).toBe(false);
        for (const step of ai.data['moves'] as Array<{ log_entries?: Array<{ seq: number }> }>) {
          expect(Array.isArray(step.log_entries)).toBe(true);
          seqs.push(...step.log_entries!.map((e) => e.seq));
        }
        next = ai.data['next_step'];
        continue;
      }
      const legal = await call('get_legal_moves', { session_id, player_id: 'p1' });
      const move = (legal.data['legal_moves'] as Array<{ move: unknown }>)[0]!.move;
      const applied = await call('apply_move', { session_id, player_id: 'p1', move });
      expect(applied.isError).toBe(false);
      expect(Array.isArray(applied.data['log_entries'])).toBe(true);
      seqs.push(...(applied.data['log_entries'] as Array<{ seq: number }>).map((e) => e.seq));
      next = applied.data['next_step'];
    }
    const end = await call('get_state', { session_id, player_id: 'p1' });
    const all = (end.data['log'] as Array<{ seq: number }>).map((e) => e.seq);
    expect(all.length).toBeGreaterThan(start.data['log'].length);
    expect(seqs).toEqual(all);
  });
});
