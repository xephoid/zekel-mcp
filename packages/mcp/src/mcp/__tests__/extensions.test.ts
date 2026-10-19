// Locks the way a game adds its own MCP tools and resources
// (Game.getExtraTools / getExtraResources -> src/mcp/extensions.ts): the
// server builds them from plain descriptions, formats results and errors the
// same way every time, and refuses to start when a game's name clashes with
// one already registered. Warble Way Galaxy's get_lore is the real user; its
// replies were checked byte-for-byte against the hand-written tool this
// replaced. This file uses made-up games only.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { registerGame } from '../../core/registry.js';
import type { ExtraResources, ExtraTool, Game } from '@zekel/game-kit';
import { buildMcpServer } from '../../server/bootstrap.js';

const SERVER = { serverInfo: { name: 'zekel-test', version: '0' }, instructions: 'test' };

function fakeGame(id: string, tools: ExtraTool[], resources?: ExtraResources): Game<unknown, unknown, unknown> {
  return {
    id,
    name: id,
    getExtraTools: () => tools,
    getExtraResources: () => resources ?? {},
  } as unknown as Game<unknown, unknown, unknown>;
}

const echoTool: ExtraTool = {
  name: 'echo_word',
  description: 'Echoes a word back.',
  args: { word: { description: 'the word' }, shout: { description: 'any text to shout', optional: true } },
  run(args) {
    if (args.word === 'bad') return { error: { error_code: 'BAD_WORD', message: 'no' } };
    return { result: { word: args.word, shouted: args.shout !== undefined } };
  },
};

async function connect(): Promise<Client> {
  const server = buildMcpServer(SERVER);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return client;
}

describe('game-added MCP tools and resources', () => {
  // One registry per test file (vitest isolates files), so these made-up games
  // are the only games this file's server sees.
  registerGame(
    fakeGame('fake-extras', [echoTool], {
      fixed: [{ name: 'fake-note', uri: 'game://fake-extras/note', title: 'Note', description: 'A note.', mimeType: 'text/plain', read: () => 'hello' }],
      templates: [
        {
          name: 'fake-page',
          uriTemplate: 'game://fake-extras/page/{n}',
          title: 'Page',
          description: 'A page.',
          mimeType: 'text/markdown',
          read: (vars) => {
            if (vars.n === 'none') throw new Error('no such page');
            return `# page ${vars.n}`;
          },
        },
      ],
    }),
  );

  it('lists the tool with its arguments, required and optional', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'echo_word');
    expect(tool?.description).toBe('Echoes a word back.');
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['word', 'shout']);
    expect(tool?.inputSchema.required).toEqual(['word']);
    await client.close();
  });

  it('sends a result as indented JSON, and an error as a tool error', async () => {
    const client = await connect();
    const ok = (await client.callTool({ name: 'echo_word', arguments: { word: 'hi' } })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0]!.text).toBe(JSON.stringify({ word: 'hi', shouted: false }, null, 2));
    const bad = (await client.callTool({ name: 'echo_word', arguments: { word: 'bad' } })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(bad.isError).toBe(true);
    // The client-mode layer re-formats JSON text on the way out, so compare the value.
    expect(JSON.parse(bad.content[0]!.text)).toEqual({ error_code: 'BAD_WORD', message: 'no' });
    await client.close();
  });

  it('serves fixed and templated resources', async () => {
    const client = await connect();
    const note = await client.readResource({ uri: 'game://fake-extras/note' });
    expect(note.contents[0]).toMatchObject({ uri: 'game://fake-extras/note', mimeType: 'text/plain', text: 'hello' });
    const page = await client.readResource({ uri: 'game://fake-extras/page/3' });
    expect(page.contents[0]).toMatchObject({ mimeType: 'text/markdown', text: '# page 3' });
    await expect(client.readResource({ uri: 'game://fake-extras/page/none' })).rejects.toThrow(/no such page/);
    await client.close();
  });

  it("refuses a game whose tool name clashes with the server's own", () => {
    registerGame(fakeGame('fake-clash', [{ ...echoTool, name: 'get_state' }]));
    expect(() => buildMcpServer(SERVER)).toThrow(/fake-clash adds tool get_state/);
  });
});
