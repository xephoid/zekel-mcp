// set_session_preferences + the create_session teaching option (docs/
// rules-teaching.md M3): seeding at creation, mid-game toggling ("off" is not
// "taught"), not-a-game-move guarantees (no move log entry, nothing undoable),
// and multi-device seat auth.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../tools.js';
import { getSession, setSessionStore } from '../../core/sessions.js';
import { MemorySessionStore } from '../../core/store/memory.js';
import { registerGame } from '../../core/registry.js';
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

describe('create_session teaching option', () => {
  it('teaching:false suppresses the opening lesson and is recorded per seat', async () => {
    const res = await call('create_session', {
      game_id: 'rules-teaching-stub',
      players: [
        { player_id: 'p1', kind: 'human', name: 'Zeke', teaching: false },
        { player_id: 'bot', kind: 'ai' },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.data.rules_briefing).toBeUndefined();
    const session = await getSession(res.data.session_id as string);
    expect(session.seatPreferences?.p1?.teaching).toBe(false);
    // The preference never leaks onto the seat's PlayerConfig.
    expect((session.players[0] as Record<string, unknown>).teaching).toBeUndefined();
  });
});

describe('set_session_preferences', () => {
  it('toggles mid-game; re-enabling teaches what was never taught (off is not taught)', async () => {
    const created = await call('create_session', {
      game_id: 'rules-teaching-stub',
      players: [
        { player_id: 'p1', kind: 'human', name: 'Zeke' },
        { player_id: 'bot', kind: 'ai' },
      ],
    });
    const sid = created.data.session_id as string;
    // Turn teaching off, then open the power_strike gate silently.
    const off = await call('set_session_preferences', {
      session_id: sid,
      player_id: 'p1',
      preferences: { teaching: false },
    });
    expect(off.isError).toBe(false);
    expect((off.data.preferences as Record<string, unknown>).teaching).toBe(false);
    await call('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'rest' } });
    const opened = await call('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'rest' } });
    expect(opened.data.rules_briefing).toBeUndefined();
    // Re-enable: the never-taught section now teaches on the next response.
    await call('set_session_preferences', {
      session_id: sid,
      player_id: 'p1',
      preferences: { teaching: true },
    });
    const legal = await call('get_legal_moves', { session_id: sid, player_id: 'p1' });
    const briefing = legal.data.rules_briefing as { sections: Array<{ id: string }> };
    expect(briefing.sections.map((s) => s.id)).toEqual(['power-strike']);
  });

  it('is not a game move: no move log entry, nothing to undo', async () => {
    const created = await call('create_session', {
      game_id: 'rules-teaching-stub',
      players: [
        { player_id: 'p1', kind: 'human', name: 'Zeke' },
        { player_id: 'bot', kind: 'ai' },
      ],
    });
    const sid = created.data.session_id as string;
    await call('set_session_preferences', {
      session_id: sid,
      player_id: 'p1',
      preferences: { teaching: false },
    });
    const session = await getSession(sid);
    expect(session.moveLog).toHaveLength(0);
    const undone = await call('undo', { session_id: sid });
    expect(undone.data.undone).toBe(false);
  });

  it('rejects an unknown seat', async () => {
    const created = await call('create_session', {
      game_id: 'rules-teaching-stub',
      players: [
        { player_id: 'p1', kind: 'human', name: 'Zeke' },
        { player_id: 'bot', kind: 'ai' },
      ],
    });
    const res = await call('set_session_preferences', {
      session_id: created.data.session_id as string,
      player_id: 'ghost',
      preferences: { teaching: false },
    });
    expect(res.isError).toBe(true);
    expect(res.data.error_code).toBe('PLAYER_NOT_FOUND');
  });
});

describe('multi-device seat auth', () => {
  it('a claimed seat needs its claim_token; the host token covers the rest', async () => {
    const created = await call('create_session', {
      game_id: 'rules-teaching-stub',
      players: [
        { player_id: 'p1', kind: 'human', name: 'Host' },
        { player_id: 'p2', kind: 'human', name: 'Guest' },
      ],
    });
    const sid = created.data.session_id as string;
    const join = created.data.join as { join_code: string; host_token: string };
    const joined = await call('join_session', { join_code: join.join_code, name: 'Guest' });
    expect(joined.isError).toBe(false);
    const claimToken = joined.data.claim_token as string;

    // No token → rejected.
    const bare = await call('set_session_preferences', {
      session_id: sid,
      player_id: 'p2',
      preferences: { teaching: false },
    });
    expect(bare.isError).toBe(true);
    // The remote's own claim token → allowed.
    const own = await call('set_session_preferences', {
      session_id: sid,
      player_id: 'p2',
      preferences: { teaching: false },
      auth_token: claimToken,
    });
    expect(own.isError).toBe(false);
    // The host token does NOT reach a claimed seat…
    const hostOnClaimed = await call('set_session_preferences', {
      session_id: sid,
      player_id: 'p2',
      preferences: { teaching: true },
      auth_token: join.host_token,
    });
    expect(hostOnClaimed.isError).toBe(true);
    // …but covers the host's own (unclaimed) seat.
    const hostOwn = await call('set_session_preferences', {
      session_id: sid,
      player_id: 'p1',
      preferences: { teaching: false },
      auth_token: join.host_token,
    });
    expect(hostOwn.isError).toBe(false);
  });
});
