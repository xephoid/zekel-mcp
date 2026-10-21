// The ai-harness per-seat feature table: rows of one value per seat, built from
// the per-game metrics records (seat ids ai1, ai2, ...). Shared by the
// ai-harness command and games' dev hooks (featureRows).

import type { MetricsRecord, MetricValue } from './metrics.js';

/** One row of the per-seat feature table. */
export interface FeatureRow {
  label: string;
  values: string[];
}

export function avg(values: number[]): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function pctTrue(values: boolean[]): number {
  if (values.length === 0) return 0;
  return values.filter(Boolean).length / values.length;
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function num(x: number, digits = 2): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(digits);
}

export function pluck(metricsList: MetricsRecord[], key: string): MetricValue[] {
  const out: MetricValue[] = [];
  for (const m of metricsList) {
    if (key in m) out.push(m[key]!);
  }
  return out;
}

export function asNumbers(values: MetricValue[]): number[] {
  return values.filter((v): v is number => typeof v === 'number');
}

export function asBooleans(values: MetricValue[]): boolean[] {
  return values.filter((v): v is boolean => typeof v === 'boolean');
}

export function makeNumericRow(metricsList: MetricsRecord[], playerCount: number, suffix: string, label: string): FeatureRow {
  const values: string[] = [];
  for (let i = 0; i < playerCount; i++) {
    const key = `ai${i + 1}_${suffix}`;
    const ns = asNumbers(pluck(metricsList, key));
    values.push(ns.length ? num(avg(ns)) : '—');
  }
  return { label, values };
}

export function makeBooleanRow(metricsList: MetricsRecord[], playerCount: number, suffix: string, label: string): FeatureRow {
  const values: string[] = [];
  for (let i = 0; i < playerCount; i++) {
    const key = `ai${i + 1}_${suffix}`;
    const bs = asBooleans(pluck(metricsList, key));
    values.push(bs.length ? pct(pctTrue(bs)) : '—');
  }
  return { label, values };
}

// "%-of-games where the per-player count > 0" — useful for at-least-one rollups.
export function makeAtLeastOneRow(metricsList: MetricsRecord[], playerCount: number, suffix: string, label: string): FeatureRow {
  const values: string[] = [];
  for (let i = 0; i < playerCount; i++) {
    const key = `ai${i + 1}_${suffix}`;
    const ns = asNumbers(pluck(metricsList, key));
    if (ns.length === 0) {
      values.push('—');
    } else {
      const atLeastOne = ns.filter((v) => v > 0).length / ns.length;
      values.push(pct(atLeastOne));
    }
  }
  return { label, values };
}

