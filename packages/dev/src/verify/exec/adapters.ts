// The rules checker's per-game adapters come from each game's dev hooks
// (harness/devHooks.ts): a game lists its adapters by id, and this looks them up.

import { verifyAdapterFor, verifyAdapterIds } from '../../harness/devHooks.js';
import type { VerifyAdapter } from './driver.js';

export function getVerifyAdapter(gameId: string): VerifyAdapter<unknown> {
  const adapter = verifyAdapterFor(gameId);
  if (!adapter) {
    const known = verifyAdapterIds().join(', ') || '(none yet)';
    throw new Error(
      `no verify adapter for "${gameId}" — games with one: ${known}. ` +
        `To add one, write an adapter (verify/exec/driver.ts describes it) and list it under verify in that game's dev hooks`,
    );
  }
  return adapter;
}
