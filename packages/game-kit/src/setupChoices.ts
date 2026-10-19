// Shared "setup-choice ownership" plumbing (cross-game).
//
// Many games open with a per-seat IDENTITY choice that belongs to the human, not
// the server: a standee COLOR (Snallygaster, Brass), a FACTION color (Arcs), a GOD
// (Ankh), a character, a starting leader, etc. Left to a generic turn loop the model
// silently auto-assigns these by seat index — picking for the human, who never gets
// asked. This module standardizes the FIX so each game wires it in ~10 lines instead
// of hand-rolling the pending, the validation, and the directive wording:
//
//   1. The session starts BLOCKED on the choice when a human is present (a per-game
//      pending), owned by ONE human reporter who submits the whole seat→option map
//      in a single move (humans state their own; the table also picks for AI seats).
//   2. `setupChoiceChecklistStep` surfaces it in create_session.setup_checklist.
//   3. `setupChoiceNextStep` emits the human_to_move directive that NAMES the move
//      and says "ask the humans — do NOT pick for them".
//   4. `validateSetupSelections` enforces full coverage / valid options / distinctness.
//   5. All-AI sessions auto-assign via `defaultSetupAssignment` and skip the handshake
//      (empty checklist, null override) so the harness is unaffected.
//
// The helpers are PURE (no RNG / clock / IO). The OPTION POOL and the STATE FIELD the
// choice sets are game-specific — the game owns those; this module owns the rails and
// the wording. The recommended shared move shape is:
//   { type: 'assign_setup_choices'; selections: Record<playerId, optionId> }
// (a game may keep a legacy game-specific move name — Snallygaster predates this and
// uses `assign_kid_colors` — but new games should use the shared shape.)

import type { NextStep, PlayerConfig, SetupStep } from './game.js';
import { seatDisplayName } from './seatNames.js';
import { GameError } from './errors.js';

export interface SetupChoiceOption {
  id: string; // the value stored on state + sent in `selections`
  label: string; // human-facing (e.g. "Anubis — God of the Dead")
}

export interface SetupChoiceSpec {
  // What is being chosen, singular, lowercase — e.g. "standee color", "god", "faction color".
  choiceLabel: string;
  // The pool every seat picks from.
  options: SetupChoiceOption[];
  // The seats that must choose (usually every player; e.g. all of Brass, or every
  // Kid in Snallygaster — exclude seats that don't get this identity, like the
  // hidden Lost Kid). Order is the seat/turn order, used for the default assignment.
  seats: PlayerConfig[];
  // Must each seat pick a DIFFERENT option (colors, factions, gods → true)? When
  // false, seats may share (rare). Defaults to true at the call sites that omit it.
  distinct: boolean;
}

// The first human seat among the choosers — the reporter who submits the map. Null
// when every chooser is an AI (→ all-AI auto-setup, no human handshake).
export function firstHumanReporter(seats: PlayerConfig[]): string | null {
  return seats.find((p) => p.kind === 'human')?.player_id ?? null;
}

// Distinct default assignment (seat i → option i). Used for the all-AI auto-setup
// path and as the "confirm defaults" option in get_legal_moves. Requires at least as
// many options as seats when distinct; falls back to round-robin if not (non-distinct).
export function defaultSetupAssignment(spec: SetupChoiceSpec): Record<string, string> {
  const out: Record<string, string> = {};
  spec.seats.forEach((seat, i) => {
    const opt = spec.distinct ? spec.options[i] : spec.options[i % spec.options.length];
    if (opt) out[seat.player_id] = opt.id;
  });
  return out;
}

// Validate a submitted selections map for an `assign_setup_choices`-style move.
// Throws GameError (ILLEGAL_MOVE) with a clear message on any problem. `actualPlayerId`
// is the player who sent the move; it must equal the designated `reporterId`.
export function validateSetupSelections(
  spec: SetupChoiceSpec,
  selections: Record<string, string>,
  reporterId: string,
  actualPlayerId: string,
): void {
  if (actualPlayerId !== reporterId) {
    throw new GameError('ILLEGAL_MOVE', `Only the reporting player (${reporterId}) assigns the ${spec.choiceLabel}s`);
  }
  const optionIds = new Set(spec.options.map((o) => o.id));
  const used: string[] = [];
  for (const seat of spec.seats) {
    const choice = selections[seat.player_id];
    if (!choice) {
      throw new GameError('ILLEGAL_MOVE', `Missing a ${spec.choiceLabel} for ${seat.player_id}`);
    }
    if (!optionIds.has(choice)) {
      throw new GameError(
        'ILLEGAL_MOVE',
        `"${choice}" is not a valid ${spec.choiceLabel} (choose from ${spec.options.map((o) => o.id).join(', ')})`,
      );
    }
    if (spec.distinct && used.includes(choice)) {
      throw new GameError('ILLEGAL_MOVE', `Two players cannot share the ${choice} ${spec.choiceLabel}`);
    }
    used.push(choice);
  }
}

