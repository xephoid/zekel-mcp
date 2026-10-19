// End-to-end test of the join_session feature driven through the REAL MCP tool
// surface (an in-memory client ↔ server), so it exercises create_session →
// join_session → seat-auth enforcement exactly as a second device would.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../tools.js';
import { buildNextStep } from '../nextStep.js';
import { setSessionStore } from '../../core/sessions.js';
import { MemorySessionStore } from '../../core/store/memory.js';
import { registerGame } from '../../core/registry.js';
import { hashToken } from '../../core/joinAuth.js';
import type { SessionState } from '@zekel/game-kit';
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

async function createTwoHumanGame() {
  const res = await call('create_session', {
    game_id: 'lucky-tic-tac-toe',
    players: [
      { player_id: 'p1', kind: 'human', name: 'Host' },
      { player_id: 'p2', kind: 'human', name: 'Guest' },
    ],
  });
  expect(res.isError).toBe(false);
  return res.data;
}

describe('create_session join provisioning', () => {
  it('issues a join code + host token + open seats for a multi-human game', async () => {
    const data = await createTwoHumanGame();
    const join = data.join as Record<string, unknown>;
    expect(join).toBeDefined();
    expect(String(join.join_code)).toHaveLength(4);
    expect(join.host_player_id).toBe('p1');
    expect(typeof join.host_token).toBe('string');
    expect(join.open_seats).toEqual(['p2']);
  });

  it('does NOT issue join info for a solo-vs-AI game (no open human seat)', async () => {
    const res = await call('create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [
        { player_id: 'p1', kind: 'human' },
        { player_id: 'ai', kind: 'ai' },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.data.join).toBeUndefined();
  });

  it('honors an explicit host_player_id', async () => {
    const res = await call('create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [
        { player_id: 'p1', kind: 'human' },
        { player_id: 'p2', kind: 'human' },
      ],
      host_player_id: 'p2',
    });
    const join = res.data.join as Record<string, unknown>;
    expect(join.host_player_id).toBe('p2');
    expect(join.open_seats).toEqual(['p1']);
  });
});

describe('human naming reminder', () => {
  it('flags human seats created without a real name', async () => {
    const res = await call('create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [
        { player_id: 'p1', kind: 'human' }, // no name
        { player_id: 'ai', kind: 'ai' },
      ],
    });
    expect(res.isError).toBe(false);
    expect(typeof res.data.naming_reminder).toBe('string');
    expect(res.data.naming_reminder as string).toContain('p1');
  });

  it('is silent when every human seat has a real name', async () => {
    const res = await call('create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [
        { player_id: 'p1', kind: 'human', name: 'Alice' },
        { player_id: 'ai', kind: 'ai', difficulty: 'hard' },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.data.naming_reminder).toBeUndefined();
  });
});

describe('AI difficulty reminder', () => {
  it('flags AI seats created without an explicit difficulty', async () => {
    const res = await call('create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [
        { player_id: 'p1', kind: 'human', name: 'Alice' },
        { player_id: 'ai', kind: 'ai' }, // no difficulty
      ],
    });
    expect(res.isError).toBe(false);
    expect(typeof res.data.difficulty_reminder).toBe('string');
    expect(res.data.difficulty_reminder as string).toContain('ai');
  });

  it('is silent when every AI seat has an explicit difficulty', async () => {
    const res = await call('create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [
        { player_id: 'p1', kind: 'human', name: 'Alice' },
        { player_id: 'ai', kind: 'ai', difficulty: 'easy' },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.data.difficulty_reminder).toBeUndefined();
  });
});

