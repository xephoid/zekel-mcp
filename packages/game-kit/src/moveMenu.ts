// Shared move-menu helpers usable from BOTH the generic builder (mcp/moveMenu.ts)
// and a game's own describeMoveMenu override — kept in core so a game module can
// build a MoveMenu without depending on the mcp layer. The MoveMenu/MoveMenuEntry
// types live in core/game.ts; this file is just the presentation boilerplate so
// each describeMoveMenu doesn't restate the client/human guidance strings.

import type { MoveMenu, MoveMenuEntry } from './game.js';

// Above this many options at one level, collapse/group instead of listing flat.
// Games building their own menu can reuse this to match the generic boundary.
export const MOVE_MENU_FLAT_THRESHOLD = 12;

export const MOVE_MENU_FREE_TEXT_HINT =
  'Type the number of your choice — or just tell me the move in your own words ' +
  '(a card or location name works) and I’ll match it.';

export const MOVE_MENU_HOW_TO_USE =
  'Render entries to the human as a numbered list of key + label. If an entry ' +
  'has a submenu it is a CATEGORY (count = options inside, grouped by group_by): ' +
  'when the human picks it, show that submenu as the next numbered list — never ' +
  'dump every option at once. When the human picks a leaf (an entry with a ' +
  'move_id), call apply_move with that move_id. The human may instead answer in ' +
  'their own words — match it to an entry label or a printed component name, ' +
  'confirm the resolved move in one line, then apply it. This menu reflects the ' +
  'CURRENT state only; re-fetch it (it rides on each human-to-move response, or ' +
  'call get_legal_moves) before every human decision — keys and move_ids are not ' +
  'stable across moves.';

// Wraps game-built (or generically-built) entries in a MoveMenu with the standard
// client/human guidance strings, so callers don't restate them.
export function composeMenu(opts: {
  prompt: string;
  entries: MoveMenuEntry[];
  total_moves: number;
  collapsed: boolean;
}): MoveMenu {
  return {
    ...opts,
    free_text_hint: MOVE_MENU_FREE_TEXT_HINT,
    how_to_use: MOVE_MENU_HOW_TO_USE,
  };
}

// Title-cases an id/enum/value into a readable label: "iron_works" -> "Iron
// Works", "burton-on-trent" -> "Burton On Trent". Non-strings pass through
// String().
export function humanizeMenuValue(value: unknown): string {
  if (typeof value !== 'string') return String(value);
  const cleaned = value.replace(/[_-]+/g, ' ').trim();
  if (cleaned === '') return value;
  return cleaned
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
