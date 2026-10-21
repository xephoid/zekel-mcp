// Seedable random numbers for the harness, so a batch is reproducible from
// --seed. Shared by the ai-harness command and games' dev hooks (sweeps and
// strategy drafts) — the exact same code, so results do not change with where
// a sweep is defined.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickDistinct<T>(pool: readonly T[], count: number, rand: () => number): T[] {
  const arr = [...pool];
  // Partial Fisher–Yates: shuffle the first `count` slots.
  const n = Math.min(count, arr.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (arr.length - i));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr.slice(0, n);
}
