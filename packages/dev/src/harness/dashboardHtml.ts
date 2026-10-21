// Balance dashboard — renders a BatchAnalysis (analysis.ts) as a single
// self-contained HTML page: no external scripts, stylesheets, or fonts, so the
// file can be posted/e-mailed/hosted anywhere as-is. Charts are server-rendered
// inline SVG. Semantics mirror renderBatchAnalysis exactly (same minSample
// gating, same CI discipline); this is a VIEW over the analysis, never a new
// source of numbers. Per BALANCE-METRIC-DEFINITIONS.md §6.4, every chart
// carries its conditioning caption (skill, strategy mix, N, CI).

import type {
  BatchAnalysis,
  ComboSynergy,
  Distribution,
  FeatureLift,
  MatchupMatrix,
  PaceAssociation,
  PaceStats,
  TemporalStats,
} from './analysis.js';
import type { Interval } from './stats.js';
import { halfWidthPct, intervalsSeparate, newcombeDiffInterval } from './stats.js';

export interface DashboardScenario {
  /** e.g. "2 players" or "Medium skill" — the tab label. */
  label: string;
  analysis: BatchAnalysis;
  /** §6.4 conditioning for THIS tab (skill · strategy mix · N · seed), shown as
   *  a strip above the tab's content. Every tab states its own conditions when
   *  tabs differ by run config, not just player count. */
  conditions?: string;
}

export interface DashboardMeta {
  gameId: string;
  /** Display title; defaults to the game id. */
  title?: string;
  /** ISO timestamp of generation (passed in by the caller). */
  generatedAt: string;
  /** Conditioning banner (§6.4): skill tier(s), strategy mix, seed, n … */
  settings: Record<string, string>;
}

export interface DashboardOpts {
  /** Cells / lift rows thinner than this are greyed, same as the md renderer. */
  minSample?: number;
}

// ---------- formatting ----------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}
function signedPct(x: number): string {
  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
}
function num(x: number, digits = 2): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(digits);
}
function ciPct(ci: Interval): string {
  return `[${pct(ci.low)}, ${pct(ci.high)}]`;
}
function isSignificant(ci: Interval): boolean {
  return ci.low > 0 || ci.high < 0;
}

// ---------- tiny SVG helpers ----------

const CHART_W = 660;

function svgOpen(h: number): string {
  return `<svg viewBox="0 0 ${CHART_W} ${h}" xmlns="http://www.w3.org/2000/svg" role="img">`;
}

// Linear scale factory.
function scale(domainLo: number, domainHi: number, rangeLo: number, rangeHi: number): (v: number) => number {
  const d = domainHi - domainLo || 1;
  return (v) => rangeLo + ((v - domainLo) / d) * (rangeHi - rangeLo);
}

// Diverging heat colour around a baseline win rate: red below, green above.
function heatColor(winRate: number, baseline: number): string {
  const delta = Math.max(-0.35, Math.min(0.35, winRate - baseline)) / 0.35; // -1..1
  const hue = delta >= 0 ? 145 : 4; // green / red
  const sat = 55;
  const light = 24 + (1 - Math.abs(delta)) * 14; // stronger delta = deeper colour
  return `hsl(${hue} ${sat}% ${light}%)`;
}

// ---------- sections ----------

// The plain-language rule: section copy reads without stats training; the exact
// statistical machinery (Wilson/Newcombe intervals, Nash/Hodge, gates) lives in
// a per-section collapsible so rigor stays inspectable without being a wall.
function nerdNote(text: string): string {
  return `<details class="nerd"><summary>Stats details</summary><p>${text}</p></details>`;
}

// Global methodology block (above the tabs) — the §6.4 conditioning only means
// something if the reader knows what a batch, a seed, and wiggle room ARE.
function methodologySection(tabCount: number): string {
  return `<section class="panel">
<h2>How this report was made</h2>
<ul class="method">
<li><b>Computer players played full games against each other</b>, through the game's real rules engine — every move checked legal, every rule enforced. No shortcuts or estimates: each game is actually played out.</li>
<li><b>Both players play at the same skill level</b> within a batch (stated on each tab), so differences come from the game, not from one player being smarter. When a batch lists a <b>strategy mix</b>, each game randomly assigns each player a style from that pool — over many games, every style meets every other.</li>
<li><b>Players swap seats</b> from game to game, so "who goes first" is spread evenly.</li>
<li><b>A seed is the starting point for all the shuffles and dice in a batch.</b> The same seed replays the exact same games (so results can be reproduced); a different seed replays the same design with different luck. Big conclusions are checked on at least two seeds — <b>if a verdict flips between seeds, it was luck, not design</b>.</li>
<li><b>Wiggle room:</b> every rate carries a 95% range. If two numbers' ranges overlap, the difference could just be luck — don't act on it.</li>
</ul>
${
  tabCount > 1
    ? `<p class="caption">This report contains <b>${tabCount} batches</b> — use the buttons below to switch between them. Each batch states its own skill level, strategy mix, game count, and seed.</p>`
    : ''
}
</section>`;
}

