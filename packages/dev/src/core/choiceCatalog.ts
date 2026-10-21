// Helpers for the choice catalog — every decision the printed rules give a
// player, as data instead of prose. The `PlayerChoice` type itself lives in
// core/game.ts (same split as GameLogEntry / gameLog.ts).
//
// WHY THIS EXISTS. The all-AI harness cannot see a game that quietly decides
// something for a human seat: the AI is *supposed* to decide everything, so the
// games run clean either way. Wonderland's War shipped as "fully playable" with
// 8 decisions taken out of the player's hands, and the harness had been green
// the whole time. The post-port runbook's answer was a written table in
// POST-PORT.md — a table nobody executes.
//
// This turns that table into data. `src/harness/choiceCoverage.ts` plays each
// game with one human seat and checks that every decision marked `player` is
// actually put to that seat. A decision the engine settles silently never shows
// up, so the check fails. The same data renders the POST-PORT.md §6 table, so
// the document and the check cannot drift apart.

import type { PlayerChoice } from '@zekel/game-kit';

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Check a catalog is well formed. Returns a list of problems in plain words;
 * an empty list means it is fine.
 */
export function validateChoiceCatalog(catalog: PlayerChoice[]): string[] {
  const problems: string[] = [];
  if (catalog.length === 0) problems.push('the catalog is empty');

  const seen = new Set<string>();
  for (const c of catalog) {
    const where = c.id ? `"${c.id}"` : '(a choice with no id)';
    if (!c.id || !ID_PATTERN.test(c.id)) {
      problems.push(`${where}: id must be lowercase and hyphenated`);
    }
    if (seen.has(c.id)) problems.push(`${where}: duplicate id`);
    seen.add(c.id);

    if (!c.description || c.description.trim().length === 0) {
      problems.push(`${where}: needs a description`);
    }
    if (c.owner !== 'player' && c.owner !== 'auto') {
      problems.push(`${where}: owner must be "player" or "auto"`);
    }
    if (c.when !== 'setup' && c.when !== 'in-game') {
      problems.push(`${where}: when must be "setup" or "in-game"`);
    }
    if (c.owner === 'player' && c.resolvedBy.length === 0) {
      problems.push(`${where}: a player-owned choice must list the move types that settle it`);
    }
    if (c.owner === 'auto' && (!c.why || c.why.trim().length === 0)) {
      problems.push(
        `${where}: the engine settles this one, so "why" must say what makes that faithful to the rules`,
      );
    }
  }
  return problems;
}

/** Render a catalog as the POST-PORT.md §6 table, so the document tracks the data. */
export function renderChoiceCatalog(catalog: PlayerChoice[]): string {
  const order = (c: PlayerChoice): number => (c.when === 'setup' ? 0 : 1);
  const lines: string[] = [];
  lines.push('| Choice | Owner | How it reaches the player | AI policy | Balance axis |');
  lines.push('|---|---|---|---|---|');
  for (const c of [...catalog].sort((a, b) => order(a) - order(b))) {
    const owner = c.owner === 'player' ? '**player**' : `engine — ${c.why ?? ''}`;
    const how = c.resolvedBy.map((m) => `\`${m}\``).join(' / ') || '—';
    lines.push(
      `| ${c.description} (\`${c.id}\`) | ${owner} | ${how} | ${c.aiPolicy ?? '—'} | ${c.balanceAxis ?? '—'} |`,
    );
  }
  return lines.join('\n');
}
