// The hunter's candidates: small, readable rule trees over a game's common
// comparison shape. Interior nodes compare a sensor to a constant; leaves rank
// move types by weight. A candidate IS its own bug report: render() prints the
// strategy in words.
//
// The vocabulary is per-game, supplied by the verify adapter: `sensors`
// (numeric reads over the comparison shape), `sensorMax` (plausible maxima for
// threshold generation), and `moveTypes` (what a leaf may prefer). Genomes are
// plain data over sensor/move NAMES, so they serialize and render without the
// adapter; evaluation resolves names through it (an unknown sensor reads 0).

import type { LegalMove } from '@zekel/game-kit';
import type { MovePolicy } from '../exec/driver.js';

/** The per-game vocabulary genomes are built from. */
export interface HunterVocabulary {
  sensorNames: readonly string[];
  sensorMax: Record<string, number>;
  moveTypes: readonly string[];
}

export type GenomeNode =
  | { kind: 'branch'; sensor: string; cmp: '<=' | '>'; threshold: number; then: GenomeNode; otherwise: GenomeNode }
  | { kind: 'leaf'; weights: Record<string, number> };

export interface Genome {
  root: GenomeNode;
}

export function vocabularyOf(adapter: {
  sensors: Record<string, unknown>;
  sensorMax: Record<string, number>;
  moveTypes: readonly string[];
}): HunterVocabulary {
  return {
    sensorNames: Object.keys(adapter.sensors),
    sensorMax: adapter.sensorMax,
    moveTypes: adapter.moveTypes,
  };
}

export function nodeCount(node: GenomeNode): number {
  return node.kind === 'leaf' ? 1 : 1 + nodeCount(node.then) + nodeCount(node.otherwise);
}

function leafFor<V>(
  state: V,
  node: GenomeNode,
  sensors: Record<string, (view: V) => number>,
): Record<string, number> {
  let current = node;
  while (current.kind === 'branch') {
    const value = sensors[current.sensor]?.(state) ?? 0;
    const takeThen = current.cmp === '<=' ? value <= current.threshold : value > current.threshold;
    current = takeThen ? current.then : current.otherwise;
  }
  return current.weights;
}

/** Turn a genome into a driver policy. Scores each legal move by the active
 * leaf's weight for its move type; seeded jitter breaks ties so equal-weight
 * moves vary between games instead of always picking the first. */
export function genomePolicy<V>(genome: Genome, sensors: Record<string, (view: V) => number>): MovePolicy<V> {
  return (view, legal: LegalMove<unknown>[], rng) => {
    const weights = leafFor(view, genome.root, sensors);
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < legal.length; i++) {
      const moveType = (legal[i]!.move as { type?: string }).type ?? '';
      const score = (weights[moveType] ?? 0) + rng() * 0.001;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    return bestIndex;
  };
}

/** The candidate in words — the shape findings arrive in. */
export function renderGenome(genome: Genome): string {
  const lines: string[] = [];
  const walk = (node: GenomeNode, indent: string): void => {
    if (node.kind === 'leaf') {
      const ranked = Object.entries(node.weights)
        .filter(([, w]) => w !== 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([t, w]) => `${t}(${w.toFixed(1)})`);
      lines.push(`${indent}prefer ${ranked.length > 0 ? ranked.join(' > ') : 'anything'}`);
      return;
    }
    lines.push(`${indent}if ${node.sensor} ${node.cmp} ${node.threshold}:`);
    walk(node.then, indent + '  ');
    lines.push(`${indent}else:`);
    walk(node.otherwise, indent + '  ');
  };
  walk(genome.root, '');
  return lines.join('\n');
}

// --- random construction and variation (all rng-fed, fully deterministic) ---

function randomChoice<T>(items: readonly T[], rng: () => number): T {
  const pick = items[Math.floor(rng() * items.length)];
  if (pick === undefined) throw new Error('randomChoice on empty list');
  return pick;
}

function maxFor(vocabulary: HunterVocabulary, sensor: string): number {
  return vocabulary.sensorMax[sensor] ?? 10;
}