// "Findings at a glance" — the FINDINGS-doc question/answer format, derived
// from the same analysis object the charts render (never a separate source of
// numbers). One entry per runbook question this batch can answer; questions the
// batch didn't measure say so instead of disappearing (§ deliverable rule).
function findingsSection(a: BatchAnalysis, minSample: number): string {
  const rows: Array<{ q: string; answer: string }> = [];

  // Did the simulation behave?
  rows.push({
    q: 'Did the simulation run cleanly?',
    answer:
      a.games_errored === 0
        ? `Yes — all ${a.games_scored} games completed without errors.`
        : `⚠ No — ${a.games_errored} of ${a.games_total} games hit errors; treat everything below with suspicion until they're investigated.`,
  });

  // Does going first matter?
  const seats = a.seat_outcomes;
  if (seats.length > 0) {
    const baseline = (1 - a.tie_rate) / seats.length;
    const advantaged = seats.filter((s) => s.win_rate_ci.low > baseline);
    rows.push({
      q: 'Does going first matter?',
      answer:
        advantaged.length > 0
          ? `Yes — seat ${(advantaged[0]!.seat_index ?? 0) + 1} wins ${pct(advantaged[0]!.win_rate)} against a fair share of ${pct(
              baseline,
            )}, and its wiggle room clears the fair line.`
          : `No detectable edge — every seat's win rate (${seats.map((s) => pct(s.win_rate)).join(' vs ')}) has wiggle room crossing the fair split of ${pct(baseline)}.`,
    });
  }

  // Is one strategy dominant / does a meta exist?
  const stratMatrix = a.matchups.find((m) => m.dimension !== 'difficulty' && m.categories.length >= 3);
  if (stratMatrix) {
    const meta = stratMatrix.meta;
    const texture =
      meta.cyclicity > 0.5
        ? 'every pick has a counter (rock-paper-scissors)'
        : meta.transitivity > 0.7
          ? 'stronger picks simply beat weaker ones (a power ladder)'
          : 'part ladder, part rock-paper-scissors';
    rows.push({
      q: `Is one ${stratMatrix.dimension} the only smart pick?`,
      answer:
        meta.viable.length <= 1
          ? `In this batch, yes — the expected field collapses onto ${meta.viable[0] ?? '—'}${
              meta.dominant ? ' (it beats every other head-to-head)' : ''
            }. Careful: on a near-even field this verdict can flip with different luck — compare it across seeds before acting.`
          : `No — ${meta.viable.length} of ${meta.categories.length} are worth picking (${meta.viable.join(', ')}), and ${texture}.`,
    });
    if (meta.dead.length > 0) {
      rows.push({
        q: `Is any ${stratMatrix.dimension} never worth picking?`,
        answer: `Yes — ${meta.dead.join(', ')} loses every pairing in this batch.`,
      });
    }
  }

  // Which components win games? / what looks like a trap?
  const gated = a.feature_lift.filter(
    (f) =>
      !f.feature.startsWith('strategy:') && f.n_used >= minSample && f.n_available - f.n_used >= minSample,
  );
  const sigPos = gated.filter((f) => f.lift_ci.low > 0).sort((x, y) => y.lift - x.lift);
  const sigNeg = gated.filter((f) => f.lift_ci.high < 0).sort((x, y) => x.lift - y.lift);
  if (sigPos.length > 0) {
    rows.push({
      q: 'Which cards and actions actually win games?',
      answer:
        sigPos
          .slice(0, 3)
          .map((f) => `${describeFeature(f.feature)} (${signedPct(f.lift)} win boost, in ${pct(f.usage_rate, 0)} of games)`)
          .join(' · ') + ' — real signals, not luck. The biggest boost at the highest usage is the first rebalance candidate.',
    });
  }
  if (sigNeg.length > 0) {
    rows.push({
      q: 'What looks weak — or like a trap?',
      answer:
        sigNeg
          .slice(0, 2)
          .map((f) => `${describeFeature(f.feature)} (${signedPct(f.lift)} when used)`)
          .join(' · ') +
        '. Careful before nerfing: a catch-up move you only use while losing will look like this even when it works.',
    });
  }

  // Do any combos break the game?
  rows.push({
    q: 'Do any combos break the game?',
    answer:
      a.combos.length === 0
        ? 'No — no pair of cards or actions wins significantly more together than expected from each alone.'
        : a.combos
            .slice(0, 2)
            .map(
              (c) =>
                `${describeFeature(c.feature_a)} + ${describeFeature(c.feature_b)} wins ${pct(c.wr_both)} together — ${signedPct(
                  c.interaction,
                )} beyond what the parts predict`,
            )
            .join(' · ') + '. Confirm by re-running with one half removed.',
  });

  // What ends games quickly / what makes them drag?
  const pace = a.pace;
  rows.push({
    q: 'What ends games quickly?',
    answer:
      pace.fast_finishers.length === 0
        ? `Nothing specific — winners of the fastest games (≤${num(pace.fast_max_turns, 0)} turns) used the same components as winners of slower ones.`
        : `In the fastest quarter of games (≤${num(pace.fast_max_turns, 0)} turns), winners leaned on ${pace.fast_finishers
            .slice(0, 3)
            .map((f) => `${describeFeature(f.feature)} (${pct(f.rate_group, 0)} of fast wins vs ${pct(f.rate_rest, 0)} otherwise)`)
            .join(' · ')}.`,
  });
  rows.push({
    q: 'What makes games drag on?',
    answer:
      pace.drag_features.length === 0
        ? `Nothing specific — the longest games (≥${num(pace.long_min_turns, 0)} turns) share no common card or action.`
        : `The longest games (≥${num(pace.long_min_turns, 0)} turns, stuck games included) disproportionately feature ${pace.drag_features
            .slice(0, 3)
            .map((f) => `${describeFeature(f.feature)} (${pct(f.rate_group, 0)} of long games vs ${pct(f.rate_rest, 0)} of shorter ones)`)
            .join(' · ')}.`,
  });

  // Is it decided too early / do comebacks happen?
  if (a.temporal) {
    const t = a.temporal;
    const decided = t.decisiveness.find((p) => p.accuracy >= 0.9 && p.progress < 1);
    rows.push({
      q: 'Is the winner decided too early?',
      answer: decided
        ? `Somewhat — by ${pct(decided.progress, 0)} of the way through, the leader goes on to win ${pct(decided.accuracy, 0)} of the time.`
        : `No — even at 90% of the way through, the leader only wins ${pct(
            t.decisiveness.find((p) => p.progress === 0.9)?.accuracy ?? 0,
          )} of the time; the lead changes hands ~${num(t.lead_changes.mean)} times per game.`,
    });
  } else {
    rows.push({
      q: 'Is the winner decided too early?',
      answer: 'Not measured in this batch — see the batch that tracked the turn-by-turn leader.',
    });
  }

  // Do games feel close? How long? Wasted turns?
  rows.push({
    q: 'Do games feel close?',
    answer: `${pct(a.margin.nail_biter_share)} of decisive games are close finishes and ${pct(
      a.margin.rout_share,
    )} are blowouts; ${pct(a.tie_rate)} of games end with no winner${
      a.stalemate_rate > 0.05 ? ` — and ${pct(a.stalemate_rate)} get stuck at the round limit, which is worth a look` : ''
    }.`,
  });
  rows.push({
    q: 'How long is a game?',
    answer: `Typically ${num(a.game_length.median)} turns (~${num(a.avg_rounds, 0)} rounds); the middle half of games run ${num(
      a.game_length.p25,
    )}–${num(a.game_length.p75)} turns. Wasted turns are ${a.dead_turn_rate > 0.1 ? 'high' : 'rare'} at ${pct(a.dead_turn_rate)}.`,
  });

  const body = rows
    .map((r) => `<div class="qa"><p class="qa-q">${esc(r.q)}</p><p class="qa-a">${esc(r.answer)}</p></div>`)
    .join('\n');
  return `<section class="panel">
<h2>Findings at a glance</h2>
<p class="subtitle">Every answer below is computed from this batch's games — the charts underneath show the evidence for each one.</p>
${body}
</section>`;
}

function headlineCards(a: BatchAnalysis): string {
  const cards: Array<{ label: string; value: string; note: string; tone?: string }> = [
    { label: 'Games played', value: String(a.games_scored), note: `${a.games_errored} crashed of ${a.games_total} started` },
    { label: 'Ended with no winner', value: pct(a.tie_rate), note: `${pct(a.stalemate_rate)} got stuck and never finished` },
    { label: 'Rounds per game', value: num(a.avg_rounds), note: `${num(a.avg_player_turns)} turns total, on average` },
    {
      label: 'Empty turns',
      value: pct(a.dead_turn_rate),
      note: 'turns where a player did nothing useful',
      tone: a.dead_turn_rate > 0.1 ? 'warn' : 'good',
    },
    {
      label: 'Close finishes',
      value: pct(a.margin.nail_biter_share),
      note: `winner won by ${pct(a.margin.nail_biter_max, 0)} of their score or less`,
      tone: 'good',
    },
    {
      label: 'Blowouts',
      value: pct(a.margin.rout_share),
      note: `winner won by ${pct(a.margin.rout_min, 0)} or more`,
    },
  ];
  const cells = cards
    .map(
      (c) => `<div class="card${c.tone ? ` ${c.tone}` : ''}">
  <div class="card-value">${esc(c.value)}</div>
  <div class="card-label">${esc(c.label)}</div>
  <div class="card-note">${esc(c.note)}</div>
</div>`,
    )
    .join('\n');
  return `<div class="cards">${cells}</div>`;
}

function seatSection(a: BatchAnalysis): string {
  const seats = a.seat_outcomes;
  if (seats.length === 0) return '';
  // Fair share of the DECISIVE games — per-seat win rates are computed over all
  // games (ties count as non-wins), so with a t tie rate every seat sits below
  // 1/seats even in a perfectly fair game. Comparing to (1-t)/seats keeps the
  // §2.1 rule (draws are a third outcome, never silently split).
  const baseline = (1 - a.tie_rate) / Math.max(seats.length, 1);
  const rowH = 44;
  const top = 18;
  const h = top + seats.length * rowH + 30;
  const xLo = 90;
  const xHi = CHART_W - 20;
  const maxX = Math.min(1, Math.max(baseline * 1.6, ...seats.map((s) => s.win_rate_ci.high)) + 0.05);
  const x = scale(0, maxX, xLo, xHi);
  const parts: string[] = [svgOpen(h)];
  // baseline
  parts.push(
    `<line x1="${x(baseline)}" y1="${top - 8}" x2="${x(baseline)}" y2="${h - 24}" class="axis-dash"/>`,
    `<text x="${x(baseline)}" y="${h - 8}" class="tick" text-anchor="middle">fair ${pct(baseline, 0)}</text>`,
  );
  seats.forEach((s, i) => {
    const y = top + i * rowH;
    const real = s.win_rate_ci.low > baseline || s.win_rate_ci.high < baseline;
    const fill = !real ? 'var(--muted-bar)' : s.win_rate > baseline ? 'var(--good)' : 'var(--bad)';
    const label = s.seat_index === 0 ? `Seat 1 (first)` : `Seat ${s.seat_index + 1}`;
    parts.push(
      `<text x="${xLo - 8}" y="${y + 17}" class="lbl" text-anchor="end">${esc(label)}</text>`,
      `<rect x="${xLo}" y="${y}" width="${Math.max(x(s.win_rate) - xLo, 1)}" height="24" rx="3" fill="${fill}"/>`,
      // CI whisker
      `<line x1="${x(s.win_rate_ci.low)}" y1="${y + 12}" x2="${x(s.win_rate_ci.high)}" y2="${y + 12}" class="whisker"/>`,
      `<line x1="${x(s.win_rate_ci.low)}" y1="${y + 6}" x2="${x(s.win_rate_ci.low)}" y2="${y + 18}" class="whisker"/>`,
      `<line x1="${x(s.win_rate_ci.high)}" y1="${y + 6}" x2="${x(s.win_rate_ci.high)}" y2="${y + 18}" class="whisker"/>`,
      `<text x="${x(s.win_rate_ci.high) + 6}" y="${y + 17}" class="val">${pct(s.win_rate)} <tspan class="dim">±${esc(
        halfWidthPct(s.win_rate, s.win_rate_ci),
      )}</tspan></text>`,
    );
  });
  parts.push('</svg>');
  const anyReal = seats.some((s) => s.win_rate_ci.low > baseline || s.win_rate_ci.high < baseline);
  return section(
    'Does going first matter?',
    `How often each seat won. A perfectly fair split would give each seat ${pct(baseline)} (after setting aside the games ` +
      `that ended with no winner). The small brackets show each bar's wiggle room — if the brackets cross the dashed fair line, ` +
      `that seat's edge could just be luck. Grey bars mean exactly that.`,
    parts.join('\n'),
    (anyReal
      ? `<span class="flag warn">⚠ At least one seat's wiggle room sits fully past the fair line — turn order really does matter in this build.</span>`
      : `<span class="flag good">✓ Every seat's wiggle room crosses the fair line — no seat has a proven edge from this many games.</span>`) +
      nerdNote(
        `Win rate per seat over all games (ties count as non-wins). Whiskers are 95% Wilson intervals. Fair baseline is tie-adjusted: (1 − tie rate) ÷ seats = ${pct(
          baseline,
        )}. An advantage is claimed only when the interval excludes the baseline.`,
      ),
  );
}

