import { describe, expect, it } from 'vitest';
import { extractMoveJson } from '../ollama.js';

// The LLM-bot reads a weak model's free-form reply and must recover the one move
// JSON from it. These cover the shapes models actually emit: bare object, fenced
// block, object after prose, and a <think> preamble — plus the genuine
// no-parseable-move case (which the bot records as a format_error).

describe('extractMoveJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractMoveJson('{"type":"pass"}')).toEqual({ type: 'pass' });
  });

  it('parses a ```json fenced block', () => {
    const text = 'Here is my move:\n```json\n{"type":"loan","player_id":"p1"}\n```\n';
    expect(extractMoveJson(text)).toEqual({ type: 'loan', player_id: 'p1' });
  });

  it('parses an object embedded after prose', () => {
    const text = 'I will build a mine. {"type":"build","tile":"coal","city":"dudley"}';
    expect(extractMoveJson(text)).toEqual({ type: 'build', tile: 'coal', city: 'dudley' });
  });

  it('ignores a <think> preamble and reads the object after it', () => {
    const text = '<think>The directive says report my hand.</think>{"type":"report_initial_hand","player_id":"p1"}';
    expect(extractMoveJson(text)).toEqual({ type: 'report_initial_hand', player_id: 'p1' });
  });

  it('handles nested objects via brace matching', () => {
    const text = 'move: {"type":"assign_setup_choices","selections":{"p1":"red","p2":"blue"}}';
    expect(extractMoveJson(text)).toEqual({ type: 'assign_setup_choices', selections: { p1: 'red', p2: 'blue' } });
  });

  it('does not mistake a brace inside a string for structure', () => {
    expect(extractMoveJson('{"type":"note","text":"a } brace"}')).toEqual({ type: 'note', text: 'a } brace' });
  });

  it('returns null when there is no JSON object at all', () => {
    expect(extractMoveJson('I think I should pass this turn.')).toBeNull();
  });

  it('returns null for a bare array (a move must be an object)', () => {
    expect(extractMoveJson('[1,2,3]')).toBeNull();
  });
});
