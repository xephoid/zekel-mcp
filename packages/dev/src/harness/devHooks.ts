// What a game gives the development tools beyond the Game itself: its "dev
// hooks".
//
// The tools (balance analysis, metrics, the ai-harness command, the rules
// checker, the desync bot) used to hold per-game lists — game A's dead-turn
// rule, game B's sweep, game C's rules-checker adapter. Each game now supplies
// those parts itself, as one optional bundle registered under its game id, and
// the tools look the bundle up. A game with no bundle gets the generic
// behaviour, exactly as before.
//
// Who registers: the project that knows which games exist, before it runs a
// command (and in its test setup). The tools never import a game. A tool that
// looks hooks up before ANY bundle was registered stops with an error instead
// of silently running without the games' settings (which would quietly produce
// different balance numbers).

import type { AnalysisOverride } from './analysis.js';
import type { MetricsExtractor, MetricsRecord } from './metrics.js';
import type { VerifyAdapter } from '../verify/exec/driver.js';
import type { FeatureRow } from './featureRows.js';

/** How a --sweep=<name> varies a game's options from game to game. */
export interface SweepSpec {
  /** Which option to vary. */
  optionKey: string;
  /** How many to pick from the pool for each game. */
  count: number;
  /** The values to pick from. */
  pool: string[];
  /** Guarantee at least one pick comes from this subset of the pool. */
  mustIncludeFrom?: string[];
  /** A related assignment, sampled without replacement from eligible values
   *  for each primary pick (e.g. species-eligible leaders). */
  companion?: { optionKey: string; eligible: Record<string, string[]> };
}

/** Builds a sweep from the game's own reference data (get_rules), or null when
 *  the reference data lacks what the sweep needs. */
export type SweepBuilder = (reference: Record<string, unknown>) => SweepSpec | null;

/** A game whose --strategy names are identities it can DRAFT for (Fractured
 *  Fist's factions co-drafting a shared loadout). */
export interface StrategyDraft {
  /** A draft plan for this --strategy list, or null when the list isn't one
   *  this game drafts for (then the generic strategy handling applies). */
  plan(strategies: string[], reference: Record<string, unknown>): StrategyDraftPlan | null;
}

export interface StrategyDraftPlan {
  /** One line for the log, e.g. "Faction draft: a, b — fixed pair, …". */
  describe(strategyCount: number): string;
  /** The strategy (identity) of each seat for the game with this seed. */
  seatStrategies(seats: number, seed: number): string[];
  /** The game options for one game, from its final seats' strategies and
   *  difficulties. These replace any sweep for that game. */
  options(seed: number, seatStrategies: string[], seatDifficulties: Array<string | undefined>): Record<string, unknown>;
}

/** The desync bot's per-game help: how a real player would SAY a move, and how
 *  to tidy a move before comparing the recorded one with the intended one. */
export interface DesyncHooks {
  /** A whole utterance for this move, or null to use the generic wording. */
  utterance?(move: unknown, isReport: boolean, view: Record<string, unknown>, playerId: string): string | null;
  /** How to say one value inside a move (e.g. a card object), or null for the
   *  generic "key value, key value" rendering. */
  renderValue?(value: Record<string, unknown>): string | null;
  /** How to say a REPORT move whose values need game-specific wording, or null
   *  for the generic wording. Called after names are resolved. */
  reportUtterance?(move: Record<string, unknown>): string | null;
  /** Tidy a move (already name-resolved) before comparing recorded with intended. */
  canonicalMove?(move: Record<string, unknown>): Record<string, unknown>;
}

export interface GameDevHooks {
  /** Balance analysis: dead turns, real turns, extra lift features, … */
  analysis?: AnalysisOverride;
  /** Extra per-game metrics, merged over the generic ones. */
  metrics?: MetricsExtractor;
  /** Rules-checker adapters, by adapter id (usually the game id; a game may add
   *  variants, e.g. 'sweetlands-imperium-5p'). */
  verify?: Record<string, VerifyAdapter<unknown>>;
  /** --sweep=<name> builders. */
  sweeps?: Record<string, SweepBuilder>;
  /** --strategy names this game drafts for. */
  strategyDraft?: StrategyDraft;
  /** Extra rows for the ai-harness per-seat feature table (build them with
   *  src/harness/featureRows.ts). */
  featureRows?(metrics: MetricsRecord[], playerCount: number): FeatureRow[];
  /** Desync bot wording and comparison help. */
  desync?: DesyncHooks;
}

const registry = new Map<string, GameDevHooks>();
let loaded = false;

/** Register a game's dev hooks under its game id. */
export function registerDevHooks(gameId: string, hooks: GameDevHooks): void {
  registry.set(gameId, hooks);
  loaded = true;
}

/** Mark the hooks as loaded even when no game has any (a setup with no
 *  per-game parts at all). */
export function markDevHooksLoaded(): void {
  loaded = true;
}

function assertLoaded(): void {
  if (!loaded) {
    throw new Error(
      'No game dev hooks were loaded. A tool looked up per-game settings before the games registered them; ' +
        'register them with registerDevHooks (or call markDevHooksLoaded when no game has any) before running a tool.',
    );
  }
}

/** A game's dev hooks; an empty bundle when the game has none. */
export function devHooksFor(gameId: string): GameDevHooks {
  assertLoaded();
  return registry.get(gameId) ?? {};
}

/** The rules-checker adapter with this id, from whichever game supplies it. */
export function verifyAdapterFor(adapterId: string): VerifyAdapter<unknown> | undefined {
  assertLoaded();
  for (const hooks of registry.values()) {
    const adapter = hooks.verify?.[adapterId];
    if (adapter) return adapter;
  }
  return undefined;
}

/** Every registered rules-checker adapter id. */
export function verifyAdapterIds(): string[] {
  assertLoaded();
  return [...registry.values()].flatMap((h) => Object.keys(h.verify ?? {})).sort();
}