function histogramSvg(d: Distribution, unit: string): string {
  if (d.n === 0 || d.histogram.length === 0) return '<p class="dim">(no data)</p>';
  const h = 190;
  const plotTop = 14;
  const plotBottom = h - 42;
  const xLo = 30;
  const xHi = CHART_W - 16;
  const peak = Math.max(...d.histogram.map((b) => b.count), 1);
  const y = scale(0, peak, plotBottom, plotTop);
  const bw = (xHi - xLo) / d.histogram.length;
  const parts: string[] = [svgOpen(h)];
  d.histogram.forEach((b, i) => {
    const bx = xLo + i * bw;
    const by = y(b.count);
    const range = b.lo === b.hi ? num(b.lo) : `${num(b.lo, 1)}–${num(b.hi, 1)}`;
    parts.push(
      `<rect x="${bx + 2}" y="${by}" width="${Math.max(bw - 4, 1)}" height="${plotBottom - by}" rx="2" class="hbar"><title>${esc(
        `${range} ${unit}: ${b.count} games`,
      )}</title></rect>`,
      `<text x="${bx + bw / 2}" y="${plotBottom + 14}" class="tick" text-anchor="middle">${esc(
        b.lo === b.hi ? num(b.lo) : num(b.lo, 0),
      )}</text>`,
    );
    if (b.count > 0 && plotBottom - by > 14) {
      parts.push(`<text x="${bx + bw / 2}" y="${by + 13}" class="bar-count" text-anchor="middle">${b.count}</text>`);
    }
  });
  const last = d.histogram[d.histogram.length - 1];
  if (last) {
    parts.push(`<text x="${xHi}" y="${plotBottom + 14}" class="tick" text-anchor="end">${esc(num(last.hi, 0))}</text>`);
  }
  parts.push(`<text x="${xLo}" y="${h - 6}" class="tick">${esc(unit)}</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

function distCaption(d: Distribution, unit: string): string {
  return `typical game: <b>${num(d.median)}</b> ${esc(unit)} · the middle half fall between ${num(d.p25)} and ${num(
    d.p75,
  )} · full range ${num(d.min)}–${num(d.max)} · average ${num(d.mean)} · from ${d.n} games`;
}

function shapeSection(a: BatchAnalysis): string {
  const m = a.margin;
  const lengthHtml = `<h3>How long are games? <span class="dim">(turns per game)</span></h3>
<p class="caption">${distCaption(a.game_length, 'turns')}</p>
${histogramSvg(a.game_length, 'player-turns')}
<p class="hint">Two humps in this chart = two different games hiding in one ruleset (a fast rush and a slow grind).</p>`;
  const marginHtml = `<h3>How big are the wins? <span class="dim">(final score gap)</span></h3>
<p class="caption"><b class="good-text">close finishes ${pct(m.nail_biter_share)}</b> ·
<b class="${m.rout_share > 0.5 ? 'warn-text' : ''}">blowouts ${pct(m.rout_share)}</b> ·
dead-even ties ${pct(m.exact_tie_share)}</p>
<p class="caption">${distCaption(m.distribution, 'pts')}</p>
${histogramSvg(m.distribution, 'points')}
<p class="hint">Averages hide this — two designs with the same average margin can be all close finishes or all blowouts. That's why we show the whole spread. ` +
    `Note: some games are blowout-by-nature (a knock-out game measures margin by leftover health, so decisive wins look huge) — judge these shares against what "close" should mean for YOUR game.</p>`;
  return section(
    'Do games feel close?',
    `A close finish means the winner won by ${pct(m.nail_biter_max, 0)} of their score or less; a blowout means ${pct(
      m.rout_min,
      0,
    )} or more. You can move these cut-offs to match what "close" means for your game.`,
    `<div class="two-col"><div>${lengthHtml}</div><div>${marginHtml}</div></div>`,
    nerdNote(
      `Margins are normalized (gap ÷ winner's score) so the cut-offs are scale-free across games. Close-finish share ${pct(
        m.nail_biter_share,
      )} ${ciPct(m.nail_biter_ci)}, blowout share ${pct(m.rout_share)} ${ciPct(
        m.rout_ci,
      )} (95% Wilson). "Typical" is the median; its 95% bootstrap CI: length [${num(a.game_length.median_ci.low)}, ${num(
        a.game_length.median_ci.high,
      )}], margin [${num(m.distribution.median_ci.low)}, ${num(m.distribution.median_ci.high)}].`,
    ),
  );
}

function liftSection(a: BatchAnalysis, minSample: number): string {
  const rows = a.feature_lift.filter((f) => f.n_used >= minSample && f.n_available - f.n_used >= minSample);
  if (rows.length === 0) {
    return section(
      'Which cards and actions win games?',
      `Not enough data yet — we only score a component once at least ${minSample} players used it and ${minSample} skipped it.`,
      '<p class="dim">Run a larger batch to populate this view.</p>',
    );
  }
  // Scatter: x = usage rate, y = lift.
  const h = 320;
  const xLo = 56;
  const xHi = CHART_W - 16;
  const plotTop = 16;
  const plotBottom = h - 36;
  const maxAbs = Math.max(0.12, ...rows.map((f) => Math.max(Math.abs(f.lift_ci.low), Math.abs(f.lift_ci.high))));
  const x = scale(0, 1, xLo, xHi);
  const y = scale(-maxAbs, maxAbs, plotBottom, plotTop);
  const parts: string[] = [svgOpen(h)];
  // danger corner: high usage AND high positive lift (§3.2)
  parts.push(
    `<rect x="${x(0.5)}" y="${plotTop}" width="${x(1) - x(0.5)}" height="${y(0.08) - plotTop}" class="danger-zone"/>`,
    `<text x="${x(0.98)}" y="${plotTop + 14}" class="tick warn-text" text-anchor="end">used a lot AND wins a lot — look here first</text>`,
  );
  // axes
  parts.push(
    `<line x1="${xLo}" y1="${y(0)}" x2="${xHi}" y2="${y(0)}" class="axis"/>`,
    `<text x="${xLo - 6}" y="${y(0) + 4}" class="tick" text-anchor="end">0</text>`,
    `<text x="${xLo - 6}" y="${plotTop + 6}" class="tick" text-anchor="end">${signedPct(maxAbs)}</text>`,
    `<text x="${xLo - 6}" y="${plotBottom}" class="tick" text-anchor="end">${signedPct(-maxAbs)}</text>`,
  );
  for (const gx of [0.25, 0.5, 0.75, 1]) {
    parts.push(
      `<line x1="${x(gx)}" y1="${plotTop}" x2="${x(gx)}" y2="${plotBottom}" class="grid"/>`,
      `<text x="${x(gx)}" y="${plotBottom + 16}" class="tick" text-anchor="middle">${pct(gx, 0)}</text>`,
    );
  }
  parts.push(`<text x="${(xLo + xHi) / 2}" y="${h - 4}" class="tick" text-anchor="middle">how often it was used (share of games)</text>`);
  // points, labelled when significant
  const labelled = rows
    .filter((f) => isSignificant(f.lift_ci))
    .sort((p, q) => Math.abs(q.lift) - Math.abs(p.lift))
    .slice(0, 10);
  const labelledSet = new Set(labelled.map((f) => f.feature));
  for (const f of rows) {
    const sig = isSignificant(f.lift_ci);
    const cx = x(f.usage_rate);
    const cy = y(Math.max(-maxAbs, Math.min(maxAbs, f.lift)));
    const r = Math.max(4, Math.min(11, Math.sqrt(f.n_used) / 2.4));
    const cls = sig ? (f.lift > 0 ? 'pt pos' : 'pt neg') : 'pt ns';
    parts.push(
      `<line x1="${cx}" y1="${y(Math.max(-maxAbs, Math.min(maxAbs, f.lift_ci.low)))}" x2="${cx}" y2="${y(
        Math.max(-maxAbs, Math.min(maxAbs, f.lift_ci.high)),
      )}" class="ci ${sig ? '' : 'ns'}"/>`,
      `<circle cx="${cx}" cy="${cy}" r="${r}" class="${cls}"><title>${esc(
        `${describeFeature(f.feature)}\nused in ${pct(f.usage_rate)} of games · win boost ${signedPct(f.lift)} (wiggle room ${signedPct(
          f.lift_ci.low,
        )} to ${signedPct(f.lift_ci.high)})\nwon ${pct(f.win_rate_used)} when used vs ${pct(
          f.win_rate_not_used,
        )} when skipped · available in ${f.n_available} player-games`,
      )}</title></circle>`,
    );
    if (labelledSet.has(f.feature)) {
      const anchor = f.usage_rate > 0.8 ? 'end' : 'start';
      const dx = f.usage_rate > 0.8 ? -10 : 10;
      parts.push(`<text x="${cx + dx}" y="${cy + 4}" class="pt-lbl" text-anchor="${anchor}">${esc(describeFeature(f.feature))}</text>`);
    }
  }
  parts.push('</svg>');

  const table = liftTable(labelled.length > 0 ? labelled : rows.slice(0, 10));
  return section(
    'Which cards and actions win games?',
    `Each dot is one card or action. Higher = a bigger win boost: players who used it won that much more often than players ` +
      `who could have used it but didn't. Solid dots are real signals; hollow dots could just be luck. Bigger dots = used in more games.`,
    parts.join('\n') + table,
    `<span class="hint">A win boost is a clue, not proof. A catch-up move (one you're only allowed to use while losing) will look like it loses games — really, losing causes it, not the other way around. To be sure about a card, re-run the batch with it removed and compare.</span>` +
      nerdNote(
        `Lift, played-vs-available form: win rate among seats that used the feature ≥1× minus win rate among seats that had it available but never used it. ` +
          `"Real signal" = the 95% Newcombe interval on that difference excludes 0. Only features with ≥${minSample} player-games on BOTH sides are shown, so thin samples never read as signal.`,
      ),
  );
}

function prettyFeature(feature: string): string {
  const i = feature.indexOf(':');
  return i === -1 ? feature : feature.slice(i + 1).replace(/_/g, ' ');
}

// Verb-forward variant for prose ("buying flying kick" vs "playing flying
// kick") — the same card appears as both a buy: and a play: feature with
// different lifts, so the bare name is ambiguous outside the table (which
// shows the kind chip).
function describeFeature(feature: string): string {
  const name = prettyFeature(feature);
  const kind = featureKind(feature);
  if (kind === 'play') return `playing ${name}`;
  if (kind === 'buy') return `buying ${name}`;
  if (kind === 'strategy') return `the ${name} strategy`;
  return name;
}
function featureKind(feature: string): string {
  const i = feature.indexOf(':');
  return i === -1 ? '' : feature.slice(0, i);
}

function liftTable(rows: FeatureLift[]): string {
  if (rows.length === 0) return '';
  const body = rows
    .map((f) => {
      const sig = isSignificant(f.lift_ci);
      return `<tr>
  <td><span class="kind">${esc(featureKind(f.feature))}</span> ${esc(prettyFeature(f.feature))}</td>
  <td class="r">${pct(f.usage_rate)}</td>
  <td class="r">${pct(f.win_rate_used)} <span class="dim">±${esc(halfWidthPct(f.win_rate_used, f.win_rate_used_ci))}</span></td>
  <td class="r">${pct(f.win_rate_not_used)}</td>
  <td class="r ${f.lift > 0 ? 'good-text' : 'bad-text'}"><b>${signedPct(f.lift)}</b></td>
  <td class="r dim">${signedPct(f.lift_ci.low)} … ${signedPct(f.lift_ci.high)}</td>
  <td class="c">${sig ? '<span class="sig">✓</span>' : ''}</td>
</tr>`;
    })
    .join('\n');
  return `<table class="tbl">
<thead><tr><th>Component</th><th class="r">How often used</th><th class="r">Win % when used</th><th class="r">Win % when skipped</th><th class="r">Win boost</th><th class="r">Wiggle room</th><th class="c">Real?</th></tr></thead>
<tbody>${body}</tbody></table>`;
}

function matchupSection(matchups: MatchupMatrix[], minSample: number): string {
  if (matchups.length === 0) return '';
  const blocks = matchups.map((m) => matchupBlock(m, minSample)).join('\n');
  return section(
    'Who beats whom?',
    'Each box shows how often the row side beat the column side when they met. Green = wins more than half of those games, red = less. ' +
      `Boxes from too few games (under ${minSample}) show a dot instead — we would rather show a gap than a number we cannot trust.`,
    blocks,
    nerdNote(
      'Cell = row category’s win rate in games containing the column category (the exact head-to-head matchup for 2-player batches), with N and a ±95% Wilson half-width. Ties are why a pair of mirrored cells can sum to less than 100%.',
    ),
  );
}

function matchupBlock(m: MatchupMatrix, minSample: number): string {
  const cats = m.categories;
  const baseline = 0.5;
  const header = cats.map((c) => `<th>${esc(c)}</th>`).join('');
  const rows = cats
    .map((a) => {
      const cells = cats
        .map((b) => {
          const cell = m.cells[a]?.[b];
          if (!cell || cell.games === 0) return '<td class="heat empty">—</td>';
          if (cell.games < minSample) {
            return `<td class="heat thin"><span>·</span><small>only ${cell.games} games</small></td>`;
          }
          return `<td class="heat" style="background:${heatColor(cell.win_rate, baseline)}"><span>${pct(
            cell.win_rate,
          )}</span><small>±${esc(halfWidthPct(cell.win_rate, cell.ci))} · ${cell.games} games</small></td>`;
        })
        .join('');
      return `<tr><th class="rowh">${esc(a)}</th>${cells}</tr>`;
    })
    .join('\n');
  const label = m.dimension === 'difficulty' ? 'skill' : m.dimension;
  const metaHtml = m.dimension !== 'difficulty' && cats.length >= 3 ? metaPanel(m) : '';
  return `<h3>${esc(label)} <span class="dim">(how often the row beats the column)</span></h3>
<div class="matchup-wrap"><table class="matchup"><thead><tr><th class="rowh">row \\ col</th>${header}</tr></thead><tbody>${rows}</tbody></table></div>
${metaHtml}`;
}

function metaPanel(m: MatchupMatrix): string {
  const meta = m.meta;
  const mix = meta.categories
    .map((c) => ({ c, w: meta.nash[c] ?? 0 }))
    .sort((x, y) => y.w - x.w);
  const total = mix.reduce((s, e) => s + e.w, 0) || 1;
  const palette = ['#4cc9f0', '#4ade80', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c', '#34d399', '#f87171'];
  const segs = mix
    .filter((e) => e.w > 0.001)
    .map((e, i) => {
      const w = (e.w / total) * 100;
      return `<div class="nash-seg" style="width:${w.toFixed(2)}%;background:${palette[i % palette.length]}" title="${esc(
        `${e.c}: ${pct(e.w)}`,
      )}">${w > 9 ? esc(`${e.c} ${pct(e.w, 0)}`) : ''}</div>`;
    })
    .join('');
  const healthy = meta.viable.length > 1;
  const verdict = healthy
    ? `<span class="flag good">✓ ${meta.viable.length} strategies are all worth picking — there is no single best choice.</span>`
    : `<span class="flag warn">⚠ One strategy is the only smart pick (${esc(meta.viable[0] ?? '—')})${
        meta.dominant ? ' — it beats every other strategy head-to-head' : ''
      }. That usually needs a fix.</span>
<p class="caption">Careful: when several strategies are nearly even, this winner-take-all math can crown a coin-flip winner — a different batch may crown a different one. Confirm with a second batch (different seed) before acting.</p>`;
  const texture =
    meta.cyclicity > 0.5
      ? 'mostly rock-paper-scissors — every pick has a counter (usually a healthy sign)'
      : meta.transitivity > 0.7
        ? 'mostly a power ladder — stronger picks simply beat weaker ones'
        : 'a mix of power ladder and rock-paper-scissors';
  return `<div class="meta-panel">
<h4>If everyone played to win, what would they pick?</h4>
<p class="caption">The bar shows the mix of strategies you'd expect to see once players figure the game out — bigger slice = picked more often.</p>
<div class="nash-bar">${segs}</div>
<p>${verdict}</p>
${meta.dead.length ? `<p class="caption">Never worth picking: <b class="bad-text">${esc(meta.dead.join(', '))}</b> — they lose too often no matter what.</p>` : ''}
<p class="caption">The matchup web is ${esc(texture)}${
    meta.topCycle ? ` · one loop: ${esc(meta.topCycle.join(' beats '))} beats ${esc(meta.topCycle[0] ?? '')}` : ''
  }.</p>
${nerdNote(
  `The expected mix is the Nash equilibrium of the matchup matrix (multiplicative-weights self-play). "Worth picking" = equilibrium weight ≥ 5%. ` +
    `Texture is the Hodge decomposition of the advantage matrix: ${pct(meta.transitivity)} transitive vs ${pct(
      meta.cyclicity,
    )} cyclic.`,
)}
</div>`;
}

function temporalSection(t: TemporalStats | undefined): string {
  if (!t) return '';
  const h = 260;
  const xLo = 56;
  const xHi = CHART_W - 20;
  const plotTop = 16;
  const plotBottom = h - 40;
  const pts = t.decisiveness;
  if (pts.length === 0) return '';
  const x = scale(0, 1, xLo, xHi);
  const yLoDomain = Math.min(0.45, ...pts.map((p) => p.ci.low));
  const y = scale(yLoDomain, 1, plotBottom, plotTop);
  const parts: string[] = [svgOpen(h)];
  // gridlines
  for (const gy of [0.5, 0.7, 0.9, 1.0]) {
    if (gy < yLoDomain) continue;
    parts.push(
      `<line x1="${xLo}" y1="${y(gy)}" x2="${xHi}" y2="${y(gy)}" class="grid"/>`,
      `<text x="${xLo - 6}" y="${y(gy) + 4}" class="tick" text-anchor="end">${pct(gy, 0)}</text>`,
    );
  }
  for (const gx of [0.25, 0.5, 0.75, 1]) {
    parts.push(`<text x="${x(gx)}" y="${plotBottom + 16}" class="tick" text-anchor="middle">${pct(gx, 0)}</text>`);
  }
  parts.push(`<text x="${(xLo + xHi) / 2}" y="${h - 4}" class="tick" text-anchor="middle">game progress (share of turns elapsed)</text>`);
  // CI band
  const band =
    pts.map((p) => `${x(p.progress)},${y(Math.min(1, p.ci.high))}`).join(' ') +
    ' ' +
    [...pts].reverse().map((p) => `${x(p.progress)},${y(Math.max(yLoDomain, p.ci.low))}`).join(' ');
  parts.push(`<polygon points="${band}" class="band"/>`);
  // line + dots
  const line = pts.map((p) => `${x(p.progress)},${y(p.accuracy)}`).join(' ');
  parts.push(`<polyline points="${line}" class="line"/>`);
  for (const p of pts) {
    parts.push(
      `<circle cx="${x(p.progress)}" cy="${y(p.accuracy)}" r="4" class="dot"><title>${esc(
        `${pct(p.progress, 0)} progress: leader wins ${pct(p.accuracy)} ${ciPct(p.ci)} (N=${p.n})`,
      )}</title></circle>`,
    );
  }
  // first ≥90% marker
  const decidedAt = pts.find((p) => p.accuracy >= 0.9);
  if (decidedAt) {
    const nearRightEdge = decidedAt.progress > 0.85;
    parts.push(
      `<line x1="${x(decidedAt.progress)}" y1="${plotTop}" x2="${x(decidedAt.progress)}" y2="${plotBottom}" class="axis-dash warn-stroke"/>`,
      `<text x="${x(decidedAt.progress) + (nearRightEdge ? -6 : 6)}" y="${plotTop + 12}" class="tick warn-text" text-anchor="${
        nearRightEdge ? 'end' : 'start'
      }">winner ~locked in here</text>`,
    );
  }
  parts.push('</svg>');
  const lead = t.lead_changes;
  const trail = t.turns_trailing_winner;
  return section(
    'When is the winner decided?',
    `At each point in the game, how often did the player in the lead go on to win? (Measured over ${t.n_games} finished games.) ` +
      `If the line shoots up early, games snowball — whoever gets ahead first almost always wins. ` +
      `If it hugs 50% until late, comebacks stay possible to the end.`,
    parts.join('\n'),
    `<span class="caption">The lead swapped hands about <b>${num(lead.mean)}</b> times per game · the eventual winner spent about ` +
      `<b>${num(trail.mean)}</b> turns behind — near zero means whoever leads early usually stays ahead.</span>` +
      nerdNote(
        'The "who is ahead" scalar is the game-declared leaderScalar over per-turn scoreboard snapshots. The curve can end below 100% when the winner is set by end-only scoring or a tiebreaker the mid-game scoreboard does not show. Bands are 95% Wilson intervals.',
      ),
  );
}

function paceTable(rows: PaceAssociation[], groupHead: string, restHead: string): string {
  const body = rows
    .slice(0, 10)
    .map(
      (f) => `<tr>
  <td><span class="kind">${esc(featureKind(f.feature))}</span> ${esc(prettyFeature(f.feature))}</td>
  <td class="r">${pct(f.rate_group)}</td>
  <td class="r">${pct(f.rate_rest)}</td>
  <td class="r good-text"><b>${signedPct(f.diff)}</b></td>
  <td class="r dim">${signedPct(f.diff_ci.low)} … ${signedPct(f.diff_ci.high)}</td>
</tr>`,
    )
    .join('\n');
  return `<table class="tbl">
<thead><tr><th>Component</th><th class="r">${esc(groupHead)}</th><th class="r">${esc(restHead)}</th><th class="r">Difference</th><th class="r">Wiggle room</th></tr></thead>
<tbody>${body}</tbody></table>`;
}

function paceSection(p: PaceStats): string {
  const fast =
    p.fast_finishers.length > 0
      ? `<h3>What ends games quickly</h3>
<p class="caption">In the quickest quarter of decided games (${num(p.fast_max_turns, 0)} turns or fewer, ${p.n_fast} games), the <b>winner</b> used these significantly more often than winners of slower games did:</p>
${paceTable(p.fast_finishers, 'In fast wins', 'In other wins')}`
      : `<h3>What ends games quickly</h3>
<p class="caption">Nothing stands out — no card or action shows up significantly more in the winner's kit in the quickest quarter of games (${num(
          p.fast_max_turns,
          0,
        )} turns or fewer). Fast wins come from how the game flows, not one component.</p>`;
  const drag =
    p.drag_features.length > 0
      ? `<h3>What makes games drag on</h3>
<p class="caption">In the longest quarter of games (${num(p.long_min_turns, 0)} turns or more, ${p.n_long} games — including games that got stuck at the round limit), <b>either side</b> used these significantly more often than in shorter games:</p>
${paceTable(p.drag_features, 'In long games', 'In shorter games')}`
      : `<h3>What makes games drag on</h3>
<p class="caption">Nothing stands out — long games (${num(p.long_min_turns, 0)}+ turns) don't share a common card or action. The slow games are slow for reasons the components don't explain.</p>`;
  return section(
    'What speeds games up — and what slows them down',
    'The length chart shows HOW long games run; this shows WHAT the fast and slow ones have in common. Each row is a real difference (its wiggle room excludes zero), not noise.',
    `${fast}${drag}`,
    `<span class="hint">These are associations, not proof — a "finisher" card may just be what winners happen to hold in short games. To confirm one, re-run the batch with it removed and watch the game-length chart move.</span>` +
      nerdNote(
        `Fast = decisive games with length ≤ P25 of decisive lengths (${num(p.fast_max_turns)} player-turns); ` +
          `long = scored games ≥ P75 of all lengths (${num(p.long_min_turns)}), stalemates included. Rates are difference-of-proportions with 95% Newcombe CIs; only positive-significant rows are kept (§5.1).`,
      ),
  );
}

function combosSection(combos: ComboSynergy[]): string {
  const body =
    combos.length === 0
      ? `<p class="flag good">✓ No combo breaks the game — no pair of cards or actions wins significantly more together than you'd expect from each one alone.</p>`
      : `<table class="tbl">
<thead><tr><th>Combo</th><th class="r">Win % together</th><th class="r">A alone</th><th class="r">B alone</th><th class="r">Neither</th><th class="r">Extra win % beyond the parts</th></tr></thead>
<tbody>${combos
          .map(
            (c) => `<tr>
  <td>${esc(describeFeature(c.feature_a))} <span class="dim">+</span> ${esc(describeFeature(c.feature_b))}</td>
  <td class="r"><b>${pct(c.wr_both)}</b> <span class="dim">(${c.n_both} games)</span></td>
  <td class="r">${pct(c.wr_a_only)}</td>
  <td class="r">${pct(c.wr_b_only)}</td>
  <td class="r">${pct(c.wr_neither)}</td>
  <td class="r warn-text"><b>${signedPct(c.interaction)}</b></td>
</tr>`,
          )
          .join('\n')}</tbody></table>
<p class="hint">Read "extra win %" as: how much better the pair does than adding up what each piece earns on its own. The best way to confirm a combo is real: re-run the batch with one half removed and see if the other half's win rate collapses.</p>`;
  return section(
    'Do any combos break the game?',
    'A card can be fine alone and broken next to the right partner. This looks at every well-used pair of components and asks: do players who used BOTH win more than the two pieces separately predict? Only real signals are listed — pairs whose extra win rate has wiggle room clear of zero.',
    body,
    nerdNote(
      'For each pair over the player-games where both were available: the 2×2 interaction contrast WR(both) − WR(A only) − WR(B only) + WR(neither), CI by normal approximation over the four cells (§3.5). Cells are sample-gated; buy/play of the same card is excluded as a tautology.',
    ),
  );
}

function deadCardsSection(a: BatchAnalysis, minSample: number): string {
  const underused = a.feature_lift
    .filter((f) => f.feature.startsWith('buy:') && f.n_available >= minSample && f.usage_rate < 0.05)
    .sort((p, q) => p.usage_rate - q.usage_rate);
  const a2p = a.acquire_to_play.filter((c) => c.acquired >= minSample).sort((p, q) => p.a2p - q.a2p);
  if (underused.length === 0 && a2p.length === 0) return '';
  const under =
    underused.length > 0
      ? `<h3>Almost never bought</h3>
<p class="caption">These cards were on offer in plenty of games (at least ${minSample}), but players chose to buy them in under 5% of those games. When a card is this unpopular it's usually one of three things: it's too weak for its cost, it's priced wrong, or the computer player doesn't understand it yet. Each is worth a different fix — check the card's cost and effect before assuming it's just bad.</p>
<table class="tbl"><thead><tr><th>Card</th><th class="r">Games it was available</th><th class="r">How often bought</th></tr></thead><tbody>${underused
          .map(
            (f) =>
              `<tr><td>${esc(prettyFeature(f.feature))}</td><td class="r">${f.n_available}</td><td class="r bad-text">${pct(
                f.usage_rate,
              )}</td></tr>`,
          )
          .join('')}</tbody></table>`
      : '';
  const ratio =
    a2p.length > 0
      ? `<h3>Bought — but then how often actually played?</h3>
<p class="caption">A different question from the table above: once a player DID spend resources on a card, did it ever hit the table? "Plays per purchase" is total plays divided by total purchases across the whole batch. Near 0 means players buy it and it rots in hand — a dead purchase. 1 or more means it earns its cost back with repeated use. A card that wins games when played but rarely gets played is situational (needs an easier setup), which is a different fix than a card that's simply weak.</p>
<table class="tbl"><thead><tr><th>Card</th><th class="r">Times bought</th><th class="r">Times played</th><th class="r">Plays per purchase</th></tr></thead><tbody>${a2p
          .map(
            (c) =>
              `<tr><td>${esc(c.card.replace(/_/g, ' '))}</td><td class="r">${c.acquired}</td><td class="r">${c.played}</td><td class="r ${
                c.a2p < 0.5 ? 'bad-text' : c.a2p >= 1 ? 'good-text' : ''
              }"><b>${num(c.a2p)}</b></td></tr>`,
          )
          .join('')}</tbody></table>`
      : '';
  return section(
    'Cards nobody uses',
    'A win rate can never show you this: a card that players skip at the shop, or buy and never play, is dead weight in the box even if it "wins 50%" on paper. Two different symptoms below, two different fixes.',
    `${under}${ratio}`,
    `<span class="hint">One caution before cutting anything here: if the computer player ignores a card, that can be a blind spot in ITS play rather than a flaw in the card. The honest test is to improve the AI's handling of the card (or force it into decks) and re-run the batch.</span>`,
  );
}