export function randomLeaf(vocabulary: HunterVocabulary, rng: () => number): GenomeNode {
  const weights: Record<string, number> = {};
  const howMany = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < howMany; i++) {
    weights[randomChoice(vocabulary.moveTypes, rng)] = Math.round((rng() * 10 - 3) * 10) / 10;
  }
  return { kind: 'leaf', weights };
}

export function randomNode(vocabulary: HunterVocabulary, rng: () => number, depth: number): GenomeNode {
  if (depth <= 0 || rng() < 0.35) return randomLeaf(vocabulary, rng);
  const sensor = randomChoice(vocabulary.sensorNames, rng);
  return {
    kind: 'branch',
    sensor,
    cmp: rng() < 0.5 ? '<=' : '>',
    threshold: Math.floor(rng() * (maxFor(vocabulary, sensor) + 1)),
    then: randomNode(vocabulary, rng, depth - 1),
    otherwise: randomNode(vocabulary, rng, depth - 1),
  };
}

export function randomGenome(vocabulary: HunterVocabulary, rng: () => number): Genome {
  return { root: randomNode(vocabulary, rng, 3) };
}

function clone(node: GenomeNode): GenomeNode {
  return structuredClone(node);
}

function collectNodes(node: GenomeNode, out: GenomeNode[]): void {
  out.push(node);
  if (node.kind === 'branch') {
    collectNodes(node.then, out);
    collectNodes(node.otherwise, out);
  }
}

/** Breed a variation: swap a comparison, change a constant, retune a leaf, or
 * graft a fresh subtree. */
export function mutate(vocabulary: HunterVocabulary, genome: Genome, rng: () => number): Genome {
  const root = clone(genome.root);
  const nodes: GenomeNode[] = [];
  collectNodes(root, nodes);
  const target = randomChoice(nodes, rng);
  const roll = rng();
  if (target.kind === 'branch') {
    if (roll < 0.3) {
      target.threshold = Math.floor(rng() * (maxFor(vocabulary, target.sensor) + 1));
    } else if (roll < 0.55) {
      target.sensor = randomChoice(vocabulary.sensorNames, rng);
      target.threshold = Math.floor(rng() * (maxFor(vocabulary, target.sensor) + 1));
    } else if (roll < 0.7) {
      target.cmp = target.cmp === '<=' ? '>' : '<=';
    } else if (roll < 0.85) {
      target.then = randomNode(vocabulary, rng, 2);
    } else {
      target.otherwise = randomNode(vocabulary, rng, 2);
    }
  } else {
    if (roll < 0.6) {
      target.weights[randomChoice(vocabulary.moveTypes, rng)] = Math.round((rng() * 10 - 3) * 10) / 10;
    } else {
      const fresh = randomLeaf(vocabulary, rng);
      target.weights = fresh.kind === 'leaf' ? fresh.weights : target.weights;
    }
  }
  // Cap growth: if the tree bloats past ~40 nodes, collapse a branch.
  if (nodeCount(root) > 40) {
    const branches = nodes.filter((n): n is Extract<GenomeNode, { kind: 'branch' }> => n.kind === 'branch');
    if (branches.length > 0) {
      const b = randomChoice(branches, rng);
      b.then = randomLeaf(vocabulary, rng);
      b.otherwise = randomLeaf(vocabulary, rng);
    }
  }
  return { root };
}

/** Crossover: graft a random subtree of b into a random point of a. */
export function crossover(a: Genome, b: Genome, rng: () => number): Genome {
  const root = clone(a.root);
  if (root.kind === 'leaf') return { root: clone(b.root) };
  const aNodes: GenomeNode[] = [];
  collectNodes(root, aNodes);
  const bNodes: GenomeNode[] = [];
  collectNodes(b.root, bNodes);
  const donor = clone(randomChoice(bNodes, rng));
  const branches = aNodes.filter((n): n is Extract<GenomeNode, { kind: 'branch' }> => n.kind === 'branch');
  const site = randomChoice(branches, rng);
  if (rng() < 0.5) site.then = donor;
  else site.otherwise = donor;
  return { root };
}
