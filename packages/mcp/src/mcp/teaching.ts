// Teach-on-first-encounter (docs/rules-teaching.md channels 2 + 3). The first
// time a tagged phase or move type becomes live for a human seat, the response
// inlines that rules section ONCE (then never again — teach-once is what keeps
// lessons read instead of skimmed). The full-section lesson on a failed-gate
// rejection also renders through here. Lessons ride a rules_briefing SIBLING
// field — never inside next_step.instruction (that field has a never-bloat,
// never-lie contract the desync bot verifies).

import type { RuleSection, SessionState } from '@zekel/game-kit';
import type { AnyGame } from '../core/registry.js';
import { moveTypeOf } from '@zekel/game-kit';
import { sectionsForMoveType, sectionsForPhase } from '@zekel/game-kit';

export interface RulesBriefing {
  for_player: string;
  sections: Array<{ id: string; title: string; text: string }>;
  teach_note: string;
}

/** Teaching defaults ON; absent preference = on. */
export function teachingEnabled(session: SessionState<unknown>, playerId: string): boolean {
  return session.seatPreferences?.[playerId]?.teaching !== false;
}

/** Record delivered lessons on the seat (mutates the live session object; the
 *  caller owns when that gets saved). */
export function markTaught(
  session: SessionState<unknown>,
  playerId: string,
  sectionIds: string[],
): void {
  if (sectionIds.length === 0) return;
  const map = (session.taughtSections ??= {});
  const taught = (map[playerId] ??= []);
  for (const id of sectionIds) {
    if (!taught.includes(id)) taught.push(id);
  }
}

/** First-encounter sections for a seat: phase-tagged sections for the current
 *  phase (getCurrentPhase, when the game implements it) plus move-type-tagged
 *  sections for the types offered to this seat right now — minus everything
 *  this seat has already been taught. */
export function firstEncounterSections(
  game: AnyGame,
  session: SessionState<unknown>,
  playerId: string,
): RuleSection[] {
  const all = game.getRulesSections?.() ?? [];
  if (all.length === 0) return [];
  const taught = new Set(session.taughtSections?.[playerId] ?? []);
  const fresh: RuleSection[] = [];
  const seen = new Set<string>();
  const add = (secs: RuleSection[]) => {
    for (const s of secs) {
      if (!taught.has(s.id) && !seen.has(s.id)) {
        seen.add(s.id);
        fresh.push(s);
      }
    }
  };
  const phase = game.getCurrentPhase?.(session) ?? null;
  if (phase !== null) add(sectionsForPhase(all, phase));
  // Offered move types only fire when the seat is actually on the clock.
  if (session.activePlayerId === playerId) {
    const types = new Set<string>();
    for (const lm of game.getLegalMoves(session, playerId)) {
      const t = moveTypeOf(lm.move);
      if (t !== null) types.add(t);
    }
    for (const t of types) add(sectionsForMoveType(all, t));
  }
  return fresh;
}

/** Channel 2: the briefing to attach to a response for this seat, or null when
 *  there is nothing new to teach (or teaching is off / seat is not human).
 *  Caller must markTaught(taught_ids) + save, so a delivered lesson never
 *  repeats. */
export function buildRulesBriefing(
  game: AnyGame,
  session: SessionState<unknown>,
  playerId: string,
): { briefing: RulesBriefing; taught_ids: string[] } | null {
  const seat = session.players.find((p) => p.player_id === playerId);
  if (seat?.kind !== 'human') return null;
  if (!teachingEnabled(session, playerId)) return null;
  const fresh = firstEncounterSections(game, session, playerId);
  if (fresh.length === 0) return null;
  const name = seat.name ?? playerId;
  return {
    briefing: {
      for_player: playerId,
      sections: fresh.map((s) => ({ id: s.id, title: s.title, text: s.text })),
      teach_note:
        `FIRST TIME these rules are relevant this session. Briefly teach them to ${name} now ` +
        '(a sentence or two each, plain words) before play continues — this lesson will NOT repeat. ' +
        'If they say they know the game or want no teaching, turn it off with set_session_preferences.',
    },
    taught_ids: fresh.map((s) => s.id),
  };
}

/** Channel 3: the full-section lesson for a failed-gate rejection — the one
 *  moment the server can SEE the player wanted the blocked move. Returns the
 *  section (by the gate's rules_section id) or null. Inlined on every gated
 *  rejection regardless of taught state (demonstrated intent earns the full
 *  text); marking is still teach-once. */
export function gateLessonSection(
  game: AnyGame,
  sectionId: string | undefined,
): RuleSection | null {
  if (sectionId === undefined) return null;
  return (game.getRulesSections?.() ?? []).find((s) => s.id === sectionId) ?? null;
}
