// The evolution loop: a population of rule trees plays seeded games; a
// candidate's pay is how many NEW disagreements its play produces, scored
// against an archive of divergences already found (keyed by rule + field).
// Without the archive, evolution re-finds the first bug forever.

import type { VerifyAdapter } from '../exec/driver.js';
import { makeRng, randomPolicy, runGame } from '../exec/driver.js';
import type { Divergence } from '../exec/types.js';
import { divergenceKey } from '../exec/types.js';
import type { Genome } from './genome.js';
import { crossover, genomePolicy, mutate, nodeCount, randomGenome, renderGenome, vocabularyOf } from './genome.js';

export interface HuntConfig {
  populationSize: number;
  generations: number;
  gamesPerCandidate: number;
  maxMovesPerGame: number;
  baseSeed: number;
}

export interface ArchiveEntry {
  key: string;
  exemplar: Divergence;
  /** Global game counter value when this key was first produced. */
  foundAtGame: number;
  foundBy: 'hunter' | 'random';
  /** The strategy that produced it, in words. */
  strategy: string;
  hits: number;
}

export interface HuntResult {
  archive: Map<string, ArchiveEntry>;
  gamesPlayed: number;
  driverErrors: string[];
  bestRender: string;
}

export function runHunt(
  adapter: VerifyAdapter<unknown>,
  config: HuntConfig,
  onProgress?: (line: string) => void,
): HuntResult {
  const masterRng = makeRng(config.baseSeed);
  const vocabulary = vocabularyOf(adapter);
  let population: Genome[] = Array.from({ length: config.populationSize }, () => randomGenome(vocabulary, masterRng));
  const archive = new Map<string, ArchiveEntry>();
  const driverErrors: string[] = [];
  let gamesPlayed = 0;
  let bestRender = renderGenome(population[0]!);

  for (let gen = 0; gen < config.generations; gen++) {
    const knownAtGenStart = new Set(archive.keys());
    const scored: { genome: Genome; fitness: number; fresh: Map<string, Divergence> }[] = [];

    for (let c = 0; c < population.length; c++) {
      const genome = population[c]!;
      const fresh = new Map<string, Divergence>();
      for (let g = 0; g < config.gamesPerCandidate; g++) {
        const seed = config.baseSeed + gen * 100_000 + g * 1000 + 7;
        const result = runGame(adapter, genomePolicy(genome, adapter.sensors), seed, config.maxMovesPerGame);
        gamesPlayed += 1;
        if (result.error) driverErrors.push(`seed ${result.seed}: ${result.error}`);
        for (const d of result.divergences) {
          const key = divergenceKey(d);
          if (!knownAtGenStart.has(key) && !fresh.has(key)) fresh.set(key, d);
          const existing = archive.get(key);
          if (existing) existing.hits += 1;
        }
      }
      // Pay: novel divergence keys; parsimony breaks ties toward small trees.
      const fitness = fresh.size * 1000 - nodeCount(genome.root);
      scored.push({ genome, fitness, fresh });
      for (const [key, d] of fresh) {
        if (!archive.has(key)) {
          archive.set(key, {
            key,
            exemplar: d,
            foundAtGame: gamesPlayed,
            foundBy: 'hunter',
            strategy: renderGenome(genome),
            hits: 1,
          });
        }
      }
    }

    scored.sort((a, b) => b.fitness - a.fitness);
    bestRender = renderGenome(scored[0]!.genome);
    onProgress?.(
      `gen ${gen + 1}/${config.generations}: archive ${archive.size} keys, ` +
        `best fresh ${scored[0]!.fresh.size}, games ${gamesPlayed}`,
    );

    // Next generation: keep the top fifth, breed the rest from it.
    const eliteCount = Math.max(2, Math.floor(config.populationSize / 5));
    const elite = scored.slice(0, eliteCount).map((s) => s.genome);
    const next: Genome[] = [...elite];
    while (next.length < config.populationSize) {
      const roll = masterRng();
      if (roll < 0.55) {
        next.push(mutate(vocabulary, elite[Math.floor(masterRng() * elite.length)]!, masterRng));
      } else if (roll < 0.8) {
        const a = elite[Math.floor(masterRng() * elite.length)]!;
        const b = elite[Math.floor(masterRng() * elite.length)]!;
        next.push(crossover(a, b, masterRng));
      } else {
        next.push(randomGenome(vocabulary, masterRng));
      }
    }
    population = next;
  }

  return { archive, gamesPlayed, driverErrors, bestRender };
}

/** The control: the same budget spent on uniform-random play. */
export function runRandomControl(
  adapter: VerifyAdapter<unknown>,
  totalGames: number,
  maxMovesPerGame: number,
  baseSeed: number,
  onProgress?: (line: string) => void,
): HuntResult {
  const archive = new Map<string, ArchiveEntry>();
  const driverErrors: string[] = [];
  let gamesPlayed = 0;
  for (let g = 0; g < totalGames; g++) {
    const seed = baseSeed + g * 1000 + 7;
    const result = runGame(adapter, randomPolicy, seed, maxMovesPerGame);
    gamesPlayed += 1;
    if (result.error) driverErrors.push(`seed ${result.seed}: ${result.error}`);
    for (const d of result.divergences) {
      const key = divergenceKey(d);
      const existing = archive.get(key);
      if (existing) {
        existing.hits += 1;
      } else {
        archive.set(key, {
          key,
          exemplar: d,
          foundAtGame: gamesPlayed,
          foundBy: 'random',
          strategy: 'uniform random play',
          hits: 1,
        });
      }
    }
    if (onProgress && (g + 1) % 200 === 0) {
      onProgress(`random: ${g + 1}/${totalGames} games, archive ${archive.size} keys`);
    }
  }
  return { archive, gamesPlayed, driverErrors, bestRender: 'uniform random play' };
}
