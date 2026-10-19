// Shared game-log helpers — generic over any game's resource vocabulary.
//
// These back two patterns:
//   1. Self-logging games (Game.getLog): the engine authors GameLogEntry[] with
//      names, board locations, and phase transitions. diffStats + renderLogEntries
//      help build those entries and render them into a move summary.
//   2. Auto-delta games (Game.getScoreboard): the MCP layer diffs the per-player
//      scoreboard before/after a move and attaches the result to the moveLog.
//
// Resource names are free strings, so each game keeps its own vocabulary. The
// render helpers use the raw names; a game wanting prettier labels (e.g. "Credits"
// instead of "credits") can supply its own renderer.

import type { GameLogEntry, LogResourceDelta } from './game.js';

/** Split a before→after numeric-stat change into spent (decreases) and gained
 *  (increases). `exclude` drops resources whose deltas are noise (e.g. an action
 *  cube whose spend is implied by taking an action). */
export function diffStats(
  before: Record<string, number>,
  after: Record<string, number>,
  exclude: readonly string[] = [],
): { spent: LogResourceDelta[]; gained: LogResourceDelta[] } {
  const spent: LogResourceDelta[] = [];
  const gained: LogResourceDelta[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const r of keys) {
    if (exclude.includes(r)) continue;
    const d = (after[r] ?? 0) - (before[r] ?? 0);
    if (d > 0) gained.push({ resource: r, amount: d });
    else if (d < 0) spent.push({ resource: r, amount: -d });
  }
  return { spent, gained };
}

/** Diff one player's row across two scoreboard snapshots. Returns null when there
 *  is no change, so callers can skip attaching an empty delta. */
export function diffScoreboardRow(
  before: Record<string, Record<string, number>> | undefined,
  after: Record<string, Record<string, number>> | undefined,
  playerId: string,
  exclude: readonly string[] = [],
): { spent: LogResourceDelta[]; gained: LogResourceDelta[] } | null {
  if (!before || !after) return null;
  const { spent, gained } = diffStats(before[playerId] ?? {}, after[playerId] ?? {}, exclude);
  if (spent.length === 0 && gained.length === 0) return null;
  return { spent, gained };
}

/** "3 credits, 1 discovery" — a list of resource amounts in plain terms.
 *  Resource KEYS are stat identifiers (cards_in_hand); spoken summaries get
 *  them with spaces — the relayer echoes summaries verbatim, so raw
 *  underscores would reach the human's ear (relay-harness voice finding). */
export function renderResourceList(list: LogResourceDelta[]): string {
  return list.map((r) => `${r.amount} ${r.resource.replace(/_/g, ' ')}`).join(', ');
}

/** Render one entry as a single narration line: summary plus any deltas. */
export function renderLogLine(entry: GameLogEntry): string {
  const parts = [entry.summary];
  if (entry.spent && entry.spent.length) parts.push(`(spent ${renderResourceList(entry.spent)})`);
  if (entry.gained && entry.gained.length) parts.push(`(gained ${renderResourceList(entry.gained)})`);
  return parts.join(' ');
}

/** Render a slice of the log (the entries one move produced) into a multi-line
 *  move summary. */
export function renderLogEntries(entries: GameLogEntry[]): string {
  return entries.map(renderLogLine).join('\n');
}

/** Append an entry to a log array, stamping its 1-based seq. Returns the entry. */
export function pushLogEntry(
  log: GameLogEntry[],
  entry: Omit<GameLogEntry, 'seq'>,
): GameLogEntry {
  const stamped: GameLogEntry = { seq: log.length + 1, ...entry };
  log.push(stamped);
  return stamped;
}
