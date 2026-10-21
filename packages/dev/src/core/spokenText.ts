// Checks a move's state_summary (and an AI move's narration) against the
// spoken-text conventions (docs/spoken-narration.md). The summary is the
// canonical per-move string: zekel Live reads it aloud as-is and text clients
// show it as-is, so it must read naturally and never expose engine internals.
// Used by scripts/check-summaries.ts (post-port) — mechanical checks only; a
// human still reads a sample for whether it sounds right.

export interface SpokenTextProblem {
  rule: string;
  detail: string;
}

// A few engine abbreviations that have turned up in summaries.
const ABBREVIATIONS = /\b(dmg|def|atk|hp|vp|lvl|qty|pts)\b/;
// Debug output that belongs in the server log, never in narration.
const DEBUG = /\b(mcts|sims?|simulations?|iterations?|visits?|avg=|score=|Δ=|lookahead)\b|\((easy|medium|hard|random|bot)\)/i;
// snake_case or kebab-case identifiers (engine ids, move types, pending kinds).
const IDENTIFIER = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b|\b[a-z]+(?:-[a-z0-9]+){2,}\b/;

/** Problems with one spoken string. `seatIds` are the session's raw seat ids,
 *  which must never be spoken (use core/seatNames.ts display names). */
export function checkSpokenText(text: string, seatIds: string[]): SpokenTextProblem[] {
  const problems: SpokenTextProblem[] = [];
  if (text.trim() === '') problems.push({ rule: 'not empty', detail: 'the string is empty' });
  for (const id of seatIds) {
    const re = new RegExp(`(^|[^A-Za-z0-9_])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_])`);
    if (re.test(text)) problems.push({ rule: 'display names, not seat ids', detail: `says the seat id "${id}"` });
  }
  const ident = text.match(IDENTIFIER);
  if (ident) problems.push({ rule: 'printed names, no internal ids', detail: `contains "${ident[0]}"` });
  const abbr = text.match(ABBREVIATIONS);
  if (abbr) problems.push({ rule: 'no abbreviations', detail: `contains "${abbr[0]}"` });
  const dbg = text.match(DEBUG);
  if (dbg) problems.push({ rule: 'no debug text', detail: `contains "${dbg[0]}"` });
  if (/[{}]|\[object /.test(text)) problems.push({ rule: 'no raw data', detail: 'contains braces or an object dump' });
  return problems;
}