describe('join_session', () => {
  it('claims the open seat and returns a private claim token', async () => {
    const data = await createTwoHumanGame();
    const join = data.join as Record<string, unknown>;
    const res = await call('join_session', { join_code: join.join_code as string, name: 'Bob' });
    expect(res.isError).toBe(false);
    expect(res.data.player_id).toBe('p2');
    expect(typeof res.data.claim_token).toBe('string');
  });

  it('is case/space-insensitive on the code', async () => {
    const data = await createTwoHumanGame();
    const code = (data.join as Record<string, unknown>).join_code as string;
    const res = await call('join_session', { join_code: ` ${code.toLowerCase()} ` });
    expect(res.isError).toBe(false);
    expect(res.data.player_id).toBe('p2');
  });

  it('rejects an unknown code', async () => {
    const res = await call('join_session', { join_code: '----' });
    expect(res.isError).toBe(true);
    expect(res.data.error_code).toBe('JOIN_CODE_NOT_FOUND');
  });

  it('rejects a second joiner when no seat is left', async () => {
    const data = await createTwoHumanGame();
    const code = (data.join as Record<string, unknown>).join_code as string;
    await call('join_session', { join_code: code });
    const second = await call('join_session', { join_code: code });
    expect(second.isError).toBe(true);
    expect(second.data.error_code).toBe('NO_OPEN_SEAT');
  });
});

describe('seat auth enforcement after a join', () => {
  async function joined() {
    const data = await createTwoHumanGame();
    const join = data.join as Record<string, unknown>;
    const j = await call('join_session', { join_code: join.join_code as string });
    return {
      sessionId: data.session_id as string,
      hostToken: join.host_token as string,
      claimToken: j.data.claim_token as string,
    };
  }

  it('lets unauthenticated calls through BEFORE anyone joins (single-device)', async () => {
    const data = await createTwoHumanGame();
    const res = await call('get_legal_moves', {
      session_id: data.session_id as string,
      player_id: 'p1',
    });
    expect(res.isError).toBe(false);
  });

  it('requires the host token for the host seat once multi-device', async () => {
    const { sessionId, hostToken } = await joined();
    const noAuth = await call('get_legal_moves', { session_id: sessionId, player_id: 'p1' });
    expect(noAuth.isError).toBe(true);
    expect(noAuth.data.error_code).toBe('SEAT_AUTH_REQUIRED');

    const withHost = await call('get_legal_moves', {
      session_id: sessionId,
      player_id: 'p1',
      auth_token: hostToken,
    });
    expect(withHost.isError).toBe(false);
  });

  it('forbids the host from reading the remote seat, but allows the remote', async () => {
    const { sessionId, hostToken, claimToken } = await joined();

    const hostPeek = await call('get_state', {
      session_id: sessionId,
      player_id: 'p2',
      auth_token: hostToken,
    });
    expect(hostPeek.isError).toBe(true);
    expect(hostPeek.data.error_code).toBe('INVALID_SEAT_AUTH');

    const remoteOwn = await call('get_state', {
      session_id: sessionId,
      player_id: 'p2',
      auth_token: claimToken,
    });
    expect(remoteOwn.isError).toBe(false);
  });

  it('forbids the remote from acting on the host seat', async () => {
    const { sessionId, claimToken } = await joined();
    const res = await call('get_state', {
      session_id: sessionId,
      player_id: 'p1',
      auth_token: claimToken,
    });
    expect(res.isError).toBe(true);
    expect(res.data.error_code).toBe('INVALID_SEAT_AUTH');
  });
});

