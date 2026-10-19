import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { registerAIPlugin, type AIMovePlugin } from '../core/aiPlugins.js';
import { listRegisteredGames } from '../core/registry.js';
import { setSessionStore, rebuildJoinCodeIndex } from '../core/sessions.js';
import { createSessionStoreFromEnv } from '../core/store/fromEnv.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerTools } from '../mcp/tools.js';
import { registerResources } from '../mcp/resources.js';
import { registerGameExtensions } from '../mcp/extensions.js';
import { installClientModeDetection, llmDrivenContext, withClientMode } from '../mcp/clientMode.js';
import { DEBUG_PAGE_HTML } from './debugPage.js';
import { GALLERY_PAGE_HTML } from './galleryPage.js';

// Shared server bootstrap: transport plumbing (stdio + streamable HTTP), store
// selection, and join-code index rebuild — extracted from src/index.ts.
// (Originally shared with the since-merged solo-RPG sibling entrypoint; kept
// separate from index.ts because the transport/store lifecycle is independent
// of which games an entrypoint registers.) smoke-mcp.mjs and
// check-persistence.mjs lock the server end-to-end.
export interface RunServerOptions {
  serverInfo: { readonly name: string; readonly version: string };
  instructions: string;
  /** Server instructions for a connection that declares orchestrated mode
   *  (src/mcp/clientMode.ts). Defaults to `instructions`. */
  orchestratedInstructions?: string;
  /** Register this entrypoint's games into the process-global registry. */
  registerGames: () => void;
  /** Outside AIs that pick moves for seats with a difficulty they claim
   *  (src/core/aiPlugins.ts), e.g. the hyperon brain. */
  aiPlugins?: readonly AIMovePlugin[];
}

// Build one McpServer for ONE connection, with tools/resources wired up. Each
// connection gets its own context: the client mode it declares at initialize
// (src/mcp/clientMode.ts) decides the server instructions it is answered with
// and how every response is shaped. The mode is never stored on a game
// session. Exported so tests run exactly this wiring over an in-memory transport.
export function buildMcpServer(
  opts: Pick<RunServerOptions, 'serverInfo' | 'instructions' | 'orchestratedInstructions'>,
): McpServer {
  const ctx = llmDrivenContext();
  const server = new McpServer(opts.serverInfo, {
    capabilities: { tools: {}, resources: {} },
    instructions: opts.instructions,
  });
  installClientModeDetection(server, ctx, (mode) =>
    mode === 'orchestrated' ? (opts.orchestratedInstructions ?? opts.instructions) : opts.instructions,
  );
  registerTools(server, ctx);
  registerResources(server, ctx);
  // Tools/resources the registered games add themselves (Game.getExtraTools /
  // getExtraResources, e.g. Warble Way Galaxy's get_lore).
  registerGameExtensions(withClientMode(server, ctx));
  return server;
}

