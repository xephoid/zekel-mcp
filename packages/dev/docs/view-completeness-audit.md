# View-completeness audit

The audit that led to **post-port runbook §1a** (read
[that section](./post-port-runbook.md#1a-view-completeness--the-table-reconstruction-test)
for the binding definition, classification, and rulings). It was one pass over
every game the server had at the time (19 of them), asking one question: *could
a human who lost track of the table fully and unambiguously rebuild everything
they are entitled to see, from `getPlayerView` alone?*

Keep it as a worked example of the §1a check, and as a list of the ways views
go wrong. Run the same audit on a new game during post-port.

Method: separate read-only passes classified every state field
(public-physical / private-known / hidden-by-rule / internal) and compared the
views against the first two categories. Two games (one of them Sweetlands
Imperium) were checked by hand; every other finding was
**re-checked against the code at fix time** — a row in an audit like this is a
claim with a citation, not yet a confirmed bug, until its status says so.

Statuses: `open` (reported, unverified) · `confirmed` (verified at fix time) ·
`fixed` (landed + view test) · `rejected` (verification showed no gap; reason
noted) · `deferred` (real, deliberately postponed; reason noted).

Rulings applied: face-up discard piles are public unless the rulebook forbids
inspection; tokenless-but-public facts (legality-gating flags, who-has-acted,
turn order) are in scope.

The findings for Zekel Games' own games are given in full below, with the file
each one was in; the code is public in
[zekel-games](https://github.com/xephoid/zekel-games) and each fix is locked by
the game's `src/__tests__/viewCompleteness.test.ts`. (Line numbers from the
audit are left out: the code has moved since.) The other games in the audit
belong to other publishers, so for those only the lesson is given.

---

## Tier 1 — problems that broke play or caused desyncs

These are from other publishers' games, described without naming them. Every finding here was verified real
and fixed, and locked by a view-completeness test.

- **A card duel** (nine gaps). An ability that added extra play areas showed
  them in neither view, so the opponent could not see cards attacking them. One
  of five public protection flags was left out while the other four were shown.
  Zones the `types.ts` header called public (the discard, a pile cards return
  from) were sent as a count or a top card only. Targets and modes players
  declared out loud were dropped. Zones showed card labels while moves took card
  ids, so the identifier the move needs was missing. Table-visible setup facts
  (who had redrawn their opening hand) were missing.
- **A two-sided map game** (five gaps, one claim rejected). An off-map holding
  area was skipped because the view only walked the map, so pieces there were
  invisible even to their owner. Markers attached to cards, mid-combat damage
  and combat progress could not be recovered (the owner got prose, the opponent
  got "waiting"). Build queues were prose-only where a per-slot count belonged.
  One side's own deduction record was missing from its private view. The
  rejected claim: the audit thought some scored cards were dropped, but by the
  rules those cards leave the game, so there was nothing on the table to show —
  the dead field was deleted instead.
- **An asymmetric dungeon game** (four gaps). The worst kind: the view worked out which way a player
  could move from the printed walls alone, so after any effect that opened or
  closed a passage it **actively misstated** the board. Fixed by computing it
  through the same engine function moves use. Also: face-up side objectives
  hidden; a visible token pile missing while a similar pile was shown; a count
  that decides the win could not be derived because the tiles it counts had been
  removed.
- **A two-player deduction game** (two gaps). A pending choice sent 0-based positions while
  the whole wire format is 1-based, so "1" meant the second item. The fix
  converted at the boundary and **renamed the field**, so an old reader gets
  nothing rather than a wrong number. The list itself had no explicit position
  labels, which is what made the first gap dangerous. Because this changed
  behaviour, the desync gate was re-run for that game.
- **A tile-laying game** (three gaps). A face-up stack of cards was flattened to its top
  surface, so the stack could not be rebuilt. View coordinates were shifted to a
  moving origin while moves used absolute coordinates, and the origin was never
  sent — the view and the moves disagreed about where `(0,0)` was. Who had
  already placed this step was missing.

---

## Tier 2 — completeness gaps

### Sweetlands Imperium *(checked by hand)*

| # | Field | Gap | File | Status |
|---|---|---|---|---|
| 1 | `UnitLocation` | prose-only via `describeLocation`, and **ambiguous**: `ringColor` is `i % 6` over a 12-space two-run ring, so "region 2 ring (yellow)" matches two spaces | `views.ts`, structured data unused in `types.ts` | fixed |

Fixed: structured `unit_locations` (the raw discriminated union, same frame as
moves) beside the prose, and the prose now carries the space index.

### Warble Way Galaxy

| # | Field | Gap | File | Status |
|---|---|---|---|---|
| 1 | item ids | `equipped`/`ship.parts` emit raw ids; the items ledger emits name/type/consumed with NO id — unjoinable | `types.ts`, `views.ts` | fixed |
| 2 | `RuinToken.is_character`/`unnamed`/`has_attacked` | dropped from `party[]`; `has_attacked` gates targeting legality | `types.ts`, `views.ts` | fixed |
| 3 | `attacker_turn_index` | only marker of enemy-phase progress; omitted | `types.ts` | fixed |
| 4 | space-combat modifiers | `volley_used`/`pirate_debuff`/`survivors_rolled`/`redline_used`/`player_buff` absent — player cannot compute a roll | `types.ts`, `views.ts` | fixed |
| 5 | habitat one-shots | `unnamed_rolled`, `fabricated_this_arrival`, `bulkheads_spent` missing while siblings are exposed | `types.ts`, `views.ts` | fixed |
| 6 | journey leg `mission_id` | prose-only; identical-stat missions indistinguishable | `views.ts`, `engine.ts` | fixed |
| 7 | travel-deck discard | face-up, server-tracked, emitted as count | `types.ts`, `views.ts` | fixed |

All seven verified real and fixed.

### Fractured Fist

| # | Field | Gap | File | Status |
|---|---|---|---|---|
| 1 | `playersDoneThisRound` | who is still owed a turn this round; absent, not derivable | `types.ts`, `engine.ts` | fixed |
| 2 | `focusReloadsThisTurn` | public legality-gating count (`FOCUS_RELOADS_PER_TURN`); absent | `types.ts`, `legalMoves.ts`, `engine.ts` | fixed |
| 3 | `startingHandSize` | per-player, option-configurable redraw size; absent | `types.ts`, `engine.ts` | fixed |
| 4 | tracked `discard` contents for opponents | count-only by documented design intent (`index.ts`) — **overruled** by the face-up discard ruling: physical Fractured Fist discards are face-up, so they are public | `types.ts`, `views.ts` | fixed |

### Other publishers' games

All verified real and fixed, each locked by a view-completeness test. Games are described, not named.

- **A game with a shared ring of spaces** *(checked by hand)*. Pawn positions and other markers
  around a shared ring were never shown; a token sitting on a board space was
  missing; progress tracks were collapsed to counts where the filled positions
  decide rewards; named pieces on a track or in a face-up area were collapsed
  to counts.
- **A dice-driven encounter game**. A public location report was declared public in `types.ts`
  and then mostly dropped from the view, including the list of places a player
  could go next. A public profile field was dropped. Encounter details were
  collapsed to a count. Queued bonuses that change the next encounter were
  invisible while similar modifiers were shown. When the server rolled the
  dice, a reroll offer did not show the dice.
- **A game with a co-operative mode**. Several public tokens and a once-per-game public action
  showed only in the AI's own view. A card that becomes public after a game
  event stayed AI-only. Pinned pieces were in neither view. In a co-operative
  mode, a player's own holdings were missing from their own view. Round order
  and who had acted were missing (tokenless but public, so in scope).
- **A space engine-building game**. Cubes on action spaces, which feed a scoring step, could
  not be recovered. A face-up one-shot card was missing. A visible stacking
  order used as a live tiebreaker was missing; only a turn order derived from it
  earlier was shown.
- **An economic track game**. An exact track position was reduced to a level, and
  several positions share each level, so the position was lost. Face-up
  discard piles were sent as counts.
- **A skirmish game**. A per-seat setup supply that limits legal moves was
  mentioned only in prose inside one seat's directive. Game over was reported
  with no winner field. Which players could still use a once-per-turn action
  was missing.
- **A tile-shedding game**. Tiles were shown by value only, so a player holding two
  tiles of the same value could not tell which one scored differently; the
  last-played tile was not sent. **While fixing this, a leak turned up:** tile
  ids encoded their values, and the public view sent the ids of face-down
  tiles, so anyone could read the hidden value. The fix nulls the id of
  face-down tiles in the public view and gives the owner their own ids in the
  private view. Lesson: an id that encodes a hidden value is itself hidden.
- **A card-driven space game**. A card that physically rests on another card until the round ends
  vanished from the player boards, with nothing in its place.
- **A round-based racing game**. The order players finished the round in (which decides
  the next first player) was missing (tokenless but public).
- **A card-capture game**. A face-up discard pile was count-only, even in the view of
  the side the server tracks.

---

## Clean

- **A board game with many figures** — every board component passes through with structured ids. One
  borderline case: a progress cursor sits inside a block the view deliberately
  leaves out; judged minor, and the reason for leaving the block out holds.
- **The round-based racing game above** — clean apart from its one tokenless-public gap.

## Checked and judged not gaps

Each of these looked like a gap and was not; the reasons are the useful part.

- **Fractured Fist**: the opponent's deck sent as `deck_count_by_card` — the
  order is hidden by rule, and the counts are all the table shows.
- A supply that always leaves lowest-first, sent as "how many left + the next
  level" — nothing is lost, because the remaining items follow from that
 .
- A discard pile sent as names without ids — the physical copies cannot be told
  apart, so the name is enough.
- Board cells dropping image fields — the wall layout can be rebuilt from the
  structured passages (once the dungeon game's first gap was fixed).
- A row of face-down and face-up tiles with each slot's position structured, the
  face-down value nulled in public and given to the owner privately — the model
  for how to show a partly hidden row.
- A hidden location masked in the public view, and a deck the server owns —
  correct by the rules.
- Tiles the players manage physically with no server state at all — exempt by
  definition.
