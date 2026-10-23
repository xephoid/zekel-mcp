// Balance dashboard generator — renders a self-contained HTML balance report
// via src/harness/dashboardHtml.ts, from either input the harness produces:
//
//  A) Aggregated-analysis JSONs (the scale path — pairs with --no-game-files):
//       balance-dashboard --game=<id> \
//         --analysis "Medium skill=out/ff-medium.analysis.json" \
//         --analysis "Hard skill=out/ff-hard.analysis.json" --out=<file.html>
//     One tab per label (× player count if a file holds several scenarios).
//     Each tab carries its own §6.4 conditioning strip (skill · strategy mix ·
//     N · seed) read from the file's settings block. Label syntax is
//     "<label>=<path>" — split on the FIRST '=' (paths may contain '=' later,
//     and ':' is unusable on Windows drive letters).
//
//  B) Per-game record directories (small runs, retroactive):
//       balance-dashboard --game=<id> [--dir=./harness-out]
//     Discovers <dir>/<game>/<Np>/seed-*.json and re-runs analyzeBatch, so the
//     dashboard always agrees with the markdown summary for the same data.
//
//  C) A/B comparison (the §6.3 holdout loop as a deliverable):
//       balance-dashboard --game=<id> --compare \
//         --analysis "before=out/a.analysis.json" --analysis "after=out/b.analysis.json"
//     Renders deltas per metric, each gated on 95%-range separation (§6.2) —
//     unclaimed differences are explicitly labelled noise.

import { parseArgs } from 'node:util';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { GameRecord } from '../harness/runner.js';
import { analyzeBatch, type BatchAnalysis } from '../harness/analysis.js';
import {
  renderCompareHtml,
  renderDashboardHtml,
  type DashboardMeta,
  type DashboardScenario,
} from '../harness/dashboardHtml.js';

interface Cli {
  game: string;
  dir: string;
  out: string | undefined;
  title: string | undefined;
  minSample: number;
  analyses: Array<{ label: string; path: string }>;
  // A/B mode: requires exactly two --analysis entries (A first, B second) and
  // renders the §6.2/§6.3 comparison page instead of the tabbed report.
  compare: boolean;
}

function parseCli(argv: string[]): Cli {
  const { values } = parseArgs({
    args: argv,
    options: {
      game: { type: 'string' },
      dir: { type: 'string', default: './harness-out' },
      out: { type: 'string' },
      title: { type: 'string' },
      'min-sample': { type: 'string', default: '20' },
      analysis: { type: 'string', multiple: true },
      compare: { type: 'boolean', default: false },
    },
  });
  if (!values.game) {
    console.error(
      'Usage: balance-dashboard --game=<id> [--analysis "<label>=<file.json>" ...] [--compare] [--dir=./harness-out] [--out=<file.html>] [--title=<name>] [--min-sample=20]',
    );
    process.exit(1);
  }
  const analyses = (values.analysis ?? []).map((spec) => {
    const eq = spec.indexOf('=');
    if (eq <= 0) {
      console.error(`--analysis expects "<label>=<path>", got "${spec}"`);
      process.exit(1);
    }
    return { label: spec.slice(0, eq).trim(), path: resolve(spec.slice(eq + 1).trim()) };
  });
  return {
    game: values.game,
    dir: resolve(String(values.dir)),
    out: values.out ? resolve(values.out) : undefined,
    title: values.title,
    minSample: Number(values['min-sample']) || 20,
    analyses,
    compare: Boolean(values.compare),
  };
}

// Shape of the --analysis-json payload ai-harness.ts writes.
interface AnalysisFile {
  game_id: string;
  generated: string;
  settings: {
    n: number;
    difficulty: string;
    strategy?: string;
    sweep?: string;
    seed: number;
    trace?: boolean;
  };
  scenarios: Array<{ player_count: number; analysis: BatchAnalysis }>;
}

// §6.4: skill · strategy mix · N · seed, stated per tab.
function conditionsOf(f: AnalysisFile, scenario: { player_count: number; analysis: BatchAnalysis }): string {
  const strat = f.settings.strategy
    ? `strategy mix uniform over {${f.settings.strategy}}`
    : 'default AI policy';
  return (
    `skill=${f.settings.difficulty} · ${strat} · ${scenario.analysis.games_scored} games scored ` +
    `(${scenario.player_count} players) · seed ${f.settings.seed} · every rate carries a 95% range`
  );
}

async function scenariosFromAnalyses(cli: Cli): Promise<DashboardScenario[]> {
  const out: DashboardScenario[] = [];
  for (const a of cli.analyses) {
    const f = JSON.parse(await readFile(a.path, 'utf8')) as AnalysisFile;
    if (f.game_id !== cli.game) {
      console.error(`--analysis file ${a.path} is for game "${f.game_id}", not "${cli.game}"`);
      process.exit(1);
    }
    for (const s of f.scenarios) {
      const label = f.scenarios.length > 1 ? `${a.label} · ${s.player_count}p` : a.label;
      // Analysis JSONs written before the §3.5 WR(both) > WR(neither) guard can
      // carry "less bad together" pairs. The guard is a pure filter over stored
      // fields, so enforcing it on load is identical to recomputation.
      const analysis = {
        ...s.analysis,
        combos: (s.analysis.combos ?? []).filter((c) => c.wr_both > c.wr_neither),
      };
      out.push({ label, analysis, conditions: conditionsOf(f, s) });
    }
  }
  return out;
}

