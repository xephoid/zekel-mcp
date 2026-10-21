// Rules encoding — the second, engine-independent statement of a game's rules,
// authored from the rulebook text ALONE (never from the game module). It exists
// so the two statements can be compared: the linter audits the encoding on paper
// (verbatim citations + full zone-by-event coverage), and later tooling replays
// games against it. Idea and experiments: docs/rules-verification-brief.md.
//
// Design constraints that are load-bearing:
// - Gaps are explicit entries (status 'silent' / 'vague'), never absences. The
//   coverage matrix makes a gap unwritable-around: every zone x event cell must
//   be a rule, a gap entry, or a reasoned not-applicable.
// - Every rule cites a VERBATIM quote of the licensing rulebook sentence. The
//   linter string-searches the pinned plain-text rules for it, so a citation
//   cannot be faked.
// - The effect op set is closed and tiny, growing only on demand.

/** Everything the game's table contains, declared up front so coverage can be
 * measured against it. Authored from the rulebook, like the entries. */
export interface RulesUniverse {
  /** Every place a component can sit (decks, hands, discard piles, the board,
   * tracks, supplies). Plain names, e.g. "location deck". */
  zones: string[];
  /** Every numeric quantity the rules mention (action points, clue counts,
   * hand sizes, track positions). */
  counters: string[];
  /** Every kind of thing that can happen (each player action, each mandatory
   * step, each triggered effect, each end condition). */
  eventKinds: string[];
}

/** A verbatim quote of the rulebook sentence licensing an entry. The linter
 * requires `quote` to appear in the pinned rules text exactly (only runs of
 * whitespace are collapsed before comparing, because the text is hard-wrapped). */
export interface Citation {
  /** Section reference as printed, e.g. "5.1" or "9". */
  section: string;
  quote: string;
}

/** The closed op set. Values and conditions are readable strings (this encoding
 * is audited on paper first; execution comes with the game driver later). */
export type RuleEffect =
  | { op: 'move_token'; token: string; from: string; to: string }
  | { op: 'set_counter'; counter: string; to: number | string }
  | { op: 'adjust_counter'; counter: string; by: number | string }
  | { op: 'advance_track'; track: string; by: number | string }
  | { op: 'draw'; from: string; to: string; count: number | string }
  | { op: 'conditional'; condition: string; then: RuleEffect[]; otherwise?: RuleEffect[] }
  | { op: 'player_choice'; chooser: string; choiceOf: string; then: RuleEffect[] }
  | { op: 'game_end'; winner: string; reason: string };

interface EntryCommon {
  /** Stable kebab-case id, unique within the encoding. */
  id: string;
  /** Which universe event kind this entry is about. */
  eventKind: string;
  /** Which universe zones this entry touches (used for coverage). */
  zones: string[];
  notes?: string;
}

/** One rule the book actually states. */
export interface RuleEntry extends EntryCommon {
  status: 'rule';
  /** When the rule fires, in plain words over observable facts. */
  trigger: string;
  effects: RuleEffect[];
  citation: Citation;
}

/** The book says NOTHING about a reachable situation; a ruling is needed.
 * The citation, when present, quotes the nearest sentence that stops short. */
export interface SilentEntry extends EntryCommon {
  status: 'silent';
  /** The concrete situation the book does not cover. */
  situation: string;
  /** The question a designer would have to answer. */
  rulingNeeded: string;
  citation?: Citation;
}

/** The book supports two or more readings of the same sentence. */
export interface VagueEntry extends EntryCommon {
  status: 'vague';
  situation: string;
  /** The competing readings, each stated fully (at least two). */
  readings: string[];
  citation: Citation;
}

export type EncodingEntry = RuleEntry | SilentEntry | VagueEntry;

/** An explicit "nothing can happen here, and here is why" cell. */
export interface NotApplicableCell {
  zone: string;
  eventKind: string;
  reason: string;
}

export interface GameRulesEncoding {
  gameId: string;
  /** The rules version this encoding was authored against, e.g. "pre-v2.3". */
  rulesVersion: string;
  /** Repo-relative path of the pinned plain-text rules the citations live in. */
  rulesFile: string;
  universe: RulesUniverse;
  entries: EncodingEntry[];
  notApplicable: NotApplicableCell[];
}
