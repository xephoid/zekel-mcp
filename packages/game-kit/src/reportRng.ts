// Deterministic side-seed derivation for the auto_report integration-harness
// report auto-resolver (`Game.autoResolveReport`).
//
// autoResolveReport is READ-ONLY — the auto_report tool returns a report move
// WITHOUT applying it, so the resolver must not advance the game's own RNG
// stream. To make engine-bot games FAITHFUL (a representative random draw from a
// hidden multiset, a real seeded dice roll) AND deterministic-per-seed, the
// resolver derives a *side* seed from the game's current RNG cursor plus a salt
// describing the specific report it is resolving:
//
//   same session seed → same game progression → same RNG cursor at each report →
//   same side seed → same picks/rolls.
//
// The salt keeps two distinct reports resolved at the same cursor (e.g. two
// court refills before any intervening shuffle) from collapsing to the same
// draw. Pre-shuffled ORDERED hidden decks (where taking from the top is already
// faithful) do not need this — it is for unordered multisets and dice only.

/** Mix a base RNG cursor with a string salt into a non-zero uint32 seed.
 *  FNV-1a over the salt, XOR-folded into the base cursor. */
export function deriveReportSeed(base: number, salt: string): number {
  let h = ((base >>> 0) ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < salt.length; i++) {
    h ^= salt.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Avoid 0: several of the repo's mulberry32-derived RNGs degenerate on it.
  return (h || 0x9e3779b9) >>> 0;
}
