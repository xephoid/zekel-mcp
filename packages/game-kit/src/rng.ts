// Seedable RNG (mulberry32) so games are deterministic and testable.
// State is a single uint32 seed carried in FFState.

export function nextSeed(seed: number): number {
  // Step the mulberry32 state by one full step and return the new state.
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

export function randomFloat(seed: number): { value: number; nextSeed: number } {
  const s = nextSeed(seed);
  return { value: s / 0x100000000, nextSeed: s };
}

export function randomInt(seed: number, maxExclusive: number): { value: number; nextSeed: number } {
  const r = randomFloat(seed);
  return { value: Math.floor(r.value * maxExclusive), nextSeed: r.nextSeed };
}

// Fisher–Yates shuffle, pure: returns new array + new seed.
export function shuffle<T>(items: readonly T[], seed: number): { items: T[]; nextSeed: number } {
  const arr = [...items];
  let s = seed;
  for (let i = arr.length - 1; i > 0; i--) {
    const r = randomInt(s, i + 1);
    s = r.nextSeed;
    const j = r.value;
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return { items: arr, nextSeed: s };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}
