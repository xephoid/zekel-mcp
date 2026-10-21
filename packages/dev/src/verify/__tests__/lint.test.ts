import { describe, expect, it } from 'vitest';
import { lintEncoding, quoteAppearsVerbatim, renderFinding } from '../lint.js';
import type { GameRulesEncoding } from '../types.js';

const RULES_TEXT = [
  'Toy game rules.',
  'On your turn, draw a card from the deck',
  'into your hand. When the deck is empty,',
  'the game ends immediately.',
].join('\n');

function toyEncoding(): GameRulesEncoding {
  return {
    gameId: 'toy',
    rulesVersion: 'v1',
    rulesFile: 'toy-rules.txt',
    universe: {
      zones: ['deck', 'hand'],
      counters: ['cards in hand'],
      eventKinds: ['draw', 'game end'],
    },
    entries: [
      {
        id: 'draw-a-card',
        status: 'rule',
        eventKind: 'draw',
        zones: ['deck', 'hand'],
        trigger: 'the active player takes their turn',
        effects: [{ op: 'draw', from: 'deck', to: 'hand', count: 1 }],
        citation: { section: '1', quote: 'draw a card from the deck into your hand' },
      },
      {
        id: 'deck-empty-ends',
        status: 'rule',
        eventKind: 'game end',
        zones: ['deck'],
        trigger: 'the deck has no cards',
        effects: [{ op: 'game_end', winner: 'nobody', reason: 'deck empty' }],
        citation: { section: '1', quote: 'When the deck is empty, the game ends immediately.' },
      },
    ],
    notApplicable: [
      { zone: 'hand', eventKind: 'game end', reason: 'the hand plays no part in ending the game' },
    ],
  };
}

describe('verbatim quote check', () => {
  it('accepts a quote that differs only in line wrapping', () => {
    expect(quoteAppearsVerbatim('draw a card from the deck into your hand', RULES_TEXT)).toBe(true);
  });

  it('rejects a paraphrase', () => {
    expect(quoteAppearsVerbatim('take a card from the pile', RULES_TEXT)).toBe(false);
  });

  it('rejects an empty quote', () => {
    expect(quoteAppearsVerbatim('   ', RULES_TEXT)).toBe(false);
  });
});

describe('lintEncoding', () => {
  it('passes a complete, correctly cited encoding with no findings', () => {
    expect(lintEncoding(toyEncoding(), RULES_TEXT)).toEqual([]);
  });

  it('flags a citation that is not in the rules text', () => {
    const encoding = toyEncoding();
    const first = encoding.entries[0];
    if (first?.status !== 'rule') throw new Error('fixture changed');
    first.citation = { section: '1', quote: 'players draw two cards each turn' };
    const findings = lintEncoding(encoding, RULES_TEXT);
    expect(findings).toContainEqual({
      kind: 'bad_citation',
      entryId: 'draw-a-card',
      quote: 'players draw two cards each turn',
    });
  });

  it('flags every uncovered zone x event cell', () => {
    const encoding = toyEncoding();
    encoding.notApplicable = [];
    const findings = lintEncoding(encoding, RULES_TEXT);
    expect(findings).toContainEqual({ kind: 'uncovered_cell', zone: 'hand', eventKind: 'game end' });
    expect(findings).toHaveLength(1);
  });

  it('echoes silent and vague entries as findings (they still cover their cells)', () => {
    const encoding = toyEncoding();
    encoding.universe.eventKinds.push('discard');
    encoding.entries.push({
      id: 'discard-when-full',
      status: 'silent',
      eventKind: 'discard',
      zones: ['deck', 'hand'],
      situation: 'a player must discard but the rules never say where discards go',
      rulingNeeded: 'where do discarded cards go?',
    });
    const findings = lintEncoding(encoding, RULES_TEXT);
    expect(findings).toContainEqual({
      kind: 'silent',
      entryId: 'discard-when-full',
      situation: 'a player must discard but the rules never say where discards go',
      rulingNeeded: 'where do discarded cards go?',
    });
    // The silent entry covers deck x discard and hand x discard, so no
    // uncovered-cell findings appear for them.
    expect(findings.filter((f) => f.kind === 'uncovered_cell')).toEqual([]);
  });

  it('flags duplicate ids and references outside the declared universe', () => {
    const encoding = toyEncoding();
    encoding.entries.push({
      id: 'draw-a-card',
      status: 'rule',
      eventKind: 'not-an-event',
      zones: ['not-a-zone'],
      trigger: 'never',
      effects: [],
      citation: { section: '1', quote: 'Toy game rules.' },
    });
    const findings = lintEncoding(encoding, RULES_TEXT);
    expect(findings).toContainEqual({ kind: 'duplicate_id', entryId: 'draw-a-card' });
    expect(findings).toContainEqual({ kind: 'unknown_zone', entryId: 'draw-a-card', zone: 'not-a-zone' });
    expect(findings).toContainEqual({
      kind: 'unknown_event_kind',
      entryId: 'draw-a-card',
      eventKind: 'not-an-event',
    });
  });

  it('renders every finding kind as one readable line', () => {
    const encoding = toyEncoding();
    encoding.notApplicable = [];
    const first = encoding.entries[0];
    if (first?.status !== 'rule') throw new Error('fixture changed');
    first.citation = { section: '1', quote: 'nope' };
    for (const finding of lintEncoding(encoding, RULES_TEXT)) {
      expect(renderFinding(finding).length).toBeGreaterThan(0);
    }
  });
});
