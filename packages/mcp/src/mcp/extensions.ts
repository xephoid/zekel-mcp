// Builds the extra MCP tools and resources that registered games describe
// through Game.getExtraTools / Game.getExtraResources (src/game-kit/extensions.ts).
// Games hand over plain descriptions; this file owns the MCP SDK and zod side
// and the reply format, so a game never imports either.
//
// Reply format (kept from the hand-written Warble Way lore tool this replaced,
// whose replies were checked byte-for-byte): a result is its JSON indented by
// 2; an error is a tool error whose text is the error's JSON. The client-mode
// layer (withClientMode) then shapes both, as it does for every tool.

import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listRegisteredGames } from '../core/registry.js';
import type { ExtraTool } from '@zekel/game-kit';

function zodArgs(tool: ExtraTool): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, arg] of Object.entries(tool.args)) {
    shape[name] = (arg.optional ? z.string().optional() : z.string()).describe(arg.description);
  }
  return shape;
}

function registerOne(server: McpServer, gameId: string, what: string, register: () => void): void {
  try {
    register();
  } catch (err) {
    throw new Error(
      `Game ${gameId} adds ${what}, which clashes with one already registered: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/** Register every registered game's extra tools and resources on `server`.
 *  Pass the client-mode view of the server (withClientMode) so replies are
 *  shaped like every other tool's. */
export function registerGameExtensions(server: McpServer): void {
  for (const game of listRegisteredGames()) {
    for (const tool of game.getExtraTools?.() ?? []) {
      registerOne(server, game.id, `tool ${tool.name}`, () =>
        server.registerTool(
          tool.name,
          { description: tool.description, inputSchema: zodArgs(tool) },
          (args) => {
            // zod has already checked every argument is a string (or absent).
            const outcome = tool.run(args as Record<string, string | undefined>);
            if ('error' in outcome) {
              return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(outcome.error) }] };
            }
            return { content: [{ type: 'text' as const, text: JSON.stringify(outcome.result, null, 2) }] };
          },
        ),
      );
    }

    const resources = game.getExtraResources?.();
    for (const res of resources?.fixed ?? []) {
      registerOne(server, game.id, `resource ${res.uri}`, () =>
        server.registerResource(
          res.name,
          res.uri,
          { title: res.title, description: res.description, mimeType: res.mimeType },
          (uri) => ({ contents: [{ uri: uri.href, mimeType: res.mimeType, text: res.read() }] }),
        ),
      );
    }
    for (const res of resources?.templates ?? []) {
      registerOne(server, game.id, `resource ${res.uriTemplate}`, () =>
        server.registerResource(
          res.name,
          new ResourceTemplate(res.uriTemplate, { list: undefined }),
          { title: res.title, description: res.description, mimeType: res.mimeType },
          (uri, vars) => {
            const flat: Record<string, string> = {};
            for (const [k, v] of Object.entries(vars)) flat[k] = Array.isArray(v) ? v.join(',') : String(v);
            return { contents: [{ uri: uri.href, mimeType: res.mimeType, text: res.read(flat) }] };
          },
        ),
      );
    }
  }
}
