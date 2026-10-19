import { verifySeatAuth } from '../core/joinAuth.js';
import type {
  Game,
  LegalMove,
  MoveMenu,
  MoveMenuEntry,
  NextStep,
  SessionState,
} from '@zekel/game-kit';
import {
  MOVE_MENU_FLAT_THRESHOLD,
  composeMenu,
  humanizeMenuValue,
} from '@zekel/game-kit';
import { isHumanTurnStatus } from '@zekel/game-kit';

// ===========================================================================
// Move menu — a typing-friendly rendering of the current legal moves.
//
// The human plays on a physical table and talks to the model in prose; making
// them spell out a whole move ("build a Cotton Mill in Birmingham slot 2 paying
// coal from the market") is a lot of typing AND a desync risk (the model has to
// reconstruct an exact move shape). A numbered menu collapses that to "type 3".
//
// This is purely a PRESENTATION of get_legal_moves — never the source of truth
// for legality. Every leaf carries a move_id straight from get_legal_moves, so
// the model applies a pick by passing that move_id to apply_move and never
// invents a move object. The human may also answer in their own words; the
// model matches the word to a label (or a printed component name) and confirms.
//
// Two shapes:
//   - FLAT   (<= FLAT_THRESHOLD moves): one numbered list, done.
//   - GROUPED (more): split by the move discriminant (type/action), and
//     recursively by whichever field best shrinks each oversized group, so no
//     single level dumps hundreds of options. Pagination is the last resort
//     when nothing splits cleanly, so a level is never unbounded.
//
// A game can override the grouping/labels entirely via Game.describeMoveMenu;
// the generic builder here is the default every game gets for free.
// ===========================================================================

// Above this many options at one level, collapse/group instead of listing flat.
const FLAT_THRESHOLD = MOVE_MENU_FLAT_THRESHOLD;
// A category list longer than this is itself unwieldy, so a split that produces
// more groups than this is rejected in favor of a different field (or pages).
const MAX_GROUPS = 24;
// Cap on grouping depth so a pathological move space can't nest forever.
const MAX_DEPTH = 3;

// Fields whose name makes a more human-readable category than an arbitrary id,
// used only to break ties between equally-good splits. Unlisted fields still
// qualify — they just lose ties.
const FIELD_LABEL_PRIORITY = [
  'location',
  'connection_id',
  'city',
  'space',
  'target',
  'industry_type',
  'industry',
  'card_id',
  'card',
  'slot_index',
];

const DISCRIMINANT_KEYS = ['type', 'action', 'kind'];

type AnyMove = Record<string, unknown>;

function isPrimitive(v: unknown): v is string | number | boolean {
  return (
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
  );
}

const humanize = humanizeMenuValue;

function leaf(move: LegalMove<unknown>, key: number): MoveMenuEntry {
  return { key: String(key), label: move.description, move_id: move.move_id };
}

// Builds leaf entries for a small, ungroupable set.
function flatLeaves(moves: LegalMove<unknown>[]): MoveMenuEntry[] {
  return moves.map((m, i) => leaf(m, i + 1));
}

// Last-resort split: chop a long, unsplittable list into pages of FLAT_THRESHOLD
// so no single level is unbounded. Page nodes are shallow (their submenu is just
// the leaves) and uniform.
function paginate(moves: LegalMove<unknown>[]): MoveMenuEntry[] {
  const pages: MoveMenuEntry[] = [];
  for (let start = 0; start < moves.length; start += FLAT_THRESHOLD) {
    const slice = moves.slice(start, start + FLAT_THRESHOLD);
    pages.push({
      key: String(pages.length + 1),
      label: `Options ${start + 1}–${start + slice.length}`,
      count: slice.length,
      submenu: flatLeaves(slice),
    });
  }
  return pages;
}

// Groups moves by a field value, preserving first-seen order of both the values
// and the moves within each value.
function groupByField(
  moves: LegalMove<unknown>[],
  field: string,
): Map<string, { value: unknown; moves: LegalMove<unknown>[] }> {
  const groups = new Map<string, { value: unknown; moves: LegalMove<unknown>[] }>();
  for (const m of moves) {
    const value = (m.move as AnyMove)[field];
    const k = String(value);
    let bucket = groups.get(k);
    if (!bucket) {
      bucket = { value, moves: [] };
      groups.set(k, bucket);
    }
    bucket.moves.push(m);
  }
  return groups;
}