describe('release_seat', () => {
  async function joined() {
    const data = await createTwoHumanGame();
    const join = data.join as Record<string, unknown>;
    const j = await call('join_session', { join_code: join.join_code as string });
    return {
      sessionId: data.session_id as string,
      code: join.join_code as string,
      hostToken: join.host_token as string,
      claimToken: j.data.claim_token as string,
    };
  }

  it('lets the host reclaim a seat, dropping back to single-device', async () => {
    const { sessionId, hostToken } = await joined();
    const res = await call('release_seat', {
      session_id: sessionId,
      player_id: 'p2',
      auth_token: hostToken,
    });
    expect(res.isError).toBe(false);
    expect(res.data.multi_device).toBe(false);

    // Auth is off again: the host can act on every seat with no token.
    const noAuth = await call('get_legal_moves', { session_id: sessionId, player_id: 'p1' });
    expect(noAuth.isError).toBe(false);
  });

  it('lets the remote player release their own seat with their claim_token', async () => {
    const { sessionId, claimToken } = await joined();
    const res = await call('release_seat', {
      session_id: sessionId,
      player_id: 'p2',
      auth_token: claimToken,
    });
    expect(res.isError).toBe(false);
  });

  it('reopens the seat for a fresh join while still in setup', async () => {
    const { sessionId, code, hostToken } = await joined();
    await call('release_seat', { session_id: sessionId, player_id: 'p2', auth_token: hostToken });
    const rejoin = await call('join_session', { join_code: code });
    expect(rejoin.isError).toBe(false);
    expect(rejoin.data.player_id).toBe('p2');
  });

  it('rejects releasing a seat nobody holds', async () => {
    const data = await createTwoHumanGame();
    const res = await call('release_seat', {
      session_id: data.session_id as string,
      player_id: 'p1',
      auth_token: (data.join as Record<string, unknown>).host_token as string,
    });
    expect(res.isError).toBe(true);
    expect(res.data.error_code).toBe('SEAT_NOT_CLAIMED');
  });
});

describe('reassign_seat', () => {
  it('rotates the token: the old one stops working, the new one works', async () => {
    const data = await createTwoHumanGame();
    const join = data.join as Record<string, unknown>;
    const sessionId = data.session_id as string;
    const j = await call('join_session', { join_code: join.join_code as string });
    const oldToken = j.data.claim_token as string;

    const re = await call('reassign_seat', {
      session_id: sessionId,
      player_id: 'p2',
      auth_token: join.host_token as string,
    });
    expect(re.isError).toBe(false);
    const newToken = re.data.claim_token as string;
    expect(newToken).not.toBe(oldToken);

    const withOld = await call('get_state', {
      session_id: sessionId,
      player_id: 'p2',
      auth_token: oldToken,
    });
    expect(withOld.isError).toBe(true);
    expect(withOld.data.error_code).toBe('INVALID_SEAT_AUTH');

    const withNew = await call('get_state', {
      session_id: sessionId,
      player_id: 'p2',
      auth_token: newToken,
    });
    expect(withNew.isError).toBe(false);
  });

  it('rejects reassigning a seat nobody holds', async () => {
    const data = await createTwoHumanGame();
    const res = await call('reassign_seat', {
      session_id: data.session_id as string,
      player_id: 'p2',
      auth_token: (data.join as Record<string, unknown>).host_token as string,
    });
    expect(res.isError).toBe(true);
    expect(res.data.error_code).toBe('SEAT_NOT_CLAIMED');
  });
});

describe('remote-seat next_step directive', () => {
  it('tells the host to wait when it is a claimed seat\'s turn', () => {
    const state = {
      sessionId: 's',
      gameId: 'g',
      players: [
        { player_id: 'p1', kind: 'human', name: 'Host' },
        { player_id: 'p2', kind: 'human', name: 'Bob' },
      ],
      activePlayerId: 'p2',
      turnNumber: 2,
      gameState: {},
      moveLog: [],
      createdAt: 'now',
      hostPlayerId: 'p1',
      hostTokenHash: hashToken('h'),
      seatClaims: { p2: { tokenHash: hashToken('c'), name: 'Bob', claimedAt: 'now' } },
    } as SessionState<unknown>;
    const step = buildNextStep(state, null);
    expect(step.status).toBe('human_to_move');
    expect(step.active_player_id).toBe('p2');
    expect(step.instruction).toContain('REMOTE');
    expect(step.instruction).toContain('WAIT');
    expect(step.instruction).toContain('Bob');
  });
});
