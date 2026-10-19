// Helpers for sectioned rules (docs/rules-teaching.md). A game authors its
// rules as RuleSection[] (addressable, tagged); everything else derives:
// the getRulesText blob (renderRulesText), the get_rules topic filter
// (findSections), teach triggers (sectionsForMoveType / sectionsForPhase),
// and the per-game coverage lock (validateSectionCoverage).

import type { RuleSection } from './game.js';

/** Render sections to the single rules-text blob. Games implement
 *  getRulesText() as `renderRulesText(SECTIONS)` so blob and sections are one
 *  source. */
export function renderRulesText(sections: RuleSection[]): string {
  return sections.map((s) => `## ${s.title}\n\n${s.text}`).join('\n\n');
}

/** Sections governing a move type (a moveSchema discriminant). */
export function sectionsForMoveType(
  sections: RuleSection[],
  moveType: string,
): RuleSection[] {
  return sections.filter((s) => s.tags.move_types?.includes(moveType));
}

/** Sections governing a game-defined phase label. */
export function sectionsForPhase(sections: RuleSection[], phase: string): RuleSection[] {
  return sections.filter((s) => s.tags.phases?.includes(phase));
}

/** Topic lookup for the get_rules filter: exact id match wins; otherwise
 *  case-insensitive substring match on id or title. Returns [] on no match
 *  (caller renders the section index so the model can pick a valid topic). */
export function findSections(sections: RuleSection[], topic: string): RuleSection[] {
  const exact = sections.filter((s) => s.id === topic);
  if (exact.length) return exact;
  const needle = topic.trim().toLowerCase();
  if (!needle) return [];
  return sections.filter(
    (s) => s.id.toLowerCase().includes(needle) || s.title.toLowerCase().includes(needle),
  );
}

/** The per-game coverage lock (docs/rules-teaching.md "Test locks"): every
 *  move type must be governed by at least one section. Returns the move types
 *  with NO section — a game's test asserts this is empty, so an untagged new
 *  move type is a red test, not a silent no-hint gap. The game passes its own
 *  move-type list (it knows its moveSchema discriminants). */
export function validateSectionCoverage(
  sections: RuleSection[],
  moveTypes: string[],
): string[] {
  return moveTypes.filter((t) => sectionsForMoveType(sections, t).length === 0);
}

/** Duplicate-id guard, used by the same lock test. */
export function duplicateSectionIds(sections: RuleSection[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const s of sections) {
    if (seen.has(s.id)) dups.add(s.id);
    seen.add(s.id);
  }
  return [...dups];
}