// Chooses the field to split `moves` on at this depth. The discriminant
// (type/action) wins when it actually varies, giving the intuitive "pick an
// action first" top level. Otherwise picks the field that best shrinks the
// oversized groups (fewest still-too-big subgroups, then fewest groups), with
// readable string fields and the priority list breaking ties. Returns null when
// no field splits usefully (caller paginates).
function chooseSplitField(
  moves: LegalMove<unknown>[],
  usedFields: Set<string>,
): string | null {
  // Candidate fields: every key with a primitive value present on ALL moves
  // (a partial field would dump some moves into an "(unspecified)" bucket), not
  // already used by an ancestor level.
  const candidates: string[] = [];
  const first = moves[0]?.move as AnyMove | undefined;
  if (!first) return null;
  for (const key of Object.keys(first)) {
    if (usedFields.has(key)) continue;
    if (moves.every((m) => isPrimitive((m.move as AnyMove)[key]))) {
      candidates.push(key);
    }
  }

  // Prefer the discriminant when present and actually varying.
  for (const disc of DISCRIMINANT_KEYS) {
    if (candidates.includes(disc)) {
      const distinct = groupByField(moves, disc).size;
      if (distinct >= 2 && distinct <= MAX_GROUPS) return disc;
    }
  }

  let best: { field: string; oversize: number; groups: number } | null = null;
  for (const field of candidates) {
    if (DISCRIMINANT_KEYS.includes(field)) continue;
    const groups = groupByField(moves, field);
    const n = groups.size;
    // Reject useless splits: a single bucket, more groups than we'd ever list,
    // or one-group-per-move (just renames the leaves).
    if (n < 2 || n > MAX_GROUPS || n === moves.length) continue;
    let oversize = 0;
    for (const g of groups.values()) if (g.moves.length > FLAT_THRESHOLD) oversize++;
    if (
      best === null ||
      oversize < best.oversize ||
      (oversize === best.oversize && n < best.groups) ||
      (oversize === best.oversize &&
        n === best.groups &&
        fieldRank(field) < fieldRank(best.field))
    ) {
      best = { field, oversize, groups: n };
    }
  }
  return best?.field ?? null;
}

function fieldRank(field: string): number {
  const i = FIELD_LABEL_PRIORITY.indexOf(field);
  return i === -1 ? FIELD_LABEL_PRIORITY.length : i;
}

// Recursively builds the entries for a set of moves at a given depth.
function buildEntries(
  moves: LegalMove<unknown>[],
  depth: number,
  usedFields: Set<string>,
): MoveMenuEntry[] {
  if (moves.length <= FLAT_THRESHOLD) return flatLeaves(moves);
  if (depth >= MAX_DEPTH) return paginate(moves);

  const field = chooseSplitField(moves, usedFields);
  if (field === null) return paginate(moves);

  const groups = groupByField(moves, field);
  const nextUsed = new Set(usedFields).add(field);
  const entries: MoveMenuEntry[] = [];
  let i = 1;
  for (const { value, moves: groupMoves } of groups.values()) {
    if (groupMoves.length === 1 && groupMoves[0]) {
      // A category of one is just a leaf — don't make the human drill into it.
      entries.push(leaf(groupMoves[0], i));
    } else {
      entries.push({
        key: String(i),
        label: `${humanize(value)} — ${groupMoves.length} options`,
        count: groupMoves.length,
        group_by: field,
        submenu: buildEntries(groupMoves, depth + 1, nextUsed),
      });
    }
    i++;
  }
  return entries;
}

// The generic builder. Returns null when there are no legal moves (nothing to
// offer). Tries the game's describeMoveMenu override first, then falls back to
// the discriminant-grouped heuristic.
export function buildMoveMenu(
  state: SessionState<unknown>,
  legalMoves: LegalMove<unknown>[],
  game?: Pick<Game<unknown, unknown, unknown>, 'describeMoveMenu'>,
): MoveMenu | null {
  if (legalMoves.length === 0) return null;

  const custom = game?.describeMoveMenu?.(state, legalMoves);
  if (custom) return custom;

  const total = legalMoves.length;
  if (total <= FLAT_THRESHOLD) {
    return composeMenu({
      prompt: 'Your move — pick a number:',
      entries: flatLeaves(legalMoves),
      total_moves: total,
      collapsed: false,
    });
  }

  return composeMenu({
    prompt:
      `You have ${total} legal moves. Pick a category by number, then I’ll ` +
      'show its options:',
    entries: buildEntries(legalMoves, 0, new Set()),
    total_moves: total,
    collapsed: true,
  });
}

// Convenience for the response handlers: build a menu for whoever is on the
// clock, but only when that is a HUMAN who actually has moves to make — AND
// the RESPONSE's caller is authorized for that seat (snapshotSeats is the ONE
// source of who-may-read; probe finding #1: an off-turn authenticated caller
// could read another human's private-hand menu). Returns undefined (not null)
// so it omits cleanly from a response spread. AI turns get no menu — the
// server plays those seats itself.
export function menuForActivePlayer(
  game: Pick<
    Game<unknown, unknown, unknown>,
    'getLegalMoves' | 'describeMoveMenu'
  >,
  session: SessionState<unknown>,
  nextStep: NextStep,
  callerAuthToken?: string,
): MoveMenu | undefined {
  if (!isHumanTurnStatus(nextStep.status)) return undefined;
  const activeId = nextStep.active_player_id;
  if (!activeId) return undefined;
  const seat = session.players.find((p) => p.player_id === activeId);
  if (seat?.kind !== 'human') return undefined;
  // Seat-scope: the menu carries seat-private content in private-hand games.
  // Multi-device sessions: attach only when the caller's credential authorizes
  // the on-clock seat (host_token for unclaimed seats, claim_token for remote).
  // Single-device sessions (hot-seat) carry no auth — keep the menu there.
  try {
    verifySeatAuth(session, activeId, callerAuthToken);
  } catch {
    return undefined;
  }
  const moves = game.getLegalMoves(session, activeId);
  return buildMoveMenu(session, moves, game) ?? undefined;
}
