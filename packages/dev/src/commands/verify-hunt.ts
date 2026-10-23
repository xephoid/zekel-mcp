// Run the divergence hunter or its random-play control against a game engine
// (docs/rules-verification.md).
//
//   verify-hunt --game=cybernoir-2127 --mode=random --games=500
//   verify-hunt --game=cybernoir-2127 --mode=hunt --pop=40 --gens=15 --games-per=12
//   verify-hunt --game=cybernoir-2127 --mode=versus --role=hacker --difficulty=hard
//
// versus: win-scored evolution against the game's own AI — an exploit finder
// for the AI ladder. Reports the champion strategy in words, its HELD-OUT win
// rate, and the uniform-random baseline on the same held-out seeds.
//
// Both print the divergence archive: every distinct (rule, field) disagreement
// found, when it was first found (global game count), the cited rulebook
// sentence, both values, and — for the hunter — the strategy that found it,
// in words.

import { getVerifyAdapter } from '../verify/exec/adapters.js';
import { runHunt, runRandomControl, type HuntResult } from '../verify/hunter/evolve.js';

export async function main(argv: string[]): Promise<void> {
  const arg = (name: string, fallback: string): string => {
    const found = argv.find((a) => a.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : fallback;
  };
  const mode = arg('mode', 'random');
  const baseSeed = Number(arg('seed', '1'));
  const maxMoves = Number(arg('max-moves', '600'));
  const err = (line: string): void => void process.stderr.write(line + '\n');

  const gameId = arg('game', '');
  if (!gameId) throw new Error('Usage: verify-hunt --game=<id> [--mode=random|hunt|versus] …');
  const adapter = getVerifyAdapter(gameId);

  if (mode === 'versus') {
    const { runVersus } = await import('../verify/hunter/versus.js');
    const config = {
      policySeatId: arg('role', 'hacker'),
      aiDifficulty: arg('difficulty', 'medium'),
      populationSize: Number(arg('pop', '30')),
      generations: Number(arg('gens', '15')),
      gamesPerCandidate: Number(arg('games-per', '10')),
      holdoutGames: Number(arg('holdout', '200')),
      maxMovesPerGame: maxMoves,
      baseSeed,
    };
    err(
      `versus: evolved ${config.policySeatId} vs ${config.aiDifficulty} AI — ` +
        `pop ${config.populationSize} x gens ${config.generations} x ${config.gamesPerCandidate} games, holdout ${config.holdoutGames}`,
    );
    const versus = await runVersus(adapter, config, err);
    err('');
    err(`games played: ${versus.gamesPlayed}`);
    err(`training best win rate by generation: ${versus.generationBests.map((b) => (b * 100).toFixed(0) + '%').join(' ')}`);
    const pct = (s: { wins: number; games: number }): string => `${s.wins}/${s.games} (${((100 * s.wins) / s.games).toFixed(1)}%)`;
    err('');
    err(`HELD-OUT champion win rate:  ${pct(versus.holdout)}`);
    err(`held-out random baseline:    ${pct(versus.randomBaseline)}`);
    if (versus.holdout.driverErrors.length > 0 || versus.randomBaseline.driverErrors.length > 0) {
      err(`driver errors (holdout): ${versus.holdout.driverErrors.length + versus.randomBaseline.driverErrors.length}`);
      for (const e of [...versus.holdout.driverErrors, ...versus.randomBaseline.driverErrors].slice(0, 5)) err(`  ${e}`);
    }
    const alerts = [...versus.holdout.divergenceKeys.keys(), ...versus.randomBaseline.divergenceKeys.keys()];
    if (alerts.length > 0) {
      err(`rules alerts seen while sparring (investigate separately): ${[...new Set(alerts)].join(' | ')}`);
    }
    err('');
    err('champion strategy:');
    for (const line of versus.championRender.split('\n')) err(`  ${line}`);
    return;
  }

  let result: HuntResult;
  if (mode === 'hunt') {
    const config = {
      populationSize: Number(arg('pop', '40')),
      generations: Number(arg('gens', '15')),
      gamesPerCandidate: Number(arg('games-per', '12')),
      maxMovesPerGame: maxMoves,
      baseSeed,
    };
    err(`hunt: pop ${config.populationSize} x gens ${config.generations} x ${config.gamesPerCandidate} games`);
    result = runHunt(adapter, config, err);
  } else {
    const games = Number(arg('games', '500'));
    err(`random control: ${games} games`);
    result = runRandomControl(adapter, games, maxMoves, baseSeed, err);
  }

  err('');
  err(`games played: ${result.gamesPlayed}`);
  err(`driver errors: ${result.driverErrors.length}`);
  const errorKinds = new Map<string, number>();
  for (const e of result.driverErrors) { const k = e.replace(/^seed \d+: /, ''); errorKinds.set(k, (errorKinds.get(k) ?? 0) + 1); }
  for (const [k, n] of errorKinds) err(`  ${n} x ${k}`); // grouped, so a real error is not hidden behind the first ten
  for (const e of result.driverErrors.slice(0, 10)) err(`  DRIVER ERROR: ${e}`);

  const entries = [...result.archive.values()].sort((a, b) => a.foundAtGame - b.foundAtGame);
  err(`divergence archive: ${entries.length} distinct (rule, field) disagreements`);
  for (const entry of entries) {
    err('');
    err(`— ${entry.key}`);
    err(`  first found at game ${entry.foundAtGame} (${entry.foundBy}), seen ${entry.hits}x`);
    err(`  cites §${entry.exemplar.citation.section}: "${entry.exemplar.citation.quote}"`);
    err(`  move #${entry.exemplar.moveIndex} (${entry.exemplar.moveType} by ${entry.exemplar.actor}), seed ${entry.exemplar.seed}`);
    err(`  predicted: ${entry.exemplar.predicted}`);
    err(`  actual:    ${entry.exemplar.actual}`);
    if (entry.foundBy === 'hunter') {
      err(`  strategy that found it:`);
      for (const line of entry.strategy.split('\n')) err(`    ${line}`);
    }
  }

  if (mode === 'hunt') {
    err('');
    err('best surviving strategy:');
    for (const line of result.bestRender.split('\n')) err(`  ${line}`);
  }
}
