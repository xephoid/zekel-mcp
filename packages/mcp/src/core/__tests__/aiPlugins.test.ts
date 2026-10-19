// Locks the outside-AI plug-in slot (src/core/aiPlugins.ts): built-in
// difficulties go to the game's own getAIMove; a claimed difficulty goes to
// its plug-in; an unclaimed one fails with AI_BACKEND_UNAVAILABLE instead of
// quietly playing the game's own AI. Also locks the repo-split boundary: the
// server's startup file must not pull in any game, src/env or src/ai code.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearAIPlugins,
  forgetSessionInAIPlugins,
  listAIPlugins,
  noteAppliedMove,
  pickAIMove,
  registerAIPlugin,
  type AIMovePlugin,
} from '../aiPlugins.js';
import { GameError } from '@zekel/game-kit';
import type { Game, SessionState } from '@zekel/game-kit';

const calls: string[] = [];

function fakeGame(): Game<unknown, unknown, unknown> {
  return {
    id: 'fake',
    getAIMove: async (_s: unknown, _p: string, difficulty?: string) => {
      calls.push(`game:${difficulty ?? 'default'}`);
      return { move: { type: 'engine' }, narration: 'engine move' };
    },
  } as unknown as Game<unknown, unknown, unknown>;
}

const session = { sessionId: 's1', gameId: 'fake', players: [] } as unknown as SessionState<unknown>;

function fakePlugin(name: string, difficulties: string[]): AIMovePlugin {
  return {
    name,
    difficulties,
    pickMove: async () => {
      calls.push(`plugin:${name}`);
      return { move: { type: 'plugin' }, narration: name };
    },
    noteAppliedMove: async () => {
      calls.push(`note:${name}`);
    },
    forgetSession: (id) => {
      calls.push(`forget:${name}:${id}`);
    },
  };
}

afterEach(() => {
  clearAIPlugins();
  calls.length = 0;
});

describe('outside AI plug-ins', () => {
  it('sends built-in and missing difficulties to the game itself', async () => {
    registerAIPlugin(fakePlugin('brain', ['hyperon']));
    await pickAIMove(fakeGame(), session, 'p1', { difficulty: 'hard' });
    await pickAIMove(fakeGame(), session, 'p1', {});
    await pickAIMove(fakeGame(), session, 'p1', undefined);
    expect(calls).toEqual(['game:hard', 'game:default', 'game:default']);
  });

  it('sends a claimed difficulty to its plug-in', async () => {
    registerAIPlugin(fakePlugin('brain', ['hyperon']));
    const pick = await pickAIMove(fakeGame(), session, 'p1', { difficulty: 'hyperon' });
    expect(pick.move).toEqual({ type: 'plugin' });
    expect(calls).toEqual(['plugin:brain']);
  });

  it('fails, never falls back, when no plug-in claims the difficulty', async () => {
    const attempt = pickAIMove(fakeGame(), session, 'p1', { difficulty: 'hyperon' });
    await expect(attempt).rejects.toBeInstanceOf(GameError);
    await expect(attempt).rejects.toMatchObject({ error_code: 'AI_BACKEND_UNAVAILABLE' });
    expect(calls).toEqual([]);
  });

  it('refuses a plug-in that claims a built-in or an already-claimed difficulty', () => {
    expect(() => registerAIPlugin(fakePlugin('bad', ['easy']))).toThrow(/built-in/);
    registerAIPlugin(fakePlugin('first', ['hyperon']));
    expect(() => registerAIPlugin(fakePlugin('second', ['hyperon']))).toThrow(/both claim/);
    expect(listAIPlugins().map((p) => p.name)).toEqual(['first']);
  });

  it('tells every plug-in about applied moves and undos', async () => {
    registerAIPlugin(fakePlugin('a', ['x']));
    registerAIPlugin(fakePlugin('b', ['y']));
    await noteAppliedMove(fakeGame(), session, session, 'p1', { type: 'm' });
    forgetSessionInAIPlugins('s1');
    expect(calls).toEqual(['note:a', 'note:b', 'forget:a:s1', 'forget:b:s1']);
  });
});

// The server side of the repo split (extraction/d1-option-a-analysis.md):
// nothing the server's startup file imports may reach into a game, the
// training bridge (src/env) or the hyperon brain (src/ai/brain.ts). Walks the
// relative imports from src/server/bootstrap.ts.
describe('server import boundary', () => {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  // `import x from './a.js'`, `export * from './a.js'`, bare `import './a.js'`, and `import('./a.js')`.
  const importPattern = /(?:import|export)\s[^'";]*?from\s+['"](\.[^'"]+)['"]|import\s*\(?\s*['"](\.[^'"]+)['"]/g;

  function serverFiles(): string[] {
    const seen = new Set<string>();
    const queue = [path.join(srcDir, 'server', 'bootstrap.ts')];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(importPattern)) {
        const spec = (match[1] ?? match[2])!;
        const target = path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts');
        queue.push(target);
      }
    }
    return [...seen].map((f) => path.relative(srcDir, f));
  }

  it('reaches no game, src/env or src/ai code', () => {
    const files = serverFiles();
    expect(files.length).toBeGreaterThan(10); // the walk really ran
    const leaks = files.filter((f) => /^(games|env|ai)\//.test(f.split(path.sep).join('/')));
    expect(leaks).toEqual([]);
  });

  it('every file it walked exists in src (sanity check on the walker)', () => {
    const top = new Set(readdirSync(srcDir));
    for (const f of serverFiles()) expect(top.has(f.split(path.sep)[0]!)).toBe(true);
  });
});
