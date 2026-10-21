// Metric extractors for the AI testing harness. The generic extractor runs
// for every game; a game may add its own through its dev hooks
// (devHooksFor(id).metrics, src/harness/devHooks.ts). The helpers below are
// shared with those per-game extractors.

import type { GameRecord, MoveRecord } from './runner.js';
import { devHooksFor } from './devHooks.js';

export type MetricValue = number | string | boolean | string[];
export type MetricsRecord = Record<string, MetricValue>;

export interface MetricsExtractor {
  (record: GameRecord): MetricsRecord;
}

// ---------- helpers ----------

export function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

export function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function moveType(m: MoveRecord): string {
  const t = (m.move as { type?: unknown } | null | undefined)?.type;
  return typeof t === 'string' ? t : 'unknown';
}

export function moveWeapon(m: MoveRecord): string | undefined {
  const w = (m.move as { weapon?: unknown } | null | undefined)?.weapon;
  return typeof w === 'string' ? w : undefined;
}

export function moveBool(m: MoveRecord, field: string): boolean {
  const v = (m.move as Record<string, unknown> | null | undefined)?.[field];
  return v === true;
}

export function moveHasObject(m: MoveRecord, field: string): boolean {
  const v = (m.move as Record<string, unknown> | null | undefined)?.[field];
  return typeof v === 'object' && v !== null;
}

export function moveField<T>(m: MoveRecord, field: string): T | undefined {
  const v = (m.move as Record<string, unknown> | null | undefined)?.[field];
  return v as T | undefined;
}

// ---------- generic extractor (works for any game) ----------

export const genericExtractor: MetricsExtractor = (record) => {
  const out: MetricsRecord = {
    total_turns: record.moves.length,
    distinct_winners: record.result.winners.length,
    is_tie: record.result.winners.length !== 1,
    has_error: !!record.error,
  };
  const byPlayer = groupBy(record.moves, (m) => m.player_id);
  for (const p of record.players) {
    const myMoves = byPlayer[p.player_id] ?? [];
    const byType = countBy(myMoves, moveType);
    out[`${p.player_id}_score`] = record.result.scores[p.player_id] ?? 0;
    out[`${p.player_id}_won`] = record.result.winners.includes(p.player_id);
    out[`${p.player_id}_action_count`] = myMoves.length;
    out[`${p.player_id}_action_variety`] = Object.keys(byType).length;
    for (const [type, count] of Object.entries(byType)) {
      out[`${p.player_id}_action_${type}`] = count;
    }
  }
  return out;
};

// ---------- composing generic + per-game (from the game's dev hooks) ----------

/** Compose the generic + (optional) game-specific extractor for a game. */
export function extractMetrics(record: GameRecord): MetricsRecord {
  const generic = genericExtractor(record);
  const specific = devHooksFor(record.game_id).metrics?.(record) ?? {};
  return { ...generic, ...specific };
}
