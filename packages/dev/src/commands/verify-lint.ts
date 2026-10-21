// Run the rules-encoding linter for one game and print the findings list.
// Usage: verify-lint --game=cybernoir-2127 [--encoding=<file>]
// Loads src/verify/<game>/encoding.ts (default export: GameRulesEncoding) and
// the pinned rules text the encoding names in `rulesFile`.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lintEncoding, renderFinding } from '../verify/lint.js';
import type { GameRulesEncoding } from '../verify/types.js';

export async function main(argv: string[]): Promise<void> {
  const gameArg = argv.find((a) => a.startsWith('--game='));
  if (!gameArg) {
    process.stderr.write('usage: verify-lint --game=<id> [--encoding=<file>]\n');
    process.exitCode = 2;
    return;
  }
  const gameId = gameArg.slice('--game='.length);

  // The encoding file: --encoding=<file>, or src/verify/<game>/encoding.ts in
  // the current folder.
  const encodingArg = argv.find((a) => a.startsWith('--encoding='));
  const encodingPath = resolve(encodingArg ? encodingArg.slice('--encoding='.length) : `src/verify/${gameId}/encoding.ts`);
  const module_ = (await import(pathToFileURL(encodingPath).href)) as { default: GameRulesEncoding };
  const encoding = module_.default;
  const rulesText = readFileSync(resolve(encoding.rulesFile), 'utf-8');

  const findings = lintEncoding(encoding, rulesText);
  const cells = encoding.universe.zones.length * encoding.universe.eventKinds.length;
  process.stderr.write(
    `${gameId} rules ${encoding.rulesVersion}: ${encoding.entries.length} entries, ` +
      `${encoding.notApplicable.length} not-applicable cells, ${cells} universe cells\n`,
  );

  if (findings.length === 0) {
    process.stderr.write('no findings — citations verbatim, matrix fully covered, no gaps recorded\n');
    return;
  }

  const structural = findings.filter((f) => f.kind !== 'silent' && f.kind !== 'vague');
  const gaps = findings.filter((f) => f.kind === 'silent' || f.kind === 'vague');
  if (structural.length > 0) {
    process.stderr.write(`\n${structural.length} structural problem(s) — fix these first:\n`);
    for (const f of structural) process.stderr.write(`  ${renderFinding(f)}\n`);
  }
  if (gaps.length > 0) {
    process.stderr.write(`\n${gaps.length} recorded gap(s) in the rulebook — the findings list:\n`);
    for (const f of gaps) process.stderr.write(`  ${renderFinding(f)}\n`);
  }
  if (structural.length > 0) process.exitCode = 1;
}
