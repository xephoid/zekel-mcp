import { describe, expect, it } from 'vitest';
import type { RuleSection } from '../game.js';
import {
  duplicateSectionIds,
  findSections,
  renderRulesText,
  sectionsForMoveType,
  sectionsForPhase,
  validateSectionCoverage,
} from '../rulesSections.js';

const sections: RuleSection[] = [
  {
    id: 'movement',
    title: 'Moving Around',
    text: 'Move up to your Speed in steps.',
    tags: { move_types: ['move', 'sprint'] },
  },
  {
    id: 'combat',
    title: 'Combat',
    text: 'Attack a visible enemy.',
    tags: { move_types: ['attack'], phases: ['battle'] },
  },
  {
    id: 'setup-draft',
    title: 'Drafting',
    text: 'Each player drafts a character.',
    tags: { phases: ['setup'] },
  },
];

describe('renderRulesText', () => {
  it('renders every section as a titled block, in order', () => {
    const text = renderRulesText(sections);
    expect(text).toBe(
      '## Moving Around\n\nMove up to your Speed in steps.\n\n' +
        '## Combat\n\nAttack a visible enemy.\n\n' +
        '## Drafting\n\nEach player drafts a character.',
    );
  });
});

describe('tag lookups', () => {
  it('finds sections by move type', () => {
    expect(sectionsForMoveType(sections, 'sprint').map((s) => s.id)).toEqual(['movement']);
    expect(sectionsForMoveType(sections, 'attack').map((s) => s.id)).toEqual(['combat']);
    expect(sectionsForMoveType(sections, 'unknown')).toEqual([]);
  });

  it('finds sections by phase', () => {
    expect(sectionsForPhase(sections, 'battle').map((s) => s.id)).toEqual(['combat']);
    expect(sectionsForPhase(sections, 'setup').map((s) => s.id)).toEqual(['setup-draft']);
    expect(sectionsForPhase(sections, 'main')).toEqual([]);
  });
});

describe('findSections (the get_rules topic filter)', () => {
  it('matches an exact id first', () => {
    expect(findSections(sections, 'combat').map((s) => s.id)).toEqual(['combat']);
  });

  it('falls back to case-insensitive substring on id or title', () => {
    expect(findSections(sections, 'MOVING').map((s) => s.id)).toEqual(['movement']);
    expect(findSections(sections, 'draft').map((s) => s.id)).toEqual(['setup-draft']);
  });

  it('returns [] on no match or a blank topic', () => {
    expect(findSections(sections, 'shipbuilding')).toEqual([]);
    expect(findSections(sections, '   ')).toEqual([]);
  });
});

describe('validateSectionCoverage (the per-game lock helper)', () => {
  it('returns the move types no section governs', () => {
    expect(validateSectionCoverage(sections, ['move', 'sprint', 'attack'])).toEqual([]);
    expect(validateSectionCoverage(sections, ['move', 'teleport', 'dig'])).toEqual([
      'teleport',
      'dig',
    ]);
  });
});

describe('duplicateSectionIds', () => {
  it('flags repeated ids', () => {
    expect(duplicateSectionIds(sections)).toEqual([]);
    expect(
      duplicateSectionIds([...sections, { ...sections[0]!, title: 'Copy' }]),
    ).toEqual(['movement']);
  });
});