// ---------- page assembly ----------

function section(title: string, subtitle: string, body: string, footer?: string): string {
  return `<section class="panel">
<h2>${esc(title)}</h2>
<p class="subtitle">${subtitle}</p>
${body}
${footer ? `<p class="footer-note">${footer}</p>` : ''}
</section>`;
}

function scenarioHtml(s: DashboardScenario, minSample: number): string {
  const a = s.analysis;
  return [
    s.conditions ? `<p class="tab-conditions">This batch: ${esc(s.conditions)}</p>` : '',
    findingsSection(a, minSample),
    headlineCards(a),
    seatSection(a),
    matchupSection(a.matchups, minSample),
    liftSection(a, minSample),
    combosSection(a.combos),
    temporalSection(a.temporal),
    shapeSection(a),
    paceSection(a.pace),
    deadCardsSection(a, minSample),
  ]
    .filter(Boolean)
    .join('\n');
}

const CSS = `
:root{--bg:#0e1320;--panel:#161d2e;--panel2:#1b2438;--border:#26314a;--text:#e7ecf6;--muted:#94a0b8;
--accent:#4cc9f0;--good:#3fb96f;--bad:#e05d5d;--warn:#e8b44a;--muted-bar:#3a4763}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:0 0 64px}
.container{max-width:960px;margin:0 auto;padding:0 20px}
header.hero{padding:40px 0 22px;border-bottom:1px solid var(--border);margin-bottom:26px}
header.hero h1{font-size:30px;letter-spacing:-.02em}
header.hero .sub{color:var(--muted);margin-top:6px}
.conditions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.chip{background:var(--panel2);border:1px solid var(--border);border-radius:999px;padding:3px 12px;font-size:12.5px;color:var(--muted)}
.chip b{color:var(--text);font-weight:600}
.tabs-bar{position:sticky;top:0;z-index:5;background:var(--bg);display:flex;align-items:center;gap:12px;padding:10px 0 12px;margin:0 0 18px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.tabs-label{color:var(--muted);font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.tabs{display:flex;gap:8px;flex-wrap:wrap}
.tab-conditions{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:8px 14px;font-size:12.5px;color:var(--muted);margin-bottom:16px}
.tabs button{background:var(--panel);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:7px 16px;font-size:14px;cursor:pointer;transition:border-color .15s,background .15s}
.tabs button:hover{border-color:var(--accent)}
.tabs button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.tabs button.active{background:var(--accent);border-color:var(--accent);color:#08121f;font-weight:600}
.scenario{display:none}.scenario.active{display:block}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:22px 24px;margin-bottom:22px;overflow-x:auto}
.panel h2{font-size:19px;margin-bottom:4px;text-wrap:balance}
.panel h3{font-size:15px;margin:18px 0 6px}
.panel h4{font-size:14px;margin:0 0 8px}
.subtitle{color:var(--muted);font-size:13.5px;margin-bottom:14px;max-width:70ch}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:22px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.card-value{font-size:24px;font-weight:700;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.card-label{font-size:13px;color:var(--text);margin-top:2px}
.card-note{font-size:11.5px;color:var(--muted);margin-top:2px}
.card.good .card-value{color:var(--good)}.card.warn .card-value{color:var(--warn)}
svg{width:100%;height:auto;display:block;margin:6px 0}
.lbl{fill:var(--text);font-size:12.5px}
.val{fill:var(--text);font-size:12.5px;font-weight:600}
.tick{fill:var(--muted);font-size:11px}
.dim{color:var(--muted);fill:var(--muted);font-weight:400}
.bar-count{fill:#08121f;font-size:11px;font-weight:700}
.hbar{fill:var(--accent);opacity:.85}
.whisker{stroke:#dfe7f5;stroke-width:1.4}
.axis{stroke:var(--border);stroke-width:1}
.axis-dash{stroke:var(--muted);stroke-width:1;stroke-dasharray:4 4}
.warn-stroke{stroke:var(--warn)}
.grid{stroke:var(--border);stroke-width:.6}
.pt.pos{fill:var(--good)}.pt.neg{fill:var(--bad)}
.pt.ns{fill:none;stroke:var(--muted-bar);stroke-width:1.5}
.pt-lbl{fill:var(--text);font-size:11px}
.ci{stroke:#8fa2c4;stroke-width:1.2;opacity:.75}.ci.ns{opacity:.3}
.danger-zone{fill:#e05d5d;opacity:.07}
.band{fill:var(--accent);opacity:.14}
.line{fill:none;stroke:var(--accent);stroke-width:2.2}
.dot{fill:var(--accent)}
.tbl{border-collapse:collapse;width:100%;font-size:13px;margin:10px 0 4px;font-variant-numeric:tabular-nums}
.tbl th{color:var(--muted);font-weight:600;text-align:left;padding:6px 10px;border-bottom:1px solid var(--border)}
.tbl td{padding:6px 10px;border-bottom:1px solid var(--border)}
.tbl .r{text-align:right}.tbl .c{text-align:center}
.kind{background:var(--panel2);border:1px solid var(--border);border-radius:4px;font-size:10.5px;color:var(--muted);padding:1px 6px;margin-right:6px;text-transform:uppercase;letter-spacing:.04em}
.sig{color:var(--good);font-weight:700}
.good-text{color:var(--good)}.bad-text{color:var(--bad)}.warn-text{color:var(--warn);fill:var(--warn)}
.matchup-wrap{overflow-x:auto}
.matchup{border-collapse:separate;border-spacing:3px;margin:8px 0;font-size:12.5px;font-variant-numeric:tabular-nums}
.matchup th{color:var(--muted);font-weight:600;padding:4px 8px;text-align:center}
.matchup .rowh{text-align:right;padding-right:10px}
.matchup td.heat{min-width:96px;text-align:center;border-radius:6px;padding:7px 8px}
.matchup td.heat span{font-weight:700;display:block}
.matchup td.heat small{color:rgba(255,255,255,.75);font-size:10.5px}
.matchup td.thin{background:var(--panel2);color:var(--muted)}
.matchup td.thin small{color:var(--muted)}
.matchup td.empty{background:transparent;color:var(--muted)}
.meta-panel{background:var(--panel2);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:10px 0 18px}
.nash-bar{display:flex;height:28px;border-radius:6px;overflow:hidden;margin:8px 0 10px}
.nash-seg{display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:700;color:#08121f;white-space:nowrap;overflow:hidden}
.flag{font-size:13.5px;font-weight:600}
.flag.good{color:var(--good)}.flag.warn{color:var(--warn)}
.caption{font-size:12.5px;color:var(--muted);margin:4px 0}
.caption b{color:var(--text)}
.hint{font-size:12px;color:var(--muted);font-style:italic;margin-top:8px;max-width:75ch}
.footer-note{font-size:12.5px;color:var(--muted);margin-top:12px}
.method{list-style:none;display:flex;flex-direction:column;gap:9px;font-size:13.5px;color:var(--muted)}
.method b{color:var(--text)}
.method li{padding-left:18px;position:relative}
.method li::before{content:"—";position:absolute;left:0;color:var(--accent)}
.qa{border-left:3px solid var(--accent);padding:2px 0 2px 14px;margin:12px 0}
.qa-q{font-weight:700;font-size:14.5px}
.qa-a{color:var(--muted);font-size:13.5px;margin-top:2px;max-width:80ch}
.qa-a b{color:var(--text)}
.nerd{margin-top:10px;font-size:12px;color:var(--muted)}
.nerd summary{cursor:pointer;font-weight:600;letter-spacing:.02em}
.nerd p{margin-top:6px;max-width:80ch}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:24px}
@media(max-width:760px){.two-col{grid-template-columns:1fr}}
footer.colophon{color:var(--muted);font-size:12.5px;text-align:center;margin-top:30px}
`;

