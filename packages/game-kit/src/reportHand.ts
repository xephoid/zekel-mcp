// Shared "human reports the cards they drew" plumbing (cross-game).
//
// A game with a single SHARED hidden draw deck cannot let the server own the deck
// order without contradicting the physical-first design: the human shuffles their
// OWN physical deck and draws random cards, which never match cards the server
// invented for them. The fix inverts ownership: the human physically shuffles and draws, REPORTS what they
// drew, and the server removes those from a tracked remainder and deals the AI's
// hand(s) from what's left — guaranteeing disjoint hands. The AI's hand stays
// hidden; only its board actions are narrated.
//
// This module owns only the cross-cutting WORDING (the next_step directive + the
// setup-checklist entry) so each game wires a report move in a few lines. The deck
// math (multiset+mint+reconcile for decks with duplicate cards, a unique-id slice
// for decks where every card is different) is game-specific and lives in each engine — a single "deal remainder to AI"
// util would straddle both shapes and become a leaky abstraction.

import type { NextStep, NextStepFacts, SetupStep } from './game.js';

// The phase-aware next_step directive for a "report what you drew" pending. Routes
// to the human who physically drew (NOT necessarily the active player — at a mid-game
// deal an AI may be the active seat) and NAMES the move + the ask-don't-invent rule.
export function reportHandNextStep(opts: {
  // The apply_move `type` the client must send (e.g. "report_initial_hand").
  moveType: string;
  // The human seat that physically drew and must report.
  playerId: string;
  // Exactly what to ask the human for (e.g. "the 8 card types in their hand plus the
  // 1 setup-discard type"). Phrased as the object of "ASK them for ...".
  ask: string;
  // Optional trailing sentence(s): where to read valid values, what the server does
  // with the report, etc.
  extra?: string;
  // The same facts as `extra`, structured for clients that never see the prose
  // instruction (NextStepFacts). The helper always adds that the server deals
  // the AI's hands from what is left.
  facts?: NextStepFacts;
}): NextStep {
  const { moveType, playerId, ask, extra, facts } = opts;
  return {
    status: 'human_to_move',
    active_player_id: playerId,
    instruction:
      `${playerId} physically shuffled the shared deck and drew. ASK ${playerId} for ${ask}, ` +
      `then submit apply_move { type: "${moveType}", player_id: "${playerId}", ... }. Do NOT invent ` +
      `the cards — report exactly what they drew. The server deals each AI's hand from the remainder ` +
      `(never revealed).` + (extra ? ` ${extra}` : ''),
    // Answer-shape hint: the highest-friction spot for card draws is the model
    // echoing an internal id ("cut-supply-lines-1") instead of the printed name.
    // Steer it to report NAMES.
    human_response: {
      ask: `which cards did ${playerId} draw? — report each by the NAME printed on it (${ask})`,
      example: 'I drew "Shipping Interest" and "Pottery" — the names printed on the cards, never an internal id like "guild-shipping-interest"',
      records_as: `${moveType} with player_id "${playerId}" and the drawn cards listed by their printed names`,
      // The caller's `ask` may name tool fields; the spoken question stays plain.
      spoken_ask: 'Which cards did you draw? Say each one by the name printed on it.',
      // A drawn hand is the player's secret: with other humans at the table it
      // must be entered privately (NextStep 'awaiting_private_input').
      private: true,
    },
    facts: {
      ...facts,
      notes: [...(facts?.notes ?? []), 'The server deals each AI hand from the cards that are left, without revealing them.'],
    },
  };
}

// The create_session setup-checklist entry for a report move.
export function reportHandChecklistStep(opts: {
  moveType: string;
  count: number;
  description: string;
  ask: string;
}): SetupStep {
  return {
    move_type: opts.moveType,
    count: opts.count,
    description: opts.description,
    ask_human_for: opts.ask,
  };
}