export async function runServer(opts: RunServerOptions): Promise<void> {
  // A fresh McpServer per connection (one per HTTP session; one for stdio). The
  // session store itself is a process-wide singleton — game sessions are shared
  // across MCP clients, keyed by session_id.
  const buildServer = (): McpServer => buildMcpServer(opts);

  // Stdio transport — single-client. Used by the harness and any local Claude
  // Code / MCP Inspector session that spawns the server as a subprocess.
  async function startStdio(): Promise<void> {
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Log to stderr so it doesn't interfere with MCP JSON-RPC on stdout.
    process.stderr.write(`${opts.serverInfo.name} listening on stdio\n`);
  }

  // Streamable HTTP transport — multi-client. Each client gets a separate
  // session_id; the transports map keeps per-session state.
  async function startHttp(): Promise<void> {
    // Lazy-imported because Express adds startup latency we don't want when
    // running stdio-mode (the harness spawns the compiled server thousands of
    // times per test run).
    const expressModule = await import('express');
    const express = expressModule.default;
    type ExpressRequest = import('express').Request;
    type ExpressResponse = import('express').Response;

    const port = Number(process.env.PORT ?? 3000);
    const expectedBearer = process.env.MCP_BEARER_TOKEN;
    if (!expectedBearer) {
      process.stderr.write(
        'WARNING: MCP_BEARER_TOKEN not set. The HTTP endpoint will accept ' +
          'all requests. Do not deploy this to a public network without ' +
          'setting a token.\n',
      );
    }

    const app = express();
    app.use(express.json());

    // One transport per session_id. The MCP spec routes follow-up requests
    // back to the transport that handled `initialize`.
    const transports: Record<string, StreamableHTTPServerTransport> = {};

    // Health endpoint — outside auth, hosting platforms hit this to verify
    // the process is alive.
    app.get('/healthz', (_req, res) => {
      res.json({ ok: true, name: opts.serverInfo.name, version: opts.serverInfo.version });
    });

    // The v0 web debug client (docs/board-viz.md) — a static page that speaks
    // MCP JSON-RPC to /mcp from the browser. Served outside auth (it contains
    // no secrets); the page itself sends the bearer token with each /mcp call.
    app.get('/debug', (_req, res) => {
      res.type('html').send(DEBUG_PAGE_HTML);
    });

    // The zekel-* component library (docs/board-viz.md): compiled ES modules
    // served straight from dist/web (no bundler — the browser imports them
    // natively), plus the component gallery. Both static, outside auth.
    const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    // Each game's board drawing is served from the folder the game names
    // (Game.webAssetsDir), so it works the same for a game installed as a
    // package. A game with no drawing names none and none of its code is served.
    for (const game of listRegisteredGames()) {
      if (game.webAssetsDir) app.use(`/web/games/${game.id}`, express.static(game.webAssetsDir));
    }
    app.use('/web', express.static(path.join(distDir, 'web'), { fallthrough: false }));
    app.get('/gallery', (_req, res) => {
      res.type('html').send(GALLERY_PAGE_HTML);
    });

    // Bearer-token middleware. Skipped entirely if MCP_BEARER_TOKEN is unset
    // (dev mode). Applies to /mcp only — /healthz remains unauthenticated.
    app.use('/mcp', (req, res, next) => {
      if (!expectedBearer) {
        next();
        return;
      }
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${expectedBearer}`) {
        res.status(401).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized' },
          id: null,
        });
        return;
      }
      next();
    });

    // POST /mcp — JSON-RPC requests. Initialize creates a new transport+server
    // pair; follow-up requests with a session_id reuse the existing one.
    app.post('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) delete transports[sid];
        };
        const server = buildServer();
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message:
              'Bad Request: missing mcp-session-id header (or not an initialize request).',
          },
          id: null,
        });
        return;
      }
      await transport.handleRequest(req, res, req.body);
    });

    // GET /mcp — opens an SSE stream so the server can push messages.
    // DELETE /mcp — terminates the session.
    const handleSessionRequest = async (
      req: ExpressRequest,
      res: ExpressResponse,
    ): Promise<void> => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }
      await transports[sessionId].handleRequest(req, res);
    };
    app.get('/mcp', handleSessionRequest);
    app.delete('/mcp', handleSessionRequest);

    app.listen(port, () => {
      process.stderr.write(
        `${opts.serverInfo.name} listening on http://0.0.0.0:${port}/mcp ` +
          `(auth=${expectedBearer ? 'on' : 'OFF'})\n`,
      );
    });
  }

  opts.registerGames();
  for (const plugin of opts.aiPlugins ?? []) registerAIPlugin(plugin);
  // Swap the default in-memory session store for the env-selected one BEFORE
  // serving. Persistent (mongodb) by default so games survive restarts — this
  // awaits the DB connection and fails fast if no mongod is reachable; the
  // harness/smoke/tests set SESSION_STORE=memory. Log to stderr only.
  const { store, description } = await createSessionStoreFromEnv();
  setSessionStore(store);
  process.stderr.write(`session store: ${description}\n`);
  // Repopulate the multi-device join-code index from any persisted sessions so
  // outstanding codes keep working across a restart (the code lives on
  // SessionState.joinCode). No-op for the memory store.
  const restoredCodes = await rebuildJoinCodeIndex(listRegisteredGames().map((g) => g.id));
  if (restoredCodes > 0) {
    process.stderr.write(`restored ${restoredCodes} join code(s) from persisted sessions\n`);
  }
  const transport = (process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase();
  switch (transport) {
    case 'stdio':
      await startStdio();
      return;
    case 'http':
      await startHttp();
      return;
    default:
      throw new Error(
        `Unknown MCP_TRANSPORT="${transport}". Expected "stdio" or "http".`,
      );
  }
}
