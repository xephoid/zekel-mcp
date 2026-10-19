// Teach-on-first-encounter + the failed-gate lesson + the teaching preference
// (docs/rules-teaching.md M2), driven through the real MCP tool surface:
//   - the opening sections teach ONCE on create_session
//   - a newly offered move type teaches on the response that offered it
//   - a failed-gate rejection inlines the full section (channel 3) and marks it
//   - teaching off silences lessons but NOT the grey list
//   - per-seat isolation (teaching the host doesn't teach the other seat)
//   - undo: taughtSections reverts, seatPreferences survives

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

interface Briefing {
  for_player: string;
  sections: Array<{ id: string; title: string; text: string }>;
  teach_note: string;
}

function briefingOf(data: Record<string, unknown>): Briefing | undefined {
  return data.rules_briefing as Briefing | undefined;
}

async function newSession(): Promise<{ sid: string; created: Record<string, unknown> }> {
  const res = await call('create_session', {
    game_id: 'rules-teaching-stub',
    players: [
      { player_id: 'p1', kind: 'human', name: 'Zeke' },
      { player_id: 'bot', kind: 'ai' },
    ],
  });
  expect(res.isError).toBe(false);
  return { sid: res.data.session_id as string, created: res.data };
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

describe('teach-on-first-encounter (channel 2)', () => {
  it('teaches the opening sections once, on create_session', async () => {
    const { created } = await newSession();
    const briefing = briefingOf(created)!;
    expect(briefing).toBeDefined();
    expect(briefing.for_player).toBe('p1');
    // Phase-tagged section first, then the offered move types' sections.
    expect(briefing.sections.map((s) => s.id)).toEqual(['main-phase', 'advancing', 'resting']);
    expect(briefing.teach_note).toContain('Zeke');
    expect(briefing.teach_note).toContain('will NOT repeat');
  });

  it('does not repeat taught sections on the next read', async () => {
    const { sid } = await newSession();
    const res = await call('get_legal_moves', { session_id: sid, player_id: 'p1' });
    expect(briefingOf(res.data)).toBeUndefined();
    const state = await call('get_state', { session_id: sid, player_id: 'p1' });
    expect(briefingOf(state.data)).toBeUndefined();
  });

  it('teaches a newly offered move type on the response that first offers it', async () => {
    const { sid } = await newSession();
    const first = await call('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'rest' } });
    expect(briefingOf(first.data)).toBeUndefined(); // nothing new at 1 Energy
    const second = await call('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'rest' } });
    const briefing = briefingOf(second.data)!;
    expect(briefing).toBeDefined();
    expect(briefing.sections.map((s) => s.id)).toEqual(['power-strike']);
    // And never again.
    const after = await call('get_legal_moves', { session_id: sid, player_id: 'p1' });
    expect(briefingOf(after.data)).toBeUndefined();
  });
});

describe('failed-gate lesson (channel 3)', () => {
  it('inlines the full section on a gated rejection and marks it taught', async () => {
    const { sid } = await newSession();
    const res = await call('apply_move', {
      session_id: sid,
      player_id: 'p1',
      move: { type: 'power_strike' },
    });
    expect(res.isError).toBe(true);
    const details = res.data.details as Record<string, unknown>;
    const briefing = details.rules_briefing as Briefing;
    expect(briefing.sections.map((s) => s.id)).toEqual(['power-strike']);
    expect(briefing.sections[0]!.text).toContain('Power Strike costs 2 Energy');
    // Marked taught: opening the gate later does NOT re-teach it.
    await call('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'rest' } });
    const second = await call('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'rest' } });
    expect(briefingOf(second.data)).toBeUndefined();
    const session = await getSession(sid);
    expect(session.taughtSections?.p1).toContain('power-strike');
  });
});

describe('teaching preference', () => {
  it('off silences lessons and the rejection lesson, but never the grey list', async () => {
    const { sid } = await newSession();
    (await getSession(sid)).seatPreferences = { p1: { teaching: false } };
    // Rejection still enriched with the live reason, but carries no lesson.
    const rejected = await call('apply_move', {
      session_id: sid,
      player_id: 'p1',
      move: { type: 'power_strike' },
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.data.message).toContain('needs 2 Energy, you have 0');
    expect((rejected.data.details as Record<string, unknown> | undefined)?.rules_briefing).toBeUndefined();
    // The gate opening teaches nothing…
    await call('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'rest' } });
    const second = await call('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'rest' } });
    expect(briefingOf(second.data)).toBeUndefined();
    // …but the grey list still rides for what remains blocked (desync guard).
    const legal = await call('get_legal_moves', { session_id: sid, player_id: 'p1' });
    const grey = legal.data.unavailable_moves as Array<Record<string, unknown>>;
    expect(grey.some((g) => g.move_type === 'celebrate')).toBe(true);
  });
});

describe('per-seat isolation', () => {
  it('teaching the first seat does not teach the second', async () => {
    const res = await call('create_session', {
      game_id: 'rules-teaching-stub',
      players: [
        { player_id: 'p1', kind: 'human', name: 'Zeke' },
        { player_id: 'p2', kind: 'human', name: 'Guest' },
      ],
    });
    const sid = res.data.session_id as string;
    expect(briefingOf(res.data)!.for_player).toBe('p1');
    // p1 hands the turn to p2 — p2 now gets their own first lesson.
    const advanced = await call('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'advance' } });
    const briefing = briefingOf(advanced.data)!;
    expect(briefing.for_player).toBe('p2');
    expect(briefing.sections.map((s) => s.id)).toEqual(['main-phase', 'advancing', 'resting']);
    expect(briefing.teach_note).toContain('Guest');
    const session = await getSession(sid);
    expect(session.taughtSections?.p1).toEqual(['main-phase', 'advancing', 'resting']);
    expect(session.taughtSections?.p2).toEqual(['main-phase', 'advancing', 'resting']);
  });
});

describe('undo semantics', () => {
  it('reverts taughtSections but carries seatPreferences forward', async () => {
    const { sid } = await newSession();
    await call('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'rest' } });
    // Second rest opens the gate → teaches power-strike.
    await call('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'rest' } });
    expect((await getSession(sid)).taughtSections?.p1).toContain('power-strike');
    // Preference set AFTER those moves (not in any snapshot).
    (await getSession(sid)).seatPreferences = { p1: { teaching: false } };
    const undone = await call('undo', { session_id: sid });
    expect(undone.isError).toBe(false);
    const session = await getSession(sid);
    // The lesson reverted with the state it belonged to…
    expect(session.taughtSections?.p1 ?? []).not.toContain('power-strike');
    // …but the preference survived: it is not a game event.
    expect(session.seatPreferences?.p1?.teaching).toBe(false);
  });
});
