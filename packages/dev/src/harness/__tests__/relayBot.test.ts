// Locks the relay harness's pure round-trip machinery: skeleton blanking, the
// nameify-path bookkeeping that lets a reconstruction be resolved back to the
// shadow session's own ids, reader-output coercion, and the lexical fact check
// that disambiguates relay omission (B/C) from reader noise (D).

import { describe, expect, it } from 'vitest';
import {
  batchComplexity,
  blankSkeleton,
  coerceReconstruction,
  collectChangedPaths,
  denameifyAtPaths,
  extractFacts,
  invertNameMap,
  placeholderPaths,
  textContains,
} from '../relayBot.js';

describe('blankSkeleton', () => {
  it('blanks every leaf to a typed placeholder but keeps the move discriminant', () => {
    const move = { type: 'build', city: 'Worcester', slot: 0, overbuild: false, pieces: [{ kind: 'cube', count: 2 }] };
    expect(blankSkeleton(move)).toEqual({
      type: 'build',
      city: '<string>',
      slot: '<number>',
      overbuild: '<boolean>',
      pieces: [{ kind: '<string>', count: '<number>' }],
    });
  });

  it('keeps an `action` discriminant and null values as-is', () => {
    expect(blankSkeleton({ action: 'tax', target: null })).toEqual({ action: 'tax', target: null });
  });
});

describe('collectChangedPaths + denameifyAtPaths', () => {
  const raw = { type: 'play', card_id: 'L136', to: 'discard', picks: ['I5', 'keep'] };
  const nameified = { type: 'play', card_id: 'Birmingham', to: 'discard', picks: ['Loyal Engineer', 'keep'] };

  it('records exactly the paths nameify rewrote', () => {
    expect(collectChangedPaths(raw, nameified)).toEqual(['card_id', 'picks.0']);
  });

  it('maps names back to the target session ids at those paths only', () => {
    const inverse = { Birmingham: 'M77', 'Loyal Engineer': 'M9', discard: 'XXX-should-not-apply' };
    expect(denameifyAtPaths(nameified, ['card_id', 'picks.0'], inverse)).toEqual({
      type: 'play',
      card_id: 'M77',
      to: 'discard', // not a nameified path — a legit name-valued field is never touched
      picks: ['M9', 'keep'],
    });
  });

  it('passes unknown names through so the engine resolver (or a clean rejection) decides', () => {
    expect(denameifyAtPaths({ card_id: 'Wolverhampton' }, ['card_id'], {})).toEqual({ card_id: 'Wolverhampton' });
  });
});

describe('invertNameMap', () => {
  it('keeps the first id for duplicate names (fungible copies)', () => {
    expect(invertNameMap({ C1: 'Warrior', C2: 'Warrior', C3: 'Priest' })).toEqual({ Warrior: 'C1', Priest: 'C3' });
  });
});

describe('coerceReconstruction', () => {
  it('coerces numeric strings where the ground truth held a number and counts unfilled placeholders', () => {
    const gt = { type: 'move', spaces: 3, from: 'Gate Six', flying: true };
    const filled = { type: 'move', spaces: '3', from: '<string>', flying: 'true' };
    const { value, unfilled } = coerceReconstruction(filled, gt);
    expect(value).toEqual({ type: 'move', spaces: 3, from: '<string>', flying: true });
    expect(unfilled).toBe(1);
  });

  it('coerces inside arrays against the ground-truth element shape', () => {
    const { value, unfilled } = coerceReconstruction({ dice: ['2', '5'] }, { dice: [2, 5] });
    expect(value).toEqual({ dice: [2, 5] });
    expect(unfilled).toBe(0);
  });

  it('restores a reader-rewritten or dropped move discriminant (structure is granted, not under test)', () => {
    const gt = { type: 'draw_chip', player_id: 'Red Queen' };
    expect(coerceReconstruction({ type: 'draws', player_id: 'Red Queen' }, gt).value).toEqual(gt);
    expect(coerceReconstruction({ player_id: 'Red Queen' }, gt).value).toEqual(gt);
    // nested type-named fields are values under test — untouched
    const gtNested = { type: 'cast', spell: { type: 'fire' } };
    expect(coerceReconstruction({ type: 'casts', spell: { type: 'ice' } }, gtNested).value)
      .toEqual({ type: 'cast', spell: { type: 'ice' } });
  });
});

describe('extractFacts + textContains', () => {
  it('collects move leaf values and summary names/numbers, skipping player ids', () => {
    const facts = extractFacts(
      [{ type: 'capture', piece: 'Robot', player_id: 'p2', roll: 14 }],
      ['AI captured the Robot with a 14 and refilled the Market from Supply Deck.'],
    );
    expect(facts).toContain('Robot');
    expect(facts).toContain('14');
    expect(facts).toContain('Supply Deck');
    expect(facts).not.toContain('p2');
  });

  it('matches facts case/punctuation-insensitively with light plural tolerance', () => {
    expect(textContains('The AI leads Guild Struggle, then taxes.', 'lead')).toBe(true);
    expect(textContains('The AI leads GUILD-STRUGGLE.', 'Guild Struggle')).toBe(true);
    expect(textContains('The AI took its turn.', 'Guild Struggle')).toBe(false);
    expect(textContains('gains 3 power', '3')).toBe(true);
  });
});

describe('placeholderPaths', () => {
  it('names every unfilled slot for the reader-retry nudge, and nothing else', () => {
    const moves = [
      { type: 'declare_ambition', ambition: '<string>' },
      { type: 'move', spaces: 3, path: ['5h', '<string>'] },
    ];
    expect(placeholderPaths(moves)).toEqual(['moves[0].ambition', 'moves[1].path.1']);
    expect(placeholderPaths([{ type: 'pass' }])).toEqual([]);
  });

  it('treats an empty string as an unfilled slot (observed reader "" instead of placeholder)', () => {
    expect(placeholderPaths([{ type: 'place_leader', region: '' }])).toEqual(['moves[0].region']);
  });
});

describe('batchComplexity', () => {
  it('ranks a multi-move, fact-dense batch above a simple one', () => {
    const dense = batchComplexity(
      [
        { type: 'lead', card: 'Guild Struggle' },
        { type: 'battle', from: 'Gate Six', dice: [1, 2, 3] },
      ],
      ['leads Guild Struggle', 'battles at Gate Six: 2 hits, 1 intercept, loses 1 ship'],
    );
    const simple = batchComplexity([{ type: 'pass' }], ['passes']);
    expect(dense).toBeGreaterThan(simple);
  });
});