// The create_session setup-checklist entry. Returns null when there is no human
// chooser (all-AI session auto-assigns → empty checklist).
export function setupChoiceChecklistStep(moveType: string, spec: SetupChoiceSpec): SetupStep | null {
  if (!firstHumanReporter(spec.seats)) return null;
  const pool = spec.options.map((o) => o.id).join('/');
  return {
    move_type: moveType,
    count: 1,
    description:
      `Assign each player a ${spec.choiceLabel} before the first turn` +
      (spec.distinct ? ' (each distinct' : ' (') +
      `, from ${pool}). Humans choose FIRST — ask each their own; then assign each AI seat one of the REMAINING ${spec.choiceLabel}s.`,
    ask_human_for: `each human's chosen ${spec.choiceLabel} FIRST (then pick a ${spec.choiceLabel} for any AI seat from what's left)`,
  };
}

// The phase-aware next_step directive for the choice. Routes to the human reporter
// and NAMES the move + the ask-don't-invent rule. Returns null when the reporter is
// not human (shouldn't happen — reporter is chosen as the first human — but stays safe
// so the generic ai_to_move directive stands for an all-AI session).
export function setupChoiceNextStep(
  moveType: string,
  spec: SetupChoiceSpec,
  reporterId: string,
): NextStep | null {
  const reporterSeat = spec.seats.find((p) => p.player_id === reporterId);
  if (!reporterSeat || reporterSeat.kind !== 'human') return null;
  const humans = spec.seats.filter((p) => p.kind === 'human').map((p) => p.player_id);
  const ais = spec.seats.filter((p) => p.kind === 'ai').map((p) => p.player_id);
  const display = (o: { id: string; label?: string }): string => (o.label && o.label !== o.id ? o.label : o.id);
  const pool = spec.options.map((o) => (o.label && o.label !== o.id ? `${o.id} (${o.label})` : o.id)).join(', ');
  const firstDisplay = spec.options[0] ? display(spec.options[0]) : `a ${spec.choiceLabel}`;
  return {
    status: 'human_to_move',
    active_player_id: reporterId,
    instruction:
      `SETUP — assign each player a ${spec.choiceLabel} before play begins. FIRST ASK each human ` +
      `(${humans.join(', ')}) which ${spec.choiceLabel} they want` +
      (ais.length
        ? `; THEN assign each AI seat (${ais.join(', ')}) one of the ${spec.choiceLabel}s the humans did NOT take`
        : '') +
      `. ${spec.distinct ? 'Each must be distinct. ' : ''}Choose from: ${pool}. ` +
      `Send ${moveType}{selections:{<player_id>:<${spec.choiceLabel.replace(/\s+/g, '_')}>, ...}} covering EVERY player. ` +
      `Humans choose first — do NOT pick their ${spec.choiceLabel}s for them, and never give an AI an option before a human has chosen. (get_legal_moves offers the default map to confirm or edit.)`,
    // Answer-shape hint: the identity pick is a top spot for the model to invent an
    // id or pick silently. Name the options + the per-player map it records as.
    human_response: {
      ask: `which ${spec.choiceLabel} does each player want? Ask each human FIRST, then give each AI seat one of the remaining options. Choose from: ${pool}.${spec.distinct ? ' Each must be distinct.' : ''}`,
      example: `I'll take ${firstDisplay}${ais.length ? ` and give the AI ${spec.options[1] ? display(spec.options[1]) : 'another option'}` : ''}`,
      records_as: `${moveType} with selections: a map of every player_id to their chosen ${spec.choiceLabel} (by name or id)`,
    },
    facts: {
      phase: 'Setup',
      options: spec.options.map(display),
      notes: [
        `Each human picks their own ${spec.choiceLabel} first: ${humans.map((id) => seatDisplayName(spec.seats, id)).join(', ')}.`,
        ...(ais.length
          ? [`Then each AI seat takes one of the ${spec.choiceLabel}s left over: ${ais.map((id) => seatDisplayName(spec.seats, id)).join(', ')}.`]
          : []),
        ...(spec.distinct ? [`Every player's ${spec.choiceLabel} must be different.`] : []),
      ],
    },
  };
}
