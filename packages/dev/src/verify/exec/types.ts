// The executable half of rules verification (docs/rules-verification-brief.md,
// experiment 2). The engine plays; after every applied move, transition rules
// authored from the rulebook — each citing its licensing sentence verbatim,
// same linter discipline as the paper encoding — predict what the affected
// fields of the next state must be, computed from the ENGINE'S OWN previous
// state. A divergence is "rule X (quoting sentence Y) predicted Z for this
// field, the engine produced W".
//
// This is a deliberate narrowing of the brief's lockstep-simulator design: the
// rules side keeps no state of its own, so partial rule coverage produces no
// false alarms and no drift — at the cost of not catching missing-offered-move
// bugs (would need the rules side to enumerate moves) or bugs in fields no
// rule predicts. Recorded as a design divergence in AUDIT-FINDINGS.md.

// Each game defines its own common comparison shape (the projection target —
// e.g. CybernoirVerifyState in exec/cybernoir/project.ts); the driver, rules,
// and hunter are generic over it. Conventions a shape should follow: every
// field server-known, set-valued zones SORTED so diffs are order-independent
// (except where physical order IS the fact under test, like a jail track).

/** One applied engine move, as the rules side sees it. */
export interface VerifyEvent {
  moveIndex: number;
  /** Seat/role label of the player that submitted the move. */
  actor: string;
  /** The engine move's `type` discriminant. */
  moveType: string;
  /** The raw move, for rules that need its fields. */
  move: Record<string, unknown>;
  /** Driver-annotated: the next state's POI deck. Rules recover an arrest's
   * target by id-diffing instead of re-implementing printed-name resolution. */
  nextPoiDeck?: string[];
  /** Driver-annotated: ids that left the jail track this transition. */
  freedIds?: string[];
}

/** A transition rule: fires on matching events, checks prev -> next. Rules are
 * small functions (not the paper encoding's op-set data — a recorded v0
 * shortcut) but carry the same verbatim-citation obligation, enforced by the
 * existing linter over the pinned rules text. Generic over the game's
 * comparison shape. */
export interface OracleRule<V = unknown> {
  id: string;
  /** Move types this rule fires on; '*' fires on every transition. */
  on: string[] | '*';
  citation: { section: string; quote: string };
  /** Return every field-level violation of this rule for the transition.
   * Empty array = the transition satisfies the rule. */
  check: (prev: V, event: VerifyEvent, next: V) => RuleViolation[];
}

export interface RuleViolation {
  field: string;
  predicted: string;
  actual: string;
}

/** A divergence report, per the brief: seed, move index, field, cited
 * sentence, both values. */
export interface Divergence {
  seed: number;
  moveIndex: number;
  ruleId: string;
  field: string;
  citation: { section: string; quote: string };
  predicted: string;
  actual: string;
  moveType: string;
  actor: string;
}

/** Archive key for novelty scoring: one bug = one (rule, field) pair, however
 * many times and seeds it reproduces under. */
export function divergenceKey(d: Pick<Divergence, 'ruleId' | 'field'>): string {
  return `${d.ruleId} ${d.field}`;
}
