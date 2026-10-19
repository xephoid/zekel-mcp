// Locks the create_session legibility contract (docs/assistant-model-finetune.md,
// "First real-session capture"): the published schema keeps kind/difficulty as
// plain strings so imperfect calls REACH the server (instead of dying on a
// client-side schema check with "input did not match expected schema"), and the
// server is tolerant in what it accepts (case/whitespace, ""=unset, difficulty
// on a human seat dropped) and specific in what it rejects (names the accepted
// forms). Plus the all-AI backstop warning for the observed weak-model mistake
// of marking every seat kind:"ai", the human's included.

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

afterAll(async () => {
  await client.close();
});

type Recorded = { player_id: string; kind: string; difficulty?: string };

describe('create_session seat normalization', () => {
  it('accepts the exact observed 9B slop: difficulty:"" and difficulty on a human seat', async () => {
    // The real captured failure was difficulty:"" on the (mis-kinded) human
    // seat — under strict enums it never reached the server at all.
    const res = await call('create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [
        { player_id: 'p1', kind: 'human', name: 'Zeke', difficulty: '' },
        { player_id: 'p2', kind: 'ai', difficulty: '' },
      ],
    });
    expect(res.isError).toBe(false);
    const recorded = res.data.players_recorded as Recorded[];
    expect(recorded.find((p) => p.player_id === 'p1')?.difficulty).toBeUndefined();
    // "" = unset → the default ladder applied, and the reminder to ask fires.
    expect(recorded.find((p) => p.player_id === 'p2')?.difficulty).toBe('mcts');
    expect(String(res.data.difficulty_reminder)).toContain('p2');
  });

  it('normalizes case and whitespace on kind and difficulty', async () => {
    const res = await call('create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [
        { player_id: 'p1', kind: ' Human ', name: 'Zeke' },
        { player_id: 'p2', kind: 'AI', difficulty: ' MEDIUM ' },
      ],
    });
    expect(res.isError).toBe(false);
    const recorded = res.data.players_recorded as Recorded[];
    expect(recorded.find((p) => p.player_id === 'p1')?.kind).toBe('human');
    expect(recorded.find((p) => p.player_id === 'p2')).toMatchObject({ kind: 'ai', difficulty: 'medium' });
    expect(res.data.difficulty_reminder).toBeUndefined();
  });

  it('rejects an unknown kind with a message naming the accepted forms', async () => {
    const res = await call('create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [
        { player_id: 'p1', kind: 'robot' },
        { player_id: 'p2', kind: 'ai' },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.data.message).toContain('"robot"');
    expect(res.data.message).toContain('"human"');
    expect(res.data.message).toContain('"ai"');
  });

  it('rejects an unknown difficulty with a message naming the accepted forms', async () => {
    const res = await call('create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [
        { player_id: 'p1', kind: 'human' },
        { player_id: 'p2', kind: 'ai', difficulty: 'impossible' },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.data.message).toContain('"impossible"');
    for (const level of ['easy', 'medium', 'hard', 'mcts']) {
      expect(res.data.message).toContain(level);
    }
    expect(res.data.message).toContain('omit');
  });
});

describe('the all-AI backstop', () => {
  it('warns (does not reject) when every seat is kind:"ai"', async () => {
    const res = await call('create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [
        { player_id: 'p1', kind: 'ai' },
        { player_id: 'p2', kind: 'ai' },
      ],
    });
    expect(res.isError).toBe(false); // the harness creates these on purpose
    expect(String(res.data.all_ai_reminder)).toContain('kind:"human"');
  });

  it('stays silent when a human seat exists', async () => {
    const res = await call('create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [
        { player_id: 'p1', kind: 'human', name: 'Zeke' },
        { player_id: 'p2', kind: 'ai', difficulty: 'medium' },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.data.all_ai_reminder).toBeUndefined();
  });
});
