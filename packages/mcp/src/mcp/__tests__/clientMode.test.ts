// Client mode (src/mcp/clientMode.ts), proven on both paths through the real
// server wiring (buildMcpServer) over an in-memory MCP connection:
//   - llm_driven: the recorded baseline (__fixtures__/llmDrivenBaseline.json)
//     is reproduced exactly. Re-record on purpose with UPDATE_BASELINE=1, then
//     review the diff: it is the text models read.
//   - orchestrated: no loop directions anywhere in the same conversations.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS, ORCHESTRATED_SERVER_INSTRUCTIONS } from '../serverInstructions.js';
import { parseClientMode } from '../clientMode.js';
import { runBaselineFlows, type FlowRecord } from './baselineFlows.js';
import { connect, ORCHESTRATED_CAPABILITIES } from './testServer.js';

const ORCHESTRATED = ORCHESTRATED_CAPABILITIES;

// Fields allowed to differ from the recording (none now; kept so an additive
// field can be let through deliberately). Everything else must match exactly.
const ALLOWED_ADDITIONS: string[] = [];

function withoutAdditions(records: FlowRecord[]): FlowRecord[] {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!ALLOWED_ADDITIONS.includes(k)) out[k] = strip(x);
    }
    return out;
  };
  return strip(records) as FlowRecord[];
}

const BASELINE_PATH = resolve('packages/mcp/src/mcp/__tests__/__fixtures__/llmDrivenBaseline.json');

describe('parseClientMode', () => {
  it('reads only the declared capability', () => {
    expect(parseClientMode(undefined)).toBe('llm_driven');
    expect(parseClientMode({})).toBe('llm_driven');
    expect(parseClientMode({ experimental: { zekel: { mode: 'something' } } })).toBe('llm_driven');
    expect(parseClientMode(ORCHESTRATED)).toBe('orchestrated');
  });
});

describe('llm_driven: exactly what it saw before the change', () => {
  it('reproduces the recorded baseline', async () => {
    const records = await runBaselineFlows(() => connect());
    if (process.env.UPDATE_BASELINE) {
      mkdirSync(dirname(BASELINE_PATH), { recursive: true });
      writeFileSync(BASELINE_PATH, JSON.stringify(records, null, 2) + '\n');
    }
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as FlowRecord[];
    expect(withoutAdditions(records)).toEqual(baseline);
  });

  it('a client that declares nothing gets the full server instructions', async () => {
    const client = await connect();
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    await client.close();
  });
});

// Words that only ever appear in directions to a loop-driving LLM.
const LOOP_DIRECTION = /run_ai_turn|get_ai_move|keep calling|REPORT (THIS|THESE)|relay (EVERY|every|its)|call apply_move|call get_/;

function stringsIn(v: unknown, path = ''): Array<{ path: string; text: string }> {
  if (typeof v === 'string') return [{ path, text: v }];
  if (Array.isArray(v)) return v.flatMap((x, i) => stringsIn(x, `${path}[${i}]`));
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => stringsIn(x, path ? `${path}.${k}` : k));
  }
  return [];
}

describe('orchestrated: facts only', () => {
  let records: FlowRecord[];
  beforeAll(async () => {
    records = await runBaselineFlows(() => connect(ORCHESTRATED));
  });

  it('gets the short server instructions', async () => {
    const client = await connect(ORCHESTRATED);
    expect(client.getInstructions()).toBe(ORCHESTRATED_SERVER_INSTRUCTIONS);
    expect(client.getInstructions()).not.toMatch(LOOP_DIRECTION);
    await client.close();
  });

  it('no response carries a loop direction', () => {
    const hits = records
      .flatMap((r) => r.calls.flatMap((c) => stringsIn(c.response, c.call)))
      // Tool-supplied game data (card text, rules sections, move labels) is
      // not a direction; only check the fields a client would act on.
      .filter((s) => !/\.(rules_briefing|reference_data|description|label|text|summary|state_summary|narration)$/.test(s.path))
      .filter((s) => LOOP_DIRECTION.test(s.text));
    expect(hits).toEqual([]);
  });

  it('next_step keeps its facts and loses the prose', () => {
    const steps = records.flatMap((r) =>
      r.calls.flatMap((c) => {
        const out: Array<Record<string, unknown>> = [];
        const walk = (v: unknown): void => {
          if (Array.isArray(v)) return v.forEach(walk);
          if (!v || typeof v !== 'object') return;
          for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
            if (k === 'next_step') out.push(x as Record<string, unknown>);
            else walk(x);
          }
        };
        walk(c.response);
        return out;
      }),
    );
    expect(steps.length).toBeGreaterThan(10);
    for (const s of steps) {
      expect(s).not.toHaveProperty('instruction');
      expect(typeof s.status).toBe('string');
      expect(s).toHaveProperty('active_player_id');
    }
  });

  it('drops report_to_human and agent_guidance', () => {
    const text = JSON.stringify(records);
    expect(text).not.toContain('"report_to_human"');
    expect(text).not.toContain('"agent_guidance"');
    expect(text).not.toContain('"how_to_apply"');
  });
});
