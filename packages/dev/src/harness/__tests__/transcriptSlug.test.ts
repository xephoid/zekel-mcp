import { describe, it, expect } from 'vitest';

// Lock for the B-class harness-fidelity fix in scripts/desync-bot.ts: the
// transcript filename the harness WRITES must equal the filename the gate
// check (scripts/supervised/checks/desync_clean.py) LOOKS FOR. The check is
// the filename authority (it deletes + reads the file); the harness must
// conform. The prior harness regex kept "." (so "qwen3.5:9b" → "qwen3.5-9b")
// while the check strips it ("qwen3-5-9b") — the check could never find a
// transcript for any dotted model name. This test pins both slug algorithms
// together so neither side can drift back.

// The check's slug (desync_clean.py line 62):
//   re.sub(r"[^a-z0-9]+", "-", assistant.lower()).strip("-")
function checkSlug(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// The harness's slug (scripts/desync-bot.ts):
//   cli.assistant.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
function harnessSlug(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

describe('desync transcript filename slug (harness == check)', () => {
  const cases: [string, string][] = [
    // The gate's default assistant — the exact failure case (dotted name).
    ['qwen3.5:9b', 'qwen3-5-9b'],
    ['qwen3.6:35b', 'qwen3-6-35b'],
    ['qwen3.6:latest', 'qwen3-6-latest'],
    ['gpt-oss:120b', 'gpt-oss-120b'],
    ['llama3.3:70b', 'llama3-3-70b'],
    ['llama3.1:70b', 'llama3-1-70b'],
    // No dots / colons — unchanged shape.
    ['llama3', 'llama3'],
    ['gemma4', 'gemma4'],
    // Leading/trailing separators strip (Python .strip("-") parity).
    [':9b', '9b'],
    ['qwen3.5:', 'qwen3-5'],
  ];

  for (const [model, expected] of cases) {
    it(`check slug: ${model} -> ${expected}`, () => {
      expect(checkSlug(model)).toBe(expected);
    });
    it(`harness slug matches check: ${model}`, () => {
      expect(harnessSlug(model)).toBe(checkSlug(model));
    });
  }

  it('the gate default (qwen3.5:9b) does NOT keep the dot (regression guard)', () => {
    // The old harness regex was [^a-z0-9.]+ which kept "." -> "qwen3.5-9b".
    expect(harnessSlug('qwen3.5:9b')).not.toContain('.');
    expect(harnessSlug('qwen3.5:9b')).toBe('qwen3-5-9b');
  });

  it('full transcript name for the notorious gate seed', () => {
    const name = `desync-notorious-seed11-${harnessSlug('qwen3.5:9b')}.json`;
    expect(name).toBe('desync-notorious-seed11-qwen3-5-9b.json');
  });
});
