// The shared setup-choice framework (src/core/setupChoices.ts) — used by every game
// with a per-seat identity pick (Snallygaster colours, Brass colours, Arcs factions,
// Ankh gods). Locks the validation, the default assignment, and the rail builders.

import { describe, it, expect } from 'vitest';
import {
  defaultSetupAssignment,
  firstHumanReporter,
  setupChoiceChecklistStep,
  setupChoiceNextStep,
  validateSetupSelections,
  type SetupChoiceSpec,
} from '../setupChoices.js';

function spec(overrides: Partial<SetupChoiceSpec> = {}): SetupChoiceSpec {
  return {
    choiceLabel: 'colour',
    options: [
      { id: 'red', label: 'Red' },
      { id: 'blue', label: 'Blue' },
      { id: 'green', label: 'Green' },
    ],
    seats: [
      { player_id: 'h1', kind: 'human' },
      { player_id: 'a1', kind: 'ai' },
    ],
    distinct: true,
    ...overrides,
  };
}

describe('setupChoices framework', () => {
  it('firstHumanReporter finds the first human, or null when all-AI', () => {
    expect(firstHumanReporter(spec().seats)).toBe('h1');
    expect(firstHumanReporter([{ player_id: 'a1', kind: 'ai' }, { player_id: 'a2', kind: 'ai' }])).toBeNull();
  });

  it('defaultSetupAssignment gives distinct seat-ordered options', () => {
    expect(defaultSetupAssignment(spec())).toEqual({ h1: 'red', a1: 'blue' });
  });

  it('validateSetupSelections accepts a valid distinct map from the reporter', () => {
    expect(() => validateSetupSelections(spec(), { h1: 'green', a1: 'red' }, 'h1', 'h1')).not.toThrow();
  });

  it('rejects wrong reporter / missing seat / unknown option / duplicate', () => {
    expect(() => validateSetupSelections(spec(), { h1: 'red', a1: 'blue' }, 'h1', 'a1')).toThrow(/Only the reporting/);
    expect(() => validateSetupSelections(spec(), { h1: 'red' }, 'h1', 'h1')).toThrow(/Missing/);
    expect(() => validateSetupSelections(spec(), { h1: 'pink', a1: 'blue' }, 'h1', 'h1')).toThrow(/not a valid/);
    expect(() => validateSetupSelections(spec(), { h1: 'red', a1: 'red' }, 'h1', 'h1')).toThrow(/cannot share/);
  });

  it('non-distinct specs allow shared options', () => {
    const s = spec({ distinct: false });
    expect(() => validateSetupSelections(s, { h1: 'red', a1: 'red' }, 'h1', 'h1')).not.toThrow();
  });

  it('checklist step is null for an all-AI seat set, present with a human', () => {
    expect(setupChoiceChecklistStep('assign_setup_choices', spec({ seats: [{ player_id: 'a1', kind: 'ai' }] }))).toBeNull();
    const step = setupChoiceChecklistStep('assign_setup_choices', spec());
    expect(step?.move_type).toBe('assign_setup_choices');
    expect(step?.ask_human_for.length).toBeGreaterThan(0);
  });

  it('nextStep routes to the human reporter, names the move + the ask rule, lists the pool', () => {
    const step = setupChoiceNextStep('assign_setup_choices', spec(), 'h1');
    expect(step?.status).toBe('human_to_move');
    expect(step?.active_player_id).toBe('h1');
    expect(step?.instruction).toContain('assign_setup_choices');
    expect(step?.instruction).toMatch(/ASK/);
    expect(step?.instruction).toContain('h1');
    expect(step?.instruction).toContain('a1'); // names the AI seat to pick for
  });

  it('nextStep carries a human_response answer-shape hint (ask / example / records_as)', () => {
    const hr = setupChoiceNextStep('assign_setup_choices', spec(), 'h1')?.human_response;
    expect(hr).toBeDefined();
    expect(hr!.records_as).toContain('assign_setup_choices');
    expect(hr!.ask).toContain('colour'); // the choiceLabel
    expect(hr!.ask).toMatch(/Red|Blue|Green/); // lists the option pool
    expect(hr!.example).toContain('Red'); // example uses the first option's label
    expect(hr!.example.length).toBeGreaterThan(0);
  });

  it('nextStep is null when the named reporter is not human (defensive)', () => {
    expect(setupChoiceNextStep('assign_setup_choices', spec(), 'a1')).toBeNull();
  });
});
