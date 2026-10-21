// The win-scored variant of the hunter (docs/rules-verification.md;
// anticipated by the brief as "same machinery, second use"): evolve readable
// rule-tree strategies whose pay is BEATING the game's own AI at a difficulty
// tier, instead of producing rule divergences. What it finds is an exploit
// report for the ai-development and balance gates — either "this simple
// strategy beats the tier X% of the time" (with the strategy in words), or
// honest evidence that nothing simple cracks it at the tried budget.
//
// Overfitting guard: candidates in a generation share that generation's seed
// block (fair comparison), each generation gets fresh seeds, and the champion
// is re-scored on a held-out seed block it never trained on — report ONLY the
// holdout number.

import type { MovePolicy, VerifyAdapter } from '../exec/driver.js';
import { makeRng, randomPolicy, runVersusGame } from '../exec/driver.js';
import type { Divergence } from '../exec/types.js';
import { divergenceKey } from '../exec/types.js';
import type { Genome } from './genome.js';
import { crossover, genomePolicy, mutate, nodeCount, randomGenome, renderGenome, vocabularyOf } from './genome.js';

export interface VersusConfig {
  /** The seat the evolved policy plays; every other seat is the engine AI. */
  policySeatId: string;
  aiDifficulty: string;
  populationSize: number;
  generations: number;
  gamesPerCandidate: number;
  holdoutGames: number;
  maxMovesPerGame: number;
  baseSeed: number;
}

export interface VersusScore {
  games: number;
  wins: number;
  driverErrors: string[];
  /** Oracle-rule alerts seen while sparring (the rules stay on for free). */
  divergenceKeys: Map<string, Divergence>;
}

export interface VersusResult {
  championRender: string;
  /** Champion's held-out score — the only number to quote. */
  holdout: VersusScore;
  /** Uniform-random play on the same held-out seeds — the floor. */
  randomBaseline: VersusScore;
  /** Best training win rate per generation, for the progress story. */
  generationBests: number[];
  gamesPlayed: number;
}

async function score(
  adapter: VerifyAdapter<unknown>,
  config: VersusConfig,
  policy: MovePolicy,
  seedBlock: number,
  games: number,
): Promise<VersusScore> {
  const result: VersusScore = { games, wins: 0, driverErrors: [], divergenceKeys: new Map() };
  for (let g = 0; g < games; g++) {
    const seed = seedBlock + g * 1000 + 7;
    const run = await runVersusGame(
      adapter,
      config.policySeatId,
      policy,
      config.aiDifficulty,
      seed,
      config.maxMovesPerGame,
    );
    if (run.error) result.driverErrors.push(`seed ${run.seed}: ${run.error}`);
    if (run.winners.includes(config.policySeatId)) result.wins += 1;
    for (const d of run.divergences) {
      const key = divergenceKey(d);
      if (!result.divergenceKeys.has(key)) result.divergenceKeys.set(key, d);
    }
  }
  return result;
}

export async function runVersus(
  adapter: VerifyAdapter<unknown>,
  config: VersusConfig,
  onProgress?: (line: string) => void,
): Promise<VersusResult> {
  const masterRng = makeRng(config.baseSeed);
  const vocabulary = vocabularyOf(adapter);
  let population: Genome[] = Array.from({ length: config.populationSize }, () => randomGenome(vocabulary, masterRng));
  const generationBests: number[] = [];
  let gamesPlayed = 0;
  let champion: Genome = population[0]!;
  let championTrainWins = -1;

  for (let gen = 0; gen < config.generations; gen++) {
    const seedBlock = config.baseSeed + (gen + 1) * 1_000_000;
    const scored: { genome: Genome; wins: number; fitness: number }[] = [];
    for (const genome of population) {
      const s = await score(adapter, config, genomePolicy(genome, adapter.sensors), seedBlock, config.gamesPerCandidate);
      gamesPlayed += s.games;
      scored.push({ genome, wins: s.wins, fitness: s.wins * 1000 - nodeCount(genome.root) });
    }
    scored.sort((a, b) => b.fitness - a.fitness);
    const best = scored[0]!;
    generationBests.push(best.wins / config.gamesPerCandidate);
    if (best.wins > championTrainWins) {
      championTrainWins = best.wins;
      champion = best.genome;
    }
    onProgress?.(
      `gen ${gen + 1}/${config.generations}: best ${best.wins}/${config.gamesPerCandidate} wins vs ${config.aiDifficulty}, games ${gamesPlayed}`,
    );

    const eliteCount = Math.max(2, Math.floor(config.populationSize / 5));
    const elite = scored.slice(0, eliteCount).map((s) => s.genome);
    const next: Genome[] = [...elite];
    while (next.length < config.populationSize) {
      const roll = masterRng();
      if (roll < 0.55) next.push(mutate(vocabulary, elite[Math.floor(masterRng() * elite.length)]!, masterRng));
      else if (roll < 0.8) {
        next.push(
          crossover(
            elite[Math.floor(masterRng() * elite.length)]!,
            elite[Math.floor(masterRng() * elite.length)]!,
            masterRng,
          ),
        );
      } else next.push(randomGenome(vocabulary, masterRng));
    }
    population = next;
  }

  // Held-out seeds: far outside every training block.
  const holdoutBlock = config.baseSeed + 500_000_000;
  const holdout = await score(adapter, config, genomePolicy(champion, adapter.sensors), holdoutBlock, config.holdoutGames);
  const randomBaseline = await score(adapter, config, randomPolicy, holdoutBlock, config.holdoutGames);
  gamesPlayed += holdout.games + randomBaseline.games;

  return {
    championRender: renderGenome(champion),
    holdout,
    randomBaseline,
    generationBests,
    gamesPlayed,
  };
}
