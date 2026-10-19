// Checks for NextStep.facts (see NextStepFacts in core/game.ts). Orchestrated clients read these fields instead of the prose
// `instruction`, and zekel Live may speak them, so they must hold game facts
// only — never the loop directions that belong to `instruction`.

import type { NextStep } from './game.js';

// Words that mark a loop direction or tool jargon, not a game fact.
const DIRECTION_PATTERNS: RegExp[] = [
  /\bcall\b/i,
  /\bapply_move\b/,
  /\brun_ai_turn\b/,
  /\bget_[a-z_]+\b/,
  /\bdo not invent\b/i,
  /\bdon't invent\b/i,
  /\bASK\b/,
  /\bnext_step\b/,
  /\bmove_id\b/,
];

/** Every problem with a step's structured fact text; [] when clean. */
export function lintNextStepFacts(step: NextStep): string[] {
  const problems: string[] = [];
  const check = (where: string, text: string | undefined): void => {
    if (text === undefined) return;
    if (text.trim() === '') problems.push(`${where} is empty`);
    for (const re of DIRECTION_PATTERNS) {
      if (re.test(text)) problems.push(`${where} contains a loop direction (${re}): ${JSON.stringify(text)}`);
    }
  };
  const f = step.facts;
  if (f) {
    check('facts.phase', f.phase);
    check('facts.reason', f.reason);
    check('facts.repeat', f.repeat);
    f.options?.forEach((o, i) => check(`facts.options[${i}]`, o));
    f.notes?.forEach((n, i) => check(`facts.notes[${i}]`, n));
    if (f.progress && (f.progress.current < 1 || f.progress.current > f.progress.total)) {
      problems.push(`facts.progress out of range: ${f.progress.current} of ${f.progress.total}`);
    }
  }
  return problems;
}
