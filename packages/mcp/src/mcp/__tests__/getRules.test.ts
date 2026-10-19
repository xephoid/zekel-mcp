// get_rules with sectioned rules (docs/rules-teaching.md M0): the sections
// index, the topic filter, and blob-only backward compat — driven through the
// real MCP tool surface.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../tools.js';
import { setSessionStore } from '../../core/sessions.js';
import { MemorySessionStore } from '../../core/store/memory.js';
import { registerGame } from '../../core/registry.js';
import { renderRulesText } from '@zekel/game-kit';
import { blobOnlyStub, rulesTeachingStub, STUB_SECTIONS } from './rulesTeachingStub.js';

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
  registerGame(blobOnlyStub);
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

describe('get_rules with sectioned rules', () => {
  it('returns the full derived text + a rules_sections index without a topic', async () => {
    const res = await call('get_rules', { game_id: 'rules-teaching-stub' });
    expect(res.isError).toBe(false);
    expect(res.data.rules).toBe(renderRulesText(STUB_SECTIONS));
    expect(res.data.rules_sections).toEqual(
      STUB_SECTIONS.map((s) => ({ id: s.id, title: s.title })),
    );
  });

  it('filters to one section by exact id', async () => {
    const res = await call('get_rules', {
      game_id: 'rules-teaching-stub',
      topic: 'power-strike',
    });
    expect(res.isError).toBe(false);
    expect(res.data.rules).toBe('## Power Strike\n\n' + STUB_SECTIONS[2]!.text);
    // The index still rides so the model can navigate to other topics.
    expect(res.data.rules_sections).toHaveLength(STUB_SECTIONS.length);
  });

  it('filters by case-insensitive title substring', async () => {
    const res = await call('get_rules', {
      game_id: 'rules-teaching-stub',
      topic: 'MAIN PHASE',
    });
    expect(res.isError).toBe(false);
    expect(res.data.rules).toContain('During the main phase');
    expect(res.data.rules).not.toContain('Power Strike costs');
  });

  it('answers an unknown topic with a plain miss message + the index, not an error', async () => {
    const res = await call('get_rules', {
      game_id: 'rules-teaching-stub',
      topic: 'shipbuilding',
    });
    expect(res.isError).toBe(false);
    expect(res.data.rules).toContain('No rules section matches topic "shipbuilding"');
    expect(res.data.rules_sections).toHaveLength(STUB_SECTIONS.length);
  });
});

describe('get_rules blob-only backward compat', () => {
  it('returns the blob with no sections index', async () => {
    const res = await call('get_rules', { game_id: 'blob-only-stub' });
    expect(res.isError).toBe(false);
    expect(res.data.rules).toBe('One big blob of rules.');
    expect(res.data.rules_sections).toBeUndefined();
  });

  it('ignores topic for a blob-only game (full text, no error)', async () => {
    const res = await call('get_rules', { game_id: 'blob-only-stub', topic: 'anything' });
    expect(res.isError).toBe(false);
    expect(res.data.rules).toBe('One big blob of rules.');
  });
});
