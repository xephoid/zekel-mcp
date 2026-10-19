import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { llmDrivenContext, withClientMode, type ConnectionContext } from './clientMode.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GameError } from '@zekel/game-kit';
import { toGameMetadata } from '@zekel/game-kit';
import { getGame, listRegisteredGames } from '../core/registry.js';
import { getSession, getSessionsForGame } from '../core/sessions.js';
import { verifySeatAuth } from '../core/joinAuth.js';
import { buildNextStep } from './nextStep.js';

function jsonContents(uri: URL, payload: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function textContents(uri: URL, text: string) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'text/markdown',
        text,
      },
    ],
  };
}

export function registerResources(rawServer: McpServer, ctx: ConnectionContext = llmDrivenContext()): void {
  // Resource bodies are shaped for the connection's declared mode too (the
  // session-player resource carries next_step) — see src/mcp/clientMode.ts.
  const server = withClientMode(rawServer, ctx);
  server.registerResource(
    'catalog',
    'game://catalog',
    {
      title: 'Game catalog',
      description: 'List of every game this server supports.',
      mimeType: 'application/json',
    },
    (uri) =>
      jsonContents(uri, { games: listRegisteredGames().map(toGameMetadata) }),
  );

  server.registerResource(
    'game-meta',
    new ResourceTemplate('game://{game_id}', { list: undefined }),
    {
      title: 'Game metadata',
      description: 'Metadata and rules for a specific game.',
      mimeType: 'application/json',
    },
    (uri, vars) => {
      const id = String(vars.game_id);
      // Avoid colliding with "game://catalog"
      if (id === 'catalog') {
        return jsonContents(uri, { games: listRegisteredGames().map(toGameMetadata) });
      }
      const game = getGame(id);
      return jsonContents(uri, toGameMetadata(game));
    },
  );

  server.registerResource(
    'game-rules',
    new ResourceTemplate('game://{game_id}/rules', { list: undefined }),
    {
      title: 'Game rules',
      description: 'Rules text for a specific game.',
      mimeType: 'text/markdown',
    },
    (uri, vars) => {
      const game = getGame(String(vars.game_id));
      const rules = game.getRulesText?.() ?? `No rules text available for ${game.id}.`;
      return textContents(uri, rules);
    },
  );

  server.registerResource(
    'game-sessions',
    new ResourceTemplate('game://{game_id}/sessions', { list: undefined }),
    {
      title: 'Active sessions for a game',
      description: 'List of active sessions for a given game.',
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const id = String(vars.game_id);
      getGame(id); // throws if unknown
      const sessions = (await getSessionsForGame(id)).map((s) => ({
        session_id: s.sessionId,
        active_player_id: s.activePlayerId,
        turn_number: s.turnNumber,
        created_at: s.createdAt,
      }));
      return jsonContents(uri, { sessions });
    },
  );

  server.registerResource(
    'session-public',
    new ResourceTemplate('game://{game_id}/sessions/{session_id}', { list: undefined }),
    {
      title: 'Public session state',
      description: 'Public (non-hidden) view of a session. Hidden information is omitted.',
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const session = await getSession(String(vars.session_id));
      const game = getGame(session.gameId);
      if (game.id !== String(vars.game_id)) {
        throw new GameError(
          'SESSION_NOT_FOUND',
          `Session ${session.sessionId} belongs to ${game.id}, not ${vars.game_id}`,
        );
      }
      return jsonContents(uri, game.getPublicView(session));
    },
  );

  server.registerResource(
    'session-player',
    new ResourceTemplate('game://{game_id}/sessions/{session_id}/player/{player_id}', {
      list: undefined,
    }),
    {
      title: 'Per-player session state',
      description:
        'A specific player\'s full view of the session, including their hidden information. For a multi-device session (a seat claimed via join_session), pass the seat\'s token as an auth_token query param, e.g. .../player/p2?auth_token=XXX — the host_token for non-remote seats, the claim_token for a remote seat. Single-device sessions need no token.',
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const session = await getSession(String(vars.session_id));
      const game = getGame(session.gameId);
      if (game.id !== String(vars.game_id)) {
        throw new GameError(
          'SESSION_NOT_FOUND',
          `Session ${session.sessionId} belongs to ${game.id}, not ${vars.game_id}`,
        );
      }
      // Same multi-device auth as get_state — a private view requires the seat's
      // token once the session has a remote player. Token rides as a query param
      // since resources are URI-addressed. No-op for single-device sessions.
      verifySeatAuth(session, String(vars.player_id), uri.searchParams.get('auth_token') ?? undefined);
      const view = game.getPlayerView(session, String(vars.player_id));
      const next_step = buildNextStep(session, game.isGameOver(session), game);
      return jsonContents(
        uri,
        view && typeof view === 'object'
          ? { ...(view as Record<string, unknown>), next_step }
          : { state: view, next_step },
      );
    },
  );

  server.registerResource(
    'session-log',
    new ResourceTemplate('game://{game_id}/sessions/{session_id}/log', { list: undefined }),
    {
      title: 'Session move log',
      description: 'Append-only log of moves applied to a session.',
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const session = await getSession(String(vars.session_id));
      const game = getGame(session.gameId);
      if (game.id !== String(vars.game_id)) {
        throw new GameError(
          'SESSION_NOT_FOUND',
          `Session ${session.sessionId} belongs to ${game.id}, not ${vars.game_id}`,
        );
      }
      // Prefer the game's rich, replayable log when it self-logs (getLog);
      // otherwise the generic move log (auto-enriched with deltas via getScoreboard).
      const richLog = game.getLog?.(session);
      return jsonContents(uri, {
        session_id: session.sessionId,
        ...(richLog ? { log: richLog } : {}),
        moves: session.moveLog,
      });
    },
  );
}
