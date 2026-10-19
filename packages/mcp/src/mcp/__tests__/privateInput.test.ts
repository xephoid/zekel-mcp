// next_step status 'awaiting_private_input', end to end through the real
// server wiring (buildMcpServer over an in-memory MCP connection), using the
// test game's secret setup step: a human reports their lucky-square card.
//   - two humans sharing one device → awaiting_private_input (both modes)
//   - solo against the AI           → human_to_move (never private)
//   - the reporting seat joined from their own device → human_to_move, seat.remote
// Plus the move menu still reaches the private seat, and every consumer treats
// the status as a human turn (isHumanTurnStatus).

import { describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { isHumanTurnStatus } from '@zekel/game-kit';
import { connect, ORCHESTRATED_CAPABILITIES as ORCHESTRATED } from './testServer.js';

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  const body = JSON.parse(r.content[0]!.text) as Record<string, any>;
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(body)}`);
  return body;
}

const MARKS = { type: 'assign_setup_choices', selections: { p1: 'X', p2: 'O' } };

async function twoHumans(client: Client) {
  return call(client, 'create_session', {
    game_id: 'lucky-tic-tac-toe',
    players: [
      { player_id: 'p1', kind: 'human', name: 'Ada' },
      { player_id: 'p2', kind: 'human', name: 'Zeke' },
    ],
    options: { seed: 4 },
  });
}

describe('awaiting_private_input', () => {
  it('two humans on one device: the lucky-card report is private, in both modes', async () => {
    for (const caps of [{}, ORCHESTRATED]) {
      const client = await connect(caps);
      const created = await twoHumans(client);
      const marked = await call(client, 'apply_move', { session_id: created.session_id, player_id: 'p1', move: MARKS });
      const step = marked.next_step;
      expect(step.status).toBe('awaiting_private_input');
      expect(step.active_player_id).toBe('p1');
      expect(step.human_response.ask).toBe('Which lucky-square card did you draw?');
      if (caps === ORCHESTRATED) {
        expect(step.human_response.private).toBe(true);
        expect(step).not.toHaveProperty('instruction');
        expect(step.facts.phase).toBe('Setup');
      } else {
        // llm_driven keeps the prose and never sees the orchestrated-only fields.
        expect(typeof step.instruction).toBe('string');
        expect(step.human_response).not.toHaveProperty('private');
        expect(step).not.toHaveProperty('facts');
      }
      // The private seat still gets its move menu.
      const state = await call(client, 'get_state', { session_id: created.session_id, player_id: 'p1' });
      expect(state.next_step.status).toBe('awaiting_private_input');
      expect(state.move_menu).toBeDefined();
      await client.close();
    }
  });

  it('solo against the AI: never private', async () => {
    const client = await connect(ORCHESTRATED);
    const created = await call(client, 'create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [
        { player_id: 'p1', kind: 'ai' },
        { player_id: 'p2', kind: 'human', name: 'Zeke' },
      ],
      options: { seed: 4 },
    });
    const marked = await call(client, 'apply_move', { session_id: created.session_id, player_id: 'p2', move: MARKS });
    expect(marked.next_step.status).toBe('human_to_move');
    expect(marked.next_step.active_player_id).toBe('p2');
    await client.close();
  });

  it('the reporting seat on its own joined device: not private, marked remote', async () => {
    const client = await connect(ORCHESTRATED);
    const created = await twoHumans(client);
    const joined = await call(client, 'join_session', { join_code: created.join.join_code, name: 'Zeke' });
    expect(joined.player_id).toBe('p2');
    const host = created.join.host_token as string;
    await call(client, 'apply_move', { session_id: created.session_id, player_id: 'p1', move: MARKS, auth_token: host });
    await call(client, 'apply_move', { session_id: created.session_id, player_id: 'p1', move: { type: 'report_lucky_card', square: 'C3' }, auth_token: host });
    const state = await call(client, 'get_state', {
      session_id: created.session_id,
      player_id: 'p2',
      auth_token: joined.claim_token,
    });
    expect(state.next_step.active_player_id).toBe('p2');
    expect(state.next_step.status).toBe('human_to_move');
    expect(state.next_step.seat).toEqual({ remote: true });
    expect(state.next_step.shared_session).toBe(true);
    await client.close();
  });

  it('every consumer treats it as a human turn', () => {
    expect(isHumanTurnStatus('awaiting_private_input')).toBe(true);
    expect(isHumanTurnStatus('human_to_move')).toBe(true);
    expect(isHumanTurnStatus('ai_to_move')).toBe(false);
    expect(isHumanTurnStatus('game_over')).toBe(false);
  });
});