async function loadRecords(dir: string): Promise<GameRecord[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter((n) => /^seed-\d+\.json$/.test(n)).sort((a, b) => {
    const na = Number(a.match(/\d+/)?.[0] ?? 0);
    const nb = Number(b.match(/\d+/)?.[0] ?? 0);
    return na - nb;
  });
  const records: GameRecord[] = [];
  for (const f of files) {
    try {
      // The stored payload is a GameRecord plus a derived `metrics` map —
      // extra keys are harmless to analyzeBatch.
      records.push(JSON.parse(await readFile(join(dir, f), 'utf8')) as GameRecord);
    } catch (err) {
      console.error(`skipping unreadable record ${join(dir, f)}: ${String(err)}`);
    }
  }
  return records;
}

// Conditioning banner (§6.4): derive the run's settings from the records
// themselves so the report is self-describing regardless of CLI flags used.
function deriveSettings(scenarios: Array<{ label: string; records: GameRecord[] }>): Record<string, string> {
  const all = scenarios.flatMap((s) => s.records);
  const difficulties = new Set<string>();
  const strategies = new Set<string>();
  for (const r of all) {
    for (const p of r.players) {
      if (p.difficulty) difficulties.add(p.difficulty);
      if (p.strategy) strategies.add(p.strategy);
    }
  }
  const settings: Record<string, string> = {
    games: String(all.length),
    scenarios: scenarios.map((s) => `${s.label} (${s.records.length} games)`).join(' · '),
    skill: difficulties.size > 0 ? [...difficulties].sort().join(', ') : 'unspecified',
  };
  settings['strategy mix'] =
    strategies.size > 0 ? `uniform over {${[...strategies].sort().join(', ')}}` : 'default policy';
  return settings;
}

export async function main(argv: string[]): Promise<void> {
  const cli = parseCli(argv);
  const gameDir = join(cli.dir, cli.game);

  let rendered: DashboardScenario[];
  let settings: Record<string, string>;

  if (cli.analyses.length > 0) {
    // Mode A — aggregated-analysis JSONs; per-tab conditioning comes from each
    // file, so the header only carries batch-wide facts.
    rendered = await scenariosFromAnalyses(cli);
    settings = {
      'games total': String(rendered.reduce((sum, r) => sum + r.analysis.games_scored, 0)),
      batches: rendered.map((r) => r.label).join(' · '),
    };
  } else {
    // Mode B — per-game record directories.
    const scenarios: Array<{ label: string; records: GameRecord[] }> = [];
    const direct = await loadRecords(gameDir);
    if (direct.length > 0) scenarios.push({ label: 'all games', records: direct });
    let subdirs: string[] = [];
    try {
      subdirs = (await readdir(gameDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && /^\d+p$/.test(e.name))
        .map((e) => e.name)
        .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
    } catch {
      // gameDir itself missing — handled by the empty check below
    }
    for (const sub of subdirs) {
      const records = await loadRecords(join(gameDir, sub));
      if (records.length > 0) scenarios.push({ label: `${Number.parseInt(sub, 10)} players`, records });
    }

    if (scenarios.length === 0) {
      console.error(
        `No seed-*.json records found under ${gameDir}. Run the harness first (without --no-game-files), or pass --analysis "<label>=<file.json>".`,
      );
      process.exit(1);
    }

    rendered = scenarios.map((s) => ({ label: s.label, analysis: analyzeBatch(s.records) }));
    settings = deriveSettings(scenarios);
  }

  const meta: DashboardMeta = {
    gameId: cli.game,
    title: cli.title,
    generatedAt: new Date().toISOString().slice(0, 10),
    settings,
  };

  if (cli.compare) {
    if (rendered.length !== 2) {
      console.error(
        `--compare needs exactly two batches (A then B); got ${rendered.length}. ` +
          'Pass two --analysis "<label>=<file.json>" entries whose files hold one scenario each.',
      );
      process.exit(1);
    }
    const [sideA, sideB] = rendered as [DashboardScenario, DashboardScenario];
    const html = renderCompareHtml(meta, sideA, sideB, { minSample: cli.minSample });
    const outFile = cli.out ?? join(gameDir, 'compare.html');
    await writeFile(outFile, html, 'utf8');
    console.error(`A: ${sideA.label} (${sideA.analysis.games_scored} games) vs B: ${sideB.label} (${sideB.analysis.games_scored} games)`);
    console.error(`Comparison written to ${outFile}`);
    return;
  }

  const html = renderDashboardHtml(meta, rendered, { minSample: cli.minSample });
  const outFile = cli.out ?? join(gameDir, 'dashboard.html');
  await writeFile(outFile, html, 'utf8');

  for (const s of rendered) {
    const a = s.analysis;
    console.error(
      `${s.label}: ${a.games_scored} scored (${a.games_errored} errored), tie ${(a.tie_rate * 100).toFixed(1)}%, ` +
        `${a.matchups.length} matchup dimension(s), ${a.feature_lift.length} lift features` +
        (a.temporal ? `, temporal over ${a.temporal.n_games} traced games` : ''),
    );
  }
  console.error(`Dashboard written to ${outFile}`);
}

