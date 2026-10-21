// The claims audit catches the failure the desync metric alone can't see: the
// assistant telling the human "got it" while recording NOTHING (observed with
// qwen3.6:35b in real LibreChat sessions — the human-move confirmation was prose
// only, no apply_move). Classifier contract: a successful record is 'recorded'
// regardless of prose; with nothing recorded, honest markers (questions,
// admissions of failure) win over confirmation markers; only clearly-affirmative
// bookkeeping language counts as a fabricated confirmation.

import { describe, expect, it } from 'vitest';
import { classifyClaims } from '../desyncBot.js';

describe('classifyClaims', () => {
  it('a successful record is "recorded" no matter what the prose says', () => {
    expect(classifyClaims({ type: 'leap' }, "Done — I've recorded your leap.")).toBe('recorded');
    expect(classifyClaims({ type: 'leap' }, '')).toBe('recorded');
    expect(classifyClaims({ move_id: 'm3' }, 'Hmm, I am not sure that worked?')).toBe('recorded');
  });

  it('flags affirmative bookkeeping prose with nothing recorded as fabrication', () => {
    expect(classifyClaims(null, "Got it — I've recorded your move west 2.")).toBe('fabricated_confirmation');
    expect(classifyClaims(null, 'Your build in Worcester has been applied. The AI is up next.')).toBe('fabricated_confirmation');
    expect(classifyClaims(null, 'Noted! You played the Ogre card.')).toBe('fabricated_confirmation');
    expect(classifyClaims(null, '✅ Move logged for seat p1.')).toBe('fabricated_confirmation');
    expect(classifyClaims(null, 'All set. Your turn is complete.')).toBe('fabricated_confirmation');
  });

  it('honest failures and questions are not fabrications', () => {
    expect(classifyClaims(null, 'Which card did you mean — Ambush or Assault?')).toBe('honest_failure');
    expect(classifyClaims(null, "I couldn't apply that move: the server rejected it as not legal.")).toBe('honest_failure');
    expect(classifyClaims(null, 'Sorry, I was unable to record that. Please tell me the exact tile.')).toBe('honest_failure');
    // Mixed prose: the admission wins over the confirmation phrasing.
    expect(classifyClaims(null, "Sorry — I noted your move but the server rejected it as invalid.")).toBe('honest_failure');
  });

  it('prose that neither confirms nor admits, and empty replies, are no_record_no_claim', () => {
    expect(classifyClaims(null, '')).toBe('no_record_no_claim');
    expect(classifyClaims(null, 'The Knight is a strong faction in the early game.')).toBe('no_record_no_claim');
  });
});
