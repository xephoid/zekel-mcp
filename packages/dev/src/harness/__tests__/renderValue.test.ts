import { describe, it, expect } from 'vitest';
import { renderUtterance, renderValue } from '../desyncBot.js';
import { registerDevHooks } from '../devHooks.js';

// A game may say a value its own way through its dev hooks (renderValue). The
// human-sim must speak cards as countable units: joining an object's fields
// with ',' made a single-card report ("kind token, token star") sound like two
// cards and desynced the report. A made-up game shows the hook in use.
registerDevHooks('test-token-game', {
  desync: {
    renderValue: (v) => (v.kind === 'token' && typeof v.token === 'string' ? `a ${v.token} token` : null),
  },
});

describe('renderValue — a game\'s own wording, as human speech', () => {
  it('renders a single card as ONE comma-free unit', () => {
    const out = renderValue([{ kind: 'token', token: 'star' }], 'test-token-game');
    expect(out).toBe('a star token');
    expect(out).not.toContain(','); // no internal comma to miscount on
  });

  it('keeps each card a distinct unit in a multi-card report', () => {
    const out = renderValue([
      { kind: 'token', token: 'star' },
      { kind: 'token', token: 'moon' },
      { kind: 'token', token: 'sun' },
    ], 'test-token-game');
    expect(out).toBe('a star token; a moon token; a sun token');
    expect(out.split(';')).toHaveLength(3); // exactly three countable cards
  });

  it('still renders non-card objects with the generic field rendering', () => {
    expect(renderValue([{ color: 'red', face: 'hit' }, { color: 'black', face: 'blank' }]))
      .toBe('color red, face hit; color black, face blank');
  });
});

// Taxonomy #7 again: a legal-move description that is an INSTRUCTION TO THE
// ASSISTANT (template-fill "EDIT …" or placeholder-default "PLACEHOLDER … do NOT
// submit as-is. ASK the human …") must never be spoken as the human's utterance —
// the assistant rightly answers such an utterance by ASKING, the sim never
// replies, and the whole game strands (a quest report seen in a real desync run).
describe('renderUtterance — second-person turn phrasing is spoken first-person', () => {
  it('"End your turn." becomes "end my turn" (a human never says "end your turn")', () => {
    const out = renderUtterance({ type: 'end_turn' }, false, 'End your turn.', {});
    expect(out).toBe("I'm going to end my turn..");
    expect(out).not.toContain('your turn');
  });

  it('leaves other second-person words alone (only the turn phrase inverts)', () => {
    const out = renderUtterance({ type: 'x' }, false, 'Move your ship and end your turn', {});
    expect(out).toContain('your ship');
    expect(out).toContain('end my turn');
  });
});

describe('renderUtterance — instruction descriptions are never spoken', () => {
  it('falls through to concrete values for a PLACEHOLDER/ASK description', () => {
    const out = renderUtterance(
      { type: 'knight_report_quests', quests: ['adventurous', 'bedecked', 'cunning'] },
      false,
      'PLACEHOLDER default — do NOT submit as-is. ASK the human which 3 Side Quest cards are face-up…',
      {},
    );
    expect(out).toBe('I\'m playing knight report quests (quests: adventurous, bedecked, cunning).');
    expect(out).not.toContain('PLACEHOLDER');
    expect(out).not.toContain('ASK');
  });

  it('falls through for an EDIT template-fill description', () => {
    const out = renderUtterance(
      { type: 'build_units', units: ['infantry'] },
      false,
      'Build one unit per icon — EDIT each to a legal type',
      {},
    );
    expect(out).not.toContain('EDIT');
    expect(out).toContain('infantry');
  });

  it('falls through for an "ASK each human" description (setup colours)', () => {
    const out = renderUtterance(
      { type: 'assign_setup_choices', selections: { p1: 'red', p2: 'blue' } },
      false,
      'Assign player colours. ASK each human which colour they want (red/blue/green/yellow); the table also assigns the AI seats. Colours must be distinct.',
      {},
    );
    expect(out).not.toContain('ASK');
    expect(out).toContain('red');
    expect(out).toContain('blue');
  });

  it('still speaks a faithful statement description as-is', () => {
    expect(renderUtterance({ type: 'move', direction: 'east' }, false, 'Move east.', {})).toBe(
      "I'm going to move east..",
    );
  });
});

describe('renderUtterance — an empty list is spoken, not dropped', () => {
  it('a hand report with no cards says "none" instead of reading the description', () => {
    const out = renderUtterance(
      { type: 'report_location_hand', locations: [] },
      false,
      'Report the Location cards still in your hand (name them exactly; the gathered pile is everything else)',
      {},
    );
    expect(out).toBe("I'm reporting my location hand — locations: none.");
  });

  it('an empty list renders as "none"; a non-empty one is unchanged', () => {
    expect(renderValue([])).toBe('none');
    expect(renderValue(['Docks', 'Arcade'])).toBe('Docks, Arcade');
  });
});

describe('renderValue — game wording only applies to its own game', () => {
  it('another game, or no game, gets the generic wording for the same shape', () => {
    expect(renderValue([{ kind: 'token', token: 'star' }])).toBe('kind token, token star');
    expect(renderValue([{ kind: 'token', token: 'star' }], 'another-game')).toBe('kind token, token star');
  });
});
