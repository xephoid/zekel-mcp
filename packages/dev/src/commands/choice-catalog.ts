#!/usr/bin/env tsx
// Print a game's choice catalog as the POST-PORT.md §6 table.
//
// The catalog is the data (src/games/<game>/choices.ts); this renders it. Paste
// the output into POST-PORT.md rather than hand-maintaining a second copy —
// a hand-written table drifts from the code, which is how a game ends up with a
// green table and decisions the player never gets to make.
//
// Examples:
//   npx tsx scripts/choice-catalog.ts sweetlands-imperium
//   npx tsx scripts/choice-catalog.ts --list

import { renderChoiceCatalog, validateChoiceCatalog } from '../core/choiceCatalog.js';
import type { DevSetup } from './setup.js';

export async function main(argv: string[], setup: DevSetup): Promise<void> {
  const arg = argv[0];
  const allGames = setup.games ?? [];
  const withCatalog = allGames.filter((g) => typeof g.getChoiceCatalog === 'function');

  if (!arg || arg === '--list') {
    process.stdout.write('Games with a choice catalog:\n');
    for (const g of withCatalog) process.stdout.write(`  ${g.id}\n`);
    const without = allGames.filter((g) => typeof g.getChoiceCatalog !== 'function');
    process.stdout.write(`\nStill to do (${without.length}):\n`);
    for (const g of without) process.stdout.write(`  ${g.id}\n`);
    return;
  }

  const game = allGames.find((g) => g.id === arg);
  if (!game) {
    process.stderr.write(`No game with id "${arg}". Try --list.\n`);
    process.exitCode = 1;
    return;
  }
  if (typeof game.getChoiceCatalog !== 'function') {
    process.stderr.write(`${arg} has no choice catalog yet (no getChoiceCatalog).\n`);
    process.exitCode = 1;
    return;
  }

  const catalog = game.getChoiceCatalog();
  const problems = validateChoiceCatalog(catalog);
  if (problems.length > 0) {
    process.stderr.write(`Problems with ${arg}'s catalog:\n`);
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.exitCode = 1;
  }

  const player = catalog.filter((c) => c.owner === 'player').length;
  const auto = catalog.length - player;
  process.stdout.write(`## 6. Choice catalog — ${game.name}\n\n`);
  process.stdout.write(
    `${catalog.length} decisions: ${player} the player makes, ${auto} the engine settles ` +
      '(each with a stated reason). Generated from `choices.ts` by ' +
      '`npx tsx scripts/choice-catalog.ts ' + game.id + '` — edit the code, not this table.\n\n',
  );
  process.stdout.write(renderChoiceCatalog(catalog));
  process.stdout.write('\n');
}
