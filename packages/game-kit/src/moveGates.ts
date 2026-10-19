// Helpers for move-gate declarations (docs/rules-teaching.md). A game's
// describeMoveGates hook reports the live status of every seat-applicable move
// TYPE; these helpers turn that into the ambient grey list on get_legal_moves,
// the apply_move rejection enrichment, and the consistency lock that keeps the
// gates honest against getLegalMoves.

import { GameError } from './errors.js';
import type { LegalMove, MoveGateStatus, PendingOption, PendingView } from './game.js';

/** A grey-list entry as surfaced to the client. */
export interface UnavailableMove {
  move_type: string;
  /** One blocked option of the type (a purchasable, a treaty), when the gate
   *  names one; absent = the whole move type is unavailable. */
  item?: string;
  reason: string;
  /** Governing RuleSection id, when the gate declared one. */
  rules_section?: string;
}

/** Reads the conventional discriminant off an arbitrary move shape. */
export function moveTypeOf(move: unknown): string | null {
  if (move === null || typeof move !== 'object') return null;
  const m = move as Record<string, unknown>;
  const t = m.type ?? m.action;
  return typeof t === 'string' ? t : null;
}

function offeredTypes(legalMoves: Array<LegalMove<unknown>>): Set<string> {
  const types = new Set<string>();
  for (const lm of legalMoves) {
    const t = moveTypeOf(lm.move);
    if (t !== null) types.add(t);
  }
  return types;
}

/** The ambient grey list: declared gates whose move type has ZERO legal
 *  instances right now. Entries reported 'available' are never greyed (a
 *  disagreement with getLegalMoves is a bug checkGateConsistency exists to
 *  catch — we do not paper over it here). */
export function unavailableMoves(
  gates: MoveGateStatus[],
  legalMoves: Array<LegalMove<unknown>>,
): UnavailableMove[] {
  const offered = offeredTypes(legalMoves);
  return gates
    // A whole-type entry greys only when the type has no instance; an item
    // entry names one blocked option and greys beside the offered ones.
    .filter((g) => g.status !== 'available' && (g.item !== undefined || !offered.has(g.move_type)))
    .map((g) => ({
      move_type: g.move_type,
      ...(g.item !== undefined ? { item: g.item } : {}),
      reason: g.reason ?? 'not available right now',
      ...(g.rules_section !== undefined ? { rules_section: g.rules_section } : {}),
    }));
}

/** The consistency lock (the load-bearing test of the feature): the hook and
 *  getLegalMoves must agree. Returns human-readable mismatches; a per-game
 *  test asserts [] across representative states. */
export function checkGateConsistency(
  gates: MoveGateStatus[],
  legalMoves: Array<LegalMove<unknown>>,
): string[] {
  const offered = offeredTypes(legalMoves);
  const problems: string[] = [];
  for (const g of gates) {
    // Item entries speak about one option; the game's own test checks them.
    if (g.item !== undefined) continue;
    if (g.status === 'available' && !offered.has(g.move_type)) {
      problems.push(
        `gate says '${g.move_type}' is available but getLegalMoves offers no instance`,
      );
    }
    if (g.status !== 'available' && offered.has(g.move_type)) {
      problems.push(
        `gate says '${g.move_type}' is ${g.status} but getLegalMoves offers it`,
      );
    }
  }
  return problems;
}

/** Order-insensitive structural equality for move shapes (plain JSON data). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The instance-level companion to checkGateConsistency: a pending's published
 *  options and getLegalMoves must agree. An open option's `move` must be
 *  offered; a shut option must carry a reason and no move. When `wouldBe` can
 *  name the move a shut option stands for, that move must NOT be offered —
 *  unless an open option carries the same move (two copies of one card, one
 *  playable: the move is legal through the other). Returns human-readable
 *  mismatches; a per-game test asserts [] across representative states. */
export function checkPendingOptionConsistency<Move>(
  pending: PendingView<Move> | null | undefined,
  legalMoves: Array<LegalMove<Move>>,
  wouldBe?: (option: PendingOption<Move>) => Move | undefined,
): string[] {
  if (!pending?.options) return [];
  const offered = new Set(legalMoves.map((lm) => canonical(lm.move)));
  const openMoves = new Set(
    pending.options.filter((o) => o.move !== undefined).map((o) => canonical(o.move)),
  );
  const problems: string[] = [];
  for (const o of pending.options) {
    const where = `${pending.kind} option '${o.option_id}'`;
    if (o.move !== undefined && o.blocked_reason !== undefined) {
      problems.push(`${where} carries both a move and a blocked_reason`);
    }
    if (o.move === undefined && o.blocked_reason === undefined) {
      problems.push(`${where} carries neither a move nor a blocked_reason`);
    }
    if (o.move !== undefined && !offered.has(canonical(o.move))) {
      problems.push(`${where} is open but getLegalMoves does not offer ${canonical(o.move)}`);
    }
    if (o.blocked_reason !== undefined && wouldBe) {
      const m = wouldBe(o);
      if (m !== undefined && offered.has(canonical(m)) && !openMoves.has(canonical(m))) {
        problems.push(`${where} is shut ("${o.blocked_reason}") but getLegalMoves offers ${canonical(m)}`);
      }
    }
  }
  return problems;
}

/** Rejection enrichment: when the engine rejects a move whose type a gate
 *  reports blocked, append the gate's live reason so the rejection carries the
 *  rule instead of leaving a vacuum. Returns the original error untouched when
 *  no gate speaks to it. */
export function enrichGateRejection(
  err: unknown,
  gates: MoveGateStatus[] | undefined,
  move: unknown,
): unknown {
  if (!(err instanceof GameError) || !gates) return err;
  const type = moveTypeOf(move);
  if (type === null) return err;
  // Prefer the gate naming this exact option (a field of the move equal to
  // its item, e.g. item: "Dragon"), then the whole-type gate.
  const values = new Set(Object.values(move as Record<string, unknown>)
    .filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase()));
  const blocked = gates.filter((g) => g.move_type === type && g.status !== 'available');
  const gate = blocked.find((g) => g.item !== undefined && values.has(g.item.toLowerCase()))
    ?? blocked.find((g) => g.item === undefined);
  if (!gate?.reason) return err;
  const details = {
    ...(err.details !== undefined && err.details !== null && typeof err.details === 'object'
      ? (err.details as Record<string, unknown>)
      : {}),
    ...(gate.rules_section !== undefined ? { rules_section: gate.rules_section } : {}),
  };
  return new GameError(
    err.error_code,
    `${err.message} Why: ${type}${gate.item !== undefined ? ` ${gate.item}` : ''} — ${gate.reason}.`,
    Object.keys(details).length ? details : undefined,
  );
}
