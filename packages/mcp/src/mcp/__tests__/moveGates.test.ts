// Gate declarations + the ambient grey list (docs/rules-teaching.md M1),
// driven through the real MCP tool surface with the rules-teaching stub game:
//   - unavailable_moves renders blocked move TYPES with live gate reasons
//   - it tracks state (gate opens when the requirement is met)
//   - only a human on the clock gets it
//   - apply_move rejections carry the gate's reason
//   - checkGateConsistency (the load-bearing lock) agrees with getLegalMoves
//     across representative states

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../tools.js';
import { setSessionStore } from '../../core/sessions.js';
import { MemorySessionStore } from '../../core/store/memory.js';
import { registerGame } from '../../core/registry.js';
import { checkGateConsistency, unavailableMoves } from '@zekel/game-kit';
import { rulesTeachingStub } from './rulesTeachingStub.js';

let client: Client;

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
  };
  const text = r.content?.[0]?.text ?? '{}';
  return { isError: !!r.isError, data: JSON.parse(text) };
}

async function newSession(): Promise<string> {
  const res = await call('create_session', {
    game_id: 'rules-teaching-stub',
    players: [
      { player_id: 'p1', kind: 'human', name: 'Zeke' },
      { player_id: 'bot', kind: 'ai' },
    ],
  });
  expect(res.isError).toBe(false);
  return res.data.session_id as string;
}

beforeAll(async () => {
  setSessionStore(new MemorySessionStore());
  registerGame(rulesTeachingStub);
  const server = new McpServer({ name: 'test', version: '0' }, { capabilities: { tools: {} } });
  registerTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
});

describe('ambient grey list on get_legal_moves', () => {
  it('lists blocked move types with live gate reasons for the human on the clock', async () => {
    const sid = await newSession();
    const res = await call('get_legal_moves', { session_id: sid, player_id: 'p1' });
    expect(res.isError).toBe(false);
    const grey = res.data.unavailable_moves as Array<Record<string, unknown>>;
    expect(grey).toEqual([
      {
        move_type: 'power_strike',
        reason: 'needs 2 Energy, you have 0',
        rules_section: 'power-strike',
      },
      {
        move_type: 'celebrate',
        reason: 'only possible during the victory phase',
        rules_section: 'celebrating',
      },
    ]);
    expect(typeof res.data.unavailable_note).toBe('string');
    // The offered set never appears greyed.
    const offered = (res.data.legal_moves as Array<{ move: { type: string } }>).map(
      (m) => m.move.type,
    );
    expect(offered).toContain('advance');
    expect(offered).toContain('rest');
    expect(offered).not.toContain('power_strike');
  });

  it('updates with live state — the gate opens at 2 Energy', async () => {
    const sid = await newSession();
    await call('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'rest' } });
    const mid = await call('get_legal_moves', { session_id: sid, player_id: 'p1' });
    const midGrey = mid.data.unavailable_moves as Array<Record<string, unknown>>;
    expect(midGrey.find((g) => g.move_type === 'power_strike')?.reason).toBe(
      'needs 2 Energy, you have 1',
    );
    await call('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'rest' } });
    const after = await call('get_legal_moves', { session_id: sid, player_id: 'p1' });
    const afterGrey = after.data.unavailable_moves as Array<Record<string, unknown>>;
    expect(afterGrey.find((g) => g.move_type === 'power_strike')).toBeUndefined();
    const offered = (after.data.legal_moves as Array<{ move: { type: string } }>).map(
      (m) => m.move.type,
    );
    expect(offered).toContain('power_strike');
  });

  it('is absent for a seat that is not on the clock and for AI seats', async () => {
    const sid = await newSession();
    const offTurn = await call('get_legal_moves', { session_id: sid, player_id: 'bot' });
    expect(offTurn.data.unavailable_moves).toBeUndefined();
    // Pass the turn to the AI; now the human is off the clock.
    await call('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'advance' } });
    const human = await call('get_legal_moves', { session_id: sid, player_id: 'p1' });
    expect(human.data.unavailable_moves).toBeUndefined();
  });
});

describe('gate-aware rejection enrichment on apply_move', () => {
  it('appends the live gate reason to an engine rejection', async () => {
    const sid = await newSession();
    const res = await call('apply_move', {
      session_id: sid,
      player_id: 'p1',
      move: { type: 'power_strike' },
    });
    expect(res.isError).toBe(true);
    expect(res.data.message).toContain('power_strike requires 2 Energy.');
    expect(res.data.message).toContain('Why: power_strike — needs 2 Energy, you have 0.');
  });

  it('leaves rejections untouched once the gate is open (engine still decides)', async () => {
    const sid = await newSession();
    await call('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'rest' } });
    await call('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'rest' } });
    const res = await call('apply_move', {
      session_id: sid,
      player_id: 'p1',
      move: { type: 'power_strike' },
    });
    expect(res.isError).toBe(false);
  });
});

describe('checkGateConsistency — the load-bearing lock', () => {
  // The pattern M4 replicates per game: sweep representative states and assert
  // the hook and getLegalMoves agree everywhere.
  it('agrees with getLegalMoves across energy 0/1/2 and both phases', () => {
    const base = rulesTeachingStub.createSession([
      { player_id: 'p1', kind: 'human' },
      { player_id: 'bot', kind: 'ai' },
    ]);
    for (const energy of [0, 1, 2, 5]) {
      for (const phase of ['main', 'victory'] as const) {
        const state = {
          ...base,
          gameState: { energy: { p1: energy, bot: 0 }, phase },
        };
        const gates = rulesTeachingStub.describeMoveGates!(state, 'p1');
        const legal = rulesTeachingStub.getLegalMoves(state, 'p1');
        expect(checkGateConsistency(gates, legal)).toEqual([]);
      }
    }
  });

  it('reports both directions of disagreement', () => {
    const legal = [{ move_id: 'x', description: 'x', move: { type: 'rest' } }];
    expect(
      checkGateConsistency(
        [
          { move_type: 'rest', status: 'gated', reason: 'nope' },
          { move_type: 'power_strike', status: 'available' },
        ],
        legal,
      ),
    ).toEqual([
      "gate says 'rest' is gated but getLegalMoves offers it",
      "gate says 'power_strike' is available but getLegalMoves offers no instance",
    ]);
  });

  it('unavailableMoves never greys an offered or available type', () => {
    const legal = [{ move_id: 'x', description: 'x', move: { type: 'rest' } }];
    const grey = unavailableMoves(
      [
        { move_type: 'rest', status: 'available' },
        { move_type: 'power_strike', status: 'available' }, // inconsistent — but never greyed
        { move_type: 'celebrate', status: 'routine' }, // no reason → generic fallback
      ],
      legal,
    );
    expect(grey).toEqual([{ move_type: 'celebrate', reason: 'not available right now' }]);
  });
});
