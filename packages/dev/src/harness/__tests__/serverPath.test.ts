import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Harness, setDefaultServerPath } from '../runner.js';

describe('which server a Harness starts', () => {
  afterEach(() => setDefaultServerPath(undefined));

  it('defaults to dist/index.js in the current folder', () => {
    expect(new Harness()['serverPath']).toBe(resolve(process.cwd(), 'dist', 'index.js'));
  });

  it("uses the project's server when one is named", () => {
    setDefaultServerPath('examples/serve.mjs');
    expect(new Harness()['serverPath']).toBe(resolve('examples/serve.mjs'));
  });

  it('an explicit server for one Harness still wins', () => {
    setDefaultServerPath('examples/serve.mjs');
    expect(new Harness({ serverPath: '/x/server.js' })['serverPath']).toBe('/x/server.js');
  });
});
