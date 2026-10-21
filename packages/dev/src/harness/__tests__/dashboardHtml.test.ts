import { describe, expect, it } from 'vitest';

import { analyzeBatch } from '../analysis.js';
import { markDevHooksLoaded } from '../devHooks.js';
import { renderCompareHtml, renderDashboardHtml, type DashboardMeta } from '../dashboardHtml.js';
import type { GameRecord } from '../runner.js';

// Build a small synthetic batch through the real analyzeBatch so the dashboard
// is exercised against the genuine BatchAnalysis shape, not a hand-rolled stub.
function record(seed: number, winner: 'p1' | 'p2'): GameRecord {
  const moves = [
    { turn: 1, player_id: 'p1', move: { type: 'play_card', card_id: 'attack' }, narration: '', summary: '' },
    { turn: 2, player_id: 'p1', move: { type: 'end_turn' }, narration: '', summary: '' },
    { turn: 3, player_id: 'p2', move: { type: 'play_card', card_id: 'block' }, narration: '', summary: '' },
    { turn: 4, player_id: 'p2', move: { type: 'end_turn' }, narration: '', summary: '' },
  ];
  return {
    game_id: 'testgame',
    seed,
    players: [
      { player_id: 'p1', kind: 'ai', difficulty: 'medium', strategy: 'aggro' },
      { player_id: 'p2', kind: 'ai', difficulty: 'medium', strategy: 'control' },
    ],
    moves,
    result: { winners: [winner], scores: { p1: winner === 'p1' ? 10 : 4, p2: winner === 'p2' ? 10 : 4 }, summary: '' },
    final_views: {},
  };
}

const meta: DashboardMeta = {
  gameId: 'testgame',
  title: 'Test <Game> & Co',
  generatedAt: '2026-07-06',
  settings: { games: '8', skill: 'medium', 'strategy mix': 'uniform over {aggro, control}' },
};

markDevHooksLoaded();

describe('renderDashboardHtml', () => {
  const records = Array.from({ length: 8 }, (_, i) => record(i + 1, i % 2 === 0 ? 'p1' : 'p2'));
  const analysis = analyzeBatch(records);
  const html = renderDashboardHtml(meta, [{ label: '2 players', analysis }], { minSample: 2 });

  it('is a self-contained page with no external resources', () => {
    expect(html).toContain('<!doctype html>');
    expect(html).not.toMatch(/src="http/);
    expect(html).not.toMatch(/href="http/);
    expect(html).not.toContain('@import');
  });

  it('escapes HTML in user-facing strings', () => {
    expect(html).toContain('Test &lt;Game&gt; &amp; Co');
    expect(html).not.toContain('Test <Game>');
  });

  it('renders every core section', () => {
    for (const heading of [
      'Does going first matter?',
      'Do games feel close?',
      'Which cards and actions win games?',
      'Do any combos break the game?',
      'What speeds games up — and what slows them down',
      'What ends games quickly?',
      'What makes games drag on?',
      'Games played',
    ]) {
      expect(html).toContain(heading);
    }
  });

  it('renders the strategy matchup matrix with its metagame read', () => {
    expect(html).toContain('Who beats whom?');
    expect(html).toContain('aggro');
    expect(html).toContain('control');
  });

  it('uses the tie-adjusted fair-share baseline for seats', () => {
    // 0 ties in this batch and 2 seats → fair share is exactly 50.0%.
    expect(html).toContain('give each seat 50.0%');
  });

  it('keeps the statistical machinery available in collapsible notes', () => {
    expect(html).toContain('class="nerd"');
    expect(html).toContain('Wilson');
  });

  it('emits no NaN coordinates in any SVG', () => {
    expect(html).not.toContain('NaN');
  });

  it('opens with methodology and a findings Q&A derived from the analysis', () => {
    expect(html).toContain('How this report was made');
    expect(html).toContain('A seed is the starting point');
    expect(html).toContain('Findings at a glance');
    expect(html).toContain('Does going first matter?');
    expect(html).toContain('Do games feel close?');
    // The findings section precedes the chart sections.
    expect(html.indexOf('Findings at a glance')).toBeLessThan(html.indexOf('Does going first matter?<'));
  });

  it('renders a per-tab conditioning strip when provided (§6.4)', () => {
    const withConditions = renderDashboardHtml(
      meta,
      [{ label: 'Medium skill', analysis, conditions: 'skill=medium · strategy mix uniform · 8 games · seed 1' }],
      { minSample: 2 },
    );
    expect(withConditions).toContain('class="tab-conditions"');
    expect(withConditions).toContain('skill=medium · strategy mix uniform · 8 games · seed 1');
    expect(html).not.toContain('class="tab-conditions"');
  });

  it('renders one tab per scenario only when there are several', () => {
    expect(html).not.toContain('class="tabs"');
    const two = renderDashboardHtml(
      meta,
      [
        { label: '2 players', analysis },
        { label: '3 players', analysis },
      ],
      { minSample: 2 },
    );
    expect(two).toContain('class="tabs"');
    expect(two).toContain('3 players');
  });
});

describe('renderCompareHtml', () => {
  // Batch A: seat 1 (p1) always wins. Batch B: seat 2 (p2) always wins.
  // 40 games each so the seat-rate Newcombe interval clears zero decisively.
  function batch(winner: 'p1' | 'p2'): ReturnType<typeof analyzeBatch> {
    return analyzeBatch(Array.from({ length: 40 }, (_, i) => record(i + 1, winner)));
  }
  const a = batch('p1');
  const b = batch('p2');
  const identical = renderCompareHtml(
    meta,
    { label: 'seed 1', analysis: a, conditions: 'skill=medium · 40 games · seed 1' },
    { label: 'seed 1 again', analysis: a },
    { minSample: 2 },
  );
  const flipped = renderCompareHtml(meta, { label: 'before', analysis: a }, { label: 'after', analysis: b }, { minSample: 2 });

  it('claims nothing when the batches are identical', () => {
    expect(identical).toContain('No real differences');
    expect(identical).not.toContain('real change');
  });

  it('claims the seat flip and labels it real', () => {
    expect(flipped).toContain('real change');
    expect(flipped).toContain('Seat 1 win rate moved from 100.0% to 0.0%');
    expect(flipped).toContain('✓ real');
  });

  it('labels non-significant rows as noise, never as findings', () => {
    // Identical batches: every rate row must be marked noise.
    expect(identical).toContain('noise');
    expect(identical).not.toContain('✓ real');
  });

  it('is self-contained and carries both sides’ labels and conditions', () => {
    expect(identical).toContain('<!doctype html>');
    expect(identical).not.toMatch(/src="http/);
    expect(identical).toContain('seed 1 again');
    expect(identical).toContain('skill=medium · 40 games · seed 1');
  });
});