export function renderDashboardHtml(
  meta: DashboardMeta,
  scenarios: DashboardScenario[],
  opts?: DashboardOpts,
): string {
  const minSample = opts?.minSample ?? 20;
  const title = meta.title ?? meta.gameId;
  const chips = Object.entries(meta.settings)
    .map(([k, v]) => `<span class="chip">${esc(k)} <b>${esc(v)}</b></span>`)
    .join('\n');
  const tabs =
    scenarios.length > 1
      ? `<div class="tabs-bar">
<span class="tabs-label">Viewing batch:</span>
<div class="tabs">${scenarios
          .map((s, i) => `<button data-i="${i}"${i === 0 ? ' class="active"' : ''}>${esc(s.label)}</button>`)
          .join('')}</div>
</div>`
      : '';
  const bodies = scenarios
    .map((s, i) => `<div class="scenario${i === 0 ? ' active' : ''}" data-i="${i}">${scenarioHtml(s, minSample)}</div>`)
    .join('\n');
  const js =
    scenarios.length > 1
      ? `<script>document.querySelectorAll('.tabs button').forEach(function(b){b.addEventListener('click',function(){
document.querySelectorAll('.tabs button').forEach(function(x){x.classList.toggle('active',x===b)});
document.querySelectorAll('.scenario').forEach(function(s){s.classList.toggle('active',s.dataset.i===b.dataset.i)});
})});</script>`
      : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Balance Report</title>
<style>${CSS}</style>
</head>
<body>
<div class="container">
<header class="hero">
<h1>${esc(title)} <span class="dim">— balance report</span></h1>
<p class="sub">Computer players played this design over and over so you don't have to · generated ${esc(meta.generatedAt)}.</p>
<div class="conditions">${chips}</div>
</header>
${methodologySection(scenarios.length)}
${tabs}
${bodies}
<footer class="colophon">Generated by the zekel balance harness — simulated playtesting for tabletop designers.</footer>
</div>
${js}
</body>
</html>
`;
}

// ---------- A/B compare (§6.2 / §6.3) ----------
//
// Renders two batches side by side — typically build A vs build B after a rule
// tweak (the §6.3 targeted-holdout loop), or two seeds of the same build as a
// noise check. The §6.2 rule is absolute here: a delta is CLAIMED only when the
// 95% ranges separate; everything else is explicitly "within noise". This is
// what stops a designer chasing a 2pp wiggle after every edit.

export interface CompareSide {
  label: string;
  analysis: BatchAnalysis;
  conditions?: string;
}

interface RateDelta {
  metric: string;
  a: { k: number; n: number };
  b: { k: number; n: number };
  diff: number; // B − A
  diff_ci: Interval; // 95% Newcombe
  significant: boolean;
  /** Plain-language sentence used in the verdict list when significant. */
  describe: string;
}

// Rates are stored as (rate, n); reconstruct the count — exact for true
// proportions since k/n round-trips through rate*n.
function rateDelta(metric: string, rateA: number, nA: number, rateB: number, nB: number, unit: string): RateDelta {
  const kA = Math.round(rateA * nA);
  const kB = Math.round(rateB * nB);
  const ci = newcombeDiffInterval(kB, nB, kA, nA);
  const diff = (nB > 0 ? kB / nB : 0) - (nA > 0 ? kA / nA : 0);
  const significant = nA > 0 && nB > 0 && (ci.low > 0 || ci.high < 0);
  return {
    metric,
    a: { k: kA, n: nA },
    b: { k: kB, n: nB },
    diff,
    diff_ci: ci,
    significant,
    describe: `${metric} moved from ${pct(nA > 0 ? kA / nA : 0)} to ${pct(nB > 0 ? kB / nB : 0)} (${signedPct(
      diff,
    )} of ${unit})`,
  };
}

function compareRateRows(a: BatchAnalysis, b: BatchAnalysis): RateDelta[] {
  const rows: RateDelta[] = [
    rateDelta('Games ending with no winner', a.tie_rate, a.games_scored, b.tie_rate, b.games_scored, 'games'),
    rateDelta('Games stuck at the round limit', a.stalemate_rate, a.games_scored, b.stalemate_rate, b.games_scored, 'games'),
    rateDelta(
      'Close finishes',
      a.margin.nail_biter_share,
      a.margin.distribution.n,
      b.margin.nail_biter_share,
      b.margin.distribution.n,
      'decisive games',
    ),
    rateDelta(
      'Blowouts',
      a.margin.rout_share,
      a.margin.distribution.n,
      b.margin.rout_share,
      b.margin.distribution.n,
      'decisive games',
    ),
  ];
  const turnsA = Math.round(a.avg_player_turns * a.games_scored);
  const turnsB = Math.round(b.avg_player_turns * b.games_scored);
  rows.push(rateDelta('Empty turns', a.dead_turn_rate, turnsA, b.dead_turn_rate, turnsB, 'turns'));
  // Per-seat win rates (seats present on both sides).
  for (const sa of a.seat_outcomes) {
    const sb = b.seat_outcomes.find((s) => s.seat_index === sa.seat_index);
    if (!sb) continue;
    rows.push(
      rateDelta(`Seat ${sa.seat_index + 1} win rate`, sa.win_rate, sa.games, sb.win_rate, sb.games, 'games'),
    );
  }
  return rows;
}

interface MedianDelta {
  metric: string;
  unit: string;
  a: Distribution;
  b: Distribution;
  significant: boolean; // 95% bootstrap CIs on the medians separate
}

function compareMedians(a: BatchAnalysis, b: BatchAnalysis): MedianDelta[] {
  const mk = (metric: string, unit: string, da: Distribution, db: Distribution): MedianDelta => ({
    metric,
    unit,
    a: da,
    b: db,
    significant: da.n > 0 && db.n > 0 && intervalsSeparate(da.median_ci, db.median_ci),
  });
  return [
    mk('Typical game length', 'turns', a.game_length, b.game_length),
    mk('Typical winning margin', 'pts', a.margin.distribution, b.margin.distribution),
  ];
}

interface LiftMover {
  feature: string;
  liftA: number;
  liftB: number;
  delta: number;
  significant: boolean; // the two lift CIs separate (conservative)
}

function compareLifts(a: BatchAnalysis, b: BatchAnalysis, minSample: number): LiftMover[] {
  const gate = (f: FeatureLift): boolean =>
    !f.feature.startsWith('strategy:') && f.n_used >= minSample && f.n_available - f.n_used >= minSample;
  const mapB = new Map(b.feature_lift.filter(gate).map((f) => [f.feature, f]));
  const out: LiftMover[] = [];
  for (const fa of a.feature_lift.filter(gate)) {
    const fb = mapB.get(fa.feature);
    if (!fb) continue;
    out.push({
      feature: fa.feature,
      liftA: fa.lift,
      liftB: fb.lift,
      delta: fb.lift - fa.lift,
      significant: intervalsSeparate(fa.lift_ci, fb.lift_ci),
    });
  }
  return out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

// Descriptive (no-CI) set diffs: metagame verdicts, combos, pace suspects.
function setDiff(aList: string[], bList: string[]): { appeared: string[]; disappeared: string[] } {
  const aSet = new Set(aList);
  const bSet = new Set(bList);
  return {
    appeared: bList.filter((x) => !aSet.has(x)),
    disappeared: aList.filter((x) => !bSet.has(x)),
  };
}

export function renderCompareHtml(
  meta: DashboardMeta,
  a: CompareSide,
  b: CompareSide,
  opts?: DashboardOpts,
): string {
  const minSample = opts?.minSample ?? 20;
  const title = meta.title ?? meta.gameId;
  const rates = compareRateRows(a.analysis, b.analysis);
  const medians = compareMedians(a.analysis, b.analysis);
  const lifts = compareLifts(a.analysis, b.analysis, minSample);
  const sigLifts = lifts.filter((l) => l.significant);

  // Verdict: every claimed change in one list.
  const claims: string[] = [
    ...rates.filter((r) => r.significant).map((r) => r.describe),
    ...medians
      .filter((m) => m.significant)
      .map((m) => `${m.metric} moved from ${num(m.a.median)} to ${num(m.b.median)} ${m.unit}`),
    ...sigLifts.map(
      (l) => `the win boost of ${describeFeature(l.feature)} moved from ${signedPct(l.liftA)} to ${signedPct(l.liftB)}`,
    ),
  ];
  const verdict =
    claims.length === 0
      ? `<p class="flag good">✓ No real differences — on every compared metric, the two batches are within each other's wiggle room. Any gaps you see below could just be luck.</p>`
      : `<p class="flag warn">${claims.length} real change${claims.length === 1 ? '' : 's'} detected:</p>
<ul class="method">${claims.map((c) => `<li>${esc(c)}</li>`).join('\n')}</ul>`;

  const rateRows = rates
    .map((r) => {
      const pa = r.a.n > 0 ? r.a.k / r.a.n : 0;
      const pb = r.b.n > 0 ? r.b.k / r.b.n : 0;
      return `<tr class="${r.significant ? 'sig-row' : 'ns-row'}">
  <td>${esc(r.metric)}</td>
  <td class="r">${pct(pa)}</td>
  <td class="r">${pct(pb)}</td>
  <td class="r"><b>${signedPct(r.diff)}</b></td>
  <td class="r dim">${signedPct(r.diff_ci.low)} … ${signedPct(r.diff_ci.high)}</td>
  <td class="c">${r.significant ? '<span class="sig">✓ real</span>' : '<span class="dim">noise</span>'}</td>
</tr>`;
    })
    .join('\n');

  const medianRows = medians
    .map(
      (m) => `<tr class="${m.significant ? 'sig-row' : 'ns-row'}">
  <td>${esc(m.metric)}</td>
  <td class="r">${num(m.a.median)} <span class="dim">[${num(m.a.median_ci.low)}, ${num(m.a.median_ci.high)}]</span></td>
  <td class="r">${num(m.b.median)} <span class="dim">[${num(m.b.median_ci.low)}, ${num(m.b.median_ci.high)}]</span></td>
  <td class="r"><b>${num(m.b.median - m.a.median)} ${esc(m.unit)}</b></td>
  <td class="r dim">—</td>
  <td class="c">${m.significant ? '<span class="sig">✓ real</span>' : '<span class="dim">noise</span>'}</td>
</tr>`,
    )
    .join('\n');

  const moverRows = (sigLifts.length > 0 ? sigLifts : lifts.slice(0, 8))
    .slice(0, 12)
    .map(
      (l) => `<tr class="${l.significant ? 'sig-row' : 'ns-row'}">
  <td><span class="kind">${esc(featureKind(l.feature))}</span> ${esc(prettyFeature(l.feature))}</td>
  <td class="r">${signedPct(l.liftA)}</td>
  <td class="r">${signedPct(l.liftB)}</td>
  <td class="r"><b>${signedPct(l.delta)}</b></td>
  <td class="c">${l.significant ? '<span class="sig">✓ real</span>' : '<span class="dim">noise</span>'}</td>
</tr>`,
    )
    .join('\n');

  // Descriptive shifts (no CI machinery exists for these — say so).
  const metaA = a.analysis.matchups.find((m) => m.dimension !== 'difficulty' && m.categories.length >= 3);
  const metaB = b.analysis.matchups.find((m) => m.dimension !== 'difficulty' && m.categories.length >= 3);
  let metaShift = '';
  if (metaA && metaB && metaA.dimension === metaB.dimension) {
    const viable = setDiff(metaA.meta.viable, metaB.meta.viable);
    const dead = setDiff(metaA.meta.dead, metaB.meta.dead);
    const bits: string[] = [];
    if (viable.appeared.length) bits.push(`now worth picking: <b>${esc(viable.appeared.join(', '))}</b>`);
    if (viable.disappeared.length)
      bits.push(`no longer worth picking: <b class="bad-text">${esc(viable.disappeared.join(', '))}</b>`);
    if (dead.appeared.length) bits.push(`newly dead: <b class="bad-text">${esc(dead.appeared.join(', '))}</b>`);
    if (dead.disappeared.length) bits.push(`revived: <b class="good-text">${esc(dead.disappeared.join(', '))}</b>`);
    metaShift = `<h3>Metagame shifts <span class="dim">(${esc(metaA.dimension)})</span></h3>
<p class="caption">${bits.length > 0 ? bits.join(' · ') : 'The set of viable strategies is unchanged.'}</p>
<p class="hint">Directional only — equilibrium weights carry no confidence range, so treat shifts here as leads to confirm in the matchup tables, not verdicts.</p>`;
  }
  const comboDiff = setDiff(
    a.analysis.combos.map((c) => `${describeFeature(c.feature_a)} + ${describeFeature(c.feature_b)}`),
    b.analysis.combos.map((c) => `${describeFeature(c.feature_a)} + ${describeFeature(c.feature_b)}`),
  );
  const comboShift =
    comboDiff.appeared.length || comboDiff.disappeared.length
      ? `<h3>Combo shifts</h3>
<p class="caption">${[
          comboDiff.appeared.length
            ? `new super-additive pairs: <b class="warn-text">${esc(comboDiff.appeared.join(' · '))}</b>`
            : '',
          comboDiff.disappeared.length
            ? `no longer super-additive: <b>${esc(comboDiff.disappeared.join(' · '))}</b>`
            : '',
        ]
          .filter(Boolean)
          .join(' · ')}</p>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — A/B Comparison</title>
<style>${CSS}
.sig-row td{color:var(--text)}
.ns-row td{color:var(--muted)}
.side-label{font-weight:700;color:var(--accent)}
</style>
</head>
<body>
<div class="container">
<header class="hero">
<h1>${esc(title)} <span class="dim">— A/B comparison</span></h1>
<p class="sub">Two batches, side by side · generated ${esc(meta.generatedAt)}. A difference is claimed only when the two batches' 95% ranges pull clear of each other — everything else is labelled noise, because it might be.</p>
<div class="conditions">
<span class="chip"><span class="side-label">A</span> <b>${esc(a.label)}</b></span>
<span class="chip"><span class="side-label">B</span> <b>${esc(b.label)}</b></span>
</div>
</header>
${a.conditions ? `<p class="tab-conditions"><span class="side-label">A</span> ${esc(a.conditions)}</p>` : ''}
${b.conditions ? `<p class="tab-conditions"><span class="side-label">B</span> ${esc(b.conditions)}</p>` : ''}
<section class="panel">
<h2>What actually changed</h2>
<p class="subtitle">Every claim below survived the wiggle-room test. If it's not in this list, this comparison could not tell the two batches apart on it.</p>
${verdict}
</section>
<section class="panel">
<h2>Outcome rates</h2>
<table class="tbl">
<thead><tr><th>Metric</th><th class="r">A</th><th class="r">B</th><th class="r">Change (B − A)</th><th class="r">Wiggle room</th><th class="c">Real?</th></tr></thead>
<tbody>${rateRows}
${medianRows}</tbody>
</table>
${nerdNote(
  'Rate deltas: 95% Newcombe interval on the difference of proportions; "real" iff it excludes 0. Median rows: "real" iff the two 95% bootstrap CIs on the medians do not overlap (conservative). Counts are reconstructed exactly from stored (rate, N) pairs.',
)}
</section>
<section class="panel">
<h2>Component win-boost movers</h2>
<p class="subtitle">${
    sigLifts.length > 0
      ? `Components whose win boost really moved between A and B (both sides clear the ≥${minSample} sample gate).`
      : `No component's win boost moved beyond noise — the largest apparent movers are shown greyed for context.`
  }</p>
<table class="tbl">
<thead><tr><th>Component</th><th class="r">Boost in A</th><th class="r">Boost in B</th><th class="r">Change</th><th class="c">Real?</th></tr></thead>
<tbody>${moverRows}</tbody>
</table>
${nerdNote(
  'A mover is "real" only when the two lift CIs (95% Newcombe, played-vs-available form) fully separate — conservative relative to a pooled test, deliberately: cross-build claims should be hard to make.',
)}
</section>
${metaShift || comboShift ? `<section class="panel">\n<h2>Directional shifts</h2>\n${metaShift}\n${comboShift}\n</section>` : ''}
<footer class="colophon">Generated by the zekel balance harness — simulated playtesting for tabletop designers.</footer>
</div>
</body>
</html>
`;
}
